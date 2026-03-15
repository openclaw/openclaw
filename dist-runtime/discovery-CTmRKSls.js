import { XS as listChannelPluginCatalogEntries } from "./auth-profiles-DqxBs6Au.js";
import { o as listChatChannels } from "./registry-DrRO3PZ7.js";
import { n as loadPluginManifestRegistry } from "./manifest-registry-CA0yK887.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-tkfLX5MZ.js";
//#region src/commands/channel-setup/discovery.ts
function resolveWorkspaceDir(cfg, workspaceDir) {
	return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}
function listManifestInstalledChannelIds(params) {
	const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
	return new Set(loadPluginManifestRegistry({
		config: params.cfg,
		workspaceDir,
		env: params.env ?? process.env
	}).plugins.flatMap((plugin) => plugin.channels));
}
function isCatalogChannelInstalled(params) {
	return listManifestInstalledChannelIds(params).has(params.entry.id);
}
function resolveChannelSetupEntries(params) {
	const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
	const manifestInstalledIds = listManifestInstalledChannelIds({
		cfg: params.cfg,
		workspaceDir,
		env: params.env
	});
	const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
	const catalogEntries = listChannelPluginCatalogEntries({ workspaceDir });
	const installedCatalogEntries = catalogEntries.filter((entry) => !installedPluginIds.has(entry.id) && manifestInstalledIds.has(entry.id));
	const installableCatalogEntries = catalogEntries.filter((entry) => !installedPluginIds.has(entry.id) && !manifestInstalledIds.has(entry.id));
	const metaById = /* @__PURE__ */ new Map();
	for (const meta of listChatChannels()) {metaById.set(meta.id, meta);}
	for (const plugin of params.installedPlugins) {metaById.set(plugin.id, plugin.meta);}
	for (const entry of installedCatalogEntries) {if (!metaById.has(entry.id)) metaById.set(entry.id, entry.meta);}
	for (const entry of installableCatalogEntries) {if (!metaById.has(entry.id)) metaById.set(entry.id, entry.meta);}
	return {
		entries: Array.from(metaById, ([id, meta]) => ({
			id,
			meta
		})),
		installedCatalogEntries,
		installableCatalogEntries,
		installedCatalogById: new Map(installedCatalogEntries.map((entry) => [entry.id, entry])),
		installableCatalogById: new Map(installableCatalogEntries.map((entry) => [entry.id, entry]))
	};
}
//#endregion
export { resolveChannelSetupEntries as n, isCatalogChannelInstalled as t };
