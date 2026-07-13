// Feishu production-path proof: real saveMediaStream against stalled iterable.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("times out through production saveMediaStream when the source stalls", async () => {
    const neverYielding: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            return new Promise<IteratorResult<Buffer>>(() => {});
          },
        };
      },
    };

    const startedAt = Date.now();
    await expect(
      saveMediaStreamWithIdleTimeout(neverYielding, "image/jpeg", 1024, undefined, 50),
    ).rejects.toMatchObject({
      name: "FeishuInboundMediaTimeoutError",
      chunkTimeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[feishu media idle production proof] timed_out=true elapsed_ms=${elapsedMs} real_saveMediaStream=true chunkTimeoutMs=50`,
    );
  });
});
