import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-DYciFJlN.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-BZPeeXp6.js";
import { t as createFalProvider } from "../../provider-registration-4IV-2Ud7.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-DJkuYTOb.js";
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
