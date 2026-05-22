import { t as definePluginEntry } from "../../plugin-entry-DtJdmmKN.js";
import { t as buildCliSpeechProvider } from "../../speech-provider-Be3nBMfW.js";
//#region extensions/tts-local-cli/index.ts
var tts_local_cli_default = definePluginEntry({
	id: "tts-local-cli",
	name: "Local CLI TTS",
	description: "Bundled CLI speech provider for local TTS",
	register(api) {
		api.registerSpeechProvider(buildCliSpeechProvider());
	}
});
//#endregion
export { tts_local_cli_default as default };
