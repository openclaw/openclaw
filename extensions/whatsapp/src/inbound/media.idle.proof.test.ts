// WhatsApp production-path proof: real saveMediaStream, stalled Baileys iterable.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockNormalizeMessageContent } from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn(),
}));

vi.mock("baileys", async () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

describe("downloadInboundMedia production-path idle proof", () => {
  let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;
  let stateDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;
  const mockSock = {
    updateMediaMessage: vi.fn(),
    logger: { child: () => ({}) },
  };

  beforeAll(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-idle-proof-"));
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ({ downloadInboundMedia } = await import("./media.js"));
  });

  afterEach(async () => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
  });

  it("times out through production saveMediaStream when Baileys stalls", async () => {
    const neverYielding: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Buffer>> {
            return new Promise<IteratorResult<Buffer>>(() => {});
          },
        };
      },
    };
    downloadMediaMessage.mockResolvedValueOnce(neverYielding);

    const startedAt = Date.now();
    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        1024 * 1024,
        { chunkTimeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      name: "WhatsAppInboundMediaTimeoutError",
      chunkTimeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[whatsapp media idle production proof] timed_out=true elapsed_ms=${elapsedMs} real_saveMediaStream=true chunkTimeoutMs=50`,
    );
  });

  afterAll(() => {
    envSnapshot.restore();
    return fs.rm(stateDir, { recursive: true, force: true });
  });
});
