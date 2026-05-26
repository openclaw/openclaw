import { t as transcribeOpenAiCompatibleAudio } from "./media-understanding-C_qxfCIa.js";
//#region extensions/senseaudio/media-understanding-provider.ts
const DEFAULT_SENSEAUDIO_AUDIO_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_SENSEAUDIO_AUDIO_MODEL = "senseaudio-asr-pro-1.5-260319";
async function transcribeSenseAudioAudio(params) {
	return await transcribeOpenAiCompatibleAudio({
		...params,
		provider: "senseaudio",
		defaultBaseUrl: DEFAULT_SENSEAUDIO_AUDIO_BASE_URL,
		defaultModel: DEFAULT_SENSEAUDIO_AUDIO_MODEL
	});
}
const senseaudioMediaUnderstandingProvider = {
	id: "senseaudio",
	capabilities: ["audio"],
	defaultModels: { audio: DEFAULT_SENSEAUDIO_AUDIO_MODEL },
	autoPriority: { audio: 40 },
	transcribeAudio: transcribeSenseAudioAudio
};
//#endregion
export { transcribeSenseAudioAudio as n, senseaudioMediaUnderstandingProvider as t };
