// Fork-only tests for kyutai-streaming.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

// We test the protocol parsing and stream behavior by mocking fetch.

function buildPcmsResponse(sampleRate: number, pcmChunks: Buffer[]): ReadableStream<Uint8Array> {
  const header = Buffer.alloc(8);
  header.write("PCMS", 0, 4, "ascii");
  header.writeUInt32LE(sampleRate, 4);

  const allChunks = [header, ...pcmChunks];
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < allChunks.length) {
        controller.enqueue(new Uint8Array(allChunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

function mockFetch(body: ReadableStream<Uint8Array>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    body,
    text: () => Promise.resolve("error body"),
  });
}

async function collectReadable(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("streamKyutaiTts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses PCMS header and returns correct sample rate", async () => {
    const pcm = Buffer.from(new Int16Array([100, 200, 300, 400]).buffer);
    const body = buildPcmsResponse(24000, [pcm]);
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    const { readable, sampleRate } = await streamKyutaiTts("hello");

    expect(sampleRate).toBe(24000);
    const collected = await collectReadable(readable);
    expect(collected.length).toBe(pcm.length);
    expect(collected).toEqual(pcm);
  });

  it("handles multiple PCM chunks streamed sequentially", async () => {
    const chunk1 = Buffer.from(new Int16Array([1, 2, 3]).buffer);
    const chunk2 = Buffer.from(new Int16Array([4, 5, 6]).buffer);
    const body = buildPcmsResponse(48000, [chunk1, chunk2]);
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    const { readable, sampleRate } = await streamKyutaiTts("test");

    expect(sampleRate).toBe(48000);
    const collected = await collectReadable(readable);
    expect(collected.length).toBe(chunk1.length + chunk2.length);
  });

  it("handles header split across multiple chunks", async () => {
    // Header arrives in two pieces (e.g., 4 bytes then 4 bytes + PCM)
    const pcm = Buffer.from(new Int16Array([10, 20]).buffer);
    const header = Buffer.alloc(8);
    header.write("PCMS", 0, 4, "ascii");
    header.writeUInt32LE(24000, 4);

    const firstHalf = header.subarray(0, 4);
    const secondHalf = Buffer.concat([header.subarray(4), pcm]);

    let index = 0;
    const chunks = [firstHalf, secondHalf];
    const body = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(new Uint8Array(chunks[index]!));
          index++;
        } else {
          controller.close();
        }
      },
    });
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    const { readable, sampleRate } = await streamKyutaiTts("split header");

    expect(sampleRate).toBe(24000);
    const collected = await collectReadable(readable);
    expect(collected).toEqual(pcm);
  });

  it("throws on invalid magic bytes", async () => {
    const header = Buffer.alloc(8);
    header.write("XXXX", 0, 4, "ascii");
    header.writeUInt32LE(24000, 4);

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(header));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    await expect(streamKyutaiTts("bad magic")).rejects.toThrow("invalid header magic");
  });

  it("throws on HTTP error response", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    vi.stubGlobal("fetch", mockFetch(body, 503));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    await expect(streamKyutaiTts("error")).rejects.toThrow("Kyutai stream error (503)");
  });

  it("throws if stream ends before header is complete", async () => {
    const partial = Buffer.from("PCM"); // only 3 bytes, need 8
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(partial));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    await expect(streamKyutaiTts("short")).rejects.toThrow("before PCMS header");
  });

  it("destroys readable on mid-stream fetch error", async () => {
    const header = Buffer.alloc(8);
    header.write("PCMS", 0, 4, "ascii");
    header.writeUInt32LE(24000, 4);

    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index === 0) {
          controller.enqueue(new Uint8Array(header));
          index++;
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    vi.stubGlobal("fetch", mockFetch(body));

    const { streamKyutaiTts } = await import("./kyutai-streaming.js");
    const { readable } = await streamKyutaiTts("mid-stream error");

    // The readable should eventually be destroyed with an error
    await expect(
      new Promise((resolve, reject) => {
        readable.on("error", reject);
        readable.on("end", resolve);
        readable.resume(); // consume
      }),
    ).rejects.toThrow("connection reset");
  });
});
