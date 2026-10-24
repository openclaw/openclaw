import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as vydra from "./provider-test-helpers.js";

describe("vydra video-generation provider", () => {
  installPinnedHostnameTestHooks();
  const { videoProvider: provider } = vydra.registerVydraProviders();
  const request = { provider: "vydra", model: "kling", prompt: "animate this image", cfg: {} };
  const completed = (jobId: string, videoUrl: string) => ({ jobId, status: "completed", videoUrl });
  const stubJob = (jobId: string, videoUrl: string, data: string, mime = "video/mp4") =>
    vydra.stubFetch(
      jsonResponse({ jobId, status: "processing" }),
      jsonResponse(completed(jobId, videoUrl)),
      vydra.binaryResponse(data, mime),
    );
  beforeEach(vydra.stubVydraApiKey);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(provider);
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    stubJob("job-123", "https://cdn.vydra.ai/generated/test.mp4", "too-large");
    await expect(
      provider.generateVideo({
        ...request,
        model: "veo3",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Vydra video download exceeds 1 bytes");
  });

  it("submits, polls, and downloads veo3 video with the configured request policy", async () => {
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonResponse");
    const pollProviderOperationJsonSpy = vi.spyOn(providerHttp, "pollProviderOperationJson");
    const fetchWithTimeoutGuardedSpy = vi.spyOn(providerHttp, "fetchWithTimeoutGuarded");
    const videoUrl = "https://198.18.0.10/generated/policy.mp4";
    const baseUrl = "https://198.18.0.10/api/v1";
    const policy = {
      allowPrivateNetwork: true,
      headers: { "X-Vydra-Policy": "video-policy" },
      proxy: { mode: "env-proxy" as const },
    };
    const fetchMock = stubJob("job-policy", videoUrl, "webm-data", "video/webm");
    const result = await provider.generateVideo({
      ...request,
      model: "veo3",
      prompt: "policy proof",
      cfg: { models: { providers: { vydra: { baseUrl, models: [], request: policy } } } },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${baseUrl}/models/veo3`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "policy proof" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${baseUrl}/jobs/job-policy`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.videos).toEqual([
      { buffer: Buffer.from("webm-data"), mimeType: "video/webm", fileName: "video-1.webm" },
    ]);
    expect(result.metadata).toEqual(completed("job-policy", videoUrl));
    const submitRequest = postJsonRequestSpy.mock.calls[0]?.[0];
    expect(submitRequest).toMatchObject({
      allowPrivateNetwork: true,
      dispatcherPolicy: { mode: "env-proxy" },
    });
    expect(submitRequest?.headers.get("x-vydra-policy")).toBe("video-policy");
    const pollRequest = pollProviderOperationJsonSpy.mock.calls[0]?.[0];
    expect(pollRequest?.allowPrivateNetwork).toBe(true);
    expect(pollRequest?.dispatcherPolicy).toBe(submitRequest?.dispatcherPolicy);
    const pollHeaders = new Headers(
      typeof pollRequest?.headers === "function" ? pollRequest.headers() : pollRequest?.headers,
    );
    expect(pollHeaders.get("x-vydra-policy")).toBe("video-policy");
    const downloadRequest = fetchWithTimeoutGuardedSpy.mock.calls.find(([url]) => url === videoUrl);
    expect(downloadRequest?.[4]).toMatchObject({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy: submitRequest?.dispatcherPolicy,
      auditContext: "vydra-media-download",
    });
    for (const index of [0, 1, 2]) {
      const call = fetchMock.mock.calls[index];
      assert(call, `Expected fetch call ${index}`);
      const headers = new Headers((call[1] as RequestInit).headers);
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
    const videoUrl = "https://cdn.vydra.ai/generated/kling.mp4";
    const fetchMock = stubJob("job-kling", videoUrl, "mp4-data");
    const result = await provider.generateVideo({
      ...request,
      inputImages: [{ url: "https://example.com/reference.png" }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/kling",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "animate this image",
          image_url: "https://example.com/reference.png",
          video_url: "https://example.com/reference.png",
        }),
      }),
    );
    expect(result.videos.map(({ mimeType }) => mimeType)).toEqual(["video/mp4"]);
    expect(result.metadata).toEqual(completed("job-kling", videoUrl));
  });
});
