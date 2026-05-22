import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import "../../text-runtime-FOsx_CPC.js";
import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
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
