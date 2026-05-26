import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { a as wrapWebContent, i as wrapExternalContent } from "./external-content-BWPoz0BU.js";
import { i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey } from "./web-shared-CYJpPo1M.js";
import { u as postTrustedWebToolsJson } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./secret-input-CWnTb0tw.js";
import "./security-runtime-CcSekjBd.js";
import "./provider-web-search-DNIStESL.js";
//#region extensions/tavily/src/config.ts
const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
function resolveTavilySearchConfig(cfg) {
	const pluginWebSearch = (cfg?.plugins?.entries?.tavily?.config)?.webSearch;
	if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) return pluginWebSearch;
}
function normalizeConfiguredSecret(value, path) {
	return normalizeSecretInput(normalizeResolvedSecretInputString({
		value,
		path
	}));
}
function resolveTavilyApiKey(cfg) {
	return normalizeConfiguredSecret(resolveTavilySearchConfig(cfg)?.apiKey, "plugins.entries.tavily.config.webSearch.apiKey") || normalizeSecretInput(process.env.TAVILY_API_KEY) || void 0;
}
function resolveTavilyBaseUrl(cfg) {
	return (normalizeOptionalString(resolveTavilySearchConfig(cfg)?.baseUrl) ?? "") || normalizeSecretInput(process.env.TAVILY_BASE_URL) || "https://api.tavily.com";
}
function resolveTavilySearchTimeoutSeconds(override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	return 30;
}
function resolveTavilyExtractTimeoutSeconds(override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	return 60;
}
//#endregion
//#region extensions/tavily/src/tavily-client.ts
const SEARCH_CACHE = /* @__PURE__ */ new Map();
const EXTRACT_CACHE = /* @__PURE__ */ new Map();
const DEFAULT_SEARCH_COUNT = 5;
function resolveEndpoint(baseUrl, pathname) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
	try {
		const url = new URL(trimmed);
		url.pathname = url.pathname.replace(/\/$/, "") + pathname;
		return url.toString();
	} catch {
		return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
	}
}
async function postTavilyJson(params) {
	return postTrustedWebToolsJson({
		url: resolveEndpoint(params.baseUrl, params.pathname),
		timeoutSeconds: params.timeoutSeconds,
		apiKey: params.apiKey,
		body: params.body,
		errorLabel: params.errorLabel,
		extraHeaders: { "X-Client-Source": "openclaw" }
	}, async (response) => readTavilyJsonResponse(response, params.errorLabel));
}
async function readTavilyJsonResponse(response, label) {
	try {
		return await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
}
async function runTavilySearch(params) {
	const apiKey = resolveTavilyApiKey(params.cfg);
	if (!apiKey) throw new Error("web_search (tavily) needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.");
	const count = typeof params.maxResults === "number" && Number.isFinite(params.maxResults) ? Math.max(1, Math.min(20, Math.floor(params.maxResults))) : DEFAULT_SEARCH_COUNT;
	const timeoutSeconds = resolveTavilySearchTimeoutSeconds(params.timeoutSeconds);
	const baseUrl = resolveTavilyBaseUrl(params.cfg);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "tavily-search",
		q: params.query,
		count,
		baseUrl,
		searchDepth: params.searchDepth,
		topic: params.topic,
		includeAnswer: params.includeAnswer,
		timeRange: params.timeRange,
		includeDomains: params.includeDomains,
		excludeDomains: params.excludeDomains
	}));
	const cached = readCache(SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const body = {
		query: params.query,
		max_results: count
	};
	if (params.searchDepth) body.search_depth = params.searchDepth;
	if (params.topic) body.topic = params.topic;
	if (params.includeAnswer) body.include_answer = true;
	if (params.timeRange) body.time_range = params.timeRange;
	if (params.includeDomains?.length) body.include_domains = params.includeDomains;
	if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains;
	const start = Date.now();
	const payload = await postTavilyJson({
		baseUrl,
		pathname: "/search",
		timeoutSeconds,
		apiKey,
		body,
		errorLabel: "Tavily Search"
	});
	const results = (Array.isArray(payload.results) ? payload.results : []).map((r) => Object.assign({
		title: typeof r.title === `string` ? wrapWebContent(r.title, `web_search`) : ``,
		url: typeof r.url === `string` ? r.url : ``,
		snippet: typeof r.content === `string` ? wrapWebContent(r.content, `web_search`) : ``,
		score: typeof r.score === `number` ? r.score : void 0
	}, typeof r.published_date === `string` ? { published: r.published_date } : {}));
	const result = {
		query: params.query,
		provider: "tavily",
		count: results.length,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "tavily",
			wrapped: true
		},
		results
	};
	if (typeof payload.answer === "string" && payload.answer) result.answer = wrapWebContent(payload.answer, "web_search");
	writeCache(SEARCH_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
async function runTavilyExtract(params) {
	const apiKey = resolveTavilyApiKey(params.cfg);
	if (!apiKey) throw new Error("tavily_extract needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.");
	const baseUrl = resolveTavilyBaseUrl(params.cfg);
	const timeoutSeconds = resolveTavilyExtractTimeoutSeconds(params.timeoutSeconds);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "tavily-extract",
		urls: params.urls,
		baseUrl,
		query: params.query,
		extractDepth: params.extractDepth,
		chunksPerSource: params.chunksPerSource,
		includeImages: params.includeImages
	}));
	const cached = readCache(EXTRACT_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const body = { urls: params.urls };
	if (params.query) body.query = params.query;
	if (params.extractDepth) body.extract_depth = params.extractDepth;
	if (params.chunksPerSource) body.chunks_per_source = params.chunksPerSource;
	if (params.includeImages) body.include_images = true;
	const start = Date.now();
	const payload = await postTavilyJson({
		baseUrl,
		pathname: "/extract",
		timeoutSeconds,
		apiKey,
		body,
		errorLabel: "Tavily Extract"
	});
	const results = (Array.isArray(payload.results) ? payload.results : []).map((r) => Object.assign({
		url: typeof r.url === `string` ? r.url : ``,
		rawContent: typeof r.raw_content === `string` ? wrapExternalContent(r.raw_content, {
			source: `web_fetch`,
			includeWarning: false
		}) : ``
	}, typeof r.content === `string` ? { content: wrapExternalContent(r.content, {
		source: `web_fetch`,
		includeWarning: false
	}) } : {}, Array.isArray(r.images) ? { images: r.images.map((img) => wrapExternalContent(img, {
		source: `web_fetch`,
		includeWarning: false
	})) } : {}));
	const failedResults = Array.isArray(payload.failed_results) ? payload.failed_results : [];
	const result = {
		provider: "tavily",
		count: results.length,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_fetch",
			provider: "tavily",
			wrapped: true
		},
		results,
		...failedResults.length > 0 ? { failedResults } : {}
	};
	writeCache(EXTRACT_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
const testing = {
	readTavilyJsonResponse,
	resolveEndpoint
};
//#endregion
export { runTavilySearch as n, testing as r, runTavilyExtract as t };
