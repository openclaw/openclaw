import { s as normalizeOptionalLowercaseString } from "../../string-coerce-LndEvhRk.js";
import { c as isRecord } from "../../utils-CKsuXgDI.js";
import "../../string-coerce-runtime-Ce59bOpy.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import "../../record-shared-D7kDFrbc.js";
//#region extensions/browser/setup-api.ts
function listContainsBrowser(value) {
	return Array.isArray(value) && value.some((entry) => normalizeOptionalLowercaseString(entry) === "browser");
}
function toolPolicyReferencesBrowser(value) {
	return isRecord(value) && (listContainsBrowser(value.allow) || listContainsBrowser(value.alsoAllow));
}
function hasBrowserToolReference(config) {
	if (toolPolicyReferencesBrowser(config.tools)) return true;
	const agentList = config.agents?.list;
	return Array.isArray(agentList) ? agentList.some((entry) => isRecord(entry) && toolPolicyReferencesBrowser(entry.tools)) : false;
}
var setup_api_default = definePluginEntry({
	id: "browser",
	name: "Browser Setup",
	description: "Lightweight Browser setup hooks",
	register(api) {
		api.registerAutoEnableProbe(({ config }) => {
			if (config.browser?.enabled === false || config.plugins?.entries?.browser?.enabled === false) return null;
			if (Object.prototype.hasOwnProperty.call(config, "browser")) return "browser configured";
			if (config.plugins?.entries && Object.prototype.hasOwnProperty.call(config.plugins.entries, "browser")) return "browser plugin configured";
			if (hasBrowserToolReference(config)) return "browser tool referenced";
			return null;
		});
	}
});
//#endregion
export { setup_api_default as default };
