import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { bufferedOversizedJsonResponse as oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as vydra from "./provider-test-helpers.js";

describe("vydra image-generation provider", () => {
  installPinnedHostnameTestHooks();
  const { imageProvider: provider } = vydra.registerVydraProviders();
  const request = { provider: "vydra", model: "grok-imagine", prompt: "draw a cat", cfg: {} };
  const imageUrl = "https://cdn.vydra.ai/generated/test.png";
  const completed = () => jsonResponse({ jobId: "job-123", status: "completed", imageUrl });
  const queuedJob = () => jsonResponse({ jobId: "job-123", status: "queued" });
  const png = (body = "png-data") => vydra.binaryResponse(body, "image/png");
  const headersAt = (mock: ReturnType<typeof vi.fn>, index: number) => {
    const call = mock.mock.calls[index];
    assert(call, `Expected fetch call ${index}`);
    return new Headers((call[1] as RequestInit).headers);
  };
  beforeEach(vydra.stubVydraApiKey);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the www api and downloads the generated image", async () => {
    const fetchMock = vydra.stubFetch(completed(), png());
    const result = await provider.generateImage(request);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://www.vydra.ai/api/v1/models/grok-imagine",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "draw a cat", model: "text-to-image" }),
      }),
    ]);
    expect(headersAt(fetchMock, 0).get("authorization")).toBe("Bearer vydra-test-key");
    expect(result).toEqual({
      images: [{ buffer: Buffer.from("png-data"), mimeType: "image/png", fileName: "image-1.png" }],
      model: "grok-imagine",
      metadata: { jobId: "job-123", imageUrl, status: "completed" },
    });
  });

  it("keeps generated image downloads above the configured media cap", async () => {
    vydra.stubFetch(completed(), png("over-cap"));
    const result = await provider.generateImage({
      ...request,
      cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    });
    expect(result.images[0]?.buffer.toString()).toBe("over-cap");
  });

  it("rejects image creation JSON responses that exceed the provider cap", async () => {
    vydra.stubFetch(oversizedJsonResponse());
    await expect(provider.generateImage(request)).rejects.toThrow(
      "vydra.image-generation: JSON response exceeds 16777216 bytes",
    );
  });

  it("passes request SSRF policy through image creation, polling, and download", async () => {
    const baseUrl = "https://198.18.0.10/api/v1";
    const headers = { "X-Vydra-Policy": "cross-origin" };
    const resultUrl = "https://198.18.0.11/generated/test.png";
    const fetchMock = vydra.stubFetch(
      queuedJob(),
      jsonResponse({ jobId: "job-123", status: "completed", resultUrls: [resultUrl] }),
      png(),
    );
    await provider.generateImage({
      ...request,
      cfg: { models: { providers: { vydra: { baseUrl, models: [], request: { headers } } } } },
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${baseUrl}/models/grok-imagine`, "POST"],
      [`${baseUrl}/jobs/job-123`, "GET"],
      [resultUrl, "GET"],
    ]);
    for (const index of [0, 1]) {
      expect(headersAt(fetchMock, index).get("x-vydra-policy")).toBe("cross-origin");
    }
    expect(
      ["authorization", "x-vydra-policy"].map((key) => headersAt(fetchMock, 2).get(key)),
    ).toEqual([null, null]);
  });

  it("rejects job poll JSON responses that exceed the provider cap", async () => {
    vydra.stubFetch(queuedJob(), oversizedJsonResponse());
    await expect(provider.generateImage(request)).rejects.toThrow(
      "Vydra job status request failed: JSON response exceeds 16777216 bytes",
    );
  });
});
