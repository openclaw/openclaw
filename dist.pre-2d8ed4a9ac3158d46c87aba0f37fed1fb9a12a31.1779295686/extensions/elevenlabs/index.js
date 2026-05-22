import { t as definePluginEntry } from "../../plugin-entry-BW8FQC_w.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-CWRk4ENr.js";
import { t as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Br1CDV0_.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-C9U9NDKm.js";
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
