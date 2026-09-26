import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  binaryResponse,
  jsonResponse,
  stubFetch,
  stubVydraApiKey,
} from "./provider-test-helpers.js";
import { buildVydraVideoGenerationProvider } from "./video-generation-provider.js";

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call;
}

describe("vydra video-generation provider", () => {
  installPinnedHostnameTestHooks();
  const provider = buildVydraVideoGenerationProvider();
  const request = { provider: "vydra", model: "kling", prompt: "animate this image", cfg: {} };
  beforeEach(stubVydraApiKey);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits, polls, and downloads veo3 video with the configured request policy", async () => {
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");
    const pollProviderOperationJsonSpy = vi.spyOn(providerHttp, "pollProviderOperationJson");
    const fetchWithTimeoutGuardedSpy = vi.spyOn(providerHttp, "fetchWithTimeoutGuarded");
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-policy", status: "processing" }),
      jsonResponse({
        jobId: "job-policy",
        status: "completed",
        videoUrl: "https://198.18.0.10/generated/policy.mp4",
      }),
      binaryResponse("webm-data", "video/webm"),
    );
    const result = await provider.generateVideo({
      ...request,
      model: "veo3",
      prompt: "policy proof",
      cfg: {
        models: {
          providers: {
            vydra: {
              baseUrl: "https://198.18.0.10/api/v1",
              models: [],
              request: {
                allowPrivateNetwork: true,
                headers: { "X-Vydra-Policy": "video-policy" },
                proxy: { mode: "env-proxy" },
              },
            },
          },
        },
      },
    });
    expect(fetchCall(fetchMock, 0)).toEqual([
      "https://198.18.0.10/api/v1/models/veo3",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "policy proof" }) }),
    ]);
    expect(fetchCall(fetchMock, 1)).toEqual([
      "https://198.18.0.10/api/v1/jobs/job-policy",
      expect.objectContaining({ method: "GET" }),
    ]);
    expect(result.videos).toEqual([
      { buffer: Buffer.from("webm-data"), mimeType: "video/webm", fileName: "video-1.webm" },
    ]);
    expect(result.metadata).toEqual({
      jobId: "job-policy",
      videoUrl: "https://198.18.0.10/generated/policy.mp4",
      status: "completed",
    });
    const submitRequest = postJsonRequestSpy.mock.calls[0]?.[0];
    expect(submitRequest?.allowPrivateNetwork).toBe(true);
    expect(submitRequest?.dispatcherPolicy).toMatchObject({ mode: "env-proxy" });
    expect(submitRequest?.headers.get("x-vydra-policy")).toBe("video-policy");
    const pollRequest = pollProviderOperationJsonSpy.mock.calls[0]?.[0];
    expect(pollRequest?.allowPrivateNetwork).toBe(true);
    expect(pollRequest?.dispatcherPolicy).toBe(submitRequest?.dispatcherPolicy);
    const pollHeaders = new Headers(
      typeof pollRequest?.headers === "function" ? pollRequest.headers() : pollRequest?.headers,
    );
    expect(pollHeaders.get("x-vydra-policy")).toBe("video-policy");
    const downloadRequest = fetchWithTimeoutGuardedSpy.mock.calls.find(
      ([url]) => url === "https://198.18.0.10/generated/policy.mp4",
    );
    expect(downloadRequest?.[4]).toMatchObject({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: submitRequest?.dispatcherPolicy,
      auditContext: "vydra-media-download",
    });
    for (const index of [0, 1, 2]) {
      const headers = new Headers((fetchCall(fetchMock, index)[1] as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
      expect(headers.get("x-vydra-policy")).toBe("video-policy");
    }
  });

  it("requires a remote image url for kling", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      provider.generateVideo({
        ...request,
        inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("Vydra kling currently requires a remote image URL reference.");
  });

  it("submits kling jobs with a remote image url", async () => {
    const fetchMock = stubFetch(
      jsonResponse({ jobId: "job-kling", status: "processing" }),
      jsonResponse({
        jobId: "job-kling",
        status: "completed",
        videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
      }),
      binaryResponse("mp4-data", "video/mp4"),
    );
    const result = await provider.generateVideo({
      ...request,
      inputImages: [{ url: "https://example.com/reference.png" }],
    });
    const createCall = fetchCall(fetchMock, 0);
    expect(createCall[0]).toBe("https://www.vydra.ai/api/v1/models/kling");
    const createInit = createCall[1] as { method?: string; body?: unknown } | undefined;
    expect(createInit?.method).toBe("POST");
    expect(createInit?.body).toBe(
      JSON.stringify({
        prompt: "animate this image",
        image_url: "https://example.com/reference.png",
        video_url: "https://example.com/reference.png",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-kling",
      videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
      status: "completed",
    });
  });
});
