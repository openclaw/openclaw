import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPortkeyImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "portkey-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined as unknown,
  })),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
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

describe("portkey image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("declares portkey id and OpenAI-compatible size hints", () => {
    const provider = buildPortkeyImageGenerationProvider();

    expect(provider.id).toBe("portkey");
    expect(provider.label).toBe("Portkey");
    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.capabilities.geometry?.sizes).toEqual(
      expect.arrayContaining(["1024x1024", "2048x2048", "3840x2160"]),
    );
    expect(provider.capabilities.edit?.enabled).toBe(true);
  });

  it("uses x-portkey-api-key header for authentication", async () => {
    mockGeneratedPngResponse();

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
      model: "gpt-image-2",
      prompt: "Draw a gateway",
      cfg: {},
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultHeaders: { "x-portkey-api-key": "portkey-key" },
      }),
    );
  });

  it("defaults to the Portkey cloud base URL", async () => {
    mockGeneratedPngResponse();

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
      model: "gpt-image-2",
      prompt: "Draw a gateway",
      cfg: {},
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.portkey.ai/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.portkey.ai/v1/images/generations",
      }),
    );
  });

  it("honors configured baseUrl", async () => {
    mockGeneratedPngResponse();

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
      model: "gpt-image-2",
      prompt: "campaign hero",
      cfg: {
        models: {
          providers: {
            portkey: {
              baseUrl: "https://custom-gateway.example.com/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://custom-gateway.example.com/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://custom-gateway.example.com/v1/images/generations",
      }),
    );
  });

  it("forwards count and size overrides on generation requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
      model: "dall-e-3",
      prompt: "two landscape variants",
      cfg: {},
      count: 2,
      size: "3840x2160",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.portkey.ai/v1/images/generations",
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

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
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
        url: "https://api.portkey.ai/v1/images/edits",
      }),
    );
    const call = postJsonRequestMock.mock.calls[0][0] as { body: { images: unknown[] } };
    expect(call.body.images).toHaveLength(1);
  });

  it("throws a clear error when the API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildPortkeyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "portkey",
        model: "gpt-image-2",
        prompt: "x",
        cfg: {},
      }),
    ).rejects.toThrow("Portkey API key missing");
  });

  it("forwards dispatcherPolicy from resolveProviderHttpRequestConfig to postJsonRequest", async () => {
    const dispatcherPolicy = { proxyUrl: "http://corp-proxy:3128" } as unknown;
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://custom-gateway.example.com/v1",
      allowPrivateNetwork: false,
      headers: new Headers({ "x-portkey-api-key": "portkey-key" }),
      dispatcherPolicy,
    });
    mockGeneratedPngResponse();

    const provider = buildPortkeyImageGenerationProvider();
    await provider.generateImage({
      provider: "portkey",
      model: "gpt-image-2",
      prompt: "hi",
      cfg: {
        models: {
          providers: {
            portkey: { baseUrl: "https://custom-gateway.example.com/v1", models: [] },
          },
        },
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(expect.objectContaining({ dispatcherPolicy }));
  });
});
