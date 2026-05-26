import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CHmW1Elt.js";
import { t as createFalProvider } from "../../provider-registration-CHrO-Psz.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-Clt74XZo.js";
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
