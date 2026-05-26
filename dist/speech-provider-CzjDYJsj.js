import { n as asObject } from "./provider-http-errors-C90BH-le.js";
import { t as createOpenAiCompatibleSpeechProvider } from "./speech-DNHVYL_R.js";
import { t as OPENROUTER_BASE_URL } from "./provider-catalog-Dya4CIwt.js";
//#region extensions/openrouter/speech-provider.ts
const DEFAULT_OPENROUTER_TTS_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_OPENROUTER_TTS_VOICE = "af_alloy";
const OPENROUTER_TTS_MODELS = [
	DEFAULT_OPENROUTER_TTS_MODEL,
	"google/gemini-3.1-flash-tts-preview",
	"mistralai/voxtral-mini-tts-2603",
	"elevenlabs/eleven-turbo-v2"
];
const OPENROUTER_TTS_RESPONSE_FORMATS = ["mp3", "pcm"];
function buildOpenRouterSpeechProvider() {
	return createOpenAiCompatibleSpeechProvider({
		id: "openrouter",
		label: "OpenRouter",
		autoSelectOrder: 35,
		models: OPENROUTER_TTS_MODELS,
		voices: [DEFAULT_OPENROUTER_TTS_VOICE],
		defaultModel: DEFAULT_OPENROUTER_TTS_MODEL,
		defaultVoice: DEFAULT_OPENROUTER_TTS_VOICE,
		defaultBaseUrl: OPENROUTER_BASE_URL,
		envKey: "OPENROUTER_API_KEY",
		responseFormats: OPENROUTER_TTS_RESPONSE_FORMATS,
		defaultResponseFormat: "mp3",
		voiceCompatibleResponseFormats: ["mp3"],
		baseUrlPolicy: {
			kind: "canonical",
			aliases: ["https://openrouter.ai/v1"]
		},
		extraHeaders: {
			"HTTP-Referer": "https://openclaw.ai",
			"X-OpenRouter-Title": "OpenClaw"
		},
		apiErrorLabel: "OpenRouter TTS API error",
		missingApiKeyError: "OpenRouter API key missing",
		readExtraConfig: (raw) => ({ provider: asObject(raw?.provider) }),
		extraJsonBodyFields: [{ configKey: "provider" }]
	});
}
//#endregion
export { buildOpenRouterSpeechProvider as t };
