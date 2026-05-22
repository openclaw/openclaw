import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-C3dEiJRc.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-Nft80h8d.js";
import { t as createFalProvider } from "../../provider-registration-CODv2p5U.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-BUmZakk0.js";
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
