// Qqbot tests cover built-in bridge adapter behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  readRemoteMediaBuffer: (...args: unknown[]) => readRemoteMediaBufferMock(...args),
}));

describe("qqbot bridge bootstrap", () => {
  beforeEach(() => {
    readRemoteMediaBufferMock.mockReset();
    vi.resetModules();
  });

  it("forwards response header deadlines to the media runtime", async () => {
    readRemoteMediaBufferMock.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      fileName: "remote.png",
    });

    const [{ ensurePlatformAdapter }, { getPlatformAdapter }] = await Promise.all([
      import("./bootstrap.js"),
      import("../engine/adapter/index.js"),
    ]);
    ensurePlatformAdapter();

    const result = await getPlatformAdapter().fetchMedia({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      maxBytes: 1024,
      maxRedirects: 2,
      timeoutMs: 5_000,
      responseHeaderTimeoutMs: 120_000,
      ssrfPolicy: { hostnameAllowlist: ["*.qq.com"] },
      requestInit: { headers: { accept: "image/png" } },
    });

    expect(result).toEqual({ buffer: Buffer.from("image"), fileName: "remote.png" });
    expect(readRemoteMediaBufferMock).toHaveBeenCalledWith({
      url: "https://media.qq.com/assets/photo.png",
      filePathHint: "photo.png",
      maxBytes: 1024,
      maxRedirects: 2,
      timeoutMs: 5_000,
      responseHeaderTimeoutMs: 120_000,
      ssrfPolicy: { hostnameAllowlist: ["*.qq.com"] },
      requestInit: { headers: { accept: "image/png" } },
    });
  });
});
