import { p as resolvePrimaryStringValue } from "./string-coerce-DyL154ka.js";
import { t as findNormalizedProviderKey } from "./provider-id-zTW9Rdln.js";
import { n as normalizeAgentModelRefForConfig, t as normalizeAgentModelMapForConfig } from "./model-input-ChW9XXsQ.js";
import { a as resolveStaticAllowlistModelKey, r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import "./defaults-mDjiWzE5.js";
//#region src/agents/model-allowlist-entry.ts
function ensureStaticModelAllowlistEntry(params) {
	const rawModelRef = params.modelRef.trim();
	if (!rawModelRef) return params.cfg;
	const models = { ...params.cfg.agents?.defaults?.models };
	const keySet = new Set([rawModelRef]);
	const canonicalKey = resolveStaticAllowlistModelKey(rawModelRef, params.defaultProvider ?? "openai");
	if (canonicalKey) keySet.add(canonicalKey);
	for (const key of keySet) models[key] = { ...models[key] };
	return {
		...params.cfg,
		agents: {
			...params.cfg.agents,
			defaults: {
				...params.cfg.agents?.defaults,
				models
			}
		}
	};
}
//#endregion
//#region src/plugin-sdk/provider-onboard.ts
const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set(["opencode/claude-opus-4-5", "opencode-zen/claude-opus-4-5"]);
const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
function extractAgentDefaultModelFallbacks(model) {
	if (!model || typeof model !== "object") return;
	if (!("fallbacks" in model)) return;
	const fallbacks = model.fallbacks;
	return Array.isArray(fallbacks) ? fallbacks.map((value) => String(value)) : void 0;
}
function normalizeAgentModelAliasEntry(entry) {
	if (typeof entry === "string") return { modelRef: entry };
	return entry;
}
function normalizeProviderModelForConfig(providerId, model) {
	const id = normalizeConfiguredProviderCatalogModelId(providerId, model.id);
	return id === model.id ? model : {
		...model,
		id
	};
}
function normalizeProviderModelsForConfig(providerId, models) {
	let mutated = false;
	const next = [];
	const seenById = /* @__PURE__ */ new Map();
	for (const model of models) {
		const normalized = normalizeProviderModelForConfig(providerId, model);
		if (normalized !== model) mutated = true;
		const existingIndex = seenById.get(normalized.id);
		if (existingIndex !== void 0) {
			mutated = true;
			next[existingIndex] = {
				...normalized,
				...next[existingIndex]
			};
			continue;
		}
		seenById.set(normalized.id, next.length);
		next.push(normalized);
	}
	return mutated ? next : models;
}
function normalizeModelProvidersForConfig(providers) {
	if (!providers) return providers;
	let mutated = false;
	const nextProviders = {};
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		const models = Array.isArray(providerConfig.models) ? normalizeProviderModelsForConfig(providerId, providerConfig.models) : providerConfig.models;
		if (models !== providerConfig.models) {
			mutated = true;
			nextProviders[providerId] = {
				...providerConfig,
				models
			};
			continue;
		}
		nextProviders[providerId] = providerConfig;
	}
	return mutated ? nextProviders : providers;
}
function resolveProviderModelMergeState(cfg, providerId) {
	const providers = { ...cfg.models?.providers };
	const existingProviderKey = findNormalizedProviderKey(providers, providerId);
	const existingProvider = existingProviderKey !== void 0 ? providers[existingProviderKey] : void 0;
	const existingModels = Array.isArray(existingProvider?.models) ? normalizeProviderModelsForConfig(providerId, existingProvider.models) : [];
	if (existingProviderKey && existingProviderKey !== providerId) delete providers[existingProviderKey];
	return {
		providers,
		existingProvider: existingProvider ? {
			...existingProvider,
			models: existingModels
		} : existingProvider,
		existingModels
	};
}
function buildProviderConfig(params) {
	const { apiKey: existingApiKey, ...existingProviderRest } = params.existingProvider ?? {};
	const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : void 0;
	return {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: params.api,
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: params.mergedModels.length > 0 ? params.mergedModels : params.fallbackModels
	};
}
function applyProviderConfigWithMergedModels(cfg, params) {
	const mergedModels = normalizeProviderModelsForConfig(params.providerId, params.mergedModels);
	const fallbackModels = normalizeProviderModelsForConfig(params.providerId, params.fallbackModels);
	params.providerState.providers[params.providerId] = buildProviderConfig({
		existingProvider: params.providerState.existingProvider,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels
	});
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: params.agentModels,
		providers: params.providerState.providers
	});
}
function createProviderPresetAppliers(params) {
	return {
		applyProviderConfig(cfg, ...args) {
			const resolved = params.resolveParams(cfg, ...args);
			return resolved ? params.applyPreset(cfg, resolved) : cfg;
		},
		applyConfig(cfg, ...args) {
			const resolved = params.resolveParams(cfg, ...args);
			if (!resolved) return cfg;
			return params.applyPreset(cfg, {
				...resolved,
				primaryModelRef: params.primaryModelRef
			});
		}
	};
}
function withAgentModelAliases(existing, aliases) {
	const next = normalizeAgentModelMapForConfig({ ...existing });
	for (const entry of aliases) {
		const normalized = normalizeAgentModelAliasEntry(entry);
		const modelRef = normalizeAgentModelRefForConfig(normalized.modelRef);
		next[modelRef] = {
			...next[modelRef],
			...normalized.alias ? { alias: next[modelRef]?.alias ?? normalized.alias } : {}
		};
	}
	return next;
}
function applyOnboardAuthAgentModelsAndProviders(cfg, params) {
	const mergedAgentModels = normalizeAgentModelMapForConfig({
		...cfg.agents?.defaults?.models,
		...params.agentModels
	});
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models: mergedAgentModels
			}
		},
		models: {
			mode: cfg.models?.mode ?? "merge",
			providers: params.providers
		}
	};
}
function applyAgentDefaultModelPrimary(cfg, primary) {
	const defaults = cfg.agents?.defaults;
	const normalizedFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model)?.map((fallback) => normalizeAgentModelRefForConfig(fallback));
	const normalizedModels = defaults?.models === void 0 ? void 0 : normalizeAgentModelMapForConfig(defaults.models);
	const normalizedProviders = normalizeModelProvidersForConfig(cfg.models?.providers);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...defaults,
				model: {
					...normalizedFallbacks ? { fallbacks: normalizedFallbacks } : void 0,
					primary: normalizeAgentModelRefForConfig(primary)
				},
				...normalizedModels !== void 0 ? { models: normalizedModels } : void 0
			}
		},
		...normalizedProviders !== void 0 ? { models: {
			...cfg.models,
			providers: normalizedProviders
		} } : void 0
	};
}
function applyOpencodeZenModelDefault(cfg) {
	const current = resolvePrimaryStringValue(cfg.agents?.defaults?.model);
	if ((current && LEGACY_OPENCODE_ZEN_DEFAULT_MODELS.has(current) ? "opencode/claude-opus-4-6" : current) === "opencode/claude-opus-4-6") return {
		next: cfg,
		changed: false
	};
	return {
		next: applyAgentDefaultModelPrimary(cfg, OPENCODE_ZEN_DEFAULT_MODEL),
		changed: true
	};
}
function applyProviderConfigWithDefaultModels(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const defaultModels = params.defaultModels;
	const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
	const hasDefaultModel = defaultModelId ? providerState.existingModels.some((model) => model.id === defaultModelId) : true;
	const mergedModels = providerState.existingModels.length > 0 ? hasDefaultModel || defaultModels.length === 0 ? providerState.existingModels : [...providerState.existingModels, ...defaultModels] : defaultModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: defaultModels
	});
}
function applyProviderConfigWithDefaultModel(cfg, params) {
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		defaultModels: [params.defaultModel],
		defaultModelId: params.defaultModelId ?? params.defaultModel.id
	});
}
function applyProviderConfigWithDefaultModelPreset(cfg, params) {
	const next = applyProviderConfigWithDefaultModel(cfg, {
		agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		defaultModel: params.defaultModel,
		defaultModelId: params.defaultModelId
	});
	return params.primaryModelRef ? applyAgentDefaultModelPrimary(next, params.primaryModelRef) : next;
}
function createDefaultModelPresetAppliers(params) {
	return createProviderPresetAppliers({
		resolveParams: params.resolveParams,
		applyPreset: applyProviderConfigWithDefaultModelPreset,
		primaryModelRef: params.primaryModelRef
	});
}
function applyProviderConfigWithDefaultModelsPreset(cfg, params) {
	const next = applyProviderConfigWithDefaultModels(cfg, {
		agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		defaultModels: params.defaultModels,
		defaultModelId: params.defaultModelId
	});
	return params.primaryModelRef ? applyAgentDefaultModelPrimary(next, params.primaryModelRef) : next;
}
function createDefaultModelsPresetAppliers(params) {
	return createProviderPresetAppliers({
		resolveParams: params.resolveParams,
		applyPreset: applyProviderConfigWithDefaultModelsPreset,
		primaryModelRef: params.primaryModelRef
	});
}
function applyProviderConfigWithModelCatalog(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const catalogModels = params.catalogModels;
	const mergedModels = providerState.existingModels.length > 0 ? [...providerState.existingModels, ...catalogModels.filter((model) => !providerState.existingModels.some((existing) => existing.id === model.id))] : catalogModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: catalogModels
	});
}
function applyProviderConfigWithModelCatalogPreset(cfg, params) {
	const next = applyProviderConfigWithModelCatalog(cfg, {
		agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		catalogModels: params.catalogModels
	});
	return params.primaryModelRef ? applyAgentDefaultModelPrimary(next, params.primaryModelRef) : next;
}
function createModelCatalogPresetAppliers(params) {
	return createProviderPresetAppliers({
		resolveParams: params.resolveParams,
		applyPreset: applyProviderConfigWithModelCatalogPreset,
		primaryModelRef: params.primaryModelRef
	});
}
function ensureModelAllowlistEntry(params) {
	return ensureStaticModelAllowlistEntry(params);
}
//#endregion
export { applyProviderConfigWithDefaultModel as a, applyProviderConfigWithDefaultModelsPreset as c, createDefaultModelPresetAppliers as d, createDefaultModelsPresetAppliers as f, withAgentModelAliases as h, applyOpencodeZenModelDefault as i, applyProviderConfigWithModelCatalog as l, ensureModelAllowlistEntry as m, applyAgentDefaultModelPrimary as n, applyProviderConfigWithDefaultModelPreset as o, createModelCatalogPresetAppliers as p, applyOnboardAuthAgentModelsAndProviders as r, applyProviderConfigWithDefaultModels as s, OPENCODE_ZEN_DEFAULT_MODEL as t, applyProviderConfigWithModelCatalogPreset as u };
