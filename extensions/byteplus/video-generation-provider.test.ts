import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  oversizedJsonResponse,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { streamedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import type { VideoGenerationRequest } from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
const model = "seedance-1-0-pro-250528";
const videoUrl = "https://example.com/byteplus.mp4";
const imageUrl = "https://example.com/first-frame.png";
const downloadLabel = "BytePlus generated video download";

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

const generateVideo = (request: Partial<VideoGenerationRequest> = {}) =>
  buildBytePlusVideoGenerationProvider().generateVideo({
    provider: "byteplus",
    model,
    prompt: "A lantern floats upward into the night sky",
    cfg: {},
    ...request,
  });

const taskResponse = (overrides: Record<string, unknown> = {}) =>
  streamedJsonResponse({
    id: "task_123",
    status: "succeeded",
    content: { video_url: videoUrl },
    model,
    ...overrides,
  });

function videoResponse(body: BodyInit, contentType = "video/mp4") {
  return new Response(body, { headers: { "content-type": contentType } });
}

function completeVideo(
  request: Partial<VideoGenerationRequest> = {},
  download = videoResponse("webm-bytes", "video/webm"),
  task: Record<string, unknown> = {},
) {
  fetchWithTimeoutMock.mockResolvedValueOnce(taskResponse(task)).mockResolvedValueOnce(download);
  return generateVideo(request);
}

const postRequest = () =>
  requireFirstPostJsonRecordRequest(postJsonRequestMock, "BytePlus video request");

it("cancels the unread response body when a generated-video MIME type is rejected", async () => {
  const canceled = vi.fn();
  const result = completeVideo(
    {},
    videoResponse(
      new ReadableStream({
        start: (controller) => controller.enqueue(new Uint8Array([1])),
        cancel: canceled,
      }),
      "application/json",
    ),
  );

  await expect(result).rejects.toThrow(`${downloadLabel}: malformed video response`);
  expect(canceled).toHaveBeenCalledOnce();
});

it("rejects generated video downloads that exceed the configured media cap", async () => {
  await expect(
    completeVideo(
      { cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } },
      videoResponse("too-large"),
    ),
  ).rejects.toThrow(`${downloadLabel} exceeds 1 bytes`);
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
    `${downloadLabel} timed out after 100ms`,
  );
  await vi.advanceTimersByTimeAsync(11);
  await assertion;
});

it("keeps the unified model for image requests and lowercases resolution", async () => {
  await completeVideo({
    prompt: "Animate this still image",
    resolution: "720P",
    inputImages: [{ url: imageUrl }],
  });

  expect(postRequest().body).toEqual({
    model,
    resolution: "720p",
    content: [
      { type: "text", text: "Animate this still image" },
      { type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
    ],
  });
});

it("maps declared providerOptions into the request body", async () => {
  await completeVideo({ providerOptions: { seed: 42, draft: true, camera_fixed: false } });

  expect(postRequest().body).toMatchObject({
    model,
    seed: 42,
    resolution: "480p",
    camera_fixed: false,
  });
});

it.each([
  ["seed", { providerOptions: { seed: 1.5 } }],
  ["duration", { durationSeconds: 99 }],
] as const)("drops invalid %s values before creating videos", async (field, request) => {
  await completeVideo(request);
  expect(postRequest().body).not.toHaveProperty(field);
});

it("submits, polls, and downloads while dropping malformed duration metadata", async () => {
  const result = await completeVideo({}, undefined, { duration: 1.5, model: undefined });
  expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
  expect(postRequest().url).toBe(
    "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks",
  );
  expect(result.videos).toHaveLength(1);
  expect(result.videos[0]?.fileName).toBe("video-1.webm");
  expect(result.metadata).toMatchObject({ taskId: "task_123", duration: undefined });
});

it.each([
  ["BytePlus video status response missing task status", { status: undefined }],
  ["BytePlus video generation completed with malformed content", { content: [videoUrl] }],
] as const)("rejects invalid task responses: %s", async (message, task) => {
  fetchWithTimeoutMock.mockResolvedValueOnce(taskResponse({ ...task, model: undefined }));
  await expect(generateVideo()).rejects.toThrow(message);
});

it.each([
  ["submit", "BytePlus video generation failed"],
  ["poll", "BytePlus video status request failed"],
])("bounds the %s JSON body and cancels an oversized stream", async (stage, label) => {
  // Twice the shared 16 MiB cap proves cancellation before the stream ends.
  const stream = oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
  const release = vi.fn(async () => {});
  if (stage === "submit") {
    postJsonRequestMock.mockResolvedValue({ response: stream.response, release });
  } else {
    fetchWithTimeoutMock.mockResolvedValueOnce(stream.response);
  }
  await expect(generateVideo()).rejects.toThrow(
    `${label}: JSON response exceeds ${16 * 1024 * 1024} bytes`,
  );
  expect(stream.wasCanceled()).toBe(true);
  expect(stream.getReadCount()).toBeLessThan(32);
  if (stage === "submit") {
    expect(release).toHaveBeenCalledOnce();
  }
});
