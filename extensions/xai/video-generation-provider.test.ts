import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "xai-key" })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

describe("xai video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("creates, polls, and downloads a generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_123",
          status: "done",
          video: { url: "https://cdn.x.ai/video.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "A tiny robot crab crossing a moonlit tide pool",
      cfg: {},
      durationSeconds: 6,
      aspectRatio: "16:9",
      resolution: "720P",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/generations",
        body: expect.objectContaining({
          model: "grok-imagine-video",
          prompt: "A tiny robot crab crossing a moonlit tide pool",
          duration: 6,
          aspect_ratio: "16:9",
          resolution: "720p",
        }),
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.x.ai/v1/videos/req_123",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        requestId: "req_123",
        mode: "generate",
      }),
    );
  });

  it("routes video inputs to the extension endpoint when duration is set", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          request_id: "req_extend",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          request_id: "req_extend",
          status: "done",
          video: { url: "https://cdn.x.ai/extended.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("extended-bytes"),
      });

    const provider = buildXaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "xai",
      model: "grok-imagine-video",
      prompt: "Continue the shot into a neon alleyway",
      cfg: {},
      durationSeconds: 8,
      inputVideos: [{ url: "https://example.com/input.mp4" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/videos/extensions",
        body: expect.objectContaining({
          video: { url: "https://example.com/input.mp4" },
          duration: 8,
        }),
      }),
    );
  });
});
