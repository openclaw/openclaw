import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { t as buildGradiumSpeechProvider } from "../../speech-provider-0kZ5KHBB.js";
//#region extensions/gradium/index.ts
var gradium_default = definePluginEntry({
	id: "gradium",
	name: "Gradium Speech",
	description: "Bundled Gradium speech provider",
	register(api) {
		api.registerSpeechProvider(buildGradiumSpeechProvider());
	}
});
//#endregion
export { gradium_default as default };
