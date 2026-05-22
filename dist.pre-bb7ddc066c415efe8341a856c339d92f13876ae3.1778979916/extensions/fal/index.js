import { t as definePluginEntry } from "../../plugin-entry-DtJdmmKN.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-Fv-0Tou9.js";
import { t as createFalProvider } from "../../provider-registration-B6klhqn6.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-DDMBuTvy.js";
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
