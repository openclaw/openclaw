import { afterEach, describe, expect, it, vi } from "vitest";

const { GoogleGenAIMock, downloadFileMock, generateVideosMock, getVideosOperationMock } =
  vi.hoisted(() => {
    const generateVideosMock = vi.fn();
    const getVideosOperationMock = vi.fn();
    const downloadFileMock = vi.fn();
    const GoogleGenAIMock = vi.fn(function GoogleGenAI() {
      return {
        models: {
          generateVideos: generateVideosMock,
        },
        operations: {
          getVideosOperation: getVideosOperationMock,
        },
        files: {
          download: downloadFileMock,
        },
      };
    });
    return { GoogleGenAIMock, downloadFileMock, generateVideosMock, getVideosOperationMock };
  });

vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAIMock,
}));

import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildGoogleVideoGenerationProvider } from "./video-generation-provider.js";

describe("google video generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    downloadFileMock.mockReset();
    generateVideosMock.mockReset();
    getVideosOperationMock.mockReset();
    GoogleGenAIMock.mockClear();
  });

  it("submits generation and returns inline video bytes", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: false,
      name: "operations/123",
    });
    getVideosOperationMock.mockResolvedValue({
      done: true,
      name: "operations/123",
      response: {
        generatedVideos: [
          {
            video: {
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
              mimeType: "video/mp4",
            },
          },
        ],
      },
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

    expect(generateVideosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "veo-3.1-fast-generate-preview",
        prompt: "A tiny robot watering a windowsill garden",
        config: expect.objectContaining({
          numberOfVideos: 1,
          durationSeconds: 4,
          aspectRatio: "16:9",
          resolution: "720p",
          generateAudio: true,
        }),
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(GoogleGenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "google-key",
        httpOptions: expect.not.objectContaining({
          baseUrl: expect.anything(),
          apiVersion: expect.anything(),
        }),
      }),
    );
  });

  it("rejects mixed image and video inputs", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
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
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [
          {
            video: {
              videoBytes: Buffer.from("mp4-bytes").toString("base64"),
              mimeType: "video/mp4",
            },
          },
        ],
      },
    });

    const provider = buildGoogleVideoGenerationProvider();
    await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
      durationSeconds: 5,
    });

    expect(generateVideosMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          durationSeconds: 6,
        }),
      }),
    );
  });

  it("falls back to REST when the SDK returns a 404 for text-only prompts", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockRejectedValue(new Error(JSON.stringify({ error: { code: 404 } })));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            done: true,
            name: "operations/rest-123",
            response: {
              generateVideoResponse: {
                generatedSamples: [
                  {
                    video: {
                      uri: "https://video.example/rest-123.mp4",
                      mimeType: "video/mp4",
                    },
                  },
                ],
              },
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Uint8Array.from(Buffer.from("rest-video")).buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-lite-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/models/veo-3.1-lite-generate-preview:predictLongRunning",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://video.example/rest-123.mp4");
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer.equals(Buffer.from("rest-video"))).toBe(true);
  });

  it("falls back to REST when the SDK returns an empty result", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockResolvedValue({
      done: true,
      response: {
        generatedVideos: [],
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          done: true,
          name: "operations/rest-456",
          response: {
            generatedVideos: [
              {
                video: {
                  videoBytes: Buffer.from("rest-inline-video").toString("base64"),
                  mimeType: "video/mp4",
                },
              },
            ],
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "google",
      model: "veo-3.1-lite-generate-preview",
      prompt: "A tiny robot watering a windowsill garden",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.buffer.equals(Buffer.from("rest-inline-video"))).toBe(true);
  });

  it("does not fall back to REST when reference inputs are present", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-key",
      source: "env",
      mode: "api-key",
    });
    generateVideosMock.mockRejectedValue(new Error(JSON.stringify({ error: { code: 404 } })));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "google",
        model: "veo-3.1-fast-generate-preview",
        prompt: "Animate this sketch",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("img"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow('{"error":{"code":404}}');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
