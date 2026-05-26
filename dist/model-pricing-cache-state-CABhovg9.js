import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
//#region src/gateway/model-pricing-cache-state.ts
let cachedPricing = /* @__PURE__ */ new Map();
let cachedAt = 0;
const sourceFailures = /* @__PURE__ */ new Map();
function modelPricingCacheKey(provider, model) {
	const providerId = normalizeProviderId(provider);
	const modelId = model.trim();
	if (!providerId || !modelId) return "";
	return normalizeLowercaseStringOrEmpty(modelId).startsWith(`${normalizeLowercaseStringOrEmpty(providerId)}/`) ? modelId : `${providerId}/${modelId}`;
}
function replaceGatewayModelPricingCache(nextPricing, nextCachedAt = Date.now()) {
	cachedPricing = nextPricing;
	cachedAt = nextCachedAt;
}
function recordGatewayModelPricingSourceFailure(source, detail, failedAt = Date.now()) {
	sourceFailures.set(source, {
		lastFailureAt: failedAt,
		detail
	});
}
function clearGatewayModelPricingSourceFailure(source) {
	sourceFailures.delete(source);
}
function clearGatewayModelPricingFailures() {
	sourceFailures.clear();
}
function getGatewayModelPricingHealth(params) {
	if (params?.enabled === false) return {
		state: "disabled",
		sources: []
	};
	const sources = Array.from(sourceFailures.entries()).map(([source, failure]) => ({
		source,
		state: "degraded",
		lastFailureAt: failure.lastFailureAt,
		detail: failure.detail
	})).toSorted((left, right) => left.source.localeCompare(right.source));
	const latest = sources.reduce((current, source) => {
		if (!current || (source.lastFailureAt ?? 0) > (current.lastFailureAt ?? 0)) return source;
		return current;
	}, void 0);
	return {
		state: sources.length > 0 ? "degraded" : "ok",
		sources,
		...latest?.lastFailureAt ? { lastFailureAt: latest.lastFailureAt } : {},
		...latest?.detail ? { detail: latest.detail } : {}
	};
}
function getCachedGatewayModelPricing(params) {
	const provider = params.provider?.trim();
	const model = params.model?.trim();
	if (!provider || !model) return;
	const key = modelPricingCacheKey(provider, model);
	const direct = key ? cachedPricing.get(key) : void 0;
	if (direct) return direct;
	const normalized = normalizeModelRef(provider, model);
	const normalizedKey = modelPricingCacheKey(normalized.provider, normalized.model);
	if (normalizedKey === key) return;
	return normalizedKey ? cachedPricing.get(normalizedKey) : void 0;
}
function getGatewayModelPricingCacheMeta() {
	return {
		cachedAt,
		ttlMs: 0,
		size: cachedPricing.size
	};
}
function stablePricingValue(value) {
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => stablePricingValue(entry)).join(",")}]`;
	const record = value;
	return `{${Object.keys(record).filter((key) => record[key] !== void 0).toSorted().map((key) => `${JSON.stringify(key)}:${stablePricingValue(record[key])}`).join(",")}}`;
}
function getGatewayModelPricingCacheFingerprint() {
	return stablePricingValue(Array.from(cachedPricing.entries()).toSorted(([a], [b]) => a.localeCompare(b)));
}
//#endregion
export { getGatewayModelPricingCacheMeta as a, replaceGatewayModelPricingCache as c, getGatewayModelPricingCacheFingerprint as i, clearGatewayModelPricingSourceFailure as n, getGatewayModelPricingHealth as o, getCachedGatewayModelPricing as r, recordGatewayModelPricingSourceFailure as s, clearGatewayModelPricingFailures as t };
