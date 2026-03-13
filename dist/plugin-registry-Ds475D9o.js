import { t as __exportAll } from "./rolldown-runtime-DUslC3ob.js";
import { t as createSubsystemLogger } from "./subsystem-DVwhOlEq.js";
import { z as loadOpenClawPlugins, zg as loadConfig } from "./auth-profiles-CAw5gP6f.js";
import { d as resolveAgentWorkspaceDir, f as resolveDefaultAgentId } from "./agent-scope-DBEC2O3x.js";
import { u as getActivePluginRegistry } from "./registry-B23eaqdH.js";
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
