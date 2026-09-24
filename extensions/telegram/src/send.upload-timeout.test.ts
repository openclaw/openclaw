// Telegram tests cover size-aware upload deadlines through the real send stack.
import { InputFile } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBot } from "./bot.js";
import { recordTelegramUploadBytes } from "./request-timeouts.js";
import { withTelegramApiContext } from "./send-context.js";
import { resetTelegramClientOptionsCacheForTests, sendMessageTelegram } from "./send.js";

const { loadWebMedia, resolveTelegramTransport } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
  resolveTelegramTransport: vi.fn(),
}));

vi.mock("./send.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.runtime.js")>()),
  loadWebMedia,
}));

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
  resolveTelegramTransport,
}));

const MIB = 1024 * 1024;
const cfg = { channels: { telegram: { botToken: "123456:upload-timeout-fixture" } } };

describe("Telegram media upload deadline", () => {
  const aborts: Array<{ method: string; afterMs: number; reason: string }> = [];

  // Stands in for a Bot API server that is still relaying the file to Telegram.
  const pendingUploadFetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const startedAt = Date.now();
      init?.signal?.addEventListener(
        "abort",
        () => {
          const reason: unknown = init.signal?.reason;
          const error = reason instanceof Error ? reason : new Error("aborted");
          aborts.push({
            method: url.split("/").at(-1) ?? "",
            afterMs: Date.now() - startedAt,
            reason: error.message,
          });
          reject(error);
        },
        { once: true },
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    aborts.length = 0;
    resetTelegramClientOptionsCacheForTests();
    resolveTelegramTransport.mockReturnValue({
      fetch: pendingUploadFetch as typeof fetch,
      sourceFetch: pendingUploadFetch as typeof fetch,
      close: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.useRealTimers();
  });

  it("keeps a 40 MiB document upload open past the 30s senddocument guard", async () => {
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.alloc(40 * MIB),
      contentType: "application/zip",
      fileName: "archive.zip",
    });

    const outcome = sendMessageTelegram("123", "archive", {
      cfg,
      mediaUrl: "file:///tmp/archive.zip",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40_000);

    // 40 MiB at the assumed 2 MiB/s is 20s, plus the 15s response margin.
    expect(aborts).toEqual([
      {
        method: "sendDocument",
        afterMs: 35_000,
        reason: "Telegram senddocument timed out after 35000ms",
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });

  // grammY also races every call against its own client timer (500 s unless
  // client.timeoutSeconds is set). The size tag stands in for a file too large
  // to allocate here; prepareTelegramOutboundMedia records the same number.
  const taggedUpload = (fileName: string, uploadBytes: number) =>
    recordTelegramUploadBytes(new InputFile(Buffer.from("x"), fileName), uploadBytes);

  it("keeps a 1 GiB send upload open past grammY's 500 s client timer", async () => {
    const outcome = withTelegramApiContext({ cfg }, ({ api }) =>
      api.sendDocument("123", taggedUpload("disk.img", 1024 * MIB)),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(530_000);

    // 1 GiB at the assumed 2 MiB/s is 512s, plus the 15s response margin.
    expect(aborts).toEqual([
      {
        method: "sendDocument",
        afterMs: 527_000,
        reason: "Telegram senddocument timed out after 527000ms",
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });

  it.each([
    { size: "100 MiB", uploadBytes: 100 * MIB, afterMs: 65_000 },
    { size: "1 GiB", uploadBytes: 1024 * MIB, afterMs: 527_000 },
  ])("keeps a $size polling bot upload open until its size guard", async (upload) => {
    // polling-session.ts passes the 45s getUpdates guard as this minimum.
    const bot = createTelegramBot({
      token: cfg.channels.telegram.botToken,
      config: cfg,
      minimumClientTimeoutSeconds: 45,
    });
    const outcome = bot.api
      .sendVideo(123, taggedUpload("clip.mp4", upload.uploadBytes))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(upload.afterMs + 5_000);

    expect(aborts).toEqual([
      {
        method: "sendVideo",
        afterMs: upload.afterMs,
        reason: `Telegram sendvideo timed out after ${upload.afterMs}ms`,
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });
});
