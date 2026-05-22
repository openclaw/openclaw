import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, p as resolvePrimaryStringValue } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as normalizeGooglePreviewModelId } from "./provider-model-id-normalize-BPUSCSQX.js";
//#region src/config/model-input.ts
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function modelKeyForConfig(provider, model) {
	const providerId = provider.trim();
	const modelId = model.trim();
	if (!providerId) return modelId;
	if (!modelId) return providerId;
	return normalizeLowercaseStringOrEmpty(modelId).startsWith(`${normalizeLowercaseStringOrEmpty(providerId)}/`) ? modelId : `${providerId}/${modelId}`;
}
function resolveAgentModelPrimaryValue(model) {
	return resolvePrimaryStringValue(model);
}
function resolveAgentModelFallbackValues(model) {
	if (!model || typeof model !== "object") return [];
	return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
function resolveAgentModelTimeoutMsValue(model) {
	if (!model || typeof model !== "object") return;
	return typeof model.timeoutMs === "number" && Number.isFinite(model.timeoutMs) && model.timeoutMs > 0 ? Math.floor(model.timeoutMs) : void 0;
}
function toAgentModelListLike(model) {
	if (typeof model === "string") {
		const primary = normalizeOptionalString(model);
		return primary ? { primary } : void 0;
	}
	if (!model || typeof model !== "object") return;
	return model;
}
const GOOGLE_PROVIDER_IDS = new Set([
	"google",
	"google-gemini-cli",
	"google-vertex"
]);
function normalizeAgentModelRefForConfig(model) {
	const trimmed = model.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return trimmed;
	const provider = normalizeProviderId(trimmed.slice(0, slash));
	const modelSuffix = trimmed.slice(slash + 1);
	return modelKeyForConfig(provider, GOOGLE_PROVIDER_IDS.has(provider) || modelSuffix.startsWith("google/") ? normalizeGooglePreviewModelId(modelSuffix) : modelSuffix);
}
function mergeAgentModelEntryForConfig(existing, incoming) {
	if (!isPlainRecord(existing) || !isPlainRecord(incoming)) return incoming;
	const existingParams = isPlainRecord(existing.params) ? existing.params : void 0;
	const incomingParams = isPlainRecord(incoming.params) ? incoming.params : void 0;
	return {
		...existing,
		...incoming,
		...existingParams || incomingParams ? { params: {
			...existingParams,
			...incomingParams
		} } : void 0
	};
}
function normalizeAgentModelMapForConfig(models) {
	let mutated = false;
	const next = {};
	for (const [key, entry] of Object.entries(models)) {
		const normalizedKey = normalizeAgentModelRefForConfig(key);
		if (normalizedKey !== key || Object.prototype.hasOwnProperty.call(next, normalizedKey)) mutated = true;
		next[normalizedKey] = mergeAgentModelEntryForConfig(next[normalizedKey], entry);
	}
	return mutated ? next : models;
}
//#endregion
export { resolveAgentModelTimeoutMsValue as a, resolveAgentModelPrimaryValue as i, normalizeAgentModelRefForConfig as n, toAgentModelListLike as o, resolveAgentModelFallbackValues as r, normalizeAgentModelMapForConfig as t };
