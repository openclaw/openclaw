import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-yRH2xD-5.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-2cFc17rL.js";
import { t as createFalProvider } from "../../provider-registration-Bgr3i6SC.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-ZgLML3ho.js";
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
