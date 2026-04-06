import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postTranscriptionRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openai-key" })),
  postJsonRequestMock: vi.fn(),
  postTranscriptionRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? params.baseUrl?.trim()),
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
  postTranscriptionRequest: postTranscriptionRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

describe("openai image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    postTranscriptionRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
  });

  it("allows explicit local baseUrl overrides for image requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
      },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
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
        allowPrivateNetwork: true,
      }),
    );
    expect(result.images).toHaveLength(1);
  });
});
