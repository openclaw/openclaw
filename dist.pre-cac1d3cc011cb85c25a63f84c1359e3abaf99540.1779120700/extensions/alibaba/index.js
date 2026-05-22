import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { t as buildAlibabaVideoGenerationProvider } from "../../video-generation-provider-BV4qYyV-.js";
//#region extensions/alibaba/index.ts
var alibaba_default = definePluginEntry({
	id: "alibaba",
	name: "Alibaba Model Studio Plugin",
	description: "Bundled Alibaba Model Studio video provider plugin",
	register(api) {
		api.registerVideoGenerationProvider(buildAlibabaVideoGenerationProvider());
	}
});
//#endregion
export { alibaba_default as default };
