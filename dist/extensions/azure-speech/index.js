import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as buildAzureSpeechProvider } from "../../speech-provider-BcNV6B1g.js";
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
