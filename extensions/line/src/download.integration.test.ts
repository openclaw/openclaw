// Integration proof: real saveMediaStream + mocked LINE client shows filename-based audio detection.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMessageContentMock = vi.hoisted(() => vi.fn());

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiBlobClient: class {
      getMessageContent(messageId: string) {
        return getMessageContentMock(messageId);
      }
    },
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }),
  logVerbose: () => {},
}));

let tmpHome: string;
let originalHome: string | undefined;
let downloadLineMedia: typeof import("./download.js").downloadLineMedia;

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

describe("downloadLineMedia integration proof", () => {
  beforeAll(async () => {
    originalHome = process.env.OPENCLAW_HOME;
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "oc-line-proof-"));
    process.env.OPENCLAW_HOME = tmpHome;
    ({ downloadLineMedia } = await import("./download.js"));
  });

  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getMessageContentMock.mockReset();
  });

  it("saves a LINE file-upload audio attachment with audio/mpeg MIME using the filename hint", async () => {
    // No audio magic bytes; only the .mp3 filename hint can classify this as audio.
    const data = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    getMessageContentMock.mockResolvedValueOnce(chunks([data]));

    const result = await downloadLineMedia("mid-file", "token", 10 * 1024 * 1024, "voice.mp3");

    expect(result.size).toBe(data.length);
    expect(result.contentType).toBe("audio/mpeg");
    expect(path.extname(result.path)).toBe(".mp3");
    expect(existsSync(result.path)).toBe(true);
  });
});
