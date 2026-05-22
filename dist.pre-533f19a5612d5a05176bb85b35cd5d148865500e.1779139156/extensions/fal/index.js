import { t as definePluginEntry } from "../../plugin-entry-DPwMZz_-.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-CgXWZ6ib.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-BmFr8U8U.js";
import { t as createFalProvider } from "../../provider-registration-B3N0YZBs.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-BMg45ANK.js";
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
