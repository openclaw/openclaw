import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-D_6kqRly.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
//#region extensions/acpx/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "acpx",
	name: "ACPX Setup",
	description: "Lightweight ACPX setup hooks",
	register(api) {
		api.registerAutoEnableProbe(({ config }) => {
			const backendRaw = normalizeLowercaseStringOrEmpty(config.acp?.backend);
			return (config.acp?.enabled === true || config.acp?.dispatch?.enabled === true || backendRaw === "acpx") && (!backendRaw || backendRaw === "acpx") ? "ACP runtime configured" : null;
		});
	}
});
//#endregion
export { setup_api_default as default };
