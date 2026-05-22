import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-C0vbpn4e.js";
import { t as createFalProvider } from "../../provider-registration-DTwpdPF3.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DulUd2mi.js";
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
