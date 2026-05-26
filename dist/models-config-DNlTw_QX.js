import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { a as createConfigRuntimeEnv } from "./state-dir-dotenv-Dzh60TUr.js";
import { m as resolveSecretInputRef } from "./types.secrets-DwPik3M8.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { t as MODEL_APIS } from "./types.models-lqH0KLkn.js";
import { n as resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed-HgZGS-Bx.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig, s as projectConfigOntoRuntimeSourceSnapshot } from "./io-DoswVvYe.js";
import { r as normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared-BkjJfDrJ.js";
import { s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import "./config-B6Oplu5W.js";
import { h as resolveOwningPluginIdsForProvider } from "./plugin-auto-enable-CuCUT4Z1.js";
import { E as resolveProviderConfigApiKeyWithPlugin, m as normalizeProviderConfigWithPlugin, n as applyProviderNativeStreamingUsageCompatWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { f as parseConfiguredModelVisibilityEntries } from "./model-selection-shared-ClxdEp4X.js";
import { g as resolveNonEnvSecretRefHeaderValueMarker, h as resolveNonEnvSecretRefApiKeyMarker, m as resolveEnvSecretRefHeaderValueMarker, u as isNonSecretApiKeyMarker } from "./model-auth-markers-Cf78z2Zm.js";
import { i as runProviderCatalog, n as normalizePluginDiscoveryResult, r as resolveRuntimePluginDiscoveryProviders, t as groupPluginDiscoveryProvidersByOrder } from "./provider-discovery-CP1SEcge.js";
import { a as normalizeHeaderValues, c as resolveMissingProviderApiKey, i as normalizeConfiguredProviderApiKey, n as createProviderAuthResolver, o as normalizeResolvedEnvApiKey, s as resolveApiKeyFromProfiles, t as createProviderApiKeyResolver } from "./models-config.providers.secrets-k1Lv9zej.js";
import { t as stableStringify } from "./stable-stringify-TfJ9A6yH.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/models-config-state.ts
const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");
const MODELS_JSON_STATE = (() => {
	const globalState = globalThis;
	if (!globalState[MODELS_JSON_STATE_KEY]) globalState[MODELS_JSON_STATE_KEY] = {
		writeLocks: /* @__PURE__ */ new Map(),
		readyCache: /* @__PURE__ */ new Map()
	};
	return globalState[MODELS_JSON_STATE_KEY];
})();
//#endregion
//#region src/agents/models-config.merge.ts
function isPositiveFiniteTokenLimit(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function resolvePreferredTokenLimit(params) {
	if (params.explicitPresent && isPositiveFiniteTokenLimit(params.explicitValue)) return params.explicitValue;
	if (isPositiveFiniteTokenLimit(params.implicitValue)) return params.implicitValue;
	return isPositiveFiniteTokenLimit(params.explicitValue) ? params.explicitValue : void 0;
}
function getProviderModelId$1(model) {
	if (!model || typeof model !== "object") return "";
	const id = model.id;
	return normalizeOptionalString(id) ?? "";
}
function mergeProviderModels(implicit, explicit) {
	const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
	const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
	const implicitHeaders = implicit.headers && typeof implicit.headers === "object" && !Array.isArray(implicit.headers) ? implicit.headers : void 0;
	const explicitHeaders = explicit.headers && typeof explicit.headers === "object" && !Array.isArray(explicit.headers) ? explicit.headers : void 0;
	if (implicitModels.length === 0) return {
		...implicit,
		...explicit,
		...implicitHeaders || explicitHeaders ? { headers: {
			...implicitHeaders,
			...explicitHeaders
		} } : {}
	};
	const implicitById = new Map(implicitModels.map((model) => [getProviderModelId$1(model), model]).filter(([id]) => Boolean(id)));
	const seen = /* @__PURE__ */ new Set();
	const mergedModels = explicitModels.map((explicitModel) => {
		const id = getProviderModelId$1(explicitModel);
		if (!id) return explicitModel;
		seen.add(id);
		const implicitModel = implicitById.get(id);
		if (!implicitModel) return explicitModel;
		const contextWindow = resolvePreferredTokenLimit({
			explicitPresent: "contextWindow" in explicitModel,
			explicitValue: explicitModel.contextWindow,
			implicitValue: implicitModel.contextWindow
		});
		const contextTokens = resolvePreferredTokenLimit({
			explicitPresent: "contextTokens" in explicitModel,
			explicitValue: explicitModel.contextTokens,
			implicitValue: implicitModel.contextTokens
		});
		const maxTokens = resolvePreferredTokenLimit({
			explicitPresent: "maxTokens" in explicitModel,
			explicitValue: explicitModel.maxTokens,
			implicitValue: implicitModel.maxTokens
		});
		return Object.assign({}, explicitModel, {
			input: "input" in explicitModel ? explicitModel.input : implicitModel.input,
			reasoning: `reasoning` in explicitModel ? explicitModel.reasoning : implicitModel.reasoning
		}, contextWindow === void 0 ? {} : { contextWindow }, contextTokens === void 0 ? {} : { contextTokens }, maxTokens === void 0 ? {} : { maxTokens });
	});
	for (const implicitModel of implicitModels) {
		const id = getProviderModelId$1(implicitModel);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		mergedModels.push(implicitModel);
	}
	return {
		...implicit,
		...explicit,
		...implicitHeaders || explicitHeaders ? { headers: {
			...implicitHeaders,
			...explicitHeaders
		} } : {},
		models: mergedModels
	};
}
function mergeProviders(params) {
	const out = params.implicit ? { ...params.implicit } : {};
	for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
		const providerKey = normalizeOptionalString(key) ?? "";
		if (!providerKey) continue;
		const implicit = out[providerKey];
		out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
	}
	return out;
}
function resolveProviderApi(entry) {
	return normalizeOptionalString(entry?.api);
}
function resolveModelApiSurface(entry) {
	if (!Array.isArray(entry?.models)) return;
	const apis = entry.models.flatMap((model) => {
		if (!model || typeof model !== "object") return [];
		const api = model.api;
		const normalized = normalizeOptionalString(api);
		return normalized ? [normalized] : [];
	}).toSorted();
	return apis.length > 0 ? JSON.stringify(apis) : void 0;
}
function resolveProviderApiSurface(entry) {
	return resolveProviderApi(entry) ?? resolveModelApiSurface(entry);
}
function shouldPreserveExistingApiKey(params) {
	const { providerKey, existing, nextEntry, secretRefManagedProviders } = params;
	const nextApiKey = typeof nextEntry.apiKey === "string" ? nextEntry.apiKey : "";
	if (nextApiKey && isNonSecretApiKeyMarker(nextApiKey)) return false;
	return !secretRefManagedProviders.has(providerKey) && typeof existing.apiKey === "string" && existing.apiKey.length > 0 && !isNonSecretApiKeyMarker(existing.apiKey, { includeEnvVarName: false });
}
function shouldPreserveExistingBaseUrl(params) {
	const { existing, nextEntry } = params;
	if (typeof existing.baseUrl !== "string" || existing.baseUrl.length === 0) return false;
	const existingApi = resolveProviderApiSurface(existing);
	const nextApi = resolveProviderApiSurface(nextEntry);
	return !existingApi || !nextApi || existingApi === nextApi;
}
function mergeWithExistingProviderSecrets(params) {
	const { nextProviders, existingProviders, secretRefManagedProviders } = params;
	const mergedProviders = {};
	for (const [key, entry] of Object.entries(existingProviders)) mergedProviders[key] = entry;
	for (const [key, newEntry] of Object.entries(nextProviders)) {
		const existing = existingProviders[key];
		if (!existing) {
			mergedProviders[key] = newEntry;
			continue;
		}
		const preserved = {};
		if (shouldPreserveExistingApiKey({
			providerKey: key,
			existing,
			nextEntry: newEntry,
			secretRefManagedProviders
		})) preserved.apiKey = existing.apiKey;
		if (shouldPreserveExistingBaseUrl({
			existing,
			nextEntry: newEntry
		})) preserved.baseUrl = existing.baseUrl;
		mergedProviders[key] = {
			...newEntry,
			...preserved
		};
	}
	return mergedProviders;
}
//#endregion
//#region src/agents/models-config.providers.implicit.ts
const log = createSubsystemLogger("agents/model-providers");
const PROVIDER_IMPLICIT_MERGERS = { ollama: ({ implicit }) => implicit };
const PLUGIN_DISCOVERY_ORDERS = [
	"simple",
	"profile",
	"paired",
	"late"
];
function resolveLiveProviderCatalogTimeoutMs(env) {
	if (!(env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1")) return null;
	const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
	if (!raw) return 15e3;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 15e3;
}
function resolveProviderDiscoveryFilter(params) {
	const { config, workspaceDir, env } = params;
	const testRaw = env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS?.trim();
	if (testRaw) {
		const ids = testRaw.split(",").map((value) => value.trim()).filter(Boolean);
		return ids.length > 0 ? [...new Set(ids)] : void 0;
	}
	const scopedProviderIds = params.providerIds?.map((value) => value.trim()).filter((value) => value.length > 0);
	if (scopedProviderIds) return resolveProviderPluginScopeFromProviderIds({
		providerIds: scopedProviderIds,
		config,
		workspaceDir,
		env,
		resolveOwners: params.resolveOwners
	});
	if (!(env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1")) return;
	const rawValues = [env.OPENCLAW_LIVE_PROVIDERS?.trim(), env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim()].filter((value) => Boolean(value && value !== "all"));
	if (rawValues.length === 0) return;
	const ids = rawValues.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
	if (ids.length === 0) return;
	return resolveProviderPluginScopeFromProviderIds({
		providerIds: ids,
		config,
		workspaceDir,
		env,
		resolveOwners: params.resolveOwners
	});
}
function resolveProviderPluginScopeFromProviderIds(params) {
	const pluginIds = /* @__PURE__ */ new Set();
	for (const id of params.providerIds) {
		const owners = params.resolveOwners?.(id) ?? resolveOwningPluginIdsForProvider({
			provider: id,
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env
		}) ?? [];
		if (owners.length > 0) {
			for (const owner of owners) pluginIds.add(owner);
			continue;
		}
		pluginIds.add(id);
	}
	return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
function resolvePluginMetadataProviderOwners(pluginMetadataSnapshot, provider) {
	if (!pluginMetadataSnapshot) return;
	const normalizedProvider = normalizeProviderId(provider);
	if (!normalizedProvider) return;
	const owners = /* @__PURE__ */ new Set();
	appendNormalizedPluginMetadataOwners(owners, pluginMetadataSnapshot.owners.providers ?? /* @__PURE__ */ new Map(), provider, normalizedProvider);
	appendNormalizedPluginMetadataOwners(owners, pluginMetadataSnapshot.owners.modelCatalogProviders ?? /* @__PURE__ */ new Map(), provider, normalizedProvider);
	appendNormalizedPluginMetadataOwners(owners, pluginMetadataSnapshot.owners.setupProviders ?? /* @__PURE__ */ new Map(), provider, normalizedProvider);
	appendNormalizedPluginMetadataOwners(owners, pluginMetadataSnapshot.owners.cliBackends ?? /* @__PURE__ */ new Map(), provider, normalizedProvider);
	return owners.size > 0 ? [...owners].toSorted((left, right) => left.localeCompare(right)) : void 0;
}
function appendNormalizedPluginMetadataOwners(target, ownerMap, provider, normalizedProvider) {
	for (const owner of ownerMap.get(provider) ?? []) target.add(owner);
	if (normalizedProvider !== provider) for (const owner of ownerMap.get(normalizedProvider) ?? []) target.add(owner);
	for (const [ownedId, owners] of ownerMap.entries()) if (ownedId !== provider && ownedId !== normalizedProvider && normalizeProviderId(ownedId) === normalizedProvider) for (const owner of owners) target.add(owner);
}
function mergeImplicitProviderSet(target, additions) {
	if (!additions) return;
	for (const [key, value] of Object.entries(additions)) target[key] = value;
}
function mergeImplicitProviderConfig(params) {
	const { providerId, existing, implicit } = params;
	if (!existing) return implicit;
	const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
	if (merge) return merge({
		existing,
		implicit
	});
	if (params.dynamicProviderModels) return mergeProviderModels(implicit, existing);
	return {
		...implicit,
		...existing,
		models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : implicit.models
	};
}
function resolveConfiguredImplicitProvider(params) {
	for (const providerId of params.providerIds) {
		const configured = findNormalizedProviderValue(params.configuredProviders ?? void 0, providerId);
		if (configured) return configured;
	}
}
function resolveExistingImplicitProviderFromContext(params) {
	return resolveConfiguredImplicitProvider({
		configuredProviders: params.ctx.explicitProviders,
		providerIds: params.providerIds
	}) ?? resolveConfiguredImplicitProvider({
		configuredProviders: params.ctx.config?.models?.providers,
		providerIds: params.providerIds
	});
}
function hasProviderWildcardVisibility(params) {
	return parseConfiguredModelVisibilityEntries({ cfg: params.config }).providerWildcards.has(normalizeProviderId(params.providerId));
}
async function resolvePluginImplicitProviders(ctx, providers, order) {
	const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
	const discovered = {};
	const catalogConfig = buildPluginCatalogConfig(ctx);
	for (const provider of byOrder[order]) {
		const resolveCatalogProviderApiKey = (providerId) => {
			const resolvedProviderId = providerId?.trim() || provider.id;
			const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
			if (resolved.apiKey) return resolved;
			if (!findNormalizedProviderValue({
				[provider.id]: true,
				...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
				...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true]))
			}, resolvedProviderId)) return resolved;
			const syntheticApiKey = (provider.resolveSyntheticAuth?.({
				config: catalogConfig,
				provider: resolvedProviderId,
				providerConfig: catalogConfig.models?.providers?.[resolvedProviderId]
			}))?.apiKey?.trim();
			if (!syntheticApiKey) return resolved;
			return {
				apiKey: isNonSecretApiKeyMarker(syntheticApiKey) ? syntheticApiKey : resolveNonEnvSecretRefApiKeyMarker("file"),
				discoveryApiKey: void 0
			};
		};
		const result = await runProviderCatalogWithTimeout({
			provider,
			config: catalogConfig,
			agentDir: ctx.agentDir,
			workspaceDir: ctx.workspaceDir,
			env: ctx.env,
			resolveProviderApiKey: resolveCatalogProviderApiKey,
			resolveProviderAuth: (providerId, options) => ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
			timeoutMs: ctx.providerDiscoveryTimeoutMs ?? resolveLiveProviderCatalogTimeoutMs(ctx.env)
		});
		if (!result) continue;
		const normalizedResult = normalizePluginDiscoveryResult({
			provider,
			result
		});
		for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) discovered[providerId] = mergeImplicitProviderConfig({
			providerId,
			existing: discovered[providerId] ?? resolveExistingImplicitProviderFromContext({
				ctx,
				providerIds: [
					providerId,
					provider.id,
					...provider.aliases ?? [],
					...provider.hookAliases ?? []
				]
			}),
			implicit: implicitProvider,
			dynamicProviderModels: hasProviderWildcardVisibility({
				config: ctx.config,
				providerId
			})
		});
	}
	return Object.keys(discovered).length > 0 ? discovered : void 0;
}
function buildPluginCatalogConfig(ctx) {
	if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) return ctx.config ?? {};
	return {
		...ctx.config,
		models: {
			...ctx.config?.models,
			providers: {
				...ctx.config?.models?.providers,
				...ctx.explicitProviders
			}
		}
	};
}
async function runProviderCatalogWithTimeout(params) {
	const catalogRun = runProviderCatalog(params);
	const timeoutMs = params.timeoutMs ?? void 0;
	if (!timeoutMs) return await catalogRun;
	let timer;
	try {
		return await Promise.race([catalogRun, new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`));
			}, timeoutMs);
			timer.unref?.();
		})]);
	} catch (error) {
		const message = formatErrorMessage(error);
		if (message.includes("provider catalog timed out after")) {
			log.warn(`${message}; skipping provider discovery`);
			return;
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function resolveImplicitProviders(params) {
	const providers = {};
	const env = params.env ?? process.env;
	let authStore;
	const getAuthStore = () => authStore ??= ensureAuthProfileStore(params.agentDir, {
		allowKeychainPrompt: false,
		externalCliProviderIds: params.providerDiscoveryProviderIds
	});
	const context = {
		...params,
		get authStore() {
			return getAuthStore();
		},
		env,
		resolveProviderApiKey: createProviderApiKeyResolver(env, getAuthStore, params.config),
		resolveProviderAuth: createProviderAuthResolver(env, getAuthStore, params.config)
	};
	const discoveryProviders = await resolveRuntimePluginDiscoveryProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env,
		onlyPluginIds: resolveProviderDiscoveryFilter({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env,
			resolveOwners: params.pluginMetadataSnapshot ? (provider) => resolvePluginMetadataProviderOwners(params.pluginMetadataSnapshot, provider) : void 0,
			providerIds: params.providerDiscoveryProviderIds
		}),
		...params.pluginMetadataSnapshot ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot } : {},
		...params.providerDiscoveryEntriesOnly === true ? { discoveryEntriesOnly: true } : {}
	});
	for (const order of PLUGIN_DISCOVERY_ORDERS) mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, discoveryProviders, order));
	return providers;
}
//#endregion
//#region src/agents/models-config.providers.policy.lookup.ts
const GENERIC_PROVIDER_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai"
]);
function resolveProviderPluginLookupKey(providerKey, provider) {
	const api = normalizeOptionalString(provider?.api) ?? "";
	if (providerKey === "google-antigravity" || providerKey === "google-vertex" || api === "google-generative-ai") return "google";
	if (Array.isArray(provider?.models) && provider.models.some((model) => normalizeOptionalString(model.api) === "google-generative-ai")) return "google";
	if (api && MODEL_APIS.includes(api) && !GENERIC_PROVIDER_APIS.has(api)) return api;
	return providerKey;
}
//#endregion
//#region src/agents/models-config.providers.policy.runtime.ts
function applyProviderNativeStreamingUsagePolicy(providerKey, provider) {
	return applyProviderNativeStreamingUsageCompatWithPlugin({
		provider: resolveProviderPluginLookupKey(providerKey, provider),
		allowRuntimePluginLoad: false,
		context: {
			provider: providerKey,
			providerConfig: provider
		}
	}) ?? provider;
}
function normalizeProviderConfigPolicy(providerKey, provider) {
	return normalizeProviderConfigWithPlugin({
		provider: resolveProviderPluginLookupKey(providerKey, provider),
		allowRuntimePluginLoad: false,
		context: {
			provider: providerKey,
			providerConfig: provider
		}
	}) ?? provider;
}
function resolveProviderConfigApiKeyPolicy(providerKey, provider) {
	const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
	return (env) => resolveProviderConfigApiKeyWithPlugin({
		provider: runtimeProviderKey,
		allowRuntimePluginLoad: false,
		context: {
			provider: providerKey,
			env
		}
	});
}
//#endregion
//#region src/agents/models-config.providers.policy.ts
function applyNativeStreamingUsageCompat(providers) {
	let changed = false;
	const nextProviders = {};
	for (const [providerKey, provider] of Object.entries(providers)) {
		const nextProvider = applyProviderNativeStreamingUsagePolicy(providerKey, provider);
		nextProviders[providerKey] = nextProvider;
		changed ||= nextProvider !== provider;
	}
	return changed ? nextProviders : providers;
}
function normalizeProviderSpecificConfig(providerKey, provider) {
	const normalized = normalizeProviderConfigPolicy(providerKey, provider);
	if (normalized && normalized !== provider) return normalized;
	return provider;
}
function resolveProviderConfigApiKeyResolver(providerKey, provider) {
	return resolveProviderConfigApiKeyPolicy(providerKey, provider);
}
//#endregion
//#region src/agents/models-config.providers.source-managed.ts
function normalizeSourceProviderLookup(providers) {
	if (!providers) return {};
	const out = {};
	for (const [key, provider] of Object.entries(providers)) {
		const normalizedKey = key.trim();
		if (!normalizedKey || !isRecord(provider)) continue;
		out[normalizedKey] = provider;
	}
	return out;
}
function resolveSourceManagedApiKeyMarker(params) {
	const sourceApiKeyRef = resolveSecretInputRef({
		value: params.sourceProvider?.apiKey,
		defaults: params.sourceSecretDefaults
	}).ref;
	if (!sourceApiKeyRef || !sourceApiKeyRef.id.trim()) return;
	return sourceApiKeyRef.source === "env" ? sourceApiKeyRef.id.trim() : resolveNonEnvSecretRefApiKeyMarker(sourceApiKeyRef.source);
}
function resolveSourceManagedHeaderMarkers(params) {
	const sourceHeaders = isRecord(params.sourceProvider?.headers) ? params.sourceProvider.headers : void 0;
	if (!sourceHeaders) return {};
	const markers = {};
	for (const [headerName, headerValue] of Object.entries(sourceHeaders)) {
		const sourceHeaderRef = resolveSecretInputRef({
			value: headerValue,
			defaults: params.sourceSecretDefaults
		}).ref;
		if (!sourceHeaderRef || !sourceHeaderRef.id.trim()) continue;
		markers[headerName] = sourceHeaderRef.source === "env" ? resolveEnvSecretRefHeaderValueMarker(sourceHeaderRef.id) : resolveNonEnvSecretRefHeaderValueMarker(sourceHeaderRef.source);
	}
	return markers;
}
function enforceSourceManagedProviderSecrets(params) {
	const { providers } = params;
	if (!providers) return providers;
	const sourceProvidersByKey = normalizeSourceProviderLookup(params.sourceProviders);
	if (Object.keys(sourceProvidersByKey).length === 0) return providers;
	let nextProviders = null;
	for (const [providerKey, provider] of Object.entries(providers)) {
		if (!isRecord(provider)) continue;
		const sourceProvider = sourceProvidersByKey[providerKey.trim()];
		if (!sourceProvider) continue;
		let nextProvider = provider;
		let providerMutated = false;
		const sourceApiKeyMarker = resolveSourceManagedApiKeyMarker({
			sourceProvider,
			sourceSecretDefaults: params.sourceSecretDefaults
		});
		if (sourceApiKeyMarker) {
			params.secretRefManagedProviders?.add(providerKey.trim());
			if (nextProvider.apiKey !== sourceApiKeyMarker) {
				providerMutated = true;
				nextProvider = {
					...nextProvider,
					apiKey: sourceApiKeyMarker
				};
			}
		}
		const sourceHeaderMarkers = resolveSourceManagedHeaderMarkers({
			sourceProvider,
			sourceSecretDefaults: params.sourceSecretDefaults
		});
		if (Object.keys(sourceHeaderMarkers).length > 0) {
			const currentHeaders = isRecord(nextProvider.headers) ? nextProvider.headers : void 0;
			const nextHeaders = { ...currentHeaders };
			let headersMutated = !currentHeaders;
			for (const [headerName, marker] of Object.entries(sourceHeaderMarkers)) {
				if (nextHeaders[headerName] === marker) continue;
				headersMutated = true;
				nextHeaders[headerName] = marker;
			}
			if (headersMutated) {
				providerMutated = true;
				nextProvider = {
					...nextProvider,
					headers: nextHeaders
				};
			}
		}
		if (!providerMutated) continue;
		if (!nextProviders) nextProviders = { ...providers };
		nextProviders[providerKey] = nextProvider;
	}
	return nextProviders ?? providers;
}
//#endregion
//#region src/agents/models-config.providers.normalize.ts
function getProviderModelId(model) {
	return typeof model.id === "string" && model.id.trim() ? model.id : void 0;
}
function mergeNormalizedProviderModel(existing, incoming) {
	return {
		...incoming,
		...existing,
		...existing.cost || incoming.cost ? { cost: {
			...incoming.cost,
			...existing.cost
		} } : void 0
	};
}
function normalizeProviderModelsForConfig(providerKey, provider) {
	if (!Array.isArray(provider.models) || provider.models.length === 0) return {
		provider,
		mutated: false
	};
	let mutated = false;
	const nextModels = [];
	const seenById = /* @__PURE__ */ new Map();
	for (const model of provider.models) {
		const rawId = getProviderModelId(model);
		const normalizedId = rawId ? normalizeConfiguredProviderCatalogModelId(providerKey, rawId) : rawId;
		const normalizedModel = normalizedId && normalizedId !== rawId ? {
			...model,
			id: normalizedId
		} : model;
		if (normalizedModel !== model) mutated = true;
		const id = getProviderModelId(normalizedModel);
		if (id) {
			const existingIndex = seenById.get(id);
			if (existingIndex !== void 0) {
				mutated = true;
				nextModels[existingIndex] = mergeNormalizedProviderModel(nextModels[existingIndex], normalizedModel);
				continue;
			}
			seenById.set(id, nextModels.length);
		}
		nextModels.push(normalizedModel);
	}
	return mutated ? {
		provider: {
			...provider,
			models: nextModels
		},
		mutated
	} : {
		provider,
		mutated
	};
}
function normalizeProviderCatalogModelsForConfig(providers) {
	if (!providers) return providers;
	let mutated = false;
	const next = {};
	for (const [providerKey, provider] of Object.entries(providers)) {
		const normalized = normalizeProviderModelsForConfig(providerKey, provider);
		if (normalized.mutated) mutated = true;
		next[providerKey] = normalized.provider;
	}
	return mutated ? next : providers;
}
function normalizeProviders(params) {
	const { providers } = params;
	if (!providers) return providers;
	const env = params.env ?? process.env;
	let authStore;
	const resolveProfileApiKey = (providerKey) => {
		authStore ??= ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
		return resolveApiKeyFromProfiles({
			provider: providerKey,
			store: authStore,
			env
		});
	};
	let mutated = false;
	const next = {};
	for (const [key, provider] of Object.entries(providers)) {
		const normalizedKey = key.trim();
		if (!normalizedKey) {
			mutated = true;
			continue;
		}
		if (normalizedKey !== key) mutated = true;
		let normalizedProvider = provider;
		const normalizedHeaders = normalizeHeaderValues({
			headers: normalizedProvider.headers,
			secretDefaults: params.secretDefaults
		});
		if (normalizedHeaders.mutated) {
			mutated = true;
			normalizedProvider = {
				...normalizedProvider,
				headers: normalizedHeaders.headers
			};
		}
		const providerWithConfiguredApiKey = normalizeConfiguredProviderApiKey({
			providerKey: normalizedKey,
			provider: normalizedProvider,
			secretDefaults: params.secretDefaults,
			profileApiKey: void 0,
			secretRefManagedProviders: params.secretRefManagedProviders
		});
		if (providerWithConfiguredApiKey !== normalizedProvider) {
			mutated = true;
			normalizedProvider = providerWithConfiguredApiKey;
		}
		const providerWithResolvedEnvApiKey = normalizeResolvedEnvApiKey({
			providerKey: normalizedKey,
			provider: normalizedProvider,
			env,
			secretRefManagedProviders: params.secretRefManagedProviders
		});
		if (providerWithResolvedEnvApiKey !== normalizedProvider) {
			mutated = true;
			normalizedProvider = providerWithResolvedEnvApiKey;
		}
		const needsProfileApiKey = Array.isArray(normalizedProvider.models) && normalizedProvider.models.length > 0 && !(typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim() || normalizedProvider.apiKey);
		const profileApiKey = needsProfileApiKey ? resolveProfileApiKey(normalizedKey) : void 0;
		const providerApiKeyResolver = needsProfileApiKey ? resolveProviderConfigApiKeyResolver(normalizedKey) : void 0;
		const providerWithApiKey = resolveMissingProviderApiKey({
			providerKey: normalizedKey,
			provider: normalizedProvider,
			env,
			profileApiKey,
			secretRefManagedProviders: params.secretRefManagedProviders,
			providerApiKeyResolver
		});
		if (providerWithApiKey !== normalizedProvider) {
			mutated = true;
			normalizedProvider = providerWithApiKey;
		}
		const providerSpecificNormalized = normalizeProviderSpecificConfig(normalizedKey, normalizedProvider);
		if (providerSpecificNormalized !== normalizedProvider) {
			mutated = true;
			normalizedProvider = providerSpecificNormalized;
		}
		const providerWithNormalizedModels = normalizeProviderModelsForConfig(normalizedKey, normalizedProvider);
		if (providerWithNormalizedModels.mutated) {
			mutated = true;
			normalizedProvider = providerWithNormalizedModels.provider;
		}
		const existing = next[normalizedKey];
		if (existing) {
			mutated = true;
			next[normalizedKey] = {
				...existing,
				...normalizedProvider,
				models: normalizedProvider.models ?? existing.models
			};
			continue;
		}
		next[normalizedKey] = normalizedProvider;
	}
	return enforceSourceManagedProviderSecrets({
		providers: mutated ? next : providers,
		sourceProviders: params.sourceProviders,
		sourceSecretDefaults: params.sourceSecretDefaults,
		secretRefManagedProviders: params.secretRefManagedProviders
	});
}
//#endregion
//#region src/agents/models-config.plan.ts
async function resolveProvidersForModelsJsonWithDeps(params, deps) {
	const { cfg, agentDir, env } = params;
	const explicitProviders = cfg.models?.providers ?? {};
	return mergeProviders({
		implicit: await (deps?.resolveImplicitProviders ?? resolveImplicitProviders)({
			agentDir,
			config: cfg,
			env,
			...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
			explicitProviders,
			...params.pluginMetadataSnapshot ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot } : {},
			...params.providerDiscoveryProviderIds ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds } : {},
			...params.providerDiscoveryTimeoutMs !== void 0 ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs } : {},
			...params.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}
		}),
		explicit: explicitProviders
	});
}
function resolveProvidersForMode(params) {
	if (params.mode !== "merge") return params.providers;
	const existing = params.existingParsed;
	if (!isRecord(existing) || !isRecord(existing.providers)) return params.providers;
	const existingProviders = existing.providers;
	return mergeWithExistingProviderSecrets({
		nextProviders: params.providers,
		existingProviders,
		secretRefManagedProviders: params.secretRefManagedProviders
	});
}
async function planOpenClawModelsJsonWithDeps(params, deps) {
	const { cfg, agentDir, env } = params;
	const providers = await resolveProvidersForModelsJsonWithDeps({
		cfg,
		agentDir,
		env,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
		...params.pluginMetadataSnapshot ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot } : {},
		...params.providerDiscoveryProviderIds ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds } : {},
		...params.providerDiscoveryTimeoutMs !== void 0 ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs } : {},
		...params.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}
	}, deps);
	if (Object.keys(providers).length === 0) return { action: "skip" };
	const mode = cfg.models?.mode ?? "merge";
	const secretRefManagedProviders = /* @__PURE__ */ new Set();
	const normalizedProviders = normalizeProviders({
		providers,
		agentDir,
		env,
		secretDefaults: cfg.secrets?.defaults,
		sourceProviders: params.sourceConfigForSecrets?.models?.providers,
		sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
		secretRefManagedProviders
	}) ?? providers;
	const mergedProviders = resolveProvidersForMode({
		mode,
		existingParsed: params.existingParsed,
		providers: normalizedProviders,
		secretRefManagedProviders
	});
	const normalizedMergedProviders = normalizeProviderCatalogModelsForConfig(mergedProviders) ?? mergedProviders;
	const finalProviders = applyNativeStreamingUsageCompat(enforceSourceManagedProviderSecrets({
		providers: normalizedMergedProviders,
		sourceProviders: params.sourceConfigForSecrets?.models?.providers,
		sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
		secretRefManagedProviders
	}) ?? normalizedMergedProviders);
	const nextContents = `${JSON.stringify({ providers: finalProviders }, null, 2)}\n`;
	if (params.existingRaw === nextContents) return { action: "noop" };
	return {
		action: "write",
		contents: nextContents
	};
}
async function planOpenClawModelsJson(params) {
	return planOpenClawModelsJsonWithDeps(params);
}
//#endregion
//#region src/agents/models-config.ts
async function readFileMtimeMs(pathname) {
	try {
		const stat = await fs.stat(pathname);
		return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
	} catch {
		return null;
	}
}
async function buildModelsJsonFingerprint(params) {
	const authProfilesMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "auth-profiles.json"));
	const modelsFileMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "models.json"));
	const envShape = createConfigRuntimeEnv(params.config, {});
	const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index) : void 0;
	return stableStringify({
		config: params.config,
		sourceConfigForSecrets: params.sourceConfigForSecrets,
		envShape,
		authProfilesMtimeMs,
		modelsFileMtimeMs,
		workspaceDir: params.workspaceDir,
		pluginMetadataSnapshotIndexFingerprint,
		providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
		providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
		providerDiscoveryEntriesOnly: params.providerDiscoveryEntriesOnly === true
	});
}
function modelsJsonReadyCacheKey(targetPath, fingerprint) {
	return `${targetPath}\0${fingerprint}`;
}
async function readExistingModelsFile(pathname) {
	try {
		const raw = await privateFileStore(path.dirname(pathname)).readTextIfExists(path.basename(pathname));
		if (raw === null) return {
			raw: "",
			parsed: null
		};
		return {
			raw,
			parsed: JSON.parse(raw)
		};
	} catch {
		return {
			raw: "",
			parsed: null
		};
	}
}
async function ensureModelsFileModeForModelsJson(pathname) {
	await fs.chmod(pathname, 384).catch(() => {});
}
async function writeModelsFileAtomicForModelsJson(targetPath, contents) {
	await privateFileStore(path.dirname(targetPath)).writeText(path.basename(targetPath), contents);
}
function resolveModelsConfigInput(config) {
	const runtimeSource = getRuntimeConfigSourceSnapshot();
	if (!config) {
		const loaded = getRuntimeConfig();
		return {
			config: runtimeSource ?? loaded,
			sourceConfigForSecrets: runtimeSource ?? loaded
		};
	}
	if (!runtimeSource) return {
		config,
		sourceConfigForSecrets: config
	};
	const projected = projectConfigOntoRuntimeSourceSnapshot(config);
	return {
		config: projected,
		sourceConfigForSecrets: projected === config ? runtimeSource : projected
	};
}
async function withModelsJsonWriteLock(targetPath, run) {
	const prior = MODELS_JSON_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
	let release = () => {};
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const pending = prior.then(() => gate);
	MODELS_JSON_STATE.writeLocks.set(targetPath, pending);
	try {
		await prior;
		return await run();
	} finally {
		release();
		if (MODELS_JSON_STATE.writeLocks.get(targetPath) === pending) MODELS_JSON_STATE.writeLocks.delete(targetPath);
	}
}
async function ensureOpenClawModelsJson(config, agentDirOverride, options = {}) {
	const resolved = resolveModelsConfigInput(config);
	const cfg = resolved.config;
	const workspaceDir = options.workspaceDir ?? (agentDirOverride?.trim() ? void 0 : resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
	const pluginMetadataSnapshot = options.pluginMetadataSnapshot ?? getCurrentPluginMetadataSnapshot({
		config: cfg,
		...workspaceDir ? { workspaceDir } : {}
	});
	const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
	const targetPath = path.join(agentDir, "models.json");
	const fingerprint = await buildModelsJsonFingerprint({
		config: cfg,
		sourceConfigForSecrets: resolved.sourceConfigForSecrets,
		agentDir,
		...workspaceDir ? { workspaceDir } : {},
		...pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {},
		...options.providerDiscoveryProviderIds ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds } : {},
		...options.providerDiscoveryTimeoutMs !== void 0 ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs } : {},
		...options.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}
	});
	const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
	const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
	if (cached) {
		const settled = await cached;
		await ensureModelsFileModeForModelsJson(targetPath);
		return settled.result;
	}
	const pending = withModelsJsonWriteLock(targetPath, async () => {
		const env = createConfigRuntimeEnv(cfg);
		const existingModelsFile = await readExistingModelsFile(targetPath);
		const plan = await planOpenClawModelsJson({
			cfg,
			sourceConfigForSecrets: resolved.sourceConfigForSecrets,
			agentDir,
			env,
			...workspaceDir ? { workspaceDir } : {},
			existingRaw: existingModelsFile.raw,
			existingParsed: existingModelsFile.parsed,
			...pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {},
			...options.providerDiscoveryProviderIds ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds } : {},
			...options.providerDiscoveryTimeoutMs !== void 0 ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs } : {},
			...options.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}
		});
		if (plan.action === "skip") return {
			fingerprint,
			result: {
				agentDir,
				wrote: false
			}
		};
		if (plan.action === "noop") {
			await ensureModelsFileModeForModelsJson(targetPath);
			return {
				fingerprint,
				result: {
					agentDir,
					wrote: false
				}
			};
		}
		await fs.mkdir(agentDir, {
			recursive: true,
			mode: 448
		});
		await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
		await ensureModelsFileModeForModelsJson(targetPath);
		return {
			fingerprint,
			result: {
				agentDir,
				wrote: true
			}
		};
	});
	MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
	try {
		const settled = await pending;
		const refreshedFingerprint = await buildModelsJsonFingerprint({
			config: cfg,
			sourceConfigForSecrets: resolved.sourceConfigForSecrets,
			agentDir,
			...workspaceDir ? { workspaceDir } : {},
			...pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {},
			...options.providerDiscoveryProviderIds ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds } : {},
			...options.providerDiscoveryTimeoutMs !== void 0 ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs } : {},
			...options.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}
		});
		const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
		if (refreshedCacheKey !== cacheKey) {
			MODELS_JSON_STATE.readyCache.delete(cacheKey);
			MODELS_JSON_STATE.readyCache.set(refreshedCacheKey, Promise.resolve({
				fingerprint: refreshedFingerprint,
				result: settled.result
			}));
		}
		return settled.result;
	} catch (error) {
		if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) MODELS_JSON_STATE.readyCache.delete(cacheKey);
		throw error;
	}
}
//#endregion
export { ensureOpenClawModelsJson as n, writeModelsFileAtomicForModelsJson as r, ensureModelsFileModeForModelsJson as t };
