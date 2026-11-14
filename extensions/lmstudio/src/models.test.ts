import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterAll, afterEach, assert, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import {
  cancelTrackedTextResponse,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";
import plugin from "../index.js";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import {
  discoverLmstudioModels,
  ensureLmstudioModelLoaded,
  fetchLmstudioModels,
} from "./models.fetch.js";
import {
  normalizeLmstudioProviderConfig,
  resolveLmstudioReasoningCompat,
  type LmstudioModelWire,
} from "./models.js";
import { discoverLmstudioProvider } from "./setup.js";

const guardedFetch = vi.hoisted(() => vi.fn());
function expectRequest(mock: ReturnType<typeof vi.fn>, headers: Record<string, string>) {
  expect(mock).toHaveBeenCalledWith("http://localhost:1234/api/v1/models", {
    headers,
    signal: expect.any(AbortSignal),
  });
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: (...args: unknown[]) => guardedFetch(...args) };
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

afterEach(() => {
  guardedFetch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const mockLoad = (
    model: LmstudioModelWire = {},
    loadResponse = () => Response.json({ status: "loaded", instance_id: "inst-loaded" }),
  ) => {
    const mock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/models")) {
        return Response.json({ models: [{ type: "llm", key: modelKey, ...model }] });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return loadResponse();
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(mock));
    return mock;
  };
  const loadCall = (fetchMock: ReturnType<typeof mockLoad>) =>
    fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/models/load"));

  it("preserves an explicit network policy and request headers", () => {
    expect(
      normalizeLmstudioProviderConfig({ baseUrl: "http://192.168.1.10:1234", models: [] }),
    ).toEqual({
      baseUrl: "http://192.168.1.10:1234/v1",
      request: { allowPrivateNetwork: true },
      models: [],
    });
    const config = {
      baseUrl: "http://gpu-box.local:1234/v1",
      request: { allowPrivateNetwork: false, headers: { "X-Proxy-Auth": "token" } },
      models: [],
    };
    expect(normalizeLmstudioProviderConfig(config)).toEqual(config);
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
        loaded_instances: [{ id: "inst-1", config: { context_length: 8_192 } }],
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
      ...[["off", "low", "medium"], ["minimal"]].map((allowed_options) => ({
        type: "llm",
        key: allowed_options.join("-"),
        capabilities: { reasoning: { allowed_options } },
      })),
      { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" },
      { type: "llm", key: "   " },
      null,
      [],
      "invalid-model",
      42,
    ]);

    const models = await discover(fetchMock, { quiet: false });
    expectRequest(fetchMock, { Authorization: "Bearer lm-token" });
    expect(models.map(({ id, reasoning }) => [id, reasoning])).toEqual([
      ["qwen3-8b-instruct", true],
      ["deepseek-r1", false],
      ["graded-reasoning", true],
      ["off-only-reasoning", false],
      ["off-low-medium", true],
      ["minimal", true],
    ]);
    expect(models[0]).toMatchObject({
      name: "Qwen3 8B (MLX, vision, tool-use, loaded)",
      input: ["text", "image"],
      contextWindow: 262144,
      contextTokens: 8192,
      maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        supportsTools: true,
        supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
      },
    });
    expect(models[1]).toMatchObject({
      name: "deepseek-r1",
      input: ["text"],
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    for (const index of [1, 3]) {
      expect(models[index]?.compat).toEqual({ supportsUsageInStreaming: true });
    }
    for (const [index, efforts, max] of [
      [2, ["low", "medium", "high"], "high"],
      [4, ["none", "low", "medium"], "medium"],
      [5, ["minimal"], "minimal"],
    ] as const) {
      expect(models[index]?.compat).toEqual({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: efforts,
        reasoningEffortMap: {
          ...(efforts.some((effort) => effort === "none") ? { off: "none", none: "none" } : {}),
          adaptive: max,
          max,
        },
      });
    }
  });

  it("reports wrong-shaped model lists with owned errors", async () => {
    for (const payload of [[], { models: {} }, { models: [null] }]) {
      const result = await fetchModels(vi.fn(async () => Response.json(payload)));
      expect(result).toMatchObject({
        reachable: false,
        error: { message: "LM Studio model list: malformed JSON response" },
      });
    }
  });

  it.each([false, true])("caps discovery timeout with guarded=%s", async (guarded) => {
    const response = Response.json({ models: [] });
    guardedFetch.mockResolvedValue({ response, release: vi.fn(async () => undefined) });
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const direct = vi.fn(async (_url: string | URL, _init?: RequestInit) => response);
    const result = await fetchModels(direct, {
      timeoutMs: Number.MAX_SAFE_INTEGER,
      ...(guarded ? { ssrfPolicy: {} } : {}),
    });
    expect(result.reachable).toBe(true);
    if (guarded) {
      expect(guardedFetch.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: MAX_TIMER_TIMEOUT_MS });
    } else {
      expect(timeout).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
      expect(direct.mock.calls[0]?.[1]?.signal).toBe(signal);
    }
  });

  it.each<[string, number, number, number | undefined, number]>([
    ["larger requested window", 4096, 32768, 8192, 8192],
    ["clamped default window", 4096, 32768, undefined, 32768],
    ["malformed context lengths", 4096.5, 32768.5, 8192.5, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH],
  ])("reloads for %s", async (_name, loaded, max, requested, expected) => {
    const fetchMock = mockLoad({
      max_context_length: max,
      loaded_instances: [{ id: "inst-1", config: { context_length: loaded } }],
    });
    await expect(loadModel({ requestedContextLength: requested })).resolves.toBe(modelKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseBody(loadCall(fetchMock)?.[1])).toMatchObject({ context_length: expected });
  });

  it.each([
    ["canonical key", "gemma", " gemma@q4_k_m ", "gemma@q4_k_m"],
    ["suffixed key", "local/special@q4_k_m", "local/special@q4_k_m", "local/special@q8_0"],
  ])(
    "loads the %s for an advertised variant",
    async (_name, canonicalKey, requestedKey, advertisedVariant) => {
      const fetchMock = mockLoad({
        key: canonicalKey,
        variants: [null, 42, "", ` ${advertisedVariant} `, advertisedVariant],
      });
      await expect(loadModel({ modelKey: requestedKey })).resolves.toBe(canonicalKey);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const loadInit = loadCall(fetchMock)?.[1];
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
    mockLoad({}, () => tracked.response);
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
    mockLoad({}, () => tracked.response);
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
    mockLoad({}, () => new Response(body, { status: 502 }));
    await expect(loadModel(params)).rejects.toMatchObject({
      message: `LM Studio model load failed (502): ${expected}`,
      resolvedModelKey: modelKey,
    });
  });

  it("throws when model discovery fails", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", asFetch(fetchMock));
    await expect(loadModel()).rejects.toThrow("LM Studio model discovery failed (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function context(headers?: Record<string, string>, keyless = false): ProviderCatalogContext {
  return {
    config: createModelProviderConfig({
      lmstudio: {
        baseUrl: "http://localhost:1234/api/v1/",
        apiKey: keyless ? undefined : "configured-key",
        headers,
        models: [],
      },
    }),
    env: {},
    resolveProviderApiKey: () =>
      keyless
        ? { apiKey: undefined }
        : {
            apiKey: "LM_API_TOKEN",
            discoveryApiKey: "profile-key",
            profileId: "lmstudio:profile",
          },
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
}

const catalog = capturePluginRegistration(plugin).providers[0]?.catalog;
assert(catalog);
const runCatalog = catalog.run;

async function discoverConfigured(
  provider: Partial<ModelProviderConfig>,
  env: NodeJS.ProcessEnv = {},
  discoveryApiKey?: string,
) {
  const fetchMock = vi.fn(async () =>
    Response.json({
      models: [{ type: "llm", key: "qwen3-8b-instruct" }],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await discoverLmstudioProvider({
    ...context(),
    config: createModelProviderConfig({
      lmstudio: { baseUrl: "http://localhost:1234/api/v1/", models: [], ...provider },
    }),
    env,
    resolveProviderApiKey: () => ({ apiKey: undefined, discoveryApiKey }),
  });
  return { result, fetchMock };
}

const headerAuth = { Authorization: "Bearer custom-token" };
const proxyAuth = { "X-Proxy-Auth": "proxy-token" };
const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

it.each<[Partial<ModelProviderConfig>, Partial<ModelProviderConfig>]>([
  [{ auth: "api-key" }, { auth: "api-key", apiKey: "LM_API_TOKEN" }],
  [{ apiKey: "stale-legacy-key", headers: headerAuth }, { headers: headerAuth }],
  [{ apiKey: "${LMSTUDIO_API_KEY}", headers: headerAuth }, { headers: headerAuth }],
  [{ headers: proxyAuth }, { apiKey: "lmstudio-local", headers: proxyAuth }],
])("preserves explicit models without fetching for %j", async (patch, persisted) => {
  const models: ModelProviderConfig["models"] = [
    {
      id: "qwen3-8b-instruct",
      name: "Qwen3 8B",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 8192,
    },
  ];
  const { result, fetchMock } = await discoverConfigured({ ...patch, models });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result).toEqual({
    provider: {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      ...persisted,
      models,
    },
  });
});

it("resolves configured SecretRefs for discovery requests", async () => {
  const { result, fetchMock } = await discoverConfigured(
    {
      apiKey: envRef("LMSTUDIO_DISCOVERY_TOKEN"),
      headers: { "X-Proxy-Auth": envRef("LMSTUDIO_PROXY_TOKEN") },
    },
    { LMSTUDIO_DISCOVERY_TOKEN: "secretref-key", LMSTUDIO_PROXY_TOKEN: "proxy-token" },
  );
  expectRequest(fetchMock, {
    Authorization: "Bearer secretref-key",
    "X-Proxy-Auth": "proxy-token",
  });
  expect(result?.provider.models?.map((model) => model.id)).toEqual(["qwen3-8b-instruct"]);
});

it.each<Partial<ModelProviderConfig>>([
  { headers: { "X-Proxy-Auth": envRef("LMSTUDIO_PROXY_TOKEN") } },
  { apiKey: envRef("LMSTUDIO_DISCOVERY_TOKEN") },
])("rejects unresolved catalog credentials before fetch: %j", async (patch) => {
  const { result, fetchMock } = await discoverConfigured(patch);
  expect(result).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each<[string, string | undefined, Record<string, string> | undefined, string]>([
  ["configured-key", undefined, undefined, "configured-key"],
  ["configured-key", "discovery-key", undefined, "discovery-key"],
  ["${LMSTUDIO_API_KEY}", "discovery-key", undefined, "discovery-key"],
  ["configured-key", "stale-key", headerAuth, "custom-token"],
])(
  "selects discovery credentials for %s / %s / %j",
  async (apiKey, discoveryApiKey, headers, expected) => {
    const { result, fetchMock } = await discoverConfigured(
      { apiKey, headers },
      {},
      discoveryApiKey,
    );
    expectRequest(fetchMock, { Authorization: `Bearer ${expected}` });
    if (headers) {
      expect(result?.provider).toMatchObject({
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        models: [expect.objectContaining({ id: "qwen3-8b-instruct" })],
      });
      expect(result?.provider.headers).toEqual(headers);
      expect(result?.provider.apiKey).toBeUndefined();
      expect(result?.provider.auth).toBeUndefined();
    }
  },
);

it.each([401, 503, "disconnect", "invalid-json", "missing-models", "header"])(
  "reports %s as failed acquisition while preserving the public advisory helper",
  async (failure) => {
    const fetchMock = vi.fn(async () => {
      if (failure === "disconnect") {
        throw new Error("connection reset");
      }
      return new Response(failure === "invalid-json" ? "{" : "{}", {
        status: failure === "header" ? 403 : typeof failure === "number" ? failure : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const key = failure === "header" ? "header-key" : "profile-key";
    const ctx = context(failure === "header" ? { Authorization: `Bearer ${key}` } : undefined);
    const rejected = failure === 401 || failure === "header";
    const outcome = {
      provider: "lmstudio",
      ...(failure === "header" ? {} : { profileId: "lmstudio:profile" }),
      status: rejected ? "auth-rejected" : "unavailable",
      ...(rejected ? { rejectionScope: "catalog" } : {}),
    };
    await expect(runCatalog(ctx)).resolves.toEqual({ providers: {}, outcomes: [outcome] });
    expectRequest(fetchMock, { Authorization: `Bearer ${key}` });
    await expect(discoverLmstudioProvider(ctx)).resolves.toMatchObject({
      provider: { models: [] },
    });
  },
);

it("retains configured and optional empty listings while the public helper stays quiet", async () => {
  const fetchMock = vi.fn(async () => Response.json({ models: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const ctx = context(undefined, true);
  await expect(runCatalog(ctx)).resolves.toMatchObject({
    provider: { models: [] },
    outcomes: [{ provider: "lmstudio", status: "ready" }],
  });
  await expect(discoverLmstudioProvider(ctx)).resolves.toBeNull();
  ctx.config = {};
  const modelIdCatalog = { baseUrl: "http://localhost:1234/v1", modelIds: [], aliases: [] };
  await expect(runCatalog(ctx)).resolves.toEqual({
    providers: {},
    outcomes: [{ provider: "lmstudio", status: "ready", modelIdCatalog }],
  });
  fetchMock.mockRejectedValueOnce(new Error("optional server offline"));
  await expect(runCatalog(ctx)).resolves.toBeNull();
  fetchMock.mockClear();
  await expect(runCatalog({ ...context(), providerIds: ["another-provider"] })).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("releases guarded non-ok discovery without waiting for the capture clone", async () => {
  const tracked = cancelTrackedTextResponse("unavailable", { status: 503 });
  const captureClone = tracked.response.clone();
  const release = vi.fn(async () => undefined);
  guardedFetch.mockResolvedValue({ response: tracked.response, release });
  const request = fetchLmstudioModels({ baseUrl: "http://localhost:1234/v1", ssrfPolicy: {} });
  try {
    const result = await raceWithTimeout(request, 500, () => {
      throw new Error("LM Studio cleanup waited for the capture clone");
    });
    expect(result).toMatchObject({ reachable: true, status: 503, models: [] });
    expect(tracked.response.bodyUsed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await captureClone.body?.cancel().catch(() => undefined);
    await request;
  }
  expect(tracked.wasCanceled()).toBe(true);
});

it.each([
  { supportedReasoningEfforts: ["off", "on"], reasoningEffortMap: { off: "off", medium: "on" } },
  {
    supportedReasoningEfforts: ["none", "low", "high"],
    reasoningEffortMap: { off: "low", medium: "none" },
  },
])(
  "preserves authored reasoning maps in the configured catalog: $reasoningEffortMap",
  async (compat) => {
    const provider = capturePluginRegistration(plugin).providers[0];
    assert(provider?.augmentModelCatalog, "LM Studio catalog hook is missing");
    const config = createModelProviderConfig({
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        models: [
          {
            id: "saved-model",
            name: "Saved",
            reasoning: true,
            input: ["text"],
            cost: SELF_HOSTED_DEFAULT_COST,
            maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
            contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
            compat,
          },
        ],
      },
    });
    const entries = await provider.augmentModelCatalog({ config, entries: [], env: {} });
    assert(Array.isArray(entries), "LM Studio catalog hook returned no entries");
    expect(entries[0]?.compat).toMatchObject(compat);
    expect(config.models?.providers?.lmstudio?.models[0]?.compat).toEqual(compat);
  },
);
