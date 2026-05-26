import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { a as readResponseText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-CYJpPo1M.js";
import { _ as resolveSiteName, b as withTrustedWebSearchEndpoint, h as resolveSearchCount } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-web-search-DNIStESL.js";
//#region extensions/duckduckgo/src/config.ts
const DEFAULT_DDG_SAFE_SEARCH = "moderate";
function resolveDdgWebSearchConfig(config) {
	const webSearch = (config?.plugins?.entries?.duckduckgo?.config)?.webSearch;
	if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) return webSearch;
}
function resolveDdgRegion(config) {
	const region = resolveDdgWebSearchConfig(config)?.region;
	if (typeof region !== "string") return;
	return region.trim() || void 0;
}
function resolveDdgSafeSearch(config) {
	const safeSearch = resolveDdgWebSearchConfig(config)?.safeSearch;
	const normalized = normalizeLowercaseStringOrEmpty(safeSearch);
	if (normalized === "strict" || normalized === "off") return normalized;
	return DEFAULT_DDG_SAFE_SEARCH;
}
//#endregion
//#region extensions/duckduckgo/src/ddg-client.ts
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DEFAULT_TIMEOUT_SECONDS = 20;
const DDG_SAFE_SEARCH_PARAM = {
	strict: "1",
	moderate: "-1",
	off: "-2"
};
const DDG_SEARCH_CACHE = /* @__PURE__ */ new Map();
function decodeHtmlEntities(text) {
	return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "-").replace(/&mdash;/g, "--").replace(/&hellip;/g, "...").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
function stripHtml(html) {
	return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function decodeDuckDuckGoUrl(rawUrl) {
	try {
		const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
		const uddg = new URL(normalized).searchParams.get("uddg");
		if (uddg) return uddg;
	} catch {}
	return rawUrl;
}
function readHrefAttribute(tagAttributes) {
	return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? "";
}
function isBotChallenge(html) {
	if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false;
	return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}
function parseDuckDuckGoHtml(html) {
	const results = [];
	const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
	const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
	const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;
	for (const match of html.matchAll(resultRegex)) {
		const rawAttributes = match[1] ?? "";
		const rawTitle = match[2] ?? "";
		const rawUrl = readHrefAttribute(rawAttributes);
		const matchEnd = (match.index ?? 0) + match[0].length;
		const trailingHtml = html.slice(matchEnd);
		const nextResultIndex = trailingHtml.search(nextResultRegex);
		const scopedTrailingHtml = nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
		const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
		const title = decodeHtmlEntities(stripHtml(rawTitle));
		const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
		const snippet = decodeHtmlEntities(stripHtml(rawSnippet));
		if (title && url) results.push({
			title,
			url,
			snippet
		});
	}
	return results;
}
async function runDuckDuckGoSearch(params) {
	const count = resolveSearchCount(params.count, 5);
	const region = params.region ?? resolveDdgRegion(params.config);
	const safeSearch = params.safeSearch === "strict" || params.safeSearch === "moderate" || params.safeSearch === "off" ? params.safeSearch : resolveDdgSafeSearch(params.config);
	const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
	const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, 15);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		provider: "duckduckgo",
		query: params.query,
		count,
		region: region ?? "",
		safeSearch
	}));
	const cached = readCache(DDG_SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const url = new URL(DDG_HTML_ENDPOINT);
	url.searchParams.set("q", params.query);
	if (region) url.searchParams.set("kl", region);
	url.searchParams.set("kp", DDG_SAFE_SEARCH_PARAM[safeSearch]);
	const startedAt = Date.now();
	const results = await withTrustedWebSearchEndpoint({
		url: url.toString(),
		timeoutSeconds,
		init: {
			method: "GET",
			headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" }
		}
	}, async (response) => {
		if (!response.ok) {
			const detail = (await readResponseText(response, { maxBytes: 64e3 })).text;
			throw new Error(`DuckDuckGo search error (${response.status}): ${detail || response.statusText}`);
		}
		const html = await response.text();
		if (isBotChallenge(html)) throw new Error("DuckDuckGo returned a bot-detection challenge.");
		return parseDuckDuckGoHtml(html).slice(0, count);
	});
	const payload = {
		query: params.query,
		provider: "duckduckgo",
		count: results.length,
		tookMs: Date.now() - startedAt,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "duckduckgo",
			wrapped: true
		},
		results: results.map((result) => ({
			title: wrapWebContent(result.title, "web_search"),
			url: result.url,
			snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
			siteName: resolveSiteName(result.url) || void 0
		}))
	};
	writeCache(DDG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
	return payload;
}
const testing = {
	decodeDuckDuckGoUrl,
	decodeHtmlEntities,
	isBotChallenge,
	parseDuckDuckGoHtml
};
//#endregion
export { testing as __testing, testing, runDuckDuckGoSearch };
