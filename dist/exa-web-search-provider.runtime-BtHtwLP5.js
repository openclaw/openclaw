import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { f as readNumberParam, g as readStringParam } from "./common-E9YpX7pB.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { _ as resolveSiteName, b as withTrustedWebSearchEndpoint, d as readCachedSearchPayload, f as readConfiguredSecretString, g as resolveSearchTimeoutSeconds, i as buildSearchCacheKey, l as parseIsoDateRange, m as resolveSearchCacheTtlMs, p as readProviderEnvValue, x as writeCachedSearchPayload } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import "./provider-web-search-DNIStESL.js";
//#region extensions/exa/src/exa-web-search-provider.runtime.ts
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_SEARCH_TYPES = [
	"auto",
	"neural",
	"fast",
	"deep",
	"deep-reasoning",
	"instant"
];
const EXA_FRESHNESS_VALUES = [
	"day",
	"week",
	"month",
	"year"
];
const EXA_MAX_SEARCH_COUNT = 100;
async function readExaSearchResults(response) {
	try {
		return normalizeExaResults(await response.json());
	} catch (cause) {
		throw new Error("Exa API returned malformed JSON", { cause });
	}
}
function normalizeExaFreshness(value) {
	const trimmed = normalizeOptionalLowercaseString(value);
	if (!trimmed) return;
	return EXA_FRESHNESS_VALUES.includes(trimmed) ? trimmed : void 0;
}
function resolveExaConfig(searchConfig) {
	const exa = searchConfig?.exa;
	return exa && typeof exa === "object" && !Array.isArray(exa) ? exa : {};
}
function resolveExaApiKey(exa) {
	return readConfiguredSecretString(exa?.apiKey, "tools.web.search.exa.apiKey") ?? readProviderEnvValue(["EXA_API_KEY"]);
}
function invalidBaseUrlPayload(value) {
	return {
		error: "invalid_base_url",
		message: `plugins.entries.exa.config.webSearch.baseUrl must be a valid http(s) URL. Got: ${value}`,
		docs: "https://docs.openclaw.ai/tools/exa-search"
	};
}
function resolveExaSearchEndpoint(exa) {
	const configured = normalizeOptionalString(exa?.baseUrl);
	if (!configured) return { endpoint: EXA_SEARCH_ENDPOINT };
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(configured) && !/^https?:\/\//i.test(configured)) return invalidBaseUrlPayload(configured);
	const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
	let parsed;
	try {
		parsed = new URL(candidate);
	} catch {
		return invalidBaseUrlPayload(configured);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalidBaseUrlPayload(configured);
	const pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = pathname.endsWith("/search") ? pathname : `${pathname === "" ? "" : pathname}/search`;
	parsed.hash = "";
	return { endpoint: parsed.toString() };
}
function resolveExaDescription(result) {
	const highlights = result.highlights;
	if (Array.isArray(highlights)) {
		const highlightText = highlights.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry)).join("\n");
		if (highlightText) return highlightText;
	}
	const summary = normalizeOptionalString(result.summary);
	if (summary) return summary;
	return normalizeOptionalString(result.text) ?? "";
}
function parsePositiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function invalidContentsPayload(message) {
	return {
		error: "invalid_contents",
		message,
		docs: "https://docs.openclaw.ai/tools/web"
	};
}
function isErrorPayload(value) {
	return Boolean(value && typeof value === "object" && "error" in value && "message" in value && "docs" in value);
}
function resolveExaSearchCount(value, fallback) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.min(EXA_MAX_SEARCH_COUNT, Math.floor(parsed)));
}
function parseExaContents(rawContents) {
	if (rawContents === void 0) return { value: void 0 };
	if (!rawContents || typeof rawContents !== "object" || Array.isArray(rawContents)) return invalidContentsPayload("contents must be an object with optional text, highlights, and summary fields.");
	const raw = rawContents;
	const allowedKeys = new Set([
		"text",
		"highlights",
		"summary"
	]);
	for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) return invalidContentsPayload(`contents has unknown field "${key}". Only "text", "highlights", and "summary" are allowed.`);
	const parsed = {};
	const parseText = (value) => {
		if (typeof value === "boolean") return value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return invalidContentsPayload("contents.text must be a boolean or an object.");
		const obj = value;
		for (const key of Object.keys(obj)) if (key !== "maxCharacters") return invalidContentsPayload(`contents.text has unknown field "${key}". Only "maxCharacters" is allowed.`);
		if ("maxCharacters" in obj && parsePositiveInteger(obj.maxCharacters) === void 0) return invalidContentsPayload("contents.text.maxCharacters must be a positive integer.");
		return parsePositiveInteger(obj.maxCharacters) ? { maxCharacters: parsePositiveInteger(obj.maxCharacters) } : {};
	};
	const parseHighlights = (value) => {
		if (typeof value === "boolean") return value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return invalidContentsPayload("contents.highlights must be a boolean or an object.");
		const obj = value;
		const allowed = new Set([
			"maxCharacters",
			"query",
			"numSentences",
			"highlightsPerUrl"
		]);
		for (const key of Object.keys(obj)) if (!allowed.has(key)) return invalidContentsPayload(`contents.highlights has unknown field "${key}". Allowed fields are "maxCharacters", "query", "numSentences", and "highlightsPerUrl".`);
		if ("maxCharacters" in obj && parsePositiveInteger(obj.maxCharacters) === void 0) return invalidContentsPayload("contents.highlights.maxCharacters must be a positive integer.");
		if ("numSentences" in obj && parsePositiveInteger(obj.numSentences) === void 0) return invalidContentsPayload("contents.highlights.numSentences must be a positive integer.");
		if ("highlightsPerUrl" in obj && parsePositiveInteger(obj.highlightsPerUrl) === void 0) return invalidContentsPayload("contents.highlights.highlightsPerUrl must be a positive integer.");
		if ("query" in obj && typeof obj.query !== "string") return invalidContentsPayload("contents.highlights.query must be a string.");
		return {
			...parsePositiveInteger(obj.maxCharacters) ? { maxCharacters: parsePositiveInteger(obj.maxCharacters) } : {},
			...typeof obj.query === "string" ? { query: obj.query } : {},
			...parsePositiveInteger(obj.numSentences) ? { numSentences: parsePositiveInteger(obj.numSentences) } : {},
			...parsePositiveInteger(obj.highlightsPerUrl) ? { highlightsPerUrl: parsePositiveInteger(obj.highlightsPerUrl) } : {}
		};
	};
	const parseSummary = (value) => {
		if (typeof value === "boolean") return value;
		if (!value || typeof value !== "object" || Array.isArray(value)) return invalidContentsPayload("contents.summary must be a boolean or an object.");
		const obj = value;
		for (const key of Object.keys(obj)) if (key !== "query") return invalidContentsPayload(`contents.summary has unknown field "${key}". Only "query" is allowed.`);
		if ("query" in obj && typeof obj.query !== "string") return invalidContentsPayload("contents.summary.query must be a string.");
		return typeof obj.query === "string" ? { query: obj.query } : {};
	};
	if ("text" in raw) {
		const parsedText = parseText(raw.text);
		if (isErrorPayload(parsedText)) return parsedText;
		parsed.text = parsedText;
	}
	if ("highlights" in raw) {
		const parsedHighlights = parseHighlights(raw.highlights);
		if (isErrorPayload(parsedHighlights)) return parsedHighlights;
		parsed.highlights = parsedHighlights;
	}
	if ("summary" in raw) {
		const parsedSummary = parseSummary(raw.summary);
		if (isErrorPayload(parsedSummary)) return parsedSummary;
		parsed.summary = parsedSummary;
	}
	return { value: parsed };
}
function normalizeExaResults(payload) {
	if (!payload || typeof payload !== "object") return [];
	const results = payload.results;
	if (!Array.isArray(results)) return [];
	return results.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
}
function resolveFreshnessStartDate(freshness) {
	const now = /* @__PURE__ */ new Date();
	if (freshness === "day") {
		now.setUTCDate(now.getUTCDate() - 1);
		return now.toISOString();
	}
	if (freshness === "week") {
		now.setUTCDate(now.getUTCDate() - 7);
		return now.toISOString();
	}
	if (freshness === "month") {
		const currentDay = now.getUTCDate();
		now.setUTCDate(1);
		now.setUTCMonth(now.getUTCMonth() - 1);
		const lastDayOfTargetMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
		now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
		return now.toISOString();
	}
	now.setUTCFullYear(now.getUTCFullYear() - 1);
	return now.toISOString();
}
async function runExaSearch(params) {
	const body = {
		query: params.query,
		numResults: params.count,
		type: params.type,
		contents: params.contents ?? { highlights: true }
	};
	if (params.dateAfter) body.startPublishedDate = params.dateAfter;
	else if (params.freshness) body.startPublishedDate = resolveFreshnessStartDate(params.freshness);
	if (params.dateBefore) body.endPublishedDate = params.dateBefore;
	return withTrustedWebSearchEndpoint({
		url: params.endpoint,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"x-api-key": params.apiKey,
				"x-exa-integration": "openclaw"
			},
			body: JSON.stringify(body)
		}
	}, async (res) => {
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`);
		}
		return readExaSearchResults(res);
	});
}
function missingExaKeyPayload() {
	return {
		error: "missing_exa_api_key",
		message: "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure tools.web.search.exa.apiKey.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
}
function buildExaCacheKey(params) {
	return buildSearchCacheKey([
		"exa",
		params.endpoint,
		params.type,
		params.query,
		params.count,
		params.freshness,
		params.dateAfter,
		params.dateBefore,
		params.contents?.highlights ? JSON.stringify(params.contents.highlights) : void 0,
		params.contents?.text ? JSON.stringify(params.contents.text) : void 0,
		params.contents?.summary ? JSON.stringify(params.contents.summary) : void 0
	]);
}
async function executeExaWebSearchProviderTool(ctx, args) {
	const searchConfig = mergeScopedSearchConfig(ctx.searchConfig, "exa", resolveProviderWebSearchPluginConfig(ctx.config, "exa"));
	const params = args;
	const exaConfig = resolveExaConfig(searchConfig);
	const apiKey = resolveExaApiKey(exaConfig);
	if (!apiKey) return missingExaKeyPayload();
	const endpointResult = resolveExaSearchEndpoint(exaConfig);
	if ("error" in endpointResult) return endpointResult;
	const endpoint = endpointResult.endpoint;
	const query = readStringParam(params, "query", { required: true });
	const rawType = readStringParam(params, "type");
	const type = EXA_SEARCH_TYPES.includes(rawType) ? rawType : "auto";
	const count = readNumberParam(params, "count", { integer: true }) ?? searchConfig?.maxResults ?? void 0;
	const rawFreshness = readStringParam(params, "freshness");
	const freshness = normalizeExaFreshness(rawFreshness);
	if (rawFreshness && !freshness) return {
		error: "invalid_freshness",
		message: "freshness must be one of \"day\", \"week\", \"month\", or \"year\".",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	const rawDateAfter = readStringParam(params, "date_after");
	const rawDateBefore = readStringParam(params, "date_before");
	if (freshness && (rawDateAfter || rawDateBefore)) return {
		error: "conflicting_time_filters",
		message: "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	const parsedDateRange = parseIsoDateRange({
		rawDateAfter,
		rawDateBefore,
		invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
		invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
		invalidDateRangeMessage: "date_after must be earlier than or equal to date_before."
	});
	if ("error" in parsedDateRange) return parsedDateRange;
	const { dateAfter, dateBefore } = parsedDateRange;
	const parsedContents = parseExaContents(params.contents);
	if (isErrorPayload(parsedContents)) return parsedContents;
	const contents = parsedContents.value && Object.keys(parsedContents.value).length > 0 ? parsedContents.value : void 0;
	const resolvedCount = resolveExaSearchCount(count, 5);
	const cacheKey = buildExaCacheKey({
		endpoint,
		type,
		query,
		count: resolvedCount,
		freshness,
		dateAfter,
		dateBefore,
		contents
	});
	const cached = readCachedSearchPayload(cacheKey);
	if (cached) return cached;
	const start = Date.now();
	const results = await runExaSearch({
		apiKey,
		endpoint,
		query,
		count: resolvedCount,
		freshness,
		dateAfter,
		dateBefore,
		type,
		contents,
		timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig)
	});
	const payload = {
		query,
		provider: "exa",
		count: results.length,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "exa",
			wrapped: true
		},
		results: results.map((entry) => {
			const title = typeof entry.title === "string" ? entry.title : "";
			const url = typeof entry.url === "string" ? entry.url : "";
			const description = resolveExaDescription(entry);
			const summary = normalizeOptionalString(entry.summary) ?? "";
			const highlightScores = Array.isArray(entry.highlightScores) ? entry.highlightScores.filter((score) => typeof score === "number" && Number.isFinite(score)) : [];
			const published = typeof entry.publishedDate === "string" && entry.publishedDate ? entry.publishedDate : void 0;
			return Object.assign({
				title: title ? wrapWebContent(title, `web_search`) : ``,
				url,
				description: description ? wrapWebContent(description, `web_search`) : ``,
				published,
				siteName: resolveSiteName(url) || void 0
			}, summary ? { summary: wrapWebContent(summary, `web_search`) } : {}, highlightScores.length > 0 ? { highlightScores } : {});
		})
	};
	writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
	return payload;
}
const testing = {
	normalizeExaResults,
	normalizeExaFreshness,
	parseExaContents,
	buildExaCacheKey,
	resolveExaApiKey,
	resolveExaConfig,
	resolveExaDescription,
	resolveExaSearchCount,
	resolveExaSearchEndpoint,
	resolveFreshnessStartDate,
	readExaSearchResults
};
//#endregion
export { testing as n, executeExaWebSearchProviderTool as t };
