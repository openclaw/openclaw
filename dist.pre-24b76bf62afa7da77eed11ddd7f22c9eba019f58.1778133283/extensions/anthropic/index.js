import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { n as registerAnthropicPlugin } from "../../register.runtime-CEVB5lQG.js";
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
