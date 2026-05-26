import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { _ as resolvePinnedHostnameWithPolicy, c as isBlockedHostnameOrIp, u as isPrivateIpAddress } from "./ssrf-DdDeGa5L.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { a as readResponseText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-CYJpPo1M.js";
import { _ as resolveSiteName, b as withTrustedWebSearchEndpoint, h as resolveSearchCount, y as withSelfHostedWebSearchEndpoint } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./secret-input-CWnTb0tw.js";
import { t as assertHttpUrlTargetsPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./provider-web-search-DNIStESL.js";
//#region extensions/searxng/src/config.ts
function normalizeConfiguredString(value, path) {
	try {
		return normalizeSecretInput(normalizeResolvedSecretInputString({
			value,
			path
		}));
	} catch {
		return;
	}
}
function readInlineEnvSecretRefValue(value, env) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	if (record.source !== "env" || typeof record.id !== "string") return;
	return normalizeSecretInput(env[record.id]);
}
function normalizeTrimmedString(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function normalizeBaseUrl(value) {
	return value?.replace(/\/+$/u, "") || void 0;
}
function resolveSearxngWebSearchConfig(config) {
	const webSearch = (config?.plugins?.entries?.searxng?.config)?.webSearch;
	if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) return webSearch;
}
function resolveSearxngBaseUrl(config, env = process.env) {
	const webSearch = resolveSearxngWebSearchConfig(config);
	return normalizeBaseUrl(normalizeConfiguredString(webSearch?.baseUrl, "plugins.entries.searxng.config.webSearch.baseUrl")) ?? normalizeBaseUrl(readInlineEnvSecretRefValue(webSearch?.baseUrl, env)) ?? normalizeBaseUrl(normalizeSecretInput(env.SEARXNG_BASE_URL));
}
function resolveSearxngCategories(config) {
	return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.categories);
}
function resolveSearxngLanguage(config) {
	return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.language);
}
//#endregion
//#region extensions/searxng/src/searxng-client.ts
const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_RESPONSE_BYTES = 1e6;
const SEARXNG_SEARCH_CACHE = /* @__PURE__ */ new Map();
function normalizeSearxngResult(value) {
	if (!value || typeof value !== "object") return null;
	const candidate = value;
	if (typeof candidate.url !== "string" || typeof candidate.title !== "string") return null;
	return {
		url: candidate.url,
		title: candidate.title,
		content: typeof candidate.content === "string" ? candidate.content : void 0,
		img_src: typeof candidate.img_src === "string" ? candidate.img_src : void 0
	};
}
function buildSearxngSearchUrl(params) {
	const url = new URL(params.baseUrl);
	url.pathname = url.pathname.endsWith("/") ? `${url.pathname}search` : `${url.pathname}/search`;
	url.search = "";
	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");
	if (params.categories) url.searchParams.set("categories", params.categories);
	if (params.language) url.searchParams.set("language", params.language);
	return url.toString();
}
function shouldRetryEmptyCategorySearchWithGeneral(categories) {
	if (!categories) return false;
	const normalized = categories.split(",").map((category) => category.trim().toLowerCase()).filter((category) => category.length > 0);
	return normalized.length > 0 && !normalized.includes("general");
}
async function searxngEndpointTargetsPrivateNetwork(url, lookupFn) {
	if (isBlockedHostnameOrIp(url.hostname)) return true;
	try {
		return (await resolvePinnedHostnameWithPolicy(url.hostname, {
			lookupFn,
			policy: {
				allowPrivateNetwork: true,
				allowRfc2544BenchmarkRange: true
			}
		})).addresses.every((address) => isPrivateIpAddress(address));
	} catch {
		return false;
	}
}
async function validateSearxngBaseUrl(baseUrl, lookupFn) {
	let parsed;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error("SearXNG base URL must be a valid http:// or https:// URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("SearXNG base URL must use http:// or https://.");
	if (parsed.protocol === "http:") {
		await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
			dangerouslyAllowPrivateNetwork: true,
			lookupFn,
			errorMessage: "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts."
		});
		return "selfHosted";
	}
	return await searxngEndpointTargetsPrivateNetwork(parsed, lookupFn) ? "selfHosted" : "strict";
}
function parseSearxngResponseText(text, count) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("SearXNG returned invalid JSON.");
	}
	if (!parsed || typeof parsed !== "object") return [];
	const response = parsed;
	const rawResults = Array.isArray(response.results) ? response.results : [];
	const results = [];
	for (const rawResult of rawResults) {
		const result = normalizeSearxngResult(rawResult);
		if (result) results.push(result);
		if (results.length >= count) break;
	}
	return results;
}
async function fetchSearxngResults(params) {
	const url = buildSearxngSearchUrl({
		baseUrl: params.baseUrl,
		query: params.query,
		categories: params.categories,
		language: params.language
	});
	return await (params.endpointMode === "selfHosted" ? withSelfHostedWebSearchEndpoint : withTrustedWebSearchEndpoint)({
		url,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "GET",
			headers: { Accept: "application/json" }
		}
	}, async (response) => {
		if (!response.ok) {
			const detail = (await readResponseText(response, { maxBytes: 64e3 })).text;
			throw new Error(`SearXNG search error (${response.status}): ${detail || response.statusText}`);
		}
		const body = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
		if (body.truncated) throw new Error("SearXNG response too large.");
		return parseSearxngResponseText(body.text, params.count);
	});
}
async function runSearxngSearch(params) {
	const count = resolveSearchCount(params.count, 5);
	const categories = params.categories ?? resolveSearxngCategories(params.config);
	const language = params.language ?? resolveSearxngLanguage(params.config);
	const baseUrl = params.baseUrl ?? resolveSearxngBaseUrl(params.config);
	const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
	const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, 15);
	if (!baseUrl) throw new Error("SearXNG base URL is not configured. Set SEARXNG_BASE_URL or configure plugins.entries.searxng.config.webSearch.baseUrl.");
	const endpointMode = await validateSearxngBaseUrl(baseUrl);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		provider: "searxng",
		query: params.query,
		count,
		categories: categories ?? "",
		language: language ?? "",
		baseUrl
	}));
	const cached = readCache(SEARXNG_SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const startedAt = Date.now();
	let results = await fetchSearxngResults({
		baseUrl,
		query: params.query,
		categories,
		language,
		timeoutSeconds,
		count,
		endpointMode
	});
	if (results.length === 0 && shouldRetryEmptyCategorySearchWithGeneral(categories)) results = await fetchSearxngResults({
		baseUrl,
		query: params.query,
		categories: "general",
		language,
		timeoutSeconds,
		count,
		endpointMode
	});
	const payload = {
		query: params.query,
		provider: "searxng",
		count: results.length,
		tookMs: Date.now() - startedAt,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "searxng",
			wrapped: true
		},
		results: results.map((result) => ({
			title: wrapWebContent(result.title, "web_search"),
			url: result.url,
			snippet: result.content ? wrapWebContent(result.content, "web_search") : "",
			siteName: resolveSiteName(result.url) || void 0,
			img_src: result.img_src || void 0
		}))
	};
	writeCache(SEARXNG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
	return payload;
}
const testing = {
	buildSearxngSearchUrl,
	normalizeSearxngResult,
	parseSearxngResponseText,
	shouldRetryEmptyCategorySearchWithGeneral,
	validateSearxngBaseUrl,
	SEARXNG_SEARCH_CACHE
};
//#endregion
export { testing as __testing, testing, runSearxngSearch };
