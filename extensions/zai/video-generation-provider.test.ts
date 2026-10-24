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
const prompt = "A blue cube sliding across a studio floor";
const videoUrl = "https://example.com/video.mp4";

function generateVideo(request: Partial<Video.VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "zai",
    model: "cogvideox-3",
    prompt,
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

it.each([
  [undefined, "https://api.z.ai/api/paas/v4"],
  ["https://open.bigmodel.cn/api/coding/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"],
  ["https://api.z.ai/api/coding/paas/v4", "https://api.z.ai/api/paas/v4"],
  ["https://proxy.example/zai/", "https://proxy.example/zai"],
])("Z.AI generates and downloads video from %s via %s", async (configured, baseUrl) => {
  const processing = configured === undefined;
  const remote = configured === "https://proxy.example/zai/";
  const image = remote
    ? { url: "https://example.com/frame.jpg" }
    : { buffer: Buffer.from("png-bytes"), mimeType: "image/png" };
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
  const pending = generateVideo(
    processing
      ? {
          durationSeconds: 10,
          size: "1900x1069",
          audio: true,
          providerOptions: { quality: "quality", fps: 60 },
        }
      : {
          cfg: { models: { providers: { zai: { baseUrl: configured, models: [] } } } },
          ...(remote ? {} : { durationSeconds: 5, aspectRatio: "9:16" }),
          inputImages: [image],
        },
  );
  await vi.advanceTimersByTimeAsync(processing ? 5_000 : 0);
  expect(await pending).toMatchObject({
    model: "cogvideox-3",
    videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    metadata: { taskId: "task-1", status: "SUCCESS" },
  });
  const body = processing
    ? {
        model: "cogvideox-3",
        prompt,
        duration: 10,
        size: "1920x1080",
        with_audio: true,
        quality: "quality",
        fps: 60,
      }
    : expect.objectContaining({
        image_url: remote ? image.url : "data:image/png;base64,cG5nLWJ5dGVz",
        duration: 5,
        size: remote ? "1280x720" : "720x1280",
        with_audio: false,
      });
  expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: `${baseUrl}/videos/generations`,
      headers: expect.any(Headers),
      body,
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

it.each<{ request: Partial<Video.VideoGenerationRequest>; error: string }>([
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
])("Z.AI rejects unsupported input before submission: $error", async ({ request, error }) => {
  await expect(generateVideo(request)).rejects.toThrow(error);
  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each<{ payload: Record<string, unknown>; error: string }>([
  {
    payload: { task_status: "FAIL", error: { message: "Generation rejected" } },
    error: "Generation rejected",
  },
  { payload: { task_status: "SUCCESS", video_result: [] }, error: "completed without a video URL" },
  { payload: {}, error: "missing or unknown task_status" },
])("Z.AI reports unusable task results: $error", async ({ payload, error }) => {
  mockSubmit();
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
  await expect(generateVideo()).rejects.toThrow(error);
  expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
});
