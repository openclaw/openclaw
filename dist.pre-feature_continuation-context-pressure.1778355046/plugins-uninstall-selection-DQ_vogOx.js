import { t as parseClawHubPluginSpec } from "./clawhub-spec-CIPRxT8T.js";
//#region src/cli/plugins-uninstall-selection.ts
function resolvePluginUninstallId(params) {
	const rawId = params.rawId.trim();
	const plugin = params.plugins.find((entry) => entry.id === rawId || entry.name === rawId);
	if (plugin) return {
		pluginId: plugin.id,
		plugin
	};
	for (const [pluginId, install] of Object.entries(params.config.plugins?.installs ?? {})) if (install.spec === rawId || install.resolvedSpec === rawId || install.resolvedName === rawId || install.marketplacePlugin === rawId) return { pluginId };
	const requestedClawHub = parseClawHubPluginSpec(rawId);
	if (requestedClawHub) {
		for (const [pluginId, install] of Object.entries(params.config.plugins?.installs ?? {})) if ((install.clawhubPackage ?? parseClawHubPluginSpec(install.spec ?? "")?.name ?? parseClawHubPluginSpec(install.resolvedSpec ?? "")?.name) === requestedClawHub.name) return { pluginId };
	}
	return { pluginId: rawId };
}
//#endregion
export { resolvePluginUninstallId };
