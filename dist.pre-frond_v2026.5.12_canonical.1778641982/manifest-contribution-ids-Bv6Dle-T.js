import { p as loadPluginRegistrySnapshot, t as listPluginContributionIds } from "./plugin-registry-Cut-MFnk.js";
//#region src/plugins/manifest-contribution-ids.ts
function listManifestContributionIds(params) {
	const env = params.env ?? process.env;
	return listPluginContributionIds({
		index: params.index ?? loadPluginRegistrySnapshot({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env,
			candidates: params.candidates,
			preferPersisted: params.preferPersisted
		}),
		contribution: params.contribution,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env,
		includeDisabled: params.includeDisabled
	});
}
function listManifestChannelContributionIds(params = {}) {
	return listManifestContributionIds({
		...params,
		contribution: "channels"
	});
}
//#endregion
export { listManifestChannelContributionIds as t };
