import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import { t as buildMicrosoftSpeechProvider } from "../../speech-provider-Dq5xhPnM.js";
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
