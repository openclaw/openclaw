import { a as resolvePluginControlPlaneFingerprint } from "./plugin-metadata-snapshot-rXHPD8HR.js";
import { c as getCurrentPluginMetadataSnapshotState, g as resolveInstalledPluginIndexPolicyHash, l as setCurrentPluginMetadataSnapshotState, s as clearCurrentPluginMetadataSnapshotState } from "./installed-plugin-index-store-WXOsBZRd.js";
//#region src/plugins/current-plugin-metadata-snapshot.ts
function resolvePluginMetadataControlPlaneFingerprint(config, options = {}) {
	return resolvePluginControlPlaneFingerprint({
		config,
		...options
	});
}
function setCurrentPluginMetadataSnapshot(snapshot, options = {}) {
	setCurrentPluginMetadataSnapshotState(snapshot, snapshot ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
		env: options.env,
		index: snapshot.index,
		policyHash: snapshot.policyHash,
		workspaceDir: options.workspaceDir ?? snapshot.workspaceDir
	}) : void 0);
}
function clearCurrentPluginMetadataSnapshot() {
	clearCurrentPluginMetadataSnapshotState();
}
function getCurrentPluginMetadataSnapshot(params = {}) {
	const { snapshot: rawSnapshot, configFingerprint } = getCurrentPluginMetadataSnapshotState();
	const snapshot = rawSnapshot;
	if (!snapshot) return;
	if (params.config && snapshot.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)) return;
	if (params.config) {
		const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
			env: params.env,
			index: snapshot.index,
			policyHash: snapshot.policyHash,
			workspaceDir: params.workspaceDir
		});
		if (configFingerprint && configFingerprint !== requestedConfigFingerprint) return;
		if (snapshot.configFingerprint && snapshot.configFingerprint !== requestedConfigFingerprint) return;
	}
	if (snapshot.workspaceDir !== void 0 && params.workspaceDir === void 0) return;
	if (params.workspaceDir !== void 0 && (snapshot.workspaceDir ?? "") !== (params.workspaceDir ?? "")) return;
	return snapshot;
}
//#endregion
export { getCurrentPluginMetadataSnapshot as n, setCurrentPluginMetadataSnapshot as r, clearCurrentPluginMetadataSnapshot as t };
