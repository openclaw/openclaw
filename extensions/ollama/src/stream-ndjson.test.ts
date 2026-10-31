// This suite owns NDJSON record framing and size bounds. Reader-cancellation
// lifecycle cases stay with the guarded stream tests in stream-runtime.test.ts.
// Match the complete content-free diagnostic, not just its prefix.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createClosedChunkStream } from "../../test-support/streaming-error-response.js";
import { parseNdjsonStream } from "./stream-ndjson.js";

function mockNdjsonReader(lines: string[], options: { trailingNewline?: boolean } = {}) {
  const payload = lines.join("\n") + (options.trailingNewline === false ? "" : "\n");
  return expectDefined(new Response(payload).body, "NDJSON response body").getReader();
}

async function expectNoParsedChunks(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: unknown[] = [];
  for await (const chunk of parseNdjsonStream(reader)) {
    chunks.push(chunk);
  }
  expect(chunks).toEqual([]);
}

describe("parseNdjsonStream", () => {
  it("cancels an oversized unterminated record", async () => {
    const oversizedRecord = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x20);
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedRecord);
      },
      cancel() {
        canceled = true;
      },
    });
    const reader = stream.getReader();

    await expect(expectNoParsedChunks(reader)).rejects.toThrow(
      "Ollama NDJSON record exceeds 16777216 bytes",
    );
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("resets the record limit after each newline", async () => {
    const legalRecord = new Uint8Array(9 * 1024 * 1024 + 1).fill(0x20);
    legalRecord[legalRecord.length - 1] = 0x0a;
    const reader = createClosedChunkStream([legalRecord, legalRecord]).getReader();

    await expectNoParsedChunks(reader);
  });

  it("rejects malformed trailing data without exposing its bytes", async () => {
    const prefix = "x".repeat(119);
    const reader = mockNdjsonReader([`${prefix}\u{1f600}tail`], { trailingNewline: false });

    await expect(expectNoParsedChunks(reader)).rejects.toMatchObject({
      message: "OpenClaw transport error: malformed_streaming_fragment",
    });
  });

  it.each(["null"])("rejects non-object NDJSON records: %s", async (record) => {
    await expect(expectNoParsedChunks(mockNdjsonReader([record]))).rejects.toThrow(
      "OpenClaw transport error: malformed_streaming_fragment",
    );
  });
});
