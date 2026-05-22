import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-Un-11gdB.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-H1775Ucg.js";
import { t as createFalProvider } from "../../provider-registration-8vpYOip-.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-CsNoxV5m.js";
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
