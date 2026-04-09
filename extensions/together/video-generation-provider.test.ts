import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTogetherVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "together-key" })),
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

describe("together video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("creates a video, polls completion, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video_123",
          status: "in_progress",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "video_123",
          status: "completed",
          outputs: { video_url: "https://example.com/together.mp4" },
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildTogetherVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "together",
      model: "Wan-AI/Wan2.2-T2V-A14B",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.together.xyz/v1/videos",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        videoId: "video_123",
      }),
    );
  });
});
