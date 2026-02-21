/**
 * Opus Audio Pipeline for Mumble Voice Chat
 *
 * Handles encoding and decoding of Opus audio using pure WASM libraries
 * - opus-decoder: Decode Opus frames from Mumble to PCM
 * - opus-encdec: Encode PCM to Opus frames for Mumble
 */

import { OpusDecoder } from "opus-decoder";

/**
 * Audio configuration for Mumble
 */
export const MUMBLE_AUDIO_CONFIG = {
  sampleRate: 48000, // Mumble uses 48kHz
  channels: 1, // Mono
  frameSize: 480, // 10ms at 48kHz (48000 * 0.01) - Mumble low-latency standard
  bitRate: 128000, // 128 kbps - high quality for TTS
} as const;

/**
 * Opus Decoder Wrapper
 */
export class MumbleOpusDecoder {
  private decoder?: OpusDecoder;
  private isReady = false;

  async initialize(): Promise<void> {
    if (this.isReady) return;

    this.decoder = new OpusDecoder();
    await this.decoder.ready;
    this.isReady = true;
  }

  /**
   * Decode Opus frame to PCM
   * @param opusData - Encoded Opus frame from Mumble
   * @returns Int16Array PCM data
   */
  async decode(opusData: Buffer): Promise<Int16Array> {
    if (!this.decoder || !this.isReady) {
      throw new Error("Decoder not initialized");
    }

    // Decode to Float32Array
    const decoded = this.decoder.decodeFrame(new Uint8Array(opusData));

    // Convert Float32 to Int16 PCM
    const float32 = decoded.channelData[0];
    const pcm16 = new Int16Array(float32.length);

    for (let i = 0; i < float32.length; i++) {
      // Clamp to [-1, 1] and convert to 16-bit
      const sample = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return pcm16;
  }

  async free(): Promise<void> {
    if (this.decoder) {
      await this.decoder.free();
      this.isReady = false;
    }
  }
}

/**
 * Opus Encoder Wrapper (using @discordjs/opus)
 */
export class MumbleOpusEncoder {
  private encoder?: any;
  private isReady = false;

  async initialize(): Promise<void> {
    if (this.isReady) return;

    const { OpusEncoder } = await import("@discordjs/opus");
    this.encoder = new OpusEncoder(MUMBLE_AUDIO_CONFIG.sampleRate, MUMBLE_AUDIO_CONFIG.channels);

    // Set high bitrate for better TTS quality (128kbps)
    if (this.encoder.setBitrate) {
      this.encoder.setBitrate(MUMBLE_AUDIO_CONFIG.bitRate);
    }

    // Set application type to "audio" for music/TTS quality (not "voip")
    if (this.encoder.setApplication) {
      this.encoder.setApplication("audio");
    }

    this.isReady = true;
  }

  /**
   * Encode PCM to Opus frame
   * @param pcmData - Int16Array or Float32Array PCM data (must be exactly 960 samples for 20ms)
   * @returns Buffer with encoded Opus frame
   */
  async encode(pcmData: Int16Array | Float32Array): Promise<Buffer> {
    if (!this.encoder || !this.isReady) {
      throw new Error("Encoder not initialized");
    }

    if (pcmData.length !== MUMBLE_AUDIO_CONFIG.frameSize) {
      throw new Error(`PCM data must be ${MUMBLE_AUDIO_CONFIG.frameSize} samples (10ms at 48kHz)`);
    }

    // @discordjs/opus expects Buffer input (PCM 16-bit LE)
    let pcmBuffer: Buffer;

    if (pcmData instanceof Int16Array) {
      pcmBuffer = Buffer.from(pcmData.buffer);
    } else {
      // Convert Float32 to Int16
      const int16Data = new Int16Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        const sample = Math.max(-1, Math.min(1, pcmData[i]));
        int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      pcmBuffer = Buffer.from(int16Data.buffer);
    }

    // Encode to Opus
    const encoded = this.encoder.encode(pcmBuffer);

    return encoded;
  }

  async free(): Promise<void> {
    if (this.encoder) {
      this.encoder.delete();
      this.isReady = false;
    }
  }
}

/**
 * Convert PCM Int16Array to WAV Buffer for Whisper STT
 * @param pcm - PCM data as Int16Array
 * @param sampleRate - Sample rate (default 48000)
 * @param channels - Number of channels (default 1)
 * @returns WAV file as Buffer
 */
export function pcmToWav(
  pcm: Int16Array,
  sampleRate: number = MUMBLE_AUDIO_CONFIG.sampleRate,
  channels: number = MUMBLE_AUDIO_CONFIG.channels,
): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length * 2; // 2 bytes per sample (16-bit)
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);
  let offset = 0;

  // RIFF chunk
  buffer.write("RIFF", offset);
  offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  buffer.write("WAVE", offset);
  offset += 4;

  // fmt chunk
  buffer.write("fmt ", offset);
  offset += 4;
  buffer.writeUInt32LE(16, offset);
  offset += 4; // fmt chunk size
  buffer.writeUInt16LE(1, offset);
  offset += 2; // Audio format (1 = PCM)
  buffer.writeUInt16LE(channels, offset);
  offset += 2;
  buffer.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buffer.writeUInt32LE(byteRate, offset);
  offset += 4;
  buffer.writeUInt16LE(blockAlign, offset);
  offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data chunk
  buffer.write("data", offset);
  offset += 4;
  buffer.writeUInt32LE(dataSize, offset);
  offset += 4;

  // Write PCM data
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Accumulator for building complete audio segments from Opus frames
 */
export class AudioFrameAccumulator {
  private frames: Int16Array[] = [];
  private totalSamples = 0;

  /**
   * Add a decoded frame to the accumulator
   */
  addFrame(pcm: Int16Array): void {
    this.frames.push(pcm);
    this.totalSamples += pcm.length;
  }

  /**
   * Get accumulated audio and reset
   */
  getAudio(): Int16Array {
    if (this.frames.length === 0) {
      return new Int16Array(0);
    }

    // Concatenate all frames
    const combined = new Int16Array(this.totalSamples);
    let offset = 0;

    for (const frame of this.frames) {
      combined.set(frame, offset);
      offset += frame.length;
    }

    // Reset
    this.frames = [];
    this.totalSamples = 0;

    return combined;
  }

  /**
   * Check if we have accumulated audio
   */
  hasAudio(): boolean {
    return this.frames.length > 0;
  }

  /**
   * Get duration in seconds
   */
  getDuration(): number {
    return this.totalSamples / MUMBLE_AUDIO_CONFIG.sampleRate;
  }

  /**
   * Reset accumulator
   */
  reset(): void {
    this.frames = [];
    this.totalSamples = 0;
  }
}

/**
 * Chunk PCM audio into 20ms frames for encoding
 * @param pcm - Full PCM audio
 * @returns Array of 20ms frames
 */
export function chunkAudioForEncoding(
  pcm: Int16Array | Float32Array,
): Array<Int16Array | Float32Array> {
  const frames: Array<typeof pcm> = [];
  const frameSize = MUMBLE_AUDIO_CONFIG.frameSize;

  for (let i = 0; i < pcm.length; i += frameSize) {
    const chunk = pcm.slice(i, i + frameSize);

    // Pad last frame if necessary
    if (chunk.length < frameSize) {
      const padded = new (pcm.constructor as any)(frameSize);
      padded.set(chunk);
      frames.push(padded);
    } else {
      frames.push(chunk);
    }
  }

  return frames;
}

/**
 * Sleep utility for frame timing
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
