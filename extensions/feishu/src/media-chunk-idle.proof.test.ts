import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Feishu production-path proof: real saveMediaStream against stalled Node.js
// Readable streams — the exact boundary Lark SDK `getReadableStream()` returns.
import { Readable } from "node:stream";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("saveMediaStreamWithIdleTimeout production-path proof", () => {
  let saveMediaStreamWithIdleTimeout: typeof import("./media-chunk-idle.js").saveMediaStreamWithIdleTimeout;
  let stateDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-idle-proof-"));
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ({ saveMediaStreamWithIdleTimeout } = await import("./media-chunk-idle.js"));
  });

  afterAll(() => {
    envSnapshot.restore();
    return fs.rm(stateDir, { recursive: true, force: true });
  });

  // Lark SDK `getReadableStream()` returns a Node.js Readable. When the
  // underlying HTTP response stalls, the Readable's internal buffer stays
  // empty and `for await` hangs — the exact bug this PR fixes.
  it("times out a stalled Node.js Readable (Lark SDK boundary) and destroys the source", async () => {
    const stalledReadable = new Readable({
      read() {
        // Never push data, never end — simulates a stalled Lark HTTP response
        // body. The Readable stays in flowing=false with an empty buffer, so
        // the async iterator's next() never settles.
      },
    });

    const startedAt = Date.now();
    await expect(
      saveMediaStreamWithIdleTimeout(stalledReadable, "image/jpeg", 1024, undefined, 50),
    ).rejects.toMatchObject({
      name: "FeishuInboundMediaTimeoutError",
      chunkTimeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    // The stalled source must be destroyed so the underlying resource closes.
    expect(stalledReadable.destroyed).toBe(true);
    console.log(
      `[feishu media idle production proof] boundary=Readable timed_out=true elapsed_ms=${elapsedMs} chunkTimeoutMs=50 destroyed=true`,
    );
  });

  it("completes a progressing Readable through real saveMediaStream without timeout", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const progressing = Readable.from([jpeg]);

    const result = await saveMediaStreamWithIdleTimeout(
      progressing,
      "image/jpeg",
      1024,
      undefined,
      50,
    );
    expect(result.size).toBe(jpeg.byteLength);
    expect(result.contentType).toBe("image/jpeg");
    console.log(
      `[feishu media idle production proof] progressing_readable=true size=${result.size} timed_out=false`,
    );
  });

  it("does not time out a multi-chunk Readable that completes within the deadline", async () => {
    const chunks = [Buffer.alloc(512), Buffer.alloc(512), Buffer.alloc(256)];
    const multiChunk = Readable.from(chunks);
    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);

    const result = await saveMediaStreamWithIdleTimeout(
      multiChunk,
      "application/octet-stream",
      totalBytes * 2,
      undefined,
      200,
    );
    expect(result.size).toBe(totalBytes);
    console.log(
      `[feishu media idle production proof] multi_chunk_readable=true chunks=${chunks.length} total_bytes=${totalBytes} timed_out=false`,
    );
  });
});
