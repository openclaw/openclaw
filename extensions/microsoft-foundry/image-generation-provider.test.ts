import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftFoundryImageGenerationProvider } from "./image-generation-provider.js";
import { PROVIDER_ID } from "./shared.js";

const {
  http,
  isProviderApiKeyConfiguredAsyncMock,
  prepareFoundryRuntimeAuthMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  http: {
    assertOkOrThrowHttpError: vi.fn(async () => {}),
    createProviderOperationDeadline: vi.fn((params: Record<string, unknown>) => params),
    postJsonRequest: vi.fn(),
    postMultipartRequest: vi.fn(),
    resolveProviderHttpRequestConfig: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: false,
      headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
      dispatcherPolicy: undefined,
    })),
    resolveProviderOperationTimeoutMs: vi.fn(
      (params: Record<string, unknown>) =>
        (params.deadline as { timeoutMs?: number }).timeoutMs ?? params.defaultTimeoutMs,
    ),
    sanitizeConfiguredModelProviderRequest: vi.fn((request) => request),
  },
  isProviderApiKeyConfiguredAsyncMock: vi.fn(async () => true),
  prepareFoundryRuntimeAuthMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "foundry-key",
    mode: "api-key" as const,
    profileId: undefined as string | undefined,
    source: "test",
  })),
}));

// mock-isolation: Image request tests control credential availability independently of host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    ...actual,
    ...http,
  };
});

vi.mock("./runtime.js", () => ({
  prepareFoundryRuntimeAuth: prepareFoundryRuntimeAuthMock,
}));

function buildConfig({
  modelId = "image-deployment",
  modelName = "MAI-Image-2.5",
  baseUrl = "https://example.services.ai.azure.com/openai/v1",
  includeModel = true,
  mediaMaxMb,
}: {
  modelId?: string;
  modelName?: string;
  baseUrl?: string;
  includeModel?: boolean;
  mediaMaxMb?: number;
} = {}): OpenClawConfig {
  return {
    ...(mediaMaxMb !== undefined ? { agents: { defaults: { mediaMaxMb } } } : {}),
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          api: "openai-completions",
          models: !includeModel
            ? []
            : [
                {
                  id: modelId,
                  name: modelName,
                  api: "openai-completions",
                  baseUrl,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 0,
                },
              ],
        },
      },
    },
  };
}

function imageResponse(base64 = Buffer.from("png").toString("base64")) {
  return {
    response: Response.json({ data: [{ b64_json: base64 }] }),
    release: vi.fn(async () => {}),
  };
}

function generateImage(overrides: Partial<ImageGenerationRequest> = {}) {
  return buildMicrosoftFoundryImageGenerationProvider().generateImage({
    provider: PROVIDER_ID,
    model: "image-deployment",
    prompt: "draw it",
    cfg: buildConfig(),
    ...overrides,
  });
}

function requireRequest(mock = http.postJsonRequest): Record<string, unknown> {
  const request = mock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object") {
    throw new Error("expected Microsoft Foundry image request");
  }
  return request as Record<string, unknown>;
}

function requireHeaders(value: unknown): Headers {
  expect(value).toBeInstanceOf(Headers);
  if (!(value instanceof Headers)) {
    throw new Error("expected request headers");
  }
  return value;
}

const inputImages = [{ buffer: Buffer.from("input"), mimeType: "image/png" }];
async function expectRejectedBeforeAuth(
  request: Partial<ImageGenerationRequest>,
  error: string,
  transport = http.postJsonRequest,
) {
  await expect(generateImage(request)).rejects.toThrow(error);
  expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
}

describe("microsoft foundry image generation provider", () => {
  afterEach(() => {
    Object.values(http).forEach((mock) => mock.mockClear());
    isProviderApiKeyConfiguredAsyncMock.mockClear();
    http.postJsonRequest.mockReset();
    http.postMultipartRequest.mockReset();
    prepareFoundryRuntimeAuthMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("exposes MAI image provider metadata and capabilities", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();
    const cfg = buildConfig();
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.defaultModel).toBeUndefined();
    expect(provider.models).toEqual([]);
    expect(provider.capabilities.generate.maxCount).toBe(1);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(1);
    expect(provider.capabilities.geometry?.sizes).toBeUndefined();
    expect(provider.capabilities.output?.formats).toEqual(["png"]);
    expect(await provider.isConfiguredAsync?.({ agentDir: "/agent", cfg })).toBe(true);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith({
      provider: PROVIDER_ID,
      agentDir: "/agent",
      cfg,
    });
  });

  it("sends MAI image generation requests to the Foundry MAI endpoint with API-key auth", async () => {
    http.postJsonRequest.mockResolvedValue(imageResponse());

    const result = await generateImage({
      prompt: "draw a clean product render",
      size: "768x1365",
      timeoutMs: 12_345,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
      provider: PROVIDER_ID,
      cfg: buildConfig(),
      agentDir: undefined,
      store: undefined,
    });
    expect(http.postJsonRequest).toHaveBeenCalledOnce();
    const request = requireRequest();
    expect(request).toMatchObject({
      url: "https://example.services.ai.azure.com/mai/v1/images/generations",
      timeoutMs: 12_345,
      allowPrivateNetwork: false,
    });
    expect(request.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(request.body).toEqual({
      model: "image-deployment",
      prompt: "draw a clean product render",
      width: 768,
      height: 1365,
    });
    expect(Object.fromEntries(requireHeaders(request.headers).entries())).toEqual({
      "api-key": "foundry-key",
      "content-type": "application/json",
    });
    expect(result.model).toBe("image-deployment");
    expect(result.images[0]?.buffer.toString()).toBe("png");
    expect(result.images[0]?.mimeType).toBe("image/png");
  });

  it("honors configured generated media caps above the default image limit", async () => {
    const imageBytes = Buffer.alloc(7 * 1024 * 1024, 1);
    http.postJsonRequest.mockResolvedValue(imageResponse(imageBytes.toString("base64")));

    const result = await generateImage({ cfg: buildConfig({ mediaMaxMb: 8 }) });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.buffer.byteLength).toBe(imageBytes.byteLength);
  });

  it("rejects oversized MAI image JSON responses", async () => {
    // One image result: the bound is the 64 MiB download ceiling as base64.
    http.postJsonRequest.mockResolvedValue(imageResponse("x".repeat(90 * 1024 * 1024)));

    await expect(generateImage()).rejects.toThrow(
      "microsoft-foundry.image-generation: JSON response exceeds",
    );
  });

  it("uses AZURE_OPENAI_ENDPOINT when env API-key auth has no configured base URL", async () => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://env.services.ai.azure.com");
    http.postJsonRequest.mockResolvedValue(imageResponse());

    await generateImage({
      prompt: "draw from env endpoint",
      cfg: buildConfig({ baseUrl: "" }),
    });

    expect(requireRequest().url).toBe(
      "https://env.services.ai.azure.com/mai/v1/images/generations",
    );
    expect(requireRequest().timeoutMs).toBe(600_000);
  });

  it("refreshes Entra ID auth and sends MAI image edits as multipart form data", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "__entra_id_dynamic__",
      mode: "api-key",
      profileId: "microsoft-foundry:entra",
      source: "profile:microsoft-foundry:entra",
    });
    prepareFoundryRuntimeAuthMock.mockResolvedValueOnce({
      apiKey: "entra-token",
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      expiresAt: Date.now() + 60_000,
    });
    http.resolveProviderHttpRequestConfig.mockImplementationOnce(
      (params: Record<string, unknown>) => ({
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork: false,
        headers: new Headers({
          ...(params.defaultHeaders as Record<string, string>),
          "Content-Type": "application/json",
        }),
        dispatcherPolicy: undefined,
      }),
    );
    http.postMultipartRequest.mockResolvedValue(
      imageResponse(Buffer.from("edited").toString("base64")),
    );

    const result = await generateImage({
      prompt: "make it brighter",
      agentDir: "/agent",
      inputImages: [
        {
          buffer: Buffer.from("input"),
          mimeType: "image/png",
          fileName: "input.png",
        },
      ],
    });

    expect(prepareFoundryRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/agent",
        provider: PROVIDER_ID,
        modelId: "image-deployment",
        apiKey: "__entra_id_dynamic__",
        authMode: "api-key",
        profileId: "microsoft-foundry:entra",
      }),
    );
    expect(http.postMultipartRequest).toHaveBeenCalledOnce();
    const request = requireRequest(http.postMultipartRequest);
    expect(request.url).toBe("https://example.services.ai.azure.com/mai/v1/images/edits");
    expect(Object.fromEntries(requireHeaders(request.headers).entries())).toEqual({
      authorization: "Bearer entra-token",
    });
    const form = request.body as FormData;
    expect(form.get("model")).toBe("image-deployment");
    expect(form.get("prompt")).toBe("make it brighter");
    const image = form.get("image");
    expect(image).toBeInstanceOf(Blob);
    expect((image as File).name).toBe("input.png");
    expect((image as File).type).toBe("image/png");
    expect(result.images[0]?.buffer.toString()).toBe("edited");
  });

  it("rejects image edits for MAI text-to-image-only deployments", async () => {
    await expectRejectedBeforeAuth(
      { cfg: buildConfig({ modelName: "MAI-Image-2e" }), inputImages },
      "MAI-Image-2e does not support Microsoft Foundry MAI image edits.",
      http.postMultipartRequest,
    );
  });

  it("requires an explicit deployment name before making requests", async () => {
    await expectRejectedBeforeAuth({ model: "" }, "requires a deployment name");
  });

  it("allows custom MAI deployment names for generation when model metadata is absent", async () => {
    http.postJsonRequest.mockResolvedValue(imageResponse());

    await generateImage({
      model: "prod-image",
      cfg: buildConfig({ includeModel: false }),
      size: "800x1000",
    });

    expect(http.postJsonRequest).toHaveBeenCalledOnce();
    expect(requireRequest().body).toEqual({
      model: "prod-image",
      prompt: "draw it",
      width: 800,
      height: 1000,
    });
  });

  it("allows custom mai-image deployment names for generation without model metadata", async () => {
    http.postJsonRequest.mockResolvedValue(imageResponse());

    await generateImage({
      model: "mai-image-2-live",
      cfg: buildConfig({ modelId: "mai-image-2-live", includeModel: false }),
    });

    expect(http.postJsonRequest).toHaveBeenCalledOnce();
    expect(requireRequest().body).toMatchObject({
      model: "mai-image-2-live",
    });
  });

  it("allows manual custom deployment names when configured name only repeats the id", async () => {
    http.postJsonRequest.mockResolvedValue(imageResponse());

    await generateImage({
      model: "prod-image",
      cfg: buildConfig({ modelId: "prod-image", modelName: "prod-image" }),
    });

    expect(http.postJsonRequest).toHaveBeenCalledOnce();
    expect(requireRequest().body).toEqual({
      model: "prod-image",
      prompt: "draw it",
      width: 1024,
      height: 1024,
    });
  });

  it("requires MAI-Image-2.5 metadata before editing custom deployment names", async () => {
    await expectRejectedBeforeAuth(
      { model: "prod-image", cfg: buildConfig({ includeModel: false }), inputImages },
      "edits require MAI-Image-2.5 model metadata",
      http.postMultipartRequest,
    );
  });

  it("rejects non-MAI image deployments before making requests", async () => {
    await expectRejectedBeforeAuth(
      {
        model: "gpt-deployment",
        cfg: buildConfig({ modelId: "gpt-deployment", modelName: "gpt-5.4" }),
      },
      'supports MAI image deployments only, got "gpt-5.4"',
    );
  });

  it("rejects literal non-image MAI model names before making requests", async () => {
    await expect(
      generateImage({
        model: "MAI-DS-R1",
        cfg: buildConfig({ includeModel: false }),
      }),
    ).rejects.toThrow('supports MAI image deployments only, got "MAI-DS-R1"');
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(http.postJsonRequest).not.toHaveBeenCalled();
  });

  it("rejects MAI image sizes outside Microsoft Foundry limits", async () => {
    await expect(generateImage({ size: "512x512" })).rejects.toThrow("at least 768x768");
    expect(http.postJsonRequest).not.toHaveBeenCalled();
  });
});
