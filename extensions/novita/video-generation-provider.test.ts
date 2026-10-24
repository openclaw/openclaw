import assert from "node:assert/strict";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http-test-mocks";
import type * as Video from "openclaw/plugin-sdk/video-generation";
import { beforeAll, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = providerHttp.getProviderHttpMocks();
const prompt = "A lobster waves hello";
const hailuoModel = "minimax-hailuo-2.3-t2v";
const hailuoBody = { prompt, duration: 6, resolution: "768P" };
const hailuoOptions = { enable_prompt_expansion: false, fast_pretreatment: true };
const novitaBaseUrl = "https://api.novita.ai/openai/v1";
const remote = (name: string) => ({ url: `https://example.com/${name}` });
let provider: Video.VideoGenerationProvider;

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const registered = capturePluginRegistration(plugin).videoGenerationProviders[0];
  assert(registered, "Novita video generation provider was not registered");
  provider = registered;
});
providerHttp.installProviderHttpMockCleanup();

function generateVideo(req: Partial<Video.VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "novita",
    model: "wan2.6-t2v",
    prompt,
    cfg: {},
    ...req,
  });
}

function mockTask(
  payload: unknown = {
    task: { status: "TASK_STATUS_SUCCEED" },
    videos: [{ video_url: "https://example.com/out.mp4" }],
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

it.each<[string, Partial<Video.VideoGenerationRequest>, unknown]>([
  [
    "wan2.6-t2v",
    {
      cfg: { models: { providers: { novita: { baseUrl: novitaBaseUrl, models: [] } } } },
      durationSeconds: 10,
      aspectRatio: "9:16",
      resolution: "1080P",
      providerOptions: {
        negative_prompt: "blur",
        prompt_extend: false,
        shot_type: "single",
        seed: 42,
      },
    },
    {
      input: { prompt, negative_prompt: "blur" },
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
  ],
  [
    "minimax-hailuo-2.3-i2v",
    {
      model: hailuoModel,
      inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
    },
    { ...hailuoBody, image: "data:image/png;base64,cG5n" },
  ],
  [
    "wan2.6-i2v",
    {
      model: "wan2.6-i2v",
      durationSeconds: 15,
      resolution: "1080P",
      audio: true,
      watermark: true,
      inputImages: [remote("frame.png")],
      inputAudios: [remote("track.mp3")],
    },
    {
      input: {
        prompt,
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
  ],
  [
    hailuoModel,
    {
      model: hailuoModel,
      durationSeconds: 6,
      resolution: "1080P",
      providerOptions: hailuoOptions,
    },
    { ...hailuoBody, resolution: "1080P", ...hailuoOptions },
  ],
])("submits %s, polls, and downloads the result", async (route, request, body) => {
  mockTask();
  const result = await generateVideo(request);
  expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ url: `https://api.novita.ai/v3/async/${route}`, body }),
  );
  expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
    1,
    "https://api.novita.ai/v3/async/task-result?task_id=task-1",
    expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
    expect.any(Number),
    fetch,
  );
  expect(result).toMatchObject({
    model: route,
    videos: [{ buffer: Buffer.from("video-bytes"), mimeType: "video/mp4" }],
    metadata: { taskId: "task-1" },
  });
});

it.each<[Partial<Video.VideoGenerationRequest>, string]>([
  [{ model: "wan2.6-i2v" }, "requires one input image"],
  [
    { model: hailuoModel, durationSeconds: 10, resolution: "1080P" },
    "1080P requires a 6-second duration",
  ],
  [{ inputImages: [remote("one.png"), remote("two.png")] }, "at most one input image"],
  [{ inputVideos: [remote("clip.mp4")] }, "does not support video reference inputs"],
  [{ inputAudios: [{ buffer: Buffer.from("audio") }] }, "requires a remote http(s) URL"],
  [{ providerOptions: { shot_type: "many" } }, "shot_type must be single or multi"],
  [{ providerOptions: { seed: -1 } }, "seed must be an integer"],
  [
    {
      model: "minimax-hailuo-2.3-fast-i2v",
      inputImages: [remote("frame.png")],
      providerOptions: { fast_pretreatment: true },
    },
    "does not support provider option fast_pretreatment",
  ],
])("rejects unsupported input before submission: %j (%s)", async (request, error) => {
  await expect(generateVideo(request)).rejects.toThrow(error);
  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each<[unknown, string]>([
  [
    { task: { status: "TASK_STATUS_FAILED", reason: "content rejected" } },
    "Novita video generation failed: content rejected",
  ],
  [{ task: { status: "TASK_STATUS_SUCCEED" }, videos: [] }, "completed without a video URL"],
  [{ task: { status: "unknown" } }, "unknown task status"],
])("reports unsuccessful task responses: %j (%s)", async (payload, error) => {
  mockTask(payload);
  await expect(generateVideo()).rejects.toThrow(error);
  expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
});
