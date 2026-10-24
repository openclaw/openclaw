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
function generate(req: Partial<VideoGenerationRequest> = {}) {
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
function mockSuccess(tasks: unknown[] = [{ state: "success", response: RESULT }]) {
  const release = postResponse({ code: 200, data: { taskId: "task /1" } });
  tasks.forEach(taskResponse);
  fetchWithTimeoutMock.mockResolvedValueOnce(
    new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }),
  );
  return release;
}
function expectPost(n: number, url: string, body: Record<string, unknown>) {
  expect(postJsonRequestMock).toHaveBeenNthCalledWith(n, expect.objectContaining({ url, body }));
}
function expectGet(index: number, url: string, init: RequestInit) {
  expect(fetchWithTimeoutMock.mock.calls.at(index)).toEqual([url, init, expect.any(Number), fetch]);
}

it("submits, polls pending states, decodes resultJson, and downloads without auth", async () => {
  vi.useFakeTimers();
  const release = mockSuccess([
    ...["waiting", "queuing", "generating"].map((state) => ({ state })),
    { state: "success", resultJson: JSON.stringify(RESULT) },
  ]);
  const pending = generate({ audio: true, durationSeconds: 10, timeoutMs: 20_000 });
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({
    model: MODEL,
    videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    metadata: { taskId: "task /1" },
  });
  expectPost(1, `${API}/createTask`, {
    model: MODEL,
    input: { prompt: PROMPT, duration: "10", sound: true, aspect_ratio: "16:9" },
  });
  expectGet(
    0,
    `${API}/recordInfo?taskId=task%20%2F1`,
    expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
  );
  expectGet(-1, OUTPUT, { method: "GET" });
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  { model: "hailuo/02-text-to-video-pro", input: {} },
  {
    model: "hailuo/2-3-image-to-video-standard",
    input: { duration: "6", resolution: "768P", image_url: IMAGE },
  },
])("maps optional controls and scalar image URLs for $model", async ({ model, input }) => {
  mockSuccess();
  const inputImages = input.image_url ? [{ url: input.image_url }] : undefined;
  const result = await generate({ model, inputImages });
  expectPost(1, `${API}/createTask`, { model, input: { prompt: PROMPT, ...input } });
  expect(result).toMatchObject({ model, videos: [{ buffer: Buffer.from("mp4-bytes") }] });
});

it("uploads a local buffer before submitting its returned URL", async () => {
  const release = postResponse({ code: 200, success: true, data: { downloadUrl: IMAGE } });
  mockSuccess();
  await generate({ inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }] });
  expectPost(1, "https://kieai.redpandaai.co/api/file-base64-upload", {
    base64Data: "data:image/png;base64,cG5nLWJ5dGVz",
    uploadPath: "openclaw/video-inputs",
  });
  expectPost(2, `${API}/createTask`, {
    model: "kling-2.6/image-to-video",
    input: { prompt: PROMPT, duration: "5", sound: false, image_urls: [IMAGE] },
  });
  expect(release).toHaveBeenCalledOnce();
});

it("stops before submission when upload returns an HTTP-200 body error", async () => {
  const error = "Record not found for requested model";
  postResponse({ code: 422, msg: error });
  await expect(generate({ inputImages: [{ buffer: Buffer.from("png") }] })).rejects.toThrow(error);
  expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
  expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
});

it.each`
  error                                   | data
  ${"CONTENT_REJECTED): Prompt rejected"} | ${{ state: "fail", failCode: "CONTENT_REJECTED", failMsg: "Prompt rejected" }}
  ${"unknown state: mystery"}             | ${{ state: "mystery" }}
  ${"malformed resultJson"}               | ${{ state: "success", resultJson: "not JSON" }}
  ${"without result URLs"}                | ${{ state: "success", resultJson: '{"resultUrls":[]}' }}
`(
  "rejects unusable completed jobs: $error",
  async ({ error, data }: { error: string; data: unknown }) => {
    postResponse({ code: 200, data: { taskId: "task-1" } });
    taskResponse(data);
    await expect(generate()).rejects.toThrow(error);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  },
);

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

it.each`
  error                                        | request
  ${"does not support video or audio"}         | ${{ inputVideos: [{ url: OUTPUT }] }}
  ${"at most one input image"}                 | ${{ inputImages: [{ url: IMAGE }, { url: IMAGE }] }}
  ${"remote http(s)"}                          | ${{ inputImages: [{ url: "data:image/png;base64,cG5n" }] }}
  ${"requires one input image"}                | ${{ model: "hailuo/2-3-image-to-video-pro" }}
  ${"1080P only at 6 seconds"}                 | ${{ model: "hailuo/2-3-image-to-video-pro", inputImages: [{ url: IMAGE }], resolution: "1080P", durationSeconds: 10 }}
  ${"does not support model unknown"}          | ${{ model: "unknown" }}
  ${"requires a prompt of 3-20000 characters"} | ${{ model: "bytedance/seedance-1.5-pro", prompt: "Hi" }}
`(
  "rejects invalid inputs before upload or billing: $error",
  async ({ error, request }: { error: string; request: Partial<VideoGenerationRequest> }) => {
    await expect(generate(request)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  },
);
