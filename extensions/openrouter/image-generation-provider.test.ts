// Openrouter tests cover image generation provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  isProviderApiKeyConfiguredMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  createProviderOperationDeadlineMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(
    async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: "openrouter-key" }),
  ),
  isProviderApiKeyConfiguredMock: vi.fn(() => true),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => ({
    timeoutMs: params.timeoutMs,
    label: params.label,
  })),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs ?? 60000,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    createProviderOperationDeadline: createProviderOperationDeadlineMock,
    postJsonRequest: postJsonRequestMock,
    postMultipartRequest: postMultipartRequestMock,
    readProviderJsonResponse: actual.readProviderJsonResponse,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
    resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
    sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
  };
});

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  normalizeOptionalString: (v: unknown) => (typeof v === "string" ? v.trim() : undefined),
  normalizeOptionalLowercaseString: (v: unknown) =>
    typeof v === "string" ? v.trim().toLowerCase() : undefined,
  readStringValue: (v: unknown) => (typeof v === "string" ? v.trim() : undefined),
}));

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requirePostJsonCall(index = 0): {
  url?: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
  headers?: Headers;
} {
  const params = (postJsonRequestMock.mock.calls as unknown as Array<[unknown]>)[index]?.[0] as
    | {
        url?: string;
        timeoutMs?: number;
        body?: Record<string, unknown>;
        headers?: Headers;
      }
    | undefined;
  if (!params) {
    throw new Error(`Expected postJsonRequest call ${index}`);
  }
  return params;
}

describe("openrouter image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    isProviderApiKeyConfiguredMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("builds provider metadata and capabilities", () => {
    const provider = buildOpenRouterImageGenerationProvider();
    expect(provider.id).toBe("openrouter");
    expect(provider.label).toBe("OpenRouter");
    expect(provider.defaultModel).toBe("google/gemini-3.1-flash-image-preview");
    expect(provider.models).toContain("google/gemini-3-pro-image-preview");
    expect(provider.capabilities.generate.maxCount).toBe(4);
    expect(provider.capabilities.generate.supportsAspectRatio).toBe(true);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(5);
    expect(provider.defaultTimeoutMs).toBe(180_000);
  });

  it("sends image generation requests to the /images endpoint with Gemini params", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      aspectRatio: "16:9",
      resolution: "2K",
      count: 2,
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
    } as any);

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    const authParams = (
      resolveApiKeyForProviderMock.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { provider?: string } | undefined;
    expect(authParams?.provider).toBe("openrouter");

    const httpParams = (
      resolveProviderHttpRequestConfigMock.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0] as { provider?: string; capability?: string; baseUrl?: string } | undefined;
    expect(httpParams?.provider).toBe("openrouter");
    expect(httpParams?.capability).toBe("image");
    expect(httpParams?.baseUrl).toBe("https://custom.openrouter.test/api/v1");

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://custom.openrouter.test/api/v1/images");
    expect(request.body).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      n: 2,
      aspect_ratio: "16:9",
      resolution: "2K",
    });
    expect(request.timeoutMs).toBe(180_000);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.buffer.toString()).toBe("png-one");
    expect(result.model).toBe("google/gemini-3.1-flash-image-preview");
  });

  it("uses default base URL when no custom base URL is configured", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        data: [{ b64_json: Buffer.from("png-one").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "draw a sticker",
      cfg: {},
    } as any);

    const request = requirePostJsonCall();
    expect(request.url).toBe("https://openrouter.ai/api/v1/images");
  });

  it("sends reference images as input_references for edit-style requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        data: [
          {
            b64_json: Buffer.from("webp-one").toString("base64"),
            media_type: "image/webp",
          },
        ],
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "turn this into watercolor",
      inputImages: [{ buffer: Buffer.from("source-image"), mimeType: "image/png" }],
      cfg: {},
    } as any);

    const request = requirePostJsonCall();
    expect(request.url).toContain("/images");
    expect(request.url).not.toContain("/images/generations");
    expect(request.url).not.toContain("/images/edits");
    expect(request.body?.input_references).toEqual([
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
        },
      },
    ]);
    expect(result.images[0]?.buffer.toString()).toBe("webp-one");
    expect(result.images[0]?.mimeType).toBe("image/webp");
  });

  it("does not include aspect_ratio or resolution for non-Gemini models", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({
        data: [{ b64_json: Buffer.from("img").toString("base64") }],
      }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await provider.generateImage({
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      prompt: "draw something",
      aspectRatio: "16:9",
      resolution: "2K",
      cfg: {},
    } as any);

    const request = requirePostJsonCall();
    expect(request.body?.aspect_ratio).toBeUndefined();
    expect(request.body?.resolution).toBeUndefined();
  });

  it("throws on missing API key", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });

    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "test",
        cfg: {},
      } as any),
    ).rejects.toThrow("OpenRouter API key missing");
  });

  it("throws when empty image data is returned", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
    postJsonRequestMock.mockResolvedValue({
      response: jsonResponse({ data: [] }),
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenRouterImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openrouter",
        model: "google/gemini-3.1-flash-image-preview",
        prompt: "no images returned",
        cfg: {},
      } as any),
    ).rejects.toThrow(/image.*missing image data/i);
  });
});
