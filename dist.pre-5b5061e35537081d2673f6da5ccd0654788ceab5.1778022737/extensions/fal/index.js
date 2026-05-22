import { t as definePluginEntry } from "../../plugin-entry-BzwFWtB2.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CxtfsNjn.js";
import { t as createFalProvider } from "../../provider-registration-F8UnI53v.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DeFf_96X.js";
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
