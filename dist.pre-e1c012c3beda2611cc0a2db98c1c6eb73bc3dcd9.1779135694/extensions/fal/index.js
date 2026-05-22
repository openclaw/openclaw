import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-DgiH2Wg3.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-IN01v_1F.js";
import { t as createFalProvider } from "../../provider-registration-DFr0LDnQ.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-D1ntlf87.js";
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
