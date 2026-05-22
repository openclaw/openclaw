import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-B6PliA0j.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-UBrqlWY8.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-B9ga6NPe.js";
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
