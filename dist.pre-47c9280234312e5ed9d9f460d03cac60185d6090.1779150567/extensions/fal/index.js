import { t as definePluginEntry } from "../../plugin-entry-CCu4Tzpv.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-Cy_mJoxJ.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-BgT9kZUp.js";
import { t as createFalProvider } from "../../provider-registration-BCafkZoc.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-CL2eORn4.js";
var fal_default = definePluginEntry({
	id: "fal",
	name: "fal Provider",
	description: "Bundled fal image, video, and music generation provider",
	register(api) {
		api.registerProvider(createFalProvider());
		api.registerImageGenerationProvider(buildFalImageGenerationProvider());
		api.registerMusicGenerationProvider(buildFalMusicGenerationProvider());
		api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
	}
});
//#endregion
export { fal_default as default };
