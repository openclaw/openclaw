import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKlingaiImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  postJsonRequestMock,
  fetchWithTimeoutGuardedMock,
  assertOkOrThrowHttpErrorMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "kling-test-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params): any => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  postJsonRequestMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  postJsonRequest: postJsonRequestMock,
  fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
}));

describe("klingai image generation provider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("submits an image generation task, polls completion, and downloads images", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              images: [{ url: "https://cdn.kling.ai/output/image-1.png" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "klingai",
      model: "kling-v3",
      prompt: "draw a futuristic city",
      cfg: {},
      count: 2,
      aspectRatio: "16:9",
      resolution: "2K",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-singapore.klingai.com/v1/images/generations",
        body: {
          model_name: "kling-v3",
          prompt: "draw a futuristic city",
          negative_prompt: "",
          n: 2,
          aspect_ratio: "16:9",
          resolution: "2k",
          callback_url: "",
        },
      }),
    );
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      1,
      "https://api-singapore.klingai.com/v1/images/generations/task-img-1",
      expect.objectContaining({
        method: "GET",
      }),
      30000,
      fetch,
      {},
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "kling-v3",
      metadata: {
        taskId: "task-img-1",
        taskStatus: "succeed",
      },
    });
  });

  it("routes kling-v3-omni to the omni image endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-omni-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              images: [{ url: "https://cdn.kling.ai/output/image-omni-1.png" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    await provider.generateImage({
      provider: "klingai",
      model: "kling-v3-omni",
      prompt: "render in omni mode",
      cfg: {},
      resolution: "4K",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api-singapore.klingai.com/v1/images/omni-image",
        body: expect.objectContaining({
          model_name: "kling-v3-omni",
          resolution: "4k",
          result_type: "single",
        }),
      }),
    );
  });

  it("omits default aspect_ratio and resolution when unset", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-default-omits-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              images: [{ url: "https://cdn.kling.ai/output/image-default-omits-1.png" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    await provider.generateImage({
      provider: "klingai",
      model: "kling-v3",
      prompt: "draw defaults omitted",
      cfg: {},
    });

    const request = postJsonRequestMock.mock.calls[0]?.[0] as { body?: Record<string, unknown> };
    expect(request.body).not.toHaveProperty("aspect_ratio");
    expect(request.body).not.toHaveProperty("resolution");
  });

  it("includes watermark_info when watermark is explicitly set", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-watermark-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: {
              images: [{ url: "https://cdn.kling.ai/output/image-watermark-1.png" }],
            },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    const request = {
      provider: "klingai",
      model: "kling-v3",
      prompt: "watermark off image",
      cfg: {},
      watermark: false,
    } as unknown as Parameters<typeof provider.generateImage>[0];
    await provider.generateImage(request);

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          watermark_info: { enabled: false },
        }),
      }),
    );
  });

  it("passes through a URL reference image when present", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-2" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: { url: "https://cdn.kling.ai/output/edited.png" },
          },
        }),
        headers: new Headers(),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("edited-png-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    const urlFirstInput = {
      url: "https://example.com/reference.png",
      buffer: Buffer.from("source-image"),
      mimeType: "image/jpeg",
    } as unknown as { buffer: Buffer; mimeType: string };
    await provider.generateImage({
      provider: "klingai",
      model: "kling-v3",
      prompt: "turn this into pixel art",
      cfg: {},
      inputImages: [urlFirstInput],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          image: "https://example.com/reference.png",
        }),
      }),
    );
  });

  it("fails when Kling response code is missing", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ data: { task_id: "task-img-3" } }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "klingai",
        model: "kling-v3",
        prompt: "draw a robot",
        cfg: {},
      }),
    ).rejects.toThrow("KlingAI image generation failed");
  });

  it("preserves HTTP policy and honors caller timeout for polling", async () => {
    const dispatcherPolicy = { mode: "explicit-proxy" } as any;
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://proxy.kling.ai",
      allowPrivateNetwork: true,
      headers: new Headers({
        Authorization: "Bearer kling-test-key",
        "Content-Type": "application/json",
      }),
      dispatcherPolicy,
    });
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ code: 0, data: { task_id: "task-img-policy-1" } }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        json: async () => ({
          code: 0,
          data: {
            task_status: "succeed",
            task_result: { images: [{ url: "https://cdn.kling.ai/output/policy-1.png" }] },
          },
        }),
        headers: new Headers({ "content-type": "application/json" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: {
        arrayBuffer: async () => Buffer.from("policy-bytes"),
        headers: new Headers({ "content-type": "image/png" }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildKlingaiImageGenerationProvider();
    await provider.generateImage({
      provider: "klingai",
      model: "kling-v3",
      prompt: "policy timeout test",
      cfg: {},
      timeoutMs: 5_000,
    });

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      "https://proxy.kling.ai/v1/images/generations/task-img-policy-1",
      expect.objectContaining({ method: "GET" }),
      5_000,
      fetch,
      {
        ssrfPolicy: { allowPrivateNetwork: true },
        dispatcherPolicy,
      },
    );
  });

  it("fails fast when api key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "",
    });
    const provider = buildKlingaiImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "klingai",
        model: "kling-v3",
        prompt: "cat",
        cfg: {},
      }),
    ).rejects.toThrow("KlingAI API key missing");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects kling-v3 4K image requests", async () => {
    const provider = buildKlingaiImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "klingai",
        model: "kling-v3",
        prompt: "4k please",
        cfg: {},
        resolution: "4K",
      }),
    ).rejects.toThrow("does not support 4K");
  });
});
