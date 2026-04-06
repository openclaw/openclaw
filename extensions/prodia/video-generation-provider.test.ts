import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProdiaVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "prodia-key" })),
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
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function makeVideoMp4Response(): Response {
  const videoBytes = Buffer.from("fake-mp4-video-bytes");
  return new Response(videoBytes, {
    status: 200,
    headers: { "content-type": "video/mp4" },
  });
}

describe("prodia video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("submits a text-to-video job and returns the video", async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeVideoMp4Response());

    const provider = buildProdiaVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "prodia",
      model: "veo-fast",
      prompt: "a lobster surfing at sunset",
      cfg: {},
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://inference.prodia.com/v2/job",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "inference.veo.fast.txt2vid.v1",
          config: { prompt: "a lobster surfing at sunset" },
        }),
      }),
      300_000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].mimeType).toBe("video/mp4");
    expect(result.model).toBe("veo-fast");
  });

  it("submits an image-to-video job with multipart form data", async () => {
    fetchWithTimeoutMock.mockResolvedValue(makeVideoMp4Response());

    const provider = buildProdiaVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "prodia",
      model: "seedance-lite",
      prompt: "animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://inference.prodia.com/v2/job",
      expect.objectContaining({ method: "POST" }),
      300_000,
      fetch,
    );
    // The body should be FormData for image-to-video.
    const callArgs = fetchWithTimeoutMock.mock.calls[0];
    expect(callArgs[1].body).toBeInstanceOf(FormData);
    expect(result.videos).toHaveLength(1);
    expect(result.model).toBe("seedance-lite");
  });

  it("rejects video reference inputs", async () => {
    const provider = buildProdiaVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "prodia",
        model: "veo-fast",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
      }),
    ).rejects.toThrow("Prodia video generation does not support video reference inputs.");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported text-to-video models", async () => {
    const provider = buildProdiaVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "prodia",
        model: "seedance-lite",
        prompt: "a lobster dancing",
        cfg: {},
      }),
    ).rejects.toThrow('Prodia text-to-video does not support model "seedance-lite"');
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });
    const provider = buildProdiaVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "prodia",
        model: "veo-fast",
        prompt: "test",
        cfg: {},
      }),
    ).rejects.toThrow("Prodia API key missing");
  });
});
