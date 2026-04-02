import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";

const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  modelId: string;
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
    apiKey: trimToUndefined(raw?.apiKey),
    baseUrl: baseUrl?.replace(/\/+$/, "") || DEFAULT_GEMINI_BASE_URL,
    modelId: trimToUndefined(raw?.modelId) ?? DEFAULT_GEMINI_TTS_MODEL,
    timeoutMs: asNumber(raw?.timeoutMs),
  };
}

function readGeminiProviderConfig(config: SpeechProviderConfig): GeminiProviderConfig {
  const defaults = normalizeGeminiProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey,
    baseUrl: trimToUndefined(config.baseUrl)?.replace(/\/+$/, "") ?? defaults.baseUrl,
    modelId: trimToUndefined(config.modelId) ?? defaults.modelId,
    timeoutMs: asNumber(config.timeoutMs) ?? defaults.timeoutMs,
  };
}

export async function listGeminiVoices(): Promise<SpeechVoiceOption[]> {
  return [
    {
      id: "default",
      name: "Gemini Default",
      description: "Default Gemini TTS voice",
      locale: "en-US",
    },
  ];
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
        ...(trimToUndefined(talkProviderConfig.apiKey) == null
          ? {}
          : { apiKey: trimToUndefined(talkProviderConfig.apiKey) }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { modelId: trimToUndefined(talkProviderConfig.modelId) }),
        ...(asNumber(talkProviderConfig.timeoutMs) == null
          ? {}
          : { timeoutMs: asNumber(talkProviderConfig.timeoutMs) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { modelId: trimToUndefined(params.modelId) }),
    }),
    listVoices: async () => await listGeminiVoices(),
    isConfigured: ({ providerConfig }) =>
      Boolean(
        readGeminiProviderConfig(providerConfig).apiKey || process.env.GEMINI_API_KEY,
      ),
    synthesize: async (req) => {
      const config = readGeminiProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY not configured");
      }

      const modelId =
        trimToUndefined(req.providerOverrides?.modelId) ?? config.modelId;
      const url = `${config.baseUrl}/${modelId}:generateContent?key=${apiKey}`;

      const text = req.text.slice(0, 4096);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
          },
        }),
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
        data.candidates[0].content.parts[0].inlineData.mimeType || "audio/mp3";
      const fileExtension = mimeType.includes("webm") ? ".webm" : ".mp3";

      return {
        audioBuffer,
        outputFormat: mimeType,
        fileExtension,
        voiceCompatible: mimeType.includes("mp3"),
      };
    },
  };
}
