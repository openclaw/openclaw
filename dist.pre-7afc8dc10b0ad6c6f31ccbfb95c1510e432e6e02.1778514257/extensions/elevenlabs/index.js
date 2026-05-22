import { t as definePluginEntry } from "../../plugin-entry-DFlZXTDz.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-DxUOx5L7.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Bzvzjw3N.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-4DIco8iq.js";
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
