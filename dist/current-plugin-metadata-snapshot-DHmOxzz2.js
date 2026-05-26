import { a as resolvePluginControlPlaneFingerprint } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { _ as resolveInstalledPluginIndexPolicyHash, c as getCurrentPluginMetadataSnapshotState, l as setCurrentPluginMetadataSnapshotState, s as clearCurrentPluginMetadataSnapshotState } from "./installed-plugin-index-store-DetkjvO9.js";
//#region src/plugins/current-plugin-metadata-snapshot.ts
function resolvePluginMetadataControlPlaneFingerprint(config, options = {}) {
	return resolvePluginControlPlaneFingerprint({
		config,
		...options
	});
}
function setCurrentPluginMetadataSnapshot(snapshot, options = {}) {
	const compatiblePolicyHashes = snapshot ? options.compatibleConfigs?.map((config) => resolveInstalledPluginIndexPolicyHash(config)) : void 0;
	const compatibleConfigFingerprints = snapshot ? options.compatibleConfigs?.map((config, index) => resolvePluginMetadataControlPlaneFingerprint(config, {
		env: options.env,
		index: snapshot.index,
		policyHash: compatiblePolicyHashes?.[index],
		workspaceDir: options.workspaceDir ?? snapshot.workspaceDir
	})) : void 0;
	setCurrentPluginMetadataSnapshotState(snapshot, snapshot ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
		env: options.env,
		index: snapshot.index,
		policyHash: snapshot.policyHash,
		workspaceDir: options.workspaceDir ?? snapshot.workspaceDir
	}) : void 0, compatiblePolicyHashes, compatibleConfigFingerprints);
}
function clearCurrentPluginMetadataSnapshot() {
	clearCurrentPluginMetadataSnapshotState();
}
function getCurrentPluginMetadataSnapshot(params = {}) {
	const { snapshot: rawSnapshot, configFingerprint, compatiblePolicyHashes, compatibleConfigFingerprints } = getCurrentPluginMetadataSnapshotState();
	const snapshot = rawSnapshot;
	if (!snapshot) return;
	const requestedPolicyHash = params.config ? resolveInstalledPluginIndexPolicyHash(params.config) : void 0;
	if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
		if (!new Set(compatiblePolicyHashes ?? []).has(requestedPolicyHash)) return;
	}
	const requestedWorkspaceDir = params.workspaceDir ?? (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : void 0);
	if (params.config) {
		const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
			env: params.env,
			index: snapshot.index,
			policyHash: requestedPolicyHash,
			workspaceDir: requestedWorkspaceDir
		});
		const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
		if (!(configFingerprint === requestedConfigFingerprint || snapshot.configFingerprint === requestedConfigFingerprint || compatibleFingerprints.has(requestedConfigFingerprint))) return;
	}
	if (params.requireDefaultDiscoveryContext === true) {
		const defaultDiscoveryConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint({}, {
			env: params.env,
			index: snapshot.index,
			policyHash: snapshot.policyHash,
			workspaceDir: requestedWorkspaceDir
		});
		const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
		if (!(configFingerprint === defaultDiscoveryConfigFingerprint || snapshot.configFingerprint === defaultDiscoveryConfigFingerprint || compatibleFingerprints.has(defaultDiscoveryConfigFingerprint))) return;
	}
	if (snapshot.workspaceDir !== void 0 && requestedWorkspaceDir === void 0) return;
	if (requestedWorkspaceDir !== void 0 && (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")) return;
	return snapshot;
}
//#endregion
export { getCurrentPluginMetadataSnapshot as n, setCurrentPluginMetadataSnapshot as r, clearCurrentPluginMetadataSnapshot as t };
