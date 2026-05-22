import { t as definePluginEntry } from "../../plugin-entry-qhhTPsFQ.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-DK0me_ff.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-LOtryJT1.js";
import { t as createFalProvider } from "../../provider-registration-DhSpLxfB.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DExHJ1G8.js";
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
