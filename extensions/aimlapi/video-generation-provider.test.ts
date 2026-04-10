import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAimlapiVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "aimlapi-key" })),
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

describe("AIMLAPI video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("submits an async generation, polls status, and downloads the resulting video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "gen-1",
          status: "queued",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "gen-1",
          status: "completed",
          video: {
            url: "https://cdn.aimlapi.com/out.mp4",
          },
          meta: {
            usage: {
              credits_used: 42,
            },
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildAimlapiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "aimlapi",
      model: "google/veo-3.1-t2v-fast",
      prompt: "animate a friendly lobster",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.aimlapi.com/v2/video/generations",
        body: {
          model: "google/veo-3.1-t2v-fast",
          prompt: "animate a friendly lobster",
        },
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.aimlapi.com/v2/video/generations?generation_id=gen-1",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.model).toBe("google/veo-3.1-t2v-fast");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      generationId: "gen-1",
      taskStatus: "completed",
      creditsUsed: 42,
    });
  });

  it("advertises AIMLAPI-supported text-to-video capabilities for runtime normalization", () => {
    const provider = buildAimlapiVideoGenerationProvider();

    expect(provider.capabilities).toEqual({
      generate: {
        maxVideos: 1,
        maxInputImages: 0,
        maxInputVideos: 0,
        maxDurationSeconds: 8,
        supportedDurationSeconds: [4, 6, 8],
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
      },
    });
  });

  it("fails clearly when the AIMLAPI key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });
    const provider = buildAimlapiVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "aimlapi",
        model: "google/veo-3.1-t2v-fast",
        prompt: "animate a friendly lobster",
        cfg: {},
      }),
    ).rejects.toThrow("AI/ML API key missing");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("fails fast when reference inputs are provided", async () => {
    const provider = buildAimlapiVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "aimlapi",
        model: "google/veo-3.1-t2v-fast",
        prompt: "animate this image",
        cfg: {},
        inputImages: [{ url: "https://example.com/ref.png" }],
      }),
    ).rejects.toThrow("AIMLAPI video generation currently supports text-to-video only.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("forwards AIMLAPI-supported video overrides", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "gen-2",
          status: "completed",
          video: {
            url: "https://cdn.aimlapi.com/out.mp4",
          },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      arrayBuffer: async () => Buffer.from("mp4-bytes"),
      headers: new Headers({ "content-type": "video/mp4" }),
    });

    const provider = buildAimlapiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "aimlapi",
      model: "google/veo-3.1-t2v-fast",
      prompt: "animate a friendly lobster",
      cfg: {},
      aspectRatio: "16:9",
      durationSeconds: 8,
      resolution: "1080P",
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          model: "google/veo-3.1-t2v-fast",
          prompt: "animate a friendly lobster",
          aspect_ratio: "16:9",
          duration: 8,
          resolution: "1080p",
          generate_audio: true,
        },
      }),
    );
  });
});
