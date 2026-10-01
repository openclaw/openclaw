// Finish lazy SDK/worker fixture initialization during collection so a cold import
// cannot outlive a test and resume against the next test's reset mocks.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexApiKeyAuthStore,
  createCodexOAuthAuthStore,
  createCodexTokenAuthStore,
  createMixedCodexAuthStore,
  createMixedOpenAIAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

const {
  ensureAuthProfileStoreMock,
  isProviderApiKeyConfiguredMock,
  listProfilesForProviderMock,
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
  logInfoMock,
} = vi.hoisted(() => ({
  ensureAuthProfileStoreMock: vi.fn(() => ({ version: 1, profiles: {} })),
  isProviderApiKeyConfiguredMock: vi.fn<
    (params: { provider: string; agentDir?: string }) => boolean
  >(() => false),
  listProfilesForProviderMock: vi.fn(
    (store: { profiles?: Record<string, { provider?: string }> }, provider: string) =>
      Object.entries(store.profiles ?? {})
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  ),
  resolveApiKeyForProviderMock: vi.fn(
    async (_params?: {
      provider?: string;
    }): Promise<{ apiKey?: string; source?: string; mode?: string }> => ({
      apiKey: "openai-key",
    }),
  ),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => {
    const headers = new Headers(params.defaultHeaders);
    new Headers(params.headers).forEach((value, key) => headers.set(key, value));
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(
        params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork,
      ),
      headers,
      dispatcherPolicy: undefined,
    };
  }),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
  logInfoMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  listProfilesForProvider: listProfilesForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  // Pass-through: bounded-reader enforcement is tested via bounded-reader unit tests.
  readProviderJsonResponse: async (response: { json(): Promise<unknown> }) => response.json(),
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const noopRelease = async () => {};
const generatedPngRequest = {
  response: {
    json: async () => ({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] }),
  },
  release: noopRelease,
};

function mockGeneratedPngResponse() {
  postJsonRequestMock.mockResolvedValue(generatedPngRequest);
  postMultipartRequestMock.mockResolvedValue(generatedPngRequest);
}

function mockCodexRawStream(body: string) {
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(body),
    release: noopRelease,
  }));
}

function mockCodexEvents(events: unknown[]) {
  mockCodexRawStream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

function imageItem(
  result: string | null = Buffer.from("codex-image").toString("base64"),
  status?: string,
) {
  return { type: "image_generation_call", result, ...(status ? { status } : {}) };
}

function done(item = imageItem()) {
  return { type: "response.output_item.done", item };
}

function completed(output: unknown[] = []) {
  return { type: "response.completed", response: { output } };
}

function mockCodexImageStream() {
  mockCodexEvents([done(), completed()]);
}

function mockCodexAuthOnly() {
  resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) =>
    params?.provider === "openai"
      ? { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" }
      : {},
  );
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type HttpConfigCall = {
  allowPrivateNetwork?: boolean;
  api?: string;
  baseUrl?: string;
  capability?: string;
  defaultBaseUrl?: string;
  defaultHeaders?: Record<string, string>;
  provider?: string;
  request?: unknown;
};

type RequestCall = {
  allowPrivateNetwork?: boolean;
  body?: unknown;
  dispatcherPolicy?: unknown;
  fetchFn?: typeof fetch;
  headers?: Headers;
  ssrfPolicy?: unknown;
  timeoutMs?: number;
  url?: string;
};

type AuthResolutionCall = {
  cfg?: {
    models?: {
      providers?: {
        openai?: {
          auth?: string;
        };
      };
    };
  };
  credentialPrecedence?: string;
  provider?: string;
  store?: unknown;
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function jsonRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postJsonRequestMock, callIndex) as RequestCall;
}

function multipartRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postMultipartRequestMock, callIndex) as RequestCall;
}

function httpConfigCall(callIndex = 0): HttpConfigCall {
  return mockCallArg(resolveProviderHttpRequestConfigMock, callIndex) as HttpConfigCall;
}

function authResolutionCall(callIndex = 0): AuthResolutionCall {
  return mockCallArg(resolveApiKeyForProviderMock, callIndex) as AuthResolutionCall;
}

describe("openai image generation provider", () => {
  const provider = buildOpenAIImageGenerationProvider({
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
    listProfilesForProvider: listProfilesForProviderMock,
    isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  });
  const emptyConfig: OpenClawConfig = {};
  type OpenAIImageRequest = Parameters<typeof provider.generateImage>[0];
  const generateOpenAIImage = (
    prompt: string,
    request: Omit<Partial<OpenAIImageRequest>, "prompt" | "provider"> = {},
  ) =>
    provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt,
      cfg: emptyConfig,
      ...request,
    });

  afterEach(() => {
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    isProviderApiKeyConfiguredMock.mockReset();
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    listProfilesForProviderMock.mockClear();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openai-key" });
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
    logInfoMock.mockClear();
    vi.unstubAllEnvs();
  });

  beforeEach(mockGeneratedPngResponse);

  it.each(["none", "codex", "api-key"] as const)(
    "selects an image-capable credential with SIWC first and %s configured",
    async (additional) => {
      vi.stubEnv("OPENAI_API_KEY", "");
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:siwc": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-token-sharing",
            access: "siwc-access",
            refresh: "siwc-refresh",
            expires: Date.now() + 3_600_000,
          },
          ...(additional === "codex"
            ? createCodexTokenAuthStore().profiles
            : additional === "api-key"
              ? createCodexApiKeyAuthStore().profiles
              : {}),
        },
      };
      const realAuth = await vi.importActual<
        typeof import("openclaw/plugin-sdk/provider-auth-runtime")
      >("openclaw/plugin-sdk/provider-auth-runtime");
      resolveApiKeyForProviderMock.mockImplementation((params) =>
        realAuth.resolveApiKeyForProvider({ ...params, provider: "openai", store }),
      );
      if (additional === "api-key") {
        mockGeneratedPngResponse();
      } else {
        mockCodexImageStream();
      }
      const request = generateOpenAIImage("Draw an avatar", {
        authStore: store,
        cfg: { auth: { order: { openai: Object.keys(store.profiles) } } },
      });
      if (additional === "none") {
        await expect(request).rejects.toThrow("OpenAI API key or Codex OAuth missing");
        expect(postJsonRequestMock).not.toHaveBeenCalled();
        expect(postMultipartRequestMock).not.toHaveBeenCalled();
        return;
      }
      expect((await request).images).toHaveLength(1);
      const call = jsonRequestCall();
      expect(new Headers(call.headers).get("authorization")).toBe(
        `Bearer ${additional === "codex" ? "codex-token" : "codex-api-key"}`,
      );
      expect(call.url).toBe(
        additional === "codex"
          ? "https://chatgpt.com/backend-api/codex/responses"
          : "https://api.openai.com/v1/images/generations",
      );
    },
  );

  it.each([false, true])(
    "sets private-network permission from browser opt-in: %s",
    async (allow) => {
      const cfg = openAIImageConfig({
        baseUrl: "http://127.0.0.1:44080/v1",
        ...(allow ? { apiKey: "local-noauth" } : {}),
      });
      if (allow) {
        cfg.browser = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };
      }
      const result = await generateOpenAIImage("Private endpoint", {
        cfg,
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
      expect(jsonRequestCall()).toMatchObject({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: allow,
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
      expect(result.images).toHaveLength(1);
    },
  );

  it("allows loopback for the synthetic mock-openai provider", async () => {
    await provider.generateImage({
      provider: "mock-openai",
      model: "gpt-image-2",
      prompt: "QA lighthouse",
      cfg: openAIImageConfig({ baseUrl: "http://127.0.0.1:44080/v1" }),
    });
    expect(jsonRequestCall()).toMatchObject({
      url: "http://127.0.0.1:44080/v1/images/generations",
      allowPrivateNetwork: true,
    });
  });

  it("uses a model-specific QA image endpoint without changing the text provider route", async () => {
    mockGeneratedPngResponse();
    vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

    await generateOpenAIImage("Draw a QA lighthouse", {
      model: "gpt-image-1",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-image-1",
                  name: "gpt-image-1",
                  api: "openai-responses",
                  baseUrl: "http://127.0.0.1:44080/v1",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    });

    expect(httpConfigCall().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(jsonRequestCall().url).toBe("http://127.0.0.1:44080/v1/images/generations");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
  });

  it("serializes a direct JPEG generation request and decodes its image", async () => {
    const result = await generateOpenAIImage("Landscape preview", {
      count: 2,
      size: "1024x640",
      quality: "low",
      outputFormat: "jpeg",
      providerOptions: {
        openai: {
          background: "opaque",
          moderation: "low",
          outputCompression: 60,
          user: "end-user-42",
        },
      },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().body).toEqual({
      model: "gpt-image-2",
      prompt: "Landscape preview",
      n: 2,
      size: "1024x640",
      quality: "low",
      output_format: "jpeg",
      background: "opaque",
      moderation: "low",
      output_compression: 60,
      user: "end-user-42",
    });
    expect(result).toEqual({
      model: "gpt-image-2",
      images: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/jpeg", fileName: "image-1.jpg" },
      ],
    });
  });

  it("preserves automatic dimensions for models that support them", async () => {
    const result = await generateOpenAIImage("Automatic dimensions", {
      model: "gpt-image-2.5-sunburst",
      size: "auto",
    });
    expect(jsonRequestCall().body).toMatchObject({ model: "gpt-image-2.5-sunburst", size: "auto" });
    expect(result.metadata).toBeUndefined();
  });

  it.each(["1024x624", "1025x1024", "3088x1024", "4096x2048", "2896x2896"])(
    "normalizes unsupported flexible-model dimensions %s",
    async (size) => {
      mockGeneratedPngResponse();

      const result = await generateOpenAIImage("Normalize unsupported image dimensions", {
        size,
      });

      const normalizedSize = (jsonRequestCall().body as { size: string }).size;
      expect(normalizedSize).not.toBe(size);
      expect(provider.capabilities.geometry?.sizes).toContain(normalizedSize);
      expect(result.metadata).toEqual({ requestedSize: size, normalizedSize });
    },
  );

  it("normalizes legacy native image dimensions", async () => {
    const result = await generateOpenAIImage("Wide image", {
      model: "gpt-image-1",
      size: "2048x1152",
    });
    expect(jsonRequestCall().body).toMatchObject({ model: "gpt-image-1", size: "1536x1024" });
    expect(result.metadata).toEqual({ requestedSize: "2048x1152", normalizedSize: "1536x1024" });
  });

  it("preserves custom-endpoint model and geometry choices", async () => {
    const result = await generateOpenAIImage("Transparent custom image", {
      cfg: openAIImageConfig({ baseUrl: "https://openai-compatible.example.com/v1" }),
      size: "1024x624",
      outputFormat: "png",
      background: "transparent",
    });
    expect(jsonRequestCall().url).toBe(
      "https://openai-compatible.example.com/v1/images/generations",
    );
    expect(jsonRequestCall().body).toMatchObject({
      model: "gpt-image-2",
      size: "1024x624",
      background: "transparent",
    });
    expect(result.metadata).toBeUndefined();
  });

  it("falls back to the provider baseUrl when the model catalog is omitted", async () => {
    mockGeneratedPngResponse();

    // Plugin-scoped runtime snapshots can carry a built-in provider overlay
    // before its model catalog is present.
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.com/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = await generateOpenAIImage("Create an image through a provider overlay", {
      cfg,
    });

    expect(httpConfigCall().baseUrl).toBe("https://openai-compatible.example.com/v1");
    expect(jsonRequestCall().url).toBe(
      "https://openai-compatible.example.com/v1/images/generations",
    );
    expect(result.images).toHaveLength(1);
  });

  it("routes transparent PNG generation to the alpha-capable model without compression", async () => {
    const result = await generateOpenAIImage("Transparent sticker", {
      outputFormat: "png",
      background: "transparent",
      providerOptions: { openai: { outputCompression: 60 } },
    });
    expect(jsonRequestCall().body).toEqual({
      model: "gpt-image-1.5",
      prompt: "Transparent sticker",
      n: 1,
      size: "1024x1024",
      output_format: "png",
      background: "transparent",
    });
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("serializes multipart edits with reference names, geometry, output options, and SSRF policy", async () => {
    const result = await generateOpenAIImage("Edit as WebP", {
      model: "gpt-image-2-2026-04-21",
      count: 2,
      size: "864x1536",
      quality: "high",
      outputFormat: "webp",
      cfg: openAIImageConfig({ baseUrl: "http://127.0.0.1:44080/v1" }),
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "reference.png" },
        { buffer: Buffer.from("jpeg-bytes"), mimeType: "image/jpeg" },
      ],
      providerOptions: {
        openai: {
          background: "transparent",
          moderation: "low",
          outputCompression: 75,
          user: "end-user-99",
        },
      },
    });
    const request = multipartRequestCall();
    expect(request).toMatchObject({
      url: "http://127.0.0.1:44080/v1/images/edits",
      allowPrivateNetwork: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      dispatcherPolicy: undefined,
      fetchFn: fetch,
    });
    expect(request.headers?.has("Content-Type")).toBe(false);
    const form = request.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("Expected multipart edit");
    }
    expect(Object.fromEntries([...form].filter(([key]) => key !== "image[]"))).toEqual({
      model: "gpt-image-2-2026-04-21",
      prompt: "Edit as WebP",
      n: "2",
      size: "864x1536",
      quality: "high",
      output_format: "webp",
      background: "transparent",
      moderation: "low",
      output_compression: "75",
      user: "end-user-99",
    });
    expect(form.getAll("image[]")).toEqual([
      expect.objectContaining({ name: "reference.png", type: "image/png" }),
      expect.objectContaining({ name: "image-2.jpg", type: "image/jpeg" }),
    ]);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(result.images[0]).toEqual({
      buffer: Buffer.from("png-bytes"),
      mimeType: "image/webp",
      fileName: "image-1.webp",
    });
  });

  it("uses native images when mixed subscription profiles resolve to an API key", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "codex-api-key", mode: "api-key" });
    await generateOpenAIImage("Selected API key", { authStore: createMixedCodexAuthStore() });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer codex-api-key");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it("forces explicit API-key config through native image auth", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: AuthResolutionCall) =>
      params?.cfg?.models?.providers?.openai?.auth === "api-key"
        ? { apiKey: "configured-openai-key", mode: "api-key" }
        : { apiKey: "chatgpt-oauth-token", mode: "oauth" },
    );
    const authStore = createMixedOpenAIAuthStore();
    await generateOpenAIImage("Explicit API key", {
      cfg: openAIImageConfig({ apiKey: "sk-configured", baseUrl: "https://api.openai.com/v1" }),
      authStore,
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(authResolutionCall()).toMatchObject({
      provider: "openai",
      store: authStore,
      credentialPrecedence: "env-first",
      cfg: { models: { providers: { openai: { auth: "api-key" } } } },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer configured-openai-key");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it.each(["https://openai-compatible.example.test/v1", "https://api.openai.com/v1?proxy=1"])(
    "does not send subscription credentials to %s",
    async (baseUrl) => {
      mockCodexAuthOnly();
      await expect(
        generateOpenAIImage("Custom endpoint", { cfg: openAIImageConfig({ baseUrl }) }),
      ).rejects.toThrow("OpenAI API key missing");
      expect(postJsonRequestMock).not.toHaveBeenCalled();
      expect(postMultipartRequestMock).not.toHaveBeenCalled();
    },
  );

  it("propagates unexpected auth failures without making a request", async () => {
    resolveApiKeyForProviderMock.mockRejectedValue(new Error("Keychain unavailable"));
    await expect(generateOpenAIImage("Auth error")).rejects.toThrow("Keychain unavailable");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("keeps explicit OpenAI request settings on the native transport", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openai-key", mode: "api-key" });
    await generateOpenAIImage("Explicit settings", {
      cfg: openAIImageConfig({
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        headers: { "X-Test-OpenAI": "direct" },
        request: { allowPrivateNetwork: true },
      }),
      authStore: createCodexOAuthAuthStore(),
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
    expect(httpConfigCall()).toMatchObject({
      api: "openai-responses",
      request: { allowPrivateNetwork: true },
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("X-Test-OpenAI")).toBe("direct");
  });

  it("uses Azure deployment-scoped JSON requests and its default timeout", async () => {
    await generateOpenAIImage("Transparent Azure sticker", {
      cfg: openAIImageConfig({ baseUrl: "https://myresource.openai.azure.com/openai/v1" }),
      outputFormat: "png",
      background: "transparent",
    });
    expect(jsonRequestCall()).toMatchObject({
      url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      timeoutMs: 600_000,
      body: {
        prompt: "Transparent Azure sticker",
        n: 1,
        size: "1024x1024",
        output_format: "png",
        background: "transparent",
      },
    });
    expect(jsonRequestCall().body).not.toHaveProperty("model");
    expect(jsonRequestCall().headers?.get("api-key")).toBe("openai-key");
    expect(jsonRequestCall().headers?.has("authorization")).toBe(false);
  });

  it("uses Azure deployment-scoped multipart requests with explicit version and timeout", async () => {
    vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-01-01");
    await generateOpenAIImage("Change background", {
      model: "gpt-image-2-1",
      timeoutMs: 123_456,
      cfg: openAIImageConfig({ baseUrl: "https://myresource.services.ai.azure.com/v1" }),
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "reference.png" },
      ],
    });
    const request = multipartRequestCall();
    expect(request).toMatchObject({
      url: "https://myresource.services.ai.azure.com/openai/deployments/gpt-image-2-1/images/edits?api-version=2025-01-01",
      timeoutMs: 123_456,
    });
    expect(request.headers?.get("api-key")).toBe("openai-key");
    if (!(request.body instanceof FormData)) {
      throw new Error("Expected multipart edit");
    }
    expect(request.body.has("model")).toBe(false);
    expect(request.body.get("prompt")).toBe("Change background");
    expect(request.body.get("size")).toBe("1024x1024");
  });

  describe("Codex Responses", () => {
    beforeEach(() => {
      mockCodexAuthOnly();
      mockCodexImageStream();
    });

    it("serializes reference-image requests and caps the per-image Responses calls", async () => {
      mockCodexEvents([
        {
          type: "response.output_item.done",
          item: { ...imageItem(), revised_prompt: "revised prompt" },
        },
        {
          type: "response.completed",
          response: {
            usage: { total_tokens: 30 },
            tool_usage: { image_gen: { total_tokens: 30 } },
          },
        },
      ]);
      const result = await generateOpenAIImage("Use the reference", {
        authStore: { version: 1, profiles: {} },
        count: 12,
        size: "1024x1536",
        quality: "low",
        outputFormat: "jpeg",
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        providerOptions: {
          openai: { background: "opaque", moderation: "low", outputCompression: 55 },
        },
      });
      expect(postJsonRequestMock).toHaveBeenCalledTimes(4);
      expect(jsonRequestCall()).toMatchObject({
        url: "https://chatgpt.com/backend-api/codex/responses",
        timeoutMs: 180_000,
        body: {
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Use the reference" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,cG5nLWJ5dGVz",
                  detail: "auto",
                },
              ],
            },
          ],
          instructions: "You are an image generation assistant.",
          stream: true,
          store: false,
          tools: [
            {
              type: "image_generation",
              model: "gpt-image-2",
              size: "1024x1536",
              quality: "low",
              output_format: "jpeg",
              background: "opaque",
              moderation: "low",
              output_compression: 55,
            },
          ],
          tool_choice: { type: "image_generation" },
        },
      });
      expect(jsonRequestCall().headers?.get("authorization")).toBe("Bearer codex-key");
      expect(result.images.map((image) => image.fileName)).toEqual([
        "image-1.jpg",
        "image-2.jpg",
        "image-3.jpg",
        "image-4.jpg",
      ]);
      expect(result.images[0]).toEqual({
        buffer: Buffer.from("codex-image"),
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "revised prompt",
      });
      expect(result.metadata?.responses).toEqual(
        Array.from({ length: 4 }, () => ({
          usage: { total_tokens: 30 },
          toolUsage: { image_gen: { total_tokens: 30 } },
        })),
      );
      expect(postMultipartRequestMock).not.toHaveBeenCalled();
    });

    it("honors configured transport overrides for transparent PNG requests", async () => {
      const result = await generateOpenAIImage("Transparent sticker", {
        cfg: openAIImageConfig({
          baseUrl: "http://127.0.0.1:44220/backend-api/codex",
          api: "openai-chatgpt-responses",
          request: { allowPrivateNetwork: true },
        }),
        authStore: createCodexOAuthAuthStore(),
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
        outputFormat: "png",
        providerOptions: { openai: { background: "transparent", outputCompression: 55 } },
      });
      expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
        allowPrivateNetwork: true,
      });
      expect(jsonRequestCall()).toMatchObject({
        url: "http://127.0.0.1:44220/backend-api/codex/responses",
        allowPrivateNetwork: true,
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
      expect(jsonRequestCall().body).toHaveProperty("tools", [
        {
          type: "image_generation",
          model: "gpt-image-1.5",
          size: "1024x1024",
          output_format: "png",
          background: "transparent",
        },
      ]);
      expect(result.model).toBe("gpt-image-1.5");
    });

    it("canonicalizes a legacy Codex endpoint", async () => {
      await generateOpenAIImage("Legacy endpoint", {
        cfg: openAIImageConfig({
          baseUrl: "https://chatgpt.com/backend-api/codex/v1",
          api: "openai-chatgpt-responses",
        }),
        authStore: createMixedOpenAIAuthStore(),
      });
      expect(resolveApiKeyForProviderMock).toHaveBeenCalledOnce();
      expect(httpConfigCall()).toMatchObject({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        provider: "openai",
        api: "openai-chatgpt-responses",
        capability: "image",
      });
      expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
    });

    it("sanitizes auth logs and truncates without splitting surrogate pairs", async () => {
      resolveApiKeyForProviderMock.mockResolvedValue({
        apiKey: "codex-key",
        mode: "oauth\nfake\u202eignored",
      });
      await generateOpenAIImage("Safe logs", {
        model: `${"a".repeat(255)}😀tail`,
        authStore: createCodexOAuthAuthStore(),
      });
      expect(logInfoMock).toHaveBeenCalledWith(
        expect.stringContaining(
          `mode=oauth fakeignored transport=codex-responses requestedModel=${"a".repeat(255)}... responsesModel=`,
        ),
      );
    });

    it("uses completed image bytes and metadata instead of malformed interim data", async () => {
      mockCodexEvents([
        done(imageItem("not valid base64")),
        {
          type: "response.completed",
          response: {
            output: [{ ...imageItem(), revised_prompt: "completed prompt" }],
            usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
          },
        },
      ]);
      const result = await generateOpenAIImage("Completed image");
      expect(result.images).toEqual([
        {
          buffer: Buffer.from("codex-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "completed prompt",
        },
      ]);
      expect(result.metadata).toEqual({
        responses: [
          {
            usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
            toolUsage: undefined,
          },
        ],
      });
    });

    it("parses multiline SSE without optional spaces and trims Unicode image whitespace", async () => {
      const event = JSON.stringify(done(imageItem("\u0085aGVsbG8=\u0085")));
      mockCodexRawStream(
        `data:${event.replace(',"item":', ',\ndata:"item":')}\n\ndata:${JSON.stringify(completed())}\n\n`,
      );
      expect((await generateOpenAIImage("Framed image")).images[0]?.buffer).toEqual(
        Buffer.from("hello"),
      );
    });

    it.each([
      {
        name: "authoritative failure after malformed interim data",
        events: [
          done(imageItem("invalid base64")),
          {
            type: "response.failed",
            response: { error: { code: "rate_limit_exceeded", message: "quota was exhausted" } },
          },
        ],
        error: /quota was exhausted/,
      },
      {
        name: "incomplete turn",
        events: [
          {
            type: "response.incomplete",
            response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
          },
        ],
        error: /incomplete.*max_output_tokens/i,
      },
      {
        name: "stream closed before completion",
        events: [done()],
        error: /closed before response\.completed/i,
      },
    ])("rejects $name", async ({ events, error }) => {
      mockCodexEvents(events);
      await expect(generateOpenAIImage("Rejected turn")).rejects.toThrow(error);
    });

    it.each([
      { status: "completed", result: null, error: /did not produce an image/i },
      {
        status: "failed",
        result: Buffer.from("failed-image").toString("base64"),
        error: /image call did not complete/i,
      },
    ])(
      "rejects authoritative $status output instead of using a stale interim image",
      async ({ status, result, error }) => {
        mockCodexEvents([
          done(imageItem(undefined, "completed")),
          completed([imageItem(result, status)]),
        ]);
        await expect(generateOpenAIImage("Authoritative output")).rejects.toThrow(error);
      },
    );

    it.each([
      {
        name: "invalid alphabet in completed output",
        events: [completed([imageItem("aGVs!bG8=")])],
      },
      {
        name: "noncanonical trailing bits in interim output",
        events: [done(imageItem("Zh==")), completed()],
      },
    ])("rejects $name", async ({ events }) => {
      mockCodexEvents(events);
      await expect(generateOpenAIImage("Malformed image")).rejects.toThrow(
        "OpenAI Codex image generation returned malformed base64 image data",
      );
    });

    it("cancels oversized Codex OAuth image response streams", async () => {
      let canceled = false;
      let chunkSent = false;
      const release = vi.fn(async () => {});
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunkSent) {
            return;
          }
          chunkSent = true;
          controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1));
        },
        cancel() {
          canceled = true;
        },
      });
      postJsonRequestMock.mockResolvedValue({
        response: new Response(stream),
        release,
      });

      await expect(
        generateOpenAIImage("Draw an oversized Codex lighthouse", {
          authStore: createCodexOAuthAuthStore(),
        }),
      ).rejects.toThrow("OpenAI Codex image generation response exceeded size limit");
      expect(canceled).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it("rejects streams exceeding the SSE event limit", async () => {
      mockCodexEvents(
        Array.from({ length: 513 }, (_, index) => ({
          type: "response.output_text.delta",
          delta: String(index),
        })),
      );
      await expect(generateOpenAIImage("Noisy stream")).rejects.toThrow(
        "OpenAI Codex image generation response exceeded event limit",
      );
    });
  });
});
