import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { n as registerAnthropicPlugin } from "../../register.runtime-DBep8hMt.js";
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
