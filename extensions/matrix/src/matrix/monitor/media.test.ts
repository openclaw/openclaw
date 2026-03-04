import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { downloadMatrixMedia } from "./media.js";

describe("downloadMatrixMedia", () => {
  const saveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/media",
    contentType: "image/png",
  });

  const runtimeStub = {
    channel: {
      media: {
        saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
      },
    },
  } as unknown as PluginRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
  });

  function makeEncryptedMediaFixture() {
    const decryptMedia = vi.fn().mockResolvedValue(Buffer.from("decrypted"));
    const client = {
      crypto: { decryptMedia },
      mxcToHttp: vi.fn().mockReturnValue("https://example/mxc"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;
    const file = {
      url: "mxc://example/file",
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };
    return { decryptMedia, client, file };
  }

  it("decrypts encrypted media when file payloads are present", async () => {
    const { decryptMedia, client, file } = makeEncryptedMediaFixture();

    const result = await downloadMatrixMedia({
      client,
      mxcUrl: "mxc://example/file",
      contentType: "image/png",
      maxBytes: 1024,
      file,
    });

    // decryptMedia should be called with just the file object (it handles download internally)
    expect(decryptMedia).toHaveBeenCalledWith(file);
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("decrypted"),
      "image/png",
      "inbound",
      1024,
    );
    expect(result?.path).toBe("/tmp/media");
  });

  it("downloads unencrypted media via fetch and buffers fully", async () => {
    const payload = Buffer.from("A".repeat(50_000));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(payload, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
    );

    const client = {
      mxcToHttp: vi.fn().mockReturnValue("https://matrix.example/_media/download/example/abc"),
      accessToken: "syt_test",
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    const result = await downloadMatrixMedia({
      client,
      mxcUrl: "mxc://example/abc",
      contentType: "audio/ogg",
      maxBytes: 100_000,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const fetchUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchUrl).toContain("matrix.example");
    const fetchOpts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(fetchOpts.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer syt_test" }),
    );
    expect(saveMediaBuffer).toHaveBeenCalledWith(payload, "audio/ogg", "inbound", 100_000);
    expect(result?.path).toBe("/tmp/media");
    fetchSpy.mockRestore();
  });

  it("rejects encrypted media that exceeds maxBytes before decrypting", async () => {
    const { decryptMedia, client, file } = makeEncryptedMediaFixture();

    await expect(
      downloadMatrixMedia({
        client,
        mxcUrl: "mxc://example/file",
        contentType: "image/png",
        sizeBytes: 2048,
        maxBytes: 1024,
        file,
      }),
    ).rejects.toThrow("Matrix media exceeds configured size limit");

    expect(decryptMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
