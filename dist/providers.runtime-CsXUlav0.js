import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { h as extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-store-C1Oen9wR.js";
import { n as hasExplicitPluginIdScope } from "./plugin-scope-6HF2N6kz.js";
import { d as resolveEnabledProviderPluginIds, g as withBundledProviderVitestCompat, h as resolveOwningPluginIdsForProvider, l as resolveDiscoverableProviderOwnerPluginIds, m as resolveOwningPluginIdsForModelRefs, o as resolveActivatableProviderOwnerPluginIds, s as resolveBundledProviderCompatPluginIds, u as resolveDiscoveredProviderPluginIds } from "./plugin-auto-enable-CuCUT4Z1.js";
import { r as withActivatedPluginIds, t as resolveBundledPluginCompatibleActivationInputs } from "./activation-context-VOwqwTGf.js";
import { t as resolveManifestActivationPluginIds } from "./activation-planner-Cd6anAX7.js";
import { a as getRuntimePluginRegistryForLoadOptions, c as loadOpenClawPlugins, o as isPluginRegistryLoadInFlight } from "./loader-DKK7Ita0.js";
import { c as getActivePluginRegistryWorkspaceDir } from "./runtime-DHxRl5F1.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { n as buildPluginRuntimeLoadOptionsFromValues, r as createPluginRuntimeLoaderLogger } from "./load-context-BO-9CJts.js";
//#region src/plugins/provider-config-owner.ts
function resolveProviderConfigApiOwnerHint(params) {
	const providers = params.config?.models?.providers;
	if (!providers) return;
	const normalizedProvider = normalizeProviderId(params.provider);
	if (!normalizedProvider) return;
	const providerConfig = providers[params.provider] ?? Object.entries(providers).find(([candidateId]) => normalizeProviderId(candidateId) === normalizedProvider)?.[1];
	const api = typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
	if (!api || api === normalizedProvider) return;
	return api;
}
//#endregion
//#region src/plugins/providers.runtime.ts
function dedupeSortedPluginIds(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function resolveExplicitProviderOwnerPluginIds(params) {
	return dedupeSortedPluginIds(params.providerRefs.flatMap((provider) => {
		const plannedPluginIds = resolveManifestActivationPluginIds({
			trigger: {
				kind: "provider",
				provider
			},
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			manifestRecords: params.pluginMetadataSnapshot?.manifestRegistry.plugins
		});
		if (plannedPluginIds.length > 0) return plannedPluginIds;
		const apiOwnerHint = resolveProviderConfigApiOwnerHint({
			provider,
			config: params.config
		});
		if (apiOwnerHint) {
			const apiOwnerPluginIds = resolveManifestActivationPluginIds({
				trigger: {
					kind: "provider",
					provider: apiOwnerHint
				},
				config: params.config,
				workspaceDir: params.workspaceDir,
				env: params.env,
				manifestRecords: params.pluginMetadataSnapshot?.manifestRegistry.plugins
			});
			if (apiOwnerPluginIds.length > 0) return apiOwnerPluginIds;
			const legacyApiOwnerPluginIds = resolveOwningPluginIdsForProvider({
				provider: apiOwnerHint,
				config: params.config,
				workspaceDir: params.workspaceDir,
				env: params.env,
				manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
			});
			if (legacyApiOwnerPluginIds?.length) return legacyApiOwnerPluginIds;
		}
		return resolveOwningPluginIdsForProvider({
			provider,
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
		}) ?? [];
	}));
}
function mergeExplicitOwnerPluginIds(providerPluginIds, explicitOwnerPluginIds) {
	if (explicitOwnerPluginIds.length === 0) return [...providerPluginIds];
	return dedupeSortedPluginIds([...providerPluginIds, ...explicitOwnerPluginIds]);
}
function resolvePluginProviderLoadBase(params) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
	const providerOwnedPluginIds = params.providerRefs?.length ? resolveExplicitProviderOwnerPluginIds({
		providerRefs: params.providerRefs,
		config: params.config,
		workspaceDir,
		env,
		pluginMetadataSnapshot: params.pluginMetadataSnapshot
	}) : [];
	const modelOwnedPluginIds = params.modelRefs?.length ? resolveOwningPluginIdsForModelRefs({
		models: params.modelRefs,
		config: params.config,
		workspaceDir,
		env,
		manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
	}) : [];
	return {
		env,
		workspaceDir,
		requestedPluginIds: hasExplicitPluginIdScope(params.onlyPluginIds) || params.providerRefs?.length || params.modelRefs?.length || providerOwnedPluginIds.length > 0 || modelOwnedPluginIds.length > 0 ? [...new Set([
			...params.onlyPluginIds ?? [],
			...providerOwnedPluginIds,
			...modelOwnedPluginIds
		])].toSorted((left, right) => left.localeCompare(right)) : void 0,
		explicitOwnerPluginIds: dedupeSortedPluginIds([...providerOwnedPluginIds, ...modelOwnedPluginIds]),
		rawConfig: params.config
	};
}
function resolveSetupProviderPluginLoadState(params, base) {
	const setupPluginIds = mergeExplicitOwnerPluginIds(resolveDiscoveredProviderPluginIds({
		config: params.config,
		workspaceDir: base.workspaceDir,
		env: base.env,
		onlyPluginIds: base.requestedPluginIds,
		includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
		registry: params.pluginMetadataSnapshot?.index,
		manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
	}), resolveDiscoverableProviderOwnerPluginIds({
		pluginIds: base.explicitOwnerPluginIds,
		config: params.config,
		workspaceDir: base.workspaceDir,
		env: base.env,
		includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
		registry: params.pluginMetadataSnapshot?.index,
		manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
	}));
	if (setupPluginIds.length === 0) return;
	const setupConfig = withActivatedPluginIds({
		config: base.rawConfig,
		pluginIds: setupPluginIds
	});
	return { loadOptions: buildPluginRuntimeLoadOptionsFromValues({
		config: setupConfig,
		activationSourceConfig: setupConfig,
		autoEnabledReasons: {},
		workspaceDir: base.workspaceDir,
		env: base.env,
		logger: createPluginRuntimeLoaderLogger(),
		installRecords: params.pluginMetadataSnapshot ? extractPluginInstallRecordsFromInstalledPluginIndex(params.pluginMetadataSnapshot.index) : void 0
	}, {
		onlyPluginIds: setupPluginIds,
		pluginSdkResolution: params.pluginSdkResolution,
		cache: params.cache ?? false,
		activate: params.activate ?? false
	}) };
}
function resolveRuntimeProviderPluginLoadState(params, base) {
	const explicitOwnerPluginIds = resolveActivatableProviderOwnerPluginIds({
		pluginIds: base.explicitOwnerPluginIds,
		config: base.rawConfig,
		workspaceDir: base.workspaceDir,
		env: base.env,
		includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
		registry: params.pluginMetadataSnapshot?.index,
		manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
	});
	const runtimeRequestedPluginIds = base.requestedPluginIds !== void 0 ? dedupeSortedPluginIds([...params.onlyPluginIds ?? [], ...explicitOwnerPluginIds]) : void 0;
	const activation = resolveBundledPluginCompatibleActivationInputs({
		rawConfig: withActivatedPluginIds({
			config: base.rawConfig,
			pluginIds: explicitOwnerPluginIds
		}),
		env: base.env,
		workspaceDir: base.workspaceDir,
		onlyPluginIds: runtimeRequestedPluginIds,
		applyAutoEnable: params.applyAutoEnable ?? true,
		compatMode: {
			allowlist: params.bundledProviderAllowlistCompat,
			enablement: "allowlist",
			vitest: params.bundledProviderVitestCompat
		},
		resolveCompatPluginIds: (compatParams) => resolveBundledProviderCompatPluginIds({
			...compatParams,
			manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
		})
	});
	const config = params.bundledProviderVitestCompat ? withBundledProviderVitestCompat({
		config: activation.config,
		pluginIds: activation.compatPluginIds,
		env: base.env
	}) : activation.config;
	const providerPluginIds = mergeExplicitOwnerPluginIds(resolveEnabledProviderPluginIds({
		config,
		workspaceDir: base.workspaceDir,
		env: base.env,
		onlyPluginIds: runtimeRequestedPluginIds,
		registry: params.pluginMetadataSnapshot?.index,
		manifestRegistry: params.pluginMetadataSnapshot?.manifestRegistry
	}), explicitOwnerPluginIds);
	return { loadOptions: buildPluginRuntimeLoadOptionsFromValues({
		config,
		activationSourceConfig: activation.activationSourceConfig,
		autoEnabledReasons: activation.autoEnabledReasons,
		workspaceDir: base.workspaceDir,
		env: base.env,
		logger: createPluginRuntimeLoaderLogger(),
		installRecords: params.pluginMetadataSnapshot ? extractPluginInstallRecordsFromInstalledPluginIndex(params.pluginMetadataSnapshot.index) : void 0
	}, {
		onlyPluginIds: providerPluginIds,
		pluginSdkResolution: params.pluginSdkResolution,
		cache: params.cache ?? true,
		activate: params.activate ?? false
	}) };
}
function isPluginProvidersLoadInFlight(params) {
	const base = resolvePluginProviderLoadBase(params);
	const loadState = params.mode === "setup" ? resolveSetupProviderPluginLoadState(params, base) : resolveRuntimeProviderPluginLoadState(params, base);
	if (!loadState) return false;
	return isPluginRegistryLoadInFlight(loadState.loadOptions);
}
function resolvePluginProviders(params) {
	const base = resolvePluginProviderLoadBase(params);
	if (params.mode === "setup") {
		const loadState = resolveSetupProviderPluginLoadState(params, base);
		if (!loadState) return [];
		return loadOpenClawPlugins(loadState.loadOptions).providers.map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }));
	}
	const loadState = resolveRuntimeProviderPluginLoadState(params, base);
	const registry = loadState.loadOptions.onlyPluginIds?.length === 0 ? void 0 : getLoadedRuntimePluginRegistry({
		env: base.env,
		loadOptions: loadState.loadOptions,
		workspaceDir: base.workspaceDir,
		requiredPluginIds: loadState.loadOptions.onlyPluginIds
	}) ?? getRuntimePluginRegistryForLoadOptions(loadState.loadOptions);
	if (!registry) return [];
	return registry.providers.map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId }));
}
//#endregion
export { resolvePluginProviders as n, resolveProviderConfigApiOwnerHint as r, isPluginProvidersLoadInFlight as t };
