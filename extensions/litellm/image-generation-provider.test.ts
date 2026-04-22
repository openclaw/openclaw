import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

type MockResolvedProviderHttpRequestConfig = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: PinnedDispatcherPolicy | undefined;
};

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "litellm-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn(
    (params): MockResolvedProviderHttpRequestConfig => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
      headers: new Headers(params.defaultHeaders),
      dispatcherPolicy: undefined,
    }),
  ),
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

const dispatcherPolicy: PinnedDispatcherPolicy = { mode: "direct" };

describe("litellm image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("declares litellm id and OpenAI-compatible size hints", () => {
    const provider = buildLitellmImageGenerationProvider();

    expect(provider.id).toBe("litellm");
    expect(provider.label).toBe("LiteLLM");
    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.capabilities.geometry?.sizes).toEqual(
      expect.arrayContaining(["1024x1024", "2048x2048", "3840x2160"]),
    );
    expect(provider.capabilities.edit?.enabled).toBe(true);
  });

  it("defaults to the loopback proxy and allows private network for localhost", async () => {
    mockGeneratedPngResponse();
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "http://localhost:4000",
      allowPrivateNetwork: true,
      headers: new Headers({ Authorization: "Bearer litellm-key" }),
      dispatcherPolicy,
    });

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {},
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:4000",
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:4000/images/generations",
        allowPrivateNetwork: true,
        dispatcherPolicy,
      }),
    );
  });

  it("honors configured baseUrl and keeps private-network off for public endpoints", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "campaign hero",
      cfg: {
        models: {
          providers: {
            litellm: {
              baseUrl: "https://proxy.example.com/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://proxy.example.com/v1",
        allowPrivateNetwork: false,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://proxy.example.com/v1/images/generations",
      }),
    );
  });

  it("allows https private-network LiteLLM endpoints", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "campaign hero",
      cfg: {
        models: {
          providers: {
            litellm: {
              baseUrl: "https://192.168.1.10/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://192.168.1.10/v1",
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://192.168.1.10/v1/images/generations",
        allowPrivateNetwork: true,
      }),
    );
  });

  it("forwards count and size overrides on generation requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "dall-e-3",
      prompt: "two landscape variants",
      cfg: {},
      count: 2,
      size: "3840x2160",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:4000/images/generations",
        body: {
          model: "dall-e-3",
          prompt: "two landscape variants",
          n: 2,
          size: "3840x2160",
        },
      }),
    );
  });

  it("routes to the edit endpoint when input images are provided", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "refine the hero",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("fake-input"),
          mimeType: "image/png",
        },
      ],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:4000/images/edits",
      }),
    );
    const call = postJsonRequestMock.mock.calls[0][0] as { body: { images: unknown[] } };
    expect(call.body.images).toHaveLength(1);
  });

  it("throws a clear error when the API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildLitellmImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "litellm",
        model: "gpt-image-2",
        prompt: "x",
        cfg: {},
      }),
    ).rejects.toThrow("LiteLLM API key missing");
  });
});
