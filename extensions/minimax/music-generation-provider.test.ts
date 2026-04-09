import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "minimax-key" })),
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

describe("minimax music generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("creates music and downloads the generated track", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          task_id: "task-123",
          audio_url: "https://example.com/out.mp3",
          lyrics: "our city wakes",
          base_resp: { status_code: 0 },
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValue({
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => Buffer.from("mp3-bytes"),
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "minimax",
      model: "music-2.5+",
      prompt: "upbeat dance-pop with female vocals",
      cfg: {},
      lyrics: "our city wakes",
      durationSeconds: 45,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.minimax.io/v1/music_generation",
        body: expect.objectContaining({
          model: "music-2.5+",
          lyrics: "our city wakes",
          output_format: "url",
        }),
      }),
    );
    expect(result.tracks).toHaveLength(1);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        taskId: "task-123",
        audioUrl: "https://example.com/out.mp3",
      }),
    );
  });

  it("rejects instrumental requests that also include lyrics", async () => {
    const provider = buildMinimaxMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        provider: "minimax",
        model: "music-2.5+",
        prompt: "driving techno",
        cfg: {},
        instrumental: true,
        lyrics: "do not sing this",
      }),
    ).rejects.toThrow("cannot use lyrics when instrumental=true");
  });
});
