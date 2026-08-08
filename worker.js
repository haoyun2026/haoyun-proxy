/**
 * 浩云OS · 星空代理（Cloudflare Workers 版）
 * --------------------------------------------------
 * 作用：让纯前端工作台（托管在任意静态托管，如 CloudStudio / GitHub Pages / Vercel）
 *       在「无本地代理」的手机 / 云端环境下，也能使用：
 *         · 全网热榜抓取（/hotlist）
 *         · 文章正文提取（/readpage）
 *         · AI 模型调用转发（/proxy，流式透传，绕过浏览器 CORS）
 *         · 天气（/weather）、搜索（/search）、MCP 桥接（/mcp）
 *
 * 部署：见同目录 README.md  ——  `wrangler deploy` 即可
 *
 * 安全性说明：
 *   · 本 Worker 只做「转发」，不存储你的 API Key；
 *   · 你的模型 API Key 由浏览器发给本 Worker（HTTPS 加密），再由 Worker 转发给模型厂商；
 *   · 个人自用、流量很低时足够；请勿把本地址公开给不可信人群。
 */

// ============ 全局 CORS（允许任意前端域名调用）============
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// 模拟浏览器的请求头（部分站点会按 UA / Referer 返回不同内容或风控）
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function hotNum(v) {
  if (v == null) return "";
  if (typeof v === "number") {
    if (v >= 100000000) return (v / 100000000).toFixed(1) + "亿";
    if (v >= 10000) return (v / 10000).toFixed(1) + "万";
    return String(v);
  }
  return String(v);
}

// ============ 热榜数据源 ============

// 源 A：60s.viki.moe —— 聚合 JSON，覆盖抖音/微博/知乎/头条（且支持 CORS 直连）
async function src60s(slug) {
  const r = await fetch("https://60s.viki.moe/v2/" + slug, {
    headers: { "User-Agent": "HaoyunOS/1.0" },
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json();
  if (!j || j.code !== 200 || !Array.isArray(j.data)) throw new Error("60s 返回异常");
  return j.data.map((x, i) => ({
    rank: i + 1,
    title: x.title || x.name || "",
    url: x.link || x.url || "",
    hot: hotNum(x.hot_value ?? x.hot ?? x.hotValue),
    cover: x.cover || x.pic || "",
    desc: (x.detail || x.desc || x.description || "").slice(0, 200),
    author: x.author || "",
  })).filter((x) => x.title);
}

// 源 B：tophub.today 榜单页 —— 微信/小红书/快手/B站等
async function srcTophub(nodeId) {
  let r = null, lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((s) => setTimeout(s, 1800));
    try {
      r = await fetch("https://tophub.today/n/" + nodeId, {
        headers: { ...BROWSER_HEADERS, Referer: "https://tophub.today/" },
        signal: AbortSignal.timeout(14000),
      });
      if (r.status === 200) break;
      lastErr = "tophub HTTP " + r.status;
      r = null;
    } catch (e) { lastErr = e.message || String(e); r = null; }
  }
  if (!r) throw new Error(lastErr || "tophub 请求失败");
  const html = await r.text();
  if (/安全验证|请开启JavaScript/.test(html.slice(0, 4000))) throw new Error("tophub 触发风控");
  const out = [];
  const rowRe = /<tr>\s*<td[^>]*>\s*(\d+)\.?\s*<\/td>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>(?:\s*<td[^>]*class="ws"[^>]*>([\s\S]*?)<\/td>)?/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const title = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.push({
      rank: parseInt(m[1], 10) || out.length + 1,
      title,
      url: m[2].replace(/&amp;/g, "&"),
      hot: (m[4] || "").replace(/<[^>]+>/g, "").trim(),
      cover: "", desc: "", author: "",
    });
  }
  if (!out.length) throw new Error("tophub 解析为空");
  return out;
}

// 源 C：RSSHub 公共镜像（tophub 被风控时的兜底）
async function srcRsshubTophub(nodeId) {
  const bases = ["https://rsshub.rssforever.com", "https://rsshub.app"];
  let lastErr = "";
  for (const b of bases) {
    try {
      const r = await fetch(b + "/tophub/" + nodeId, {
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "application/rss+xml,text/xml,*/*" },
        signal: AbortSignal.timeout(15000),
      });
      if (r.status !== 200) { lastErr = "RSSHub HTTP " + r.status; continue; }
      const xml = await r.text();
      const items = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      const pick = (block, tag) => {
        const mm = new RegExp("<" + tag + ">([\\s\\S]*?)<\\/" + tag + ">").exec(block);
        if (!mm) return "";
        return mm[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      };
      while ((m = re.exec(xml))) {
        const title = pick(m[1], "title");
        if (!title) continue;
        items.push({
          rank: items.length + 1,
          title,
          url: pick(m[1], "link"),
          hot: "",
          cover: "",
          desc: pick(m[1], "description").slice(0, 200),
          author: pick(m[1], "author"),
        });
      }
      if (items.length) return items;
      lastErr = "RSSHub 解析为空";
    } catch (e) { lastErr = e.message || String(e); }
  }
  throw new Error(lastErr || "RSSHub 不可用");
}

const HOT_SOURCES = {
  douyin:   { name: "抖音",     chain: [() => src60s("douyin"), () => srcTophub("DpQvNABoNE"), () => srcRsshubTophub("DpQvNABoNE")] },
  weixin:   { name: "公众号",   chain: [() => srcTophub("WnBe01o371"), () => srcRsshubTophub("WnBe01o371")] },
  xhs:      { name: "小红书",   chain: [() => srcTophub("L4MdA5ldxD"), () => srcRsshubTophub("L4MdA5ldxD")] },
  weibo:    { name: "微博",     chain: [() => src60s("weibo")] },
  zhihu:    { name: "知乎",     chain: [() => src60s("zhihu")] },
  toutiao:  { name: "今日头条", chain: [() => src60s("toutiao")] },
  kuaishou: { name: "快手",     chain: [() => srcTophub("MZd7PrPerO"), () => srcRsshubTophub("MZd7PrPerO")] },
  bili:     { name: "哔哩哔哩", chain: [() => srcTophub("74Kvxwokxm"), () => srcTophub("b0vmbRXdB1"), () => srcRsshubTophub("74Kvxwokxm")] },
  ithome:   { name: "IT之家",   chain: [() => srcTophub("74Kvx59dkx"), () => srcRsshubTophub("74Kvx59dkx")] },
};

const AVAILABLE = Object.keys(HOT_SOURCES).map((k) => ({ key: k, name: HOT_SOURCES[k].name }));

async function fetchHot(src) {
  const conf = HOT_SOURCES[src];
  if (!conf) return { ok: false, src, error: "未知平台：" + src };
  const errors = [];
  for (const fn of conf.chain) {
    try {
      const items = (await fn()).slice(0, 30);
      if (items.length) return { ok: true, src, name: conf.name, at: Date.now(), cached: false, items };
      errors.push("空列表");
    } catch (e) { errors.push(e.message || String(e)); }
  }
  return { ok: false, src, name: conf.name, error: errors.join(" / ") || "全部数据源不可用" };
}

// ============ 文章正文提取 ============
async function handleReadpage(request) {
  try {
    const p = await request.json().catch(() => ({}));
    const url = String(p.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: "非法链接" }, 200);
    const r = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Referer: new URL(url).origin + "/" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const ct = r.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      return json({ ok: false, error: "该链接不是网页（" + (ct || "未知类型") + "）", status: r.status }, 200);
    }
    let html = await r.text();
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const ogImg = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
               || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
    const author = /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html);
    const sliceFrom = (startRe, endMarkers) => {
      const mm = startRe.exec(html);
      if (!mm) return "";
      const from = mm.index + mm[0].length;
      let to = html.length;
      for (const mk of endMarkers) {
        const i = html.indexOf(mk, from);
        if (i > -1 && i < to) to = i;
      }
      const seg = html.slice(from, to);
      return seg.length > 200 ? seg : "";
    };
    let body =
         sliceFrom(/<div[^>]+id=["']js_content["'][^>]*>/i, ['id="js_pc_qr_code"', 'class="rich_media_tool', 'id="content_bottom_area"', 'id="js_tags"', "<script"])
      || sliceFrom(/<div[^>]+class=["'][^"']*rich_media_content[^"']*["'][^>]*>/i, ['id="js_pc_qr_code"', 'class="rich_media_tool', "<script"])
      || sliceFrom(/<article[^>]*>/i, ["</article>"])
      || sliceFrom(/<div[^>]+class=["'][^"']*(?:article-content|post-content|content__article|entry-content|note-content)[^"']*["'][^>]*>/i, ["<footer", '"comment', "<script"])
      || sliceFrom(/<main[^>]*>/i, ["</main>"])
      || html;
    const images = [];
    const imgRe = /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi;
    let im;
    while ((im = imgRe.exec(body)) && images.length < 20) {
      const u = im[1];
      if (/^https?:\/\//i.test(u) && !/\.svg($|\?)/i.test(u)) images.push(u);
    }
    const noiseRe = /<(?:span|div|a|p)[^>]*(?:class|id)=["'][^"']*(?:btn|tool|bar|menu|nav|share|like|comment|qr_code|rich_media_tool|profile_nickname|avatar|activity_meta|reward|tips|notice|toast|popover|dropdown|modal|dialog|overlay|footer|sidebar|ad|banner|sponsor|related|recommend|tag|label|badge|icon|svg)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
    body = body.replace(noiseRe, "");
    const wxNoiseRe = /<div[^>]*(?:id|class)=["'][^"']*(?:js_cmt_area|js_comment|discuss_container|activity-meta|reward_tip|qr_code|pc_qr_code|js_tags|content_bottom_area|js_sponsor|mpda_bottom|like_btn|js_page_bar|js_toast|js_action_card)["'][^>]*>[\s\S]*?<\/div>/gi;
    body = body.replace(wxNoiseRe, "");
    const text = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|section)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const cnChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const density = text.length > 0 ? cnChars / text.length : 0;
    const lines = text.split(/\n/).filter((l) => l.trim().length > 0);
    const avgLineLen = lines.length > 0 ? lines.reduce((s, l) => s + l.trim().length, 0) / lines.length : 0;
    const isLowQuality = text.length < 300 || density < 0.15 || avgLineLen < 8;
    if (!text || text.length < 120 || isLowQuality) {
      const isWx = /mp\.weixin\.qq\.com/i.test(url);
      return json({
        ok: false, status: r.status, frameable: true,
        error: isWx ? "公众号对服务端抓取做了限制，已切换为原文内嵌视图" : "该站点为前端渲染或有反爬，已切换为原文内嵌视图",
      });
    }
    return json({
      ok: true, url, status: r.status,
      title: titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : "",
      author: author ? author[1] : "",
      cover: ogImg ? ogImg[1] : "",
      images,
      text: text.slice(0, 20000),
      chars: text.length,
    });
  } catch (e) {
    return json({ ok: false, error: "抓取失败：" + (e && e.message ? e.message : String(e)) }, 200);
  }
}

// ============ AI 模型转发（流式透传）============
async function handleProxy(request) {
  let payload;
  try { payload = await request.json(); } catch (e) { return json({ status: 400, body: "非法 JSON" }, 400); }
  const { url, method = "POST", headers = {}, body } = payload;
  if (!url || typeof url !== "string") return json({ status: 400, body: "缺少 url" }, 400);
  if (!/^https?:\/\//i.test(url)) return json({ status: 400, body: "仅支持 http/https 目标地址" }, 400);
  const clean = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(host|connection|content-length|transfer-encoding|keep-alive|proxy-auth|proxy-authorization|te|trailer)$/i.test(k)) continue;
    clean[k] = v;
  }
  try {
    const upstream = await fetch(url, {
      method: (method || "POST").toUpperCase(),
      headers: clean,
      body: typeof body === "string" ? body : (body == null ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(110000),
    });
    const outHeaders = new Headers();
    outHeaders.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    outHeaders.set("Cache-Control", "no-cache, no-transform");
    outHeaders.set("X-Accel-Buffering", "no");
    for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);
    // 直接透传上游响应体（含 SSE 流式）
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    return json({ status: 502, body: "代理转发失败：" + (err && err.message ? err.message : String(err)) }, 502);
  }
}

// ============ 天气（wttr.in，免 Key）============
async function handleWeather(request) {
  try {
    const p = await request.json().catch(() => ({}));
    const city = String(p.city || p.q || p.query || "").trim();
    if (!city) return json({ ok: false, error: "缺少城市名称" }, 200);
    const [jsonResult, textResult] = await Promise.allSettled([
      fetch("https://wttr.in/" + encodeURIComponent(city) + "?format=j1", { headers: { "User-Agent": "curl/8.0" }, signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null),
      fetch("https://wttr.in/" + encodeURIComponent(city) + "?format=3&lang=zh", { headers: { "User-Agent": "curl/8.0" }, signal: AbortSignal.timeout(8000) }).then((r) => r.text()).catch(() => null),
    ]);
    const jdata = jsonResult.status === "fulfilled" ? jsonResult.value : null;
    const tdata = textResult.status === "fulfilled" ? textResult.value : null;
    if (!jdata || !jdata.current_condition) return json({ ok: false, error: "未找到该城市天气数据", rawText: tdata || undefined }, 200);
    const cur = jdata.current_condition[0];
    const desc = cur.weatherDesc?.[0]?.value || "";
    const result = {
      ok: true,
      city: jdata.nearest_area?.[0]?.areaName?.[0]?.value || city,
      country: jdata.nearest_area?.[0]?.country?.[0]?.value || "",
      temp_C: parseInt(cur.temp_C, 10),
      temp_F: parseInt(cur.temp_F, 10),
      feelsLikeC: parseInt(cur.FeelsLikeC, 10),
      humidity: parseInt(cur.humidity, 10),
      windDir: cur.winddir16Point,
      windSpeedKmph: parseInt(cur.windspeedKmph, 10),
      weatherDesc: desc,
      summary: (tdata || `${city}: ${desc}, ${cur.temp_C}°C, 体感 ${cur.FeelsLikeC}°C`).replace(/\n/g, " ").trim(),
      searchedAt: new Date().toISOString(),
    };
    return json(result);
  } catch (e) {
    return json({ ok: false, error: "天气查询失败：" + (e && e.message ? e.message : String(e)) }, 200);
  }
}

// ============ 搜索（DuckDuckGo HTML + Instant Answer）============
async function handleSearch(request) {
  try {
    const p = await request.json().catch(() => ({}));
    const query = String(p.query || p.q || "").trim();
    if (!query) return json({ ok: false, error: "缺少查询词" }, 200);
    const [ddgInstant, ddgHtml] = await Promise.allSettled([
      fetch("https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1&skip_disambig=1", { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null),
      fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) }).then((r) => r.text()).catch(() => null),
    ]);
    let instantAnswer = "", sourceUrl = "", abstractText = "";
    const di = ddgInstant.status === "fulfilled" ? ddgInstant.value : null;
    if (di) {
      if (di.Abstract) { instantAnswer = di.Abstract; sourceUrl = di.AbstractURL || ""; abstractText = di.AbstractText || ""; }
      if (!instantAnswer && di.Heading) instantAnswer = di.Heading;
      if (!instantAnswer && di.Answer) instantAnswer += (instantAnswer ? " " : "") + di.Answer;
    }
    let searchSnippets = [];
    if (ddgHtml.status === "fulfilled" && ddgHtml.value) {
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gis;
      const titleRegex = /<a[^>]+class="result__title"[^>]*>(.*?)<\/a>/gis;
      const snippets = [];
      let m;
      while ((m = snippetRegex.exec(ddgHtml.value)) !== null && snippets.length < 5) {
        const text = m[1].replace(/<[^>]*>/g, "").trim();
        if (text.length > 20) snippets.push(text);
      }
      while ((m = titleRegex.exec(ddgHtml.value)) !== null && snippets.length < 5) {
        const text = m[1].replace(/<[^>]*>/g, "").trim();
        if (text.length > 10) snippets.push(text);
      }
      searchSnippets = snippets;
    }
    return json({ ok: true, query, instantAnswer: instantAnswer || undefined, abstract: abstractText || undefined, source: sourceUrl || undefined, snippets: searchSnippets.length > 0 ? searchSnippets : undefined, searchedAt: new Date().toISOString() });
  } catch (err) {
    return json({ ok: false, error: "搜索失败：" + (err && err.message ? err.message : String(err)) }, 200);
  }
}

// ============ MCP 桥接（JSON-RPC 转发）============
async function handleMcp(request) {
  try {
    const p = await request.json().catch(() => ({}));
    const { url, headers = {}, tool, args = {} } = p;
    if (!url || typeof url !== "string") return json({ ok: false, error: "缺少 MCP 服务地址" }, 200);
    const baseHeaders = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...(headers || {}) };
    const rpc = async (method, params) => {
      const resp = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const ct = resp.headers.get("content-type") || "";
      let data;
      if (ct.includes("text/event-stream")) data = await resp.text();
      else { try { data = await resp.json(); } catch (e) { data = await resp.text(); } }
      return { status: resp.status, data };
    };
    const listRes = await rpc("tools/list", {});
    let callRes = null;
    if (tool) callRes = await rpc("tools/call", { name: tool, arguments: args });
    return json({ ok: true, list: listRes, call: callRes });
  } catch (e) {
    return json({ ok: false, error: "MCP 桥接失败：" + (e && e.message ? e.message : String(e)) }, 200);
  }
}

// ============ 热榜（带 Cache API 缓存 10 分钟）============
async function handleHotlist(request, url, ctx) {
  const srcs = (url.searchParams.get("src") || "douyin").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const force = url.searchParams.get("force") === "1";
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  if (!force && force !== undefined) { /* noop */ }
  if (!force) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const results = await Promise.all(srcs.map((s) => fetchHot(s)));
  const resp = json({ ok: true, at: new Date().toISOString(), available: AVAILABLE, lists: results });
  resp.headers.set("Cache-Control", "public, max-age=600");
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

// ============ 入口 ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET" && (path === "/" || path === "/health")) return json({ ok: true, service: "haoyun-proxy-cf", ts: Date.now() });
    // AI 转发：POST 到 /proxy 或 / 均可（方便用户填根地址）
    if (path === "/proxy" || (path === "/" && request.method === "POST")) return handleProxy(request);
    if (path === "/hotlist") return handleHotlist(request, url, ctx);
    if (path === "/readpage" && request.method === "POST") return handleReadpage(request);
    if (path === "/weather" && request.method === "POST") return handleWeather(request);
    if (path === "/search" && request.method === "POST") return handleSearch(request);
    if (path === "/mcp" && request.method === "POST") return handleMcp(request);
    return json({ ok: false, error: "not found: " + path }, 404);
  },
};
