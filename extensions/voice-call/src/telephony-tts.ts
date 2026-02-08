import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";

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

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);

  // Check if direct ElevenLabs streaming is available
  const ttsConfig = mergedConfig.messages?.tts;
  const canStreamElevenLabs =
    ttsConfig?.provider === "elevenlabs" &&
    ttsConfig.elevenlabs?.apiKey &&
    ttsConfig.elevenlabs?.voiceId;

  return {
    synthesizeForTelephony: async (text: string) => {
      const result = await runtime.textToSpeechTelephony({
        text,
        cfg: mergedConfig,
      });

      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }

      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    },

    // Streaming TTS: stream audio chunks as they arrive from the TTS provider
    ...(canStreamElevenLabs && {
      streamForTelephony: (text: string, signal?: AbortSignal) =>
        streamElevenLabsTelephony(text, ttsConfig, signal),
    }),
  };
}

function applyTtsOverride(coreConfig: CoreConfig, override?: VoiceCallTtsConfig): CoreConfig {
  if (!override) {
    return coreConfig;
  }

  const base = coreConfig.messages?.tts;
  const merged = mergeTtsConfig(base, override);
  if (!merged) {
    return coreConfig;
  }

  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged,
    },
  };
}

function mergeTtsConfig(
  base?: VoiceCallTtsConfig,
  override?: VoiceCallTtsConfig,
): VoiceCallTtsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!override) {
    return base;
  }
  if (!base) {
    return override;
  }
  return deepMerge(base, override);
}

function deepMerge<T>(base: T, override: T): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
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
