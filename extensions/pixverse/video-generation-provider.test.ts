import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, postMultipartRequestMock, fetchWithTimeoutMock } =
  getProviderHttpMocks();
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
function firstRequest<Body>(mock: typeof postJsonRequestMock): Request<Body> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected PixVerse request");
  }
  return call[0] as Request<Body>;
}
const firstPostJsonRequest = () => firstRequest<Record<string, unknown>>(postJsonRequestMock);
const firstMultipartRequest = () => firstRequest<FormData>(postMultipartRequestMock);
function pollFetchHeaders(callIndex: number): Headers | undefined {
  const [, init] = fetchWithTimeoutMock.mock.calls[callIndex] ?? [];
  return (init as { headers?: Headers } | undefined)?.headers;
}
function releasedResponse(response: Response) {
  return { response, release: vi.fn(async () => {}) };
}
function mockPixVerseVideoSubmit(videoId = 123) {
  postJsonRequestMock.mockImplementation(async () =>
    releasedResponse(successfulResponse({ video_id: videoId })),
  );
}
function mockPixVersePoll(result: Record<string, unknown>) {
  fetchWithTimeoutMock.mockResolvedValueOnce(successfulResponse(result));
}
function mockPixVerseVideoTask(result: Record<string, number> = {}) {
  mockPixVerseVideoSubmit();
  mockPixVersePoll({ id: 123, status: 1, url: videoUrl, ...result });
}
function mockImageUpload(img_id: number) {
  postMultipartRequestMock.mockImplementation(async () =>
    releasedResponse(successfulResponse({ img_id })),
  );
}

describe("pixverse video generation provider", () => {
  it("rejects a duration that rounds to zero before submission", async () => {
    await expect(generateVideo({ durationSeconds: 0.4 })).rejects.toThrow(
      "durationSeconds must be a positive duration",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildPixVerseVideoGenerationProvider());
  });

  it("submits text-to-video, polls status, and returns the output URL", async () => {
    mockPixVerseVideoTask({ seed: 42, outputWidth: 960, outputHeight: 540 });

    const result = await generateVideo({
      durationSeconds: 4,
      aspectRatio: "21:9",
      resolution: "720P",
      audio: true,
      providerOptions: { seed: 42, negativePrompt: "blur", cameraMovement: "zoom_in" },
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const createRequest = firstPostJsonRequest();
    expect(createRequest.url).toBe(`${baseUrl}${textEndpoint}`);
    expect(createRequest.body).toEqual({
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
    expect(createRequest.headers?.get("API-KEY")).toBe("provider-key");
    expect(createRequest.headers?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/video/result/123`);
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
  ] as const)("drops malformed request %j / response %j seeds", async (request, response) => {
    mockPixVerseVideoTask(response);
    const result = await generateVideo(request);
    expect(firstPostJsonRequest().body).not.toHaveProperty("seed");
    expect(result.metadata).toEqual({ ...taskMetadata, seed: undefined });
  });

  it.each([
    [{ ErrCode: 0, Resp: { video_id: 123.5 } }, "response missing video_id"],
    [{ ErrCode: 400017, ErrMsg: "Invalid parameter" }, "failed: Invalid parameter"],
  ] as const)("rejects invalid create response %j before polling", async (payload, message) => {
    postJsonRequestMock.mockResolvedValue(releasedResponse(streamedJsonResponse(payload)));
    await expect(generateVideo()).rejects.toThrow(`PixVerse video generation ${message}`);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("bounds an unbounded successful PixVerse create JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue(releasedResponse(oversized.response));

    await expect(generateVideo()).rejects.toThrow(
      "PixVerse video generation failed: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("uploads local image input before submitting image-to-video", async () => {
    mockImageUpload(456);
    mockPixVerseVideoTask();

    await generateVideo({
      model: "c1",
      prompt: "animate the product",
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      durationSeconds: 99,
      providerOptions: { motionMode: "fast", templateId: 302325299692608 },
    });

    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const uploadRequest = firstMultipartRequest();
    expect(uploadRequest.url).toBe(`${baseUrl}/image/upload`);
    expect(uploadRequest.headers?.get("Content-Type")).toBeNull();
    expect(uploadRequest.body?.get("image")).toBeInstanceOf(File);

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const createRequest = firstPostJsonRequest();
    expect(createRequest.url).toBe(`${baseUrl}/video/img/generate`);
    expect(createRequest.body).toEqual({
      duration: 15,
      model: "c1",
      prompt: "animate the product",
      quality: "540p",
      img_id: 456,
      motion_mode: "fast",
      template_id: 302325299692608,
    });
  });

  it("uploads remote image URLs through PixVerse image upload", async () => {
    mockImageUpload(111);
    mockPixVerseVideoTask();

    await generateVideo({ inputImages: [{ url: "https://example.com/input.png" }] });

    const uploadRequest = firstMultipartRequest();
    expect(uploadRequest.body?.get("image_url")).toBe("https://example.com/input.png");
    const createRequest = firstPostJsonRequest();
    expect(createRequest.body?.img_id).toBe(111);
  });

  it.each([
    [6, "PixVerse video generation was deleted before completion"],
    [7, "PixVerse video generation failed content moderation"],
    [8, "PixVerse video generation failed"],
    [undefined, "PixVerse video status response missing status"],
  ] as const)("reports PixVerse poll status %s", async (status, message) => {
    mockPixVerseVideoSubmit(333);
    mockPixVersePoll({ id: 333, status });

    await expect(generateVideo()).rejects.toThrow(message);
  });

  it.each([
    [undefined, "https://app-api.pixverseai.cn/openapi/v2"],
    ["https://proxy.example/openapi/v2", "https://proxy.example/openapi/v2"],
  ])("resolves CN region with baseUrl %s", async (configuredBaseUrl, expectedBaseUrl) => {
    mockPixVerseVideoTask();

    await generateVideo({
      cfg: {
        models: { providers: { pixverse: { baseUrl: configuredBaseUrl, region: "cn" } } },
      } as never,
    });

    expect(firstPostJsonRequest().url).toBe(`${expectedBaseUrl}/video/text/generate`);
    expect(fetchWithTimeoutMock.mock.calls[0]?.[0]).toBe(`${expectedBaseUrl}/video/result/123`);
  });

  it("uses a fresh trace id for each status poll", async () => {
    vi.useFakeTimers();
    try {
      mockPixVerseVideoSubmit();
      mockPixVersePoll({ id: 123, status: 5 });
      mockPixVersePoll({ id: 123, status: 1, url: videoUrl });

      const pending = generateVideo();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      const firstHeaders = pollFetchHeaders(0);
      const secondHeaders = pollFetchHeaders(1);
      expect(firstHeaders?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(secondHeaders?.get("Ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(secondHeaders?.get("Ai-trace-id")).not.toBe(firstHeaders?.get("Ai-trace-id"));
    } finally {
      vi.useRealTimers();
    }
  });
});
