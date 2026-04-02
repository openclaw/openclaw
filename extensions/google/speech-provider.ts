import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import { parseGeminiAuth } from "./api.js";

const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function resolveGeminiApiKey(configuredKey?: string): string | undefined {
  return (
    configuredKey ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
}

type GeminiProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  modelId: string;
  voiceId?: string;
  timeoutMs?: number;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeGeminiProviderConfig(
  rawConfig: Record<string, unknown>,
): GeminiProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.gemini) ?? asObject(rawConfig.gemini);
  const baseUrl = trimToUndefined(raw?.baseUrl);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.gemini.apiKey",
    }),
    baseUrl: baseUrl?.replace(/\/+$/, "") || DEFAULT_GEMINI_BASE_URL,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_GEMINI_TTS_MODEL,
    voiceId: trimToUndefined(raw?.voiceId),
    timeoutMs: asNumber(raw?.timeoutMs),
  };
}

function readGeminiProviderConfig(config: SpeechProviderConfig): GeminiProviderConfig {
  const defaults = normalizeGeminiProviderConfig({});
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: config.apiKey,
        path: "messages.tts.providers.gemini.apiKey",
      }) ?? defaults.apiKey,
    baseUrl: trimToUndefined(config.baseUrl)?.replace(/\/+$/, "") ?? defaults.baseUrl,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    timeoutMs: asNumber(config.timeoutMs) ?? defaults.timeoutMs,
  };
}

// Gemini TTS pre-built voices (as of 2026)
const GEMINI_TTS_VOICES: Array<{ id: string; name: string; gender: string }> = [
  { id: "Aoede", name: "Aoede", gender: "female" },
  { id: "Charon", name: "Charon", gender: "male" },
  { id: "Fenrir", name: "Fenrir", gender: "male" },
  { id: "Kore", name: "Kore", gender: "female" },
  { id: "Puck", name: "Puck", gender: "male" },
];

export async function listGeminiVoices(): Promise<SpeechVoiceOption[]> {
  return GEMINI_TTS_VOICES.map((voice) => ({
    id: voice.id,
    name: voice.name,
    gender: voice.gender,
    locale: "en-US",
  }));
}

export function buildGeminiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "gemini",
    label: "Google Gemini TTS",
    aliases: ["google-tts"],
    autoSelectOrder: 25,
    models: [DEFAULT_GEMINI_TTS_MODEL],
    resolveConfig: ({ rawConfig }) => normalizeGeminiProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGeminiProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.gemini.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(asNumber(talkProviderConfig.timeoutMs) == null
          ? {}
          : { timeoutMs: asNumber(talkProviderConfig.timeoutMs) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { modelId: trimToUndefined(params.modelId) }),
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceId: trimToUndefined(params.voiceId) }),
    }),
    listVoices: async () => await listGeminiVoices(),
    isConfigured: ({ providerConfig }) =>
      Boolean(resolveGeminiApiKey(readGeminiProviderConfig(providerConfig).apiKey)),
    synthesize: async (req) => {
      const config = readGeminiProviderConfig(req.providerConfig);
      const apiKey = resolveGeminiApiKey(config.apiKey);
      if (!apiKey) {
        throw new Error("Gemini API key not configured (set GEMINI_API_KEY or GOOGLE_API_KEY)");
      }

      const modelId =
        trimToUndefined(req.providerOverrides?.modelId) ?? config.modelId;
      const voiceId =
        trimToUndefined(req.providerOverrides?.voiceId) ?? config.voiceId;
      const url = `${config.baseUrl}/${modelId}:generateContent`;

      const text = req.text.slice(0, 4096);

      const timeoutMs = config.timeoutMs ?? req.timeoutMs;
      const signal = timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined;

      const generationConfig: Record<string, unknown> = {
        responseModalities: ["AUDIO"],
      };

      if (voiceId) {
        generationConfig.speechConfig = {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceId },
          },
        };
      }

      const requestBody = {
        contents: [{ parts: [{ text }] }],
        generationConfig,
      };

      const authHeaders = parseGeminiAuth(apiKey);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders.headers,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`Gemini TTS error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: {
                mimeType?: string;
                data?: string;
              };
            }>;
          };
        }>;
      };

      const audioBase64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!audioBase64) {
        throw new Error("No audio data in Gemini response");
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      const mimeType =
        data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType || "audio/mp3";
      
      // Map Gemini MIME types to correct file extensions
      let fileExtension = ".mp3";
      if (mimeType.includes("webm")) {
        fileExtension = ".webm";
      } else if (mimeType.includes("wav") || mimeType.includes("pcm") || mimeType.includes("l16")) {
        fileExtension = ".wav";
      } else if (mimeType.includes("ogg")) {
        fileExtension = ".ogg";
      } else if (mimeType.includes("flac")) {
        fileExtension = ".flac";
      }

      return {
        audioBuffer,
        outputFormat: mimeType,
        fileExtension,
        voiceCompatible: mimeType.includes("mp3") || mimeType.includes("wav"),
      };
    },
  };
}
