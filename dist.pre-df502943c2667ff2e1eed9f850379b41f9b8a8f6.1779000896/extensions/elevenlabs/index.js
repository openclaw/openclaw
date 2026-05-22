import { t as definePluginEntry } from "../../plugin-entry-qhhTPsFQ.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-D6pZgsz-.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Cq2bA6Gl.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-DA6-xyJX.js";
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
