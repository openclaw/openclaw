import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { i as resolveAgentModelPrimaryValue, o as toAgentModelListLike, r as resolveAgentModelFallbackValues } from "./model-input-B9p-bobB.js";
import { r as resolveAgentConfig } from "./agent-scope-config-26EcJVc0.js";
import { n as resolveAgentEffectiveModelPrimary, s as resolveAgentModelFallbacksOverride } from "./agent-scope-C1Fl7gAf.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import { s as resolveThinkingDefaultForModel } from "./thinking-ix_990qw.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-BAEY2i_C.js";
import { C as findModelInCatalog, _ as resolveConfiguredModelRef, b as resolveModelRefFromString, h as resolveAllowlistModelKey$1, i as buildModelAliasIndex, o as getModelRefStatusWithFallbackModels, p as resolveAllowedModelRefFromAliasIndex, r as buildConfiguredModelCatalog, t as buildAllowedModelSetWithFallbacks, u as normalizeModelSelection, v as resolveConfiguredOpenRouterCompatAlias } from "./model-selection-shared-Dh1KrVmr.js";
import { i as parseModelRef, n as modelKey, t as legacyModelKey } from "./model-selection-normalize-B4tdZ1L4.js";
import "./model-selection-cli-CT4Mltpu.js";
//#region src/agents/model-thinking-default.ts
function resolveThinkingDefault(params) {
	const normalizedProvider = normalizeProviderId(params.provider);
	const normalizedModel = normalizeLowercaseStringOrEmpty(params.model).replace(/\./g, "-");
	const catalogCandidate = Array.isArray(params.catalog) ? params.catalog.find((entry) => entry.provider === params.provider && entry.id === params.model) : void 0;
	const configuredModels = params.cfg.agents?.defaults?.models;
	const canonicalKey = modelKey(params.provider, params.model);
	const legacyKey = legacyModelKey(params.provider, params.model);
	const normalizedCanonicalKey = normalizeLowercaseStringOrEmpty(canonicalKey);
	const normalizedLegacyKey = normalizeOptionalLowercaseString(legacyKey);
	const normalizedPrimarySelection = normalizeOptionalLowercaseString(normalizeModelSelection(params.cfg.agents?.defaults?.model));
	const explicitModelConfigured = (configuredModels ? canonicalKey in configuredModels : false) || Boolean(legacyKey && configuredModels && legacyKey in configuredModels) || normalizedPrimarySelection === normalizedCanonicalKey || Boolean(normalizedLegacyKey && normalizedPrimarySelection === normalizedLegacyKey) || normalizedPrimarySelection === normalizeLowercaseStringOrEmpty(params.model);
	const perModelThinking = configuredModels?.[canonicalKey]?.params?.thinking ?? (legacyKey ? configuredModels?.[legacyKey]?.params?.thinking : void 0);
	if (perModelThinking === "off" || perModelThinking === "minimal" || perModelThinking === "low" || perModelThinking === "medium" || perModelThinking === "high" || perModelThinking === "xhigh" || perModelThinking === "adaptive" || perModelThinking === "max") return perModelThinking;
	const configured = params.cfg.agents?.defaults?.thinkingDefault;
	if (configured) return configured;
	if (normalizedProvider === "anthropic" && (normalizedModel.startsWith("claude-opus-4-7") || normalizedModel.startsWith("claude-opus-4.7"))) return "off";
	if (normalizedProvider === "anthropic" && explicitModelConfigured && typeof catalogCandidate?.name === "string" && /4\.6\b/.test(catalogCandidate.name) && (normalizedModel.startsWith("claude-opus-4-6") || normalizedModel.startsWith("claude-sonnet-4-6"))) return "adaptive";
	return resolveThinkingDefaultForModel({
		provider: params.provider,
		model: params.model,
		catalog: params.catalog
	});
}
async function resolveThinkingDefaultWithRuntimeCatalog(params) {
	const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
	const configuredSelectedEntry = configuredCatalog.find((entry) => entry.provider === params.provider && entry.id === params.model);
	const runtimeCatalog = configuredCatalog.length === 0 || !configuredSelectedEntry || configuredSelectedEntry.reasoning === void 0 ? await params.loadModelCatalog() : void 0;
	const catalog = runtimeCatalog?.find((entry) => entry.provider === params.provider && entry.id === params.model) || configuredCatalog.length === 0 ? runtimeCatalog ?? configuredCatalog : configuredCatalog;
	return resolveThinkingDefault({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		catalog
	});
}
//#endregion
//#region src/agents/model-selection.ts
function normalizePersistedDefaultProvider(value) {
	return normalizeOptionalString(value) ?? "openai";
}
function resolvePersistedOverrideModelRef(params) {
	const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
	const overrideProvider = normalizeOptionalString(params.overrideProvider);
	const overrideModel = normalizeOptionalString(params.overrideModel);
	if (!overrideModel) return null;
	return parseModelRef(overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel, defaultProvider, { allowPluginNormalization: params.allowPluginNormalization }) ?? {
		provider: overrideProvider || defaultProvider,
		model: overrideModel
	};
}
/**
* Runtime-first resolver for persisted model metadata.
* Use this when callers intentionally want the last executed model identity.
*/
function resolvePersistedModelRef(params) {
	const defaultProvider = normalizePersistedDefaultProvider(params.defaultProvider);
	const runtimeProvider = normalizeOptionalString(params.runtimeProvider);
	const runtimeModel = normalizeOptionalString(params.runtimeModel);
	if (runtimeModel) {
		if (runtimeProvider) return {
			provider: runtimeProvider,
			model: runtimeModel
		};
		return parseModelRef(runtimeModel, defaultProvider, { allowPluginNormalization: params.allowPluginNormalization }) ?? {
			provider: defaultProvider,
			model: runtimeModel
		};
	}
	return resolvePersistedOverrideModelRef({
		defaultProvider,
		overrideProvider: params.overrideProvider,
		overrideModel: params.overrideModel,
		allowPluginNormalization: params.allowPluginNormalization
	});
}
/**
* Selected-model resolver for persisted model metadata.
* Use this for control/status/UI surfaces that should honor explicit session
* overrides before falling back to runtime identity.
*/
function resolvePersistedSelectedModelRef(params) {
	const override = resolvePersistedOverrideModelRef({
		defaultProvider: params.defaultProvider,
		overrideProvider: params.overrideProvider,
		overrideModel: params.overrideModel,
		allowPluginNormalization: params.allowPluginNormalization
	});
	if (override) return override;
	return resolvePersistedModelRef({
		defaultProvider: params.defaultProvider,
		runtimeProvider: params.runtimeProvider,
		runtimeModel: params.runtimeModel,
		allowPluginNormalization: params.allowPluginNormalization
	});
}
function normalizeStoredOverrideModel(params) {
	const providerOverride = normalizeOptionalString(params.providerOverride);
	const modelOverride = normalizeOptionalString(params.modelOverride);
	if (!providerOverride || !modelOverride) return {
		providerOverride,
		modelOverride
	};
	const providerPrefix = `${providerOverride.toLowerCase()}/`;
	return {
		providerOverride,
		modelOverride: modelOverride.toLowerCase().startsWith(providerPrefix) ? modelOverride.slice(providerOverride.length + 1).trim() || modelOverride : modelOverride
	};
}
function resolveAllowlistModelKey(raw, defaultProvider, cfg) {
	return resolveAllowlistModelKey$1({
		cfg,
		raw,
		defaultProvider
	});
}
function resolveDefaultModelForAgent(params) {
	const agentModelOverride = params.agentId ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId) : void 0;
	return resolveConfiguredModelRef({
		cfg: agentModelOverride && agentModelOverride.length > 0 ? {
			...params.cfg,
			agents: {
				...params.cfg.agents,
				defaults: {
					...params.cfg.agents?.defaults,
					model: {
						...toAgentModelListLike(params.cfg.agents?.defaults?.model),
						primary: agentModelOverride
					}
				}
			}
		} : params.cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		allowPluginNormalization: params.allowPluginNormalization
	});
}
async function canonicalizeCaseOnlyCatalogModelRef(params) {
	const rawModel = normalizeOptionalString(params.raw);
	if (!rawModel) return;
	const split = splitTrailingAuthProfile(rawModel);
	if (shouldKeepProfileQualifiedModelRefRaw(split.profile, params.preserveAuthProfile)) return rawModel;
	if (!isCaseOnlyProviderModelRef(split.model)) return rawModel;
	const resolved = resolveModelRefFromString({
		cfg: params.cfg,
		raw: split.model,
		defaultProvider: params.defaultProvider,
		aliasIndex: params.aliasIndex,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization
	});
	if (!resolved) return rawModel;
	const entry = findModelInCatalog(await params.loadCatalog(), resolved.ref.provider, resolved.ref.model);
	return entry ? formatCatalogModelRef(entry, split.profile) : rawModel;
}
function hasExplicitProviderModelRef(raw) {
	const slash = raw.indexOf("/");
	return slash > 0 && slash < raw.length - 1;
}
function isCaseOnlyProviderModelRef(raw) {
	return hasExplicitProviderModelRef(raw) && raw !== raw.toLowerCase();
}
function shouldKeepProfileQualifiedModelRefRaw(profile, preserveAuthProfile) {
	return Boolean(profile && preserveAuthProfile === false);
}
function formatCatalogModelRef(entry, profile) {
	return appendAuthProfileSuffix(`${entry.provider}/${entry.id}`, profile);
}
function appendAuthProfileSuffix(modelRef, profile) {
	return profile ? `${modelRef}@${profile}` : modelRef;
}
function resolveAllowedFallbacks(params) {
	if (params.agentId) {
		const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
		if (override !== void 0) return override;
	}
	return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}
function resolveSubagentConfiguredModelSelection(params) {
	const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
	return normalizeModelSelection(agentConfig?.subagents?.model) ?? normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ?? normalizeModelSelection(agentConfig?.model);
}
/**
* Resolve a normalized model string through a pre-built alias index, returning
* a fully qualified `provider/model` string.  If the value is already qualified
* or not a known alias, returns it unchanged.
*/
function resolveModelThroughAliases(value, aliasIndex) {
	if (value.includes("/")) return value;
	const aliasKey = normalizeLowercaseStringOrEmpty(value);
	const aliasMatch = aliasIndex.byAlias.get(aliasKey);
	if (aliasMatch) return `${aliasMatch.ref.provider}/${aliasMatch.ref.model}`;
	return value;
}
function resolveSubagentSpawnModelSelection(params) {
	const runtimeDefault = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	return resolveModelThroughAliases(normalizeModelSelection(params.modelOverride) ?? resolveSubagentConfiguredModelSelection({
		cfg: params.cfg,
		agentId: params.agentId
	}) ?? normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ?? `${runtimeDefault.provider}/${runtimeDefault.model}`, buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: runtimeDefault.provider
	}));
}
function buildAllowedModelSet(params) {
	return buildAllowedModelSetWithFallbacks({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		fallbackModels: resolveAllowedFallbacks({
			cfg: params.cfg,
			agentId: params.agentId
		})
	});
}
function getModelRefStatus(params) {
	return getModelRefStatusWithFallbackModels({
		cfg: params.cfg,
		catalog: params.catalog,
		ref: params.ref,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		fallbackModels: resolveAllowedFallbacks({ cfg: params.cfg })
	});
}
function getModelRefStatusForResolve(params, ref) {
	return getModelRefStatus({
		cfg: params.cfg,
		catalog: params.catalog,
		ref,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel
	});
}
function resolveAllowedModelRef(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) return { error: "invalid model: empty" };
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider
	});
	const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
		cfg: params.cfg,
		raw: trimmed,
		defaultProvider: params.defaultProvider
	});
	if (openrouterCompatRef) {
		const status = getModelRefStatusForResolve(params, openrouterCompatRef);
		if (!status.allowed) return { error: `model not allowed: ${status.key}` };
		return {
			ref: openrouterCompatRef,
			key: status.key
		};
	}
	return resolveAllowedModelRefFromAliasIndex({
		cfg: params.cfg,
		raw: params.raw,
		defaultProvider: params.defaultProvider,
		aliasIndex,
		getStatus: (ref) => getModelRefStatusForResolve(params, ref)
	});
}
/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
function resolveReasoningDefault(params) {
	const key = modelKey(params.provider, params.model);
	return (params.catalog?.find((entry) => entry.provider === params.provider && entry.id === params.model || entry.provider === key && entry.id === params.model))?.reasoning === true ? "on" : "off";
}
//#endregion
export { resolveAllowedModelRef as a, resolvePersistedModelRef as c, resolveReasoningDefault as d, resolveSubagentConfiguredModelSelection as f, resolveThinkingDefaultWithRuntimeCatalog as h, normalizeStoredOverrideModel as i, resolvePersistedOverrideModelRef as l, resolveThinkingDefault as m, canonicalizeCaseOnlyCatalogModelRef as n, resolveAllowlistModelKey as o, resolveSubagentSpawnModelSelection as p, getModelRefStatus as r, resolveDefaultModelForAgent as s, buildAllowedModelSet as t, resolvePersistedSelectedModelRef as u };
