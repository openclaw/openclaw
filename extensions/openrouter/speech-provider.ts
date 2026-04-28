import {
  asObject,
  createOpenAiCompatibleSpeechProvider,
  trimToUndefined,
  type OpenAiCompatibleSpeechProviderConfig,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { normalizeOpenRouterBaseUrl, OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_TTS_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_OPENROUTER_TTS_VOICE = "af_alloy";
const OPENROUTER_TTS_MODELS = [
  DEFAULT_OPENROUTER_TTS_MODEL,
  "google/gemini-3.1-flash-tts-preview",
  "mistralai/voxtral-mini-tts-2603",
  "elevenlabs/eleven-turbo-v2",
] as const;
const OPENROUTER_TTS_RESPONSE_FORMATS = ["mp3", "pcm"] as const;

type OpenRouterTtsExtraConfig = {
  provider?: Record<string, unknown>;
};

type OpenRouterTtsProviderConfig = OpenAiCompatibleSpeechProviderConfig<OpenRouterTtsExtraConfig>;

function normalizeOpenRouterTtsBaseUrl(value: unknown): string {
  return (
    normalizeOpenRouterBaseUrl(trimToUndefined(value) ?? OPENROUTER_BASE_URL) ?? OPENROUTER_BASE_URL
  );
}

export function buildOpenRouterSpeechProvider(): SpeechProviderPlugin {
  return createOpenAiCompatibleSpeechProvider<OpenRouterTtsExtraConfig>({
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
    normalizeBaseUrl: normalizeOpenRouterTtsBaseUrl,
    extraHeaders: {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
    },
    apiErrorLabel: "OpenRouter TTS API error",
    missingApiKeyError: "OpenRouter API key missing",
    readExtraConfig: (raw) => ({ provider: asObject(raw?.provider) }),
    buildExtraBody: (config: OpenRouterTtsProviderConfig) =>
      config.provider == null ? undefined : { provider: config.provider },
  });
}
