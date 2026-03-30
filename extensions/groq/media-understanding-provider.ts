import {
	type MediaUnderstandingProvider,
	transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";

const DEFAULT_GROQ_AUDIO_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_AUDIO_MODEL = "whisper-large-v3-turbo";

export const groqMediaUnderstandingProvider: MediaUnderstandingProvider = {
	id: "groq",
	capabilities: ["audio"],
	transcribeAudio: (req) =>
		transcribeOpenAiCompatibleAudio({
			...req,
			baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
			defaultBaseUrl: DEFAULT_GROQ_AUDIO_BASE_URL,
			defaultModel: DEFAULT_GROQ_AUDIO_MODEL,
		}),
};
