import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-CJShh1xu.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-C7665pYd.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-CE0zaWit.js";
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
