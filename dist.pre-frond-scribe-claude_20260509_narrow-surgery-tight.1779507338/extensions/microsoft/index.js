import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as buildMicrosoftSpeechProvider } from "../../speech-provider-1F-9khXK.js";
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
