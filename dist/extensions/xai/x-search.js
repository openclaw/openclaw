import { i as getRuntimeConfigSnapshot } from "../../runtime-snapshot-DgdkBEdP.js";
import { c as jsonResult, g as readStringParam, m as readStringArrayParam } from "../../common-E9YpX7pB.js";
import { i as readCache, l as writeCache, o as resolveCacheTtlMs, s as resolveTimeoutSeconds } from "../../web-shared-CYJpPo1M.js";
import "../../runtime-config-snapshot-BBsNBtE3.js";
import "../../provider-web-search-DNIStESL.js";
import { r as resolveXaiToolApiKeyWithAuth, t as isXaiToolEnabled } from "../../tool-auth-shared-1307P-Z2.js";
import { t as resolveEffectiveXSearchConfig } from "../../x-search-config-BhpqeUob.js";
import { n as createXSearchToolDefinition, t as buildMissingXSearchApiKeyPayload } from "../../x-search-tool-shared-CZWnGcJ7.js";
import { a as resolveXaiXSearchInlineCitations, i as resolveXaiXSearchEndpoint, n as buildXaiXSearchPayload, o as resolveXaiXSearchMaxTurns, r as requestXaiXSearch, s as resolveXaiXSearchModel } from "../../x-search-shared-DES161vI.js";
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
		sourceConfig: params.cfg,
		auth: params.auth
	});
}
async function resolveXSearchApiKey(params) {
	return await resolveXaiToolApiKeyWithAuth(params);
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
		runtimeConfig: runtimeConfig ?? void 0,
		auth: options?.auth
	})) return null;
	return createXSearchToolDefinition(async (_toolCallId, args) => {
		const apiKey = await resolveXSearchApiKey({
			sourceConfig: options?.config,
			runtimeConfig: runtimeConfig ?? void 0,
			auth: options?.auth
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
