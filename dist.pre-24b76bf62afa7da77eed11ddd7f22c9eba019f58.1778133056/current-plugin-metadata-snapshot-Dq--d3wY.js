import { a as resolvePluginControlPlaneFingerprint } from "./plugin-metadata-snapshot-BENAkAnN.js";
import { _ as resolveInstalledPluginIndexPolicyHash, c as getCurrentPluginMetadataSnapshotState, l as setCurrentPluginMetadataSnapshotState, s as clearCurrentPluginMetadataSnapshotState } from "./installed-plugin-index-store-D3X0T5Yi.js";
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
	const requestedWorkspaceDir = params.workspaceDir ?? (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : void 0);
	if (params.config) {
		const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
			env: params.env,
			index: snapshot.index,
			policyHash: snapshot.policyHash,
			workspaceDir: requestedWorkspaceDir
		});
		if (configFingerprint && configFingerprint !== requestedConfigFingerprint) return;
		if (snapshot.configFingerprint && snapshot.configFingerprint !== requestedConfigFingerprint) return;
	}
	if (snapshot.workspaceDir !== void 0 && requestedWorkspaceDir === void 0) return;
	if (requestedWorkspaceDir !== void 0 && (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")) return;
	return snapshot;
}
//#endregion
export { getCurrentPluginMetadataSnapshot as n, setCurrentPluginMetadataSnapshot as r, clearCurrentPluginMetadataSnapshot as t };
