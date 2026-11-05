import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import type {
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createProxyRequestModelProviderConfig } from "../test-support/model-provider-config.test-support.js";

const {
  postJsonRequestMock: post,
  fetchWithTimeoutGuardedMock: guarded,
  fetchWithTimeoutMock: fetchMock,
  resolveApiKeyForProviderMock: auth,
  resolveProviderHttpRequestConfigMock: policy,
} = getProviderHttpMocks();
let build: typeof import("./video-generation-provider.js").buildXaiVideoGenerationProvider;
beforeAll(async () => {
  ({ buildXaiVideoGenerationProvider: build } = await import("./video-generation-provider.js"));
});
installProviderHttpMockCleanup();

function request(index = 0) {
  const call = (post.mock.calls as Array<[{ url: string; body: Record<string, unknown> }]>)[
    index
  ]?.[0];
  if (!call) {
    throw new Error(`Missing video submission ${index}`);
  }
  return call;
}
function submit(response = Response.json({ request_id: "req" })) {
  post.mockResolvedValue({ response, release: vi.fn(async () => {}) });
}
beforeEach(() => submit());
function poll(payload: Record<string, unknown>) {
  fetchMock.mockResolvedValueOnce(Response.json(payload));
}
const video = { url: "https://cdn.x.ai/video.mp4" };
const videoHeaders = { "content-type": "video/mp4" };
function complete() {
  submit();
  poll({ status: "done", video });
  fetchMock.mockResolvedValueOnce(new Response("video-bytes", { headers: videoHeaders }));
}
function asset(name: string, role?: VideoGenerationSourceAsset["role"]) {
  return { url: `https://example.com/${name}`, ...(role ? { role } : {}) };
}
function generate(overrides: Partial<VideoGenerationRequest> = {}) {
  return build().generateVideo({
    provider: "xai",
    model: "grok-imagine-video",
    prompt: "a lobster",
    cfg: {},
    ...overrides,
  });
}
const model15 = "grok-imagine-video-1.5";
const models15 = [model15, `${model15}-preview`, `${model15}-2026-05-30`];

it("releases submission before polling, waits on pending, then downloads", async () => {
  vi.useFakeTimers();
  try {
    const events: string[] = [];
    post.mockResolvedValue({
      response: Response.json({ request_id: "req" }),
      release: async () => {
        events.push("release");
      },
    });
    for (const status of ["pending", "done"]) {
      fetchMock.mockImplementationOnce(async () => {
        events.push(status);
        return Response.json({ status, video });
      });
    }
    fetchMock.mockImplementationOnce(async () => {
      events.push("download");
      return new Response("video-bytes", { headers: videoHeaders });
    });
    const pending = generate({ durationSeconds: 6, aspectRatio: "9:16", resolution: "720P" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events).toEqual(["release", "pending"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      videos: [{ mimeType: "video/mp4" }],
      metadata: { requestId: "req" },
    });
    expect(events).toEqual(["release", "pending", "done", "download"]);
  } finally {
    vi.useRealTimers();
  }
});

it("advertises 1.5 capabilities and preserves aliases, resolution and source aspect ratio", async () => {
  const provider = build();
  const capabilities = {
    imageToVideo: {
      enabled: true,
      maxInputImages: 1,
      maxDurationSeconds: 15,
      resolutions: ["480P", "720P", "1080P"],
    },
    videoToVideo: { enabled: false },
  };
  expect(provider).toMatchObject({
    defaultModel: "grok-imagine-video",
    models: ["grok-imagine-video", model15],
  });
  expect(provider.catalogByModel?.[model15]).toMatchObject({
    modes: ["imageToVideo"],
    capabilities,
  });
  for (const [index, model] of models15.entries()) {
    expect(
      await provider.resolveModelCapabilities?.({ provider: "xai", model, cfg: {} }),
    ).toMatchObject(capabilities);
    complete();
    const result = await generate({
      model,
      durationSeconds: 20,
      resolution: index ? "1080P" : undefined,
      inputImages: [asset("first.png", index ? "first_frame" : undefined)],
    });
    const body = request(index).body;
    expect(body.image).toEqual(asset("first.png"));
    expect(body).toMatchObject({ model, duration: 15, resolution: index ? "1080p" : "480p" });
    expect(body).not.toHaveProperty("aspect_ratio");
    expect(result.model).toBe(model);
  }
});

const error15 = `xAI ${model15}`;
it.each<[Partial<VideoGenerationRequest>, string]>([
  [{ durationSeconds: 0.4 }, "durationSeconds must be a positive duration"],
  [
    { inputImages: [asset("ref.png", "reference_image"), asset("first.png", "first_frame")] },
    "xAI reference-image video generation requires every image role to be reference_image.",
  ],
  [{ model: model15 }, `${error15} requires exactly one first-frame image.`],
  [
    { model: models15[1], inputImages: [asset("ref.png", "reference_image")] },
    `${error15} supports only an ordinary or first_frame image.`,
  ],
  [
    { model: models15[2], inputImages: [asset("first.png"), asset("second.png", "first_frame")] },
    `${error15} requires exactly one first-frame image.`,
  ],
  [
    { model: model15, inputVideos: [asset("input.mp4")] },
    `${error15} does not support video inputs.`,
  ],
])("rejects unsupported input %j before auth and submission", async (input, error) => {
  await expect(generate(input)).rejects.toThrow(error);
  expect(auth).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it("carries configured private-network and dispatcher policy through submit, poll and download", async () => {
  const dispatcherPolicy = { proxyUrl: "http://proxy.example:3128" };
  policy.mockImplementationOnce((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: true,
    headers: new Headers(omitNullRequestHeaders(params.defaultHeaders)),
    dispatcherPolicy: dispatcherPolicy as never,
  }));
  complete();
  await generate({ cfg: createProxyRequestModelProviderConfig("xai") });
  expect(policy.mock.calls[0]?.[0]).not.toHaveProperty("allowPrivateNetwork");
  expect(request()).toMatchObject({ allowPrivateNetwork: true, dispatcherPolicy });
  expect(guarded.mock.calls.map((call) => call[4])).toMatchObject(
    ["xai-video-status", "xai-video-download"].map((auditContext) => ({
      ssrfPolicy: { allowPrivateNetwork: true },
      dispatcherPolicy,
      auditContext,
    })),
  );
});

it("rejects generated video downloads above the configured media cap", async () => {
  poll({ status: "done", video });
  fetchMock.mockResolvedValueOnce(new Response("too-large", { headers: videoHeaders }));
  await expect(
    generate({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
  ).rejects.toThrow("xAI generated video download exceeds 1 bytes");
});
it("bounds an unbounded poll JSON body and cancels the stream", async () => {
  const oversized = oversizedJsonResponse();
  submit(streamedJsonResponse({ request_id: "req_poll_oversized" }));
  fetchMock.mockResolvedValueOnce(oversized.response);
  await expect(generate()).rejects.toThrow(
    "xAI video generation response: JSON response exceeds 16777216 bytes",
  );
  expect(oversized.state.canceled).toBe(true);
  expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
});
it.each(["[]", "<html>Unexpected token < in JSON</html>"])(
  "wraps invalid create body %s",
  async (body) => {
    submit(new Response(body));
    await expect(generate()).rejects.toThrow("xAI video generation response malformed");
  },
);
it.each([
  [{ status: "cancelled" }, "xAI video generation cancelled"],
  [{ status: "done", video: {} }, "xAI video generation response malformed"],
] as const)("rejects terminal poll payload %j", async (payload, error) => {
  poll(payload);
  await expect(generate()).rejects.toThrow(error);
});

it.each<[string, Partial<VideoGenerationRequest>, Record<string, unknown>, string[], string]>([
  [
    "generate",
    { inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }] },
    { image: { url: expect.stringMatching(/^data:image\/png;base64,/u) }, resolution: "480p" },
    ["reference_images", "aspect_ratio"],
    "generations",
  ],
  [
    "referenceToVideo",
    {
      durationSeconds: 12,
      aspectRatio: "9:16",
      resolution: "720P",
      inputImages: [asset("subject.png", "reference_image"), asset("style.png", "reference_image")],
    },
    {
      reference_images: [asset("subject.png"), asset("style.png")],
      duration: 10,
      aspect_ratio: "9:16",
      resolution: "720p",
    },
    ["image"],
    "generations",
  ],
  [
    "extend",
    {
      durationSeconds: 15,
      aspectRatio: "9:16",
      resolution: "1080P",
      inputVideos: [asset("input.mp4")],
    },
    { video: asset("input.mp4"), duration: 10 },
    ["aspect_ratio", "resolution"],
    "extensions",
  ],
])("sends the %s request", async (mode, input, body, absent, endpoint) => {
  complete();
  expect((await generate(input)).metadata?.mode).toBe(mode);
  expect(request().url).toBe(`https://api.x.ai/v1/videos/${endpoint}`);
  for (const [key, value] of Object.entries(body)) {
    expect(request().body[key]).toEqual(value);
  }
  for (const key of absent) {
    expect(request().body).not.toHaveProperty(key);
  }
});
