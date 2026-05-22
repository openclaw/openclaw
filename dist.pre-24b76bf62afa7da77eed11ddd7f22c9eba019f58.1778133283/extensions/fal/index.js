import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CiuSkGxh.js";
import { t as createFalProvider } from "../../provider-registration-DKyRKtOw.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DN6nb6b0.js";
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
