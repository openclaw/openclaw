import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-CcH6lCHZ.js";
import { d as isInstalledPluginEnabled } from "./installed-plugin-index-store-WXOsBZRd.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DwerrEpn.js";
//#region src/plugins/manifest-contract-eligibility.ts
function isManifestPluginAvailableForControlPlane(params) {
	if (params.plugin.origin === "bundled") return true;
	return isInstalledPluginEnabled(params.snapshot.index, params.plugin.id, params.config);
}
function hasManifestContractValue(params) {
	const values = params.plugin.contracts?.[params.contract] ?? [];
	return values.length > 0 && (!params.value || values.includes(params.value));
}
function listAvailableManifestContractPlugins(params) {
	return params.snapshot.plugins.filter((plugin) => hasManifestContractValue({
		plugin,
		contract: params.contract,
		value: params.value
	}) && isManifestPluginAvailableForControlPlane({
		snapshot: params.snapshot,
		plugin,
		config: params.config
	}));
}
function listAvailableManifestContractValues(params) {
	const values = /* @__PURE__ */ new Set();
	for (const plugin of listAvailableManifestContractPlugins(params)) for (const value of plugin.contracts?.[params.contract] ?? []) values.add(value);
	return [...values].toSorted((left, right) => left.localeCompare(right));
}
function loadManifestContractSnapshot(params) {
	const snapshot = loadManifestMetadataSnapshot(params);
	return {
		index: snapshot.index,
		plugins: snapshot.plugins
	};
}
function loadManifestMetadataRegistry(params) {
	const snapshot = loadManifestMetadataSnapshot(params);
	return {
		index: snapshot.index,
		manifestRegistry: snapshot.manifestRegistry
	};
}
function loadManifestMetadataSnapshot(params) {
	const env = params.env ?? process.env;
	const current = getCurrentPluginMetadataSnapshot({
		config: params.config,
		env,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	if (current) return current;
	return loadPluginMetadataSnapshot({
		config: params.config ?? {},
		env,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
}
//#endregion
export { loadManifestContractSnapshot as a, listAvailableManifestContractValues as i, isManifestPluginAvailableForControlPlane as n, loadManifestMetadataRegistry as o, listAvailableManifestContractPlugins as r, loadManifestMetadataSnapshot as s, hasManifestContractValue as t };
