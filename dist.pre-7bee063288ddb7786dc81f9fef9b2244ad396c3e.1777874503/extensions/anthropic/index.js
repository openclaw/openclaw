import { t as definePluginEntry } from "../../plugin-entry-BzwFWtB2.js";
import { n as registerAnthropicPlugin } from "../../register.runtime-Cbw6humO.js";
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
