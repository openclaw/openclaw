import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { gt as loadOpenClawPlugins } from "./reply-D8YvfZps.js";
import { d as resolveDefaultAgentId, u as resolveAgentWorkspaceDir } from "./agent-scope-D8K2SjR7.js";
import { E as getActivePluginRegistry, t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";

//#region src/cli/plugin-registry.ts
var plugin_registry_exports = /* @__PURE__ */ __exportAll({ ensurePluginRegistryLoaded: () => ensurePluginRegistryLoaded });
const log = createSubsystemLogger("plugins");
let pluginRegistryLoaded = false;
function ensurePluginRegistryLoaded() {
	if (pluginRegistryLoaded) return;
	const active = getActivePluginRegistry();
	if (active && (active.plugins.length > 0 || active.channels.length > 0 || active.tools.length > 0)) {
		pluginRegistryLoaded = true;
		return;
	}
	const config = loadConfig();
	loadOpenClawPlugins({
		config,
		workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
		logger: {
			info: (msg) => log.info(msg),
			warn: (msg) => log.warn(msg),
			error: (msg) => log.error(msg),
			debug: (msg) => log.debug(msg)
		}
	});
	pluginRegistryLoaded = true;
}

//#endregion
export { plugin_registry_exports as n, ensurePluginRegistryLoaded as t };