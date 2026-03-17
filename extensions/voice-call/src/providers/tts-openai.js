import { resolveOpenAITtsInstructions } from "openclaw/plugin-sdk/voice-call";
import { pcmToMulaw } from "../telephony-audio.js";
const OPENAI_TTS_VOICES = [
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
  "cedar"
];
function trimToUndefined(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
class OpenAITTSProvider {
  constructor(config = {}) {
    this.apiKey = trimToUndefined(config.apiKey) ?? trimToUndefined(process.env.OPENAI_API_KEY) ?? "";
    this.model = trimToUndefined(config.model) ?? "gpt-4o-mini-tts";
    this.voice = trimToUndefined(config.voice) ?? "coral";
    this.speed = config.speed ?? 1;
    this.instructions = trimToUndefined(config.instructions);
    if (!this.apiKey) {
      throw new Error("OpenAI API key required (set OPENAI_API_KEY or pass apiKey)");
    }
  }
  /**
   * Generate speech audio from text.
   * Returns raw PCM audio data (24kHz, mono, 16-bit).
   */
  async synthesize(text, instructions) {
    const body = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: "pcm",
      // Raw PCM audio (24kHz, mono, 16-bit signed LE)
      speed: this.speed
    };
    const effectiveInstructions = resolveOpenAITtsInstructions(
      this.model,
      trimToUndefined(instructions) ?? this.instructions
    );
    if (effectiveInstructions) {
      body.instructions = effectiveInstructions;
    }
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS failed: ${response.status} - ${error}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  /**
   * Generate speech and convert to mu-law format for Twilio.
   * Twilio Media Streams expect 8kHz mono mu-law audio.
   */
  async synthesizeForTwilio(text) {
    const pcm24k = await this.synthesize(text);
    const pcm8k = resample24kTo8k(pcm24k);
    return pcmToMulaw(pcm8k);
  }
}
function resample24kTo8k(input) {
  const inputSamples = input.length / 2;
  const outputSamples = Math.floor(inputSamples / 3);
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * 3;
    const srcIdx = srcPos * 2;
    if (srcIdx + 3 < input.length) {
      const s0 = input.readInt16LE(srcIdx);
      const s1 = input.readInt16LE(srcIdx + 2);
      const frac = srcPos % 1 || 0;
      const sample = Math.round(s0 + frac * (s1 - s0));
      output.writeInt16LE(clamp16(sample), i * 2);
    } else {
      output.writeInt16LE(input.readInt16LE(srcIdx), i * 2);
    }
  }
  return output;
}
function clamp16(value) {
  return Math.max(-32768, Math.min(32767, value));
}
function mulawToLinear(mulaw) {
  mulaw = ~mulaw & 255;
  const sign = mulaw & 128;
  const exponent = mulaw >> 4 & 7;
  const mantissa = mulaw & 15;
  let sample = (mantissa << 3) + 132 << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}
function chunkAudio(audio, chunkSize = 160) {
  return (function* () {
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.subarray(i, Math.min(i + chunkSize, audio.length));
    }
  })();
}
export {
  OPENAI_TTS_VOICES,
  OpenAITTSProvider,
  chunkAudio,
  mulawToLinear
};
