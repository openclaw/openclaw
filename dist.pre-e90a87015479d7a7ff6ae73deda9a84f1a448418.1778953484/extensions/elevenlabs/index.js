import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-MacUBKWT.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Cyth_FVv.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-BuxRP65U.js";
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
