import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-B7U27kx7.js";
import { t as createFalProvider } from "../../provider-registration-B8Rd1maI.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-Csh9gTRB.js";
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
