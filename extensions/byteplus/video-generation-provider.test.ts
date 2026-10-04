import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
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

function mockSuccessfulBytePlusTask(params?: { download?: Response }) {
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_123",
        status: "succeeded",
        content: { video_url: "https://example.com/byteplus.mp4" },
        model: "seedance-1-0-pro-250528",
      }),
    )
    .mockResolvedValueOnce(
      params?.download ?? new Response("webm-bytes", { headers: { "content-type": "video/webm" } }),
    );
}

function requireBytePlusPostRequest(): { body?: Record<string, unknown>; url?: string } {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected BytePlus video request");
  }
  const [request] = call;
  if (!request) {
    throw new Error("expected BytePlus video request");
  }
  if (typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected BytePlus video request options");
  }
  return request as { body?: Record<string, unknown>; url?: string };
}

function requireBytePlusPostBody(): Record<string, unknown> {
  const request = requireBytePlusPostRequest();
  if (!request.body) {
    throw new Error("expected BytePlus video request body");
  }
  return request.body;
}

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

// Advertise twice the shared 16 MiB JSON cap to prove reads stop and cancel mid-stream.
function makeOversizedJsonStream() {
  const maxBytes = 16 * 1024 * 1024;
  const chunk = new Uint8Array(1024 * 1024);
  const totalBytes = maxBytes * 2;
  const state = { bytesPulled: 0, canceled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.bytesPulled >= totalBytes) {
        controller.close();
        return;
      }
      state.bytesPulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.canceled = true;
    },
  });
  return { body, maxBytes, totalBytes, state };
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
    mockSuccessfulBytePlusTask({
      download: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
          },
          cancel: canceled,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    });

    await expect(generateVideo()).rejects.toThrow(
      "BytePlus generated video download: malformed video response",
    );
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    mockSuccessfulBytePlusTask({ download: streamedVideoResponse("too-large") });

    await expect(
      generateVideo({ cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } } }),
    ).rejects.toThrow("BytePlus generated video download exceeds 1 bytes");
  });

  it("shares one wall-clock deadline across download headers and body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_123",
          status: "succeeded",
          content: { video_url: "https://example.com/slow.mp4" },
        }),
      )
      .mockImplementationOnce(async () => {
        vi.setSystemTime(1_090);
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(new Uint8Array([1]));
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 20);
              });
            },
          }),
          { headers: { "content-type": "video/mp4" } },
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

    expect(requireBytePlusPostBody()).toEqual({
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

    expect(requireBytePlusPostBody()).toMatchObject({
      model: "seedance-1-0-pro-250528",
      seed: 42,
      resolution: "480p",
      camera_fixed: false,
    });
  });

  it("drops malformed seed values before creating videos", async () => {
    mockSuccessfulBytePlusTask();
    await generateVideo({ providerOptions: { seed: 1.5 } });

    expect(requireBytePlusPostBody()).not.toHaveProperty("seed");
  });

  it("drops out-of-range duration values before creating videos", async () => {
    mockSuccessfulBytePlusTask();
    await generateVideo({ durationSeconds: 99 });

    expect(requireBytePlusPostBody()).not.toHaveProperty("duration");
  });

  it("drops malformed response duration metadata", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task_123",
          status: "succeeded",
          content: { video_url: "https://example.com/byteplus.mp4" },
          duration: 1.5,
        }),
      )
      .mockResolvedValueOnce(streamedVideoResponse("mp4-bytes"));
    const result = await generateVideo();

    expect(result.metadata).toMatchObject({ duration: undefined });
  });

  it("rejects status responses missing a task status", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_123",
        content: { video_url: "https://example.com/byteplus.mp4" },
      }),
    );

    await expect(generateVideo()).rejects.toThrow(
      "BytePlus video status response missing task status",
    );
  });

  it("rejects malformed completed content", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task_123",
        status: "succeeded",
        content: ["https://example.com/byteplus.mp4"],
      }),
    );

    await expect(generateVideo()).rejects.toThrow(
      "BytePlus video generation completed with malformed content",
    );
  });

  it("bounds the submit task JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    await expect(generateVideo()).rejects.toThrow(
      `BytePlus video generation failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds the poll status JSON body and cancels an oversized stream", async () => {
    const stream = makeOversizedJsonStream();
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(stream.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(generateVideo()).rejects.toThrow(
      `BytePlus video status request failed: JSON response exceeds ${stream.maxBytes} bytes`,
    );
    expect(stream.state.canceled).toBe(true);
    expect(stream.state.bytesPulled).toBeLessThan(stream.totalBytes);
  });
});
