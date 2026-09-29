import type { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";

const saveResponseMediaMock = vi.hoisted(() => vi.fn<typeof saveResponseMedia>());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

const REMOTE_URL = "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content";

describe("downloadAndStoreMSTeamsRemoteMedia", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockReset().mockResolvedValue({
      id: "stored",
      path: "/tmp/stored.png",
      size: 42,
      contentType: "image/png",
    });
  });

  it.each([false, true])(
    "passes the guarded response and storage options through (preserveFilenames=%s)",
    async (preserveFilenames) => {
      const response = new Response("bytes", { headers: { "content-type": "text/plain" } });
      const fetchImpl = vi.fn(async () => response);

      const result = await downloadAndStoreMSTeamsRemoteMedia({
        url: REMOTE_URL,
        filePathHint: "report.pdf",
        maxBytes: 1024,
        contentTypeHint: "application/pdf",
        preserveFilenames,
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(REMOTE_URL, { redirect: "follow" });
      expect(saveResponseMediaMock).toHaveBeenCalledExactlyOnceWith(response, {
        sourceUrl: REMOTE_URL,
        filePathHint: "report.pdf",
        maxBytes: 1024,
        fallbackContentType: "application/pdf",
        originalFilename: preserveFilenames ? "report.pdf" : undefined,
      });
      expect(saveResponseMediaMock.mock.calls[0]?.[0]).toBe(response);
      expect(result).toEqual({ path: "/tmp/stored.png", contentType: "image/png", kind: "image" });
    },
  );

  it("preserves the caller's explicit kind over the saved content type", async () => {
    const result = await downloadAndStoreMSTeamsRemoteMedia({
      url: REMOTE_URL,
      filePathHint: "file.png",
      maxBytes: 1024,
      kind: "document",
      fetchImpl: async () => new Response("bytes"),
    });

    expect(result).toEqual({ path: "/tmp/stored.png", contentType: "image/png", kind: "document" });
  });

  it.each([false, true])(
    "preserves storage errors and cancels the unread response (cancel rejects=%s)",
    async (cancelRejects) => {
      const cancel = vi.fn(async () => {
        if (cancelRejects) {
          throw new Error("cancel failed");
        }
      });
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
      const error = new Error("storage failed");
      saveResponseMediaMock.mockImplementationOnce(async (received) => {
        expect(received).toBe(response);
        expect(received.bodyUsed).toBe(false);
        throw error;
      });

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: REMOTE_URL,
          filePathHint: "file.png",
          maxBytes: 1024,
          fetchImpl: async () => response,
        }),
      ).rejects.toBe(error);

      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});
