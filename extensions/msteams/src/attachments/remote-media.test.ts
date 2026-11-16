import type { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveResponseMediaMock = vi.hoisted(() => vi.fn<typeof saveResponseMedia>());
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";

const MEDIA_URL = "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content";
const saved = { id: "saved", path: "/tmp/saved.png", size: 42, contentType: "image/png" };
function download(
  fetchImpl: Parameters<typeof downloadAndStoreMSTeamsRemoteMedia>[0]["fetchImpl"],
  kind?: "image" | "document",
) {
  return downloadAndStoreMSTeamsRemoteMedia({
    url: MEDIA_URL,
    filePathHint: "file.png",
    contentTypeHint: "image/png",
    maxBytes: 1024,
    fetchImpl,
    kind,
  });
}

describe("downloadAndStoreMSTeamsRemoteMedia", () => {
  beforeEach(() => {
    saveResponseMediaMock.mockReset().mockResolvedValue(saved);
  });

  // Regression #63396: the caller's guarded fetch owns SSRF enforcement.
  it("forwards the guarded response and storage options without copying storage policy", async () => {
    const response = new Response("png");
    const fetchImpl = vi.fn(async () => response);
    await expect(download(fetchImpl)).resolves.toEqual({
      path: saved.path,
      contentType: saved.contentType,
      kind: "image",
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(MEDIA_URL, { redirect: "follow" });
    expect(saveResponseMediaMock).toHaveBeenCalledExactlyOnceWith(response, {
      sourceUrl: MEDIA_URL,
      filePathHint: "file.png",
      maxBytes: 1024,
      fallbackContentType: "image/png",
    });
  });

  it("preserves the explicit kind over storage MIME and filename inference", async () => {
    await expect(download(async () => new Response("png"), "document")).resolves.toEqual({
      path: saved.path,
      contentType: saved.contentType,
      kind: "document",
    });
  });

  it.each([false, true])(
    "preserves the storage error when cancellation rejects=%s",
    async (rejectCancel) => {
      const storageError = new Error("storage failed before reading");
      const cancel = vi.fn(async () => {
        if (rejectCancel) {
          throw new Error("cancel failed");
        }
      });
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
      saveResponseMediaMock.mockRejectedValueOnce(storageError);
      await expect(download(async () => response)).rejects.toBe(storageError);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});
