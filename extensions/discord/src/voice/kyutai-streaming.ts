// Fork-only: streaming TTS for local Kyutai provider.
// Bypasses the batch SpeechProviderPlugin.synthesize() path by streaming
// s16le PCM directly from the Kyutai HTTP sidecar to a Node.js Readable.
//
// Protocol: POST /v1/audio/speech/stream
//   Response: 8-byte header (PCMS magic + uint32 LE sample_rate) then raw s16le PCM chunks.

import { Readable } from "node:stream";

const KYUTAI_STREAM_URL = "http://localhost:5123/v1/audio/speech/stream";
const PCMS_HEADER_SIZE = 8;

export type KyutaiStreamResult = {
  readable: Readable;
  sampleRate: number;
};

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
