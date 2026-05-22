import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { t as buildMicrosoftSpeechProvider } from "../../speech-provider-ByxeyJyU.js";
//#region extensions/microsoft/index.ts
var microsoft_default = definePluginEntry({
	id: "microsoft",
	name: "Microsoft Speech",
	description: "Bundled Microsoft speech provider",
	register(api) {
		api.registerSpeechProvider(buildMicrosoftSpeechProvider());
	}
});
//#endregion
export { microsoft_default as default };
