import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as buildFalImageGenerationProvider } from "../../image-generation-provider-BkOEY9Au.js";
import { t as buildFalMusicGenerationProvider } from "../../music-generation-provider-M061uWRi.js";
import { t as createFalProvider } from "../../provider-registration-ws9JJua8.js";
import { t as buildFalVideoGenerationProvider } from "../../video-generation-provider-CmxsDRCF.js";
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
