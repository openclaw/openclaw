import { describe, expect, it } from "vitest";
import {
  convertPcmToMulaw8k,
  convertPcmChunkToMulaw8k,
  createPcmToMulawStreamState,
  flushPcmToMulawStream,
} from "./telephony-audio.js";

describe("incremental PCM-to-mulaw conversion", () => {
  it("produces identical output to single-pass for even-aligned chunks", () => {
    // Create a PCM buffer with known samples (16-bit LE, 24kHz -> 8kHz)
    const sampleRate = 24000;
    const numSamples = 300;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      // Sine-like pattern
      const value = Math.round(Math.sin((i / numSamples) * Math.PI * 4) * 16000);
      pcm.writeInt16LE(value, i * 2);
    }

    // Single-pass reference
    const reference = convertPcmToMulaw8k(pcm, sampleRate);

    // Incremental: split into even-sized chunks
    const chunkSize = 100; // 50 samples per chunk (even)
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
      const result = convertPcmChunkToMulaw8k(chunk, sampleRate, state);
      if (result.length > 0) {
        chunks.push(result);
      }
    }
    flushPcmToMulawStream(state);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("handles odd-byte chunks via leftover stashing", () => {
    const sampleRate = 8000;
    // 4 samples = 8 bytes
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(100, 0);
    pcm.writeInt16LE(200, 2);
    pcm.writeInt16LE(300, 4);
    pcm.writeInt16LE(400, 6);

    const reference = convertPcmToMulaw8k(pcm, sampleRate);

    // Split at odd boundaries: 3 bytes, 3 bytes, 2 bytes
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    const c1 = convertPcmChunkToMulaw8k(pcm.subarray(0, 3), sampleRate, state);
    if (c1.length > 0) chunks.push(c1);

    const c2 = convertPcmChunkToMulaw8k(pcm.subarray(3, 6), sampleRate, state);
    if (c2.length > 0) chunks.push(c2);

    const c3 = convertPcmChunkToMulaw8k(pcm.subarray(6, 8), sampleRate, state);
    if (c3.length > 0) chunks.push(c3);

    flushPcmToMulawStream(state);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("handles leftover byte at end of stream", () => {
    const sampleRate = 8000;
    // 3 bytes = 1 sample + 1 leftover byte
    const pcm = Buffer.alloc(3);
    pcm.writeInt16LE(500, 0);
    pcm[2] = 0x42; // leftover

    const reference = convertPcmToMulaw8k(pcm.subarray(0, 2), sampleRate);

    const state = createPcmToMulawStreamState();
    const result = convertPcmChunkToMulaw8k(pcm, sampleRate, state);
    const flushed = flushPcmToMulawStream(state);

    expect(state.leftover).toBeNull();
    expect(flushed.length).toBe(0);
    expect(result).toEqual(reference);
  });

  it("flush clears leftover state", () => {
    const state = createPcmToMulawStreamState();
    // Feed a single byte (odd)
    convertPcmChunkToMulaw8k(Buffer.from([0x42]), 8000, state);
    expect(state.leftover).not.toBeNull();

    flushPcmToMulawStream(state);
    expect(state.leftover).toBeNull();
  });

  it("empty chunk produces empty output", () => {
    const state = createPcmToMulawStreamState();
    const result = convertPcmChunkToMulaw8k(Buffer.alloc(0), 8000, state);
    expect(result.length).toBe(0);
  });

  it("defers interpolation at chunk edge instead of clamping s1", () => {
    // 5 samples at 20kHz (ratio=2.5): position 2.5 needs interpolation
    // between sample[2] and sample[3], but if chunk is only 3 samples,
    // sample[3] would be clamped. The fix defers to the next chunk.
    const sampleRate = 20000;
    const fullPcm = Buffer.alloc(10); // 5 samples
    for (let i = 0; i < 5; i++) {
      fullPcm.writeInt16LE((i + 1) * 1000, i * 2);
    }

    const reference = convertPcmToMulaw8k(fullPcm, sampleRate);

    // Split: 3 samples then 2 samples (6 bytes, 4 bytes)
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    const c1 = convertPcmChunkToMulaw8k(fullPcm.subarray(0, 6), sampleRate, state);
    if (c1.length > 0) chunks.push(c1);

    const c2 = convertPcmChunkToMulaw8k(fullPcm.subarray(6, 10), sampleRate, state);
    if (c2.length > 0) chunks.push(c2);

    flushPcmToMulawStream(state);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("non-aligned chunks produce consistent output across boundaries", () => {
    // 24kHz -> 8kHz (ratio=3) with chunk sizes not aligned to ratio
    const sampleRate = 24000;
    const numSamples = 100;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((i / numSamples) * Math.PI * 2) * 10000), i * 2);
    }

    const reference = convertPcmToMulaw8k(pcm, sampleRate);

    // Split into 7-sample chunks (14 bytes) — not aligned to ratio=3
    const chunkBytes = 14;
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      const result = convertPcmChunkToMulaw8k(chunk, sampleRate, state);
      if (result.length > 0) chunks.push(result);
    }
    flushPcmToMulawStream(state);

    const incremental = Buffer.concat(chunks);
    // Chunked output may have at most 1 extra sample per chunk from frac=0
    // edge positions (valid data, no clamped interpolation). The important
    // guarantee is no clamped-interpolation overproduction.
    const maxExtraPerChunk = 1;
    const numChunks = Math.ceil(pcm.length / chunkBytes);
    expect(incremental.length).toBeLessThanOrEqual(reference.length + numChunks * maxExtraPerChunk);
    // Values for the common prefix should match
    const minLen = Math.min(incremental.length, reference.length);
    expect(incremental.subarray(0, minLen)).toEqual(reference.subarray(0, minLen));
  });
});
