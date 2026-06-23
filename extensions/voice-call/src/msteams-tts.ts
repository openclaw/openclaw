/**
 * Microsoft Teams TTS adapter.
 *
 * The Teams bridge consumes raw PCM 16 kHz, 16-bit mono LE audio, whereas the
 * shared telephony TTS path (`telephony-tts.ts`) emits 8 kHz mu-law for Twilio
 * Media Streams. To keep upstream files untouched, the msteams-specific
 * behavior — synthesize raw PCM, then resample to 16 kHz — lives here. It
 * reuses the upstream host TTS runtime (`TelephonyTtsRuntime.textToSpeechTelephony`)
 * and the SDK resampler instead of duplicating synthesis logic.
 */

import { resamplePcm } from "openclaw/plugin-sdk/realtime-voice";
import { TtsConfigSchema } from "../api.js";
import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { deepMergeDefined } from "./deep-merge.js";
import { MSTEAMS_PCM_SAMPLE_RATE_HZ } from "./msteams-media-stream.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";

/** Teams wire format: PCM 16 kHz, 16-bit mono, little-endian. */
export const MSTEAMS_TTS_SAMPLE_RATE_HZ = MSTEAMS_PCM_SAMPLE_RATE_HZ;

/** Per-character speech timing forwarded from the TTS provider (wall-clock seconds). */
export type MsteamsTtsAlignment = {
  characters: string[];
  startTimesSeconds: number[];
};

export interface MsteamsTtsProvider {
  /**
   * Synthesize `text` and return PCM 16 kHz, 16-bit mono LE audio, resampled
   * from the TTS provider's native rate (e.g. 22050 Hz) when needed.
   */
  synthesizePcm16k(text: string): Promise<Buffer>;
  /**
   * Like `synthesizePcm16k`, but also surfaces the provider's per-character alignment when
   * available (e.g. ElevenLabs with-timestamps) so playback can emit real-timed viseme marks.
   * Optional: older/mock providers without it fall back to estimated viseme timing.
   */
  synthesizePcm16kWithTiming?(
    text: string,
  ): Promise<{ pcm16k: Buffer; alignment?: MsteamsTtsAlignment }>;
}

export function createMsteamsTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
  logger?: {
    warn?: (message: string) => void;
  };
}): MsteamsTtsProvider {
  const { coreConfig, ttsOverride, runtime, logger } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);

  const synthesizePcm16kWithTiming = async (text: string) => {
    // msteams drives avatar viseme/lip-sync, so opt in to provider character alignment.
    const result = await runtime.textToSpeechTelephony({
      text,
      cfg: mergedConfig,
      withTimestamps: true,
    });

    if (!result.success || !result.audioBuffer || !result.sampleRate) {
      throw new Error(result.error ?? "msteams TTS synthesis failed");
    }

    if (result.fallbackFrom && result.provider && result.fallbackFrom !== result.provider) {
      const attemptedChain =
        result.attemptedProviders && result.attemptedProviders.length > 0
          ? result.attemptedProviders.join(" -> ")
          : `${result.fallbackFrom} -> ${result.provider}`;
      logger?.warn?.(
        `[voice-call] msteams TTS fallback used from=${result.fallbackFrom} to=${result.provider} attempts=${attemptedChain}`,
      );
    }

    // Alignment is wall-clock seconds, so it stays valid across the resample below.
    const pcm16k =
      result.sampleRate === MSTEAMS_TTS_SAMPLE_RATE_HZ
        ? result.audioBuffer
        : resamplePcm(result.audioBuffer, result.sampleRate, MSTEAMS_TTS_SAMPLE_RATE_HZ);
    return { pcm16k, alignment: result.alignment };
  };

  return {
    synthesizePcm16k: async (text: string) => (await synthesizePcm16kWithTiming(text)).pcm16k,
    synthesizePcm16kWithTiming,
  };
}

/** Layer the voice-call `tts` override on top of the core `messages.tts` config. */
function applyTtsOverride(coreConfig: CoreConfig, override?: VoiceCallTtsConfig): CoreConfig {
  if (!override) {
    return coreConfig;
  }
  const base = coreConfig.messages?.tts;
  // Validate the merged result against the canonical TTS schema instead of an unchecked cast
  // (mirrors normalizeVoiceCallTtsConfig in config.ts), so an incompatible override surfaces here.
  const merged = base ? TtsConfigSchema.parse(deepMergeDefined(base, override)) : override;
  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged,
    },
  };
}
