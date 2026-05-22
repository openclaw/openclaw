import { t as definePluginEntry } from "../../plugin-entry-CvekifYj.js";
import { t as buildRunwayVideoGenerationProvider } from "../../video-generation-provider-D3aYCnMi.js";
//#region extensions/runway/index.ts
var runway_default = definePluginEntry({
	id: "runway",
	name: "Runway Provider",
	description: "Bundled Runway video provider plugin",
	register(api) {
		api.registerVideoGenerationProvider(buildRunwayVideoGenerationProvider());
	}
});
//#endregion
export { runway_default as default };
