import fs from "node:fs";
import path from "node:path";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ObservationRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type { saveRemoteMedia as SaveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMedia } from "./delivery.resolve-media.js";
import {
  expectMediaFetchError,
  expectResolvedMediaFields,
  makeCtx,
  requireResolvedMedia,
} from "./delivery.resolve-media.test-helpers.js";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const readRemoteMediaBuffer = vi.fn();
const saveRemoteMedia = vi.fn(async (params: Parameters<typeof SaveRemoteMedia>[0]) => {
  const fetched = (await readRemoteMediaBuffer(params)) as {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
  };
  return await saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    params.maxBytes,
    params.originalFilename ?? fetched.fileName ?? params.filePathHint,
  );
});
type RootRead = (params: {
  rootDir: string;
  relativePath: string;
  maxBytes?: number;
}) => ReturnType<ObservationRoot["read"]>;
const rootRead = vi.fn<RootRead>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("openclaw/plugin-sdk/file-access-runtime", () => ({
  root: async (rootDir: string) => ({
    read: async (relativePath: string, options?: { maxBytes?: number }) =>
      await rootRead({
        rootDir,
        relativePath,
        maxBytes: options?.maxBytes,
      }),
  }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
  saveRemoteMedia: (params: Parameters<typeof SaveRemoteMedia>[0]) => saveRemoteMedia(params),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: () => {},
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  formatErrorMessage: coerceErrorMessage,
}));

vi.mock("../fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fetch.js")>()),
  resolveTelegramApiBase: (apiRoot?: string) =>
    apiRoot?.trim() ? apiRoot.replace(/\/+$/u, "") : "https://api.telegram.org",
  shouldRetryTelegramTransportFallback: vi.fn(() => false),
}));

vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

const MAX_MEDIA_BYTES = 10_000_000;
const BOT_TOKEN = "tok123";

function createFileAccessError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function resolveMediaWithDefaults(
  ctx: TelegramContext,
  overrides: Partial<Parameters<typeof resolveMedia>[0]> = {},
) {
  return resolveMedia({
    ctx,
    maxBytes: MAX_MEDIA_BYTES,
    token: BOT_TOKEN,
    ...overrides,
  });
}
function mockDownload(filePath: string, contentType: string, savedPath: string) {
  readRemoteMediaBuffer.mockResolvedValueOnce({
    buffer: Buffer.from("media-data"),
    contentType,
    fileName: path.basename(filePath),
  });
  saveMediaBuffer.mockResolvedValueOnce({ path: savedPath, contentType });
  return vi.fn().mockResolvedValue({ file_path: filePath });
}

describe("resolveMedia local paths and original filenames", () => {
  beforeEach(() => {
    readRemoteMediaBuffer.mockReset();
    saveMediaBuffer.mockReset();
    saveRemoteMedia.mockClear();
    rootRead.mockReset();
  });

  it("accepts the colon-to-tilde token directory used on restricted filesystems", async () => {
    const token = "123:secret";
    const fixturePath = path.join(tempDirs.make("telegram-local-media-"), "file_9.pdf");
    const buffer = Buffer.from("pdf-data");
    fs.writeFileSync(fixturePath, buffer);
    const identity = fs.statSync(fixturePath, { bigint: true });
    const getFile = vi.fn().mockResolvedValue({
      file_path: "/var/lib/telegram-bot-api/123~secret/documents/file_9.pdf",
    });
    rootRead.mockRejectedValueOnce(createFileAccessError("not-found", "file not found"));
    rootRead.mockResolvedValueOnce({
      buffer,
      containment: "kernel-atomic",
      realPath: "/host/telegram-bot-api/token/documents/file_9.pdf",
      stat: fs.statSync(fixturePath),
      exactIdentity: { dev: identity.dev, ino: identity.ino },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/file_9.pdf",
      contentType: "application/pdf",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { file_name: "file_9.pdf", mime_type: "application/pdf" }),
      { token, trustedLocalFileRoots: ["/host/telegram-bot-api/token"] },
    );

    expect(rootRead).toHaveBeenCalledTimes(2);
    expect(rootRead).toHaveBeenLastCalledWith({
      rootDir: "/host/telegram-bot-api/token",
      relativePath: "documents/file_9.pdf",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expectResolvedMediaFields(result, "tilde-token document", {
      path: "/tmp/inbound/file_9.pdf",
      contentType: "application/pdf",
      kind: "document",
    });
  });

  it("preserves non-missing trusted-root read failures", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/documents/file_3.zip`,
    });
    rootRead.mockRejectedValue(createFileAccessError("too-large", "file exceeds limit"));

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/zip" }), {
        trustedLocalFileRoots: ["/host/telegram-bot-api/data"],
      }),
      {
        code: "fetch_failed",
        messageIncludes: "file exceeds limit",
      },
    );
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("rejects dot-segment escapes before reading a trusted root", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/../outside.zip`,
    });

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile), {
        trustedLocalFileRoots: ["/host/telegram-bot-api/data"],
      }),
      { code: "fetch_failed", messageIncludes: "outside trustedLocalFileRoots" },
    );
    expect(rootRead).not.toHaveBeenCalled();
  });
  it("classifies an audio document from the saved MIME type", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/recording.m2a" });
    saveRemoteMedia.mockResolvedValueOnce({
      path: "/tmp/inbound/recording.m2a",
      contentType: "audio/mpeg",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, {
        file_name: "recording.m2a",
        mime_type: "application/octet-stream",
      }),
    );

    expectResolvedMediaFields(result, "MPEG-2 audio document", {
      path: "/tmp/inbound/recording.m2a",
      contentType: "audio/mpeg",
      kind: "audio",
    });
  });

  it.each([
    ["audio", "music/file_99.mp3", "audio/mpeg", "my-song.mp3"],
    ["video", "videos/file_55.mp4", "video/mp4", "presentation.mp4"],
  ] as const)(
    "passes %s.file_name to saveMediaBuffer",
    async (kind, filePath, contentType, fileName) => {
      const getFile = mockDownload(filePath, contentType, `/tmp/${fileName}`);
      const ctx = makeCtx(kind, getFile, { file_name: fileName });
      const result = await resolveMediaWithDefaults(ctx);
      const call = saveMediaBuffer.mock.calls[0];
      expect(Buffer.isBuffer(call?.[0])).toBe(true);
      expect(call?.slice(1, 5)).toEqual([contentType, "inbound", MAX_MEDIA_BYTES, fileName]);
      requireResolvedMedia(result, `${kind} filename`);
    },
  );

  it("constructs correct download URL with custom apiRoot for stickers", async () => {
    const getFile = mockDownload("stickers/file_0.webp", "image/webp", "/tmp/file_0.webp");

    const customApiRoot = "http://localhost:8081/bot";
    const ctx = makeCtx("sticker", getFile);
    const result = await resolveMediaWithDefaults(ctx, { apiRoot: customApiRoot });

    expect(readRemoteMediaBuffer.mock.calls[0]?.[0]).toMatchObject({
      url: `${customApiRoot}/file/bot${BOT_TOKEN}/stickers/file_0.webp`,
      ssrfPolicy: {
        hostnameAllowlist: ["api.telegram.org", "localhost"],
        allowedHostnames: ["localhost"],
        allowRfc2544BenchmarkRange: true,
      },
    });
    requireResolvedMedia(result, "custom apiRoot sticker URL");
  });
});
