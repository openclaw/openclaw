import { t as transcribeOpenAiCompatibleAudio } from "./media-understanding-C_qxfCIa.js";
//#region extensions/mistral/media-understanding-provider.ts
const DEFAULT_MISTRAL_AUDIO_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MISTRAL_AUDIO_MODEL = "voxtral-mini-latest";
const mistralMediaUnderstandingProvider = {
	id: "mistral",
	capabilities: ["audio"],
	defaultModels: { audio: DEFAULT_MISTRAL_AUDIO_MODEL },
	autoPriority: { audio: 50 },
	transcribeAudio: async (req) => await transcribeOpenAiCompatibleAudio({
		...req,
		baseUrl: req.baseUrl ?? DEFAULT_MISTRAL_AUDIO_BASE_URL,
		defaultBaseUrl: DEFAULT_MISTRAL_AUDIO_BASE_URL,
		defaultModel: DEFAULT_MISTRAL_AUDIO_MODEL
	})
};
//#endregion
export { mistralMediaUnderstandingProvider as t };
