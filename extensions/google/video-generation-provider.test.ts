import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutGuardedMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "google-key",
    source: "env",
    mode: "api-key",
  })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
    requestConfig: {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
      headers: Object.fromEntries(new Headers(params.defaultHeaders).entries()),
      capability: params.capability ?? "other",
      transport: params.transport ?? "http",
      provider: params.provider ?? "",
      api: params.api ?? undefined,
    },
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: vi.fn(async () => {}),
  fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

describe("google video generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutGuardedMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("submits predictLongRunning and downloads the generated video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          name: "operations/123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://files.example.com/video.mp4",
                    },
                  },
                ],
              },
            },
          }),
        },
        finalUrl: "https://generativelanguage.googleapis.com/v1beta/operations/123",
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("mp4-bytes"),
        },
        finalUrl: "https://files.example.com/video.mp4",
        release: vi.fn(async () => {}),
      });

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      aspectRatio: "16:9",
      resolution: "720P",
      durationSeconds: 3,
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning",
        body: expect.objectContaining({
          instances: [
            expect.objectContaining({
              prompt: "A tiny robot watering a windowsill garden",
            }),
          ],
          parameters: expect.objectContaining({
            numberOfVideos: 1,
            durationSeconds: "4",
            aspectRatio: "16:9",
            resolution: "720p",
          }),
        }),
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      1,
      "https://generativelanguage.googleapis.com/v1beta/operations/123",
      expect.objectContaining({ method: "GET" }),
      180000,
      fetch,
      expect.anything(),
    );
  });

  it("rejects mixed image and video inputs", async () => {
    const provider = buildGoogleVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "google",
        model: "veo-3.1-fast-generate-preview",
        prompt: "Animate",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("vid"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("Google video generation does not support image and video inputs together.");
  });

  it("rounds unsupported durations to the nearest Veo value", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          name: "operations/123",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://files.example.com/video.mp4",
                    },
                  },
                ],
              },
            },
          }),
        },
        finalUrl: "https://generativelanguage.googleapis.com/v1beta/operations/123",
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("mp4-bytes"),
        },
        finalUrl: "https://files.example.com/video.mp4",
        release: vi.fn(async () => {}),
      });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 5,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          parameters: expect.objectContaining({
            durationSeconds: "6",
          }),
        }),
      }),
    );
  });
});
