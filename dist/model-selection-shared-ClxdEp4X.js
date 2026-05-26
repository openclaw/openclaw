import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as stripAnsi, t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as resolveAgentModelPrimaryValue } from "./model-input-ChW9XXsQ.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-DRIYGASz.js";
import { i as normalizeStaticProviderModelId, r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-L6rqw6O0.js";
import { t as resolveConfiguredProviderFallback } from "./configured-provider-fallback-C0W42MAj.js";
import { i as parseModelRef, n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
//#region src/agents/model-catalog-lookup.ts
function modelSupportsInput(entry, input) {
	return entry?.input?.includes(input) ?? false;
}
function findModelInCatalog(catalog, provider, modelId) {
	const normalizedProvider = normalizeProviderId(provider);
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	return catalog.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId);
}
function findModelCatalogEntry(catalog, params) {
	const modelId = normalizeOptionalString(params.modelId) ?? "";
	if (!modelId) return;
	const provider = normalizeOptionalString(params.provider);
	if (provider) return findModelInCatalog(catalog, provider, modelId);
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	const matches = catalog.filter((entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId);
	return matches.length === 1 ? matches[0] : void 0;
}
//#endregion
//#region src/agents/model-selection-shared.ts
let log = null;
function getLog() {
	log ??= createSubsystemLogger("model-selection");
	return log;
}
const OPENROUTER_COMPAT_FREE_ALIAS = "openrouter:free";
function sanitizeModelWarningValue(value) {
	const stripped = value ? stripAnsi(value) : "";
	let controlBoundary = -1;
	for (let index = 0; index < stripped.length; index += 1) {
		const code = stripped.charCodeAt(index);
		if (code <= 31 || code === 127) {
			controlBoundary = index;
			break;
		}
	}
	if (controlBoundary === -1) return sanitizeForLog(stripped);
	return sanitizeForLog(stripped.slice(0, controlBoundary));
}
function mergeModelCatalogEntries(params) {
	const merged = [...params.primary];
	const seen = new Set(merged.map((entry) => modelKey(entry.provider, entry.id)));
	for (const entry of params.secondary) {
		const key = modelKey(entry.provider, entry.id);
		if (seen.has(key)) continue;
		merged.push(entry);
		seen.add(key);
	}
	return merged;
}
function inferUniqueProviderFromConfiguredModels(params) {
	const model = params.model.trim();
	if (!model) return;
	const normalized = normalizeLowercaseStringOrEmpty(model);
	const providers = /* @__PURE__ */ new Set();
	const addProvider = (provider) => {
		const normalizedProvider = normalizeProviderId(provider);
		if (!normalizedProvider) return;
		providers.add(normalizedProvider);
	};
	const configuredModels = params.cfg.agents?.defaults?.models;
	if (configuredModels) for (const key of Object.keys(configuredModels)) {
		const ref = key.trim();
		if (!ref || !ref.includes("/") || ref.endsWith("/*")) continue;
		const parsed = parseModelRef(ref, DEFAULT_PROVIDER, { allowPluginNormalization: false });
		if (!parsed) continue;
		if (parsed.model === model || normalizeLowercaseStringOrEmpty(parsed.model) === normalized) {
			addProvider(parsed.provider);
			if (providers.size > 1) return;
		}
	}
	const configuredProviders = params.cfg.models?.providers;
	if (configuredProviders) for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
		const models = providerConfig?.models;
		if (!Array.isArray(models)) continue;
		for (const entry of models) {
			const modelId = entry?.id?.trim();
			if (!modelId) continue;
			const normalizedModelId = normalizeConfiguredProviderCatalogModelId(providerId, modelId, { manifestPlugins: params.manifestPlugins });
			if (modelId === model || normalizeLowercaseStringOrEmpty(modelId) === normalized || normalizedModelId === model || normalizeLowercaseStringOrEmpty(normalizedModelId) === normalized) addProvider(providerId);
		}
		if (providers.size > 1) return;
	}
	if (providers.size !== 1) return;
	return providers.values().next().value;
}
function inferUniqueProviderFromCatalog(params) {
	const model = params.model.trim();
	if (!model) return;
	const normalized = normalizeLowercaseStringOrEmpty(model);
	const providers = /* @__PURE__ */ new Set();
	for (const entry of params.catalog) {
		const entryId = entry.id.trim();
		if (!entryId) continue;
		if (entryId !== model && normalizeLowercaseStringOrEmpty(entryId) !== normalized) continue;
		const provider = normalizeProviderId(entry.provider);
		if (provider) providers.add(provider);
		if (providers.size > 1) return;
	}
	return providers.size === 1 ? providers.values().next().value : void 0;
}
function resolveBareModelDefaultProvider(params) {
	return inferUniqueProviderFromConfiguredModels({
		cfg: params.cfg,
		model: params.model,
		manifestPlugins: params.manifestPlugins
	}) ?? inferUniqueProviderFromCatalog({
		catalog: params.catalog,
		model: params.model
	}) ?? params.defaultProvider;
}
function isConcreteOpenRouterFreeModelRef(ref) {
	return ref.provider === "openrouter" && ref.model.includes("/") && ref.model.endsWith(":free");
}
function resolveConfiguredOpenRouterCompatFreeRef(params) {
	const configuredModels = params.cfg.agents?.defaults?.models ?? {};
	for (const raw of Object.keys(configuredModels)) {
		if (!raw.includes("/")) continue;
		const parsed = parseModelRef(raw, params.defaultProvider, {
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (parsed && isConcreteOpenRouterFreeModelRef(parsed)) return parsed;
	}
	const openrouterProviderConfig = findNormalizedProviderValue(params.cfg.models?.providers, "openrouter");
	for (const entry of openrouterProviderConfig?.models ?? []) {
		const modelId = entry?.id?.trim();
		if (!modelId || !modelId.includes("/") || !modelId.endsWith(":free")) continue;
		return normalizeModelRef("openrouter", modelId, {
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
	}
	return null;
}
function resolveConfiguredOpenRouterCompatAlias(params) {
	const normalized = normalizeLowercaseStringOrEmpty(params.raw);
	if (normalized === "openrouter:auto") return normalizeModelRef("openrouter", "auto", {
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) return null;
	return resolveConfiguredOpenRouterCompatFreeRef({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
}
function parseModelRefWithCompatAlias(params) {
	return resolveConfiguredOpenRouterCompatAlias(params) ?? resolveExactConfiguredProviderRef(params) ?? parseModelRef(params.raw, params.defaultProvider, {
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
}
function resolveExactConfiguredProviderRef(params) {
	const slash = params.raw.indexOf("/");
	if (slash <= 0 || !params.cfg?.models?.providers) return null;
	const providerRaw = params.raw.slice(0, slash).trim();
	const modelRaw = params.raw.slice(slash + 1).trim();
	if (!providerRaw || !modelRaw) return null;
	const providerKey = normalizeLowercaseStringOrEmpty(providerRaw);
	const exactConfigured = Object.entries(params.cfg.models.providers).find(([key]) => normalizeLowercaseStringOrEmpty(key) === providerKey);
	if (!exactConfigured) return null;
	const [configuredProvider, providerConfig] = exactConfigured;
	const normalizedConfiguredProvider = normalizeProviderId(configuredProvider);
	const apiOwner = typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
	if (!apiOwner || apiOwner === normalizedConfiguredProvider) return null;
	const provider = normalizeLowercaseStringOrEmpty(configuredProvider);
	return {
		provider,
		model: normalizeConfiguredProviderCatalogModelId(provider, normalizeStaticProviderModelId(provider, modelRaw.trim(), {
			allowManifestNormalization: params.allowManifestNormalization,
			manifestPlugins: params.manifestPlugins
		}), {
			allowManifestNormalization: params.allowManifestNormalization,
			manifestPlugins: params.manifestPlugins
		})
	};
}
function resolveAllowlistModelKey(params) {
	const parsed = parseModelRefWithCompatAlias({
		cfg: params.cfg,
		raw: params.raw,
		defaultProvider: params.defaultProvider,
		manifestPlugins: params.manifestPlugins
	});
	if (!parsed) return null;
	return modelKey(parsed.provider, parsed.model);
}
function buildConfiguredAllowlistKeys(params) {
	const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
	if (visibility.exactModelRefs.length === 0) return null;
	const keys = /* @__PURE__ */ new Set();
	for (const raw of visibility.exactModelRefs) {
		const key = resolveAllowlistModelKey({
			cfg: params.cfg,
			raw,
			defaultProvider: params.defaultProvider,
			manifestPlugins: params.manifestPlugins
		});
		if (key) keys.add(key);
	}
	return keys.size > 0 ? keys : null;
}
function buildModelAliasIndex(params) {
	const byAlias = /* @__PURE__ */ new Map();
	const byKey = /* @__PURE__ */ new Map();
	const rawModels = params.cfg.agents?.defaults?.models ?? {};
	for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
		const trimmedKey = keyRaw.trim();
		if (trimmedKey.endsWith("/*") && normalizeProviderId(trimmedKey.slice(0, -2))) continue;
		const parsed = parseModelRefWithCompatAlias({
			cfg: params.cfg,
			raw: keyRaw,
			defaultProvider: params.defaultProvider,
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (!parsed) continue;
		const alias = normalizeOptionalString(entryRaw?.alias) ?? "";
		if (!alias) continue;
		const aliasKey = normalizeLowercaseStringOrEmpty(alias);
		byAlias.set(aliasKey, {
			alias,
			ref: parsed
		});
		const key = modelKey(parsed.provider, parsed.model);
		const existing = byKey.get(key) ?? [];
		existing.push(alias);
		byKey.set(key, existing);
	}
	return {
		byAlias,
		byKey
	};
}
function buildModelCatalogMetadata(params) {
	const configuredByKey = /* @__PURE__ */ new Map();
	for (const entry of buildConfiguredModelCatalog({
		cfg: params.cfg,
		manifestPlugins: params.manifestPlugins
	})) configuredByKey.set(modelKey(entry.provider, entry.id), entry);
	const aliasByKey = /* @__PURE__ */ new Map();
	const configuredModels = params.cfg.agents?.defaults?.models ?? {};
	for (const [rawKey, entryRaw] of Object.entries(configuredModels)) {
		const key = resolveAllowlistModelKey({
			cfg: params.cfg,
			raw: rawKey,
			defaultProvider: params.defaultProvider,
			manifestPlugins: params.manifestPlugins
		});
		if (!key) continue;
		const alias = (entryRaw?.alias ?? "").trim();
		if (!alias) continue;
		aliasByKey.set(key, alias);
	}
	return {
		configuredByKey,
		aliasByKey
	};
}
function applyModelCatalogMetadata(params) {
	const key = modelKey(params.entry.provider, params.entry.id);
	const configuredEntry = params.metadata.configuredByKey.get(key);
	const alias = params.metadata.aliasByKey.get(key);
	if (!configuredEntry && !alias) return params.entry;
	const nextAlias = alias ?? params.entry.alias;
	const nextContextWindow = configuredEntry?.contextWindow ?? params.entry.contextWindow;
	const nextContextTokens = configuredEntry?.contextTokens ?? params.entry.contextTokens;
	const nextReasoning = configuredEntry?.reasoning ?? params.entry.reasoning;
	const nextInput = configuredEntry?.input ?? params.entry.input;
	const nextCompat = configuredEntry?.compat ?? params.entry.compat;
	return {
		...params.entry,
		name: configuredEntry?.name ?? params.entry.name,
		...nextAlias ? { alias: nextAlias } : {},
		...nextContextWindow !== void 0 ? { contextWindow: nextContextWindow } : {},
		...nextContextTokens !== void 0 ? { contextTokens: nextContextTokens } : {},
		...nextReasoning !== void 0 ? { reasoning: nextReasoning } : {},
		...nextInput ? { input: nextInput } : {},
		...nextCompat ? { compat: nextCompat } : {}
	};
}
function buildSyntheticAllowedCatalogEntry(params) {
	const key = modelKey(params.parsed.provider, params.parsed.model);
	const configuredEntry = params.metadata.configuredByKey.get(key);
	const alias = params.metadata.aliasByKey.get(key);
	const nextContextWindow = configuredEntry?.contextWindow;
	const nextContextTokens = configuredEntry?.contextTokens;
	const nextReasoning = configuredEntry?.reasoning;
	const nextInput = configuredEntry?.input;
	const nextCompat = configuredEntry?.compat;
	return {
		id: params.parsed.model,
		name: configuredEntry?.name ?? params.parsed.model,
		provider: params.parsed.provider,
		...alias ? { alias } : {},
		...nextContextWindow !== void 0 ? { contextWindow: nextContextWindow } : {},
		...nextContextTokens !== void 0 ? { contextTokens: nextContextTokens } : {},
		...nextReasoning !== void 0 ? { reasoning: nextReasoning } : {},
		...nextInput ? { input: nextInput } : {},
		...nextCompat ? { compat: nextCompat } : {}
	};
}
function resolveModelRefFromString(params) {
	const { model } = splitTrailingAuthProfile(params.raw);
	if (!model) return null;
	const aliasKey = normalizeLowercaseStringOrEmpty(model);
	const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
	if (aliasMatch) return {
		ref: aliasMatch.ref,
		alias: aliasMatch.alias
	};
	const parsed = parseModelRefWithCompatAlias({
		cfg: params.cfg,
		raw: model,
		defaultProvider: params.defaultProvider,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	if (!parsed) return null;
	return { ref: parsed };
}
function resolveConfiguredModelRef(params) {
	const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
	if (rawModel) {
		const trimmed = rawModel.trim();
		const aliasIndex = buildModelAliasIndex({
			cfg: params.cfg,
			defaultProvider: params.defaultProvider,
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
		const aliasMatch = aliasIndex.byAlias.get(aliasKey);
		if (aliasMatch) return aliasMatch.ref;
		if (!trimmed.includes("/")) {
			const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
				cfg: params.cfg,
				raw: trimmed,
				defaultProvider: params.defaultProvider,
				allowManifestNormalization: params.allowManifestNormalization,
				allowPluginNormalization: params.allowPluginNormalization,
				manifestPlugins: params.manifestPlugins
			});
			if (openrouterCompatRef) return openrouterCompatRef;
			const inferredProvider = inferUniqueProviderFromConfiguredModels({
				cfg: params.cfg,
				model: trimmed,
				manifestPlugins: params.manifestPlugins
			});
			if (inferredProvider) return normalizeModelRef(inferredProvider, trimmed, { manifestPlugins: params.manifestPlugins });
			const safeTrimmed = sanitizeModelWarningValue(trimmed);
			const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
			getLog().warn(`Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`);
			return {
				provider: params.defaultProvider,
				model: trimmed
			};
		}
		const resolved = resolveModelRefFromString({
			cfg: params.cfg,
			raw: trimmed,
			defaultProvider: params.defaultProvider,
			aliasIndex,
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (resolved) return resolved.ref;
		const safe = sanitizeForLog(trimmed);
		const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
		getLog().warn(`Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`);
	}
	const fallbackProvider = resolveConfiguredProviderFallback({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider
	});
	if (fallbackProvider) return fallbackProvider;
	return {
		provider: params.defaultProvider,
		model: params.defaultModel
	};
}
function buildAllowedModelSetWithFallbacks(params) {
	const metadata = buildModelCatalogMetadata({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider,
		manifestPlugins: params.manifestPlugins
	});
	const configuredCatalog = buildConfiguredModelCatalog({
		cfg: params.cfg,
		manifestPlugins: params.manifestPlugins
	});
	const catalog = mergeModelCatalogEntries({
		primary: params.catalog,
		secondary: configuredCatalog
	}).map((entry) => applyModelCatalogMetadata({
		entry,
		metadata
	}));
	const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
	const allowAny = !visibility.hasEntries;
	const defaultModel = params.defaultModel?.trim();
	const defaultRef = defaultModel && params.defaultProvider ? parseModelRefWithCompatAlias({
		cfg: params.cfg,
		raw: defaultModel,
		defaultProvider: params.defaultProvider,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	}) : null;
	const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : void 0;
	const catalogKeys = /* @__PURE__ */ new Set();
	for (const entry of catalog) catalogKeys.add(modelKey(entry.provider, entry.id));
	if (allowAny) {
		if (defaultKey) catalogKeys.add(defaultKey);
		return {
			allowAny: true,
			allowedCatalog: catalog,
			allowedKeys: catalogKeys
		};
	}
	const allowedKeys = /* @__PURE__ */ new Set();
	const allowedRefs = [];
	const syntheticCatalogEntries = /* @__PURE__ */ new Map();
	for (const provider of visibility.providerWildcards) allowedKeys.add(providerWildcardModelKey(provider));
	const addAllowedCatalogRef = (ref) => {
		if (!allowedRefs.some((existing) => modelKey(existing.provider, existing.model) === modelKey(ref.provider, ref.model))) allowedRefs.push(ref);
	};
	for (const entry of catalog) {
		if (!visibility.providerWildcards.has(normalizeProviderId(entry.provider))) continue;
		allowedKeys.add(modelKey(entry.provider, entry.id));
		addAllowedCatalogRef({
			provider: entry.provider,
			model: entry.id
		});
	}
	const addAllowedModelRef = (raw) => {
		const trimmed = raw.trim();
		const defaultProvider = !trimmed.includes("/") ? resolveBareModelDefaultProvider({
			cfg: params.cfg,
			catalog,
			model: trimmed,
			defaultProvider: params.defaultProvider,
			manifestPlugins: params.manifestPlugins
		}) : params.defaultProvider;
		const parsed = parseModelRefWithCompatAlias({
			cfg: params.cfg,
			raw,
			defaultProvider,
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (!parsed) return;
		const key = modelKey(parsed.provider, parsed.model);
		allowedKeys.add(key);
		addAllowedCatalogRef(parsed);
		if (!findModelCatalogEntry(catalog, {
			provider: parsed.provider,
			modelId: parsed.model
		}) && !syntheticCatalogEntries.has(key)) syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({
			parsed,
			metadata
		}));
	};
	for (const raw of visibility.exactModelRefs) addAllowedModelRef(raw);
	if (visibility.exactModelRefs.length > 0) for (const fallback of params.fallbackModels) addAllowedModelRef(fallback);
	if (defaultKey && (visibility.exactModelRefs.length > 0 && visibility.providerWildcards.size === 0 || defaultRef && visibility.providerWildcards.has(normalizeProviderId(defaultRef.provider)))) {
		allowedKeys.add(defaultKey);
		if (defaultRef) addAllowedCatalogRef(defaultRef);
	}
	const allowedCatalog = [...catalog.filter((entry) => allowedRefs.some((ref) => findModelCatalogEntry([entry], {
		provider: ref.provider,
		modelId: ref.model
	}) === entry)), ...syntheticCatalogEntries.values()];
	if (allowedCatalog.length === 0 && allowedKeys.size === 0 && visibility.providerWildcards.size === 0) {
		if (defaultKey) catalogKeys.add(defaultKey);
		return {
			allowAny: true,
			allowedCatalog: catalog,
			allowedKeys: catalogKeys
		};
	}
	return {
		allowAny: false,
		allowedCatalog,
		allowedKeys
	};
}
function getModelRefStatusFromAllowedSet(params) {
	const key = modelKey(params.ref.provider, params.ref.model);
	return {
		key,
		inCatalog: Boolean(findModelCatalogEntry(params.catalog, {
			provider: params.ref.provider,
			modelId: params.ref.model
		})),
		allowAny: params.allowed.allowAny,
		allowed: params.allowed.allowAny || isModelKeyAllowedBySet(params.allowed.allowedKeys, key)
	};
}
function getModelRefStatusWithFallbackModels(params) {
	const allowed = buildAllowedModelSetWithFallbacks({
		cfg: params.cfg,
		catalog: params.catalog,
		defaultProvider: params.defaultProvider,
		defaultModel: params.defaultModel,
		fallbackModels: params.fallbackModels,
		manifestPlugins: params.manifestPlugins
	});
	return getModelRefStatusFromAllowedSet({
		catalog: params.catalog,
		ref: params.ref,
		allowed
	});
}
function resolveAllowedModelRefFromAliasIndex(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) return { error: "invalid model: empty" };
	const effectiveDefaultProvider = !trimmed.includes("/") ? inferUniqueProviderFromConfiguredModels({
		cfg: params.cfg,
		model: trimmed,
		manifestPlugins: params.manifestPlugins
	}) ?? params.defaultProvider : params.defaultProvider;
	const resolved = resolveModelRefFromString({
		cfg: params.cfg,
		raw: trimmed,
		defaultProvider: effectiveDefaultProvider,
		aliasIndex: params.aliasIndex,
		manifestPlugins: params.manifestPlugins
	});
	if (!resolved) return { error: `invalid model: ${trimmed}` };
	const status = params.getStatus(resolved.ref);
	if (!status.allowed) return { error: `model not allowed: ${status.key}` };
	return {
		ref: resolved.ref,
		key: status.key
	};
}
function hasConfiguredProviderModelRows(cfg) {
	const providers = cfg.models?.providers;
	if (!providers || typeof providers !== "object") return false;
	return Object.values(providers).some((provider) => Array.isArray(provider?.models));
}
function resolveConfiguredModelManifestPlugins(params) {
	if (params.manifestPlugins) return params.manifestPlugins;
	if (!hasConfiguredProviderModelRows(params.cfg)) return;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	if (!workspaceDir) return getCurrentPluginMetadataSnapshot({
		config: params.cfg,
		env: process.env
	})?.plugins ?? [];
	return loadManifestMetadataSnapshot({
		config: params.cfg,
		workspaceDir,
		env: process.env
	}).plugins;
}
function buildConfiguredModelCatalog(params) {
	const providers = params.cfg.models?.providers;
	if (!providers || typeof providers !== "object") return [];
	const manifestPlugins = resolveConfiguredModelManifestPlugins(params);
	const catalog = [];
	for (const [providerRaw, provider] of Object.entries(providers)) {
		const providerId = normalizeProviderId(providerRaw);
		if (!providerId || !Array.isArray(provider?.models)) continue;
		for (const model of provider.models) {
			const rawId = normalizeOptionalString(model?.id) ?? "";
			const id = rawId ? normalizeConfiguredProviderCatalogModelId(providerId, rawId, { manifestPlugins }) : "";
			if (!id) continue;
			const name = normalizeOptionalString(model?.name) || id;
			const contextWindow = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : void 0;
			const contextTokens = typeof model?.contextTokens === "number" && model.contextTokens > 0 ? model.contextTokens : void 0;
			const reasoning = typeof model?.reasoning === "boolean" ? model.reasoning : void 0;
			const input = Array.isArray(model?.input) ? model.input : void 0;
			const compat = model?.compat && typeof model.compat === "object" ? model.compat : void 0;
			catalog.push({
				provider: providerId,
				id,
				name,
				contextWindow,
				contextTokens,
				reasoning,
				input,
				compat
			});
		}
	}
	return catalog;
}
function resolveHooksGmailModel(params) {
	const hooksModel = params.cfg.hooks?.gmail?.model;
	if (!hooksModel?.trim()) return null;
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider,
		manifestPlugins: params.manifestPlugins
	});
	return resolveModelRefFromString({
		cfg: params.cfg,
		raw: hooksModel,
		defaultProvider: params.defaultProvider,
		aliasIndex,
		manifestPlugins: params.manifestPlugins
	})?.ref ?? null;
}
function normalizeModelSelection(value) {
	if (typeof value === "string") return value.trim() || void 0;
	if (!value || typeof value !== "object") return;
	const primary = value.primary;
	if (typeof primary === "string" && primary.trim()) return primary.trim();
}
function parseConfiguredModelVisibilityEntries(params) {
	const rawModels = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
	const exactModelRefs = [];
	const providerWildcards = /* @__PURE__ */ new Set();
	for (const raw of rawModels) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (trimmed.endsWith("/*")) {
			const provider = normalizeProviderId(trimmed.slice(0, -2));
			if (provider) {
				providerWildcards.add(provider);
				continue;
			}
		}
		exactModelRefs.push(raw);
	}
	return {
		exactModelRefs,
		providerWildcards,
		hasEntries: rawModels.length > 0
	};
}
function providerWildcardModelKey(provider) {
	return modelKey(normalizeProviderId(provider), "*");
}
function isModelKeyAllowedBySet(allowedKeys, key) {
	if (allowedKeys.has(key)) return true;
	const separator = key.indexOf("/");
	if (separator <= 0) return false;
	return allowedKeys.has(providerWildcardModelKey(key.slice(0, separator)));
}
function resolveAllowedModelSelection(params) {
	const current = normalizeModelRef(params.provider, params.model, { manifestPlugins: params.manifestPlugins });
	if (params.allowAny || isModelKeyAllowedBySet(params.allowedKeys, modelKey(current.provider, current.model))) return current;
	const fallback = params.allowedCatalog[0];
	if (!fallback) return null;
	return normalizeModelRef(fallback.provider, fallback.id, { manifestPlugins: params.manifestPlugins });
}
function dedupeModelCatalogEntries(entries) {
	const seen = /* @__PURE__ */ new Set();
	const next = [];
	for (const entry of entries) {
		const key = modelKey(entry.provider, entry.id);
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(entry);
	}
	return next;
}
function createModelVisibilityPolicyWithFallbacks(params) {
	const visibility = parseConfiguredModelVisibilityEntries({ cfg: params.cfg });
	const allowed = buildAllowedModelSetWithFallbacks(params);
	const allowsKey = (key) => allowed.allowAny || isModelKeyAllowedBySet(allowed.allowedKeys, key);
	const exactConfiguredKeys = /* @__PURE__ */ new Set();
	for (const raw of visibility.exactModelRefs) {
		const key = resolveAllowlistModelKey({
			cfg: params.cfg,
			raw,
			defaultProvider: params.defaultProvider,
			manifestPlugins: params.manifestPlugins
		});
		if (key) exactConfiguredKeys.add(key);
	}
	return {
		allowAny: allowed.allowAny,
		allowedCatalog: allowed.allowedCatalog,
		allowedKeys: allowed.allowedKeys,
		exactModelRefs: visibility.exactModelRefs,
		providerWildcards: visibility.providerWildcards,
		hasConfiguredEntries: visibility.hasEntries,
		hasProviderWildcards: visibility.providerWildcards.size > 0,
		allowsKey,
		allows: (ref) => allowsKey(modelKey(ref.provider, ref.model)),
		resolveSelection: (ref) => resolveAllowedModelSelection({
			provider: ref.provider,
			model: ref.model,
			allowAny: allowed.allowAny,
			allowedKeys: allowed.allowedKeys,
			allowedCatalog: allowed.allowedCatalog,
			manifestPlugins: params.manifestPlugins
		}),
		visibleCatalog: ({ catalog, defaultVisibleCatalog, view }) => {
			if (view === "all") return [...catalog];
			if (allowed.allowAny) return [...defaultVisibleCatalog];
			if (visibility.providerWildcards.size === 0) return [...allowed.allowedCatalog];
			return dedupeModelCatalogEntries([...defaultVisibleCatalog.filter((entry) => visibility.providerWildcards.has(normalizeProviderId(entry.provider))), ...allowed.allowedCatalog.filter((entry) => !visibility.providerWildcards.has(normalizeProviderId(entry.provider)) || exactConfiguredKeys.has(modelKey(entry.provider, entry.id)))]);
		}
	};
}
//#endregion
export { findModelInCatalog as C, findModelCatalogEntry as S, resolveBareModelDefaultProvider as _, createModelVisibilityPolicyWithFallbacks as a, resolveHooksGmailModel as b, inferUniqueProviderFromCatalog as c, normalizeModelSelection as d, parseConfiguredModelVisibilityEntries as f, resolveAllowlistModelKey as g, resolveAllowedModelSelection as h, buildModelAliasIndex as i, inferUniqueProviderFromConfiguredModels as l, resolveAllowedModelRefFromAliasIndex as m, buildConfiguredAllowlistKeys as n, getModelRefStatusWithFallbackModels as o, providerWildcardModelKey as p, buildConfiguredModelCatalog as r, hasConfiguredProviderModelRows as s, buildAllowedModelSetWithFallbacks as t, isModelKeyAllowedBySet as u, resolveConfiguredModelRef as v, modelSupportsInput as w, resolveModelRefFromString as x, resolveConfiguredOpenRouterCompatAlias as y };
