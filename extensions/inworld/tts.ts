import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/speech-provider";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";
export const DEFAULT_INWORLD_VOICE_ID = "Sarah";
export const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-max";

// Abort the read if the upstream stalls mid-body so a hung stream cannot pin the
// socket and buffers open indefinitely.
const INWORLD_UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
// Error responses only need a short diagnostic snippet, never the whole body.
const INWORLD_ERROR_BODY_MAX_BYTES = 8 * 1024;
const INWORLD_ERROR_BODY_MAX_CHARS = 400;
const INWORLD_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;

// Sentinel so the error-snippet reader can tell a cap overflow apart from an
// unrelated read failure without leaking the (possibly hostile) body.
class InworldErrorBodyOverflow extends Error {}

// Overflow gets a fixed marker so hostile response bodies cannot enter diagnostics.
async function readInworldErrorBodySnippet(response: Response): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readResponseWithLimit(response, INWORLD_ERROR_BODY_MAX_BYTES, {
      chunkTimeoutMs: INWORLD_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
      onOverflow: () => new InworldErrorBodyOverflow(),
    });
  } catch (error) {
    return error instanceof InworldErrorBodyOverflow
      ? "(error body exceeded diagnostic limit; truncated)"
      : "";
  }

  const collapsed = buffer.toString("utf8").replace(/\s+/g, " ").trim();
  if (collapsed.length > INWORLD_ERROR_BODY_MAX_CHARS) {
    return `${truncateUtf16Safe(collapsed, INWORLD_ERROR_BODY_MAX_CHARS)}…`;
  }
  return collapsed;
}

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

function ssrfPolicyFromInworldBaseUrl(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return { hostnameAllowlist: [parsed.hostname] };
  } catch {
    return undefined;
  }
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
  const { canonicalizeBase64, MAX_AUDIO_BYTES } = await import("openclaw/plugin-sdk/media-runtime");
  // Leave headroom for base64 and JSON overhead while bounding the encoded body.
  const INWORLD_TTS_BODY_MAX_BYTES = MAX_AUDIO_BYTES * 2;
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
  const url = `${baseUrl}/tts/v1/voice:stream`;
  const requestBody = JSON.stringify({
    text: params.text,
    voiceId: params.voiceId ?? DEFAULT_INWORLD_VOICE_ID,
    modelId: params.modelId ?? DEFAULT_INWORLD_MODEL_ID,
    audioConfig: {
      audioEncoding: params.audioEncoding ?? "MP3",
      ...(params.sampleRateHertz && { sampleRateHertz: params.sampleRateHertz }),
    },
    ...(params.temperature != null && { temperature: params.temperature }),
  });
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Dashboard credentials are already Base64-encoded; send them verbatim.
        Authorization: `Basic ${params.apiKey}`,
      },
      body: requestBody,
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
    auditContext: "inworld-tts",
  });

  try {
    if (!response.ok) {
      const errorBody = await readInworldErrorBodySnippet(response);
      throw new Error(`Inworld TTS API error (${response.status}): ${errorBody}`);
    }

    const body = (
      await readResponseWithLimit(response, INWORLD_TTS_BODY_MAX_BYTES, {
        chunkTimeoutMs: INWORLD_UPSTREAM_IDLE_TIMEOUT_MS,
        onOverflow: ({ size, maxBytes }) =>
          new Error(`Inworld TTS audio stream too large: ${size} bytes (limit: ${maxBytes} bytes)`),
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`Inworld TTS audio stream stalled: no data received for ${chunkTimeoutMs}ms`),
      })
    ).toString("utf8");
    const chunks: Buffer[] = [];
    let decodedAudioBytes = 0;

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
          `Inworld TTS stream parse error: unexpected non-JSON line: ${truncateUtf16Safe(trimmed, 80)}`,
        );
      }

      if (parsed.error) {
        throw new Error(`Inworld TTS stream error (${parsed.error.code}): ${parsed.error.message}`);
      }

      if (parsed.result?.audioContent) {
        const canonicalAudio = canonicalizeBase64(parsed.result.audioContent);
        if (!canonicalAudio) {
          throw new Error("Inworld TTS returned malformed base64 audio data");
        }
        const chunk = Buffer.from(canonicalAudio, "base64");
        const nextDecodedAudioBytes = decodedAudioBytes + chunk.length;
        if (nextDecodedAudioBytes > MAX_AUDIO_BYTES) {
          throw new Error(
            `Inworld TTS decoded audio too large: ${nextDecodedAudioBytes} bytes (limit: ${MAX_AUDIO_BYTES} bytes)`,
          );
        }
        decodedAudioBytes = nextDecodedAudioBytes;
        chunks.push(chunk);
      }
    }

    if (chunks.length === 0) {
      throw new Error("Inworld TTS returned no audio data");
    }

    return Buffer.concat(chunks);
  } finally {
    await release();
  }
}

export async function listInworldVoices(params: {
  apiKey: string;
  baseUrl?: string;
  language?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const { MAX_AUDIO_BYTES } = await import("openclaw/plugin-sdk/media-runtime");
  const INWORLD_VOICES_BODY_MAX_BYTES = MAX_AUDIO_BYTES;
  const baseUrl = normalizeInworldBaseUrl(params.baseUrl);
  const langParam = params.language ? `?languages=${encodeURIComponent(params.language)}` : "";
  const url = `${baseUrl}/voices/v1/voices${langParam}`;
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");

  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "GET",
      headers: {
        Authorization: `Basic ${params.apiKey}`,
      },
    },
    // Cover the phase before response headers; the bounded body reader below
    // only starts after fetch resolves.
    timeoutMs: params.timeoutMs ?? INWORLD_UPSTREAM_IDLE_TIMEOUT_MS,
    policy: ssrfPolicyFromInworldBaseUrl(baseUrl),
    auditContext: "inworld-voices",
  });

  try {
    if (!response.ok) {
      const errorBody = await readInworldErrorBodySnippet(response);
      throw new Error(`Inworld voices API error (${response.status}): ${errorBody}`);
    }

    const voicesBody = (
      await readResponseWithLimit(response, INWORLD_VOICES_BODY_MAX_BYTES, {
        chunkTimeoutMs: INWORLD_UPSTREAM_IDLE_TIMEOUT_MS,
        onOverflow: ({ size, maxBytes }) =>
          new Error(`Inworld voices response too large: ${size} bytes (limit: ${maxBytes} bytes)`),
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`Inworld voices response stalled: no data received for ${chunkTimeoutMs}ms`),
      })
    ).toString("utf8");
    let json: {
      voices?: Array<{
        voiceId?: string;
        displayName?: string;
        description?: string;
        langCode?: string;
        tags?: string[];
        source?: string;
      }>;
    };
    try {
      json = JSON.parse(voicesBody) as typeof json;
    } catch {
      throw new Error("Inworld voices API returned malformed JSON");
    }

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
  } finally {
    await release();
  }
}
