import fs from "node:fs";
import path from "node:path";
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
const saveRemoteMedia = vi.fn();
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

// mock-isolation: resolve uncached media without opening persistent sticker state.
vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
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
const document = (filePath: string, opts?: Parameters<typeof makeCtx>[2]) =>
  makeCtx("document", vi.fn().mockResolvedValue({ file_path: filePath }), opts);
const trustedLocalFileRoots = ["/host/telegram-bot-api/token"];
function mockDownload(filePath: string, contentType: string, savedPath: string) {
  saveRemoteMedia.mockResolvedValueOnce({ path: savedPath, contentType });
  return vi.fn().mockResolvedValue({ file_path: filePath });
}

describe("resolveMedia local paths and original filenames", () => {
  beforeEach(() => {
    saveMediaBuffer.mockReset();
    saveRemoteMedia.mockReset();
    rootRead.mockReset();
  });

  it("accepts the colon-to-tilde token directory used on restricted filesystems", async () => {
    const token = "123:secret";
    const fixturePath = path.join(tempDirs.make("telegram-local-media-"), "file_9.pdf");
    const buffer = Buffer.from("pdf-data");
    fs.writeFileSync(fixturePath, buffer);
    const identity = fs.statSync(fixturePath, { bigint: true });
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
      document("/var/lib/telegram-bot-api/123~secret/documents/file_9.pdf", {
        file_name: "file_9.pdf",
        mime_type: "application/pdf",
      }),
      { token, trustedLocalFileRoots },
    );

    expect(rootRead).toHaveBeenCalledTimes(2);
    expect(rootRead).toHaveBeenLastCalledWith({
      rootDir: "/host/telegram-bot-api/token",
      relativePath: "documents/file_9.pdf",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expectResolvedMediaFields(result, "tilde-token document", {
      path: "/tmp/inbound/file_9.pdf",
      contentType: "application/pdf",
      kind: "document",
    });
  });

  it.each([
    ["preserves non-missing read failures", "documents/file_3.zip", "file exceeds limit", 1],
    [
      "rejects dot-segment escapes before reading",
      "../outside.zip",
      "outside trustedLocalFileRoots",
      0,
    ],
  ] as const)("%s", async (_name, suffix, messageIncludes, reads) => {
    rootRead.mockRejectedValue(createFileAccessError("too-large", "file exceeds limit"));
    await expectMediaFetchError(
      resolveMediaWithDefaults(document(`/var/lib/telegram-bot-api/${BOT_TOKEN}/${suffix}`), {
        trustedLocalFileRoots,
      }),
      { code: "fetch_failed", messageIncludes },
    );
    expect(rootRead).toHaveBeenCalledTimes(reads);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });
  it.each([
    ["document", "documents/recording.m2a", "audio/mpeg", "recording.m2a", "audio"],
    ["audio", "music/file_99.mp3", "audio/mpeg", "my-song.mp3", "audio"],
    ["video", "videos/file_55.mp4", "video/mp4", "presentation.mp4", "video"],
  ] as const)(
    "preserves %s filenames and classifies the saved media",
    async (kind, filePath, contentType, fileName, savedKind) => {
      const getFile = mockDownload(filePath, contentType, `/tmp/${fileName}`);
      const ctx = makeCtx(kind, getFile, {
        file_name: fileName,
        ...(kind === "document" ? { mime_type: "application/octet-stream" } : {}),
      });
      const result = await resolveMediaWithDefaults(ctx);
      expect(saveRemoteMedia.mock.calls[0]?.[0]).toMatchObject({
        originalFilename: fileName,
        maxBytes: MAX_MEDIA_BYTES,
      });
      expect(requireResolvedMedia(result, `${kind} filename`)).toMatchObject({
        path: `/tmp/${fileName}`,
        contentType,
        fileName,
        kind: savedKind,
      });
    },
  );

  it("constructs correct download URL with custom apiRoot for stickers", async () => {
    const getFile = mockDownload("stickers/file_0.webp", "image/webp", "/tmp/file_0.webp");

    const customApiRoot = "http://localhost:8081/bot";
    const ctx = makeCtx("sticker", getFile);
    const result = await resolveMediaWithDefaults(ctx, { apiRoot: customApiRoot });

    expect(saveRemoteMedia.mock.calls[0]?.[0]).toMatchObject({
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
