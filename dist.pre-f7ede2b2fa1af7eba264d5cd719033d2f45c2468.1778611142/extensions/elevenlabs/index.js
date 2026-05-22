import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-Ck8OBkek.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-B2FFforJ.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-CLB_AP83.js";
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
