import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import { t as buildGradiumSpeechProvider } from "../../speech-provider-BitOhA4t.js";
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
