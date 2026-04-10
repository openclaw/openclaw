import { afterEach, describe, expect, it, vi } from "vitest";
import { buildViduVideoGenerationProvider } from "./video-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "vidu-key" })),
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

describe("vidu video generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    fetchWithTimeoutMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("uses Token auth header instead of Bearer", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_auth" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_auth",
          state: "success",
          creations: [{ url: "https://example.com/v.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "test",
      cfg: {},
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: expect.objectContaining({
          Authorization: "Token vidu-key",
        }),
      }),
    );
  });

  it("creates a text-to-video task, polls state field, and downloads the video", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_123", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_123",
          state: "success",
          creations: [{ url: "https://example.com/vidu.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "A futuristic city at sunset",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/text2video",
      }),
    );
    expect(result.videos).toHaveLength(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({ taskId: "task_123", state: "success" }),
    );
  });

  it("routes single image to img2video endpoint with images array", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_456", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_456",
          state: "success",
          creations: [{ url: "https://example.com/vidu-img.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "Animate this image",
      cfg: {},
      inputImages: [{ url: "https://example.com/photo.png" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/img2video",
        body: expect.objectContaining({
          images: ["https://example.com/photo.png"],
        }),
      }),
    );
  });

  it("routes multiple images to reference2video endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_789", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_789",
          state: "success",
          creations: [{ url: "https://example.com/vidu-ref.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq2",
      prompt: "Characters interacting",
      cfg: {},
      inputImages: [
        { url: "https://example.com/ref1.png" },
        { url: "https://example.com/ref2.png" },
        { url: "https://example.com/ref3.png" },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/reference2video",
        body: expect.objectContaining({
          subjects: [
            { name: "1", images: ["https://example.com/ref1.png"] },
            { name: "2", images: ["https://example.com/ref2.png"] },
            { name: "3", images: ["https://example.com/ref3.png"] },
          ],
        }),
      }),
    );
  });

  it("routes 2 images with reference role to reference2video endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_ref2", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_ref2",
          state: "success",
          creations: [{ url: "https://example.com/vidu-ref.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq2",
      prompt: "Two characters",
      cfg: {},
      inputImages: [
        { url: "https://example.com/char1.png", metadata: { role: "reference" } },
        { url: "https://example.com/char2.png", metadata: { role: "reference" } },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/reference2video",
        body: expect.objectContaining({
          subjects: [
            { name: "1", images: ["https://example.com/char1.png"] },
            { name: "2", images: ["https://example.com/char2.png"] },
          ],
        }),
      }),
    );
  });

  it("routes 2 images without role to start-end2video endpoint by default", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_se", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_se",
          state: "success",
          creations: [{ url: "https://example.com/vidu-se.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "Transition from start to end",
      cfg: {},
      inputImages: [
        { url: "https://example.com/start.png" },
        { url: "https://example.com/end.png" },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/start-end2video",
        body: expect.objectContaining({
          images: ["https://example.com/start.png", "https://example.com/end.png"],
        }),
      }),
    );
  });

  it("converts a Buffer input image to a data URL", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_buf", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_buf",
          state: "success",
          creations: [{ url: "https://example.com/vidu-buf.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "Animate this",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("fake-png-data"),
          mimeType: "image/png",
        },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/img2video",
        body: expect.objectContaining({
          images: [`data:image/png;base64,${Buffer.from("fake-png-data").toString("base64")}`],
        }),
      }),
    );
  });

  it("throws when an image input has neither url nor buffer", async () => {
    const provider = buildViduVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vidu",
        model: "viduq3-pro",
        prompt: "Animate this",
        cfg: {},
        inputImages: [{}],
      }),
    ).rejects.toThrow("missing image data");
  });

  it("routes video reference inputs to reference2video with non-subject mode", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_vid", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_vid",
          state: "success",
          creations: [{ url: "https://example.com/vidu-vid.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq2-pro",
      prompt: "Edit this video",
      cfg: {},
      inputVideos: [{ url: "https://example.com/clip.mp4" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/reference2video",
        body: expect.objectContaining({
          videos: ["https://example.com/clip.mp4"],
        }),
      }),
    );
  });

  it("routes mixed image + video inputs to reference2video non-subject mode", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_mix", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_mix",
          state: "success",
          creations: [{ url: "https://example.com/vidu-mix.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq2-pro",
      prompt: "Combine these",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
      inputVideos: [{ url: "https://example.com/clip.mp4" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/reference2video",
        body: expect.objectContaining({
          images: ["https://example.com/ref.png"],
          videos: ["https://example.com/clip.mp4"],
        }),
      }),
    );
    // Should NOT have subjects in non-subject mode
    const body = postJsonRequestMock.mock.calls[0][0].body;
    expect(body.subjects).toBeUndefined();
  });

  it("rejects video reference inputs with unsupported model", async () => {
    const provider = buildViduVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vidu",
        model: "viduq3-pro",
        prompt: "Transform this video",
        cfg: {},
        inputVideos: [{ url: "https://example.com/clip.mp4" }],
      }),
    ).rejects.toThrow(/does not support reference2video/);
  });

  it("throws when API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });
    const provider = buildViduVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vidu",
        model: "viduq3-pro",
        prompt: "test",
        cfg: {},
      }),
    ).rejects.toThrow("API key missing");
  });

  it("throws when model is incompatible with the resolved endpoint", async () => {
    const provider = buildViduVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vidu",
        // viduq3-pro does not support reference2video
        model: "viduq3-pro",
        prompt: "Characters interacting",
        cfg: {},
        inputImages: [
          { url: "https://example.com/ref1.png", metadata: { role: "reference" } },
          { url: "https://example.com/ref2.png", metadata: { role: "reference" } },
        ],
      }),
    ).rejects.toThrow(/does not support reference2video/);
  });

  it("throws on invalid image role", async () => {
    const provider = buildViduVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "vidu",
        model: "viduq3-pro",
        prompt: "test",
        cfg: {},
        inputImages: [{ url: "https://example.com/img.png", metadata: { role: "invalid-role" } }],
      }),
    ).rejects.toThrow(/Invalid image role/);
  });

  it("routes 2 images with start-frame/end-frame roles to start-end2video endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ task_id: "task_se2", state: "created" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "task_se2",
          state: "success",
          creations: [{ url: "https://example.com/vidu-se2.mp4" }],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildViduVideoGenerationProvider();
    await provider.generateVideo({
      provider: "vidu",
      model: "viduq3-pro",
      prompt: "Smooth transition",
      cfg: {},
      inputImages: [
        { url: "https://example.com/start.png", metadata: { role: "start-frame" } },
        { url: "https://example.com/end.png", metadata: { role: "end-frame" } },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.vidu.com/ent/v2/start-end2video",
        body: expect.objectContaining({
          images: ["https://example.com/start.png", "https://example.com/end.png"],
        }),
      }),
    );
  });
});
