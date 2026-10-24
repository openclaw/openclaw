import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { streamedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildBytePlusVideoGenerationProvider: typeof import("./video-generation-provider.js").buildBytePlusVideoGenerationProvider;

beforeAll(async () => {
  ({ buildBytePlusVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

beforeEach(() => {
  postJsonRequestMock.mockResolvedValue({
    response: streamedJsonResponse({ id: "task_123" }),
    release: vi.fn(async () => {}),
  });
});
installProviderHttpMockCleanup();
afterEach(() => vi.useRealTimers());

function generateVideo(request: Partial<VideoGenerationRequest> = {}) {
  return buildBytePlusVideoGenerationProvider().generateVideo({
    provider: "byteplus",
    model: "seedance-1-0-pro-250528",
    prompt: "A lantern floats upward into the night sky",
    cfg: {},
    ...request,
  });
}

function taskResponse(overrides: Record<string, unknown> = {}) {
  return streamedJsonResponse({
    id: "task_123",
    status: "succeeded",
    content: { video_url: "https://example.com/byteplus.mp4" },
    model: "seedance-1-0-pro-250528",
    ...overrides,
  });
}

function videoResponse(body: BodyInit, contentType = "video/mp4") {
  return new Response(body, { headers: { "content-type": contentType } });
}

function mockSuccessfulBytePlusTask(
  download = videoResponse("webm-bytes", "video/webm"),
  task: Record<string, unknown> = {},
) {
  fetchWithTimeoutMock.mockResolvedValueOnce(taskResponse(task)).mockResolvedValueOnce(download);
}

function requireBytePlusPostRequest() {
  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "BytePlus video request");
  if (!request.body) {
    throw new Error("expected BytePlus video request body");
  }
  return request;
}

// Advertise twice the shared 16 MiB JSON cap to prove reads stop and cancel mid-stream.
function makeOversizedJsonStream() {
  return oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
}

function expectCanceledBeforeEnd(stream: ReturnType<typeof makeOversizedJsonStream>) {
  expect(stream.wasCanceled()).toBe(true);
  expect(stream.getReadCount()).toBeLessThan(32);
}

describe("byteplus video generation provider", () => {
  it("creates a content-generation task, polls, and downloads the video", async () => {
    mockSuccessfulBytePlusTask();
    const result = await generateVideo();

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expect(requireBytePlusPostRequest().url).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata).toMatchObject({ taskId: "task_123" });
  });

  it("cancels the unread response body when a generated-video MIME type is rejected", async () => {
    const canceled = vi.fn();
    mockSuccessfulBytePlusTask(
      videoResponse(
        new ReadableStream({
          start: (controller) => controller.enqueue(new Uint8Array([1])),
          cancel: canceled,
        }),
        "application/json",
      ),
    );

    await expect(generateVideo()).rejects.toThrow(
      "BytePlus generated video download: malformed video response",
    );
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    mockSuccessfulBytePlusTask(videoResponse("too-large"));

    await expect(
      generateVideo({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("BytePlus generated video download exceeds 1 bytes");
  });

  it("shares one wall-clock deadline across download headers and body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    fetchWithTimeoutMock
      .mockResolvedValueOnce(taskResponse({ model: undefined }))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(1_090);
        return videoResponse(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(new Uint8Array([1]));
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
              });
            },
          }),
        );
      });

    const assertion = expect(generateVideo({ timeoutMs: 100 })).rejects.toThrow(
      "BytePlus generated video download timed out after 100ms",
    );
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it("keeps the unified model for image requests and lowercases resolution", async () => {
    mockSuccessfulBytePlusTask();
    await generateVideo({
      prompt: "Animate this still image",
      resolution: "720P",
      inputImages: [{ url: "https://example.com/first-frame.png" }],
    });

    expect(requireBytePlusPostRequest().body).toEqual({
      model: "seedance-1-0-pro-250528",
      resolution: "720p",
      content: [
        { type: "text", text: "Animate this still image" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/first-frame.png" },
          role: "first_frame",
        },
      ],
    });
  });

  it("maps declared providerOptions into the request body", async () => {
    mockSuccessfulBytePlusTask();
    await generateVideo({ providerOptions: { seed: 42, draft: true, camera_fixed: false } });

    expect(requireBytePlusPostRequest().body).toMatchObject({
      model: "seedance-1-0-pro-250528",
      seed: 42,
      resolution: "480p",
      camera_fixed: false,
    });
  });

  it.each([
    ["seed", { providerOptions: { seed: 1.5 } }],
    ["duration", { durationSeconds: 99 }],
  ] as const)("drops invalid %s values before creating videos", async (field, request) => {
    mockSuccessfulBytePlusTask();
    await generateVideo(request);
    expect(requireBytePlusPostRequest().body).not.toHaveProperty(field);
  });

  it("drops malformed response duration metadata", async () => {
    mockSuccessfulBytePlusTask(videoResponse("mp4-bytes"), {
      duration: 1.5,
      model: undefined,
    });
    const result = await generateVideo();

    expect(result.metadata).toMatchObject({ duration: undefined });
  });

  it.each([
    ["BytePlus video status response missing task status", { status: undefined }],
    [
      "BytePlus video generation completed with malformed content",
      { content: ["https://example.com/byteplus.mp4"] },
    ],
  ] as const)("rejects invalid task responses: %s", async (message, task) => {
    fetchWithTimeoutMock.mockResolvedValueOnce(taskResponse({ ...task, model: undefined }));
    await expect(generateVideo()).rejects.toThrow(message);
  });

  it("bounds the submit task JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: stream.response,
      release,
    });

    await expect(generateVideo()).rejects.toThrow(
      `BytePlus video generation failed: JSON response exceeds ${16 * 1024 * 1024} bytes`,
    );
    expectCanceledBeforeEnd(stream);
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds the poll status JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    fetchWithTimeoutMock.mockResolvedValueOnce(stream.response);

    await expect(generateVideo()).rejects.toThrow(
      `BytePlus video status request failed: JSON response exceeds ${16 * 1024 * 1024} bytes`,
    );
    expectCanceledBeforeEnd(stream);
  });
});
