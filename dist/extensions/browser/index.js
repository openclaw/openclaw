import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { i as registerBrowserPlugin, n as browserPluginReload, r as browserSecurityAuditCollectors, t as browserPluginNodeHostCommands } from "../../plugin-registration-BM5pWCYl.js";
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
