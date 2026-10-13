import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { generateVideo as generateRuntimeVideo } from "openclaw/plugin-sdk/video-generation-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
function generate(request: Partial<VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "kie",
    model: "kling-2.6/text-to-video",
    prompt: PROMPT,
    cfg: {},
    ...request,
  });
}
function postResponse(payload: unknown) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({ response: Response.json(payload), release });
  return release;
}
function taskResponse(data: unknown) {
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ code: 200, data }));
}
function mockSuccess() {
  postResponse({ code: 200, data: { taskId: "task /1" } });
  taskResponse({ state: "success", response: { resultUrls: [OUTPUT] } });
  fetchWithTimeoutMock.mockResolvedValueOnce(
    new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }),
  );
}
function submittedBody() {
  return requireFirstPostJsonRecordRequest(postJsonRequestMock, "Kie submission").body;
}

describe("Kie AI registered video provider", () => {
  it("submits, polls every documented pending state, decodes resultJson, and downloads without auth", async () => {
    vi.useFakeTimers();
    const release = postResponse({ code: 200, data: { taskId: "task /1" } });
    for (const state of ["waiting", "queuing", "generating"]) {
      taskResponse({ state });
    }
    taskResponse({ state: "success", resultJson: JSON.stringify({ resultUrls: [OUTPUT] }) });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }),
    );
    const pending = generate({ audio: true, durationSeconds: 10, timeoutMs: 20_000 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(submittedBody()).toEqual({
      model: "kling-2.6/text-to-video",
      input: { prompt: PROMPT, duration: "10", sound: true, aspect_ratio: "16:9" },
    });
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task%20%2F1",
      expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
      expect.any(Number),
      fetch,
    );
    expect(fetchWithTimeoutMock).toHaveBeenLastCalledWith(
      OUTPUT,
      { method: "GET" },
      expect.any(Number),
      fetch,
    );
    expect(result).toMatchObject({
      model: "kling-2.6/text-to-video",
      videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      metadata: { taskId: "task /1" },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      model: "hailuo/02-text-to-video-pro",
      inputImages: undefined,
      input: {},
    },
    {
      model: "hailuo/2-3-image-to-video-standard",
      inputImages: [{ url: IMAGE }],
      input: { duration: "6", resolution: "768P", image_url: IMAGE },
    },
  ])(
    "maps optional controls and scalar image URLs for $model",
    async ({ model, inputImages, input }) => {
      mockSuccess();
      const result = await generate({ model, inputImages });
      expect(submittedBody()).toEqual({ model, input: { prompt: PROMPT, ...input } });
      expect(result.model).toBe(model);
      expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4-bytes"));
    },
  );

  it("uploads a local buffer before submitting its returned URL", async () => {
    const release = postResponse({ code: 200, success: true, data: { downloadUrl: IMAGE } });
    mockSuccess();
    await generate({
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "same-name.png" },
      ],
    });
    expect(postJsonRequestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://kieai.redpandaai.co/api/file-base64-upload",
        body: {
          base64Data: "data:image/png;base64,cG5nLWJ5dGVz",
          uploadPath: "openclaw/video-inputs",
        },
      }),
    );
    expect(postJsonRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://api.kie.ai/api/v1/jobs/createTask",
        body: {
          model: "kling-2.6/image-to-video",
          input: { prompt: PROMPT, duration: "5", sound: false, image_urls: [IMAGE] },
        },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("stops before submission when upload returns an HTTP-200 body error", async () => {
    postResponse({ code: 422, msg: "Record not found for requested model" });
    await expect(generate({ inputImages: [{ buffer: Buffer.from("png") }] })).rejects.toThrow(
      "Record not found for requested model",
    );
    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      data: { state: "fail", failCode: "CONTENT_REJECTED", failMsg: "Prompt rejected" },
      error: "CONTENT_REJECTED): Prompt rejected",
    },
    { data: { state: "mystery" }, error: "unknown state: mystery" },
    { data: { state: "success", resultJson: "not JSON" }, error: "malformed resultJson" },
    { data: { state: "success", resultJson: '{"resultUrls":[]}' }, error: "without result URLs" },
  ])("rejects unusable completed jobs: $error", async ({ data, error }) => {
    postResponse({ code: 200, data: { taskId: "task-1" } });
    taskResponse(data);
    await expect(generate()).rejects.toThrow(error);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
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
    expect(submittedBody()).toEqual({
      model: "grok-imagine/text-to-video",
      input: { prompt: PROMPT, duration: 29, resolution: "1080p", aspect_ratio: "16:9" },
    });
    expect(result.ignoredOverrides).toContainEqual({ key: "audio", value: true });
  });

  it.each([
    { request: { inputVideos: [{ url: OUTPUT }] }, error: "does not support video or audio" },
    {
      request: { inputImages: [{ url: IMAGE }, { url: IMAGE }] },
      error: "at most one input image",
    },
    { request: { inputImages: [{ url: "data:image/png;base64,cG5n" }] }, error: "remote http(s)" },
    { request: { model: "hailuo/2-3-image-to-video-pro" }, error: "requires one input image" },
    {
      request: {
        model: "hailuo/2-3-image-to-video-pro",
        inputImages: [{ url: IMAGE }],
        resolution: "1080P",
        durationSeconds: 10,
      },
      error: "1080P only at 6 seconds",
    },
    { request: { model: "unknown" }, error: "does not support model unknown" },
    {
      request: { model: "bytedance/seedance-1.5-pro", prompt: "Hi" },
      error: "requires a prompt of 3-20000 characters",
    },
  ])("rejects invalid inputs before upload or billing: $error", async ({ request, error }) => {
    await expect(generate(request)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
