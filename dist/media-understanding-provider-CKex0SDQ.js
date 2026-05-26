import { r as transcribeDeepgramAudio } from "./audio-C3xpbSR5.js";
//#region extensions/deepgram/media-understanding-provider.ts
const deepgramMediaUnderstandingProvider = {
	id: "deepgram",
	capabilities: ["audio"],
	defaultModels: { audio: "nova-3" },
	autoPriority: { audio: 30 },
	transcribeAudio: transcribeDeepgramAudio
};
//#endregion
export { deepgramMediaUnderstandingProvider as t };
