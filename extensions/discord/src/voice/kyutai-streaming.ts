// Fork-only: streaming TTS for local Kyutai provider.
// Bypasses the batch SpeechProviderPlugin.synthesize() path by streaming
// s16le PCM directly from the Kyutai HTTP sidecar to a Node.js Readable.
//
// Protocol: POST /v1/audio/speech/stream
//   Response: 8-byte header (PCMS magic + uint32 LE sample_rate) then raw s16le PCM chunks.

import { Readable } from "node:stream";

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

/**
 * Pre-warm the Kyutai TTS model (load into VRAM).
 * Call on Discord VC join or when anticipating voice output.
 * No-op if already loaded. Fire-and-forget safe.
 */
export async function kyutaiPrewarm(): Promise<boolean> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/load`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Release the Kyutai TTS model (free VRAM).
 * Call on Discord VC leave. The idle timeout (300s) also handles this
 * automatically, so this is optional but immediate.
 */
export async function kyutaiRelease(): Promise<boolean> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/unload`, { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the Kyutai TTS sidecar is reachable and whether the model is loaded.
 */
export async function kyutaiStatus(): Promise<{
  reachable: boolean;
  loaded: boolean;
  idleSeconds: number;
}> {
  try {
    const res = await fetch(`${KYUTAI_BASE_URL}/status`);
    if (!res.ok) return { reachable: true, loaded: false, idleSeconds: -1 };
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
// Streaming TTS
// ---------------------------------------------------------------------------

/**
 * Stream TTS audio from the local Kyutai HTTP sidecar.
 * Returns a Readable of raw s16le PCM and the sample rate.
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

  // Collect the 8-byte PCMS header
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

  // Create a Readable that forwards remaining PCM data
  const remainder = headerBuf.subarray(PCMS_HEADER_SIZE);
  const readable = new Readable({ read() {} });

  if (remainder.length > 0) {
    readable.push(remainder);
  }

  // Pump the HTTP body into the Readable (async, non-blocking)
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        readable.push(Buffer.from(value));
      }
    } catch (err) {
      readable.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    readable.push(null); // EOF
  })();

  return { readable, sampleRate };
}


/**
 * Stream TTS audio to a temp WAV file for discord.js playback.
 * Returns the file path (discord.js handles WAV files natively via FFmpeg).
 */
export async function streamKyutaiTtsToFile(text: string): Promise<{ filePath: string; sampleRate: number }> {
  const { readable, sampleRate } = await streamKyutaiTts(text);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `kyutai-stream-${Date.now()}.wav`);

  // Collect all PCM chunks
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const pcmData = Buffer.concat(chunks);

  // Write WAV file
  const numSamples = pcmData.length / 2; // s16le = 2 bytes per sample
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmData]));
  return { filePath, sampleRate };
}
