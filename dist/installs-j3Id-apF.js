import { t as buildNpmResolutionFields } from "./install-source-utils-BA9AHTyU.js";
//#region src/plugins/installs.ts
function buildNpmResolutionInstallFields(resolution) {
	return buildNpmResolutionFields(resolution);
}
function recordPluginInstall(cfg, update) {
	const { pluginId, ...record } = update;
	const installs = {
		...cfg.plugins?.installs,
		[pluginId]: {
			...cfg.plugins?.installs?.[pluginId],
			...record,
			installedAt: record.installedAt ?? (/* @__PURE__ */ new Date()).toISOString()
		}
	};
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			installs: {
				...installs,
				[pluginId]: installs[pluginId]
			}
		}
	};
}
//#endregion
export { recordPluginInstall as n, buildNpmResolutionInstallFields as t };
