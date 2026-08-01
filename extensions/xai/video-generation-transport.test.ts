// xAI generated video download regressions: binary response validation.
import { describe, expect, it, vi } from "vitest";
import { downloadXaiVideo } from "./video-generation-transport.js";

function downloadVideo(fetchFn: typeof fetch) {
  return downloadXaiVideo({
    url: "https://example.com/generated.mp4",
    defaultTimeoutMs: 5_000,
    fetchFn,
    maxBytes: 10 * 1024 * 1024,
  });
}

describe("downloadXaiVideo", () => {
  it("returns the downloaded video bytes for a well-formed binary response", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const video = await downloadVideo(fetchFn as unknown as typeof fetch);

    expect(video.mimeType).toBe("video/mp4");
    expect(video.fileName).toBe("video-1.mp4");
    expect(video.buffer?.toString("utf8")).toBe("mp4-bytes");
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as generated video", async ({ contentType, body }) => {
    const fetchFn = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );

    await expect(downloadVideo(fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "xAI generated video download: malformed video response",
    );
  });

  it("cancels the unread response body when the content type is rejected", async () => {
    const cancel = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => {
      const response = new Response('{"error":"denied"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "body", { value: { cancel }, configurable: true });
      return response;
    });

    await expect(downloadVideo(fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "xAI generated video download: malformed video response",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
