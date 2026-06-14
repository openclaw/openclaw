// Line tests cover download plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMessageContentMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());

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
  createSubsystemLogger: () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    return logger;
  },
  logVerbose: () => {},
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream: saveMediaStreamMock,
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let LineMediaDownloadTimeoutError: typeof import("./download.js").LineMediaDownloadTimeoutError;
let LINE_DOWNLOAD_IDLE_TIMEOUT_MS: typeof import("./download.js").LINE_DOWNLOAD_IDLE_TIMEOUT_MS;

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

function saveMediaStreamCall(): unknown[] {
  const call = saveMediaStreamMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveMediaStream call");
  }
  return call;
}

function detectMockContentType(buffer: Buffer, contentType?: string): string | undefined {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    return buffer.toString("ascii", 8, 12) === "M4A " ? "audio/x-m4a" : "video/mp4";
  }
  return contentType;
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia, LineMediaDownloadTimeoutError, LINE_DOWNLOAD_IDLE_TIMEOUT_MS } =
      await import("./download.js"));
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/media-store");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getMessageContentMock.mockReset();
    saveMediaStreamMock.mockReset();
    saveMediaStreamMock.mockImplementation(
      async (stream: AsyncIterable<Buffer>, contentType?: string, subdir?: string) => {
        const chunksLocal: Buffer[] = [];
        for await (const chunk of stream) {
          chunksLocal.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunksLocal);
        return {
          path: `/home/user/.openclaw/media/${subdir ?? "unknown"}/saved-media`,
          contentType: detectMockContentType(buffer, contentType),
          size: buffer.length,
        };
      },
    );
  });

  it("persists inbound media with the shared media store", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia("mid-jpeg", "token");

    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    const call = saveMediaStreamCall();
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(result).toEqual({
      path: "/home/user/.openclaw/media/inbound/saved-media",
      contentType: "image/jpeg",
      size: jpeg.length,
    });
  });

  it("does not pass the external messageId to saveMediaStream", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const result = await downloadLineMedia(messageId, "token");

    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    for (const arg of saveMediaStreamCall()) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("delegates oversized media rejection to saveMediaStream", async () => {
    getMessageContentMock.mockResolvedValueOnce(chunks([Buffer.alloc(4), Buffer.alloc(4)]));
    saveMediaStreamMock.mockRejectedValueOnce(new Error("Media exceeds 0MB limit"));

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
  });

  it("uses media store content type for M4A media", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([m4aHeader]));

    const result = await downloadLineMedia("mid-audio", "token");

    expect(result.contentType).toBe("audio/x-m4a");
    expect(saveMediaStreamCall()[2]).toBe("inbound");
  });

  it("uses media store content type for MP4 video", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    getMessageContentMock.mockResolvedValueOnce(chunks([mp4]));

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
  });

  it("propagates media store failures", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));
    saveMediaStreamMock.mockRejectedValueOnce(new Error("Media exceeds 0MB limit"));

    await expect(downloadLineMedia("mid-bad", "token")).rejects.toThrow(/Media exceeds/i);
  });

  describe("chunk-idle timeout", () => {
    function neverYieldingStream(): AsyncIterable<Buffer> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
          };
        },
      };
    }

    function delayedStream(payload: Buffer, delayMs: number): AsyncIterable<Buffer> {
      let yielded = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Buffer>> {
              if (yielded) {
                return { value: undefined as unknown as Buffer, done: true };
              }
              await new Promise((r) => setTimeout(r, delayMs));
              yielded = true;
              return { value: payload, done: false };
            },
          };
        },
      };
    }

    it("rejects with LineMediaDownloadTimeoutError when the stream stalls past chunkTimeoutMs", async () => {
      getMessageContentMock.mockResolvedValueOnce(neverYieldingStream());
      const promise = downloadLineMedia("mid-stall", "token", 1024 * 1024, {
        chunkTimeoutMs: 50,
      });
      await expect(promise).rejects.toBeInstanceOf(LineMediaDownloadTimeoutError);
      await expect(promise.catch((e) => e.chunkTimeoutMs)).resolves.toBe(50);
    });

    it("rejects when getMessageContent headers never arrive", async () => {
      getMessageContentMock.mockReturnValueOnce(new Promise(() => {}));
      const promise = downloadLineMedia("mid-stall-headers", "token", 1024 * 1024, {
        chunkTimeoutMs: 50,
      });
      await expect(promise).rejects.toBeInstanceOf(LineMediaDownloadTimeoutError);
    });

    it("does not reject when chunks arrive within chunkTimeoutMs", async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      getMessageContentMock.mockResolvedValueOnce(delayedStream(jpeg, 10));
      const result = await downloadLineMedia("mid-slow-but-progressing", "token", 1024 * 1024, {
        chunkTimeoutMs: 500,
      });
      expect(result.contentType).toBe("image/jpeg");
    });

    it("exposes LINE_DOWNLOAD_IDLE_TIMEOUT_MS = 30s aligned with TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS", () => {
      expect(LINE_DOWNLOAD_IDLE_TIMEOUT_MS).toBe(30_000);
    });

    it("calls iterator.return() exactly once on timeout so the upstream Readable is destroyed", async () => {
      const returnSpy = vi.fn(async () => ({ value: undefined as unknown as Buffer, done: true }));
      const stream: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Buffer>> {
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
            return: returnSpy as () => Promise<IteratorResult<Buffer>>,
          };
        },
      };
      getMessageContentMock.mockResolvedValueOnce(stream);
      await expect(
        downloadLineMedia("mid-return-spy", "token", 1024 * 1024, { chunkTimeoutMs: 50 }),
      ).rejects.toBeInstanceOf(LineMediaDownloadTimeoutError);
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects when a second chunk stalls after a successful first chunk (partial-then-stall)", async () => {
      const jpegPart = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
      let yieldedFirst = false;
      const stream: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Buffer>> {
              if (!yieldedFirst) {
                yieldedFirst = true;
                return { value: jpegPart, done: false };
              }
              return new Promise<IteratorResult<Buffer>>(() => {});
            },
          };
        },
      };
      getMessageContentMock.mockResolvedValueOnce(stream);
      const promise = downloadLineMedia("mid-partial-stall", "token", 1024 * 1024, {
        chunkTimeoutMs: 50,
      });
      await expect(promise).rejects.toBeInstanceOf(LineMediaDownloadTimeoutError);
      await expect(promise.catch((e) => e.chunkTimeoutMs)).resolves.toBe(50);
    });
  });
});
