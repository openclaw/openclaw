// Msteams tests cover remote media plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveResponseMediaMock = vi.hoisted(() =>
  vi.fn(async (response: Response, options: { maxBytes?: number }) => {
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      throw new Error(`HTTP ${response.status}${statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && options.maxBytes && contentLength > options.maxBytes) {
      throw new Error(`content length ${contentLength} exceeds maxBytes ${options.maxBytes}`);
    }
    return {
      id: "saved",
      path: "/tmp/saved.png",
      size: 42,
      contentType: response.headers.get("content-type") ?? "image/png",
    };
  }),
);

vi.mock("openclaw/plugin-sdk/media-runtime", async () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jsonResponse(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, init);
}

function requireFirstFetchUrl(mock: ReturnType<typeof vi.fn>): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected direct fetch call");
  }
  return call[0];
}

describe("downloadAndStoreMSTeamsRemoteMedia", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockClear();
  });

  describe("guarded caller fetch (Node 24+ / undici v7 path for issue #63396)", () => {
    it("downloads through the supplied guarded fetchImpl", async () => {
      // `fetchImpl` here simulates the "pre-validated hostname" contract from
      // `safeFetchWithPolicy`: the caller has already enforced the allowlist,
      // so the strict SSRF dispatcher is not needed.
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
      );

      const result = await downloadAndStoreMSTeamsRemoteMedia({
        url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
        filePathHint: "file.png",
        maxBytes: 1024,
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const calledUrl = requireFirstFetchUrl(fetchImpl);
      expect(calledUrl).toBe("https://graph.microsoft.com/v1.0/shares/abc/driveItem/content");
      expect(result.path).toBe("/tmp/saved.png");
    });

    it("surfaces HTTP errors as exceptions (no silent drop)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse("nope", { status: 403 }));

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
          filePathHint: "file.png",
          maxBytes: 1024,
          fetchImpl,
        }),
      ).rejects.toThrow(/HTTP 403/);
    });

    it("rejects a response whose Content-Length exceeds maxBytes", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(PNG_BYTES, {
          status: 200,
          headers: { "content-length": "999999" },
        }),
      );

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
          filePathHint: "file.png",
          maxBytes: 1024,
          fetchImpl,
        }),
      ).rejects.toThrow(/exceeds maxBytes/);
    });

    it("cancels a guarded response when storage fails before reading the body", async () => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      saveResponseMediaMock.mockRejectedValueOnce(new Error("mkdir failed"));

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
          filePathHint: "file.png",
          maxBytes: 1024,
          fetchImpl,
        }),
      ).rejects.toThrow("mkdir failed");

      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });
});
