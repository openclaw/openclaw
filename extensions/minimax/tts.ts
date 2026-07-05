// Minimax plugin module implements tts behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
<<<<<<< HEAD
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
=======
import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io";

export const MINIMAX_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
  "speech-01-240228",
] as const;

export const MINIMAX_TTS_VOICES = [
  "English_expressive_narrator",
  "Chinese (Mandarin)_Warm_Girl",
  "Chinese (Mandarin)_Lively_Girl",
  "Chinese (Mandarin)_Gentle_Boy",
  "Chinese (Mandarin)_Steady_Boy",
] as const;

export function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_MINIMAX_TTS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/(?:anthropic|v1)$/i, "");
}

function normalizeMinimaxTtsPitch(pitch: number): number {
  return Math.trunc(pitch);
}

export async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: string;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    model,
    voiceId,
    speed = 1,
    vol = 1,
    pitch = 0,
    format = "mp3",
    sampleRate = 32000,
    timeoutMs,
  } = params;
  const safeTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/v1/t2a_v2`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          text,
<<<<<<< HEAD
          stream: false,
          output_format: "hex",
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
          voice_setting: {
            voice_id: voiceId,
            speed,
            vol,
            pitch: normalizeMinimaxTtsPitch(pitch),
          },
          audio_setting: {
            format,
            sample_rate: sampleRate,
          },
        }),
        signal: controller.signal,
      },
      timeoutMs: safeTimeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
      auditContext: "minimax.tts",
    });
    try {
      await assertOkOrThrowProviderError(response, "MiniMax TTS API error");

<<<<<<< HEAD
      const body = await readProviderJsonResponse<{
        data?: { audio?: string };
        base_resp?: { status_code?: number; status_msg?: string };
      }>(response, "minimax.tts");
=======
      const body = (await response.json()) as {
        data?: { audio?: string };
        base_resp?: { status_code?: number; status_msg?: string };
      };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

      // Check base_resp for envelope errors (HTTP 200 with non-zero status_code).
      // Other MiniMax providers (image, video, music, web-search) already check this.
      // Without this check, quota/billing errors with placeholder audio are silently accepted.
      if (
        body.base_resp &&
        typeof body.base_resp.status_code === "number" &&
        body.base_resp.status_code !== 0
      ) {
        const msg = body.base_resp.status_msg ?? "unknown error";
<<<<<<< HEAD
        throw new Error(`MiniMax TTS API error (${body.base_resp.status_code}): ${msg}`);
=======
        throw new Error(
          `MiniMax TTS API error (${body.base_resp.status_code}): ${msg}`,
        );
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      }

      const hexAudio = body?.data?.audio;
      if (!hexAudio) {
        throw new Error("MiniMax TTS API returned no audio data");
      }

      return Buffer.from(hexAudio, "hex");
    } finally {
      await release();
    }
  } finally {
    clearTimeout(timeout);
  }
}
