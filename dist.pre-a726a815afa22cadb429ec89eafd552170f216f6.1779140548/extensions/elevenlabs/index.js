import { t as definePluginEntry } from "../../plugin-entry-CCu4Tzpv.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-B-NdGJoN.js";
import { t as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CDZ48Bcq.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-BDKvUC_u.js";
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
