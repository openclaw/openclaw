import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { n as registerAnthropicPlugin } from "../../register.runtime-CR-c-hRh.js";
//#region extensions/anthropic/index.ts
var anthropic_default = definePluginEntry({
	id: "anthropic",
	name: "Anthropic Provider",
	description: "Bundled Anthropic provider plugin",
	register(api) {
		return registerAnthropicPlugin(api);
	}
});
//#endregion
export { anthropic_default as default };
