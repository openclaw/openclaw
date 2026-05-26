import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as normalizePluginIdScope, t as createPluginIdScopeSet } from "./plugin-scope-6HF2N6kz.js";
import { n as resolveBundledPluginCompatibleLoadValues } from "./activation-context-VOwqwTGf.js";
//#region src/plugins/web-provider-resolution-shared.ts
function comparePluginProvidersAlphabetically(left, right) {
	return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}
function sortPluginProviders(providers) {
	return providers.toSorted(comparePluginProvidersAlphabetically);
}
function sortPluginProvidersForAutoDetect(providers) {
	return providers.toSorted((left, right) => {
		const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		return comparePluginProvidersAlphabetically(left, right);
	});
}
function pluginManifestDeclaresProviderConfig(record, configKey, contract) {
	if ((record.contracts?.[contract]?.length ?? 0) > 0) return true;
	if (Object.keys(record.configUiHints ?? {}).some((key) => key === configKey || key.startsWith(`${configKey}.`))) return true;
	const properties = record.configSchema?.properties;
	return typeof properties === "object" && properties !== null && configKey in properties;
}
function loadInstalledWebProviderManifestRecords(params) {
	const records = loadManifestMetadataSnapshot({
		config: params.config ?? {},
		workspaceDir: params.workspaceDir,
		env: params.env ?? process.env
	}).plugins;
	const pluginIdSet = createPluginIdScopeSet(params.pluginIds);
	return pluginIdSet ? records.filter((plugin) => pluginIdSet.has(plugin.id)) : records;
}
function resolveManifestDeclaredWebProviderCandidatePluginIds(params) {
	return resolveManifestDeclaredWebProviderCandidates(params).pluginIds;
}
function resolveManifestDeclaredWebProviderCandidates(params) {
	const scopedPluginIds = normalizePluginIdScope(params.onlyPluginIds);
	if (scopedPluginIds?.length === 0) return { pluginIds: [] };
	const onlyPluginIdSet = createPluginIdScopeSet(scopedPluginIds);
	const manifestRecords = params.manifestRecords ?? loadInstalledWebProviderManifestRecords({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		pluginIds: scopedPluginIds
	});
	const ids = manifestRecords.filter((plugin) => (!params.origin || plugin.origin === params.origin) && (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) && pluginManifestDeclaresProviderConfig(plugin, params.configKey, params.contract)).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
	if (ids.length > 0) return {
		pluginIds: ids,
		manifestRecords
	};
	if (params.origin || scopedPluginIds !== void 0) return {
		pluginIds: [],
		manifestRecords
	};
	return {
		pluginIds: void 0,
		manifestRecords
	};
}
function resolveBundledWebProviderCompatPluginIds(params) {
	return loadInstalledWebProviderManifestRecords(params).filter((plugin) => plugin.origin === "bundled" && (plugin.contracts?.[params.contract]?.length ?? 0) > 0).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveBundledWebProviderResolutionConfig(params) {
	const activation = resolveBundledPluginCompatibleLoadValues({
		rawConfig: params.config,
		env: params.env,
		workspaceDir: params.workspaceDir,
		applyAutoEnable: true,
		compatMode: {
			allowlist: params.config === void 0 ? false : params.bundledAllowlistCompat,
			enablement: "always",
			vitest: params.config !== void 0
		},
		resolveCompatPluginIds: (compatParams) => resolveBundledWebProviderCompatPluginIds({
			contract: params.contract,
			...compatParams
		})
	});
	return {
		config: activation.config,
		activationSourceConfig: activation.activationSourceConfig,
		autoEnabledReasons: activation.autoEnabledReasons
	};
}
function mapRegistryProviders(params) {
	const onlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(params.onlyPluginIds));
	return params.sortProviders(params.entries.filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId)).map((entry) => Object.assign({}, entry.provider, { pluginId: entry.pluginId })));
}
//#endregion
//#region src/plugins/web-fetch-providers.shared.ts
function sortWebFetchProviders(providers) {
	return sortPluginProviders(providers);
}
function sortWebFetchProvidersForAutoDetect(providers) {
	return sortPluginProvidersForAutoDetect(providers);
}
function resolveBundledWebFetchResolutionConfig(params) {
	return resolveBundledWebProviderResolutionConfig({
		contract: "webFetchProviders",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		bundledAllowlistCompat: params.bundledAllowlistCompat
	});
}
//#endregion
//#region src/plugins/web-search-providers.shared.ts
function sortWebSearchProviders(providers) {
	return sortPluginProviders(providers);
}
function sortWebSearchProvidersForAutoDetect(providers) {
	return sortPluginProvidersForAutoDetect(providers);
}
function resolveBundledWebSearchResolutionConfig(params) {
	return resolveBundledWebProviderResolutionConfig({
		contract: "webSearchProviders",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		bundledAllowlistCompat: params.bundledAllowlistCompat
	});
}
//#endregion
export { sortWebFetchProviders as a, resolveManifestDeclaredWebProviderCandidatePluginIds as c, resolveBundledWebFetchResolutionConfig as i, resolveManifestDeclaredWebProviderCandidates as l, sortWebSearchProviders as n, sortWebFetchProvidersForAutoDetect as o, sortWebSearchProvidersForAutoDetect as r, mapRegistryProviders as s, resolveBundledWebSearchResolutionConfig as t };
