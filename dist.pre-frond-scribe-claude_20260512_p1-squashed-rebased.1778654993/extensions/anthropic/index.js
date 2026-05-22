import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { n as registerAnthropicPlugin } from "../../register.runtime-nS8Q1hX_.js";
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
