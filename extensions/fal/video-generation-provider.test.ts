import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _setFalVideoFetchGuardForTesting,
  buildFalVideoGenerationProvider,
} from "./video-generation-provider.js";

function createMockRequestConfig() {
  return {} as ReturnType<typeof providerHttp.resolveProviderHttpRequestConfig>["requestConfig"];
}
describe("fal video generation provider", () => {
  const fetchGuardMock = vi.fn();

  afterEach(() => {
    vi.restoreAllMocks();
    fetchGuardMock.mockReset();
    _setFalVideoFetchGuardForTesting(null);
  });

  it("submits fal video jobs through the queue API and downloads the completed result", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-key",
      source: "env",
      mode: "api-key",
    });
    vi.spyOn(providerHttp, "resolveProviderHttpRequestConfig").mockReturnValue({
      baseUrl: "https://fal.run",
      allowPrivateNetwork: false,
      headers: new Headers({
        Authorization: "Key fal-key",
        "Content-Type": "application/json",
      }),
      dispatcherPolicy: undefined,
      requestConfig: createMockRequestConfig(),
    });
    vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);
    _setFalVideoFetchGuardForTesting(fetchGuardMock as never);
    fetchGuardMock
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            request_id: "req-123",
            status_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
            response_url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          json: async () => ({
            status: "COMPLETED",
            response: {
              video: { url: "https://fal.run/files/video.mp4" },
            },
          }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("mp4-bytes"),
        },
        release: vi.fn(async () => {}),
      });

    const provider = buildFalVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "fal",
      model: "fal-ai/minimax/video-01-live",
      prompt: "A spaceship emerges from the clouds",
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "720P",
      cfg: {},
    });

    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/video-01-live",
      }),
    );
    const submitBody = JSON.parse(
      String(fetchGuardMock.mock.calls[0]?.[0]?.init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(submitBody).toEqual({
      prompt: "A spaceship emerges from the clouds",
    });
    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/requests/req-123/status",
      }),
    );
    expect(fetchGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://queue.fal.run/fal-ai/minimax/requests/req-123",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      requestId: "req-123",
    });
  });
});
