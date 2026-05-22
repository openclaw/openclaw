import { t as definePluginEntry } from "../../plugin-entry-CEeEexhG.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-9D8t8lWA.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-ruEAF_qC.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-YtVKRwuc.js";
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
