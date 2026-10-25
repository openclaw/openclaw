import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";

afterEach(() => vi.unstubAllGlobals());

function downloadVideo(
  videoUrl = "https://example.com/generated.mp4",
  allowPrivateNetwork = false,
) {
  const downloadFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === videoUrl) {
        return downloadFetch(input, init);
      }
      return Response.json(
        url.endsWith("/videos/generations")
          ? { request_id: "synthetic-request" }
          : { status: "done", video: { url: videoUrl } },
      );
    }),
  );
  return buildXaiVideoGenerationProvider().generateVideo({
    provider: "xai",
    model: "grok-imagine-video",
    prompt: "Synthetic video",
    cfg: createModelProviderConfig({
      xai: {
        baseUrl: "https://example.com/v1",
        apiKey: "synthetic-key",
        models: [],
        request: { allowPrivateNetwork },
      },
    }),
    timeoutMs: 5_000,
  });
}

describe("xAI generated video download", () => {
  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as generated video", async ({ contentType, body }) => {
    const fetchFn = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": contentType } }),
    );
    vi.stubGlobal("fetch", fetchFn);

    await expect(downloadVideo()).rejects.toThrow(
      "xAI generated video download: malformed video response",
    );
  });

  it("closes the upstream socket for a never-ending malformed response over a real connection", async () => {
    let notifySocketClosed: ((closed: boolean) => void) | undefined;
    const socketClosed = new Promise<boolean>((resolve) => {
      notifySocketClosed = resolve;
    });
    await withServer(
      (request, response) => {
        request.socket.once("close", () => notifySocketClosed?.(true));
        response.writeHead(200, { "content-type": "application/json" });
        // Headers land, then the body never ends: only an explicit cancel closes this.
        response.write('{"error":"still streaming');
      },
      async (baseUrl) => {
        await expect(downloadVideo(`${baseUrl}/generated.mp4`, true)).rejects.toThrow(
          "xAI generated video download: malformed video response",
        );

        await expect(socketClosed).resolves.toBe(true);
      },
    );
  });
});
