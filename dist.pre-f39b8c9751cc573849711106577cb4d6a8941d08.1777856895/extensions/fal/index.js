import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-Bej1Rbq4.js";
import { t as createFalProvider } from "../../provider-registration-lHJWvzqe.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-iJu7Q1CE.js";
var fal_default = definePluginEntry({
	id: "fal",
	name: "fal Provider",
	description: "Bundled fal image and video generation provider",
	register(api) {
		api.registerProvider(createFalProvider());
		api.registerImageGenerationProvider(buildFalImageGenerationProvider());
		api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
	}
});
//#endregion
export { fal_default as default };
