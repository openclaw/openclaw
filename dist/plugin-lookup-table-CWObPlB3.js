import { i as loadPluginMetadataSnapshot, n as isPluginMetadataSnapshotCompatible } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { y as hashJson } from "./installed-plugin-index-store-C1Oen9wR.js";
import { c as resolveGatewayStartupPluginPlanFromRegistry } from "./channel-plugin-ids-nB-ga3MN.js";
//#region src/plugins/plugin-lookup-table.ts
function loadPluginLookUpTable(params) {
	const requestedSnapshotConfig = params.activationSourceConfig ?? params.config;
	const metadataSnapshot = params.metadataSnapshot && isPluginMetadataSnapshotCompatible({
		snapshot: params.metadataSnapshot,
		config: requestedSnapshotConfig,
		env: params.env,
		workspaceDir: params.workspaceDir,
		index: params.index
	}) ? params.metadataSnapshot : loadPluginMetadataSnapshot({
		config: requestedSnapshotConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
		...params.index ? { index: params.index } : {}
	});
	const { index, manifestRegistry } = metadataSnapshot;
	const startupPlanStartedAt = performance.now();
	const startup = resolveGatewayStartupPluginPlanFromRegistry({
		config: params.config,
		...params.activationSourceConfig !== void 0 ? { activationSourceConfig: params.activationSourceConfig } : {},
		env: params.env,
		index,
		manifestRegistry
	});
	const startupPlanMs = performance.now() - startupPlanStartedAt;
	return {
		...metadataSnapshot,
		key: hashJson({
			policyHash: index.policyHash,
			generatedAtMs: index.generatedAtMs,
			plugins: index.plugins.map((plugin) => [
				plugin.pluginId,
				plugin.manifestHash,
				plugin.installRecordHash
			]),
			startup
		}),
		startup,
		metrics: {
			...metadataSnapshot.metrics,
			startupPlanMs,
			totalMs: metadataSnapshot.metrics.totalMs + startupPlanMs,
			startupPluginCount: startup.pluginIds.length,
			deferredChannelPluginCount: startup.configuredDeferredChannelPluginIds.length
		}
	};
}
//#endregion
export { loadPluginLookUpTable as t };
