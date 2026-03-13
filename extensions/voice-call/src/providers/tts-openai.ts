import { resolveOpenAITtsInstructions } from "openclaw/plugin-sdk/voice-call";
import { pcmToMulaw } from "../telephony-audio.js";

/**
 * OpenAI TTS Provider
 *
 * Generates speech audio using OpenAI's text-to-speech API.
 * Handles audio format conversion for telephony (mu-law 8kHz).
 *
 * Best practices from OpenAI docs:
 * - Use gpt-4o-mini-tts for intelligent realtime applications (supports instructions)
 * - Use tts-1 for lower latency, tts-1-hd for higher quality
 * - Use marin or cedar voices for best quality
 * - Use pcm or wav format for fastest response times
 *
 * @see https://platform.openai.com/docs/guides/text-to-speech
 */

/**
 * OpenAI TTS configuration.
 */
export interface OpenAITTSConfig {
  /** OpenAI API key (uses OPENAI_API_KEY env if not set) */
  apiKey?: string;
  /**
   * TTS model:
   * - gpt-4o-mini-tts: newest, supports instructions for tone/style control (recommended)
   * - tts-1: lower latency
   * - tts-1-hd: higher quality
   */
  model?: string;
  /**
   * Voice to use. For best quality, use marin or cedar.
   * All 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
   * Note: tts-1/tts-1-hd only support: alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer
   */
  voice?: string;
  /** Speed multiplier (0.25 to 4.0) */
  speed?: number;
  /**
   * Instructions for speech style (only works with gpt-4o-mini-tts model).
   * Examples: "Speak in a cheerful tone", "Talk like a sympathetic customer service agent"
   */
  instructions?: string;
}

/**
 * Supported OpenAI TTS voices (all 13 built-in voices).
 * For best quality, use marin or cedar.
 * Note: tts-1 and tts-1-hd support a smaller set.
 */
export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export type OpenAITTSVoice = (typeof OPENAI_TTS_VOICES)[number];

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * OpenAI TTS Provider for generating speech audio.
 */
export class OpenAITTSProvider {
  private apiKey: string;
  private model: string;
  private voice: OpenAITTSVoice;
  private speed: number;
  private instructions?: string;

  constructor(config: OpenAITTSConfig = {}) {
    this.apiKey =
      trimToUndefined(config.apiKey) ?? trimToUndefined(process.env.OPENAI_API_KEY) ?? "";
    // Default to gpt-4o-mini-tts for intelligent realtime applications
    this.model = trimToUndefined(config.model) ?? "gpt-4o-mini-tts";
    // Default to coral - good balance of quality and natural tone
    this.voice = (trimToUndefined(config.voice) as OpenAITTSVoice | undefined) ?? "coral";
    this.speed = config.speed ?? 1.0;
    this.instructions = trimToUndefined(config.instructions);

    if (!this.apiKey) {
      throw new Error("OpenAI API key required (set OPENAI_API_KEY or pass apiKey)");
    }
  }

  /**
   * Generate speech audio from text.
   * Returns raw PCM audio data (24kHz, mono, 16-bit).
   */
  async synthesize(text: string, instructions?: string): Promise<Buffer> {
    // Build request body
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: "pcm", // Raw PCM audio (24kHz, mono, 16-bit signed LE)
      speed: this.speed,
    };

    const effectiveInstructions = resolveOpenAITtsInstructions(
      this.model,
      trimToUndefined(instructions) ?? this.instructions,
    );
    if (effectiveInstructions) {
      body.instructions = effectiveInstructions;
    }

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new Error(
        `OpenAI TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (err) {
      throw new Error(
        `OpenAI TTS response read failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    return Buffer.from(arrayBuffer);
  }

  /**
   * Generate speech and convert to mu-law format for Twilio.
   * Twilio Media Streams expect 8kHz mono mu-law audio.
   */
  async synthesizeForTwilio(text: string): Promise<Buffer> {
    // Get raw PCM from OpenAI (24kHz, 16-bit signed LE, mono)
    const pcm24k = await this.synthesize(text);

    // Resample from 24kHz to 8kHz
    const pcm8k = resample24kTo8k(pcm24k);

    // Encode to mu-law
    return pcmToMulaw(pcm8k);
  }
}

/**
 * Resample 24kHz PCM to 8kHz using linear interpolation.
 * Input/output: 16-bit signed little-endian mono.
 */
function resample24kTo8k(input: Buffer): Buffer {
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples / 3);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    // Calculate position in input (3:1 ratio)
    const srcPos = i * 3;
    const srcIdx = srcPos * 2;

    if (srcIdx + 3 < input.length) {
      // Linear interpolation between samples
      const s0 = input.readInt16LE(srcIdx);
      const s1 = input.readInt16LE(srcIdx + 2);
      const frac = srcPos % 1 || 0;
      const sample = Math.round(s0 + frac * (s1 - s0));
      output.writeInt16LE(clamp16(sample), i * 2);
    } else {
      // Last sample
      output.writeInt16LE(input.readInt16LE(srcIdx), i * 2);
    }
  }

  return output;
}

/**
 * Clamp value to 16-bit signed integer range.
 */
function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Convert 8-bit mu-law to 16-bit linear PCM.
 * Useful for decoding incoming audio.
 */
export function mulawToLinear(mulaw: number): number {
  // mu-law is transmitted inverted
  mulaw = ~mulaw & 0xff;

  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;

  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;

  return sign ? -sample : sample;
}

/**
 * Chunk audio buffer into 20ms frames for streaming.
 * At 8kHz mono, 20ms = 160 samples = 160 bytes (mu-law).
 */
export function chunkAudio(audio: Buffer, chunkSize = 160): Generator<Buffer, void, unknown> {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
