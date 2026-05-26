import { f as shouldRejectHardlinkedPluginFiles, t as discoverOpenClawPlugins } from "./discovery-GEDtU7uI.js";
import { n as loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { i as loadPluginManifest } from "./manifest-Cyo7Vmnr.js";
//#region src/plugins/channel-catalog-registry.ts
function listChannelCatalogEntries(params = {}) {
	const installRecords = resolveInstallRecords(params);
	return (params.discovery ?? discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		env: params.env,
		...installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}
	})).candidates.flatMap((candidate) => {
		if (params.origin && candidate.origin !== params.origin) return [];
		const channel = candidate.packageManifest?.channel;
		if (!channel?.id) return [];
		const manifest = loadPluginManifest(candidate.rootDir, shouldRejectHardlinkedPluginFiles({
			origin: candidate.origin,
			rootDir: candidate.rootDir,
			env: params.env
		}));
		if (!manifest.ok) return [];
		return [{
			pluginId: manifest.manifest.id,
			origin: candidate.origin,
			packageName: candidate.packageName,
			workspaceDir: candidate.workspaceDir,
			rootDir: candidate.rootDir,
			channel,
			...candidate.packageManifest?.install ? { install: candidate.packageManifest.install } : {}
		}];
	});
}
function resolveInstallRecords(params) {
	if (params.installRecords) return params.installRecords;
	if (params.origin === "bundled") return;
	try {
		return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
	} catch {
		return;
	}
}
//#endregion
export { listChannelCatalogEntries as t };
