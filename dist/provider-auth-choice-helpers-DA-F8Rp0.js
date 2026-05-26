import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
import { R as normalizeProviderConfigForConfigDefaults } from "./io-DoswVvYe.js";
import { r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import "./model-selection-P-81eBKx.js";
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
function normalizeProviderCatalogModelIdForWrite(provider, modelId) {
	const trimmed = modelId.trim();
	if (!trimmed) return trimmed;
	return normalizeConfiguredProviderCatalogModelId(normalizeProviderId(provider), trimmed);
}
function normalizeProviderCatalogModelIdsForWrite(provider, providerConfig) {
	const models = providerConfig.models;
	if (!Array.isArray(models) || models.length === 0) return providerConfig;
	let mutated = false;
	const nextModels = models.map((model) => {
		const nextId = normalizeProviderCatalogModelIdForWrite(provider, model.id);
		if (nextId === model.id) return model;
		mutated = true;
		return Object.assign({}, model, { id: nextId });
	});
	return mutated ? {
		...providerConfig,
		models: nextModels
	} : providerConfig;
}
function normalizeModelProviderConfigsForWrite(cfg) {
	const providers = cfg.models?.providers;
	if (!providers) return cfg;
	let mutated = false;
	const nextProviders = { ...providers };
	for (const [provider, providerConfig] of Object.entries(providers)) {
		const normalizedProviderConfig = normalizeProviderCatalogModelIdsForWrite(provider, normalizeProviderConfigForConfigDefaults({
			provider,
			providerConfig
		}));
		if (normalizedProviderConfig === providerConfig) continue;
		nextProviders[provider] = normalizedProviderConfig;
		mutated = true;
	}
	if (!mutated) return cfg;
	return {
		...cfg,
		models: {
			...cfg.models,
			providers: nextProviders
		}
	};
}
function normalizeAgentListForWrite(value) {
	if (!Array.isArray(value)) return value;
	let mutated = false;
	const next = value.map((agent) => {
		if (!isPlainRecord(agent)) return agent;
		let nextAgent = agent;
		if (Object.prototype.hasOwnProperty.call(agent, "model")) {
			const normalizedModel = normalizeAgentModelConfigForWrite(agent.model);
			if (normalizedModel !== agent.model) {
				nextAgent = {
					...nextAgent,
					model: normalizedModel
				};
				mutated = true;
			}
		}
		if (Object.prototype.hasOwnProperty.call(agent, "models")) {
			const normalizedModels = normalizeAgentModelMapForWrite(agent.models);
			if (normalizedModels !== agent.models) {
				nextAgent = {
					...nextAgent,
					models: normalizedModels
				};
				mutated = true;
			}
		}
		return nextAgent;
	});
	return mutated ? next : value;
}
function normalizeConfigModelRefsForWrite(cfg) {
	const providerNormalized = normalizeModelProviderConfigsForWrite(cfg);
	const defaults = providerNormalized.agents?.defaults;
	const agentsList = providerNormalized.agents?.list;
	let nextDefaults = defaults;
	if (defaults) {
		nextDefaults = { ...defaults };
		if (defaults.model !== void 0) nextDefaults.model = normalizeAgentModelConfigForWrite(defaults.model);
		if (defaults.models !== void 0) nextDefaults.models = normalizeAgentModelMapForWrite(defaults.models);
	}
	const nextAgentsList = normalizeAgentListForWrite(agentsList);
	if (nextDefaults === defaults && nextAgentsList === agentsList) return providerNormalized;
	return {
		...providerNormalized,
		agents: {
			...providerNormalized.agents,
			...nextDefaults ? { defaults: nextDefaults } : {},
			...nextAgentsList !== void 0 ? { list: nextAgentsList } : {}
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
/**
* Restore `agents.defaults.model` after a provider auth config merge when the user did not pass
* `--set-default`, so `applyConfig` patches cannot replace the primary without an explicit opt-in.
*/
function restorePriorAgentsDefaultsModelUnlessOptIn(params) {
	if (params.setDefault || params.priorAgentsDefaultsModel === void 0) return params.cfg;
	return {
		...params.cfg,
		agents: {
			...params.cfg.agents,
			defaults: {
				...params.cfg.agents?.defaults,
				model: params.priorAgentsDefaultsModel
			}
		}
	};
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
export { restorePriorAgentsDefaultsModelUnlessOptIn as a, resolveProviderMatch as i, applyProviderAuthConfigPatch as n, pickAuthMethod as r, applyDefaultModel as t };
