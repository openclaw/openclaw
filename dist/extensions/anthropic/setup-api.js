import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as buildAnthropicCliBackend } from "../../cli-backend-C20Lx4wR.js";
//#region extensions/anthropic/setup-api.ts
var setup_api_default = definePluginEntry({
	id: "anthropic",
	name: "Anthropic Setup",
	description: "Lightweight Anthropic setup hooks",
	register(api) {
		api.registerCliBackend(buildAnthropicCliBackend());
	}
});
//#endregion
export { setup_api_default as default };
