import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

export const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
export const DEFAULT_INWORLD_VOICE_ID = "Dennis";
export const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-max";

export const INWORLD_TTS_MODELS = [
  "inworld-tts-1.5-max",
  "inworld-tts-1.5-mini",
  "inworld-tts-1-max",
  "inworld-tts-1",
] as const;

export type InworldAudioEncoding =
  | "MP3"
  | "OGG_OPUS"
  | "LINEAR16"
  | "PCM"
  | "WAV"
  | "ALAW"
  | "MULAW"
  | "FLAC";

export function normalizeInworldBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_INWORLD_BASE_URL;
}

/**
 * Calls the Inworld streaming TTS endpoint and concatenates every audio chunk
 * into a single buffer. The stream returns newline-delimited JSON, each line
 * carrying base64 audio in `result.audioContent`.
 */
export async function inworldTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  modelId?: string;
  audioEncoding?: InworldAudioEncoding;
  sampleRateHertz?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);

  const controller = new AbortController();
  const timeout = params.timeoutMs
    ? setTimeout(() => controller.abort(), params.timeoutMs)
    : undefined;

  try {
    const res = await fetch(`${baseUrl}/tts/v1/voice:stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${params.apiKey}`,
      },
      body: JSON.stringify({
        text: params.text,
        voiceId: params.voiceId ?? DEFAULT_INWORLD_VOICE_ID,
        modelId: params.modelId ?? DEFAULT_INWORLD_MODEL_ID,
        audioConfig: {
          audioEncoding: params.audioEncoding ?? "MP3",
          ...(params.sampleRateHertz && { sampleRateHertz: params.sampleRateHertz }),
        },
        ...(params.temperature != null && { temperature: params.temperature }),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`Inworld TTS API error (${res.status}): ${errorBody}`);
    }

    const body = await res.text();
    const chunks: Buffer[] = [];

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: {
        result?: { audioContent?: string };
        error?: { code?: number; message?: string };
      };
      try {
        parsed = JSON.parse(trimmed) as typeof parsed;
      } catch {
        throw new Error(
          `Inworld TTS stream parse error: unexpected non-JSON line: ${trimmed.slice(0, 80)}`,
        );
      }

      if (parsed.error) {
        throw new Error(`Inworld TTS stream error (${parsed.error.code}): ${parsed.error.message}`);
      }

      if (parsed.result?.audioContent) {
        chunks.push(Buffer.from(parsed.result.audioContent, "base64"));
      }
    }

    if (chunks.length === 0) {
      throw new Error("Inworld TTS returned no audio data");
    }

    return Buffer.concat(chunks);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function listInworldVoices(params: {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
  const langParam = params.language ? `?languages=${encodeURIComponent(params.language)}` : "";

  const res = await fetch(`${baseUrl}/voices/v1/voices${langParam}`, {
    headers: {
      Authorization: `Basic ${params.apiKey}`,
    },
    ...(params.timeoutMs && { signal: AbortSignal.timeout(params.timeoutMs) }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Inworld voices API error (${res.status}): ${errorBody}`);
  }

  const json = (await res.json()) as {
    voices?: Array<{
      voiceId?: string;
      displayName?: string;
      description?: string;
      langCode?: string;
      tags?: string[];
      source?: string;
    }>;
  };

  return Array.isArray(json.voices)
    ? json.voices
        .map((voice) => ({
          id: voice.voiceId?.trim() ?? "",
          name: voice.displayName?.trim() || undefined,
          description: voice.description?.trim() || undefined,
          locale: voice.langCode || undefined,
          gender: voice.tags?.find((t) => t === "male" || t === "female") || undefined,
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}
