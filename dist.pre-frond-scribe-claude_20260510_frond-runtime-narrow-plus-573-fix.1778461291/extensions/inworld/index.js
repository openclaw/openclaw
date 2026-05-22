import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as buildInworldSpeechProvider } from "../../speech-provider-RtCI_K_B.js";
//#region extensions/inworld/index.ts
var inworld_default = definePluginEntry({
	id: "inworld",
	name: "Inworld Speech",
	description: "Bundled Inworld speech provider",
	register(api) {
		api.registerSpeechProvider(buildInworldSpeechProvider());
	}
});
//#endregion
export { inworld_default as default };
