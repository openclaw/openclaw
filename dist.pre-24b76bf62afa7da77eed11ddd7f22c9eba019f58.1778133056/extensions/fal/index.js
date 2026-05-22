import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CJozvIBf.js";
import { t as createFalProvider } from "../../provider-registration-Cl9UeIs-.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-0pg9z59O.js";
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
