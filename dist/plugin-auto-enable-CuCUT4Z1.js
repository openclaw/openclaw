import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord, d as resolveConfigDir, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { g as resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-store-C1Oen9wR.js";
import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { l as resolveEffectivePluginActivationState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as isPluginEnabledByDefaultForPlatform } from "./default-enablement-CT7_t1ee.js";
import { t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-HgZGS-Bx.js";
import { c as resolveProviderOwners, p as loadPluginRegistrySnapshot, r as normalizePluginsConfigWithRegistry, s as resolvePluginContributionOwners, v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { r as withBundledPluginVitestCompat } from "./bundled-compat-BkrhFp4r.js";
import { n as collectConfiguredModelRefs } from "./model-refs-BGL2fwMX.js";
import { t as getChatChannelMeta } from "./chat-meta-2H4wOcrq.js";
import "./registry-CtWyD2pE.js";
import { t as splitTrailingAuthProfile } from "./model-ref-profile-L6rqw6O0.js";
import { i as passesManifestOwnerBasePolicy, n as isActivatedManifestOwner } from "./manifest-owner-policy-DqV-lgQl.js";
import { t as createPluginIdScopeSet } from "./plugin-scope-6HF2N6kz.js";
import { t as collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes-Da9K6qai.js";
import { a as listPotentialConfiguredChannelPresenceSignals } from "./config-presence-DiJ4UoDg.js";
import { i as listBundledChannelIdsWithConfiguredState, r as hasBundledChannelConfiguredState, t as isChannelConfigured } from "./channel-configured-B6BYuKoD.js";
import { n as resolvePluginSetupAutoEnableReasons } from "./setup-registry-DHllMAAd.js";
import { t as ensurePluginAllowlisted } from "./plugins-allowlist-DNuAZt78.js";
import fs from "node:fs";
import path from "node:path";
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
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, { manifestRegistry: params.manifestRegistry });
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
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, { manifestRegistry: params.manifestRegistry });
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
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, { manifestRegistry: params.manifestRegistry });
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
	const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins !== true;
	const shouldFilterBundledByAllowlist = params.config?.plugins?.bundledDiscovery !== "compat";
	const normalizedConfig = normalizePluginsConfigWithRegistry(params.config?.plugins, registry, { manifestRegistry: params.manifestRegistry });
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
	const shouldFilterUntrustedWorkspacePlugins = params.includeUntrustedWorkspacePlugins !== true;
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
//#region src/config/plugin-auto-enable.prefer-over.ts
const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
function splitEnvPaths(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	if (!trimmed) return [];
	return normalizeStringEntries(trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)));
}
function resolveExternalCatalogPaths(env) {
	for (const key of ENV_CATALOG_PATHS) {
		const raw = normalizeOptionalString(env[key]);
		if (raw) return splitEnvPaths(raw);
	}
	const configDir = resolveConfigDir(env);
	return [
		path.join(configDir, "mpm", "plugins.json"),
		path.join(configDir, "mpm", "catalog.json"),
		path.join(configDir, "plugins", "catalog.json")
	];
}
function parseExternalCatalogChannelEntries(raw) {
	const list = (() => {
		if (Array.isArray(raw)) return raw;
		if (!isRecord(raw)) return [];
		const entries = raw.entries ?? raw.packages ?? raw.plugins;
		return Array.isArray(entries) ? entries : [];
	})();
	const channels = [];
	for (const entry of list) {
		if (!isRecord(entry) || !isRecord(entry.openclaw) || !isRecord(entry.openclaw.channel)) continue;
		const channel = entry.openclaw.channel;
		const id = normalizeOptionalString(channel.id) ?? "";
		if (!id) continue;
		const preferOver = Array.isArray(channel.preferOver) ? channel.preferOver.filter((value) => typeof value === "string") : [];
		channels.push({
			id,
			preferOver
		});
	}
	return channels;
}
function resolveExternalCatalogPreferOver(channelId, env) {
	for (const rawPath of resolveExternalCatalogPaths(env)) {
		const resolved = resolveUserPath(rawPath, env);
		if (!fs.existsSync(resolved)) continue;
		try {
			const channel = parseExternalCatalogChannelEntries(JSON.parse(fs.readFileSync(resolved, "utf-8"))).find((entry) => entry.id === channelId);
			if (channel) return channel.preferOver;
		} catch {}
	}
	return [];
}
function resolveBuiltInChannelPreferOver(channelId) {
	const builtInChannelId = normalizeChatChannelId(channelId);
	if (!builtInChannelId) return [];
	return getChatChannelMeta(builtInChannelId)?.preferOver ?? [];
}
function resolvePreferredOverIds(candidate, env, registry) {
	const channelId = candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
	const installedPlugin = registry.plugins.find((record) => record.id === candidate.pluginId);
	const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[channelId]?.preferOver;
	if (manifestChannelPreferOver?.length) return [...manifestChannelPreferOver];
	const installedChannelMeta = installedPlugin?.channelCatalogMeta;
	if (installedChannelMeta?.preferOver?.length) return [...installedChannelMeta.preferOver];
	const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(channelId);
	if (builtInChannelPreferOver.length) return [...builtInChannelPreferOver];
	return resolveExternalCatalogPreferOver(channelId, env);
}
function getPluginAutoEnableCandidateCacheKey(candidate) {
	return `${candidate.pluginId}:${candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId}`;
}
function shouldSkipPreferredPluginAutoEnable(params) {
	const getPreferredOverIds = (candidate) => {
		const cacheKey = getPluginAutoEnableCandidateCacheKey(candidate);
		const cached = params.preferOverCache.get(cacheKey);
		if (cached) return cached;
		const resolved = resolvePreferredOverIds(candidate, params.env, params.registry);
		params.preferOverCache.set(cacheKey, resolved);
		return resolved;
	};
	for (const other of params.configured) {
		if (other.pluginId === params.entry.pluginId) continue;
		if (params.isPluginDenied(params.config, other.pluginId) || params.isPluginExplicitlyDisabled(params.config, other.pluginId)) continue;
		if (getPreferredOverIds(other).includes(params.entry.pluginId)) return true;
	}
	return false;
}
//#endregion
//#region src/config/plugin-auto-enable.shared.ts
const EMPTY_PLUGIN_MANIFEST_REGISTRY = {
	plugins: [],
	diagnostics: []
};
function resolveAutoEnableProviderPluginIds(registry) {
	const entries = /* @__PURE__ */ new Map();
	for (const plugin of registry.plugins) for (const providerId of plugin.autoEnableWhenConfiguredProviders ?? []) if (!entries.has(providerId)) entries.set(providerId, plugin.id);
	return Object.fromEntries(entries);
}
function canReuseUnscopedCurrentPluginMetadataSnapshot(config) {
	return normalizePluginsConfig(config.plugins).loadPaths.length === 0;
}
function extractProviderFromModelRef(value) {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return null;
	return normalizeProviderId(trimmed.slice(0, slash));
}
function hasConfiguredEmbeddedHarnessRuntime(cfg, env) {
	return collectConfiguredAgentHarnessRuntimes(cfg, env, { includeEnvRuntime: false }).length > 0;
}
function resolveAgentHarnessOwnerPluginIds(registry, runtime) {
	const normalizedRuntime = normalizeOptionalLowercaseString(runtime);
	if (!normalizedRuntime) return [];
	return registry.plugins.filter((plugin) => [...plugin.activation?.onAgentHarnesses ?? [], ...plugin.cliBackends ?? []].some((entry) => normalizeOptionalLowercaseString(entry) === normalizedRuntime)).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function isProviderConfigured(cfg, providerId) {
	const normalized = normalizeProviderId(providerId);
	const profiles = cfg.auth?.profiles;
	if (profiles && typeof profiles === "object") for (const profile of Object.values(profiles)) {
		if (!isRecord(profile)) continue;
		if (normalizeProviderId(profile.provider ?? "") === normalized) return true;
	}
	const providerConfig = cfg.models?.providers;
	if (providerConfig && typeof providerConfig === "object") {
		for (const key of Object.keys(providerConfig)) if (normalizeProviderId(key) === normalized) return true;
	}
	for (const { value: ref } of collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false })) {
		const provider = extractProviderFromModelRef(ref);
		if (provider && provider === normalized) return true;
	}
	return false;
}
function hasPluginOwnedWebSearchConfig(cfg, pluginId) {
	const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
	return isRecord(pluginConfig) && isRecord(pluginConfig.webSearch);
}
function hasPluginOwnedWebFetchConfig(cfg, pluginId) {
	const pluginConfig = cfg.plugins?.entries?.[pluginId]?.config;
	return isRecord(pluginConfig) && isRecord(pluginConfig.webFetch);
}
function resolvePluginOwnedToolConfigKeys(plugin) {
	if ((plugin.contracts?.tools?.length ?? 0) === 0) return [];
	const properties = isRecord(plugin.configSchema) ? plugin.configSchema.properties : void 0;
	if (!isRecord(properties)) return [];
	return Object.keys(properties).filter((key) => key !== "webSearch" && key !== "webFetch");
}
function hasPluginOwnedToolConfig(cfg, plugin) {
	const pluginConfig = cfg.plugins?.entries?.[plugin.id]?.config;
	if (!isRecord(pluginConfig)) return false;
	return resolvePluginOwnedToolConfigKeys(plugin).some((key) => pluginConfig[key] !== void 0);
}
function resolveProviderPluginsWithOwnedWebSearch(registry) {
	return registry.plugins.filter((plugin) => (plugin.providers?.length ?? 0) > 0).filter((plugin) => (plugin.contracts?.webSearchProviders?.length ?? 0) > 0);
}
function resolveProviderPluginsWithOwnedWebFetch(registry) {
	return registry.plugins.filter((plugin) => (plugin.contracts?.webFetchProviders?.length ?? 0) > 0);
}
function resolvePluginsWithOwnedToolConfig(registry) {
	return registry.plugins.filter((plugin) => (plugin.contracts?.tools?.length ?? 0) > 0);
}
function resolvePluginIdForConfiguredWebFetchProvider(providerId, registry) {
	const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
	if (!normalizedProviderId) return;
	return registry.plugins.find((plugin) => plugin.origin === "bundled" && (plugin.contracts?.webFetchProviders ?? []).some((candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId))?.id;
}
function resolvePluginIdForConfiguredWebSearchProvider(providerId, registry) {
	const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
	if (!normalizedProviderId) return;
	return registry.plugins.find((plugin) => (plugin.contracts?.webSearchProviders ?? []).some((candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProviderId))?.id;
}
function normalizeManifestChannelId(channelId) {
	return normalizeChatChannelId(channelId) ?? channelId;
}
function getManifestChannelPreferOver(plugin, channelId) {
	return plugin.channelConfigs?.[channelId]?.preferOver ?? [];
}
function collectPluginIdsForConfiguredChannel(channelId, registry) {
	const normalizedChannelId = normalizeManifestChannelId(channelId);
	const builtInId = normalizeChatChannelId(normalizedChannelId);
	const claims = [];
	for (const record of registry.plugins) if ((record.channels ?? []).some((id) => normalizeManifestChannelId(id) === normalizedChannelId)) claims.push({
		plugin: record,
		preferOver: getManifestChannelPreferOver(record, normalizedChannelId)
	});
	if (claims.length === 0) return builtInId ? [builtInId] : [];
	const claimIds = new Set(claims.map((claim) => claim.plugin.id));
	if (builtInId) claimIds.add(builtInId);
	const preferredIds = /* @__PURE__ */ new Set();
	for (const claim of claims) for (const preferredOverId of claim.preferOver) if (claimIds.has(preferredOverId)) {
		preferredIds.add(claim.plugin.id);
		preferredIds.add(preferredOverId);
	}
	if (preferredIds.size > 0) return [...preferredIds].toSorted((left, right) => left.localeCompare(right));
	return [claims[0]?.plugin.id ?? builtInId ?? normalizedChannelId];
}
function collectConfiguredChannelIds(cfg, env) {
	const configuredStateChannelIds = new Set(listBundledChannelIdsWithConfiguredState());
	return listPotentialConfiguredChannelPresenceSignals(cfg, env, { includePersistedAuthState: false }).map((signal) => ({
		source: signal.source,
		channelId: normalizeChatChannelId(signal.channelId) ?? signal.channelId
	})).filter(({ channelId, source }) => isAutoEnableConfiguredChannelSignal({
		cfg,
		env,
		channelId,
		source,
		configuredStateChannelIds
	})).map(({ channelId }) => channelId);
}
function isAutoEnableConfiguredChannelSignal(params) {
	if (params.source === "env" && params.configuredStateChannelIds.has(params.channelId) && !hasBundledChannelConfiguredState({
		channelId: params.channelId,
		cfg: params.cfg,
		env: params.env
	})) return false;
	return isChannelConfigured(params.cfg, params.channelId, params.env);
}
function hasConfiguredWebSearchPluginEntry(cfg) {
	const entries = cfg.plugins?.entries;
	return !!entries && typeof entries === "object" && Object.values(entries).some((entry) => isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.webSearch));
}
function hasConfiguredWebSearchProviderSelection(cfg) {
	const provider = cfg.tools?.web?.search?.provider;
	return cfg.tools?.web?.search?.enabled !== false && typeof provider === "string" && !!provider.trim();
}
function hasConfiguredWebFetchPluginEntry(cfg) {
	const entries = cfg.plugins?.entries;
	return !!entries && typeof entries === "object" && Object.values(entries).some((entry) => isRecord(entry) && isRecord(entry.config) && isRecord(entry.config.webFetch));
}
function hasConfiguredPluginConfigEntry(cfg) {
	const entries = cfg.plugins?.entries;
	return !!entries && typeof entries === "object" && Object.values(entries).some((entry) => isRecord(entry) && isRecord(entry.config));
}
function listContainsNormalized(value, expected) {
	return Array.isArray(value) && value.some((entry) => normalizeOptionalLowercaseString(entry) === expected);
}
function toolPolicyReferencesBrowser(value) {
	return isRecord(value) && (listContainsNormalized(value.allow, "browser") || listContainsNormalized(value.alsoAllow, "browser"));
}
function hasBrowserToolReference(cfg) {
	if (toolPolicyReferencesBrowser(cfg.tools)) return true;
	const agentList = cfg.agents?.list;
	return Array.isArray(agentList) ? agentList.some((entry) => isRecord(entry) && toolPolicyReferencesBrowser(entry.tools)) : false;
}
function collectConfiguredPluginEntryIds(cfg) {
	const entries = cfg.plugins?.entries;
	if (!entries || typeof entries !== "object") return [];
	return Object.keys(entries).map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId && !isPluginEntryExplicitlyDisabled(cfg, pluginId));
}
function hasOwnPluginEntry(cfg, pluginId) {
	const entries = cfg.plugins?.entries;
	return !!entries && typeof entries === "object" && Object.hasOwn(entries, pluginId);
}
function isPluginEntryExplicitlyDisabled(cfg, pluginId) {
	return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}
function hasNonDisabledPluginEntry(cfg, pluginId) {
	if (!hasOwnPluginEntry(cfg, pluginId)) return false;
	return !isPluginEntryExplicitlyDisabled(cfg, pluginId);
}
function hasBrowserSetupAutoEnableRelevantConfig(cfg) {
	if (cfg.browser?.enabled === false || isPluginEntryExplicitlyDisabled(cfg, "browser")) return false;
	if (isRecord(cfg.browser)) return true;
	if (hasNonDisabledPluginEntry(cfg, "browser")) return true;
	return hasBrowserToolReference(cfg);
}
function hasAcpxSetupAutoEnableRelevantConfig(cfg) {
	if (isPluginEntryExplicitlyDisabled(cfg, "acpx")) return false;
	if (!isRecord(cfg.acp)) return false;
	const backend = normalizeOptionalLowercaseString(cfg.acp.backend);
	return (cfg.acp.enabled === true || isRecord(cfg.acp.dispatch) && cfg.acp.dispatch.enabled === true || backend === "acpx") && (!backend || backend === "acpx");
}
function hasXaiSetupAutoEnableRelevantConfig(cfg) {
	if (isPluginEntryExplicitlyDisabled(cfg, "xai")) return false;
	const pluginConfig = cfg.plugins?.entries?.xai?.config;
	return isRecord(pluginConfig) && (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution)) || isRecord(cfg.tools?.web) && isRecord(cfg.tools.web.x_search);
}
function resolveRelevantSetupAutoEnablePluginIds(cfg) {
	const pluginIds = new Set(collectConfiguredPluginEntryIds(cfg));
	if (hasBrowserSetupAutoEnableRelevantConfig(cfg)) pluginIds.add("browser");
	if (hasAcpxSetupAutoEnableRelevantConfig(cfg)) pluginIds.add("acpx");
	if (hasXaiSetupAutoEnableRelevantConfig(cfg)) pluginIds.add("xai");
	return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
function hasSetupAutoEnableRelevantConfig(cfg) {
	return hasBrowserSetupAutoEnableRelevantConfig(cfg) || hasAcpxSetupAutoEnableRelevantConfig(cfg) || hasXaiSetupAutoEnableRelevantConfig(cfg) || hasConfiguredPluginConfigEntry(cfg);
}
function hasPluginEntries(cfg) {
	const entries = cfg.plugins?.entries;
	return !!entries && typeof entries === "object" && Object.keys(entries).length > 0;
}
function hasPluginAllowlistWithMaterialEntries(cfg) {
	if (!Array.isArray(cfg.plugins?.allow) || cfg.plugins.allow.length === 0 || !hasPluginEntries(cfg)) return false;
	const entries = cfg.plugins?.entries;
	if (!entries || typeof entries !== "object") return false;
	return Object.values(entries).some(hasMaterialPluginEntryConfig);
}
function hasConfiguredProviderModelOrHarness(cfg, env) {
	if (cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) return true;
	if (cfg.models?.providers && Object.keys(cfg.models.providers).length > 0) return true;
	if (collectConfiguredModelRefs(cfg, { includeChannelModelOverrides: false }).length > 0) return true;
	return hasConfiguredEmbeddedHarnessRuntime(cfg, env);
}
function arePluginsGloballyDisabled(cfg) {
	return cfg.plugins?.enabled === false;
}
function configMayNeedPluginManifestRegistry(cfg, env) {
	if (arePluginsGloballyDisabled(cfg)) return false;
	if (hasPluginAllowlistWithMaterialEntries(cfg)) return true;
	if (hasConfiguredPluginConfigEntry(cfg)) return true;
	if (hasConfiguredProviderModelOrHarness(cfg, env)) return true;
	if (hasConfiguredWebSearchProviderSelection(cfg)) return true;
	const configuredChannels = cfg.channels;
	if (!configuredChannels || typeof configuredChannels !== "object") return false;
	for (const key of Object.keys(configuredChannels)) {
		if (key === "defaults" || key === "modelByChannel") continue;
		return true;
	}
	return false;
}
function configMayNeedPluginAutoEnable(cfg, env) {
	return resolvePluginAutoEnableReadiness(cfg, env).mayNeedAutoEnable;
}
function resolvePluginAutoEnableReadiness(cfg, env) {
	if (arePluginsGloballyDisabled(cfg)) return {
		mayNeedAutoEnable: false,
		configuredChannelIds: []
	};
	if (hasPluginAllowlistWithMaterialEntries(cfg)) return {
		mayNeedAutoEnable: true,
		configuredChannelIds: []
	};
	if (hasConfiguredPluginConfigEntry(cfg)) return {
		mayNeedAutoEnable: true,
		configuredChannelIds: []
	};
	const configuredChannelIds = collectConfiguredChannelIds(cfg, env);
	if (configuredChannelIds.length > 0) return {
		mayNeedAutoEnable: true,
		configuredChannelIds
	};
	if (hasConfiguredProviderModelOrHarness(cfg, env)) return {
		mayNeedAutoEnable: true,
		configuredChannelIds
	};
	if (hasConfiguredWebSearchProviderSelection(cfg) || hasConfiguredWebSearchPluginEntry(cfg) || hasConfiguredWebFetchPluginEntry(cfg)) return {
		mayNeedAutoEnable: true,
		configuredChannelIds
	};
	if (!hasSetupAutoEnableRelevantConfig(cfg)) return {
		mayNeedAutoEnable: false,
		configuredChannelIds
	};
	return {
		mayNeedAutoEnable: resolvePluginSetupAutoEnableReasons({
			config: cfg,
			env,
			pluginIds: resolveRelevantSetupAutoEnablePluginIds(cfg)
		}).length > 0,
		configuredChannelIds
	};
}
function resolvePluginAutoEnableCandidateReason(candidate) {
	switch (candidate.kind) {
		case "channel-configured": return `${candidate.channelId} configured`;
		case "provider-auth-configured": return `${candidate.providerId} auth configured`;
		case "provider-model-configured": return `${candidate.modelRef} model configured`;
		case "agent-harness-runtime-configured": return `${candidate.runtime} agent runtime configured`;
		case "web-search-provider-selected": return `${candidate.providerId} web search provider selected`;
		case "web-fetch-provider-selected": return `${candidate.providerId} web fetch provider selected`;
		case "plugin-web-search-configured": return `${candidate.pluginId} web search configured`;
		case "plugin-web-fetch-configured": return `${candidate.pluginId} web fetch configured`;
		case "plugin-tool-configured": return `${candidate.pluginId} tool configured`;
		case "setup-auto-enable": return candidate.reason;
	}
	throw new Error("Unsupported plugin auto-enable candidate");
}
function resolveConfiguredPluginAutoEnableCandidates(params) {
	const changes = [];
	for (const channelId of params.configuredChannelIds ?? collectConfiguredChannelIds(params.config, params.env)) for (const pluginId of collectPluginIdsForConfiguredChannel(channelId, params.registry)) changes.push({
		pluginId,
		kind: "channel-configured",
		channelId
	});
	for (const [providerId, pluginId] of Object.entries(resolveAutoEnableProviderPluginIds(params.registry))) if (isProviderConfigured(params.config, providerId)) changes.push({
		pluginId,
		kind: "provider-auth-configured",
		providerId
	});
	for (const { value: modelRef } of collectConfiguredModelRefs(params.config, { includeChannelModelOverrides: false })) {
		const owningPluginIds = resolveOwningPluginIdsForModelRef({
			model: modelRef,
			config: params.config,
			env: params.env,
			manifestRegistry: params.registry
		});
		if (owningPluginIds?.length === 1) changes.push({
			pluginId: owningPluginIds[0],
			kind: "provider-model-configured",
			modelRef
		});
	}
	for (const runtime of collectConfiguredAgentHarnessRuntimes(params.config, params.env, { includeEnvRuntime: false })) {
		const pluginIds = resolveAgentHarnessOwnerPluginIds(params.registry, runtime);
		for (const pluginId of pluginIds) changes.push({
			pluginId,
			kind: "agent-harness-runtime-configured",
			runtime
		});
	}
	const webSearchConfig = params.config.tools?.web?.search;
	const webSearchProvider = webSearchConfig?.enabled !== false && typeof webSearchConfig?.provider === "string" ? webSearchConfig.provider : void 0;
	const webSearchPluginId = resolvePluginIdForConfiguredWebSearchProvider(webSearchProvider, params.registry);
	if (webSearchPluginId) changes.push({
		pluginId: webSearchPluginId,
		kind: "web-search-provider-selected",
		providerId: normalizeOptionalLowercaseString(webSearchProvider) ?? ""
	});
	const webFetchProvider = typeof params.config.tools?.web?.fetch?.provider === "string" ? params.config.tools.web.fetch.provider : void 0;
	const webFetchPluginId = resolvePluginIdForConfiguredWebFetchProvider(webFetchProvider, params.registry);
	if (webFetchPluginId) changes.push({
		pluginId: webFetchPluginId,
		kind: "web-fetch-provider-selected",
		providerId: normalizeOptionalLowercaseString(webFetchProvider) ?? ""
	});
	for (const plugin of resolveProviderPluginsWithOwnedWebSearch(params.registry)) {
		const pluginId = plugin.id;
		if (hasPluginOwnedWebSearchConfig(params.config, pluginId)) changes.push({
			pluginId,
			kind: "plugin-web-search-configured"
		});
	}
	for (const plugin of resolvePluginsWithOwnedToolConfig(params.registry)) {
		const pluginId = plugin.id;
		if (hasPluginOwnedToolConfig(params.config, plugin)) changes.push({
			pluginId,
			kind: "plugin-tool-configured"
		});
	}
	for (const plugin of resolveProviderPluginsWithOwnedWebFetch(params.registry)) {
		const pluginId = plugin.id;
		if (hasPluginOwnedWebFetchConfig(params.config, pluginId)) changes.push({
			pluginId,
			kind: "plugin-web-fetch-configured"
		});
	}
	if (hasSetupAutoEnableRelevantConfig(params.config)) {
		const manifestMatchedPluginIds = new Set(changes.map((entry) => entry.pluginId));
		const setupPluginIds = resolveRelevantSetupAutoEnablePluginIds(params.config).filter((pluginId) => !manifestMatchedPluginIds.has(pluginId));
		for (const entry of resolvePluginSetupAutoEnableReasons({
			config: params.config,
			env: params.env,
			pluginIds: setupPluginIds
		})) changes.push({
			pluginId: entry.pluginId,
			kind: "setup-auto-enable",
			reason: entry.reason
		});
	}
	return changes;
}
function isPluginExplicitlyDisabled(cfg, pluginId) {
	const builtInChannelId = normalizeChatChannelId(pluginId);
	if (builtInChannelId) {
		const channelConfig = cfg.channels?.[builtInChannelId];
		if (channelConfig && typeof channelConfig === "object" && !Array.isArray(channelConfig) && channelConfig.enabled === false) return true;
	}
	return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}
function isPluginDenied(cfg, pluginId) {
	const deny = cfg.plugins?.deny;
	return Array.isArray(deny) && deny.includes(pluginId);
}
function isPluginExplicitlySelected(cfg, pluginId) {
	const allow = cfg.plugins?.allow;
	if (Array.isArray(allow) && allow.includes(pluginId)) return true;
	return hasMaterialPluginEntryConfig(cfg.plugins?.entries?.[pluginId]);
}
function disableImplicitPreferredOverPlugin(params) {
	if (isPluginExplicitlySelected(params.originalConfig, params.pluginId)) return params.config;
	if (!normalizeChatChannelId(params.pluginId) && !isKnownPluginId(params.pluginId, params.manifestRegistry)) return params.config;
	const existingEntry = params.config.plugins?.entries?.[params.pluginId];
	return {
		...params.config,
		plugins: {
			...params.config.plugins,
			entries: {
				...params.config.plugins?.entries,
				[params.pluginId]: {
					...existingEntry && typeof existingEntry === "object" ? existingEntry : {},
					enabled: false
				}
			}
		}
	};
}
function isBuiltInChannelAlreadyEnabled(cfg, channelId) {
	const channelConfig = cfg.channels?.[channelId];
	return !!channelConfig && typeof channelConfig === "object" && !Array.isArray(channelConfig) && channelConfig.enabled === true;
}
function resolveAutoEnableChannelId(params) {
	const builtInChannelId = normalizeChatChannelId(params.entry.pluginId);
	if (builtInChannelId) return builtInChannelId;
	if (params.entry.kind !== "channel-configured") return null;
	const plugin = params.manifestRegistry.plugins.find((record) => record.id === params.entry.pluginId);
	if (plugin?.origin !== "bundled") return null;
	const channelId = normalizeManifestChannelId(params.entry.channelId);
	return (plugin.channels ?? []).some((id) => normalizeManifestChannelId(id) === channelId) ? channelId : null;
}
function registerPluginEntry(cfg, entry, manifestRegistry) {
	const builtInChannelId = resolveAutoEnableChannelId({
		entry,
		manifestRegistry
	});
	if (builtInChannelId) {
		const existing = cfg.channels?.[builtInChannelId];
		const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
		return {
			...cfg,
			channels: {
				...cfg.channels,
				[builtInChannelId]: {
					...existingRecord,
					enabled: true
				}
			}
		};
	}
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			entries: {
				...cfg.plugins?.entries,
				[entry.pluginId]: {
					...cfg.plugins?.entries?.[entry.pluginId],
					enabled: true
				}
			}
		}
	};
}
function hasMaterialPluginEntryConfig(entry) {
	if (!isRecord(entry)) return false;
	return entry.enabled === true || isRecord(entry.config) || isRecord(entry.hooks) || isRecord(entry.subagent) || isRecord(entry.llm) || entry.apiKey !== void 0 || entry.env !== void 0;
}
function isKnownPluginId(pluginId, manifestRegistry) {
	if (normalizeChatChannelId(pluginId)) return true;
	return manifestRegistry.plugins.some((plugin) => plugin.id === pluginId);
}
function materializeConfiguredPluginEntryAllowlist(params) {
	let next = params.config;
	const allow = next.plugins?.allow;
	const entries = next.plugins?.entries;
	if (!Array.isArray(allow) || allow.length === 0 || !entries || typeof entries !== "object") return next;
	for (const pluginId of Object.keys(entries).toSorted((left, right) => left.localeCompare(right))) {
		const entry = entries[pluginId];
		if (!hasMaterialPluginEntryConfig(entry) || isPluginDenied(next, pluginId) || isPluginExplicitlyDisabled(next, pluginId) || allow.includes(pluginId) || !isKnownPluginId(pluginId, params.manifestRegistry)) continue;
		next = ensurePluginAllowlisted(next, pluginId);
		params.changes.push(`${pluginId} plugin config present, added to plugin allowlist.`);
	}
	return next;
}
function resolveChannelAutoEnableDisplayLabel(entry, manifestRegistry) {
	const builtInChannelId = normalizeChatChannelId(entry.channelId);
	const plugin = manifestRegistry.plugins.find((record) => record.id === entry.pluginId);
	return (builtInChannelId ? getChatChannelMeta(builtInChannelId)?.label : void 0) ?? plugin?.channelConfigs?.[entry.channelId]?.label ?? plugin?.channelCatalogMeta?.label;
}
function formatAutoEnableChange(entry, manifestRegistry) {
	if (entry.kind === "channel-configured") {
		const label = resolveChannelAutoEnableDisplayLabel(entry, manifestRegistry);
		if (label) return `${label} configured, enabled automatically.`;
	}
	return `${resolvePluginAutoEnableCandidateReason(entry).trim()}, enabled automatically.`;
}
function resolvePluginAutoEnableManifestRegistry(params) {
	if (params.manifestRegistry) return params.manifestRegistry;
	if (!configMayNeedPluginManifestRegistry(params.config, params.env)) return EMPTY_PLUGIN_MANIFEST_REGISTRY;
	return (getCurrentPluginMetadataSnapshot({
		config: params.config,
		env: params.env,
		allowWorkspaceScopedSnapshot: true
	}) ?? (() => {
		if (!canReuseUnscopedCurrentPluginMetadataSnapshot(params.config)) return;
		const snapshot = getCurrentPluginMetadataSnapshot({
			env: params.env,
			allowWorkspaceScopedSnapshot: true,
			requireDefaultDiscoveryContext: true
		});
		return snapshot?.policyHash === resolveInstalledPluginIndexPolicyHash(params.config) ? snapshot : void 0;
	})())?.manifestRegistry ?? loadPluginMetadataSnapshot({
		config: params.config,
		env: params.env
	}).manifestRegistry;
}
function materializePluginAutoEnableCandidatesInternal(params) {
	let next = params.config ?? {};
	const changes = [];
	const autoEnabledReasons = /* @__PURE__ */ new Map();
	if (next.plugins?.enabled === false) return {
		config: next,
		changes,
		autoEnabledReasons: {}
	};
	const preferOverCache = /* @__PURE__ */ new Map();
	for (const entry of params.candidates) {
		const builtInChannelId = resolveAutoEnableChannelId({
			entry,
			manifestRegistry: params.manifestRegistry
		});
		if (isPluginDenied(next, entry.pluginId) || isPluginExplicitlyDisabled(next, entry.pluginId)) continue;
		if (shouldSkipPreferredPluginAutoEnable({
			config: next,
			entry,
			configured: params.candidates,
			env: params.env,
			registry: params.manifestRegistry,
			isPluginDenied,
			isPluginExplicitlyDisabled,
			preferOverCache
		})) {
			next = disableImplicitPreferredOverPlugin({
				config: next,
				originalConfig: params.config ?? {},
				pluginId: entry.pluginId,
				manifestRegistry: params.manifestRegistry
			});
			continue;
		}
		const allow = next.plugins?.allow;
		const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
		if ((builtInChannelId != null ? isBuiltInChannelAlreadyEnabled(next, builtInChannelId) : next.plugins?.entries?.[entry.pluginId]?.enabled === true) && !allowMissing) continue;
		next = registerPluginEntry(next, entry, params.manifestRegistry);
		next = ensurePluginAllowlisted(next, entry.pluginId);
		const reason = resolvePluginAutoEnableCandidateReason(entry);
		autoEnabledReasons.set(entry.pluginId, [...autoEnabledReasons.get(entry.pluginId) ?? [], reason]);
		changes.push(formatAutoEnableChange(entry, params.manifestRegistry));
	}
	next = materializeConfiguredPluginEntryAllowlist({
		config: next,
		changes,
		manifestRegistry: params.manifestRegistry
	});
	const autoEnabledReasonRecord = Object.create(null);
	for (const [pluginId, reasons] of autoEnabledReasons) if (!isBlockedObjectKey(pluginId)) autoEnabledReasonRecord[pluginId] = [...reasons];
	return {
		config: next,
		changes,
		autoEnabledReasons: autoEnabledReasonRecord
	};
}
//#endregion
//#region src/config/plugin-auto-enable.detect.ts
function detectPluginAutoEnableCandidates(params) {
	const env = params.env ?? process.env;
	const config = params.config ?? {};
	const readiness = resolvePluginAutoEnableReadiness(config, env);
	if (!readiness.mayNeedAutoEnable) return [];
	return resolveConfiguredPluginAutoEnableCandidates({
		config,
		env,
		registry: resolvePluginAutoEnableManifestRegistry({
			config,
			env,
			manifestRegistry: params.manifestRegistry
		}),
		configuredChannelIds: readiness.configuredChannelIds
	});
}
//#endregion
//#region src/config/plugin-auto-enable.apply.ts
function materializePluginAutoEnableCandidates(params) {
	const env = params.env ?? process.env;
	const config = params.config ?? {};
	const entries = config.plugins?.entries;
	const hasRestrictiveAllowlistWithEntries = Array.isArray(config.plugins?.allow) && config.plugins.allow.length > 0 && entries !== void 0 && typeof entries === "object";
	if (params.candidates.length === 0 && !hasRestrictiveAllowlistWithEntries) return {
		config,
		changes: [],
		autoEnabledReasons: {}
	};
	const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
		config,
		env,
		manifestRegistry: params.manifestRegistry
	});
	return materializePluginAutoEnableCandidatesInternal({
		config,
		candidates: params.candidates,
		env,
		manifestRegistry
	});
}
function applyPluginAutoEnable(params) {
	const candidates = detectPluginAutoEnableCandidates(params);
	return materializePluginAutoEnableCandidates({
		config: params.config,
		candidates,
		env: params.env,
		manifestRegistry: params.manifestRegistry
	});
}
//#endregion
export { resolvePluginAutoEnableCandidateReason as a, resolveCatalogHookProviderPluginIds as c, resolveEnabledProviderPluginIds as d, resolveExternalAuthProfileCompatFallbackPluginIds as f, withBundledProviderVitestCompat as g, resolveOwningPluginIdsForProvider as h, configMayNeedPluginAutoEnable as i, resolveDiscoverableProviderOwnerPluginIds as l, resolveOwningPluginIdsForModelRefs as m, materializePluginAutoEnableCandidates as n, resolveActivatableProviderOwnerPluginIds as o, resolveExternalAuthProfileProviderPluginIds as p, detectPluginAutoEnableCandidates as r, resolveBundledProviderCompatPluginIds as s, applyPluginAutoEnable as t, resolveDiscoveredProviderPluginIds as u };
