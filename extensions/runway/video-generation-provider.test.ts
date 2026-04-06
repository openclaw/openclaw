import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "runway-key" })),
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

describe("runway video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("submits a text-to-video task, polls it, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "task-1",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task-1",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a tiny lobster DJ under neon lights",
      cfg: {},
      durationSeconds: 4,
      aspectRatio: "16:9",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.dev.runwayml.com/v1/text_to_video",
        body: {
          model: "gen4.5",
          promptText: "a tiny lobster DJ under neon lights",
          ratio: "1280:720",
          duration: 4,
        },
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://api.dev.runwayml.com/v1/tasks/task-1",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task-1",
        status: "SUCCEEDED",
        endpoint: "/v1/text_to_video",
      }),
    );
  });

  it("accepts local image buffers by converting them into data URIs", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ id: "task-2" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task-2",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    await provider.generateVideo({
      provider: "runway",
      model: "gen4_turbo",
      prompt: "animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
      durationSeconds: 6,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.dev.runwayml.com/v1/image_to_video",
        body: expect.objectContaining({
          promptImage: expect.stringMatching(/^data:image\/png;base64,/u),
          ratio: "960:960",
          duration: 6,
        }),
      }),
    );
  });

  it("requires gen4_aleph for video-to-video", async () => {
    const provider = buildRunwayVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
      }),
    ).rejects.toThrow("Runway video-to-video currently requires model gen4_aleph.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
