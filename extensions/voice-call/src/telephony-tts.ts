import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { TtsDirectiveOverrides, TtsDirectiveParseResult } from "openclaw/plugin-sdk/speech";
import type { VoiceCallTtsConfig } from "./config.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";
import { chunkTelephonyReply, MAX_TELEPHONY_TTS_SYNTH_CHARS } from "./telephony-tts-chunking.js";

// Telephony TTS adapter that applies voice-call overrides and emits 8kHz mulaw audio.

/** Core runtime TTS API used by the telephony adapter. */
export type TelephonyTtsRuntime = {
  prepareTtsRequest: (params: {
    cfg: OpenClawConfig;
    override?: VoiceCallTtsConfig;
    text: string;
  }) => Promise<{
    cfg: OpenClawConfig;
    directives: TtsDirectiveParseResult;
  }>;
  textToSpeechTelephony: (params: {
    text: string;
    cfg: OpenClawConfig;
    prefsPath?: string;
    overrides?: TtsDirectiveOverrides;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    outputFormat?: string;
    fallbackFrom?: string;
    attemptedProviders?: string[];
    error?: string;
  }>;
};

/**
 * One reply, resolved for speech: inline TTS directives have been applied
 * exactly once over the complete text, and `segments` is the resulting spoken
 * text split for synthesis. Every segment synthesizes under the same resolved
 * override set, so splitting cannot divide a directive block or apply an
 * audio-only override per segment.
 */
export type TelephonySpeechPlan = {
  /** Bounded pieces of the resolved spoken text, in playback order. */
  segments: string[];
  /** Synthesize one segment under the already-resolved overrides. */
  synthesizeSegment: (segment: string) => Promise<Buffer>;
};

/** Provider facade used by Twilio/webhook code for telephony synthesis. */
export type TelephonyTtsProvider = {
  synthesisTimeoutMs: number;
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
  /**
   * Prepare a complete reply for segmented playback. Callers that stream audio
   * themselves use this; callers that hand the whole reply to the carrier in
   * one operation keep using `synthesizeForTelephony`.
   */
  prepareSpeech: (text: string) => Promise<TelephonySpeechPlan>;
};

/** Default timeout for one telephony synthesis request. */
export const TELEPHONY_DEFAULT_TTS_TIMEOUT_MS = 8000;

class UnsupportedTelephonyTtsOutputFormatError extends Error {
  constructor(
    readonly outputFormat: string,
    readonly provider: string,
  ) {
    super(`Unsupported telephony TTS output format "${outputFormat}" from provider "${provider}"`);
    this.name = "UnsupportedTelephonyTtsOutputFormatError";
  }
}

function convertTelephonyTtsOutput(result: {
  audioBuffer: Buffer;
  outputFormat?: string;
  provider?: string;
  sampleRate: number;
}): Buffer {
  const format = result.outputFormat?.trim().toLowerCase();
  // Bundled provider contracts: Azure/Gradium emit raw-8khz-8bit-mono-mulaw/ulaw_8000;
  // ElevenLabs/OpenAI emit pcm_22050/pcm. An absent format is the shipped PCM default.
  const isRawMulaw = format === "raw-8khz-8bit-mono-mulaw" || format === "ulaw_8000";
  if (isRawMulaw && result.sampleRate === 8_000) {
    return result.audioBuffer;
  }
  const isPcm =
    !format ||
    format === "pcm" ||
    /^pcm[_-]\d+$/.test(format) ||
    (format.includes("raw") &&
      (format.includes("16bit") || format.includes("16-bit")) &&
      format.includes("pcm"));
  if (isPcm) {
    return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
  }
  throw new UnsupportedTelephonyTtsOutputFormatError(
    result.outputFormat ?? "absent",
    result.provider ?? "unknown",
  );
}

/** Create a TTS provider that honors voice-call overrides and converts PCM to mulaw. */
export async function createTelephonyTtsProvider(params: {
  coreConfig: OpenClawConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
  logger?: {
    warn?: (message: string) => void;
  };
}): Promise<TelephonyTtsProvider> {
  const { coreConfig, ttsOverride, runtime, logger } = params;
  const preparedConfig = await runtime.prepareTtsRequest({
    cfg: coreConfig,
    override: ttsOverride,
    text: "",
  });
  const synthesisTimeoutMs = resolveTimerTimeoutMs(
    preparedConfig.cfg.tts?.timeoutMs,
    TELEPHONY_DEFAULT_TTS_TIMEOUT_MS,
  );

  /**
   * Apply the inline TTS directive contract to a complete reply exactly once.
   * Returns the spoken text plus the resolved config and overrides that every
   * synthesis for this reply must reuse.
   */
  const resolveSpeech = async (text: string) => {
    const prepared = await runtime.prepareTtsRequest({
      cfg: preparedConfig.cfg,
      text,
    });
    const directives = prepared.directives;
    if (directives.warnings.length > 0) {
      logger?.warn?.(
        `[voice-call] Ignored telephony TTS directive overrides (${directives.warnings.join("; ")})`,
      );
    }
    const cleanText = directives.hasDirective
      ? directives.ttsText?.trim() || directives.cleanedText.trim()
      : text;
    return { cleanText, cfg: prepared.cfg, overrides: directives.overrides };
  };

  const synthesizeResolved = async (
    text: string,
    cfg: OpenClawConfig,
    overrides: TtsDirectiveOverrides | undefined,
  ): Promise<Buffer> => {
    const result = await runtime.textToSpeechTelephony({ text, cfg, overrides });

    if (!result.success || !result.audioBuffer || !result.sampleRate) {
      throw new Error(result.error ?? "TTS conversion failed");
    }

    if (result.fallbackFrom && result.provider && result.fallbackFrom !== result.provider) {
      const attemptedChain =
        result.attemptedProviders && result.attemptedProviders.length > 0
          ? result.attemptedProviders.join(" -> ")
          : `${result.fallbackFrom} -> ${result.provider}`;
      logger?.warn?.(
        `[voice-call] Telephony TTS fallback used from=${result.fallbackFrom} to=${result.provider} attempts=${attemptedChain}`,
      );
    }

    return convertTelephonyTtsOutput({
      audioBuffer: result.audioBuffer,
      outputFormat: result.outputFormat,
      provider: result.provider,
      sampleRate: result.sampleRate,
    });
  };

  return {
    synthesisTimeoutMs,
    synthesizeForTelephony: async (text: string) => {
      const resolved = await resolveSpeech(text);
      return synthesizeResolved(resolved.cleanText, resolved.cfg, resolved.overrides);
    },
    prepareSpeech: async (text: string) => {
      const resolved = await resolveSpeech(text);
      return {
        segments: chunkTelephonyReply(resolved.cleanText, MAX_TELEPHONY_TTS_SYNTH_CHARS),
        synthesizeSegment: (segment: string) =>
          synthesizeResolved(segment, resolved.cfg, resolved.overrides),
      };
    },
  };
}
