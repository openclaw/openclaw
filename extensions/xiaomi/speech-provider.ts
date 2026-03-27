import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";

const MIMO_TTS_MODELS = ["mimo-v2-tts"] as const;

const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "mimo-v2-tts";
const DEFAULT_MIMO_VOICE = "mimo_default";

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeMimoBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_MIMO_BASE_URL;
}

type MimoProviderConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  style?: string;
};

function readMimoProviderConfig(providerConfig: SpeechProviderConfig): MimoProviderConfig {
  const raw = asObject(providerConfig);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.mimo.apiKey",
    }),
    baseUrl: normalizeMimoBaseUrl(trimToUndefined(raw?.baseUrl)),
    model: trimToUndefined(raw?.model) ?? DEFAULT_MIMO_MODEL,
    voice: trimToUndefined(raw?.voice) ?? DEFAULT_MIMO_VOICE,
    style: trimToUndefined(raw?.style),
  };
}

export async function mimoTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  style?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voice, style, timeoutMs } = params;

  let assistantContent = text;
  if (style) {
    assistantContent = `<style>${style}</style>${text}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "assistant", content: assistantContent }],
        audio: {
          format: "wav",
          voice,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      throw new Error(`MiMo TTS API error (${response.status}): ${error}`);
    }

    const data = await response.json();
    const audioData = data?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      throw new Error("MiMo TTS API returned no audio data");
    }

    return Buffer.from(audioData, "base64");
  } finally {
    clearTimeout(timeout);
  }
}

async function listMimoVoices(): Promise<SpeechVoiceOption[]> {
  return [
    { id: "mimo_default", name: "Default (Chinese)", locale: "zh-CN" },
    { id: "default_zh", name: "Chinese", locale: "zh-CN" },
    { id: "default_en", name: "English", locale: "en-US" },
  ];
}

export function buildMimoSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "mimo",
    label: "Xiaomi MiMo TTS",
    aliases: ["xiaomi", "mimo"],
    models: MIMO_TTS_MODELS,

    isConfigured: ({ providerConfig }) =>
      Boolean(readMimoProviderConfig(providerConfig).apiKey || process.env.MIMO_API_KEY),

    synthesize: async (req) => {
      const config = readMimoProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.MIMO_API_KEY;
      if (!apiKey) {
        throw new Error("MiMo API key missing");
      }

      const audioBuffer = await mimoTTS({
        text: req.text,
        apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice,
        style: config.style,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },

    listVoices: async () => {
      return listMimoVoices();
    },
  };
}
