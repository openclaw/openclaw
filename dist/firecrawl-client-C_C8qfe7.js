import { h as resolveSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { _ as resolvePinnedHostnameWithPolicy, c as isBlockedHostnameOrIp, t as SsrFBlockedError, u as isPrivateIpAddress } from "./ssrf-DdDeGa5L.js";
import { a as wrapWebContent, i as wrapExternalContent } from "./external-content-BWPoz0BU.js";
import { a as truncateText, r as markdownToText } from "./web-fetch-utils-C4SBPqhU.js";
import { a as readResponseText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey } from "./web-shared-CYJpPo1M.js";
import "./secret-input-CWnTb0tw.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { n as withSelfHostedWebToolsEndpoint, r as withStrictWebToolsEndpoint } from "./web-guarded-fetch-CK8ghWAC.js";
import "./security-runtime-CcSekjBd.js";
import { i as canResolveEnvSecretRefInReadOnlyPath } from "./extension-shared-DSIp8QS_.js";
import "./provider-web-fetch-B-3BHMbf.js";
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 1728e5;
const FIRECRAWL_API_KEY_ENV_VAR = "FIRECRAWL_API_KEY";
function resolveSearchConfig(cfg) {
	const search = cfg?.tools?.web?.search;
	if (!search || typeof search !== "object") return;
	return search;
}
function resolveFetchConfig(cfg) {
	const fetch = cfg?.tools?.web?.fetch;
	if (!fetch || typeof fetch !== "object") return;
	return fetch;
}
function resolveFirecrawlSearchConfig(cfg) {
	const pluginWebSearch = (cfg?.plugins?.entries?.firecrawl?.config)?.webSearch;
	if (pluginWebSearch && typeof pluginWebSearch === "object" && !Array.isArray(pluginWebSearch)) return pluginWebSearch;
	const search = resolveSearchConfig(cfg);
	if (!search || typeof search !== "object") return;
	const firecrawl = "firecrawl" in search ? search.firecrawl : void 0;
	if (!firecrawl || typeof firecrawl !== "object") return;
	return firecrawl;
}
function resolveFirecrawlFetchConfig(cfg) {
	const pluginWebFetch = (cfg?.plugins?.entries?.firecrawl?.config)?.webFetch;
	if (pluginWebFetch && typeof pluginWebFetch === "object" && !Array.isArray(pluginWebFetch)) return pluginWebFetch;
	const fetch = resolveFetchConfig(cfg);
	if (!fetch || typeof fetch !== "object") return;
	const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : void 0;
	if (!firecrawl || typeof firecrawl !== "object") return;
	return firecrawl;
}
function resolveConfiguredSecret(value, path, cfg) {
	const resolved = resolveSecretInputString({
		value,
		path,
		defaults: cfg?.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status === "available") {
		const normalized = normalizeSecretInput(resolved.value);
		return normalized ? {
			status: "available",
			value: normalized
		} : { status: "missing" };
	}
	if (resolved.status === "missing") return { status: "missing" };
	if (resolved.ref.source !== "env") return { status: "blocked" };
	const envVarName = resolved.ref.id.trim();
	if (envVarName !== FIRECRAWL_API_KEY_ENV_VAR) return { status: "blocked" };
	if (!canResolveEnvSecretRefInReadOnlyPath({
		cfg,
		provider: resolved.ref.provider,
		id: envVarName
	})) return { status: "blocked" };
	const envValue = normalizeSecretInput(process.env[envVarName]);
	return envValue ? {
		status: "available",
		value: envValue
	} : { status: "missing" };
}
function resolveFirecrawlApiKey(cfg) {
	const pluginConfig = cfg?.plugins?.entries?.firecrawl?.config;
	const search = resolveFirecrawlSearchConfig(cfg);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	const configuredCandidates = [
		{
			value: pluginConfig?.webFetch?.apiKey,
			path: "plugins.entries.firecrawl.config.webFetch.apiKey"
		},
		{
			value: search?.apiKey,
			path: "plugins.entries.firecrawl.config.webSearch.apiKey"
		},
		{
			value: search?.apiKey,
			path: "tools.web.search.firecrawl.apiKey"
		},
		{
			value: fetch?.apiKey,
			path: "tools.web.fetch.firecrawl.apiKey"
		}
	];
	let blockedConfiguredSecret = false;
	for (const candidate of configuredCandidates) {
		const resolved = resolveConfiguredSecret(candidate.value, candidate.path, cfg);
		if (resolved.status === "available") return resolved.value;
		if (resolved.status === "blocked") blockedConfiguredSecret = true;
	}
	if (blockedConfiguredSecret) return;
	return normalizeSecretInput(process.env[FIRECRAWL_API_KEY_ENV_VAR]) || void 0;
}
function resolveFirecrawlBaseUrl(cfg) {
	const search = resolveFirecrawlSearchConfig(cfg);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	return (typeof search?.baseUrl === "string" ? search.baseUrl.trim() : "") || (typeof fetch?.baseUrl === "string" ? fetch.baseUrl.trim() : "") || normalizeSecretInput(process.env.FIRECRAWL_BASE_URL) || "https://api.firecrawl.dev";
}
function resolveFirecrawlOnlyMainContent(cfg, override) {
	if (typeof override === "boolean") return override;
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.onlyMainContent === "boolean") return fetch.onlyMainContent;
	return true;
}
function resolveFirecrawlMaxAgeMs(cfg, override) {
	if (typeof override === "number" && Number.isFinite(override) && override >= 0) return Math.floor(override);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.maxAgeMs === "number" && Number.isFinite(fetch.maxAgeMs) && fetch.maxAgeMs >= 0) return Math.floor(fetch.maxAgeMs);
	return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}
function resolveFirecrawlScrapeTimeoutSeconds(cfg, override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	const fetch = resolveFirecrawlFetchConfig(cfg);
	if (typeof fetch?.timeoutSeconds === "number" && Number.isFinite(fetch.timeoutSeconds) && fetch.timeoutSeconds > 0) return Math.floor(fetch.timeoutSeconds);
	return 60;
}
function resolveFirecrawlSearchTimeoutSeconds(override) {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return Math.floor(override);
	return 30;
}
//#endregion
//#region extensions/firecrawl/src/firecrawl-client.ts
const SEARCH_CACHE = /* @__PURE__ */ new Map();
const SCRAPE_CACHE = /* @__PURE__ */ new Map();
const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_SCRAPE_MAX_CHARS = 5e4;
const ALLOWED_FIRECRAWL_HOSTS = new Set(["api.firecrawl.dev"]);
const FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR = "Firecrawl custom baseUrl must target a private or internal self-hosted endpoint.";
const FIRECRAWL_HTTP_PRIVATE_ERROR = "Firecrawl HTTP baseUrl must target a private or internal self-hosted endpoint. Use https:// for public hosts.";
async function readFirecrawlJsonResponse(response, label) {
	try {
		return await response.json();
	} catch (cause) {
		throw new Error(`${label}: malformed JSON response`, { cause });
	}
}
function assertFirecrawlScrapeTargetAllowed(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new SsrFBlockedError("Invalid URL supplied to Firecrawl scrape");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new SsrFBlockedError(`Blocked non-HTTP(S) protocol in Firecrawl scrape URL: ${parsed.protocol}`);
	if (isBlockedHostnameOrIp(parsed.hostname)) throw new SsrFBlockedError(`Blocked hostname or private/internal IP in Firecrawl scrape URL: ${parsed.hostname}`);
}
function isOfficialFirecrawlEndpoint(url) {
	return url.protocol === "https:" && ALLOWED_FIRECRAWL_HOSTS.has(url.hostname);
}
async function firecrawlEndpointTargetsPrivateNetwork(url, lookupFn) {
	if (isBlockedHostnameOrIp(url.hostname)) return true;
	try {
		return (await resolvePinnedHostnameWithPolicy(url.hostname, {
			lookupFn,
			policy: { allowPrivateNetwork: true }
		})).addresses.every((address) => isPrivateIpAddress(address));
	} catch {
		return false;
	}
}
async function validateFirecrawlBaseUrl(baseUrl, lookupFn) {
	let url;
	try {
		url = new URL(baseUrl.trim() || "https://api.firecrawl.dev");
	} catch {
		throw new Error("Firecrawl baseUrl must be a valid http:// or https:// URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Firecrawl baseUrl must use http:// or https://.");
	if (isOfficialFirecrawlEndpoint(url)) return "strict";
	if (await firecrawlEndpointTargetsPrivateNetwork(url, lookupFn)) return "selfHosted";
	if (url.protocol === "http:") throw new Error(FIRECRAWL_HTTP_PRIVATE_ERROR);
	throw new Error(`${FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR} Host: ${url.hostname}`);
}
async function resolveEndpoint(baseUrl, pathname, lookupFn) {
	const url = new URL(baseUrl.trim() || "https://api.firecrawl.dev");
	const mode = await validateFirecrawlBaseUrl(url.toString(), lookupFn);
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	url.pathname = pathname;
	return {
		url: url.toString(),
		mode
	};
}
async function postFirecrawlJson(params, parse) {
	const apiKey = normalizeSecretInput(params.apiKey);
	return await ((params.mode ?? await validateFirecrawlBaseUrl(params.url)) === "selfHosted" ? withSelfHostedWebToolsEndpoint : withStrictWebToolsEndpoint)({
		url: params.url,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(params.body)
		}
	}, async ({ response }) => {
		if (!response.ok) {
			let detail = typeof response.statusText === "string" && response.statusText.trim() ? response.statusText.trim() : "request failed";
			const readJsonPayload = async () => {
				const candidate = response;
				const jsonResponse = typeof candidate.clone === "function" ? candidate.clone() : response;
				if (typeof jsonResponse.json !== "function") return null;
				try {
					const payload = await jsonResponse.json();
					return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
				} catch {
					return null;
				}
			};
			const payload = await readJsonPayload();
			if (payload) detail = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : detail;
			else {
				const errorBody = await readResponseText(response, { maxBytes: 64e3 });
				if (errorBody.text) detail = errorBody.text;
			}
			const safeDetail = wrapWebContent(detail.slice(0, 1e3), "web_fetch");
			throw new Error(`${params.errorLabel} API error (${response.status}): ${safeDetail}`);
		}
		return await parse(response);
	});
}
function resolveSiteName(urlRaw) {
	try {
		return new URL(urlRaw).hostname.replace(/^www\./, "") || void 0;
	} catch {
		return;
	}
}
function resolveSearchItems(payload) {
	const rawItems = [
		payload.data,
		payload.results,
		payload.data?.results,
		payload.data?.data,
		payload.data?.web,
		payload.web?.results
	].find((candidate) => Array.isArray(candidate));
	if (!Array.isArray(rawItems)) return [];
	const items = [];
	for (const entry of rawItems) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry;
		const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : void 0;
		const url = typeof record.url === "string" && record.url || typeof record.sourceURL === "string" && record.sourceURL || typeof record.sourceUrl === "string" && record.sourceUrl || typeof metadata?.sourceURL === "string" && metadata.sourceURL || "";
		if (!url) continue;
		const title = typeof record.title === "string" && record.title || typeof metadata?.title === "string" && metadata.title || "";
		const description = typeof record.description === "string" && record.description || typeof record.snippet === "string" && record.snippet || typeof record.summary === "string" && record.summary || void 0;
		const content = typeof record.markdown === "string" && record.markdown || typeof record.content === "string" && record.content || typeof record.text === "string" && record.text || void 0;
		const published = typeof record.publishedDate === "string" && record.publishedDate || typeof record.published === "string" && record.published || typeof metadata?.publishedTime === "string" && metadata.publishedTime || typeof metadata?.publishedDate === "string" && metadata.publishedDate || void 0;
		items.push({
			title,
			url,
			description,
			content,
			published,
			siteName: resolveSiteName(url)
		});
	}
	return items;
}
function buildSearchPayload(params) {
	return {
		query: params.query,
		provider: params.provider,
		count: params.items.length,
		tookMs: params.tookMs,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: params.provider,
			wrapped: true
		},
		results: params.items.map((entry) => ({
			title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
			url: entry.url,
			description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
			...entry.published ? { published: entry.published } : {},
			...entry.siteName ? { siteName: entry.siteName } : {},
			...params.scrapeResults && entry.content ? { content: wrapWebContent(entry.content, "web_search") } : {}
		}))
	};
}
async function runFirecrawlSearch(params) {
	const apiKey = resolveFirecrawlApiKey(params.cfg);
	if (!apiKey) throw new Error("web_search (firecrawl) needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webSearch.apiKey.");
	const count = typeof params.count === "number" && Number.isFinite(params.count) ? Math.max(1, Math.min(10, Math.floor(params.count))) : DEFAULT_SEARCH_COUNT;
	const timeoutSeconds = resolveFirecrawlSearchTimeoutSeconds(params.timeoutSeconds);
	const scrapeResults = params.scrapeResults === true;
	const sources = Array.isArray(params.sources) ? params.sources.filter(Boolean) : [];
	const categories = Array.isArray(params.categories) ? params.categories.filter(Boolean) : [];
	const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "firecrawl-search",
		q: params.query,
		count,
		baseUrl,
		sources,
		categories,
		scrapeResults
	}));
	const cached = readCache(SEARCH_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const body = {
		query: params.query,
		limit: count
	};
	if (sources.length > 0) body.sources = sources;
	if (categories.length > 0) body.categories = categories;
	if (scrapeResults) body.scrapeOptions = { formats: ["markdown"] };
	const start = Date.now();
	const endpoint = await resolveEndpoint(baseUrl, "/v2/search");
	const payload = await postFirecrawlJson({
		url: endpoint.url,
		mode: endpoint.mode,
		timeoutSeconds,
		apiKey,
		body,
		errorLabel: "Firecrawl Search"
	}, async (response) => {
		const payload = await readFirecrawlJsonResponse(response, "Firecrawl Search API error");
		if (payload.success === false) {
			const error = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : "unknown error";
			throw new Error(`Firecrawl Search API error: ${error}`);
		}
		return payload;
	});
	const result = buildSearchPayload({
		query: params.query,
		provider: "firecrawl",
		items: resolveSearchItems(payload),
		tookMs: Date.now() - start,
		scrapeResults
	});
	writeCache(SEARCH_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
function resolveScrapeData(payload) {
	const data = payload.data;
	if (data && typeof data === "object") return data;
	return {};
}
function parseFirecrawlScrapePayload(params) {
	const data = resolveScrapeData(params.payload);
	const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : void 0;
	const markdown = typeof data.markdown === "string" && data.markdown || typeof data.content === "string" && data.content || "";
	if (!markdown) throw new Error("Firecrawl scrape returned no content.");
	const rawText = params.extractMode === "text" ? markdownToText(markdown) : markdown;
	const truncated = truncateText(rawText, params.maxChars);
	return {
		url: params.url,
		finalUrl: typeof metadata?.sourceURL === "string" && metadata.sourceURL || typeof data.url === "string" && data.url || params.url,
		status: typeof metadata?.statusCode === "number" && metadata.statusCode || typeof data.statusCode === "number" && data.statusCode || void 0,
		title: typeof metadata?.title === "string" && metadata.title ? wrapExternalContent(metadata.title, {
			source: "web_fetch",
			includeWarning: false
		}) : void 0,
		extractor: "firecrawl",
		extractMode: params.extractMode,
		externalContent: {
			untrusted: true,
			source: "web_fetch",
			wrapped: true
		},
		truncated: truncated.truncated,
		rawLength: rawText.length,
		wrappedLength: wrapExternalContent(truncated.text, {
			source: "web_fetch",
			includeWarning: false
		}).length,
		text: wrapExternalContent(truncated.text, {
			source: "web_fetch",
			includeWarning: false
		}),
		warning: typeof params.payload.warning === "string" && params.payload.warning ? wrapExternalContent(params.payload.warning, {
			source: "web_fetch",
			includeWarning: false
		}) : void 0
	};
}
async function runFirecrawlScrape(params) {
	assertFirecrawlScrapeTargetAllowed(params.url);
	const apiKey = resolveFirecrawlApiKey(params.cfg);
	if (!apiKey) throw new Error("firecrawl_scrape needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webFetch.apiKey.");
	const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
	const timeoutSeconds = resolveFirecrawlScrapeTimeoutSeconds(params.cfg, params.timeoutSeconds);
	const onlyMainContent = resolveFirecrawlOnlyMainContent(params.cfg, params.onlyMainContent);
	const maxAgeMs = resolveFirecrawlMaxAgeMs(params.cfg, params.maxAgeMs);
	const proxy = params.proxy ?? "auto";
	const storeInCache = params.storeInCache ?? true;
	const maxChars = typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0 ? Math.floor(params.maxChars) : DEFAULT_SCRAPE_MAX_CHARS;
	const cacheKey = normalizeCacheKey(JSON.stringify({
		type: "firecrawl-scrape",
		url: params.url,
		extractMode: params.extractMode,
		baseUrl,
		onlyMainContent,
		maxAgeMs,
		proxy,
		storeInCache,
		maxChars
	}));
	const cached = readCache(SCRAPE_CACHE, cacheKey);
	if (cached) return {
		...cached.value,
		cached: true
	};
	const endpoint = await resolveEndpoint(baseUrl, "/v2/scrape");
	const result = parseFirecrawlScrapePayload({
		payload: await postFirecrawlJson({
			url: endpoint.url,
			mode: endpoint.mode,
			timeoutSeconds,
			apiKey,
			errorLabel: "Firecrawl",
			body: {
				url: params.url,
				formats: ["markdown"],
				onlyMainContent,
				timeout: timeoutSeconds * 1e3,
				maxAge: maxAgeMs,
				proxy,
				storeInCache
			}
		}, async (response) => {
			const payload = await readFirecrawlJsonResponse(response, "Firecrawl fetch failed");
			if (payload.success === false) {
				const detail = typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : response.statusText;
				throw new Error(`Firecrawl fetch failed (${response.status}): ${wrapWebContent(detail, "web_fetch")}`.trim());
			}
			return payload;
		}),
		url: params.url,
		extractMode: params.extractMode,
		maxChars
	});
	writeCache(SCRAPE_CACHE, cacheKey, result, resolveCacheTtlMs(void 0, 15));
	return result;
}
const testing = {
	assertFirecrawlScrapeTargetAllowed,
	parseFirecrawlScrapePayload,
	postFirecrawlJson,
	resolveEndpoint,
	validateFirecrawlBaseUrl,
	resolveSearchItems
};
//#endregion
export { testing as a, runFirecrawlSearch as i, parseFirecrawlScrapePayload as n, runFirecrawlScrape as r, assertFirecrawlScrapeTargetAllowed as t };
