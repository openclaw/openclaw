import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildKlingaiVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "kling-video-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  postJsonRequest: postJsonRequestMock,
  fetchWithTimeout: fetchWithTimeoutMock,
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
}));

describe("klingai video generation provider", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "kling-video-key" });
    resolveProviderHttpRequestConfigMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockImplementation((params) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: false,
      headers: new Headers(params.defaultHeaders),
      dispatcherPolicy: undefined,
    }));
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("submits text-to-video tasks and downloads output video by default", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.kling.ai/output/video-1.mp4" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildKlingaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3",
      prompt: "a dragon flying over mountains",
      cfg: {},
      durationSeconds: 6,
      aspectRatio: "16:9",
      audio: true,
      watermark: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-singapore.klingai.com/v1/videos/text2video",
        body: expect.objectContaining({
          model_name: "kling-v3",
          prompt: "a dragon flying over mountains",
          duration: "6",
          sound: "on",
          aspect_ratio: "16:9",
          watermark_info: { enabled: true },
        }),
      }),
    );
    expect(result.videos).toEqual([
      {
        buffer: Buffer.from("video-bytes"),
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("returns url-only output when providerOptions.return_url_only is true", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-download-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.kling.ai/output/video-download-1.mp4" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video-res-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildKlingaiVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3",
      prompt: "a dragon flying over mountains",
      cfg: {},
      providerOptions: {
        return_url_only: true,
      },
    });

    expect(result.videos).toEqual([
      {
        url: "https://cdn.kling.ai/output/video-download-1.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("maps 720P resolution to std mode", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-res-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.kling.ai/output/video-res-1.mp4" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video-1b-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });
    const provider = buildKlingaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3",
      prompt: "test std mode",
      cfg: {},
      resolution: "720P",
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          mode: "std",
        }),
      }),
    );
  });

  it("clamps duration to Kling supported range 3-15", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-1b" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.kling.ai/output/video-1b.mp4" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video-1b-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildKlingaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3",
      prompt: "a robot dancing",
      cfg: {},
      durationSeconds: 99,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          duration: "15",
        }),
      }),
    );
  });

  it("routes to image2video endpoint when a reference image is provided", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-2" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              video_url: "https://cdn.kling.ai/output/video-2.mp4",
            },
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video2-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildKlingaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3",
      prompt: "animate this portrait",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-singapore.klingai.com/v1/videos/image2video",
        body: expect.objectContaining({
          image: "https://example.com/ref.png",
        }),
      }),
    );
  });

  it("routes kling-v3-omni to omni-video endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-omni-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.kling.ai/output/video-omni-1.mp4" }],
            },
          },
        }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("video-omni-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });
    const provider = buildKlingaiVideoGenerationProvider();
    await provider.generateVideo({
      provider: "klingai",
      model: "kling-v3-omni",
      prompt: "omni mode video",
      cfg: {},
      inputImages: [{ url: "https://example.com/first-frame.png" }],
      resolution: "1080P",
    });
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-singapore.klingai.com/v1/videos/omni-video",
        body: expect.objectContaining({
          model_name: "kling-v3-omni",
          image_list: [
            { image_url: "https://example.com/first-frame.png", type: "first_frame" },
          ],
        }),
      }),
    );
  });

  it("throws when kling task reports failed status", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-vid-3" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        code: 0,
        data: {
          task_status: "failed",
          task_status_msg: "quota exceeded",
        },
      }),
      headers: new Headers(),
    });

    const provider = buildKlingaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "klingai",
        model: "kling-v3",
        prompt: "fail this",
        cfg: {},
      }),
    ).rejects.toThrow("quota exceeded");
  });

  it("rejects kling-v3 image-to-video requests with explicit aspect ratio", async () => {
    const provider = buildKlingaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "klingai",
        model: "kling-v3",
        prompt: "animate this image",
        cfg: {},
        aspectRatio: "16:9",
        inputImages: [{ url: "https://example.com/ref.png" }],
      }),
    ).rejects.toThrow("does not support aspectRatio");
  });

  it("rejects unsupported model ids", async () => {
    const provider = buildKlingaiVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "klingai",
        model: "kling-v2-6",
        prompt: "unsupported model",
        cfg: {},
      }),
    ).rejects.toThrow("Unsupported KlingAI video model");
  });
});
