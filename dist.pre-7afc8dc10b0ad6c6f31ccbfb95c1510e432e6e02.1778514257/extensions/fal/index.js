import { t as definePluginEntry } from "../../plugin-entry-DFlZXTDz.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CvljP0Mr.js";
import { t as createFalProvider } from "../../provider-registration-DUcnzql8.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-xxREVcex.js";
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
