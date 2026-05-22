import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-C3ZI8VNb.js";
import { t as createFalProvider } from "../../provider-registration-DMnTwnXm.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-BdILIOE8.js";
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
