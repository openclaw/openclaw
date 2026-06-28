// Openrouter tests cover image generation provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenRouterImageGenerationProvider,
  extractOpenRouterImagesFromResponse,
} from "./image-generation-provider.js";

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async (_params: unknown) => ({
    apiKey: "openrouter-key",
  })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  // Pass-through: bounded-reader enforcement is tested via bounded-reader unit tests.
  readProviderJsonResponse: async (response: { json(): Promise<unknown> }) => response.json(),
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function requireOpenRouterPostBody(): {
  messages?: Array<{ content?: unknown }>;
} {
  const request = requireOpenRouterPostRequest();
  return request.body as { messages?: Array<{ content?: unknown }> };
}

function requireOpenRouterPostRequest(): Record<string, unknown> {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter image generation request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image generation request");
  }
  return request as Record<string, unknown>;
}

function requireOpenRouterConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter image config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter image config request");
  }
  return request;
}

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter image request headers");
  }
  return value;
}

function requireGeneratedImage(
  result: Awaited<
    ReturnType<ReturnType<typeof buildOpenRouterImageGenerationProvider>["generateImage"]>
  >,
  index: number,
) {
  const image = result.images[index];
  if (!image) {
    throw new Error(`expected OpenRouter generated image at index ${index}`);
  }
  return image;
}

describe("openrouter image generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("builds provider metadata and capabilities", () => {
    const provider = buildOpenRouterImageGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/gemini-3.1-flash-image-preview");
    expect(provider.models).toContain("google/gemini-3.1-flash-image");
    expect(provider.models).toContain("google/gemini-3-pro-image");
    expect(provider.models).toContain("google/gemini-3-pro-image-preview");
    expect(provider.models).toContain("google/gemini-2.5-flash-image");
    expect(provider.models).toContain("openai/gpt-5-image");
    expect(provider.models).toContain("openai/gpt-5-image-mini");
    expect(provider.models).toContain("openai/gpt-5.4-image-2");
    expect(provider.models).toContain("microsoft/mai-image-2.5");
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.generate.maxCountByModel?.["microsoft/mai-image-2.5"]).toBe(1);
    expect(provider.capabilities.generate.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.geometry?.aspectRatios).toContain("1:4");
    expect(provider.capabilities.geometry?.aspectRatios).toContain("8:1");
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(10);
    expect(provider.capabilities.edit.maxInputImagesByModel?.[provider.defaultModel ?? ""]).toBe(5);
    expect(
      provider.capabilities.edit.maxInputImagesByModel?.["google/gemini-2.5-flash-image"],
    ).toBe(3);
    expect(provider.capabilities.edit.maxInputImagesByModel?.["microsoft/mai-image-2.5"]).toBe(1);
    expect(provider.capabilities.edit.supportsResolution).toBe(true);
  });

  it("sends current image models through OpenRouter images API", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "microsoft/mai-image-2.5",
      prompt: "draw a sticker",
      aspectRatio: "16:9",
      count: 1,
      inputImages: [{ buffer: Buffer.from("source-one"), mimeType: "image/png" }],
      cfg: {},
    });

    const request = requireOpenRouterPostRequest();
    expect(request).toMatchObject({
      url: "https://openrouter.ai/api/v1/images",
      body: {
        model: "microsoft/mai-image-2.5",
        prompt: "draw a sticker",
        n: 1,
        aspect_ratio: "16:9",
        input_references: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from("source-one").toString("base64")}`,
            },
          },
        ],
      },
    });
    expect(result.model).toBe("microsoft/mai-image-2.5");
    expect(requireGeneratedImage(result, 0).buffer.toString()).toBe("png-one");
  });

  it("rejects unsupported Images API count and reference image limits before request", async () => {
    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "microsoft/mai-image-2.5",
        prompt: "draw a sticker",
        count: 2,
        cfg: {},
      }),
    ).rejects.toThrow("supports at most 1 output image");

    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "microsoft/mai-image-2.5",
        prompt: "draw a sticker",
        inputImages: [
          { buffer: Buffer.from("source-one"), mimeType: "image/png" },
          { buffer: Buffer.from("source-two"), mimeType: "image/png" },
        ],
        cfg: {},
      }),
    ).rejects.toThrow("supports at most 1 reference image");

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported Images API geometry before request", async () => {
    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "microsoft/mai-image-2.5",
        prompt: "draw a sticker",
        resolution: "2K",
        cfg: {},
      }),
    ).rejects.toThrow("does not support resolution=2K");

    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "openai/gpt-5-image",
        prompt: "draw a sticker",
        aspectRatio: "16:9",
        cfg: {},
      }),
    ).rejects.toThrow("does not support aspectRatio=16:9");

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("sends OpenAI image models through OpenRouter images API without geometry", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "openai/gpt-5-image",
      prompt: "draw a sticker",
      count: 4,
      cfg: {},
    });

    expect(requireOpenRouterPostRequest()).toMatchObject({
      url: "https://openrouter.ai/api/v1/images",
      body: {
        model: "openai/gpt-5-image",
        prompt: "draw a sticker",
        n: 4,
      },
    });
    expect(requireOpenRouterPostRequest().body).not.toHaveProperty("aspect_ratio");
    expect(requireOpenRouterPostRequest().body).not.toHaveProperty("resolution");
  });

  it("ignores unsupported inferred edit resolution for Images API models", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "openai/gpt-5-image",
      prompt: "draw a sticker",
      inputImages: [{ buffer: Buffer.from("source-one"), mimeType: "image/png" }],
      resolution: "1K",
      resolutionInferred: true,
      cfg: {},
    });

    const body = requireOpenRouterPostRequest().body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "openai/gpt-5-image",
      prompt: "draw a sticker",
      n: 1,
      input_references: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from("source-one").toString("base64")}`,
          },
        },
      ],
    });
    expect(body).not.toHaveProperty("resolution");
  });

  it("sends chat completion image requests with Gemini image config and count", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                images: [
                  {
                    imageUrl: {
                      url: `data:image/png;base64,${Buffer.from("png-one").toString("base64")}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      aspectRatio: "16:9",
      resolution: "2K",
      count: 2,
      timeoutMs: 12_345,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: "openrouter",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://custom.openrouter.test/api/v1",
              models: [],
            },
          },
        },
      },
      agentDir: undefined,
      store: undefined,
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    expect(requireOpenRouterConfigRequest()).toEqual({
      baseUrl: "https://custom.openrouter.test/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      defaultHeaders: {
        Authorization: "Bearer openrouter-key",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      provider: "openrouter",
      capability: "image",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireOpenRouterPostRequest();
    const headers = requireHeaders(request.headers);
    expect(Object.fromEntries(headers.entries())).toEqual({
      authorization: "Bearer openrouter-key",
      "http-referer": "https://openclaw.ai",
      "x-openrouter-title": "OpenClaw",
    });
    expect(request).toEqual({
      url: "https://custom.openrouter.test/api/v1/chat/completions",
      headers,
      body: {
        model: "google/gemini-3.1-flash-image-preview",
        messages: [
          {
            role: "user",
            content: "draw a sticker",
          },
        ],
        modalities: ["image", "text"],
        n: 2,
        image_config: {
          aspect_ratio: "16:9",
          image_size: "2K",
        },
      },
      timeoutMs: 12_345,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
    });
    const image = requireGeneratedImage(result, 0);
    expect(image.buffer.toString()).toBe("png-one");
    expect(image.mimeType).toBe("image/png");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a 180s default timeout when no request timeout is provided", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                images: [
                  {
                    imageUrl: {
                      url: `data:image/png;base64,${Buffer.from("png-one").toString("base64")}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      release,
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      cfg: {},
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 180_000,
      }),
    );
  });

  it("sends reference images as data URLs for edit-style requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          choices: [
            {
              message: {
                content: [
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/webp;base64,${Buffer.from("webp-one").toString("base64")}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "turn this into watercolor",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      cfg: {},
    });

    const body = requireOpenRouterPostBody();
    expect(body.messages?.[0]?.content).toEqual([
      { type: "text", text: "turn this into watercolor" },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
        },
      },
    ]);
    const image = requireGeneratedImage(result, 0);
    expect(image.buffer.toString()).toBe("webp-one");
    expect(image.mimeType).toBe("image/webp");
  });

  it("rejects too many legacy chat-image references before request", async () => {
    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "turn these into watercolor",
        inputImages: Array.from({ length: 6 }, (_, index) => ({
          buffer: Buffer.from(`source-image-${index}`),
          mimeType: "image/png",
        })),
        cfg: {},
      }),
    ).rejects.toThrow("supports at most 5 reference images");

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("wraps wrong-shape successful OpenRouter image responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ choices: { message: {} } }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "bad shape",
        cfg: {},
      }),
    ).rejects.toThrow("OpenRouter image generation response malformed");
  });

  it("extracts image fallbacks from string content and raw b64 parts", () => {
    const png = Buffer.from("png-inline").toString("base64");
    const raw = Buffer.from("raw-inline").toString("base64");
    const images = extractOpenRouterImagesFromResponse({
      choices: [
        {
          message: {
            content: `done data:image/png;base64,${png}`,
          },
        },
        {
          message: {
            content: [{ b64_json: raw }],
          },
        },
      ],
    });

    expect(images.map((image) => image.buffer.toString())).toEqual(["png-inline", "raw-inline"]);
  });

  it("rejects invalid raw image parts in strict extraction mode", () => {
    expect(() =>
      extractOpenRouterImagesFromResponse(
        {
          choices: [
            {
              message: {
                content: [{ b64_json: "not-base64!" }],
              },
            },
          ],
        },
        { malformedResponseError: "OpenRouter image generation response malformed" },
      ),
    ).toThrow("OpenRouter image generation response malformed");
  });
});
