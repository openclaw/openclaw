import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest as requireFirstPostJsonRequest,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, expect, it, vi } from "vitest";
import { testVideoGenerationDeadlines } from "../test-support/video-generation-deadline.test-support.js";
import plugin from "./index.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
const provider = requireRegisteredProvider(
  capturePluginRegistration(plugin).videoGenerationProviders,
  "together",
);
installProviderHttpMockCleanup();

const videoUrl = "https://example.com/together.mp4";
const model = "Wan-AI/wan2.7-t2v";
const imageModel = "Wan-AI/wan2.7-i2v";
const request: VideoGenerationRequest = { provider: "together", model, prompt: "Rain", cfg: {} };
const expectedBody = { model, prompt: request.prompt };
const inputImages = [{ buffer: Buffer.from("png"), mimeType: "image/png" }];

const generateVideo = (overrides: Partial<VideoGenerationRequest> = {}) =>
  provider.generateVideo({ ...request, ...overrides });

function mockSubmission(payload: unknown, response?: Response) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValue({
    response: response ?? streamedJsonResponse(payload),
    release,
  });
  return release;
}

function videoResponse(body: BodyInit = Buffer.from("webm-bytes"), type = "webm") {
  return new Response(body, { headers: { "content-type": `video/${type}` } });
}

const mockPoll = (payload: unknown) =>
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));

function mockVideoDownload(response = videoResponse()) {
  mockSubmission({ id: "video_123", status: "in_progress" });
  mockPoll({ id: "video_123", status: "completed", outputs: { video_url: videoUrl } });
  fetchWithTimeoutMock.mockResolvedValueOnce(response);
}

const submittedRequest = () => requireFirstPostJsonRequest(postJsonRequestMock, "Together request");

async function generateBody(overrides: Partial<VideoGenerationRequest>) {
  mockVideoDownload();
  await generateVideo(overrides);
  return submittedRequest().body;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("expires after 20 minutes by default", async () => {
  vi.useFakeTimers();
  const pending = { id: "video_pending", status: "in_progress" };
  const release = mockSubmission(pending);
  fetchWithTimeoutMock.mockImplementation(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
    return Response.json(pending);
  });
  const failed = vi.fn();
  void generateVideo().catch(failed);
  await vi.advanceTimersByTimeAsync(1_199_999);
  expect(failed).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  // Let the shared transport settle its bounded retry after the deadline.
  await vi.advanceTimersByTimeAsync(1_001);
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: "Together video generation task video_pending timed out after 1200000ms",
    }),
  );
  expect(release).toHaveBeenCalledOnce();
});

it("creates, polls, and downloads a video", async () => {
  mockVideoDownload();
  const result = await generateVideo({
    model: "",
    cfg: {
      models: { providers: { together: { baseUrl: "https://api.together.xyz/v1", models: [] } } },
    },
  });
  expect(submittedRequest()).toMatchObject({
    url: "https://api.together.xyz/v2/videos",
    body: expectedBody,
  });
  expect(result.videos).toEqual([expect.objectContaining({ fileName: "video-1.webm" })]);
  expect(result.metadata).toEqual({ videoId: "video_123", status: "completed", videoUrl });
});

it.each([
  [{ status: "failed", error: { message: "quota exhausted" } }, "quota exhausted"],
  [{ status: "failed", error: null }, "Together video generation failed"],
  [
    { id: "video_missing_output", status: "completed" },
    "Together video generation completed without an output URL",
  ],
])("rejects an immediate submission error: %j", async (payload, message) => {
  const release = mockSubmission(payload);
  await expect(generateVideo()).rejects.toThrow(message);
  expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("surfaces failed poll errors and releases the submission", async () => {
  const release = mockSubmission({ id: "video_failed_later", status: "in_progress" });
  const message = "Together video content policy blocked this prompt";
  mockPoll({ id: "video_failed_later", status: "failed", error: { message } });
  await expect(generateVideo()).rejects.toThrow(message);
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  { video_url: ` ${videoUrl} `, url: "https://e.test/other" },
  [{ video_url: " ", url: " " }, { url: videoUrl }, { video_url: "https://e.test/other" }],
])("downloads completed output %j without polling", async (outputs) => {
  mockSubmission({ id: "video_completed", model, status: "completed", outputs });
  fetchWithTimeoutMock.mockResolvedValueOnce(videoResponse("completed-video", "mp4"));
  const result = await generateVideo();
  expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
  expect(result.model).toBe(model);
  expect(result.metadata?.videoUrl).toBe(videoUrl);
});

it("bounds the create JSON body and cancels the stream", async () => {
  const oversized = oversizedJsonResponse();
  mockSubmission(undefined, oversized.response);
  await expect(generateVideo()).rejects.toThrow(
    "Together video generation failed: JSON response exceeds 16777216 bytes",
  );
  expect(oversized.state.canceled).toBe(true);
  expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
});

it("bounds downloaded videos before materializing them", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(32)));
    },
    cancel,
  });
  mockVideoDownload(videoResponse(stream, "mp4"));
  await expect(
    generateVideo({ cfg: { agents: { defaults: { mediaMaxMb: 0.00001 } } } }),
  ).rejects.toThrow("Together generated video download exceeds");
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects a successful JSON error response as generated video", async () => {
  mockVideoDownload(Response.json({ error: "denied" }));
  await expect(generateVideo()).rejects.toThrow(
    "Together generated video download: malformed video response",
  );
});

it.each<[Partial<VideoGenerationRequest>, Record<string, unknown>]>([
  [{ durationSeconds: 1 }, {}],
  [{ durationSeconds: 99 }, {}],
  [{ durationSeconds: 2 }, { seconds: "2" }],
  [{ durationSeconds: 10 }, { seconds: "10" }],
  [{ size: "1280x720" }, { resolution: "720P", ratio: "16:9" }],
  [{ size: "1080x1920" }, { resolution: "1080P", ratio: "9:16" }],
  [
    { model: "minimax/hailuo-02", size: "1366x768", durationSeconds: 6 },
    { model: "minimax/hailuo-02", width: 1366, height: 768, seconds: "6" },
  ],
])("translates request %j", async (input, expected) => {
  expect(await generateBody(input)).toEqual({ ...expectedBody, ...expected });
});

it.each([
  [{ size: "640x480" }, /does not support size 640x480/u],
  [{ inputImages }, /does not support image reference inputs/u],
])("rejects unsupported inputs before creating a paid job: %j", async (input, error) => {
  await expect(generateVideo(input)).rejects.toThrow(error);
  expect(postJsonRequestMock).not.toHaveBeenCalled();
});

it.each([
  [inputImages, "data:image/png;base64,cG5n"],
  [[{ url: "https://example.com/reference.png" }], "https://example.com/reference.png"],
])("sends a first-frame image (%j)", async (images, inputImage) => {
  expect(await generateBody({ model: imageModel, inputImages: images })).toEqual({
    ...expectedBody,
    model: imageModel,
    media: { frame_images: [{ input_image: inputImage, frame: "first" }] },
  });
});

testVideoGenerationDeadlines({
  providerId: "together",
  model,
  pendingStatus: "in_progress",
  defaultPollingTimeoutMs: 1_200_000,
  loadPlugin: async () => plugin,
});
