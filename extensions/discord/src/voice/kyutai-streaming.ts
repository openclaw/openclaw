// Fork-only: streaming TTS for local Kyutai provider.
// Bypasses the batch SpeechProviderPlugin.synthesize() path by streaming
// s16le PCM directly from the Kyutai HTTP sidecar to a Node.js Readable.
//
// Protocol: POST /v1/audio/speech/stream
//   Response: 8-byte header (PCMS magic + uint32 LE sample_rate) then raw s16le PCM chunks.

import { Readable, Transform, type TransformCallback } from "node:stream";

const KYUTAI_BASE_URL = "http://localhost:5123";
const KYUTAI_STREAM_URL = `${KYUTAI_BASE_URL}/v1/audio/speech/stream`;
const PCMS_HEADER_SIZE = 8;

export type KyutaiStreamResult = {
  readable: Readable;
  sampleRate: number;
};

// ---------------------------------------------------------------------------
// Model lifecycle — pre-warm and release
// ---------------------------------------------------------------------------

export async function kyutaiPrewarm(): Promise<boolean> {
  const result = await kyutaiPrewarmWithAudio();
  return result !== null;
}

/**
 * Load model + run warmup inference. Returns the raw 24kHz mono s16le PCM
 * buffer so it can be played as a greeting, or null on failure.
 */
export async function kyutaiPrewarmWithAudio(): Promise<Buffer | null> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/load`, { method: "POST" });
    if (!res.ok) {
      return null;
    }

    // Warmup inference to compile CUDA kernels — collect audio to play as greeting
    try {
      const warmup = await fetch(KYUTAI_STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hey" }),
      });
      if (warmup.body) {
        const reader = warmup.body.getReader();
        const chunks: Buffer[] = [];
        let headerSkipped = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          const buf = Buffer.from(value);
          if (!headerSkipped) {
            // Skip the 8-byte PCMS header
            chunks.push(buf.subarray(PCMS_HEADER_SIZE));
            headerSkipped = true;
          } else {
            chunks.push(buf);
          }
        }
        return Buffer.concat(chunks);
      }
    } catch {
      // Model is loaded even if warmup fails
    }

    return null;
  } catch {
    return null;
  }
}

export async function kyutaiRelease(): Promise<boolean> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/unload`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function kyutaiStatus(): Promise<{
  reachable: boolean;
  loaded: boolean;
  idleSeconds: number;
}> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/status`);
    if (!res.ok) {
      return { reachable: true, loaded: false, idleSeconds: -1 };
    }
    const data = (await res.json()) as { loaded?: boolean; idle_seconds?: number };
    return {
      reachable: true,
      loaded: data.loaded === true,
      idleSeconds: data.idle_seconds ?? -1,
    };
  } catch {
    return { reachable: false, loaded: false, idleSeconds: -1 };
  }
}

// ---------------------------------------------------------------------------
// PCM resampling: 24kHz mono → 48kHz stereo (discord.js Raw format)
// ---------------------------------------------------------------------------

/**
 * Transform stream that converts s16le PCM from 24kHz mono to 48kHz stereo.
 * Uses linear interpolation for upsampling (2x) and duplicates channels.
 * Output is suitable for discord.js StreamType.Raw (48kHz, stereo, s16le).
 */
export class Resample24kMonoTo48kStereo extends Transform {
  private leftover: Buffer = Buffer.alloc(0);

  constructor() {
    // Large buffer: 48kHz stereo s16le = 192KB/s, allow ~5s of buffered audio
    super({ highWaterMark: 1024 * 1024 });
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    const input = this.leftover.length > 0 ? Buffer.concat([this.leftover, chunk]) : chunk;

    const sampleCount = Math.floor(input.length / 2);
    const remainder = input.length % 2;

    if (sampleCount === 0) {
      this.leftover = remainder > 0 ? input.subarray(0, remainder) : Buffer.alloc(0);
      callback();
      return;
    }

    // Each input sample → 2 output samples (48/24 = 2x), each stereo (×2 channels)
    // So each input sample produces 2 × 2 = 4 s16le values = 8 bytes
    const output = Buffer.alloc(sampleCount * 8);
    let outIdx = 0;

    for (let i = 0; i < sampleCount; i++) {
      const s0 = input.readInt16LE(i * 2);
      const s1 = i + 1 < sampleCount ? input.readInt16LE((i + 1) * 2) : s0;

      const mid = ((s0 + s1) >> 1) | 0;

      // Sample 1: original, duplicated to both channels
      output.writeInt16LE(s0, outIdx);
      outIdx += 2;
      output.writeInt16LE(s0, outIdx);
      outIdx += 2;
      // Sample 2: interpolated, duplicated to both channels
      output.writeInt16LE(mid, outIdx);
      outIdx += 2;
      output.writeInt16LE(mid, outIdx);
      outIdx += 2;
    }

    this.leftover = remainder > 0 ? input.subarray(sampleCount * 2) : Buffer.alloc(0);

    this.push(output);
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.leftover = Buffer.alloc(0);
    callback();
  }
}

// ---------------------------------------------------------------------------
// Streaming TTS
// ---------------------------------------------------------------------------

/**
 * Stream TTS audio from the local Kyutai HTTP sidecar.
 * Returns a Readable of raw s16le PCM (24kHz mono) and the sample rate.
 */
export async function streamKyutaiTts(text: string): Promise<KyutaiStreamResult> {
  const res = await fetch(KYUTAI_STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`Kyutai stream error (${res.status}): ${errBody}`);
  }
  if (!res.body) {
    throw new Error("Kyutai stream: response has no body");
  }

  const reader = res.body.getReader();

  let headerBuf = Buffer.alloc(0);
  while (headerBuf.length < PCMS_HEADER_SIZE) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("Kyutai stream ended before PCMS header was received");
    }
    headerBuf = Buffer.concat([headerBuf, Buffer.from(value)]);
  }

  const magic = headerBuf.subarray(0, 4).toString("ascii");
  if (magic !== "PCMS") {
    throw new Error(`Kyutai stream: invalid header magic "${magic}" (expected PCMS)`);
  }
  const sampleRate = headerBuf.readUInt32LE(4);

  const remainder = headerBuf.subarray(PCMS_HEADER_SIZE);
  const readable = new Readable({ read() {}, highWaterMark: 1024 * 1024 });

  if (remainder.length > 0) {
    readable.push(remainder);
  }

  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        readable.push(Buffer.from(value));
      }
    } catch (err) {
      readable.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    readable.push(null);
  })();

  return { readable, sampleRate };
}

/**
 * Stream TTS and return a Readable of 48kHz stereo s16le PCM,
 * ready for discord.js createAudioResource with StreamType.Raw.
 */
export async function streamKyutaiTtsRaw48k(text: string): Promise<Readable> {
  const { readable } = await streamKyutaiTts(text);
  const resampler = new Resample24kMonoTo48kStereo();
  readable.pipe(resampler);

  // Forward errors
  readable.on("error", (err) => resampler.destroy(err));

  return resampler;
}

/**
 * Stream TTS audio to a temp WAV file for discord.js playback.
 * Fallback path — collects all PCM then writes WAV.
 */
export async function streamKyutaiTtsToFile(
  text: string,
): Promise<{ filePath: string; sampleRate: number }> {
  const { readable, sampleRate } = await streamKyutaiTts(text);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `kyutai-stream-${Date.now()}.wav`);

  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const pcmData = Buffer.concat(chunks);

  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmData]));
  return { filePath, sampleRate };
}
