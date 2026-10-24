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
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testVideoGenerationDeadlines } from "../test-support/video-generation-deadline.test-support.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
let provider: VideoGenerationProvider;
beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  provider = requireRegisteredProvider(
    capturePluginRegistration(plugin).videoGenerationProviders,
    "together",
  );
});
installProviderHttpMockCleanup();

const videoUrl = "https://example.com/together.mp4";
const apiUrl = "https://api.together.xyz/v2/videos";
const model = "Wan-AI/wan2.7-t2v";
const imageModel = "Wan-AI/wan2.7-i2v";
const request = {
  provider: "together",
  model,
  prompt: "A bicycle weaving through a rainy neon street",
  cfg: {},
} satisfies VideoGenerationRequest;
const expectedBody = { model, prompt: request.prompt };
const inputImages = [
  { buffer: Buffer.from("png"), mimeType: "image/png", fileName: "reference.png" },
];

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return provider.generateVideo({ ...request, ...overrides });
}

function mockSubmission(payload: unknown, response?: Response) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockImplementation(async () => ({
    response: response ?? streamedJsonResponse(payload),
    release,
  }));
  return release;
}

function videoResponse(body: BodyInit = Buffer.from("webm-bytes"), type = "webm") {
  return new Response(body, { headers: { "content-type": `video/${type}` } });
}

function mockPoll(payload: unknown) {
  fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
}

function mockVideoDownload(response = videoResponse()) {
  mockSubmission({ id: "video_123", status: "in_progress" });
  mockPoll({ id: "video_123", status: "completed", outputs: { video_url: videoUrl } });
  fetchWithTimeoutMock.mockResolvedValueOnce(response);
}

function submittedRequest() {
  return requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
}

async function generateBody(overrides: Partial<VideoGenerationRequest>) {
  mockVideoDownload();
  await generateVideo(overrides);
  return submittedRequest().body;
}

describe("together video generation provider", () => {
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
    let error: unknown;
    void generateVideo().catch((caught: unknown) => {
      error = caught;
    });
    await vi.advanceTimersByTimeAsync(1_199_999);
    expect(error).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    // Let the shared transport settle its bounded retry after the deadline.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(error).toMatchObject({
      message: "Together video generation task video_pending timed out after 1200000ms",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses Together's canonical video model ids", () => {
    expect(provider.models).toEqual([model, imageModel, "minimax/hailuo-02"]);
  });

  it("creates, polls, and downloads a video", async () => {
    mockVideoDownload();
    const result = await generateVideo({ model: "" });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(submittedRequest()).toMatchObject({ url: apiUrl, body: expectedBody });
    expect(result.videos).toEqual([expect.objectContaining({ fileName: "video-1.webm" })]);
    expect(result.metadata).toEqual({ videoId: "video_123", status: "completed", videoUrl });
  });

  it("surfaces an immediately failed submission before polling or validating id", async () => {
    const release = mockSubmission({
      status: "failed",
      error: { message: "Together video quota exhausted" },
    });

    await expect(generateVideo()).rejects.toThrow("Together video quota exhausted");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
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
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { video_url: "https://example.com/completed.mp4" },
    { url: "https://example.com/completed.mp4" },
    {
      video_url: " https://example.com/completed.mp4 ",
      url: "https://example.com/secondary.mp4",
    },
    [
      { video_url: " ", url: " " },
      { url: "https://example.com/completed.mp4" },
      { video_url: "https://example.com/secondary.mp4" },
    ],
  ])("downloads completed output %j without polling", async (outputs) => {
    const release = mockSubmission({
      id: "video_completed",
      model,
      status: "completed",
      outputs,
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(videoResponse("completed-video", "mp4"));
    const result = await generateVideo();
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model,
      metadata: {
        status: "completed",
        videoId: "video_completed",
        videoUrl: "https://example.com/completed.mp4",
      },
    });
    expect(release).toHaveBeenCalledOnce();
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
    mockVideoDownload(
      new Response('{"error":"denied"}', { headers: { "content-type": "application/json" } }),
    );

    await expect(generateVideo()).rejects.toThrow(
      "Together generated video download: malformed video response",
    );
  });

  it("replaces the shared text endpoint with the video endpoint", async () => {
    await generateBody({
      cfg: {
        models: { providers: { together: { baseUrl: "https://api.together.xyz/v1", models: [] } } },
      },
    });
    expect(submittedRequest().url).toBe(apiUrl);
  });

  it.each([1, 99, 2, 10])("validates Wan duration %s", async (durationSeconds) => {
    const body = await generateBody({ durationSeconds });
    if (durationSeconds === 1 || durationSeconds === 99) {
      expect(body).not.toHaveProperty("seconds");
    } else {
      expect(body).toHaveProperty("seconds", String(durationSeconds));
    }
  });

  it.each([
    ["1280x720", "720P", "16:9"],
    ["1920x1080", "1080P", "16:9"],
    ["720x1280", "720P", "9:16"],
    ["1080x1920", "1080P", "9:16"],
    ["960x960", "720P", "1:1"],
    ["1440x1440", "1080P", "1:1"],
    ["1104x832", "720P", "4:3"],
    ["1648x1248", "1080P", "4:3"],
    ["832x1104", "720P", "3:4"],
    ["1248x1648", "1080P", "3:4"],
  ])("translates Wan size %s to resolution and ratio", async (size, resolution, ratio) => {
    const body = await generateBody({ size });
    expect(body).toEqual({ ...expectedBody, resolution, ratio });
  });

  it.each([
    [{ size: "640x480" }, /does not support size 640x480/u],
    [{ inputImages }, /does not support image reference inputs/u],
  ])("rejects unsupported inputs before creating a paid job: %j", async (input, error) => {
    await expect(generateVideo(input)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("keeps pixel dimensions for Hailuo", async () => {
    const id = "minimax/hailuo-02";
    const body = await generateBody({ model: id, size: "1366x768", durationSeconds: 6 });
    expect(body).toEqual({ ...expectedBody, model: id, width: 1366, height: 768, seconds: "6" });
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
});

testVideoGenerationDeadlines({
  providerId: "together",
  model,
  pendingStatus: "in_progress",
  defaultPollingTimeoutMs: 1_200_000,
  loadPlugin: async () => (await import("./index.js")).default,
});
