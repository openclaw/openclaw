import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { a as readResponseText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-CYJpPo1M.js";
//#region src/agents/tools/web-search-provider-common.ts
const webGuardedFetchLoader = createLazyImportLoader(() => import("./web-guarded-fetch-CL_R462D.js"));
async function loadTrustedWebToolsEndpoint() {
	return (await webGuardedFetchLoader.load()).withTrustedWebToolsEndpoint;
}
async function loadSelfHostedWebToolsEndpoint() {
	return (await webGuardedFetchLoader.load()).withSelfHostedWebToolsEndpoint;
}
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const SEARCH_CACHE = /* @__PURE__ */ new Map();
function resolveSearchTimeoutSeconds(searchConfig) {
	return resolveTimeoutSeconds(searchConfig?.timeoutSeconds, 30);
}
function resolveSearchCacheTtlMs(searchConfig) {
	return resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, 15);
}
function resolveSearchCount(value, fallback) {
	return Math.max(1, Math.min(10, Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback)));
}
function readConfiguredSecretString(value, path) {
	return normalizeSecretInput(normalizeResolvedSecretInputString({
		value,
		path
	})) || void 0;
}
function readProviderEnvValue(envVars) {
	for (const envVar of envVars) {
		const value = normalizeSecretInput(process.env[envVar]);
		if (value) return value;
	}
}
async function withTrustedWebSearchEndpoint(params, run) {
	return (await loadTrustedWebToolsEndpoint())({
		url: params.url,
		init: params.init,
		timeoutSeconds: params.timeoutSeconds,
		signal: params.signal
	}, async ({ response }) => run(response));
}
async function withSelfHostedWebSearchEndpoint(params, run) {
	return (await loadSelfHostedWebToolsEndpoint())({
		url: params.url,
		init: params.init,
		timeoutSeconds: params.timeoutSeconds,
		signal: params.signal
	}, async ({ response }) => run(response));
}
async function postTrustedWebToolsJson(params, parseResponse) {
	return (await loadTrustedWebToolsEndpoint())({
		url: params.url,
		timeoutSeconds: params.timeoutSeconds,
		signal: params.signal,
		init: {
			method: "POST",
			headers: {
				...params.extraHeaders,
				Accept: "application/json",
				Authorization: `Bearer ${params.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(params.body)
		}
	}, async ({ response }) => {
		if (!response.ok) {
			const detail = await readResponseText(response, { maxBytes: params.maxErrorBytes ?? 64e3 });
			throw new Error(`${params.errorLabel} API error (${response.status}): ${detail.text || response.statusText}`);
		}
		return await parseResponse(response);
	});
}
async function throwWebSearchApiError(res, providerLabel) {
	const detail = (await readResponseText(res, { maxBytes: 64e3 })).text;
	throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}
function resolveSiteName(url) {
	if (!url) return;
	try {
		return new URL(url).hostname;
	} catch {
		return;
	}
}
const BRAVE_FRESHNESS_SHORTCUTS = new Set([
	"pd",
	"pw",
	"pm",
	"py"
]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const PERPLEXITY_RECENCY_VALUES = new Set([
	"day",
	"week",
	"month",
	"year"
]);
const FRESHNESS_TO_RECENCY = {
	pd: "day",
	pw: "week",
	pm: "month",
	py: "year"
};
const RECENCY_TO_FRESHNESS = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py"
};
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function isValidIsoDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function isoToPerplexityDate(iso) {
	const match = iso.match(ISO_DATE_PATTERN);
	if (!match) return;
	const [, year, month, day] = match;
	return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}/${year}`;
}
function normalizeToIsoDate(value) {
	const trimmed = value.trim();
	if (ISO_DATE_PATTERN.test(trimmed)) return isValidIsoDate(trimmed) ? trimmed : void 0;
	const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
	if (match) {
		const [, month, day, year] = match;
		const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
		return isValidIsoDate(iso) ? iso : void 0;
	}
}
function parseIsoDateRange(params) {
	const docs = params.docs ?? "https://docs.openclaw.ai/tools/web";
	const dateAfter = params.rawDateAfter ? normalizeToIsoDate(params.rawDateAfter) : void 0;
	if (params.rawDateAfter && !dateAfter) return {
		error: "invalid_date",
		message: params.invalidDateAfterMessage,
		docs
	};
	const dateBefore = params.rawDateBefore ? normalizeToIsoDate(params.rawDateBefore) : void 0;
	if (params.rawDateBefore && !dateBefore) return {
		error: "invalid_date",
		message: params.invalidDateBeforeMessage,
		docs
	};
	if (dateAfter && dateBefore && dateAfter > dateBefore) return {
		error: "invalid_date_range",
		message: params.invalidDateRangeMessage,
		docs
	};
	return {
		dateAfter,
		dateBefore
	};
}
function normalizeFreshness(value, provider) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
	if (PERPLEXITY_RECENCY_VALUES.has(lower)) return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
	if (provider === "brave") {
		const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
		if (match) {
			const [, start, end] = match;
			if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) return `${start}to${end}`;
		}
	}
}
function readCachedSearchPayload(cacheKey) {
	const cached = readCache(SEARCH_CACHE, cacheKey);
	return cached ? {
		...cached.value,
		cached: true
	} : void 0;
}
function buildSearchCacheKey(parts) {
	return normalizeCacheKey(parts.map((part) => part === void 0 ? "default" : String(part)).join(":"));
}
function writeCachedSearchPayload(cacheKey, payload, ttlMs) {
	writeCache(SEARCH_CACHE, cacheKey, payload, ttlMs);
}
function readUnsupportedSearchFilter(params) {
	for (const name of [
		"country",
		"language",
		"freshness",
		"date_after",
		"date_before"
	]) {
		const value = params[name];
		if (typeof value === "string" && value.trim()) return name;
	}
}
function describeUnsupportedSearchFilter(name) {
	switch (name) {
		case "country": return "country filtering";
		case "language": return "language filtering";
		case "freshness": return "freshness filtering";
		case "date_after":
		case "date_before": return "date_after/date_before filtering";
	}
	throw new Error("Unsupported web search filter");
}
function buildUnsupportedSearchFilterResponse(params, provider, docs = "https://docs.openclaw.ai/tools/web") {
	const unsupported = readUnsupportedSearchFilter(params);
	if (!unsupported) return;
	const label = describeUnsupportedSearchFilter(unsupported);
	const supportedLabel = unsupported === "date_after" || unsupported === "date_before" ? "date filtering" : label;
	return {
		error: unsupported.startsWith("date_") ? "unsupported_date_filter" : `unsupported_${unsupported}`,
		message: `${label} is not supported by the ${provider} provider. Only Brave and Perplexity support ${supportedLabel}.`,
		docs
	};
}
//#endregion
export { resolveSiteName as _, buildUnsupportedSearchFilterResponse as a, withTrustedWebSearchEndpoint as b, normalizeToIsoDate as c, readCachedSearchPayload as d, readConfiguredSecretString as f, resolveSearchTimeoutSeconds as g, resolveSearchCount as h, buildSearchCacheKey as i, parseIsoDateRange as l, resolveSearchCacheTtlMs as m, FRESHNESS_TO_RECENCY as n, isoToPerplexityDate as o, readProviderEnvValue as p, MAX_SEARCH_COUNT as r, normalizeFreshness as s, DEFAULT_SEARCH_COUNT as t, postTrustedWebToolsJson as u, throwWebSearchApiError as v, writeCachedSearchPayload as x, withSelfHostedWebSearchEndpoint as y };
