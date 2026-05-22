import { t as definePluginEntry } from "../../plugin-entry-BzwFWtB2.js";
import { i as registerBrowserPlugin, n as browserPluginReload, r as browserSecurityAuditCollectors, t as browserPluginNodeHostCommands } from "../../plugin-registration-C5I70S2w.js";
//#region extensions/browser/index.ts
var browser_default = definePluginEntry({
	id: "browser",
	name: "Browser",
	description: "Default browser tool plugin",
	reload: browserPluginReload,
	nodeHostCommands: browserPluginNodeHostCommands,
	securityAuditCollectors: [...browserSecurityAuditCollectors],
	register: registerBrowserPlugin
});
//#endregion
export { browser_default as default };
