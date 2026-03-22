import type { VoiceCallTtsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import { deepMergeDefined } from "./deep-merge.js";
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

export type StreamingAudioCallback = (muLawChunk: Buffer) => void | Promise<void>;

export type TelephonyTtsProvider = {
  synthesizeForTelephony: (text: string) => Promise<Buffer>;
  /** Optional streaming synthesis - yields audio chunks as they become available */
  synthesizeForTelephonyStreaming?: (text: string, onChunk: StreamingAudioCallback) => Promise<void>;
};

export function createTelephonyTtsProvider(params: {
  coreConfig: CoreConfig;
  ttsOverride?: VoiceCallTtsConfig;
  runtime: TelephonyTtsRuntime;
}): TelephonyTtsProvider {
  const { coreConfig, ttsOverride, runtime } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);

  // Get OpenAI API key from environment or config for streaming support
  const openAiApiKey = process.env.OPENAI_API_KEY;

  const provider: TelephonyTtsProvider = {
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
  };

  // Add streaming support if OpenAI API key is available
  // This enables real-time audio streaming to prevent multi-second gaps during TTS
  if (openAiApiKey) {
    provider.synthesizeForTelephonyStreaming = async (
      text: string,
      onChunk: StreamingAudioCallback,
    ): Promise<void> => {
      // Use OpenAI's streaming TTS API for real-time audio generation
      // Get voice from config or use default
      const voice = mergedConfig.messages?.tts?.voice ?? "coral";
      const speed = mergedConfig.messages?.tts?.speed ?? 1.0;
      const instructions = mergedConfig.messages?.tts?.instructions;

      // Build request body
      const body: Record<string, unknown> = {
        model: "gpt-4o-mini-tts",
        input: text,
        voice,
        response_format: "pcm",
        speed,
      };

      if (instructions) {
        body.instructions = instructions;
      }

      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI TTS streaming failed: ${response.status} - ${error}`);
      }

      if (!response.body) {
        throw new Error("OpenAI TTS streaming failed: no response body");
      }

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      // Batch mu-law bytes for efficient chunking (160 bytes = 20ms at 8kHz)
      const muLawBatch: number[] = [];
      const BATCH_SIZE = 160;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Append new data to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          // Process complete samples (2 bytes per 16-bit sample at 24kHz)
          // Downsample from 24kHz to 8kHz (3:1 ratio)
          while (buffer.length >= 6) {
            // Take middle sample for 24kHz -> 8kHz conversion
            const sample = buffer.readInt16LE(2);
            const muLawByte = linearToMulaw(sample);
            muLawBatch.push(muLawByte);

            // Send batch when full
            if (muLawBatch.length >= BATCH_SIZE) {
              await onChunk(Buffer.from(muLawBatch));
              muLawBatch.length = 0;
            }

            // Move forward 2 samples (4 bytes) at 24kHz to output 1 sample at 8kHz
            buffer = buffer.subarray(4);
          }
        }

        // Send remaining bytes
        if (muLawBatch.length > 0) {
          await onChunk(Buffer.from(muLawBatch));
        }

        // Process any remaining buffer bytes
        if (buffer.length >= 2) {
          const padded = new Uint8Array(6);
          padded.set(buffer);
          const sample = padded.readInt16LE(2);
          const muLawByte = linearToMulaw(sample);
          await onChunk(Buffer.from([muLawByte]));
        }
      } finally {
        reader.releaseLock();
      }
    };
  }

  return provider;
}

// Linear to mu-law conversion (same as in telephony-audio.ts)
function linearToMulaw(sample: number): number {
  const BIAS = 132;
  const CLIP = 32635;

  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) {
    sample = -sample;
  }
  if (sample > CLIP) {
    sample = CLIP;
  }

  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
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
  return deepMergeDefined(base, override) as VoiceCallTtsConfig;
}
