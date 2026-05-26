import { t as transcribeOpenAiCompatibleAudio } from "./media-understanding-C_qxfCIa.js";
//#region extensions/groq/media-understanding-provider.ts
const DEFAULT_GROQ_AUDIO_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_AUDIO_MODEL = "whisper-large-v3-turbo";
const groqMediaUnderstandingProvider = {
	id: "groq",
	capabilities: ["audio"],
	defaultModels: { audio: DEFAULT_GROQ_AUDIO_MODEL },
	autoPriority: { audio: 20 },
	transcribeAudio: (req) => transcribeOpenAiCompatibleAudio({
		...req,
		baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
		defaultBaseUrl: DEFAULT_GROQ_AUDIO_BASE_URL,
		defaultModel: DEFAULT_GROQ_AUDIO_MODEL
	})
};
//#endregion
export { groqMediaUnderstandingProvider as t };
