import { r as transcribeDeepgramAudio } from "./audio-RQDr7r1W.js";
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
