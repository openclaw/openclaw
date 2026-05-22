import { r as normalizeProviderId } from "./provider-id-BvxMxU5i.js";
import { g as isPluginEnabledByDefaultForPlatform } from "./installed-plugin-index-store-DKRZAyz8.js";
import { l as resolveEffectivePluginActivationState } from "./config-state-CRUVAZgB.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-BrjVmoiX.js";
import { c as resolveProviderOwners, p as loadPluginRegistrySnapshot, r as normalizePluginsConfigWithRegistry, s as resolvePluginContributionOwners } from "./plugin-registry-BHJdb5-l.js";
import { r as withBundledPluginVitestCompat } from "./bundled-compat-DzTjSvv0.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-BKcLHPQP.js";
import { b as passesManifestOwnerBasePolicy, v as isActivatedManifestOwner } from "./bundled-ClEUgb-c.js";
import { r as createPluginIdScopeSet } from "./package-state-probes-DGLjIrlX.js";
//#region src/plugins/providers.ts
function loadProviderRegistrySnapshot(params) {
	if (params.registry) return params.registry;
	return loadPluginRegistrySnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
}
function loadScopedProviderRegistry(params) {
	return {
		registry: loadProviderRegistrySnapshot(params),
		onlyPluginIdSet: createPluginIdScopeSet(params.onlyPluginIds)
	};
}
function listRegistryPluginIds(registry, predicate) {
	return registry.plugins.filter(predicate).map((plugin) => plugin.pluginId).toSorted((left, right) => left.localeCompare(right));
}
function resolveProviderSurfacePluginIdSet(params) {
	return new Set(resolveManifestRegistry({
		...params,
		includeDisabled: true
	}).plugins.flatMap((plugin) => plugin.providers.length > 0 ? [plugin.id] : []));
}
function resolveProviderOwnerPluginIds(params) {
	if (params.pluginIds.length === 0) return [];
	const pluginIdSet = new Set(params.pluginIds);
	const registry = loadProviderRegistrySnapshot(params);
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
	return listRegistryPluginIds(registry, (plugin) => pluginIdSet.has(plugin.pluginId) && params.isEligible(plugin, normalizedConfig));
}
function resolveEffectiveRegistryPluginActivation(params) {
	return resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.normalizedConfig,
		rootConfig: params.rootConfig,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin)
	});
}
function toManifestOwnerRecord(plugin) {
	return {
		id: plugin.pluginId,
		origin: plugin.origin,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin)
	};
}
function withBundledProviderVitestCompat(params) {
	return withBundledPluginVitestCompat(params);
}
function resolveBundledProviderCompatPluginIds(params) {
	if (params.manifestRegistry) {
		const onlyPluginIdSet = createPluginIdScopeSet(params.onlyPluginIds);
		return params.manifestRegistry.plugins.filter((plugin) => plugin.origin === "bundled" && plugin.providers.length > 0 && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
	}
	const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
	const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({
		...params,
		registry
	});
	return listRegistryPluginIds(registry, (plugin) => plugin.origin === "bundled" && providerSurfacePluginIds.has(plugin.pluginId) && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)));
}
function resolveEnabledProviderPluginIds(params) {
	const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
	const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({
		...params,
		registry
	});
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
	return listRegistryPluginIds(registry, (plugin) => providerSurfacePluginIds.has(plugin.pluginId) && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)) && resolveEffectiveRegistryPluginActivation({
		plugin,
		normalizedConfig,
		rootConfig: params.config
	}).activated);
}
function resolveExternalAuthProfileProviderPluginIds(params) {
	return resolveRegistryManifestContractPluginIds({
		...params,
		contract: "externalAuthProviders"
	});
}
function resolveRegistryManifestContractPluginIds(params) {
	const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
	return resolveManifestRegistry({
		...params,
		registry,
		includeDisabled: true
	}).plugins.filter((plugin) => {
		if (params.origin && plugin.origin !== params.origin) return false;
		if (onlyPluginIdSet && !onlyPluginIdSet.has(plugin.id)) return false;
		return (plugin.contracts?.[params.contract] ?? []).length > 0;
	}).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveExternalAuthProfileCompatFallbackPluginIds(params) {
	const declaredPluginIds = params.declaredPluginIds ?? new Set(resolveExternalAuthProfileProviderPluginIds(params));
	const registry = loadProviderRegistrySnapshot(params);
	const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({
		...params,
		registry
	});
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
	return listRegistryPluginIds(registry, (plugin) => plugin.origin !== "bundled" && providerSurfacePluginIds.has(plugin.pluginId) && !declaredPluginIds.has(plugin.pluginId) && isProviderPluginEligibleForRuntimeOwnerActivation({
		plugin,
		normalizedConfig,
		rootConfig: params.config
	}));
}
function resolveDiscoveredProviderPluginIds(params) {
	const { registry, onlyPluginIdSet } = loadScopedProviderRegistry(params);
	const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({
		...params,
		registry
	});
	const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
	const shouldFilterBundledByAllowlist = params.config?.plugins?.bundledDiscovery !== "compat";
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
	return listRegistryPluginIds(registry, (plugin) => {
		if (!(providerSurfacePluginIds.has(plugin.pluginId) && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.pluginId)))) return false;
		return isProviderPluginEligibleForSetupDiscovery({
			plugin,
			shouldFilterUntrustedWorkspacePlugins,
			shouldFilterBundledByAllowlist,
			normalizedConfig,
			rootConfig: params.config
		});
	});
}
function isProviderPluginEligibleForSetupDiscovery(params) {
	if (params.plugin.origin === "workspace") {
		if (!params.shouldFilterUntrustedWorkspacePlugins) return true;
	} else if (!params.shouldFilterBundledByAllowlist) return true;
	if (!passesManifestOwnerBasePolicy({
		plugin: toManifestOwnerRecord(params.plugin),
		normalizedConfig: params.normalizedConfig
	})) return false;
	if (params.plugin.origin === "bundled") return true;
	return isActivatedManifestOwner({
		plugin: toManifestOwnerRecord(params.plugin),
		normalizedConfig: params.normalizedConfig,
		rootConfig: params.rootConfig
	});
}
function resolveDiscoverableProviderOwnerPluginIds(params) {
	const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins === false;
	const shouldFilterBundledByAllowlist = params.config?.plugins?.bundledDiscovery !== "compat";
	return resolveProviderOwnerPluginIds({
		...params,
		isEligible: (plugin, normalizedConfig) => isProviderPluginEligibleForSetupDiscovery({
			plugin,
			shouldFilterUntrustedWorkspacePlugins,
			shouldFilterBundledByAllowlist,
			normalizedConfig,
			rootConfig: params.config
		})
	});
}
function isProviderPluginEligibleForRuntimeOwnerActivation(params) {
	if (!passesManifestOwnerBasePolicy({
		plugin: toManifestOwnerRecord(params.plugin),
		normalizedConfig: params.normalizedConfig
	})) return false;
	if (params.plugin.origin !== "workspace") return true;
	return isActivatedManifestOwner({
		plugin: toManifestOwnerRecord(params.plugin),
		normalizedConfig: params.normalizedConfig,
		rootConfig: params.rootConfig
	});
}
function resolveActivatableProviderOwnerPluginIds(params) {
	return resolveProviderOwnerPluginIds({
		...params,
		isEligible: (plugin, normalizedConfig) => isProviderPluginEligibleForRuntimeOwnerActivation({
			plugin,
			normalizedConfig,
			rootConfig: params.config
		})
	});
}
function resolveManifestRegistry(params) {
	if (params.manifestRegistry) return params.manifestRegistry;
	return loadPluginManifestRegistryForInstalledIndex({
		index: params.registry ?? loadProviderRegistrySnapshot(params),
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeDisabled: params.includeDisabled
	});
}
function stripModelProfileSuffix(value) {
	return splitTrailingAuthProfile(value).model;
}
function splitExplicitModelRef(rawModel) {
	const trimmed = rawModel.trim();
	if (!trimmed) return null;
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		const modelId = stripModelProfileSuffix(trimmed);
		return modelId ? { modelId } : null;
	}
	const provider = normalizeProviderId(trimmed.slice(0, slash));
	const modelId = stripModelProfileSuffix(trimmed.slice(slash + 1));
	if (!provider || !modelId) return null;
	return {
		provider,
		modelId
	};
}
function resolveModelSupportMatchKind(plugin, modelId) {
	const patterns = plugin.modelSupport?.modelPatterns ?? [];
	for (const patternSource of patterns) try {
		if (new RegExp(patternSource, "u").test(modelId)) return "pattern";
	} catch {
		continue;
	}
	const prefixes = plugin.modelSupport?.modelPrefixes ?? [];
	for (const prefix of prefixes) if (modelId.startsWith(prefix)) return "prefix";
}
function dedupeSortedPluginIds(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function resolvePreferredManifestPluginIds(registry, matchedPluginIds) {
	if (matchedPluginIds.length === 0) return;
	const uniquePluginIds = dedupeSortedPluginIds(matchedPluginIds);
	if (uniquePluginIds.length <= 1) return uniquePluginIds;
	const nonBundledPluginIds = uniquePluginIds.filter((pluginId) => {
		return registry.plugins.find((entry) => entry.id === pluginId)?.origin !== "bundled";
	});
	if (nonBundledPluginIds.length === 1) return nonBundledPluginIds;
	if (nonBundledPluginIds.length > 1) return;
}
function resolveOwningPluginIdsForProvider(params) {
	const normalizedProvider = normalizeProviderId(params.provider);
	if (!normalizedProvider) return;
	if (params.manifestRegistry) {
		const pluginIds = params.manifestRegistry.plugins.filter((plugin) => plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider) || plugin.cliBackends.some((backendId) => normalizeProviderId(backendId) === normalizedProvider)).map((plugin) => plugin.id);
		return pluginIds.length > 0 ? pluginIds : void 0;
	}
	const env = params.env ?? process.env;
	const deduped = dedupeSortedPluginIds([...resolveProviderOwners({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env,
		providerId: normalizedProvider,
		includeDisabled: true
	}), ...resolvePluginContributionOwners({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env,
		contribution: "cliBackends",
		matches: (backendId) => normalizeProviderId(backendId) === normalizedProvider,
		includeDisabled: true
	})]);
	return deduped.length > 0 ? deduped : void 0;
}
function resolveOwningPluginIdsForModelRef(params) {
	const parsed = splitExplicitModelRef(params.model);
	if (!parsed) return;
	if (parsed.provider) return resolveOwningPluginIdsForProvider({
		provider: parsed.provider,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		manifestRegistry: params.manifestRegistry
	});
	const manifestRegistry = resolveManifestRegistry({
		...params,
		includeDisabled: true
	});
	const preferredPatternPluginIds = resolvePreferredManifestPluginIds(manifestRegistry, manifestRegistry.plugins.filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "pattern").map((plugin) => plugin.id));
	if (preferredPatternPluginIds) return preferredPatternPluginIds;
	return resolvePreferredManifestPluginIds(manifestRegistry, manifestRegistry.plugins.filter((plugin) => resolveModelSupportMatchKind(plugin, parsed.modelId) === "prefix").map((plugin) => plugin.id));
}
function resolveOwningPluginIdsForModelRefs(params) {
	const registry = params.manifestRegistry ? void 0 : loadProviderRegistrySnapshot(params);
	const manifestRegistry = params.manifestRegistry;
	return dedupeSortedPluginIds(params.models.flatMap((model) => resolveOwningPluginIdsForModelRef({
		model,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		...manifestRegistry ? { manifestRegistry } : {},
		...registry ? { registry } : {}
	}) ?? []));
}
function resolveCatalogHookProviderPluginIds(params) {
	const registry = loadProviderRegistrySnapshot(params);
	const providerSurfacePluginIds = resolveProviderSurfacePluginIdSet({
		...params,
		registry
	});
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry);
	const enabledProviderPluginIds = listRegistryPluginIds(registry, (plugin) => providerSurfacePluginIds.has(plugin.pluginId) && resolveEffectiveRegistryPluginActivation({
		plugin,
		normalizedConfig,
		rootConfig: params.config
	}).activated);
	const bundledCompatPluginIds = resolveBundledProviderCompatPluginIds(params);
	return [...new Set([...enabledProviderPluginIds, ...bundledCompatPluginIds])].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
export { resolveDiscoveredProviderPluginIds as a, resolveExternalAuthProfileProviderPluginIds as c, resolveOwningPluginIdsForProvider as d, withBundledProviderVitestCompat as f, resolveDiscoverableProviderOwnerPluginIds as i, resolveOwningPluginIdsForModelRef as l, resolveBundledProviderCompatPluginIds as n, resolveEnabledProviderPluginIds as o, resolveCatalogHookProviderPluginIds as r, resolveExternalAuthProfileCompatFallbackPluginIds as s, resolveActivatableProviderOwnerPluginIds as t, resolveOwningPluginIdsForModelRefs as u };
