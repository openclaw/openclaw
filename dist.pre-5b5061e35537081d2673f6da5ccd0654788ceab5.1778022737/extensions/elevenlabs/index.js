import { t as definePluginEntry } from "../../plugin-entry-BzwFWtB2.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-8OCgOZuy.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DyTuAhV_.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-awXBGLpa.js";
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
