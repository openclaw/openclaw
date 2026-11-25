import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import type { MatrixClient } from "../sdk.js";
import { downloadMatrixMedia } from "./media.js";

const encryptedFile = {
  url: "mxc://example/file",
  key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: "secret", ext: true },
  iv: "iv",
  hashes: { sha256: "hash" },
  v: "v2",
};

function setup() {
  const decryptMedia = vi.fn().mockResolvedValue(Buffer.from("decrypted"));
  const downloadContent = vi.fn().mockResolvedValue(Buffer.from("plain"));
  const client = { crypto: { decryptMedia }, downloadContent } as unknown as MatrixClient;
  const download = (options: Partial<Parameters<typeof downloadMatrixMedia>[0]> = {}) =>
    downloadMatrixMedia({ client, mxcUrl: encryptedFile.url, maxBytes: 1024, ...options });
  return { decryptMedia, downloadContent, download };
}

describe("downloadMatrixMedia", () => {
  const saveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/media",
    contentType: "image/png",
  });
  const runtimeStub = {
    channel: { media: { saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args) } },
  } as unknown as PluginRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  it("rejects encrypted media that exceeds maxBytes before decrypting", async () => {
    const f = setup();
    await expect(
      f.download({
        contentType: "image/png",
        sizeBytes: 2048,
        file: encryptedFile,
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
    expect(f.decryptMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("rejects oversized decrypted content before saving", async () => {
    const f = setup();
    f.decryptMedia.mockResolvedValue(Buffer.alloc(1025));
    await expect(f.download({ file: encryptedFile })).rejects.toBeInstanceOf(
      MatrixMediaSizeLimitError,
    );
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("preserves plain media error diagnostics", async () => {
    const f = setup();
    const error = new Error("download failed");
    f.downloadContent.mockRejectedValue(error);
    await expect(f.download()).rejects.toMatchObject({
      message: "Matrix media download failed: Error: download failed",
      cause: error,
    });
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });

  it("preserves typed size-limit errors from plain media downloads", async () => {
    const f = setup();
    const error = new MatrixMediaSizeLimitError(
      "Matrix media exceeds configured size limit (8192 bytes > 4096 bytes)",
    );
    f.downloadContent.mockRejectedValue(error);
    await expect(f.download({ contentType: "image/png", maxBytes: 4096 })).rejects.toBe(error);
  });

  it("passes byte limits through plain media downloads", async () => {
    const f = setup();
    await f.download({ contentType: "image/png", maxBytes: 4096 });
    expect(f.downloadContent).toHaveBeenCalledWith(encryptedFile.url, {
      maxBytes: 4096,
      readIdleTimeoutMs: 30_000,
    });
  });
});
