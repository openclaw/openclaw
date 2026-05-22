import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-D8uAqLAs.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CPO7A_n2.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-Bl7e5omt.js";
//#region extensions/elevenlabs/index.ts
var elevenlabs_default = definePluginEntry({
	id: "elevenlabs",
	name: "ElevenLabs Speech",
	description: "Bundled ElevenLabs speech provider",
	register(api) {
		api.registerSpeechProvider(buildElevenLabsSpeechProvider());
		api.registerMediaUnderstandingProvider(elevenLabsMediaUnderstandingProvider);
		api.registerRealtimeTranscriptionProvider(buildElevenLabsRealtimeTranscriptionProvider());
	}
});
//#endregion
export { elevenlabs_default as default };
