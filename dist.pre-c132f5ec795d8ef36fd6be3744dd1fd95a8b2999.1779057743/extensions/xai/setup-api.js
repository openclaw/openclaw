import { c as isRecord } from "../../utils-CpmNtyoq.js";
import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import "../../tool-config-shared-DVdE0_2q.js";
//#region extensions/xai/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "xai",
	name: "xAI Setup",
	description: "Lightweight xAI setup hooks",
	register(api) {
		api.registerAutoEnableProbe(({ config }) => {
			const pluginConfig = config.plugins?.entries?.xai?.config;
			const web = config.tools?.web;
			if (isRecord(web?.x_search) || isRecord(pluginConfig) && (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))) return "xai tool configured";
			return null;
		});
	}
});
//#endregion
export { setup_api_default as default };
