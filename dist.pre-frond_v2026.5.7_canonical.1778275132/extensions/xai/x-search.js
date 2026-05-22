import { i as getRuntimeConfigSnapshot } from "../../runtime-snapshot-Dmp4nHnj.js";
import { g as readStringParam, l as jsonResult, m as readStringArrayParam } from "../../common-Cf8ajZVR.js";
import { i as readCache, l as writeCache, o as resolveCacheTtlMs, s as resolveTimeoutSeconds } from "../../web-shared-cXpllDuo.js";
import "../../runtime-config-snapshot-v7W2zNnN.js";
import "../../provider-web-search-CXTgakJh.js";
import { r as resolveXaiToolApiKey, t as isXaiToolEnabled } from "../../tool-auth-shared-Cd2lLnLq.js";
import { t as resolveEffectiveXSearchConfig } from "../../x-search-config-DAWe0i_C.js";
import { n as createXSearchToolDefinition, t as buildMissingXSearchApiKeyPayload } from "../../x-search-tool-shared-BklkkJF3.js";
import { a as resolveXaiXSearchInlineCitations, i as resolveXaiXSearchEndpoint, n as buildXaiXSearchPayload, o as resolveXaiXSearchMaxTurns, r as requestXaiXSearch, s as resolveXaiXSearchModel } from "../../x-search-shared-CP9NHj_o.js";
//#region extensions/xai/x-search.ts
var PluginToolInputError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ToolInputError";
	}
};
const X_SEARCH_CACHE_KEY = Symbol.for("openclaw.xai.x-search.cache");
function getSharedXSearchCache() {
	const root = globalThis;
	const existing = root[X_SEARCH_CACHE_KEY];
	if (existing instanceof Map) return existing;
	const next = /* @__PURE__ */ new Map();
	root[X_SEARCH_CACHE_KEY] = next;
	return next;
}
const X_SEARCH_CACHE = getSharedXSearchCache();
function resolveXSearchConfig(cfg) {
	return resolveEffectiveXSearchConfig(cfg);
}
function resolveXSearchEnabled(params) {
	return isXaiToolEnabled({
		enabled: params.config?.enabled,
		runtimeConfig: params.runtimeConfig,
		sourceConfig: params.cfg
	});
}
function resolveXSearchApiKey(params) {
	return resolveXaiToolApiKey(params);
}
function normalizeOptionalIsoDate(value, label) {
	if (!value) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new PluginToolInputError(`${label} must use YYYY-MM-DD`);
	const [year, month, day] = trimmed.split("-").map((entry) => Number.parseInt(entry, 10));
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new PluginToolInputError(`${label} must be a valid calendar date`);
	return trimmed;
}
function buildXSearchCacheKey(params) {
	return JSON.stringify([
		"x_search",
		params.model,
		params.endpoint,
		params.query,
		params.inlineCitations,
		params.maxTurns ?? null,
		params.options.allowedXHandles ?? null,
		params.options.excludedXHandles ?? null,
		params.options.fromDate ?? null,
		params.options.toDate ?? null,
		params.options.enableImageUnderstanding ?? false,
		params.options.enableVideoUnderstanding ?? false
	]);
}
function createXSearchTool(options) {
	const xSearchConfig = resolveXSearchConfig(options?.config);
	const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
	if (!resolveXSearchEnabled({
		cfg: options?.config,
		config: xSearchConfig,
		runtimeConfig: runtimeConfig ?? void 0
	})) return null;
	return createXSearchToolDefinition(async (_toolCallId, args) => {
		const apiKey = resolveXSearchApiKey({
			sourceConfig: options?.config,
			runtimeConfig: runtimeConfig ?? void 0
		});
		if (!apiKey) return jsonResult(buildMissingXSearchApiKeyPayload());
		const query = readStringParam(args, "query", { required: true });
		const allowedXHandles = readStringArrayParam(args, "allowed_x_handles");
		const excludedXHandles = readStringArrayParam(args, "excluded_x_handles");
		const fromDate = normalizeOptionalIsoDate(readStringParam(args, "from_date"), "from_date");
		const toDate = normalizeOptionalIsoDate(readStringParam(args, "to_date"), "to_date");
		if (fromDate && toDate && fromDate > toDate) throw new PluginToolInputError("from_date must be on or before to_date");
		const xSearchOptions = {
			query,
			allowedXHandles,
			excludedXHandles,
			fromDate,
			toDate,
			enableImageUnderstanding: args.enable_image_understanding === true,
			enableVideoUnderstanding: args.enable_video_understanding === true
		};
		const xSearchConfigRecord = xSearchConfig;
		const model = resolveXaiXSearchModel(xSearchConfigRecord);
		const endpoint = resolveXaiXSearchEndpoint(xSearchConfigRecord);
		const inlineCitations = resolveXaiXSearchInlineCitations(xSearchConfigRecord);
		const maxTurns = resolveXaiXSearchMaxTurns(xSearchConfigRecord);
		const cacheKey = buildXSearchCacheKey({
			query,
			model,
			endpoint,
			inlineCitations,
			maxTurns,
			options: {
				allowedXHandles,
				excludedXHandles,
				fromDate,
				toDate,
				enableImageUnderstanding: xSearchOptions.enableImageUnderstanding,
				enableVideoUnderstanding: xSearchOptions.enableVideoUnderstanding
			}
		});
		const cached = readCache(X_SEARCH_CACHE, cacheKey);
		if (cached) return jsonResult({
			...cached.value,
			cached: true
		});
		const startedAt = Date.now();
		const result = await requestXaiXSearch({
			apiKey,
			endpoint,
			model,
			timeoutSeconds: resolveTimeoutSeconds(xSearchConfig?.timeoutSeconds, 30),
			inlineCitations,
			maxTurns,
			options: xSearchOptions
		});
		const payload = buildXaiXSearchPayload({
			query,
			model,
			tookMs: Date.now() - startedAt,
			content: result.content,
			citations: result.citations,
			inlineCitations: result.inlineCitations,
			options: xSearchOptions
		});
		writeCache(X_SEARCH_CACHE, cacheKey, payload, resolveCacheTtlMs(xSearchConfig?.cacheTtlMinutes, 15));
		return jsonResult(payload);
	});
}
//#endregion
export { createXSearchTool };
