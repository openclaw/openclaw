// Microsoft Foundry image provider tests cover MAI request construction.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMicrosoftFoundryImageGenerationProvider } from "./image-generation-provider.js";
import { PROVIDER_ID } from "./shared.js";

const {
  assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadlineMock,
  isProviderApiKeyConfiguredMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  prepareFoundryRuntimeAuthMock,
  resolveApiKeyForProviderMock,
  resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => params),
  isProviderApiKeyConfiguredMock: vi.fn(() => true),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  prepareFoundryRuntimeAuthMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "foundry-key",
    mode: "api-key" as const,
    profileId: undefined as string | undefined,
    source: "test",
  })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) =>
      (params.deadline as { timeoutMs?: number }).timeoutMs ?? params.defaultTimeoutMs,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

// Transport helpers are mocked per-test, but readProviderJsonResponse is kept
// REAL (via importActual) so the byte-bounded reader actually caps oversized
// inline MAI image JSON instead of a stub.
vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    readProviderJsonResponse: actual.readProviderJsonResponse,
    assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
    createProviderOperationDeadline: createProviderOperationDeadlineMock,
    postJsonRequest: postJsonRequestMock,
    postMultipartRequest: postMultipartRequestMock,
    resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
    resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
    sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
  };
});

vi.mock("./runtime.js", () => ({
  prepareFoundryRuntimeAuth: prepareFoundryRuntimeAuthMock,
}));

function buildConfig(
  params: {
    modelId?: string;
    modelName?: string;
    baseUrl?: string;
    includeModel?: boolean;
  } = {},
): OpenClawConfig {
  const baseUrl = params.baseUrl ?? "https://example.services.ai.azure.com/openai/v1";
  const modelId = params.modelId ?? "image-deployment";
  const modelName = params.modelName ?? "MAI-Image-2.5";
  return {
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl,
          api: "openai-completions",
          models:
            params.includeModel === false
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

function releasedJson(payload: unknown) {
  return {
    response: Response.json(payload),
    release: vi.fn(async () => {}),
  };
}

// The image-sized JSON cap (64 MiB) matches the source constant
// MAX_IMAGE_GENERATION_JSON_BYTES.
const IMAGE_JSON_CAP_BYTES = 64 * 1024 * 1024;

// Builds a JSON body larger than the image cap so the bounded reader cancels the
// stream mid-flight instead of buffering the whole advertised payload.
function releasedOversizedJson() {
  const ONE_MIB = 1024 * 1024;
  const TOTAL_CHUNKS = 65; // > 64 MiB cap.
  const chunk = new Uint8Array(ONE_MIB);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= TOTAL_CHUNKS) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(async () => {}),
  };
}

function requirePostJsonRequest(): Record<string, unknown> {
  const request = postJsonRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object") {
    throw new Error("expected Microsoft Foundry JSON image request");
  }
  return request as Record<string, unknown>;
}

function requirePostMultipartRequest(): Record<string, unknown> {
  const request = postMultipartRequestMock.mock.calls[0]?.[0];
  if (!request || typeof request !== "object") {
    throw new Error("expected Microsoft Foundry multipart image request");
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

describe("microsoft foundry image generation provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    createProviderOperationDeadlineMock.mockClear();
    isProviderApiKeyConfiguredMock.mockClear();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    prepareFoundryRuntimeAuthMock.mockReset();
    resolveApiKeyForProviderMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    resolveProviderOperationTimeoutMsMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("exposes MAI image provider metadata and capabilities", () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.defaultModel).toBeUndefined();
    expect(provider.models).toEqual([]);
    expect(provider.capabilities.generate.maxCount).toBe(1);
    expect(provider.capabilities.edit.enabled).toBe(true);
    expect(provider.capabilities.edit.maxInputImages).toBe(1);
    expect(provider.capabilities.geometry?.sizes).toBeUndefined();
    expect(provider.capabilities.output?.formats).toEqual(["png"]);
    expect(provider.isConfigured?.({ agentDir: "/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: PROVIDER_ID,
      agentDir: "/agent",
    });
  });

  it("sends MAI image generation requests to the Foundry MAI endpoint with API-key auth", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    const result = await provider.generateImage({
      provider: PROVIDER_ID,
      model: "image-deployment",
      prompt: "draw a clean product render",
      cfg: buildConfig(),
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
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith({
      baseUrl: "https://example.services.ai.azure.com/mai/v1",
      defaultBaseUrl: "https://example.services.ai.azure.com/mai/v1",
      allowPrivateNetwork: false,
      defaultHeaders: { "api-key": "foundry-key" },
      request: undefined,
      provider: PROVIDER_ID,
      capability: "image",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(createProviderOperationDeadlineMock).toHaveBeenCalledWith({
      timeoutMs: 12_345,
      label: "Microsoft Foundry MAI image generation",
    });
    expect(resolveProviderOperationTimeoutMsMock).toHaveBeenCalledWith({
      deadline: { timeoutMs: 12_345, label: "Microsoft Foundry MAI image generation" },
      defaultTimeoutMs: 600_000,
    });
    const request = requirePostJsonRequest();
    expect(request.url).toBe("https://example.services.ai.azure.com/mai/v1/images/generations");
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
    expect(request.timeoutMs).toBe(12_345);
    expect(request.ssrfPolicy).toEqual({ allowPrivateNetwork: true });
    expect(result.model).toBe("image-deployment");
    expect(result.images[0]?.buffer.toString()).toBe("png");
    expect(result.images[0]?.mimeType).toBe("image/png");
  });

  it("parses a valid inline MAI image response within the image-sized JSON cap", async () => {
    // ~4 MiB of base64 image data: above bare metadata but well under the 64 MiB
    // image cap.
    const bigBase64 = Buffer.alloc(4 * 1024 * 1024, "a").toString("base64");
    postJsonRequestMock.mockResolvedValue(releasedJson({ data: [{ b64_json: bigBase64 }] }));
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    const result = await provider.generateImage({
      provider: PROVIDER_ID,
      model: "image-deployment",
      prompt: "large valid render",
      cfg: buildConfig(),
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.buffer.length).toBe(4 * 1024 * 1024);
  });

  it("rejects MAI image responses that exceed the image-sized JSON cap", async () => {
    postJsonRequestMock.mockResolvedValue(releasedOversizedJson());
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "image-deployment",
        prompt: "oversized render",
        cfg: buildConfig(),
      }),
    ).rejects.toThrow(`exceeds ${IMAGE_JSON_CAP_BYTES} bytes`);
  });

  it("uses AZURE_OPENAI_ENDPOINT when env API-key auth has no configured base URL", async () => {
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://env.services.ai.azure.com");
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await provider.generateImage({
      provider: PROVIDER_ID,
      model: "image-deployment",
      prompt: "draw from env endpoint",
      cfg: buildConfig({ baseUrl: "" }),
    });

    expect(requirePostJsonRequest().url).toBe(
      "https://env.services.ai.azure.com/mai/v1/images/generations",
    );
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
    resolveProviderHttpRequestConfigMock.mockImplementationOnce(
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
    postMultipartRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("edited").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    const result = await provider.generateImage({
      provider: PROVIDER_ID,
      model: "image-deployment",
      prompt: "make it brighter",
      cfg: buildConfig(),
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
    expect(postMultipartRequestMock).toHaveBeenCalledOnce();
    const request = requirePostMultipartRequest();
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
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "image-deployment",
        prompt: "edit it",
        cfg: buildConfig({ modelName: "MAI-Image-2e" }),
        inputImages: [{ buffer: Buffer.from("input"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("MAI-Image-2e does not support Microsoft Foundry MAI image edits.");
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("requires an explicit deployment name before making requests", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "",
        prompt: "draw it",
        cfg: buildConfig(),
      }),
    ).rejects.toThrow("requires a deployment name");
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("allows custom MAI deployment names for generation when model metadata is absent", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await provider.generateImage({
      provider: PROVIDER_ID,
      model: "prod-image",
      prompt: "draw it",
      cfg: buildConfig({ includeModel: false }),
      size: "800x1000",
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(requirePostJsonRequest().body).toEqual({
      model: "prod-image",
      prompt: "draw it",
      width: 800,
      height: 1000,
    });
  });

  it("allows custom mai-image deployment names for generation without model metadata", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await provider.generateImage({
      provider: PROVIDER_ID,
      model: "mai-image-2-live",
      prompt: "draw it",
      cfg: buildConfig({ modelId: "mai-image-2-live", includeModel: false }),
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(requirePostJsonRequest().body).toMatchObject({
      model: "mai-image-2-live",
    });
  });

  it("allows manual custom deployment names when configured name only repeats the id", async () => {
    postJsonRequestMock.mockResolvedValue(
      releasedJson({
        data: [{ b64_json: Buffer.from("png").toString("base64") }],
      }),
    );
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await provider.generateImage({
      provider: PROVIDER_ID,
      model: "prod-image",
      prompt: "draw it",
      cfg: buildConfig({ modelId: "prod-image", modelName: "prod-image" }),
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    expect(requirePostJsonRequest().body).toEqual({
      model: "prod-image",
      prompt: "draw it",
      width: 1024,
      height: 1024,
    });
  });

  it("requires MAI-Image-2.5 metadata before editing custom deployment names", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "prod-image",
        prompt: "edit it",
        cfg: buildConfig({ includeModel: false }),
        inputImages: [{ buffer: Buffer.from("input"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("edits require MAI-Image-2.5 model metadata");
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("rejects non-MAI image deployments before making requests", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "gpt-deployment",
        prompt: "draw it",
        cfg: buildConfig({ modelId: "gpt-deployment", modelName: "gpt-5.4" }),
      }),
    ).rejects.toThrow('supports MAI image deployments only, got "gpt-5.4"');
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects literal non-image MAI model names before making requests", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "MAI-DS-R1",
        prompt: "draw it",
        cfg: buildConfig({ includeModel: false }),
      }),
    ).rejects.toThrow('supports MAI image deployments only, got "MAI-DS-R1"');
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("rejects MAI image sizes outside Microsoft Foundry limits", async () => {
    const provider = buildMicrosoftFoundryImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: PROVIDER_ID,
        model: "image-deployment",
        prompt: "draw it",
        cfg: buildConfig(),
        size: "512x512",
      }),
    ).rejects.toThrow("at least 768x768");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
