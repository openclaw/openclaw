import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
let provider: VideoGenerationProvider;

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const registered = capturePluginRegistration(plugin).videoGenerationProviders[0];
  if (!registered) {
    throw new Error("Z.AI video generation provider was not registered");
  }
  provider = registered;
});
installProviderHttpMockCleanup();

function generateVideo(request: Partial<VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "zai",
    model: "cogvideox-3",
    prompt: "A blue cube sliding across a studio floor",
    cfg: {},
    ...request,
  });
}

function mockSubmit() {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({
    response: Response.json({ id: "task-1", task_status: "PROCESSING" }),
    release,
  });
  return release;
}

function mockSuccess() {
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      Response.json({
        task_status: "SUCCESS",
        video_result: [
          {
            url: "https://example.com/video.mp4",
            cover_image_url: "https://example.com/cover.jpg",
          },
        ],
      }),
    )
    .mockResolvedValueOnce(new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }));
}

describe("Z.AI video generation", () => {
  it("submits CogVideoX fields, waits for SUCCESS, and downloads the video", async () => {
    vi.useFakeTimers();
    try {
      const release = mockSubmit();
      fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ task_status: "PROCESSING" }));
      mockSuccess();
      const pending = generateVideo({
        durationSeconds: 9,
        size: "1900x1069",
        audio: true,
        providerOptions: { quality: "quality", fps: 60 },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: "https://api.z.ai/api/paas/v4/videos/generations",
          headers: expect.any(Headers),
          body: {
            model: "cogvideox-3",
            prompt: "A blue cube sliding across a studio floor",
            duration: 10,
            size: "1920x1080",
            with_audio: true,
            quality: "quality",
            fps: 60,
          },
        }),
      );
      expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
        2,
        "https://api.z.ai/api/paas/v4/async-result/task-1",
        expect.objectContaining({ method: "GET" }),
        expect.any(Number),
        fetch,
      );
      expect(release).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        model: "cogvideox-3",
        videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        metadata: { taskId: "task-1", status: "SUCCESS" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"],
    ["https://open.bigmodel.cn/api/coding/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"],
    ["https://api.z.ai/api/coding/paas/v4", "https://api.z.ai/api/paas/v4"],
    ["https://proxy.example/zai/", "https://proxy.example/zai"],
  ])("reuses %s for regional image-to-video", async (baseUrl, videoBaseUrl) => {
    mockSubmit();
    mockSuccess();
    await generateVideo({
      cfg: { models: { providers: { zai: { baseUrl, models: [] } } } },
      durationSeconds: 6,
      aspectRatio: "9:16",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });
    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: `${videoBaseUrl}/videos/generations`,
        body: expect.objectContaining({
          image_url: "data:image/png;base64,cG5nLWJ5dGVz",
          duration: 5,
          size: "720x1280",
          with_audio: false,
        }),
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      `${videoBaseUrl}/async-result/task-1`,
      expect.objectContaining({
        method: "GET",
        headers: new Headers({
          Authorization: "Bearer provider-key",
          "Content-Type": "application/json",
        }),
      }),
      expect.any(Number),
      fetch,
    );
  });

  it("passes a remote image URL unchanged", async () => {
    mockSubmit();
    mockSuccess();
    await generateVideo({ inputImages: [{ url: "https://example.com/frame.jpg" }] });
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ image_url: "https://example.com/frame.jpg" }),
      }),
    );
  });

  it.each([
    {
      request: {
        inputImages: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
      },
      error: "at most one input image",
    },
    {
      request: { inputVideos: [{ url: "https://example.com/input.mp4" }] },
      error: "does not support video or audio reference",
    },
    {
      request: { inputImages: [{ buffer: Buffer.from("gif"), mimeType: "image/gif" }] },
      error: "PNG or JPEG",
    },
    {
      request: {
        inputImages: [{ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png" }],
      },
      error: "no larger than 5 MB",
    },
    { request: { providerOptions: { fps: 24 } }, error: "fps must be 30 or 60" },
    { request: { providerOptions: { quality: "draft" } }, error: "quality must be" },
  ])("rejects unsupported input before submission: $error", async ({ request, error }) => {
    await expect(generateVideo(request)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      payload: { task_status: "FAIL", error: { message: "Generation rejected" } },
      error: "Generation rejected",
    },
    {
      payload: { task_status: "SUCCESS", video_result: [] },
      error: "completed without a video URL",
    },
    { payload: {}, error: "missing or unknown task_status" },
  ])("reports unusable task results: $error", async ({ payload, error }) => {
    mockSubmit();
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
    await expect(generateVideo()).rejects.toThrow(error);
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
  });
});
