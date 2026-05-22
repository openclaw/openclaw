import { t as definePluginEntry } from "../../plugin-entry-CvekifYj.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-DYFqUhy2.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CrSXv1Ys.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-Bi-arog_.js";
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
