import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { generateVideo as generateRuntimeVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
let provider: VideoGenerationProvider;
beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const registered = capturePluginRegistration(plugin).videoGenerationProviders[0];
  if (!registered) {
    throw new Error("Kie plugin did not register video generation");
  }
  provider = registered;
});
installProviderHttpMockCleanup();
afterEach(() => vi.useRealTimers());

const PROMPT = "A tiny lobster walks across a sandy beach";
const IMAGE = "https://example.com/frame.png";
const OUTPUT = "https://example.com/video.mp4";
const MODEL = "kling-2.6/text-to-video";
const API = "https://api.kie.ai/api/v1/jobs";
const RESULT = { resultUrls: [OUTPUT] };
type Request = Partial<VideoGenerationRequest>;
function generate(req: Request = {}) {
  return provider.generateVideo({ provider: "kie", model: MODEL, prompt: PROMPT, cfg: {}, ...req });
}
function postResponse(payload: unknown) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({ response: Response.json(payload), release });
  return release;
}
function taskResponse(data: unknown) {
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code: 200, data }));
}
function mockSuccess(pending = false) {
  const release = postResponse({ code: 200, data: { taskId: "task /1" } });
  if (pending) {
    ["waiting", "queuing", "generating"].forEach((state) => taskResponse({ state }));
  }
  const result = pending ? { resultJson: JSON.stringify(RESULT) } : { response: RESULT };
  taskResponse({ state: "success", ...result });
  fetchWithTimeoutMock.mockResolvedValueOnce(
    new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }),
  );
  return release;
}
function expectPost(n: number, url: string, body: Record<string, unknown>) {
  expect(postJsonRequestMock).toHaveBeenNthCalledWith(n, expect.objectContaining({ url, body }));
}
it.each<{ model: string; request: Request; input: Record<string, unknown> }>([
  {
    model: MODEL,
    request: { audio: true, durationSeconds: 10, timeoutMs: 20_000 },
    input: { duration: "10", sound: true, aspect_ratio: "16:9" },
  },
  {
    model: "hailuo/02-text-to-video-pro",
    request: { model: "hailuo/02-text-to-video-pro" },
    input: {},
  },
  {
    model: "hailuo/2-3-image-to-video-standard",
    request: { model: "hailuo/2-3-image-to-video-standard", inputImages: [{ url: IMAGE }] },
    input: { duration: "6", resolution: "768P", image_url: IMAGE },
  },
  {
    model: "kling-2.6/image-to-video",
    request: { inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }] },
    input: { duration: "5", sound: false, image_urls: [IMAGE] },
  },
])("submits $model, polls, and downloads without auth", async ({ model, request, input }) => {
  vi.useFakeTimers();
  const upload = request.inputImages?.[0]?.buffer;
  const uploadRelease =
    upload && postResponse({ code: 200, success: true, data: { downloadUrl: IMAGE } });
  const release = mockSuccess(model === MODEL);
  const pending = generate(request);
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({
    model,
    videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    metadata: { taskId: "task /1" },
  });
  if (upload) {
    expectPost(1, "https://kieai.redpandaai.co/api/file-base64-upload", {
      base64Data: "data:image/png;base64,cG5nLWJ5dGVz",
      uploadPath: "openclaw/video-inputs",
    });
    expect(uploadRelease).toHaveBeenCalledOnce();
  }
  expectPost(upload ? 2 : 1, `${API}/createTask`, { model, input: { prompt: PROMPT, ...input } });
  expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(`${API}/recordInfo?taskId=task%20%2F1`);
  expect(fetchWithTimeoutMock.mock.calls.at(-1)?.slice(0, 2)).toEqual([OUTPUT, { method: "GET" }]);
  expect(release).toHaveBeenCalledOnce();
});

it("uses model-specific capabilities through the shared runtime", async () => {
  mockSuccess();
  const result = await generateRuntimeVideo(
    {
      cfg: {},
      prompt: PROMPT,
      modelOverride: "kie/grok-imagine/text-to-video",
      durationSeconds: 29,
      resolution: "1080P",
      audio: true,
    },
    {
      getProvider: () => provider,
      listProviders: () => [provider],
      getProviderEnvVars: () => [],
      log: { warn: vi.fn(), debug: vi.fn() },
    },
  );
  expectPost(1, `${API}/createTask`, {
    model: "grok-imagine/text-to-video",
    input: { prompt: PROMPT, duration: 29, resolution: "1080p", aspect_ratio: "16:9" },
  });
  expect(result.ignoredOverrides).toContainEqual({ key: "audio", value: true });
});

it.each<{ error: string; request: Request; data?: unknown }>([
  { error: "does not support video or audio", request: { inputVideos: [{ url: OUTPUT }] } },
  { error: "at most one input image", request: { inputImages: [{ url: IMAGE }, { url: IMAGE }] } },
  { error: "remote http(s)", request: { inputImages: [{ url: "data:image/png;base64,cG5n" }] } },
  { error: "requires one input image", request: { model: "hailuo/2-3-image-to-video-pro" } },
  {
    error: "1080P only at 6 seconds",
    request: {
      model: "hailuo/2-3-image-to-video-pro",
      inputImages: [{ url: IMAGE }],
      resolution: "1080P",
      durationSeconds: 10,
    },
  },
  { error: "does not support model unknown", request: { model: "unknown" } },
  {
    error: "requires a prompt of 3-20000 characters",
    request: { model: "bytedance/seedance-1.5-pro", prompt: "Hi" },
  },
  {
    error: "CONTENT_REJECTED): Prompt rejected",
    request: {},
    data: { state: "fail", failCode: "CONTENT_REJECTED", failMsg: "Prompt rejected" },
  },
  { error: "unknown state: mystery", request: {}, data: { state: "mystery" } },
  {
    error: "malformed resultJson",
    request: {},
    data: { state: "success", resultJson: "not JSON" },
  },
  {
    error: "without result URLs",
    request: {},
    data: { state: "success", resultJson: '{"resultUrls":[]}' },
  },
  {
    error: "Record not found for requested model",
    request: { inputImages: [{ buffer: Buffer.from("png") }] },
    data: { code: 422, msg: "Record not found for requested model" },
  },
])("rejects at the expected request stage: $error", async ({ error, request, data }) => {
  const upload = Boolean(request.inputImages?.[0]?.buffer);
  if (data) {
    postResponse(upload ? data : { code: 200, data: { taskId: "task-1" } });
    if (!upload) {
      taskResponse(data);
    }
  }
  await expect(generate(request)).rejects.toThrow(error);
  expect(postJsonRequestMock).toHaveBeenCalledTimes(data ? 1 : 0);
  expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(data && !upload ? 1 : 0);
});
