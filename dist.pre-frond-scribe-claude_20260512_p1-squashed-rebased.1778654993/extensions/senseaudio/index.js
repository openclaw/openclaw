import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { t as senseaudioMediaUnderstandingProvider } from "../../media-understanding-provider-BR0YMorc.js";
//#region extensions/senseaudio/index.ts
var senseaudio_default = definePluginEntry({
	id: "senseaudio",
	name: "SenseAudio",
	description: "Bundled SenseAudio audio transcription provider",
	register(api) {
		api.registerMediaUnderstandingProvider(senseaudioMediaUnderstandingProvider);
	}
});
//#endregion
export { senseaudio_default as default };
