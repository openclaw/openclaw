import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-BvxMxU5i.js";
import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-WCN93Is3.js";
import "./model-selection-DmMcdmk8.js";
//#region src/plugins/provider-auth-choice-helpers.ts
function resolveProviderMatch(providers, rawProvider) {
	const raw = normalizeOptionalString(rawProvider);
	if (!raw) return null;
	const normalized = normalizeProviderId(raw);
	return providers.find((provider) => normalizeProviderId(provider.id) === normalized) ?? providers.find((provider) => provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false) ?? null;
}
function pickAuthMethod(provider, rawMethod) {
	const raw = normalizeOptionalString(rawMethod);
	if (!raw) return null;
	const normalized = normalizeOptionalLowercaseString(raw);
	return provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.id) === normalized) ?? provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.label) === normalized) ?? null;
}
function isPlainRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
const BLOCKED_MERGE_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function sanitizeConfigPatchValue(value) {
	if (Array.isArray(value)) return value.map((entry) => sanitizeConfigPatchValue(entry));
	if (!isPlainRecord(value)) return value;
	const next = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (BLOCKED_MERGE_KEYS.has(key)) continue;
		next[key] = sanitizeConfigPatchValue(nestedValue);
	}
	return next;
}
function mergeConfigPatch(base, patch) {
	if (!isPlainRecord(base) || !isPlainRecord(patch)) return sanitizeConfigPatchValue(patch);
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (BLOCKED_MERGE_KEYS.has(key)) continue;
		const existing = next[key];
		if (isPlainRecord(existing) && isPlainRecord(value)) next[key] = mergeConfigPatch(existing, value);
		else next[key] = sanitizeConfigPatchValue(value);
	}
	return next;
}
function normalizeAgentModelConfigForWrite(value) {
	if (typeof value === "string") return normalizeAgentModelRefForConfig(value);
	if (!isPlainRecord(value)) return value;
	const next = { ...value };
	if (typeof next.primary === "string") next.primary = normalizeAgentModelRefForConfig(next.primary);
	if (Array.isArray(next.fallbacks)) next.fallbacks = next.fallbacks.map((fallback) => typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback);
	return next;
}
function normalizeAgentModelMapForWrite(value) {
	if (!isPlainRecord(value)) return value;
	return normalizeAgentModelMapForConfig(value);
}
function normalizeConfigModelRefsForWrite(cfg) {
	const defaults = cfg.agents?.defaults;
	if (!defaults) return cfg;
	const nextDefaults = { ...defaults };
	if (defaults.model !== void 0) nextDefaults.model = normalizeAgentModelConfigForWrite(defaults.model);
	if (defaults.models !== void 0) nextDefaults.models = normalizeAgentModelMapForWrite(defaults.models);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: nextDefaults
		}
	};
}
function applyProviderAuthConfigPatch(cfg, patch, options) {
	const merged = normalizeConfigModelRefsForWrite(mergeConfigPatch(cfg, patch));
	if (!options?.replaceDefaultModels || !isPlainRecord(patch)) return merged;
	const patchModels = patch.agents?.defaults?.models;
	if (!isPlainRecord(patchModels)) return merged;
	return normalizeConfigModelRefsForWrite({
		...merged,
		agents: {
			...merged.agents,
			defaults: {
				...merged.agents?.defaults,
				models: sanitizeConfigPatchValue(patchModels)
			}
		}
	});
}
function applyDefaultModel(cfg, model, opts) {
	const normalizedModel = normalizeAgentModelRefForConfig(model);
	const models = { ...normalizeAgentModelMapForConfig(cfg.agents?.defaults?.models ?? {}) };
	models[normalizedModel] = models[normalizedModel] ?? {};
	const existingModel = cfg.agents?.defaults?.model;
	const existingPrimary = typeof existingModel === "string" ? existingModel : existingModel && typeof existingModel === "object" ? existingModel.primary : void 0;
	const normalizedExistingPrimary = existingPrimary ? normalizeAgentModelRefForConfig(existingPrimary) : void 0;
	const existingFallbacks = existingModel && typeof existingModel === "object" && "fallbacks" in existingModel ? existingModel.fallbacks?.map((fallback) => normalizeAgentModelRefForConfig(fallback)) : void 0;
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models,
				model: {
					...existingFallbacks ? { fallbacks: existingFallbacks } : void 0,
					primary: opts?.preserveExistingPrimary === true ? normalizedExistingPrimary ?? normalizedModel : normalizedModel
				}
			}
		}
	};
}
//#endregion
export { resolveProviderMatch as i, applyProviderAuthConfigPatch as n, pickAuthMethod as r, applyDefaultModel as t };
