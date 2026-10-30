import assert from "node:assert/strict";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRequest,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock: post,
  postMultipartRequestMock: upload,
  fetchWithTimeoutMock: poll,
} = getProviderHttpMocks();
const baseUrl = "https://app-api.pixverse.ai/openapi/v2";
const videoUrl = "https://media.pixverse.ai/out.mp4";
const textEndpoint = "/video/text/generate";
const taskMetadata = { endpoint: textEndpoint, videoId: 123, status: 1, size: undefined };
let buildPixVerseVideoGenerationProvider: typeof import("./video-generation-provider.js").buildPixVerseVideoGenerationProvider;
beforeAll(async () => {
  ({ buildPixVerseVideoGenerationProvider } = await import("./video-generation-provider.js"));
});
installProviderHttpMockCleanup();

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return buildPixVerseVideoGenerationProvider().generateVideo({
    provider: "pixverse",
    model: "pixverse/v6",
    prompt: "a tiny lobster DJ under neon lights",
    cfg: {},
    ...overrides,
  });
}
function successfulResponse(Resp: unknown) {
  return streamedJsonResponse({ ErrCode: 0, ErrMsg: "success", Resp });
}
type Request<Body> = { url?: string; body?: Body; headers?: Headers };
function request<Body = Record<string, unknown>>(mock = post): Request<Body> {
  return requireFirstPostJsonRequest(mock, "PixVerse request") as Request<Body>;
}
function pollHeaders(index: number): Headers | undefined {
  return (poll.mock.calls[index]?.[1] as { headers?: Headers } | undefined)?.headers;
}
function releasedResponse(response: Response) {
  return { response, release: vi.fn(async () => {}) };
}
function mockTask(result: Record<string, unknown> = {}, videoId = 123) {
  const submitted = releasedResponse(successfulResponse({ video_id: videoId }));
  post.mockResolvedValue(submitted);
  poll.mockResolvedValueOnce(
    successfulResponse({ id: videoId, status: 1, url: videoUrl, ...result }),
  );
  return submitted.release;
}

describe("pixverse video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildPixVerseVideoGenerationProvider());
  });

  it("submits text-to-video, releases before polling, and returns the output URL", async () => {
    const release = mockTask({ seed: 42, outputWidth: 960, outputHeight: 540 });
    const result = await generateVideo({
      durationSeconds: 4,
      aspectRatio: "21:9",
      resolution: "720P",
      audio: true,
      providerOptions: { seed: 42, negativePrompt: "blur", cameraMovement: "zoom_in" },
    });
    const created = request();
    expect(created.url).toBe(`${baseUrl}${textEndpoint}`);
    expect(created.body).toEqual({
      duration: 4,
      model: "v6",
      prompt: "a tiny lobster DJ under neon lights",
      quality: "720p",
      aspect_ratio: "21:9",
      negative_prompt: "blur",
      camera_movement: "zoom_in",
      seed: 42,
      generate_audio_switch: true,
    });
    expect(created.headers?.get("API-KEY")).toBe("provider-key");
    expect(created.headers?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(post).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    const [releasedAt] = release.mock.invocationCallOrder;
    const [polledAt] = poll.mock.invocationCallOrder;
    assert(releasedAt !== undefined && polledAt !== undefined);
    expect(releasedAt).toBeLessThan(polledAt);
    expect(poll.mock.calls[0]?.[0]).toBe(`${baseUrl}/video/result/123`);
    expect(result).toEqual({
      videos: [
        {
          url: videoUrl,
          mimeType: "video/mp4",
          fileName: "video-1.mp4",
          metadata: { sourceUrl: videoUrl, outputWidth: 960, outputHeight: 540 },
        },
      ],
      model: "v6",
      metadata: { ...taskMetadata, seed: 42 },
    });
  });

  it.each([
    [{ providerOptions: { seed: 1.5 } }, {}],
    [{}, { seed: 1.5 }],
  ] as const)("drops malformed request %j / response %j seeds", async (input, response) => {
    mockTask(response);
    const result = await generateVideo(input);
    expect(request().body).not.toHaveProperty("seed");
    expect(result.metadata).toEqual({ ...taskMetadata, seed: undefined });
  });

  it.each([
    [{ ErrCode: 0, Resp: { video_id: 123.5 } }, "response missing video_id"],
    [{ ErrCode: 400017, ErrMsg: "Invalid parameter" }, "failed: Invalid parameter"],
  ] as const)("rejects invalid create response %j before polling", async (payload, message) => {
    post.mockResolvedValue(releasedResponse(streamedJsonResponse(payload)));
    await expect(generateVideo()).rejects.toThrow(`PixVerse video generation ${message}`);
    expect(poll).not.toHaveBeenCalled();
  });

  it("bounds oversized create JSON and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    post.mockResolvedValue(releasedResponse(oversized.response));
    await expect(generateVideo()).rejects.toThrow(
      "PixVerse video generation failed: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(poll).not.toHaveBeenCalled();
  });

  it.each([false, true])("uploads image input (remote: %s) before submission", async (remote) => {
    upload.mockResolvedValue(releasedResponse(successfulResponse({ img_id: 456 })));
    mockTask();
    const inputImages = remote
      ? [{ url: "https://example.com/input.png" }]
      : [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }];
    await generateVideo(
      remote
        ? { inputImages }
        : {
            model: "c1",
            prompt: "animate the product",
            inputImages,
            durationSeconds: 99,
            providerOptions: { motionMode: "fast", templateId: 302325299692608 },
          },
    );
    expect(upload).toHaveBeenCalledOnce();
    const uploaded = request<FormData>(upload);
    expect(uploaded.url).toBe(`${baseUrl}/image/upload`);
    expect(uploaded.headers?.get("Content-Type")).toBeNull();
    if (remote) {
      expect(uploaded.body?.get("image_url")).toBe("https://example.com/input.png");
      expect(request().body?.img_id).toBe(456);
    } else {
      expect(uploaded.body?.get("image")).toBeInstanceOf(File);
      expect(post).toHaveBeenCalledOnce();
      expect(request().url).toBe(`${baseUrl}/video/img/generate`);
      expect(request().body).toEqual({
        duration: 15,
        model: "c1",
        prompt: "animate the product",
        quality: "540p",
        img_id: 456,
        motion_mode: "fast",
        template_id: 302325299692608,
      });
    }
  });

  it.each([
    [6, "PixVerse video generation was deleted before completion"],
    [7, "PixVerse video generation failed content moderation"],
    [8, "PixVerse video generation failed"],
    [undefined, "PixVerse video status response missing status"],
  ] as const)("reports PixVerse poll status %s", async (status, message) => {
    mockTask({ status }, 333);
    await expect(generateVideo()).rejects.toThrow(message);
  });

  it.each([
    [undefined, "https://app-api.pixverseai.cn/openapi/v2"],
    ["https://proxy.example/openapi/v2", "https://proxy.example/openapi/v2"],
  ])("resolves CN region with baseUrl %s", async (configuredBaseUrl, expectedBaseUrl) => {
    mockTask();
    await generateVideo({
      cfg: {
        models: { providers: { pixverse: { baseUrl: configuredBaseUrl, region: "cn" } } },
      } as never,
    });
    expect(request().url).toBe(`${expectedBaseUrl}/video/text/generate`);
    expect(poll.mock.calls[0]?.[0]).toBe(`${expectedBaseUrl}/video/result/123`);
  });

  it("uses a fresh trace id for each status poll", async () => {
    vi.useFakeTimers();
    try {
      mockTask({ status: 5 });
      poll.mockResolvedValueOnce(successfulResponse({ id: 123, status: 1, url: videoUrl }));
      const pending = generateVideo();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      const first = pollHeaders(0)?.get("Ai-trace-id");
      const second = pollHeaders(1)?.get("Ai-trace-id");
      expect(first).toMatch(/^[0-9a-f-]{36}$/u);
      expect(second).toMatch(/^[0-9a-f-]{36}$/u);
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
