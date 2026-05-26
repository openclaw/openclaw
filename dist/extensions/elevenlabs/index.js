import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-Cx33pQwP.js";
import { t as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BEsPg9Oq.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-C9pLiKqA.js";
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
