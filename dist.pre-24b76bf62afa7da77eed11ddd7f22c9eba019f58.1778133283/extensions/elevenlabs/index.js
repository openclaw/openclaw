import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-C27CYDXs.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-KtWpBY7s.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-DAe6r_i6.js";
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
