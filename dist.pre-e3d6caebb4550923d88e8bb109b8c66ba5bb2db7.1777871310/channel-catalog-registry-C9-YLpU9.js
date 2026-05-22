import { t as discoverOpenClawPlugins, w as loadPluginManifest } from "./discovery-B19Xdk1_.js";
//#region src/plugins/channel-catalog-registry.ts
function listChannelCatalogEntries(params = {}) {
	return discoverOpenClawPlugins({
		workspaceDir: params.workspaceDir,
		env: params.env
	}).candidates.flatMap((candidate) => {
		if (params.origin && candidate.origin !== params.origin) return [];
		const channel = candidate.packageManifest?.channel;
		if (!channel?.id) return [];
		const manifest = loadPluginManifest(candidate.rootDir, candidate.origin !== "bundled");
		if (!manifest.ok) return [];
		return [{
			pluginId: manifest.manifest.id,
			origin: candidate.origin,
			packageName: candidate.packageName,
			packageVersion: candidate.packageVersion,
			workspaceDir: candidate.workspaceDir,
			rootDir: candidate.rootDir,
			channel,
			...candidate.packageManifest?.install ? { install: candidate.packageManifest.install } : {}
		}];
	});
}
//#endregion
export { listChannelCatalogEntries as t };
