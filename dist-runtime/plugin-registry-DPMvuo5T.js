import { t as createSubsystemLogger } from "./subsystem-EnljYYs1.js";
import { Bb as loadConfig, Q as loadOpenClawPlugins } from "./auth-profiles-DqxBs6Au.js";
import { u as getActivePluginRegistry } from "./registry-DrRO3PZ7.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-tkfLX5MZ.js";
import { n as resolveConfiguredChannelPluginIds, t as resolveChannelPluginIds } from "./channel-plugin-ids-DDJhum8r.js";
//#region src/cli/plugin-registry.ts
const log = createSubsystemLogger("plugins");
let pluginRegistryLoaded = "none";
function scopeRank(scope) {
	switch (scope) {
		case "none": return 0;
		case "configured-channels": return 1;
		case "channels": return 2;
		case "all": return 3;
	}
}
function ensurePluginRegistryLoaded(options) {
	const scope = options?.scope ?? "all";
	if (scopeRank(pluginRegistryLoaded) >= scopeRank(scope)) {return;}
	const active = getActivePluginRegistry();
	if (pluginRegistryLoaded === "none" && active && (active.plugins.length > 0 || active.channels.length > 0 || active.tools.length > 0)) {
		pluginRegistryLoaded = "all";
		return;
	}
	const config = loadConfig();
	const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
	loadOpenClawPlugins({
		config,
		workspaceDir,
		logger: {
			info: (msg) => log.info(msg),
			warn: (msg) => log.warn(msg),
			error: (msg) => log.error(msg),
			debug: (msg) => log.debug(msg)
		},
		...scope === "configured-channels" ? { onlyPluginIds: resolveConfiguredChannelPluginIds({
			config,
			workspaceDir,
			env: process.env
		}) } : scope === "channels" ? { onlyPluginIds: resolveChannelPluginIds({
			config,
			workspaceDir,
			env: process.env
		}) } : {}
	});
	pluginRegistryLoaded = scope;
}
//#endregion
export { ensurePluginRegistryLoaded as t };
