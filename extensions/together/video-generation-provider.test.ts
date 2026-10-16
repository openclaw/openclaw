import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest as requireFirstPostJsonRequest,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testVideoGenerationDeadlines } from "../test-support/video-generation-deadline.test-support.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildTogetherVideoGenerationProvider: typeof import("./video-generation-provider.js").buildTogetherVideoGenerationProvider;

beforeAll(async () => {
  ({ buildTogetherVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

const requireRecord = createRequireRecord("record", "expected-label-record");
const request = {
  provider: "together",
  model: "Wan-AI/wan2.7-t2v",
  prompt: "A bicycle weaving through a rainy neon street",
  cfg: {},
} satisfies VideoGenerationRequest;
const inputImages = [
  { buffer: Buffer.from("png"), mimeType: "image/png", fileName: "reference.png" },
];

function generateVideo(overrides: Partial<VideoGenerationRequest> = {}) {
  return buildTogetherVideoGenerationProvider().generateVideo({ ...request, ...overrides });
}

function mockSubmission(payload: unknown) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockImplementation(async () => ({
    response: streamedJsonResponse(payload),
    release,
  }));
  return release;
}

function mockVideoDownload(
  response = new Response(Buffer.from("webm-bytes"), {
    headers: { "content-type": "video/webm" },
  }),
) {
  mockSubmission({ id: "video_123", status: "in_progress" });
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      Response.json({
        id: "video_123",
        status: "completed",
        outputs: { video_url: "https://example.com/together.mp4" },
      }),
    )
    .mockResolvedValueOnce(response);
}

describe("together video generation provider", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("expires after 20 minutes of polling when no timeout is supplied", async () => {
    vi.useFakeTimers();
    const release = mockSubmission({ id: "video_pending", status: "in_progress" });
    fetchWithTimeoutMock.mockImplementation(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return Response.json({ id: "video_pending", status: "in_progress" });
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
    expect(buildTogetherVideoGenerationProvider().models).toEqual([
      "Wan-AI/wan2.7-t2v",
      "Wan-AI/wan2.7-i2v",
      "minimax/hailuo-02",
    ]);
  });

  it("creates a video, polls completion, and downloads the output", async () => {
    mockVideoDownload();
    const result = await generateVideo({ model: "" });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(post.url).toBe("https://api.together.xyz/v2/videos");
    const body = requireRecord(post.body, "Together request body");
    expect(body.model).toBe("Wan-AI/wan2.7-t2v");
    expect(body.prompt).toBe("A bicycle weaving through a rainy neon street");
    expect(result.videos).toEqual([expect.objectContaining({ fileName: "video-1.webm" })]);
    expect(result.metadata).toEqual({
      videoId: "video_123",
      status: "completed",
      videoUrl: "https://example.com/together.mp4",
    });
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

  it("uses an actionable fallback when an immediately failed submission omits its error", async () => {
    const release = mockSubmission({ status: "failed", error: null });

    await expect(generateVideo()).rejects.toThrow("Together video generation failed");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("surfaces provider errors from a failed poll and releases the submission", async () => {
    const release = mockSubmission({ id: "video_failed_later", status: "in_progress" });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      Response.json({
        id: "video_failed_later",
        status: "failed",
        error: { message: "Together video content policy blocked this prompt" },
      }),
    );

    await expect(generateVideo()).rejects.toThrow(
      "Together video content policy blocked this prompt",
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("downloads an immediately completed Together submission without polling it again", async () => {
    const release = mockSubmission({
      id: "video_completed",
      model: "Wan-AI/wan2.7-t2v",
      status: "completed",
      outputs: { video_url: "https://example.com/completed.mp4" },
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(Buffer.from("completed-video"), {
        headers: { "content-type": "video/mp4" },
      }),
    );

    const result = await generateVideo();

    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "Wan-AI/wan2.7-t2v",
      metadata: { status: "completed", videoId: "video_completed" },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an immediately completed submission without a generated video URL", async () => {
    const release = mockSubmission({ id: "video_missing_output", status: "completed" });

    await expect(generateVideo()).rejects.toThrow(
      "Together video generation completed without an output URL",
    );
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds an unbounded successful Together create JSON body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse();
    postJsonRequestMock.mockResolvedValue({
      response: oversized.response,
      release: vi.fn(async () => {}),
    });

    await expect(generateVideo()).rejects.toThrow(
      "Together video generation failed: JSON response exceeds 16777216 bytes",
    );
    expect(oversized.state.canceled).toBe(true);
    expect(oversized.state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("bounds downloaded videos before materializing them", async () => {
    const cancel = vi.fn();
    mockVideoDownload(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(32)));
          },
          cancel,
        }),
        { headers: { "content-type": "video/mp4" } },
      ),
    );

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

  it("uses the video API endpoint when the shared Together text base URL is configured", async () => {
    mockVideoDownload();
    await generateVideo({
      cfg: {
        models: {
          providers: { together: { baseUrl: "https://api.together.xyz/v1", models: [] } },
        },
      },
    });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(post.url).toBe("https://api.together.xyz/v2/videos");
  });

  it.each([1, 99])(
    "drops out-of-range Wan duration %s before creating videos",
    async (durationSeconds) => {
      mockVideoDownload();
      await generateVideo({ durationSeconds });

      const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
      expect(requireRecord(post.body, "Together request body")).not.toHaveProperty("seconds");
    },
  );

  it.each([2, 10])("sends supported Wan duration %s as a string", async (durationSeconds) => {
    mockVideoDownload();
    await generateVideo({ durationSeconds });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(requireRecord(post.body, "Together request body").seconds).toBe(String(durationSeconds));
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
    mockVideoDownload();
    await generateVideo({ size });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(post.body).toMatchObject({ resolution, ratio });
    expect(post.body).not.toHaveProperty("width");
    expect(post.body).not.toHaveProperty("height");
  });

  it("rejects unsupported Wan sizes before creating a paid job", async () => {
    await expect(generateVideo({ size: "640x480" })).rejects.toThrow(
      /does not support size 640x480/u,
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("keeps pixel dimensions for Hailuo", async () => {
    mockVideoDownload();
    await generateVideo({ model: "minimax/hailuo-02", size: "1366x768", durationSeconds: 6 });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(post.body).toMatchObject({ width: 1366, height: 768, seconds: "6" });
    expect(post.body).not.toHaveProperty("resolution");
    expect(post.body).not.toHaveProperty("ratio");
  });

  it("rejects reference images for Together text-to-video models before calling the API", async () => {
    await expect(generateVideo({ inputImages })).rejects.toThrow(
      /does not support image reference inputs/u,
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    [inputImages, "data:image/png;base64,cG5n"],
    [[{ url: "https://example.com/reference.png" }], "https://example.com/reference.png"],
  ])(
    "sends a first-frame image for the Together image-to-video model (%j)",
    async (images, inputImage) => {
      mockVideoDownload();
      await generateVideo({ model: "Wan-AI/wan2.7-i2v", inputImages: images });

      const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
      const body = requireRecord(post.body, "Together request body");
      const media = requireRecord(body.media, "Together video media payload");
      expect(body.model).toBe("Wan-AI/wan2.7-i2v");
      expect(media).toEqual({ frame_images: [{ input_image: inputImage, frame: "first" }] });
      expect(body).not.toHaveProperty("reference_images");
    },
  );
});

testVideoGenerationDeadlines({
  providerId: "together",
  model: "Wan-AI/wan2.7-t2v",
  pendingStatus: "in_progress",
  defaultPollingTimeoutMs: 1_200_000,
  loadPlugin: async () => (await import("./index.js")).default,
});
