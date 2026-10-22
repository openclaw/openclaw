import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftFoundryImageGenerationProvider } from "./image-generation-provider.js";
import { PROVIDER_ID } from "./shared.js";

const { http, isConfigured, refreshAuth, resolveAuth } = vi.hoisted(() => ({
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
  isConfigured: vi.fn(async () => true),
  refreshAuth: vi.fn(),
  resolveAuth: vi.fn(async () => ({
    apiKey: "foundry-key",
    mode: "api-key" as const,
    profileId: undefined as string | undefined,
    source: "test",
  })),
}));

// mock-isolation: Image request tests control credential availability independently of host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfiguredAsync: isConfigured,
}));

// mock-isolation: Credential resolution is fixture-controlled without reading the host auth store.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveAuth,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return { ...actual, ...http };
});

// mock-isolation: Token refresh is fixture-controlled without invoking Azure CLI or host credentials.
vi.mock("./runtime.js", () => ({
  prepareFoundryRuntimeAuth: refreshAuth,
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
  const model = {
    id: modelId,
    name: modelName,
    api: "openai-completions" as const,
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 0,
  };
  const provider = { baseUrl, api: model.api, models: includeModel ? [model] : [] };
  return {
    ...(mediaMaxMb !== undefined ? { agents: { defaults: { mediaMaxMb } } } : {}),
    models: { providers: { [PROVIDER_ID]: provider } },
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

function expectHeaders(request: Record<string, unknown>, expected: Record<string, string>) {
  const { headers } = request;
  if (!(headers instanceof Headers)) {
    throw new Error("expected request headers");
  }
  expect(Object.fromEntries(headers.entries())).toEqual(expected);
}

const inputImage = { buffer: Buffer.from("input"), mimeType: "image/png" };
const inputImages = [inputImage];
async function expectRejectedBeforeAuth(
  request: Partial<ImageGenerationRequest>,
  error: string,
  transport = http.postJsonRequest,
) {
  await expect(generateImage(request)).rejects.toThrow(error);
  expect(resolveAuth).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
}

describe("microsoft foundry image generation provider", () => {
  afterEach(() => {
    Object.values(http).forEach((mock) => mock.mockClear());
    isConfigured.mockClear();
    http.postJsonRequest.mockReset();
    http.postMultipartRequest.mockReset();
    refreshAuth.mockReset();
    resolveAuth.mockClear();
    vi.unstubAllEnvs();
  });

  it("exposes MAI image provider metadata and capabilities", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();
    const cfg = buildConfig();
    expect(provider).toMatchObject({
      id: PROVIDER_ID,
      models: [],
      capabilities: {
        generate: { maxCount: 1 },
        edit: { enabled: true, maxInputImages: 1 },
        output: { formats: ["png"] },
      },
    });
    expect(provider.defaultModel).toBeUndefined();
    expect(provider.capabilities.geometry?.sizes).toBeUndefined();
    expect(await provider.isConfiguredAsync?.({ agentDir: "/agent", cfg })).toBe(true);
    expect(isConfigured).toHaveBeenCalledWith({
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

    expect(resolveAuth).toHaveBeenCalledWith({
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
    expectHeaders(request, { "api-key": "foundry-key", "content-type": "application/json" });
    expect(request.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(request.body).toEqual({
      model: "image-deployment",
      prompt: "draw a clean product render",
      width: 768,
      height: 1365,
    });
    expect([result.model, result.images[0]?.buffer.toString(), result.images[0]?.mimeType]).toEqual(
      ["image-deployment", "png", "image/png"],
    );
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

    expect(requireRequest()).toMatchObject({
      url: "https://env.services.ai.azure.com/mai/v1/images/generations",
      timeoutMs: 600_000,
    });
  });

  it("refreshes Entra ID auth and sends MAI image edits as multipart form data", async () => {
    resolveAuth.mockResolvedValueOnce({
      apiKey: "__entra_id_dynamic__",
      mode: "api-key",
      profileId: "microsoft-foundry:entra",
      source: "profile:microsoft-foundry:entra",
    });
    refreshAuth.mockResolvedValueOnce({
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
      inputImages: [{ ...inputImage, fileName: "input.png" }],
    });

    expect(refreshAuth).toHaveBeenCalledWith(
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
    expectHeaders(request, { authorization: "Bearer entra-token" });
    const form = request.body as FormData;
    expect([form.get("model"), form.get("prompt")]).toEqual([
      "image-deployment",
      "make it brighter",
    ]);
    const image = form.get("image");
    expect(image).toBeInstanceOf(Blob);
    expect(image).toMatchObject({ name: "input.png", type: "image/png" });
    expect(result.images[0]?.buffer.toString()).toBe("edited");
  });

  it.each([
    ["prod-image", false, "800x1000", 800, 1000],
    ["mai-image-2-live", false, undefined, 1024, 1024],
    ["prod-image", true, undefined, 1024, 1024],
  ] as const)(
    "allows custom deployment %s with metadata=%s",
    async (model, includeModel, size, width, height) => {
      http.postJsonRequest.mockResolvedValue(imageResponse());
      await generateImage({
        model,
        cfg: buildConfig({ modelId: model, modelName: model, includeModel }),
        size,
      });
      expect(http.postJsonRequest).toHaveBeenCalledOnce();
      expect(requireRequest().body).toEqual({ model, prompt: "draw it", width, height });
    },
  );

  it.each([
    ["", "MAI-Image-2.5", false, "requires a deployment name"],
    [
      "image-deployment",
      "MAI-Image-2e",
      true,
      "MAI-Image-2e does not support Microsoft Foundry MAI image edits.",
    ],
    ["prod-image", undefined, true, "edits require MAI-Image-2.5 model metadata"],
    ["gpt-deployment", "gpt-5.4", false, 'supports MAI image deployments only, got "gpt-5.4"'],
    ["MAI-DS-R1", undefined, false, 'supports MAI image deployments only, got "MAI-DS-R1"'],
  ] as const)("rejects %s / %s before auth (edit=%s)", async (model, modelName, edit, error) => {
    await expectRejectedBeforeAuth(
      {
        model,
        cfg: buildConfig({ modelId: model, modelName, includeModel: modelName !== undefined }),
        ...(edit ? { inputImages } : {}),
      },
      error,
      edit ? http.postMultipartRequest : http.postJsonRequest,
    );
  });

  it("rejects MAI image sizes outside Microsoft Foundry limits", async () => {
    await expect(generateImage({ size: "512x512" })).rejects.toThrow("at least 768x768");
    expect(http.postJsonRequest).not.toHaveBeenCalled();
  });
});
