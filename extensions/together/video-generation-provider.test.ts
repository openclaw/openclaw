import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest as requireFirstPostJsonRequest,
  streamedJsonResponse,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  model: "Wan-AI/Wan2.2-T2V-A14B",
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

  it("drops out-of-range duration values before creating videos", async () => {
    mockVideoDownload();
    await generateVideo({ durationSeconds: 99 });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    expect(requireRecord(post.body, "Together request body")).not.toHaveProperty("seconds");
  });

  it("rejects reference images for Together text-to-video models before calling the API", async () => {
    await expect(generateVideo({ inputImages })).rejects.toThrow(
      /does not support image reference inputs/u,
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("sends reference images for the Together image-to-video model", async () => {
    mockVideoDownload();
    await generateVideo({ model: "Wan-AI/Wan2.2-I2V-A14B", inputImages });

    const post = requireFirstPostJsonRequest(postJsonRequestMock, "Together request");
    const body = requireRecord(post.body, "Together request body");
    const media = requireRecord(body.media, "Together video media payload");
    expect(body.model).toBe("Wan-AI/Wan2.2-I2V-A14B");
    expect(media.reference_images).toHaveLength(1);
    expect(body).not.toHaveProperty("reference_images");
  });
});

testVideoGenerationDeadlines({
  providerId: "together",
  model: "Wan-AI/Wan2.2-T2V-A14B",
  pendingStatus: "in_progress",
  loadPlugin: async () => (await import("./index.js")).default,
});
