import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-CJrt8-yk.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-ZlUum2Nl.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-DNVSb3Ce.js";
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
