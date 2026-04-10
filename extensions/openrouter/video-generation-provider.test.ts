import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenrouterVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openrouter-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

// Helper: mock a guarded fetch response (poll uses guarded transport).
function guardedResponse(body: unknown, headers?: Record<string, string>) {
  return {
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    }),
    release: vi.fn(async () => {}),
  };
}

// Helper: mock a guarded fetch that returns binary content (authenticated download).
function guardedBinaryResponse(data: Buffer, mimeType: string) {
  return {
    response: new Response(data, {
      status: 200,
      headers: { "content-type": mimeType },
    }),
    release: vi.fn(async () => {}),
  };
}

describe("openrouter video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    fetchWithTimeoutMock.mockReset();
    fetchWithTimeoutGuardedMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("exposes correct provider metadata", () => {
    const provider = buildOpenrouterVideoGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/veo-3.1");
    expect(provider.models).toContain("google/veo-3.1");
    expect(provider.capabilities.generate?.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.generate?.supportsAudio).toBe(true);
    expect(provider.capabilities.imageToVideo?.enabled).toBe(true);
    expect(provider.capabilities.videoToVideo?.enabled).toBe(false);
  });

  it("submits a video request, polls, and downloads the result", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video-job-1",
          polling_url: "https://openrouter.ai/api/v1/videos/video-job-1",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });

    // Poll (guarded) returns completed with unsigned URL
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      guardedResponse({
        id: "video-job-1",
        generation_id: "gen-abc",
        status: "completed",
        unsigned_urls: ["https://cdn.openrouter.ai/videos/video-job-1.mp4"],
      }),
    );

    // Download unsigned URL uses raw fetchWithTimeout
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(Buffer.from("video-bytes"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    );

    const provider = buildOpenrouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A lobster walking on a beach",
      cfg: {},
    });

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.videos[0]?.buffer.toString()).toBe("video-bytes");
    expect(result.model).toBe("google/veo-3.1");
    expect(result.metadata).toMatchObject({ videoId: "video-job-1" });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/videos",
        body: expect.objectContaining({
          model: "google/veo-3.1",
          prompt: "A lobster walking on a beach",
        }),
      }),
    );
  });

  it("uses guarded download when no unsigned URL is available", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video-auth",
          polling_url: "https://openrouter.ai/api/v1/videos/video-auth",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });

    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        guardedResponse({ id: "video-auth", status: "completed", unsigned_urls: [] }),
      )
      .mockResolvedValueOnce(guardedBinaryResponse(Buffer.from("auth-video"), "video/mp4"));

    const provider = buildOpenrouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "authenticated download",
      cfg: {},
    });

    expect(result.videos[0]?.buffer.toString()).toBe("auth-video");
    // No raw fetchWithTimeout call since download went through guarded path
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("passes duration, resolution, and aspect_ratio", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video-job-2",
          polling_url: "https://openrouter.ai/api/v1/videos/video-job-2",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });

    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        guardedResponse({ id: "video-job-2", status: "completed", unsigned_urls: [] }),
      )
      .mockResolvedValueOnce(guardedBinaryResponse(Buffer.from("mp4"), "video/mp4"));

    const provider = buildOpenrouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "waves",
      cfg: {},
      durationSeconds: 8,
      resolution: "1080P",
      aspectRatio: "16:9",
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          duration: 8,
          resolution: "1080p",
          aspect_ratio: "16:9",
          generate_audio: true,
        }),
      }),
    );
  });

  it("throws when video generation fails", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video-job-fail",
          polling_url: "https://openrouter.ai/api/v1/videos/video-job-fail",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });

    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(
      guardedResponse({ id: "video-job-fail", status: "failed" }),
    );

    const provider = buildOpenrouterVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openrouter",
        model: "google/veo-3.1",
        prompt: "will fail",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter video generation failed");
  });

  it("builds input_references for image-to-video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "video-i2v",
          polling_url: "https://openrouter.ai/api/v1/videos/video-i2v",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });

    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce(
        guardedResponse({ id: "video-i2v", status: "completed", unsigned_urls: [] }),
      )
      .mockResolvedValueOnce(guardedBinaryResponse(Buffer.from("mp4"), "video/mp4"));

    const provider = buildOpenrouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "animate this image",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("img-bytes"),
          mimeType: "image/png",
        },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          input_references: [
            {
              type: "image_url",
              image_url: `data:image/png;base64,${Buffer.from("img-bytes").toString("base64")}`,
            },
          ],
        }),
      }),
    );
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildOpenrouterVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openrouter",
        model: "google/veo-3.1",
        prompt: "test",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter API key missing");
  });
});
