import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import {
  discoverLmstudioModels,
  ensureLmstudioModelLoaded,
  fetchLmstudioModels,
} from "./models.fetch.js";
import {
  mapLmstudioWireEntry,
  normalizeLmstudioConfiguredCatalogEntry,
  normalizeLmstudioProviderConfig,
  resolveLmstudioReasoningCompat,
} from "./models.js";

const guardedFetch = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: (...args: unknown[]) => guardedFetch(...args) };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

// Direct helpers retain undefined-vs-empty compat semantics hidden by discovery.
describe("lmstudio-models", () => {
  const asFetch = (mock: unknown) => mock as typeof fetch;
  const baseUrl = "http://localhost:1234/v1";
  const modelKey = "qwen3-8b-instruct";
  const loadModel = (options: Partial<Parameters<typeof ensureLmstudioModelLoaded>[0]> = {}) =>
    ensureLmstudioModelLoaded({ baseUrl, modelKey, ...options });
  const discover = (
    fetchMock: unknown,
    options: Partial<Parameters<typeof discoverLmstudioModels>[0]> = {},
  ) =>
    discoverLmstudioModels({
      baseUrl,
      apiKey: "lm-token",
      quiet: true,
      fetchImpl: asFetch(fetchMock),
      ...options,
    });
  const fetchModels = (
    fetchMock: unknown,
    options: Partial<Parameters<typeof fetchLmstudioModels>[0]> = {},
  ) => fetchLmstudioModels({ baseUrl, fetchImpl: asFetch(fetchMock), ...options });
  const catalog = (models: unknown[]) =>
    vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ models }));
  const parseBody = (init: RequestInit | undefined): unknown => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected request body to be a JSON string");
    }
    return JSON.parse(init.body) as unknown;
  };
  const mockLoad = (params?: {
    key?: string;
    variants?: unknown;
    selectedVariant?: unknown;
    loadedContextLength?: number;
    maxContextLength?: number;
    loadResponse?: () => Response;
  }) =>
    vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const key = params?.key ?? "qwen3-8b-instruct";
      if (String(url).endsWith("/api/v1/models")) {
        return Response.json({
          models: [
            {
              type: "llm",
              key,
              max_context_length: params?.maxContextLength,
              variants: params?.variants,
              selected_variant: params?.selectedVariant,
              loaded_instances: params?.loadedContextLength
                ? [{ id: "inst-1", config: { context_length: params.loadedContextLength } }]
                : [],
            },
          ],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return (
          params?.loadResponse?.() ??
          Response.json({ status: "loaded", instance_id: "inst-loaded" })
        );
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
  const loadCall = (fetchMock: ReturnType<typeof mockLoad>) =>
    fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/models/load"));
  const expectLoadContext = (fetchMock: ReturnType<typeof mockLoad>, contextLength: number) => {
    expect(parseBody(loadCall(fetchMock)?.[1])).toMatchObject({ context_length: contextLength });
  };
  afterEach(() => {
    guardedFetch.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("marks configured LM Studio endpoints as trusted private-network model targets", () => {
    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://192.168.1.10:1234",
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://192.168.1.10:1234/v1",
      request: { allowPrivateNetwork: true },
      models: [],
    });

    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://gpu-box.local:1234/v1",
        request: { allowPrivateNetwork: false, headers: { "X-Proxy-Auth": "token" } },
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://gpu-box.local:1234/v1",
      request: { allowPrivateNetwork: false, headers: { "X-Proxy-Auth": "token" } },
      models: [],
    });
  });

  it("rejects malformed and unapproved configured compatibility fields", () => {
    expect(
      normalizeLmstudioConfiguredCatalogEntry({
        id: "qwen/qwen3-1.7b",
        compat: {
          supportsStore: "false",
          supportsPromptCacheKey: 1,
          visibleReasoningDetailTypes: ["reasoning.summary", 1],
          maxTokensField: "max_output_tokens",
          codeMode: "unsupported",
          thinkingFormat: "unsupported",
          toolSchemaProfile: 1,
          unsupportedToolSchemaKeywords: ["additionalProperties", ""],
          toolCallArgumentsEncoding: false,
          requiresOpenAiAnthropicToolPayload: "true",
          unapprovedCompatField: true,
        },
      }),
    ).toMatchObject({ id: "qwen/qwen3-1.7b", compat: undefined });
  });

  it("uses the loaded context as the effective runtime budget", () => {
    const model = mapLmstudioWireEntry({
      type: "llm",
      key: "small-loaded-context",
      max_context_length: 262_144,
      loaded_instances: [{ id: "loaded", config: { context_length: 8_192 } }],
    });

    expect(model).toMatchObject({
      id: "small-loaded-context",
      contextWindow: 262_144,
      contextTokens: 8_192,
      maxTokens: 8_192,
      loaded: true,
    });
  });

  it("omits reasoning compatibility when only off is supported", () => {
    expect(
      resolveLmstudioReasoningCompat({
        capabilities: { reasoning: { allowed_options: ["off"], default: "off" } },
      }),
    ).toBeUndefined();
  });

  it("discovers llm models and maps metadata", async () => {
    const fetchMock = catalog([
      {
        type: "llm",
        key: "qwen3-8b-instruct",
        display_name: "Qwen3 8B",
        max_context_length: 262144,
        format: "mlx",
        capabilities: {
          vision: true,
          trained_for_tool_use: true,
          reasoning: { allowed_options: ["off", "on"], default: "on" },
        },
        loaded_instances: [{ id: "inst-1", config: { context_length: 98_304 } }],
      },
      { type: "llm", key: "deepseek-r1" },
      {
        type: "llm",
        key: "graded-reasoning",
        capabilities: {
          reasoning: { allowed_options: ["low", "medium", "high"], default: "low" },
        },
      },
      {
        type: "llm",
        key: "off-only-reasoning",
        capabilities: { reasoning: { allowed_options: ["off"], default: "off" } },
      },
      { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" },
      { type: "llm", key: "   " },
    ]);

    const models = await discover(fetchMock, { quiet: false });

    const modelsRequest = fetchMock.mock.calls.find(
      ([url]) => url === "http://localhost:1234/api/v1/models",
    );
    const modelsRequestOptions = modelsRequest?.[1];
    expect(modelsRequestOptions?.headers).toEqual({ Authorization: "Bearer lm-token" });
    expect(modelsRequestOptions?.signal).toBeInstanceOf(AbortSignal);

    expect(models).toHaveLength(4);
    expect(models[0]).toEqual({
      id: "qwen3-8b-instruct",
      name: "Qwen3 8B (MLX, vision, tool-use, loaded)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
        supportsTools: true,
      },
      contextWindow: 262144,
      contextTokens: 98_304,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    expect(models[1]).toEqual({
      id: "deepseek-r1",
      name: "deepseek-r1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true },
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    expect(models[2]).toMatchObject({ id: "graded-reasoning", reasoning: true });
    expect(models[2]?.compat).toEqual({
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: { adaptive: "high", max: "high" },
    });
    expect(models[3]).toMatchObject({ id: "off-only-reasoning", reasoning: false });
    expect(models[3]?.compat).toEqual({ supportsUsageInStreaming: true });
  });

  it.each([
    { allowedOptions: ["off", "low", "medium"], expectedMax: "medium" },
    // Transport-vocabulary controls; these are synthetic discovery responses.
    { allowedOptions: ["minimal"], expectedMax: "minimal" },
  ])(
    "discovers the highest graded effort from $allowedOptions",
    async ({ allowedOptions, expectedMax }) => {
      const fetchMock = catalog([
        {
          type: "llm",
          key: "synthetic-effort-ceiling",
          capabilities: { reasoning: { allowed_options: allowedOptions } },
        },
      ]);
      const models = await discover(fetchMock, { apiKey: "synthetic-no-account" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:1234/api/v1/models",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(models).toHaveLength(1);
      expect(models[0]?.reasoning).toBe(true);
      expect(models[0]?.compat?.reasoningEffortMap).toMatchObject({
        adaptive: expectedMax,
        max: expectedMax,
      });
    },
  );

  it("reports wrong-shaped model lists with owned errors", async () => {
    for (const payload of [[], { models: {} }, { models: [null] }]) {
      const result = await fetchModels(vi.fn(async () => Response.json(payload)));
      expect(result).toMatchObject({
        reachable: false,
        error: { message: "LM Studio model list: malformed JSON response" },
      });
    }
  });

  it("discovers valid local models from partially malformed catalogs", async () => {
    const fetchMock = catalog([null, { type: "llm", key: modelKey }, [], "invalid-model", 42]);

    const models = await discover(fetchMock);

    expect(models).toEqual([expect.objectContaining({ id: "qwen3-8b-instruct" })]);
  });

  it("caps oversized direct fetch timeouts before discovering models", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = catalog([]);

    const result = await fetchModels(fetchMock, { timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(result.reachable).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutController.signal);
  });

  it("caps oversized guarded-fetch timeouts before discovering models", async () => {
    guardedFetch.mockResolvedValue({
      response: new Response(JSON.stringify({ models: [] }), { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      ssrfPolicy: {},
    });

    expect(result.reachable).toBe(true);
    expect(guardedFetch.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: MAX_TIMER_TIMEOUT_MS });
  });

  it.each<[string, number, number, number | undefined, number]>([
    ["reloads for a larger requested window", 4096, 32768, 8192, 8192],
    ["reloads to the clamped default window", 4096, 32768, undefined, 32768],
    [
      "ignores malformed context lengths",
      4096.5,
      32768.5,
      8192.5,
      LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
    ],
  ])(
    "%s",
    async (
      _name,
      loadedContextLength,
      maxContextLength,
      requestedContextLength,
      expectedContextLength,
    ) => {
      const fetchMock = mockLoad({ loadedContextLength, maxContextLength });
      vi.stubGlobal("fetch", asFetch(fetchMock));
      await expect(
        loadModel(requestedContextLength === undefined ? {} : { requestedContextLength }),
      ).resolves.toBe("qwen3-8b-instruct");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectLoadContext(fetchMock, expectedContextLength);
    },
  );

  it.each([
    ["canonical key", "gemma", "gemma@q4_k_m", "gemma@q4_k_m"],
    ["suffixed key", "local/special@q4_k_m", "local/special@q4_k_m", "local/special@q8_0"],
  ])(
    "loads the %s for an advertised variant",
    async (_name, canonicalKey, requestedKey, advertisedVariant) => {
      const fetchMock = mockLoad({
        key: canonicalKey,
        variants: [null, 42, "", ` ${advertisedVariant} `, advertisedVariant],
      });
      vi.stubGlobal("fetch", asFetch(fetchMock));
      await expect(loadModel({ modelKey: requestedKey })).resolves.toBe(canonicalKey);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const loadInit = loadCall(fetchMock)?.[1];
      expect(loadInit).toEqual({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: expect.any(AbortSignal),
        body: expect.any(String),
      });
      expect(parseBody(loadInit)).toEqual({ model: canonicalKey, context_length: 64000 });
    },
  );

  it("bounds oversized model load success bodies", async () => {
    const chunkSize = 64 * 1024;
    const tracked = createStreamingResponse({
      chunkSize,
      chunkCount: 512,
      byte: 0x61,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = mockLoad({ loadResponse: () => tracked.response });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    const error = await loadModel().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(/JSON response exceeds \d+ bytes/),
    );
    expect(tracked.wasCanceled()).toBe(true);
    expect(tracked.getReadCount() * chunkSize).toBeLessThan(32 * 1024 * 1024);
  });

  it("suppresses truncated model load error bodies", async () => {
    const credential = "split-credential-xyz";
    const body = `${"x".repeat(8 * 1024 - 2)}${credential}${"y".repeat(1000)}`;
    const tracked = cancelTrackedTextResponse(body, { status: 503 });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = mockLoad({ loadResponse: () => tracked.response });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    const error = await loadModel({ apiKey: credential }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "LM Studio model load failed (503)");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  type LoadAuth = Pick<Parameters<typeof ensureLmstudioModelLoaded>[0], "apiKey" | "headers">;
  it.each<[LoadAuth, string, string]>([
    [
      { apiKey: "abc", headers: { "X-Proxy-Auth": "abcdef" } },
      "proxy rejected abcdef and abc",
      "proxy rejected *** and ***",
    ],
    [
      { apiKey: "fresh", headers: { Authorization: "Bearer replaced-old" } },
      "stale replaced-old; active fresh",
      "stale replaced-old; active ***",
    ],
    [
      { apiKey: "lmstudio-local" },
      "lmstudio-local application/json",
      "lmstudio-local application/json",
    ],
    [{}, "upstream Authorization: Bearer sk-test", "upstream Authorization: Bearer ***"],
  ])("redacts model load error for %j", async (params, body, expected) => {
    const fetchMock = mockLoad({
      loadResponse: () => new Response(body, { status: 502 }),
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(loadModel(params)).rejects.toMatchObject({
      message: `LM Studio model load failed (502): ${expected}`,
      resolvedModelKey: modelKey,
    });
  });

  it("loads model with clamped context length and merged headers", async () => {
    const fetchMock = mockLoad({ maxContextLength: 32768 });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      loadModel({
        apiKey: "lm-token",
        headers: { "X-Proxy-Auth": "required", Authorization: "Bearer override" },
        modelKey: " qwen3-8b-instruct ",
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const loadInit = loadCall(fetchMock)?.[1];
    expect(loadInit).toEqual({
      method: "POST",
      signal: expect.any(AbortSignal),
      headers: {
        "X-Proxy-Auth": "required",
        Authorization: "Bearer lm-token",
        "Content-Type": "application/json",
      },
      body: expect.any(String),
    });
    expect(parseBody(loadInit)).toEqual({ model: "qwen3-8b-instruct", context_length: 32768 });
  });

  it("throws when model discovery fails", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(loadModel()).rejects.toThrow("LM Studio model discovery failed (401)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
