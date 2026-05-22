import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import { t as senseaudioMediaUnderstandingProvider } from "../../media-understanding-provider-D2h-2ipo2.js";
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
