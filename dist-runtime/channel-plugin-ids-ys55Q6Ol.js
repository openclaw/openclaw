import { ZS as listPotentialConfiguredChannelIds } from "./auth-profiles-DAOR1fRn.js";
import { n as loadPluginManifestRegistry } from "./manifest-registry-DZywV-kg.js";
//#region src/plugins/channel-plugin-ids.ts
function resolveChannelPluginIds(params) {
	return loadPluginManifestRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).plugins.filter((plugin) => plugin.channels.length > 0).map((plugin) => plugin.id);
}
function resolveConfiguredChannelPluginIds(params) {
	const configuredChannelIds = new Set(listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()));
	if (configuredChannelIds.size === 0) return [];
	return resolveChannelPluginIds(params).filter((pluginId) => configuredChannelIds.has(pluginId));
}
function resolveConfiguredDeferredChannelPluginIds(params) {
	const configuredChannelIds = new Set(listPotentialConfiguredChannelIds(params.config, params.env).map((id) => id.trim()));
	if (configuredChannelIds.size === 0) return [];
	return loadPluginManifestRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).plugins.filter((plugin) => plugin.channels.some((channelId) => configuredChannelIds.has(channelId)) && plugin.startupDeferConfiguredChannelFullLoadUntilAfterListen === true).map((plugin) => plugin.id);
}
//#endregion
export { resolveConfiguredChannelPluginIds as n, resolveConfiguredDeferredChannelPluginIds as r, resolveChannelPluginIds as t };
