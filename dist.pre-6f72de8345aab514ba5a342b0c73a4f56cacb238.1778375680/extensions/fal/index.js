import { t as definePluginEntry } from "../../plugin-entry-CEeEexhG.js";
import { n as buildFalImageGenerationProvider } from "../../image-generation-provider-CpW5g7KG.js";
import { t as createFalProvider } from "../../provider-registration-Dmi9m_U2.js";
import { n as buildFalVideoGenerationProvider } from "../../video-generation-provider-Dq2bNZmH.js";
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
