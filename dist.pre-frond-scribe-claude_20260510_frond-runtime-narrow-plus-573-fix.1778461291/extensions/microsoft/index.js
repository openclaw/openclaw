import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as buildMicrosoftSpeechProvider } from "../../speech-provider-CsHzxW9P.js";
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
