import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import { t as buildAzureSpeechProvider } from "../../speech-provider-C9nUbqr8.js";
//#region extensions/azure-speech/index.ts
var azure_speech_default = definePluginEntry({
	id: "azure-speech",
	name: "Azure Speech",
	description: "Bundled Azure Speech provider",
	register(api) {
		api.registerSpeechProvider(buildAzureSpeechProvider());
	}
});
//#endregion
export { azure_speech_default as default };
