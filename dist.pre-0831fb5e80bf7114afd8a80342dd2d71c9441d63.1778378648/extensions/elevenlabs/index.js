import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-e51ZlsyH.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DE1PYiK_.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-C0BLZfB2.js";
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
