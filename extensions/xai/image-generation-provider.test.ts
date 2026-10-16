// Xai tests cover image generation provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";

type GenerateImageParams = Parameters<
  ReturnType<typeof buildXaiImageGenerationProvider>["generateImage"]
>[0];

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  createProviderOperationDeadlineMock,
  resolveProviderOperationTimeoutMsMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "xai-key" })),
  postJsonRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => {
    const headers = new Headers(params.defaultHeaders as HeadersInit | undefined);
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.x.ai/v1",
      allowPrivateNetwork: false,
      headers,
      dispatcherPolicy: undefined,
    };
  }),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs ?? 60000,
  ),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    createProviderOperationDeadline: createProviderOperationDeadlineMock,
    postJsonRequest: postJsonRequestMock,
    readProviderJsonResponse: actual.readProviderJsonResponse,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
    resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
  };
});

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => {
  const normalizeMockOptionalString = (value: unknown) =>
    typeof value === "string" ? value.trim() : undefined;
  const normalizeMockOptionalLowercaseString = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined;
  const readMockStringValue = (value: unknown) =>
    typeof value === "string" ? value.trim() : undefined;
  return {
    normalizeOptionalString: normalizeMockOptionalString,
    normalizeOptionalLowercaseString: normalizeMockOptionalLowercaseString,
    readStringValue: readMockStringValue,
  };
});

function generate(overrides: Partial<GenerateImageParams> = {}) {
  return buildXaiImageGenerationProvider().generateImage({
    provider: "xai",
    model: "grok-imagine-image",
    prompt: "Combine the references",
    cfg: {},
    ...overrides,
  });
}

function mockImage(mime_type?: string, b64_json = Buffer.from("testpng").toString("base64")) {
  postJsonRequestMock.mockResolvedValue({
    response: Response.json({
      data: [{ b64_json, mime_type }],
    }),
    release: vi.fn(async () => {}),
  });
}

type ImageRequest = {
  url?: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
  headers?: Headers;
};

function requirePostJsonCall(index = 0): ImageRequest {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[unknown]>)[index]?.[0] as
    | ImageRequest
    | undefined;
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

describe("xai image generation provider", () => {
  beforeEach(() => mockImage());

  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    vi.unstubAllEnvs();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
  });

  it("builds provider with correct models, default, and capabilities", async () => {
    const provider = buildXaiImageGenerationProvider();
    expect(provider).toMatchObject({
      id: "xai",
      label: "xAI",
      defaultModel: "grok-imagine-image",
      models: ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"],
      capabilities: {
        generate: { maxCount: 4, supportsAspectRatio: true },
        edit: { enabled: true, maxInputImages: 3 },
      },
    });
    expect(provider.capabilities.geometry?.aspectRatios).toEqual([
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "2:1",
      "1:2",
      "19.5:9",
      "9:19.5",
      "20:9",
      "9:20",
    ]);
    const isConfigured = provider.isConfiguredAsync;
    if (!isConfigured) {
      throw new Error("expected XAI image provider config predicate");
    }
    vi.stubEnv("XAI_API_KEY", undefined);
    expect(await isConfigured({})).toBe(false);
    expect(
      await isConfigured({
        cfg: {
          models: {
            providers: {
              xai: {
                apiKey: "xai-image-test-key",
                baseUrl: "https://api.x.ai/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    "grok-imagine-image",
    "grok-imagine-image-2.0",
    "grok-imagine-image-quality",
    "grok-imagine-image-future",
  ])("preserves explicit model %s in the generation request and result", async (model) => {
    const provider = buildXaiImageGenerationProvider();
    const result = await generate({
      model,
      prompt: "test prompt",
      aspectRatio: "20:9",
      resolution: "2K",
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl: "https://custom.x.ai/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(
      (resolveApiKeyForProviderMock.mock.calls as unknown as Array<[unknown]>)[0]?.[0],
    ).toMatchObject({ provider: "xai" });
    expect(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "xai",
      capability: "image",
      baseUrl: "https://custom.x.ai/v1",
    });
    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/generations");
    expect(result.model).toBe(model);
    expect(provider.defaultTimeoutMs).toBe(600_000);
    expect(request).toMatchObject({
      timeoutMs: 600_000,
      body: { model, aspect_ratio: "20:9", resolution: "2k" },
    });
    expect(resolveProviderOperationTimeoutMsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultTimeoutMs: 600_000,
      }),
    );
  });

  it.each(["grok-imagine-image-2.0", "grok-imagine-image-quality"])(
    "sends %s edits as JSON with an image_url object",
    async (model) => {
      mockImage(
        "image/png",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4z0ABAAEfAG0B0xMAAAAASUVORK5CYII=",
      );
      const buffer = Buffer.from("fakeimage");
      await generate({
        model,
        prompt: "Render this as a pencil sketch with detailed shading",
        inputImages: [{ buffer, mimeType: "image/png" }],
      });

      const request = requirePostJsonCall();
      expect(request.url).toContain("/images/edits");
      expect(request.body?.model).toBe(model);
      expect(request.body?.prompt).toBe("Render this as a pencil sketch with detailed shading");
      const image = request.body?.image as { url?: string; type?: string } | undefined;
      expect(image?.url).toContain("data:image/png;base64,");
      expect(image?.type).toBe("image_url");
      expect(request.body?.response_format).toBe("b64_json");
    },
  );

  it("uses the plural xAI images payload for multiple edit inputs", async () => {
    mockImage("image/png", Buffer.from("edited").toString("base64"));
    await generate({
      inputImages: [
        { buffer: Buffer.from("first"), mimeType: "image/png" },
        { buffer: Buffer.from("second"), mimeType: "image/jpeg" },
        { buffer: Buffer.from("third"), mimeType: "image/webp" },
      ],
    });

    const request = requirePostJsonCall();
    expect(request.url).toContain("/images/edits");
    const images = request.body?.images as Array<{ url?: string; type?: string }> | undefined;
    expect(images).toHaveLength(3);
    expect(images).toEqual([
      { url: expect.stringContaining("data:image/png;base64,"), type: "image_url" },
      { url: expect.stringContaining("data:image/jpeg;base64,"), type: "image_url" },
      { url: expect.stringContaining("data:image/webp;base64,"), type: "image_url" },
    ]);
  });

  it("rejects more than three xAI edit references before HTTP", async () => {
    await expect(
      generate({
        inputImages: Array.from({ length: 4 }, (_, index) => ({
          buffer: Buffer.from(`reference-${index}`),
          mimeType: "image/png",
        })),
      }),
    ).rejects.toThrow("xAI image editing supports up to 3 reference images");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
