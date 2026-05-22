import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CCm8DLV0.js";
import { t as createFalProvider } from "../../provider-registration-D7JF2sZI.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-iJDe-aDF.js";
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
