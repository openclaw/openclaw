import type { Message } from "@grammyjs/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const fetchRemoteMedia = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
    fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    logVerbose: () => {},
    warn: (s: string) => s,
    danger: (s: string) => s,
  };
});

vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

let resolveMedia: typeof import("./delivery.js").resolveMedia;

const MAX_MEDIA_BYTES = 10_000_000;
const BOT_TOKEN = "tok123";

function makeCtx(
  mediaField: "voice" | "audio" | "photo" | "video" | "document" | "animation" | "sticker",
  getFile: TelegramContext["getFile"],
  opts?: { file_name?: string },
): TelegramContext {
  const msg: Record<string, unknown> = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
  };
  if (mediaField === "voice") {
    msg.voice = { file_id: "v1", duration: 5, file_unique_id: "u1" };
  }
  if (mediaField === "audio") {
    msg.audio = {
      file_id: "a1",
      duration: 5,
      file_unique_id: "u2",
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "photo") {
    msg.photo = [{ file_id: "p1", width: 100, height: 100 }];
  }
  if (mediaField === "video") {
    msg.video = {
      file_id: "vid1",
      duration: 10,
      file_unique_id: "u3",
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "document") {
    msg.document = {
      file_id: "d1",
      file_unique_id: "u4",
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "animation") {
    msg.animation = {
      file_id: "an1",
      duration: 3,
      file_unique_id: "u5",
      width: 200,
      height: 200,
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "sticker") {
    msg.sticker = {
      file_id: "stk1",
      file_unique_id: "ustk1",
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    };
  }
  return {
    message: msg as unknown as Message,
    me: {
      id: 1,
      is_bot: true,
      first_name: "bot",
      username: "bot",
    } as unknown as TelegramContext["me"],
    getFile,
  };
}

function setupTransientGetFileRetry() {
  const getFile = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network request for 'getFile' failed!"))
    .mockResolvedValueOnce({ file_path: "voice/file_0.oga" });

  fetchRemoteMedia.mockResolvedValueOnce({
    buffer: Buffer.from("audio"),
    contentType: "audio/ogg",
    fileName: "file_0.oga",
  });
  saveMediaBuffer.mockResolvedValueOnce({
    path: "/tmp/file_0.oga",
    contentType: "audio/ogg",
  });

  return getFile;
}

function mockPdfFetchAndSave(fileName: string | undefined) {
  fetchRemoteMedia.mockResolvedValueOnce({
    buffer: Buffer.from("pdf-data"),
    contentType: "application/pdf",
    fileName,
  });
  saveMediaBuffer.mockResolvedValueOnce({
    path: "/tmp/file_42---uuid.pdf",
    contentType: "application/pdf",
  });
}

function createFileTooBigError(): Error {
  return new Error("GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)");
}

async function expectTransientGetFileRetrySuccess() {
  const getFile = setupTransientGetFileRetry();
  const promise = resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
  await flushRetryTimers();
  const result = await promise;
  expect(getFile).toHaveBeenCalledTimes(2);
  expect(fetchRemoteMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      url: `https://api.telegram.org/file/bot${BOT_TOKEN}/voice/file_0.oga`,
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        hostnameAllowlist: ["api.telegram.org"],
      },
    }),
  );
  return result;
}

async function flushRetryTimers() {
  await vi.runAllTimersAsync();
}

describe("resolveMedia getFile retry", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ resolveMedia } = await import("./delivery.js"));
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
    ({ resolveMedia } = await import("./delivery.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries getFile on transient failure and succeeds on second attempt", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    expect(result).toEqual(
      expect.objectContaining({ path: "/tmp/file_0.oga", placeholder: "<media:audio>" }),
    );
  });

  it.each(["voice", "photo", "video"] as const)(
    "returns null for %s when getFile exhausts retries so message is not dropped",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

      const promise = resolveMedia(makeCtx(mediaField, getFile), MAX_MEDIA_BYTES, BOT_TOKEN);
      await flushRetryTimers();
      const result = await promise;

      expect(getFile).toHaveBeenCalledTimes(3);
      expect(result).toBeNull();
    },
  );

  it("does not catch errors from fetchRemoteMedia (only getFile is retried)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });
    fetchRemoteMedia.mockRejectedValueOnce(new Error("download failed"));

    await expect(
      resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN),
    ).rejects.toThrow("download failed");

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry 'file is too big' error (400 Bad Request) and returns null", async () => {
    // Simulate Telegram Bot API error when file exceeds 20MB limit.
    const fileTooBigError = createFileTooBigError();
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMedia(makeCtx("video", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    // Should NOT retry - "file is too big" is a permanent error, not transient.
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("does not retry 'file is too big' GrammyError instances and returns null", async () => {
    const fileTooBigError = new Error(
      "GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)",
    );
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMedia(makeCtx("video", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it.each(["audio", "voice"] as const)(
    "returns null for %s when file is too big",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(createFileTooBigError());

      const result = await resolveMedia(makeCtx(mediaField, getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

      expect(getFile).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    },
  );

  it("throws when getFile returns no file_path", async () => {
    const getFile = vi.fn().mockResolvedValue({});
    await expect(
      resolveMedia(makeCtx("voice", getFile), MAX_MEDIA_BYTES, BOT_TOKEN),
    ).rejects.toThrow("Telegram getFile returned no file_path");
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("still retries transient errors even after encountering file too big in different call", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    // Should retry transient errors.
    expect(result).not.toBeNull();
  });

  it("retries getFile for stickers on transient failure", async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for 'getFile' failed!"))
      .mockResolvedValueOnce({ file_path: "stickers/file_0.webp" });

    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      contentType: "image/webp",
      fileName: "file_0.webp",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_0.webp",
      contentType: "image/webp",
    });

    const ctx = makeCtx("sticker", getFile);
    const promise = resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);
    await flushRetryTimers();
    const result = await promise;

    expect(getFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({ path: "/tmp/file_0.webp", placeholder: "<media:sticker>" }),
    );
  });

  it("returns null for sticker when getFile exhausts retries", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

    const ctx = makeCtx("sticker", getFile);
    const promise = resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);
    await flushRetryTimers();
    const result = await promise;

    expect(getFile).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
  });

  it("uses caller-provided fetch impl for file downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    const callerFetch = vi.fn() as unknown as typeof fetch;
    const callerTransport = { fetch: callerFetch, sourceFetch: callerFetch };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "file_42.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_42---uuid.pdf",
      contentType: "application/pdf",
    });

    const result = await resolveMedia(
      makeCtx("document", getFile),
      MAX_MEDIA_BYTES,
      BOT_TOKEN,
      callerTransport,
    );

    expect(result).not.toBeNull();
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchImpl: callerFetch,
      }),
    );
  });

  it("uses caller-provided fetch impl for sticker downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/file_0.webp" });
    const callerFetch = vi.fn() as unknown as typeof fetch;
    const callerTransport = { fetch: callerFetch, sourceFetch: callerFetch };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      contentType: "image/webp",
      fileName: "file_0.webp",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_0.webp",
      contentType: "image/webp",
    });

    const result = await resolveMedia(
      makeCtx("sticker", getFile),
      MAX_MEDIA_BYTES,
      BOT_TOKEN,
      callerTransport,
    );

    expect(result).not.toBeNull();
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchImpl: callerFetch,
      }),
    );
  });

  it("uses local absolute file paths directly for media downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });

    const result = await resolveMedia(makeCtx("document", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        path: "/var/lib/telegram-bot-api/file.pdf",
        placeholder: "<media:document>",
      }),
    );
  });

  it("uses local absolute file paths directly for sticker downloads", async () => {
    const getFile = vi
      .fn()
      .mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/sticker.webp" });

    const result = await resolveMedia(makeCtx("sticker", getFile), MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        path: "/var/lib/telegram-bot-api/sticker.webp",
        placeholder: "<media:sticker>",
      }),
    );
  });
});

describe("resolveMedia original filename preservation", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
    ({ resolveMedia } = await import("./delivery.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes document.file_name to saveMediaBuffer instead of server-side path", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "file_42.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/business-plan---uuid.pdf",
      contentType: "application/pdf",
    });

    const ctx = makeCtx("document", getFile, { file_name: "business-plan.pdf" });
    const result = await resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "business-plan.pdf",
    );
    expect(result).toEqual(expect.objectContaining({ path: "/tmp/business-plan---uuid.pdf" }));
  });

  it("passes audio.file_name to saveMediaBuffer", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "music/file_99.mp3" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio-data"),
      contentType: "audio/mpeg",
      fileName: "file_99.mp3",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/my-song---uuid.mp3",
      contentType: "audio/mpeg",
    });

    const ctx = makeCtx("audio", getFile, { file_name: "my-song.mp3" });
    const result = await resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "audio/mpeg",
      "inbound",
      MAX_MEDIA_BYTES,
      "my-song.mp3",
    );
    expect(result).not.toBeNull();
  });

  it("passes video.file_name to saveMediaBuffer", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "videos/file_55.mp4" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("video-data"),
      contentType: "video/mp4",
      fileName: "file_55.mp4",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/presentation---uuid.mp4",
      contentType: "video/mp4",
    });

    const ctx = makeCtx("video", getFile, { file_name: "presentation.mp4" });
    const result = await resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      MAX_MEDIA_BYTES,
      "presentation.mp4",
    );
    expect(result).not.toBeNull();
  });

  it("falls back to fetched.fileName when telegram file_name is absent", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "file_42.pdf",
    );
    expect(result).not.toBeNull();
  });

  it("falls back to filePath when neither telegram nor fetched fileName is available", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave(undefined);

    const ctx = makeCtx("document", getFile);
    const result = await resolveMedia(ctx, MAX_MEDIA_BYTES, BOT_TOKEN);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "documents/file_42.pdf",
    );
    expect(result).not.toBeNull();
  });

  it("allows a configured custom apiRoot host while keeping the hostname allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMedia(
      ctx,
      MAX_MEDIA_BYTES,
      BOT_TOKEN,
      undefined,
      "http://192.168.1.50:8081/custom-bot-api/",
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: {
          hostnameAllowlist: ["api.telegram.org", "192.168.1.50"],
          allowedHostnames: ["192.168.1.50"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
    expect(result).not.toBeNull();
  });
});
