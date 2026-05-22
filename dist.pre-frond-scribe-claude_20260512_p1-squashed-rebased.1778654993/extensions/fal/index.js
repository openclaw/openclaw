import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-DHk_xCKZ.js";
import { t as createFalProvider } from "../../provider-registration-C4zn27ab.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-CmAZ8a8M.js";
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
