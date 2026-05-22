import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-BYOPmKgw.js";
import { t as createFalProvider } from "../../provider-registration-dKD6bMvS.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-wSufiErs.js";
var fal_default = definePluginEntry({
	id: "fal",
	name: "fal Provider",
	description: "Bundled fal image and video generation provider",
	register(api) {
		api.registerProvider(createFalProvider());
		api.registerImageGenerationProvider(buildFalImageGenerationProvider());
		api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
	}
});
//#endregion
export { fal_default as default };
