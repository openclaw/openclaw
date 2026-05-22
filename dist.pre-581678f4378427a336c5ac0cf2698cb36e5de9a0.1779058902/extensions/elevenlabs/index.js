import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import { t as elevenLabsMediaUnderstandingProvider } from "../../media-understanding-provider-J3BU0oDO.js";
import { n as buildElevenLabsRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BT16K7dI.js";
import { t as buildElevenLabsSpeechProvider } from "../../speech-provider-eSew7syX.js";
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
