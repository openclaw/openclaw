import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openai-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
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
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function mockGeneratedPngResponse() {
  postJsonRequestMock.mockResolvedValue({
    response: {
      json: async () => ({
        data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
      }),
    },
    release: vi.fn(async () => {}),
  });
}

describe("openai image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("advertises the current OpenAI image model and 2K/4K size hints", () => {
    const provider = buildOpenAIImageGenerationProvider();

    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.models).toEqual(["gpt-image-2"]);
    expect(provider.capabilities.geometry?.sizes).toEqual(
      expect.arrayContaining(["2048x2048", "3840x2160", "2160x3840"]),
    );
  });

  it("does not auto-allow local baseUrl overrides for image requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:44080/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: false,
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("forwards generation count and custom size overrides", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Create two landscape campaign variants",
      cfg: {},
      count: 2,
      size: "3840x2160",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: {
          model: "gpt-image-2",
          prompt: "Create two landscape campaign variants",
          n: 2,
          size: "3840x2160",
        },
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("allows loopback image requests for the synthetic mock-openai provider", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "mock-openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: true,
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("allows loopback image requests for openai only inside the QA harness envelope", async () => {
    mockGeneratedPngResponse();
    vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("forwards edit count, custom size, and multiple input images", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Change only the background to pale blue",
      cfg: {},
      count: 2,
      size: "1024x1536",
      inputImages: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
        {
          buffer: Buffer.from("jpeg-bytes"),
          mimeType: "image/jpeg",
          fileName: "style.jpg",
        },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/edits",
        body: expect.objectContaining({
          model: "gpt-image-2",
          prompt: "Change only the background to pale blue",
          n: 2,
          size: "1024x1536",
          images: [
            {
              image_url: "data:image/png;base64,cG5nLWJ5dGVz",
            },
            {
              image_url: "data:image/jpeg;base64,anBlZy1ieXRlcw==",
            },
          ],
        }),
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  describe("azure openai support", () => {
    it("uses api-key header and deployment-scoped URL for Azure .openai.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
      );
    });

    it("uses api-key header and deployment-scoped URL for .cognitiveservices.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.cognitiveservices.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.cognitiveservices.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
      );
    });

    it("uses api-key header and deployment-scoped URL for .services.ai.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://my-resource.services.ai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://my-resource.services.ai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
      );
    });

    it("respects AZURE_OPENAI_API_VERSION env override", async () => {
      mockGeneratedPngResponse();
      vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-01-01");

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-01-01",
        }),
      );
    });

    it("builds Azure edit URL with deployment and api-version", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Change background",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
        inputImages: [
          {
            buffer: Buffer.from("png-bytes"),
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/edits?api-version=2024-12-01-preview",
        }),
      );
    });

    it("strips trailing /v1 from Azure base URL", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/v1",
                models: [],
              },
            },
          },
        },
      });

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
      );
    });

    it("strips trailing /openai/v1 from Azure base URL", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
      });

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
      );
    });

    it("still uses Bearer auth for public OpenAI hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Public cat",
        cfg: {},
      });

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { Authorization: "Bearer openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.openai.com/v1/images/generations",
        }),
      );
    });
  });
});
