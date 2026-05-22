import { t as definePluginEntry } from "../../plugin-entry-CvekifYj.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-w3EJH3Gu.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-CERT3B_y.js";
import { t as createFalProvider } from "../../provider-registration-BQBbQp98.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-Be_rPgSy.js";
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
