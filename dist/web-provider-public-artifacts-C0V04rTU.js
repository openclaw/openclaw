import { o as normalizePluginId } from "./config-state-CjJBf8PG.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as resolveBundledExplicitWebSearchProvidersFromPublicArtifacts, n as loadBundledWebSearchProviderEntriesFromDir, r as resolveBundledExplicitWebFetchProvidersFromPublicArtifacts, t as loadBundledWebFetchProviderEntriesFromDir } from "./web-provider-public-artifacts.explicit-BwvGaIk_.js";
import { i as resolveBundledWebFetchResolutionConfig, l as resolveManifestDeclaredWebProviderCandidates, t as resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared-C_XvZwgr.js";
import path from "node:path";
//#region src/plugins/web-provider-public-artifacts.ts
function filterAllowlistedBundledPluginIds(config, pluginIds) {
	const allow = config?.plugins?.allow;
	if (config?.plugins?.bundledDiscovery === "compat" || !Array.isArray(allow) || allow.length === 0) return [...pluginIds];
	const allowedPluginIds = new Set(allow.map((pluginId) => normalizePluginId(pluginId)).filter(Boolean));
	return pluginIds.filter((pluginId) => allowedPluginIds.has(pluginId));
}
function resolveBundledCandidatePluginIds(params) {
	if (params.onlyPluginIds !== void 0) return { pluginIds: filterAllowlistedBundledPluginIds(params.config, [...new Set(params.onlyPluginIds)]).toSorted((left, right) => left.localeCompare(right)) };
	const resolvedConfig = params.contract === "webSearchProviders" ? resolveBundledWebSearchResolutionConfig(params).config : resolveBundledWebFetchResolutionConfig(params).config;
	const candidates = resolveManifestDeclaredWebProviderCandidates({
		contract: params.contract,
		configKey: params.configKey,
		config: resolvedConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
		onlyPluginIds: params.onlyPluginIds,
		origin: "bundled"
	});
	return {
		pluginIds: filterAllowlistedBundledPluginIds(resolvedConfig, candidates.pluginIds ?? []),
		...candidates.manifestRecords ? { manifestRecords: candidates.manifestRecords } : {}
	};
}
function resolveBundledManifestRecordsByPluginId(params) {
	const allowedPluginIds = new Set(params.onlyPluginIds);
	const manifestRecords = params.manifestRecords ?? loadManifestMetadataSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).plugins;
	return new Map(manifestRecords.filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id)).map((record) => [record.id, record]));
}
function resolveBundledWebSearchProvidersFromPublicArtifacts(params) {
	const pluginIds = resolveBundledCandidatePluginIds({
		contract: "webSearchProviders",
		configKey: "webSearch",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		bundledAllowlistCompat: params.bundledAllowlistCompat,
		onlyPluginIds: params.onlyPluginIds
	});
	if (pluginIds.pluginIds.length === 0) return [];
	const directProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({ onlyPluginIds: pluginIds.pluginIds });
	if (directProviders) return directProviders;
	const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		onlyPluginIds: pluginIds.pluginIds,
		manifestRecords: pluginIds.manifestRecords
	});
	const providers = [];
	for (const pluginId of pluginIds.pluginIds) {
		const record = recordsByPluginId.get(pluginId);
		if (!record) return null;
		const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
			dirName: path.basename(record.rootDir),
			pluginId
		});
		if (!loadedProviders) return null;
		providers.push(...loadedProviders);
	}
	return providers;
}
function resolveBundledWebFetchProvidersFromPublicArtifacts(params) {
	const pluginIds = resolveBundledCandidatePluginIds({
		contract: "webFetchProviders",
		configKey: "webFetch",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		bundledAllowlistCompat: params.bundledAllowlistCompat,
		onlyPluginIds: params.onlyPluginIds
	});
	if (pluginIds.pluginIds.length === 0) return [];
	const directProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({ onlyPluginIds: pluginIds.pluginIds });
	if (directProviders) return directProviders;
	const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		onlyPluginIds: pluginIds.pluginIds,
		manifestRecords: pluginIds.manifestRecords
	});
	const providers = [];
	for (const pluginId of pluginIds.pluginIds) {
		const record = recordsByPluginId.get(pluginId);
		if (!record) return null;
		const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
			dirName: path.basename(record.rootDir),
			pluginId
		});
		if (!loadedProviders) return null;
		providers.push(...loadedProviders);
	}
	return providers;
}
//#endregion
export { resolveBundledWebSearchProvidersFromPublicArtifacts as n, resolveBundledWebFetchProvidersFromPublicArtifacts as t };
