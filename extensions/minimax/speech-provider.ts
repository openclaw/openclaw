import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/core";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";
const DEFAULT_MODEL = "speech-2.8-turbo";
const DEFAULT_VOICE = "English_radiant_girl";

const MINIMAX_TTS_MODELS = ["speech-2.8-turbo", "speech-2.8-hd"] as const;

type MinimaxT2aResponse = {
  data?: {
    audio?: string;
    status?: number;
  };
  extra_info?: {
    audio_length?: number;
    audio_sample_rate?: number;
    audio_size?: number;
    bitrate?: number;
    audio_format?: string;
    audio_channel?: number;
    usage_characters?: number;
    word_count?: number;
  };
  trace_id?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

type MinimaxGetVoiceResponse = {
  system_voice?: Array<{
    voice_id?: string;
    voice_name?: string;
    description?: string[];
  }>;
  voice_cloning?: Array<{
    voice_id?: string;
    description?: string[];
  }>;
  voice_generation?: Array<{
    voice_id?: string;
    description?: string[];
  }>;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

function resolveMinimaxTtsBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  if (!direct) {
    return DEFAULT_MINIMAX_TTS_BASE_URL;
  }
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_MINIMAX_TTS_BASE_URL;
  }
}

function resolveMinimaxTtsApiKey(
  config: { minimax: { apiKey?: string } },
  cfg?: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): string | undefined {
  if (config.minimax.apiKey) {
    return config.minimax.apiKey;
  }
  if (process.env.MINIMAX_API_KEY) {
    return process.env.MINIMAX_API_KEY;
  }
  // Check provider-level API key from model config
  const portalKey = cfg?.models?.providers?.["minimax-portal"]?.apiKey;
  if (typeof portalKey === "string" && portalKey.trim()) {
    return portalKey.trim();
  }
  const minimaxKey = cfg?.models?.providers?.minimax?.apiKey;
  if (typeof minimaxKey === "string" && minimaxKey.trim()) {
    return minimaxKey.trim();
  }
  // Fallback: read OAuth credentials from ~/.minimax/oauth_creds.json
  return readMiniMaxOAuthAccessToken();
}

function readMiniMaxOAuthAccessToken(): string | undefined {
  try {
    const credPath = path.join(homedir(), ".minimax", "oauth_creds.json");
    if (!existsSync(credPath)) {
      return undefined;
    }
    const raw = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
    const token = raw.access_token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  speed?: number;
  audioFormat: string;
  sampleRate: number;
  bitrate: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const body: Record<string, unknown> = {
    model: params.model,
    text: params.text,
    stream: false,
    output_format: "hex",
    voice_setting: {
      voice_id: params.voice,
      speed: params.speed ?? 1,
    },
    audio_setting: {
      sample_rate: params.sampleRate,
      bitrate: params.bitrate,
      format: params.audioFormat,
      channel: 1,
    },
  };

  const controller = new AbortController();
  const timeout =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;

  const response = await fetch(`${params.baseUrl}/v1/t2a_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MiniMax TTS failed (${response.status}): ${text || response.statusText}`);
  }

  const data = (await response.json()) as MinimaxT2aResponse;

  const baseResp = data.base_resp;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    const msg = baseResp.status_msg ?? "";
    throw new Error(`MiniMax TTS API error (${baseResp.status_code}): ${msg}`);
  }

  const hexAudio = data.data?.audio;
  if (!hexAudio) {
    throw new Error("MiniMax TTS returned no audio data");
  }

  return Buffer.from(hexAudio, "hex");
}

async function listMinimaxVoices(params: {
  apiKey: string;
  baseUrl: string;
}): Promise<SpeechVoiceOption[]> {
  const response = await fetch(`${params.baseUrl}/v1/get_voice`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ voice_type: "all" }),
  });

  if (!response.ok) {
    throw new Error(`MiniMax get_voice API error (${response.status})`);
  }

  const data = (await response.json()) as MinimaxGetVoiceResponse;

  const baseResp = data.base_resp;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    throw new Error(
      `MiniMax get_voice error (${baseResp.status_code}): ${baseResp.status_msg ?? ""}`,
    );
  }

  const voices: SpeechVoiceOption[] = [];

  for (const v of data.system_voice ?? []) {
    if (v.voice_id?.trim()) {
      voices.push({
        id: v.voice_id.trim(),
        name: v.voice_name?.trim() || undefined,
        category: "system",
        description: v.description?.join("; ") || undefined,
      });
    }
  }

  for (const v of data.voice_cloning ?? []) {
    if (v.voice_id?.trim()) {
      voices.push({
        id: v.voice_id.trim(),
        category: "cloned",
        description: v.description?.join("; ") || undefined,
      });
    }
  }

  for (const v of data.voice_generation ?? []) {
    if (v.voice_id?.trim()) {
      voices.push({
        id: v.voice_id.trim(),
        category: "generated",
        description: v.description?.join("; ") || undefined,
      });
    }
  }

  return voices;
}

function buildMinimaxSpeechProvider(providerId: string): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    models: [...MINIMAX_TTS_MODELS],
    voices: [DEFAULT_VOICE],
    listVoices: async (req) => {
      const apiKey = req.apiKey || req.config?.minimax.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const baseUrl =
        req.baseUrl?.trim() || req.config?.minimax.baseUrl || DEFAULT_MINIMAX_TTS_BASE_URL;
      return listMinimaxVoices({ apiKey, baseUrl });
    },
    isConfigured: ({ config, cfg }) => Boolean(resolveMinimaxTtsApiKey(config, cfg)),
    synthesize: async (req) => {
      const apiKey = resolveMinimaxTtsApiKey(req.config, req.cfg);
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const baseUrl =
        req.config.minimax.baseUrl ||
        resolveMinimaxTtsBaseUrl(req.cfg, providerId) ||
        DEFAULT_MINIMAX_TTS_BASE_URL;

      const model = req.overrides?.minimax?.model ?? req.config.minimax.model;
      const voice = req.overrides?.minimax?.voice ?? req.config.minimax.voice;
      const speed = req.overrides?.minimax?.speed ?? req.config.minimax.speed;

      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl,
        model,
        voice,
        speed,
        audioFormat: "mp3",
        sampleRate: 32_000,
        bitrate: 128_000,
        timeoutMs: req.config.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey = resolveMinimaxTtsApiKey(req.config, req.cfg);
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const baseUrl =
        req.config.minimax.baseUrl ||
        resolveMinimaxTtsBaseUrl(req.cfg, providerId) ||
        DEFAULT_MINIMAX_TTS_BASE_URL;

      const sampleRate = 24_000;
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl,
        model: req.config.minimax.model,
        voice: req.config.minimax.voice,
        speed: req.config.minimax.speed,
        audioFormat: "pcm",
        sampleRate,
        bitrate: 128_000,
        timeoutMs: req.config.timeoutMs,
      });

      return { audioBuffer, outputFormat: "pcm", sampleRate };
    },
  };
}

export function buildMinimaxSpeechProviderForApi(): SpeechProviderPlugin {
  return buildMinimaxSpeechProvider("minimax");
}

export function buildMinimaxSpeechProviderForPortal(): SpeechProviderPlugin {
  return buildMinimaxSpeechProvider("minimax-portal");
}
