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
const MEDIA_URL = "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content";

function download(
  fetchImpl: Parameters<typeof downloadAndStoreMSTeamsRemoteMedia>[0]["fetchImpl"],
) {
  return downloadAndStoreMSTeamsRemoteMedia({
    url: MEDIA_URL,
    filePathHint: "file.png",
    maxBytes: 1024,
    fetchImpl,
  });
}

describe("downloadAndStoreMSTeamsRemoteMedia", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockClear();
  });

  // Regression #63396: use the caller's guarded fetch, which owns SSRF enforcement.
  it("downloads through the supplied guarded fetchImpl", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const result = await download(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(MEDIA_URL);
    expect(result.path).toBe("/tmp/saved.png");
  });

  it("surfaces HTTP errors as exceptions (no silent drop)", async () => {
    await expect(download(async () => new Response("nope", { status: 403 }))).rejects.toThrow(
      /HTTP 403/,
    );
  });

  it("rejects a response whose Content-Length exceeds maxBytes", async () => {
    await expect(
      download(async () => new Response(PNG_BYTES, { headers: { "content-length": "999999" } })),
    ).rejects.toThrow(/exceeds maxBytes/);
  });

  it("cancels a guarded response when storage fails before reading the body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    saveResponseMediaMock.mockRejectedValueOnce(new Error("mkdir failed"));
    await expect(download(async () => new Response(body, { status: 200 }))).rejects.toThrow(
      "mkdir failed",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
