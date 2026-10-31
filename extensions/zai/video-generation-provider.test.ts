import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type * as Video from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
let provider: Video.VideoGenerationProvider;

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const registered = capturePluginRegistration(plugin).videoGenerationProviders[0];
  if (!registered) {
    throw new Error("Z.AI video generation provider was not registered");
  }
  provider = registered;
});
installProviderHttpMockCleanup();
afterEach(() => vi.useRealTimers());
const videoUrl = "https://example.com/video.mp4";
const imageUrl = "https://example.com/frame.jpg";
const imageDataUrl = "data:image/png;base64,cG5nLWJ5dGVz";
const image = (buffer: Buffer, mimeType = "image/png") => ({ buffer, mimeType });
const requestDefaults = { provider: "zai", model: "cogvideox-3", prompt: "cube", cfg: {} };

function generateVideo(request: Partial<Video.VideoGenerationRequest> = {}) {
  return provider.generateVideo({ ...requestDefaults, ...request });
}

function mockSubmit() {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({
    response: Response.json({ id: "task-1", task_status: "PROCESSING" }),
    release,
  });
  return release;
}

it.each([
  [undefined, "https://api.z.ai/api/paas/v4"],
  ["https://open.bigmodel.cn/api/coding/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"],
  ["https://api.z.ai/api/coding/paas/v4", "https://api.z.ai/api/paas/v4"],
  ["https://proxy.example/zai/", "https://proxy.example/zai"],
])("Z.AI generates and downloads video from %s via %s", async (configured, baseUrl) => {
  const processing = configured === undefined;
  const remote = configured === "https://proxy.example/zai/";
  vi.useFakeTimers();
  const release = mockSubmit();
  if (processing) {
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ task_status: "PROCESSING" }));
  }
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      Response.json({ task_status: "SUCCESS", video_result: [{ url: videoUrl }] }),
    )
    .mockResolvedValueOnce(new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }));
  const pending = generateVideo({
    cfg: processing ? {} : { models: { providers: { zai: { baseUrl: configured, models: [] } } } },
    durationSeconds: processing ? 10 : remote ? undefined : 5,
    size: processing ? "1900x1069" : undefined,
    audio: processing ? true : undefined,
    providerOptions: processing ? { quality: "quality", fps: 60 } : undefined,
    aspectRatio: !processing && !remote ? "9:16" : undefined,
    inputImages: processing
      ? undefined
      : [remote ? { url: imageUrl } : image(Buffer.from("png-bytes"))],
  });
  await vi.advanceTimersByTimeAsync(processing ? 5_000 : 0);
  expect(await pending).toMatchObject({
    model: "cogvideox-3",
    videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    metadata: { taskId: "task-1", status: "SUCCESS" },
  });
  expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: `${baseUrl}/videos/generations`,
      headers: expect.any(Headers),
      body: {
        model: "cogvideox-3",
        prompt: "cube",
        duration: processing ? 10 : 5,
        size: processing ? "1920x1080" : remote ? "1280x720" : "720x1280",
        with_audio: processing,
        quality: processing ? "quality" : "speed",
        fps: processing ? 60 : 30,
        ...(processing ? {} : { image_url: remote ? imageUrl : imageDataUrl }),
      },
    }),
  );
  expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
    processing ? 2 : 1,
    `${baseUrl}/async-result/task-1`,
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
  expect(release).toHaveBeenCalledOnce();
});

it.each<[string, Partial<Video.VideoGenerationRequest>]>([
  ["at most one input image", { inputImages: [{ url: imageUrl }, { url: imageUrl }] }],
  ["does not support video or audio reference", { inputVideos: [{ url: videoUrl }] }],
  ["PNG or JPEG", { inputImages: [image(Buffer.from("gif"), "image/gif")] }],
  ["no larger than 5 MB", { inputImages: [image(Buffer.alloc(5 * 1024 * 1024 + 1))] }],
  ["fps must be 30 or 60", { providerOptions: { fps: 24 } }],
  ["quality must be", { providerOptions: { quality: "draft" } }],
])("Z.AI rejects unsupported input before submission: %s", async (error, request) => {
  await expect(generateVideo(request)).rejects.toThrow(error);
  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each<[string, Record<string, unknown>]>([
  ["Generation rejected", { task_status: "FAIL", error: { message: "Generation rejected" } }],
  ["completed without a video URL", { task_status: "SUCCESS", video_result: [] }],
  ["missing or unknown task_status", {}],
])("Z.AI reports unusable task results: %s", async (error, payload) => {
  mockSubmit();
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
  await expect(generateVideo()).rejects.toThrow(error);
  expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
});
