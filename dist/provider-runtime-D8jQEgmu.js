import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as resolveConfigScopedRuntimeCacheValue } from "./plugin-cache-primitives-DcK62VYf.js";
import { w as resolvePluginControlPlaneFingerprint } from "./plugin-registry-CgH_ZSlH.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-DRIYGASz.js";
import { o as normalizeProviderModelIdWithManifest } from "./model-ref-shared-BkjJfDrJ.js";
import { v as resolveBundledProviderPolicySurface } from "./thinking-DNSlsULp.js";
import { l as resolveGpt5SystemPromptContribution } from "./gpt5-prompt-overlay-ijXG4a4G.js";
import { n as mergePluginTextTransforms, t as applyPluginTextReplacements } from "./plugin-text-transforms-jHXsIkoa.js";
import { c as resolveCatalogHookProviderPluginIds, f as resolveExternalAuthProfileCompatFallbackPluginIds, h as resolveOwningPluginIdsForProvider, p as resolveExternalAuthProfileProviderPluginIds } from "./plugin-auto-enable-CuCUT4Z1.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { n as resolvePluginProviders, r as resolveProviderConfigApiOwnerHint, t as isPluginProvidersLoadInFlight } from "./providers.runtime-CsXUlav0.js";
import { t as resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import { t as resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
//#region src/plugins/provider-hook-runtime.ts
const providerRuntimePluginCache = /* @__PURE__ */ new WeakMap();
const PREPARED_PROVIDER_RUNTIME_SURFACES = ["channel"];
function matchesProviderId(provider, providerId) {
	const normalized = normalizeProviderId(providerId);
	if (!normalized) return false;
	if (normalizeProviderId(provider.id) === normalized) return true;
	return [...provider.aliases ?? [], ...provider.hookAliases ?? []].some((alias) => normalizeProviderId(alias) === normalized);
}
function resolveProviderRuntimePluginCacheKey(params) {
	return JSON.stringify({
		provider: normalizeLowercaseStringOrEmpty(params.provider),
		pluginControlPlane: resolvePluginControlPlaneFingerprint({
			config: params.config,
			env: params.env,
			workspaceDir: params.workspaceDir
		}),
		plugins: params.config?.plugins,
		models: params.config?.models?.providers,
		workspaceDir: params.workspaceDir ?? "",
		applyAutoEnable: params.applyAutoEnable ?? null,
		bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? null,
		bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? null
	});
}
function matchesProviderLiteralId(provider, providerId) {
	const normalized = normalizeLowercaseStringOrEmpty(providerId);
	return !!normalized && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
}
function findProviderRuntimePluginInLoadedRegistries(params) {
	const activeRegistry = getLoadedRuntimePluginRegistry({
		env: params.lookup.env,
		workspaceDir: params.lookup.workspaceDir
	});
	const activePlugin = activeRegistry ? findProviderRuntimePluginInRegistry({
		registry: activeRegistry,
		provider: params.lookup.provider,
		apiOwnerHint: params.apiOwnerHint
	}) : void 0;
	if (activePlugin) return activePlugin;
	for (const surface of PREPARED_PROVIDER_RUNTIME_SURFACES) {
		const registry = getLoadedRuntimePluginRegistry({
			env: params.lookup.env,
			workspaceDir: params.lookup.workspaceDir,
			surface
		});
		const plugin = registry ? findProviderRuntimePluginInRegistry({
			registry,
			provider: params.lookup.provider,
			apiOwnerHint: params.apiOwnerHint
		}) : void 0;
		if (plugin) return plugin;
	}
}
function findProviderRuntimePluginInRegistry(params) {
	return params.registry.providers.map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId })).find((plugin) => {
		if (params.apiOwnerHint) return matchesProviderLiteralId(plugin, params.provider) || matchesProviderId(plugin, params.apiOwnerHint);
		return matchesProviderId(plugin, params.provider);
	});
}
function resolveProviderPluginsForHooks(params) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	if (isPluginProvidersLoadInFlight({
		...params,
		workspaceDir,
		env,
		activate: false,
		applyAutoEnable: params.applyAutoEnable,
		bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
		bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true
	})) return [];
	return resolvePluginProviders({
		...params,
		workspaceDir,
		env,
		activate: false,
		applyAutoEnable: params.applyAutoEnable,
		bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat ?? true,
		bundledProviderVitestCompat: params.bundledProviderVitestCompat ?? true
	});
}
function resolveProviderRuntimePlugin(params) {
	const apiOwnerHint = resolveProviderConfigApiOwnerHint({
		provider: params.provider,
		config: params.config
	});
	const loadedPlugin = findProviderRuntimePluginInLoadedRegistries({
		lookup: params,
		apiOwnerHint
	});
	if (loadedPlugin) return loadedPlugin;
	return resolveConfigScopedRuntimeCacheValue({
		cache: providerRuntimePluginCache,
		config: params.env && params.env !== process.env ? void 0 : params.config,
		key: resolveProviderRuntimePluginCacheKey(params),
		load: () => {
			return resolveProviderPluginsForHooks({
				config: params.config,
				workspaceDir: params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState(),
				env: params.env,
				providerRefs: apiOwnerHint ? [params.provider, apiOwnerHint] : [params.provider],
				applyAutoEnable: params.applyAutoEnable,
				bundledProviderAllowlistCompat: params.bundledProviderAllowlistCompat,
				bundledProviderVitestCompat: params.bundledProviderVitestCompat
			}).find((plugin) => {
				if (apiOwnerHint) return matchesProviderLiteralId(plugin, params.provider) || matchesProviderId(plugin, apiOwnerHint);
				return matchesProviderId(plugin, params.provider);
			}) ?? null;
		}
	}) ?? void 0;
}
function resolveLoadedProviderRuntimePlugin(params) {
	return findProviderRuntimePluginInLoadedRegistries({
		lookup: params,
		apiOwnerHint: resolveProviderConfigApiOwnerHint({
			provider: params.provider,
			config: params.config
		})
	});
}
function resolveProviderHookPlugin(params) {
	return resolveProviderRuntimePlugin(params) ?? resolveProviderPluginsForHooks({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).find((candidate) => matchesProviderId(candidate, params.provider));
}
function resolveProviderRuntimePluginHandle(params) {
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const env = params.env;
	const runtimePlugin = resolveProviderRuntimePlugin({
		...params,
		workspaceDir,
		env
	});
	return {
		...params,
		workspaceDir,
		env,
		plugin: runtimePlugin
	};
}
function ensureProviderRuntimePluginHandle(params) {
	return params.runtimeHandle ?? resolveProviderRuntimePluginHandle(params);
}
function prepareProviderExtraParams(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.prepareExtraParams?.(params.context) ?? void 0;
}
function resolveProviderExtraParamsForTransport(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.extraParamsForTransport?.(params.context) ?? void 0;
}
function resolveProviderAuthProfileId(params) {
	const resolved = ensureProviderRuntimePluginHandle(params).plugin?.resolveAuthProfileId?.(params.context);
	return typeof resolved === "string" && resolved.trim() ? resolved.trim() : void 0;
}
function resolveProviderFollowupFallbackRoute(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.followupFallbackRoute?.(params.context) ?? void 0;
}
function wrapProviderStreamFn(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.wrapStreamFn?.(params.context) ?? void 0;
}
//#endregion
//#region src/plugins/provider-runtime.ts
const log = createSubsystemLogger("plugins/provider-runtime");
const warnedExternalAuthFallbackPluginIds = /* @__PURE__ */ new Set();
function matchesProviderPluginRef(provider, providerId) {
	const normalized = normalizeProviderId(providerId);
	if (!normalized) return false;
	if (normalizeProviderId(provider.id) === normalized) return true;
	return [...provider.aliases ?? [], ...provider.hookAliases ?? []].some((alias) => normalizeProviderId(alias) === normalized);
}
function resolveProviderHookRefs(provider, providerConfig, modelApi) {
	const refs = [provider];
	const apiRef = normalizeOptionalString(modelApi ?? providerConfig?.api);
	if (apiRef && normalizeProviderId(apiRef) !== normalizeProviderId(provider)) refs.push(apiRef);
	return [...new Set(refs)];
}
function matchesAnyProviderPluginRef(provider, providerRefs) {
	return providerRefs.some((providerRef) => matchesProviderPluginRef(provider, providerRef));
}
function hasExplicitProviderRuntimePluginActivation(params) {
	if (!params.config) return true;
	const ownerPluginIds = resolveOwningPluginIdsForProvider({
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) ?? [];
	if (ownerPluginIds.length === 0) return false;
	const allow = new Set(params.config.plugins?.allow ?? []);
	const entries = params.config.plugins?.entries ?? {};
	return ownerPluginIds.some((pluginId) => allow.has(pluginId) || entries[pluginId] !== void 0);
}
function resetExternalAuthFallbackWarningCacheForTest() {
	warnedExternalAuthFallbackPluginIds.clear();
}
const testing = { resetExternalAuthFallbackWarningCacheForTest };
function resolveProviderPluginsForCatalogHooks(params) {
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const env = params.env ?? process.env;
	const onlyPluginIds = resolveCatalogHookProviderPluginIds({
		config: params.config,
		workspaceDir,
		env
	});
	if (onlyPluginIds.length === 0) return [];
	return resolveProviderPluginsForHooks({
		...params,
		workspaceDir,
		env,
		onlyPluginIds
	});
}
function runProviderDynamicModel(params) {
	return resolveProviderRuntimePlugin(params)?.resolveDynamicModel?.(params.context) ?? void 0;
}
function resolveProviderSystemPromptContribution(params) {
	const plugin = ensureProviderRuntimePluginHandle(params).plugin;
	const baseOverlay = resolveGpt5SystemPromptContribution({
		config: params.context.config ?? params.config,
		providerId: params.context.provider ?? params.provider,
		modelId: params.context.modelId,
		trigger: params.context.trigger
	});
	return mergeProviderSystemPromptContributions(mergeProviderSystemPromptContributions(baseOverlay, plugin?.resolvePromptOverlay?.({
		...params.context,
		baseOverlay
	}) ?? void 0), plugin?.resolveSystemPromptContribution?.(params.context) ?? void 0);
}
function mergeProviderSystemPromptContributions(base, override) {
	if (!base) return override;
	if (!override) return base;
	const stablePrefix = mergeUniquePromptSections(base.stablePrefix, override.stablePrefix);
	const dynamicSuffix = mergeUniquePromptSections(base.dynamicSuffix, override.dynamicSuffix);
	return {
		...stablePrefix ? { stablePrefix } : {},
		...dynamicSuffix ? { dynamicSuffix } : {},
		sectionOverrides: {
			...base.sectionOverrides,
			...override.sectionOverrides
		}
	};
}
function mergeUniquePromptSections(...sections) {
	const uniqueSections = [...new Set(sections.filter((section) => section?.trim()))];
	return uniqueSections.length > 0 ? uniqueSections.join("\n\n") : void 0;
}
function transformProviderSystemPrompt(params) {
	const plugin = ensureProviderRuntimePluginHandle(params).plugin;
	const textTransforms = mergePluginTextTransforms(resolveRuntimeTextTransforms(), plugin?.textTransforms);
	return applyPluginTextReplacements(plugin?.transformSystemPrompt?.(params.context) ?? params.context.systemPrompt, textTransforms?.input);
}
function resolveProviderTextTransforms(params) {
	return mergePluginTextTransforms(resolveRuntimeTextTransforms(), ensureProviderRuntimePluginHandle(params).plugin?.textTransforms);
}
async function prepareProviderDynamicModel(params) {
	await resolveProviderRuntimePlugin(params)?.prepareDynamicModel?.(params.context);
}
function shouldPreferProviderRuntimeResolvedModel(params) {
	return resolveProviderRuntimePlugin(params)?.preferRuntimeResolvedModel?.(params.context) ?? false;
}
function normalizeProviderResolvedModelWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.normalizeResolvedModel?.(params.context) ?? void 0;
}
function resolveProviderCompatHookPlugins(params) {
	const candidates = resolveProviderPluginsForHooks(params);
	const owner = resolveProviderRuntimePlugin(params);
	if (!owner) return candidates;
	const ordered = [owner, ...candidates];
	const seen = /* @__PURE__ */ new Set();
	return ordered.filter((candidate) => {
		const key = `${candidate.pluginId ?? ""}:${candidate.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function applyCompatPatchToModel(model, patch) {
	const compat = model.compat && typeof model.compat === "object" ? model.compat : void 0;
	if (Object.entries(patch).every(([key, value]) => compat?.[key] === value)) return model;
	return {
		...model,
		compat: {
			...compat,
			...patch
		}
	};
}
function applyProviderResolvedModelCompatWithPlugins(params) {
	let nextModel = params.context.model;
	let changed = false;
	for (const plugin of resolveProviderCompatHookPlugins(params)) {
		const patch = plugin.contributeResolvedModelCompat?.({
			...params.context,
			model: nextModel
		});
		if (!patch || typeof patch !== "object") continue;
		const patchedModel = applyCompatPatchToModel(nextModel, patch);
		if (patchedModel === nextModel) continue;
		nextModel = patchedModel;
		changed = true;
	}
	return changed ? nextModel : void 0;
}
function applyProviderResolvedTransportWithPlugin(params) {
	const normalized = normalizeProviderTransportWithPlugin({
		provider: params.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		context: {
			provider: params.context.provider,
			api: params.context.model.api,
			baseUrl: params.context.model.baseUrl
		}
	});
	if (!normalized) return;
	const nextApi = normalized.api ?? params.context.model.api;
	const nextBaseUrl = normalized.baseUrl ?? params.context.model.baseUrl;
	if (nextApi === params.context.model.api && nextBaseUrl === params.context.model.baseUrl) return;
	return {
		...params.context.model,
		api: nextApi,
		baseUrl: nextBaseUrl
	};
}
function normalizeProviderModelIdWithPlugin(params) {
	return normalizeOptionalString(resolveProviderHookPlugin(params)?.normalizeModelId?.(params.context)) ?? normalizeProviderModelIdWithManifest(params);
}
function normalizeProviderTransportWithPlugin(params) {
	const hasTransportChange = (normalized) => (normalized.api ?? params.context.api) !== params.context.api || (normalized.baseUrl ?? params.context.baseUrl) !== params.context.baseUrl;
	const matchedPlugin = resolveProviderHookPlugin(params);
	const normalizedMatched = matchedPlugin?.normalizeTransport?.(params.context);
	if (normalizedMatched && hasTransportChange(normalizedMatched)) return normalizedMatched;
	for (const candidate of resolveProviderPluginsForHooks(params)) {
		if (!candidate.normalizeTransport || candidate === matchedPlugin) continue;
		const normalized = candidate.normalizeTransport(params.context);
		if (normalized && hasTransportChange(normalized)) return normalized;
	}
}
function normalizeProviderConfigWithPlugin(params) {
	const hasConfigChange = (normalized) => normalized !== params.context.providerConfig;
	const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
	if (bundledSurface?.normalizeConfig) {
		const normalized = bundledSurface.normalizeConfig(params.context);
		return normalized && hasConfigChange(normalized) ? normalized : void 0;
	}
	if (!hasExplicitProviderRuntimePluginActivation(params)) return;
	if (params.allowRuntimePluginLoad === false) return;
	const normalizedMatched = resolveProviderRuntimePlugin(params)?.normalizeConfig?.(params.context);
	return normalizedMatched && hasConfigChange(normalizedMatched) ? normalizedMatched : void 0;
}
function applyProviderNativeStreamingUsageCompatWithPlugin(params) {
	if (params.allowRuntimePluginLoad === false) return;
	return resolveProviderRuntimePlugin(params)?.applyNativeStreamingUsageCompat?.(params.context) ?? void 0;
}
function resolveProviderConfigApiKeyWithPlugin(params) {
	const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
	if (bundledSurface?.resolveConfigApiKey) return normalizeOptionalString(bundledSurface.resolveConfigApiKey(params.context));
	if (params.allowRuntimePluginLoad === false) return;
	return normalizeOptionalString(resolveProviderRuntimePlugin(params)?.resolveConfigApiKey?.(params.context));
}
function resolveProviderReplayPolicyWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.buildReplayPolicy?.(params.context) ?? void 0;
}
async function sanitizeProviderReplayHistoryWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.sanitizeReplayHistory?.(params.context);
}
async function validateProviderReplayTurnsWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.validateReplayTurns?.(params.context);
}
function normalizeProviderToolSchemasWithPlugin(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.normalizeToolSchemas?.(params.context) ?? void 0;
}
function inspectProviderToolSchemasWithPlugin(params) {
	return ensureProviderRuntimePluginHandle(params).plugin?.inspectToolSchemas?.(params.context) ?? void 0;
}
function resolveProviderReasoningOutputModeWithPlugin(params) {
	const mode = resolveProviderRuntimePlugin(params)?.resolveReasoningOutputMode?.(params.context);
	return mode === "native" || mode === "tagged" ? mode : void 0;
}
function resolveProviderStreamFn(params) {
	return (params.allowRuntimePluginLoad === false ? resolveLoadedProviderRuntimePlugin(params) : resolveProviderRuntimePlugin(params))?.createStreamFn?.(params.context) ?? void 0;
}
function resolveProviderTransportTurnStateWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.resolveTransportTurnState?.(params.context) ?? void 0;
}
function resolveProviderWebSocketSessionPolicyWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.resolveWebSocketSessionPolicy?.(params.context) ?? void 0;
}
async function createProviderEmbeddingProvider(params) {
	return await resolveProviderRuntimePlugin(params)?.createEmbeddingProvider?.(params.context);
}
async function prepareProviderRuntimeAuth(params) {
	return await resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth?.(params.context);
}
async function resolveProviderUsageAuthWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.resolveUsageAuth?.(params.context);
}
async function resolveProviderUsageSnapshotWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.fetchUsageSnapshot?.(params.context);
}
function matchesProviderContextOverflowWithPlugin(params) {
	const plugins = params.provider ? [resolveProviderHookPlugin({
		...params,
		provider: params.provider
	})].filter((plugin) => Boolean(plugin)) : resolveProviderPluginsForHooks(params);
	for (const plugin of plugins) if (plugin.matchesContextOverflowError?.(params.context)) return true;
	return false;
}
function classifyProviderFailoverReasonWithPlugin(params) {
	const plugins = params.provider ? [resolveProviderHookPlugin({
		...params,
		provider: params.provider
	})].filter((plugin) => Boolean(plugin)) : resolveProviderPluginsForHooks(params);
	for (const plugin of plugins) {
		const reason = plugin.classifyFailoverReason?.(params.context);
		if (reason) return reason;
	}
}
function formatProviderAuthProfileApiKeyWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.formatApiKey?.(params.context);
}
async function refreshProviderOAuthCredentialWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.refreshOAuth?.(params.context);
}
async function buildProviderAuthDoctorHintWithPlugin(params) {
	return await resolveProviderRuntimePlugin(params)?.buildAuthDoctorHint?.(params.context);
}
function resolveProviderCacheTtlEligibility(params) {
	return resolveProviderRuntimePlugin(params)?.isCacheTtlEligible?.(params.context);
}
function resolveProviderBinaryThinking(params) {
	return resolveProviderRuntimePlugin(params)?.isBinaryThinking?.(params.context);
}
function resolveProviderXHighThinking(params) {
	return resolveProviderRuntimePlugin(params)?.supportsXHighThinking?.(params.context);
}
function resolveProviderThinkingProfile(params) {
	const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
	if (bundledSurface?.resolveThinkingProfile) return bundledSurface.resolveThinkingProfile(params.context) ?? void 0;
	return resolveProviderRuntimePlugin(params)?.resolveThinkingProfile?.(params.context);
}
function resolveProviderDefaultThinkingLevel(params) {
	return resolveProviderRuntimePlugin(params)?.resolveDefaultThinkingLevel?.(params.context);
}
function applyProviderConfigDefaultsWithPlugin(params) {
	const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
	if (bundledSurface?.applyConfigDefaults) return bundledSurface.applyConfigDefaults(params.context) ?? void 0;
	return resolveProviderRuntimePlugin(params)?.applyConfigDefaults?.(params.context) ?? void 0;
}
function resolveProviderModernModelRef(params) {
	return resolveProviderRuntimePlugin(params)?.isModernModelRef?.(params.context);
}
function buildProviderMissingAuthMessageWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.buildMissingAuthMessage?.(params.context) ?? void 0;
}
function buildProviderUnknownModelHintWithPlugin(params) {
	return resolveProviderRuntimePlugin(params)?.buildUnknownModelHint?.(params.context) ?? void 0;
}
function resolveProviderSyntheticAuthWithPlugin(params) {
	const providerRefs = resolveProviderHookRefs(params.provider, params.context.providerConfig, params.modelApi);
	const discoveryPluginIds = [...new Set(providerRefs.flatMap((provider) => resolveOwningPluginIdsForProvider({
		provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) ?? []))];
	const discoveryProvider = (discoveryPluginIds.length > 0 ? resolvePluginDiscoveryProvidersRuntime({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		onlyPluginIds: discoveryPluginIds,
		discoveryEntriesOnly: true
	}) : []).find((provider) => matchesAnyProviderPluginRef(provider, providerRefs));
	if (typeof discoveryProvider?.resolveSyntheticAuth === "function") return discoveryProvider.resolveSyntheticAuth(params.context) ?? void 0;
	const runtimeResolved = resolveProviderRuntimePlugin({
		...params,
		applyAutoEnable: false,
		bundledProviderAllowlistCompat: false,
		bundledProviderVitestCompat: false
	})?.resolveSyntheticAuth?.(params.context);
	if (runtimeResolved) return runtimeResolved;
	for (const providerRef of providerRefs) {
		if (normalizeProviderId(providerRef) === normalizeProviderId(params.provider)) continue;
		const runtimeProviderResolved = resolveProviderRuntimePlugin({
			...params,
			provider: providerRef,
			applyAutoEnable: false,
			bundledProviderAllowlistCompat: false,
			bundledProviderVitestCompat: false
		})?.resolveSyntheticAuth?.(params.context);
		if (runtimeProviderResolved) return runtimeProviderResolved;
	}
	if (providerRefs.length === 1) return resolvePluginDiscoveryProvidersRuntime({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).find((provider) => matchesAnyProviderPluginRef(provider, providerRefs))?.resolveSyntheticAuth?.(params.context);
}
function resolveExternalAuthProfilesWithPlugins(params) {
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const env = params.env ?? process.env;
	const externalAuthPluginIds = resolveExternalAuthProfileProviderPluginIds({
		config: params.config,
		workspaceDir,
		env
	});
	const declaredPluginIds = new Set(externalAuthPluginIds);
	const fallbackPluginIds = resolveExternalAuthProfileCompatFallbackPluginIds({
		config: params.config,
		workspaceDir,
		env,
		declaredPluginIds
	});
	const pluginIds = [...new Set([...externalAuthPluginIds, ...fallbackPluginIds])].toSorted((left, right) => left.localeCompare(right));
	if (pluginIds.length === 0) return [];
	const matches = [];
	for (const plugin of resolveProviderPluginsForHooks({
		...params,
		workspaceDir,
		env,
		onlyPluginIds: pluginIds
	})) {
		const profiles = plugin.resolveExternalAuthProfiles?.(params.context) ?? plugin.resolveExternalOAuthProfiles?.(params.context);
		if (!profiles || profiles.length === 0) continue;
		const pluginId = plugin.pluginId ?? plugin.id;
		if (!declaredPluginIds.has(pluginId) && !warnedExternalAuthFallbackPluginIds.has(pluginId)) {
			warnedExternalAuthFallbackPluginIds.add(pluginId);
			log.warn(`Provider plugin "${sanitizeForLog(pluginId)}" uses external auth hooks without declaring contracts.externalAuthProviders. This compatibility fallback is deprecated and will be removed in a future release.`);
		}
		matches.push(...profiles);
	}
	return matches;
}
function resolveExternalOAuthProfilesWithPlugins(params) {
	return resolveExternalAuthProfilesWithPlugins(params);
}
function shouldDeferProviderSyntheticProfileAuthWithPlugin(params) {
	const providerRefs = resolveProviderHookRefs(params.provider, params.context.providerConfig, params.modelApi);
	for (const providerRef of providerRefs) {
		const resolved = resolveProviderRuntimePlugin({
			...params,
			provider: providerRef
		})?.shouldDeferSyntheticProfileAuth?.(params.context);
		if (resolved !== void 0) return resolved;
	}
}
async function augmentModelCatalogWithProviderPlugins(params) {
	const supplemental = [];
	for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
		const next = await plugin.augmentModelCatalog?.(params.context);
		if (!next || next.length === 0) continue;
		supplemental.push(...next);
	}
	return supplemental;
}
//#endregion
export { resolveProviderRuntimePluginHandle as $, resolveProviderReplayPolicyWithPlugin as A, resolveProviderXHighThinking as B, resolveExternalOAuthProfilesWithPlugins as C, resolveProviderDefaultThinkingLevel as D, resolveProviderConfigApiKeyWithPlugin as E, resolveProviderThinkingProfile as F, testing as G, sanitizeProviderReplayHistoryWithPlugin as H, resolveProviderTransportTurnStateWithPlugin as I, prepareProviderExtraParams as J, transformProviderSystemPrompt as K, resolveProviderUsageAuthWithPlugin as L, resolveProviderSyntheticAuthWithPlugin as M, resolveProviderSystemPromptContribution as N, resolveProviderModernModelRef as O, resolveProviderTextTransforms as P, resolveProviderRuntimePlugin as Q, resolveProviderUsageSnapshotWithPlugin as R, resolveExternalAuthProfilesWithPlugins as S, resolveProviderCacheTtlEligibility as T, shouldDeferProviderSyntheticProfileAuthWithPlugin as U, runProviderDynamicModel as V, shouldPreferProviderRuntimeResolvedModel as W, resolveProviderExtraParamsForTransport as X, resolveProviderAuthProfileId as Y, resolveProviderFollowupFallbackRoute as Z, normalizeProviderToolSchemasWithPlugin as _, augmentModelCatalogWithProviderPlugins as a, prepareProviderRuntimeAuth as b, buildProviderUnknownModelHintWithPlugin as c, formatProviderAuthProfileApiKeyWithPlugin as d, wrapProviderStreamFn as et, inspectProviderToolSchemasWithPlugin as f, normalizeProviderResolvedModelWithPlugin as g, normalizeProviderModelIdWithPlugin as h, applyProviderResolvedTransportWithPlugin as i, resolveProviderStreamFn as j, resolveProviderReasoningOutputModeWithPlugin as k, classifyProviderFailoverReasonWithPlugin as l, normalizeProviderConfigWithPlugin as m, applyProviderNativeStreamingUsageCompatWithPlugin as n, buildProviderAuthDoctorHintWithPlugin as o, matchesProviderContextOverflowWithPlugin as p, validateProviderReplayTurnsWithPlugin as q, applyProviderResolvedModelCompatWithPlugins as r, buildProviderMissingAuthMessageWithPlugin as s, applyProviderConfigDefaultsWithPlugin as t, createProviderEmbeddingProvider as u, normalizeProviderTransportWithPlugin as v, resolveProviderBinaryThinking as w, refreshProviderOAuthCredentialWithPlugin as x, prepareProviderDynamicModel as y, resolveProviderWebSocketSessionPolicyWithPlugin as z };
