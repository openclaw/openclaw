import { bufferedOversizedJsonResponse as oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  binaryResponse,
  jsonResponse,
  registerVydraProviders,
  stubFetch,
  stubVydraApiKey,
} from "./provider-test-helpers.js";

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index}`);
  }
  return call as [string, RequestInit];
}

describe("vydra image-generation provider", () => {
  installPinnedHostnameTestHooks();
  const { imageProvider: provider } = registerVydraProviders();
  const request = { provider: "vydra", model: "grok-imagine", prompt: "draw a cat", cfg: {} };
  const completedImage = () =>
    jsonResponse({
      jobId: "job-123",
      status: "completed",
      imageUrl: "https://cdn.vydra.ai/generated/test.png",
    });
  beforeEach(stubVydraApiKey);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the www api and downloads the generated image", async () => {
    const fetchMock = stubFetch(completedImage(), binaryResponse("png-data", "image/png"));
    const result = await provider.generateImage(request);
    const createCall = fetchCall(fetchMock);
    expect(createCall[0]).toBe("https://www.vydra.ai/api/v1/models/grok-imagine");
    expect(createCall[1].method).toBe("POST");
    expect(createCall[1].body).toBe(
      JSON.stringify({ prompt: "draw a cat", model: "text-to-image" }),
    );
    expect(new Headers(createCall[1].headers).get("authorization")).toBe("Bearer vydra-test-key");
    expect(result).toEqual({
      images: [{ buffer: Buffer.from("png-data"), mimeType: "image/png", fileName: "image-1.png" }],
      model: "grok-imagine",
      metadata: {
        jobId: "job-123",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
        status: "completed",
      },
    });
  });

  it("keeps generated image downloads above the configured media cap", async () => {
    stubFetch(completedImage(), binaryResponse("over-cap", "image/png"));
    const result = await provider.generateImage({
      ...request,
      cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
    });
    expect(result.images[0]?.buffer.toString()).toBe("over-cap");
  });

  it("rejects image creation JSON responses that exceed the provider cap", async () => {
    stubFetch(oversizedJsonResponse());
    await expect(provider.generateImage(request)).rejects.toThrow(
      "vydra.image-generation: JSON response exceeds 16777216 bytes",
    );
  });

  it("passes request SSRF policy through image creation, polling, and download", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-123", status: "queued" }),
      jsonResponse({
        jobId: "job-123",
        status: "completed",
        resultUrls: ["https://198.18.0.11/generated/test.png"],
      }),
      binaryResponse("png-data", "image/png"),
    );
    await provider.generateImage({
      ...request,
      cfg: {
        models: {
          providers: {
            vydra: {
              baseUrl: "https://198.18.0.10/api/v1",
              models: [],
              request: { headers: { "X-Vydra-Policy": "cross-origin" } },
            },
          },
        },
      },
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });
    const createCall = fetchCall(fetchMock);
    expect(createCall[0]).toBe("https://198.18.0.10/api/v1/models/grok-imagine");
    expect(createCall[1].method).toBe("POST");
    expect(new Headers(createCall[1].headers).get("x-vydra-policy")).toBe("cross-origin");
    const pollCall = fetchCall(fetchMock, 1);
    expect(pollCall[0]).toBe("https://198.18.0.10/api/v1/jobs/job-123");
    expect(pollCall[1].method).toBe("GET");
    expect(new Headers(pollCall[1].headers).get("x-vydra-policy")).toBe("cross-origin");
    const downloadCall = fetchCall(fetchMock, 2);
    expect(downloadCall[0]).toBe("https://198.18.0.11/generated/test.png");
    const downloadHeaders = new Headers(downloadCall[1].headers);
    expect(downloadHeaders.get("authorization")).toBeNull();
    expect(downloadHeaders.get("x-vydra-policy")).toBeNull();
  });

  it("rejects job poll JSON responses that exceed the provider cap", async () => {
    stubFetch(jsonResponse({ jobId: "job-456", status: "queued" }), oversizedJsonResponse());
    await expect(provider.generateImage(request)).rejects.toThrow(
      "Vydra job status request failed: JSON response exceeds 16777216 bytes",
    );
  });
});
