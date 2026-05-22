import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-BEC14v2F.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Bql8J65K.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-Ce1Uq4Lw.js";
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
