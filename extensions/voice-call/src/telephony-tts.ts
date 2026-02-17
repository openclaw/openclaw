import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { convertPcmToMulaw8k, resamplePcmTo8k, pcmToMulaw } from "./telephony-audio.js";

export type TelephonyTtsRuntime = {
  textToSpeechTelephony: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    error?: string;
  }>;
};

export type TelephonyTtsProvider = {
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
  /**
   * Stream TTS audio as mu-law 8kHz chunks for real-time playback.
   * Falls back to non-streaming synthesis if direct streaming is unavailable.
   */
  streamForTelephony?: (
    text: string,
    signal?: AbortSignal,
  ) => AsyncGenerator<Buffer, void, unknown>;
};

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Stream TTS directly from ElevenLabs in mu-law 8kHz format.
 * Yields chunks as they arrive for minimal latency.
 */
async function* streamElevenLabsTelephony(
  text: string,
  config: NonNullable<VoiceCallTtsConfig>,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, unknown> {
  const elevenlabs = config.elevenlabs;
  if (!elevenlabs?.apiKey || !elevenlabs?.voiceId) {
    throw new Error("ElevenLabs API key and voice ID required for streaming TTS");
  }

  const baseUrl = elevenlabs.baseUrl?.replace(/\/+$/, "") || "https://api.elevenlabs.io";
  const modelId = elevenlabs.modelId || "eleven_turbo_v2_5";
  const voiceId = elevenlabs.voiceId;

  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
  };

  // Add voice settings if configured
  if (elevenlabs.voiceSettings) {
    body.voice_settings = {
      stability: elevenlabs.voiceSettings.stability ?? 0.5,
      similarity_boost: elevenlabs.voiceSettings.similarityBoost ?? 0.75,
      ...(elevenlabs.voiceSettings.style != null && { style: elevenlabs.voiceSettings.style }),
      ...(elevenlabs.voiceSettings.useSpeakerBoost != null && {
        use_speaker_boost: elevenlabs.voiceSettings.useSpeakerBoost,
      }),
      ...(elevenlabs.voiceSettings.speed != null && { speed: elevenlabs.voiceSettings.speed }),
    };
  }
  if (elevenlabs.languageCode) {
    body.language_code = elevenlabs.languageCode;
  }
  if (elevenlabs.seed != null) {
    body.seed = elevenlabs.seed;
  }

  // Request mu-law 8kHz directly — no resampling or conversion needed
  const url = `${baseUrl}/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": elevenlabs.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "unknown";
  console.log(
    `[voice-call] ElevenLabs streaming TTS response: ${response.status} ${response.statusText}; content-type=${contentType}`,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`ElevenLabs streaming TTS failed: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error("ElevenLabs streaming TTS returned no body");
  }

  // Stream chunks as they arrive from ElevenLabs
  const reader = response.body.getReader();
  // Cancel the reader when abort fires — otherwise reader.read() blocks
  // indefinitely waiting for more data from ElevenLabs, hanging processQueue.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length > 0) {
        yield Buffer.from(value);
      }
    }
  } catch {
    // AbortError or stream cancelled — expected during barge-in
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after cancel
    }
  }
}

/**
 * OpenAI TTS returns raw PCM at 24kHz (16-bit signed LE mono) with response_format=pcm.
 * We stream the response, accumulate enough PCM for resampling (24k→8k requires 3:1 ratio,
 * so we process in blocks), convert to mu-law, and yield chunks.
 */
async function* streamOpenAITelephony(
  text: string,
  config: NonNullable<VoiceCallTtsConfig>,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, unknown> {
  const openai = config.openai;
  const apiKey = openai?.apiKey || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("OpenAI API key required for streaming TTS");
  }

  const model = openai?.model || "gpt-4o-mini-tts";
  const voice = openai?.voice || "coral";

  const body: Record<string, unknown> = {
    model,
    input: text,
    voice,
    response_format: "pcm", // Raw PCM: 24kHz, 16-bit signed LE, mono
  };

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  console.log(
    `[voice-call] OpenAI streaming TTS response: ${response.status} ${response.statusText}`,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OpenAI streaming TTS failed: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error("OpenAI streaming TTS returned no body");
  }

  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // OpenAI PCM is 24kHz 16-bit mono. We need to resample to 8kHz mu-law.
  // Process in blocks: 24kHz * 2 bytes * 0.1s = 4800 bytes per 100ms block.
  // Each 100ms at 24kHz → ~33ms at 8kHz after 3:1 resampling.
  const BLOCK_SIZE = 4800; // 100ms of 24kHz 16-bit mono
  let remainder = Buffer.alloc(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      // Accumulate incoming PCM data
      const chunk = Buffer.from(value);
      remainder = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;

      // Process complete blocks
      while (remainder.length >= BLOCK_SIZE) {
        // Ensure we slice on sample boundaries (2 bytes per sample)
        const blockBytes = Math.floor(BLOCK_SIZE / 2) * 2;
        const block = remainder.subarray(0, blockBytes);
        remainder = remainder.subarray(blockBytes);

        // Resample 24kHz → 8kHz, then encode to mu-law
        const pcm8k = resamplePcmTo8k(block, 24000);
        const mulaw = pcmToMulaw(pcm8k);
        if (mulaw.length > 0) {
          yield mulaw;
        }
      }
    }

    // Flush any remaining PCM data
    if (remainder.length >= 2) {
      const aligned = remainder.subarray(0, Math.floor(remainder.length / 2) * 2);
      const pcm8k = resamplePcmTo8k(aligned, 24000);
      const mulaw = pcmToMulaw(pcm8k);
      if (mulaw.length > 0) {
        yield mulaw;
      }
    }
  } catch {
    // AbortError or stream cancelled — expected during barge-in
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after cancel
    }
  }
}

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime } = params;

  // STRICT CONFIG SCOPE:
  // Voice calls must use ONLY plugins.entries.voice-call.config.tts.
  // We do NOT read or merge core messages.tts (messaging-channel TTS).
  if (!ttsOverride) {
    throw new Error(
      "voice-call TTS not configured: set plugins.entries.voice-call.config.tts (does not use messages.tts)",
    );
  }

  const effectiveConfig: CoreConfig = {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: ttsOverride,
    },
  };

  // Check if direct streaming is available for the configured provider
  const ttsConfig = effectiveConfig.messages?.tts;
  const canStreamElevenLabs =
    ttsConfig?.provider === "elevenlabs" &&
    ttsConfig.elevenlabs?.apiKey &&
    ttsConfig.elevenlabs?.voiceId;

  const canStreamOpenAI =
    ttsConfig?.provider === "openai" && (ttsConfig.openai?.apiKey || process.env.OPENAI_API_KEY);

  return {
    synthesizeForTelephony: async (text: string) => {
      const result = await runtime.textToSpeechTelephony({
        text,
        cfg: effectiveConfig,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },

    // Streaming TTS: stream audio chunks as they arrive from the TTS provider
    ...((canStreamElevenLabs || canStreamOpenAI) && {
      streamForTelephony: (text: string, signal?: AbortSignal) =>
        canStreamElevenLabs
          ? streamElevenLabsTelephony(text, ttsConfig, signal)
          : streamOpenAITelephony(text, ttsConfig, signal),
    }),
  };
}

function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const existing = (base as Record<string, unknown>)[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
