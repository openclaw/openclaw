import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-CP8tehon.js";
import { t as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-baX4OTJL.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-BrnMTs9p.js";
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
