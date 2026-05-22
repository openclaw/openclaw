import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import { t as buildAnthropicCliBackend } from "../../cli-backend-CXEODXqp.js";
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
