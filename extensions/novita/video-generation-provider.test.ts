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
    throw new Error("Novita video generation provider was not registered");
  }
  provider = registered;
});
installProviderHttpMockCleanup();

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "novita",
    model: "wan2.6-t2v",
    prompt: "A lobster waves hello",
    cfg: {},
    ...overrides,
  });
}

function mockTask(
  payload: unknown = {
    task: { status: "TASK_STATUS_SUCCEED" },
    videos: [{ video_url: "https://example.com/out.mp4", video_type: "mp4", duration: 5 }],
  },
) {
  postJsonRequestMock.mockResolvedValueOnce({
    response: Response.json({ task_id: "task-1" }),
    release: vi.fn(async () => {}),
  });
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
  fetchWithTimeoutMock.mockResolvedValueOnce(
    new Response("video-bytes", { headers: { "content-type": "video/mp4" } }),
  );
}

describe("Novita video generation provider", () => {
  it("submits silent Wan video using the native route, polls, and downloads the result", async () => {
    mockTask();
    const result = await generateVideo({
      cfg: {
        models: {
          providers: { novita: { baseUrl: "https://api.novita.ai/openai/v1", models: [] } },
        },
      },
      durationSeconds: 9,
      aspectRatio: "9:16",
      resolution: "1080P",
      providerOptions: {
        negative_prompt: "blur",
        prompt_extend: false,
        shot_type: "single",
        seed: 42,
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: "https://api.novita.ai/v3/async/wan2.6-t2v",
        body: {
          input: { prompt: "A lobster waves hello", negative_prompt: "blur" },
          parameters: {
            size: "1080*1920",
            duration: 10,
            audio: false,
            prompt_extend: false,
            shot_type: "single",
            watermark: false,
            seed: 42,
          },
        },
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.novita.ai/v3/async/task-result?task_id=task-1",
      expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
      expect.any(Number),
      fetch,
    );
    expect(result).toMatchObject({
      model: "wan2.6-t2v",
      videos: [{ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4" }],
      metadata: { taskId: "task-1" },
    });
  });

  it.each([
    {
      model: "wan2.6-t2v",
      route: "wan2.6-i2v",
      body: {
        input: { prompt: "A lobster waves hello", img_url: "data:image/png;base64,cG5n" },
        parameters: {
          resolution: "720P",
          duration: 5,
          audio: false,
          prompt_extend: true,
          shot_type: "multi",
          watermark: false,
        },
      },
    },
    {
      model: "minimax-hailuo-2.3-t2v",
      route: "minimax-hailuo-2.3-i2v",
      body: {
        prompt: "A lobster waves hello",
        image: "data:image/png;base64,cG5n",
        duration: 6,
        resolution: "768P",
      },
    },
    {
      model: "minimax-hailuo-2.3-fast-i2v",
      route: "minimax-hailuo-2.3-fast-i2v",
      body: {
        prompt: "A lobster waves hello",
        image: "data:image/png;base64,cG5n",
        duration: 6,
        resolution: "768P",
      },
    },
  ])("sends local image data on the documented $route request", async ({ model, route, body }) => {
    mockTask();
    const result = await generateVideo({
      model,
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    });
    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: `https://api.novita.ai/v3/async/${route}`,
        body,
      }),
    );
    expect(result.model).toBe(route);
  });

  it("forwards Wan remote image/audio references and explicit audio on the i2v route", async () => {
    mockTask();
    await generateVideo({
      model: "wan2.6-i2v",
      durationSeconds: 15,
      resolution: "1080P",
      audio: true,
      watermark: true,
      inputImages: [{ url: "https://example.com/frame.png" }],
      inputAudios: [{ url: "https://example.com/track.mp3" }],
    });
    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: {
          input: {
            prompt: "A lobster waves hello",
            img_url: "https://example.com/frame.png",
            audio_url: "https://example.com/track.mp3",
          },
          parameters: {
            resolution: "1080P",
            duration: 15,
            audio: true,
            prompt_extend: true,
            shot_type: "multi",
            watermark: true,
          },
        },
      }),
    );
  });

  it("uses flat Hailuo text-to-video parameters", async () => {
    mockTask();
    await generateVideo({
      model: "minimax-hailuo-2.3-t2v",
      durationSeconds: 6,
      resolution: "1080P",
      providerOptions: { enable_prompt_expansion: false, fast_pretreatment: true },
    });
    expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: "https://api.novita.ai/v3/async/minimax-hailuo-2.3-t2v",
        body: {
          prompt: "A lobster waves hello",
          duration: 6,
          resolution: "1080P",
          enable_prompt_expansion: false,
          fast_pretreatment: true,
        },
      }),
    );
  });

  it.each([
    { request: { model: "wan2.6-i2v" }, error: "requires one input image" },
    {
      request: { model: "minimax-hailuo-2.3-t2v", durationSeconds: 10, resolution: "1080P" },
      error: "1080P requires a 6-second duration",
    },
    {
      request: {
        inputImages: [
          { url: "https://example.com/one.png" },
          { url: "https://example.com/two.png" },
        ],
      },
      error: "at most one input image",
    },
    {
      request: { inputVideos: [{ url: "https://example.com/clip.mp4" }] },
      error: "does not support video reference inputs",
    },
    {
      request: { inputAudios: [{ buffer: Buffer.from("audio") }] },
      error: "requires a remote http(s) URL",
    },
    {
      request: { providerOptions: { shot_type: "many" } },
      error: "shot_type must be single or multi",
    },
    { request: { providerOptions: { seed: -1 } }, error: "seed must be an integer" },
    {
      request: {
        model: "minimax-hailuo-2.3-fast-i2v",
        inputImages: [{ url: "https://example.com/frame.png" }],
        providerOptions: { fast_pretreatment: true },
      },
      error: "does not support provider option fast_pretreatment",
    },
  ])("rejects unsupported input before submission: $error", async ({ request, error }) => {
    await expect(generateVideo(request)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      payload: { task: { status: "TASK_STATUS_FAILED", reason: "content rejected" } },
      error: "Novita video generation failed: content rejected",
    },
    {
      payload: { task: { status: "TASK_STATUS_SUCCEED" }, videos: [] },
      error: "completed without a video URL",
    },
    { payload: { task: { status: "unknown" } }, error: "unknown task status" },
  ])("reports unsuccessful task responses: $error", async ({ payload, error }) => {
    mockTask(payload);
    await expect(generateVideo()).rejects.toThrow(error);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
