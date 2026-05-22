import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-v2zd4v1n.js";
import { t as createFalProvider } from "../../provider-registration-CJXwVa6I.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DL88Kfeo.js";
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
