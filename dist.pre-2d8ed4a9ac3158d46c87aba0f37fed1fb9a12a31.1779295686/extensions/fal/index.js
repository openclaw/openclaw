import { t as definePluginEntry } from "../../plugin-entry-BW8FQC_w.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-ooWQBzBR.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-DRmMVw4V.js";
import { t as createFalProvider } from "../../provider-registration-Cc_JyDMd.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-itfAIMl2.js";
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
