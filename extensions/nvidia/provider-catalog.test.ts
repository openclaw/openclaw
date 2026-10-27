import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildLiveNvidiaProvider, buildNvidiaProvider } from "./provider-catalog.js";

const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

const catalogResponses = new Map<string, Response[]>();

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
  catalogResponses.clear();
});

function mockCatalog(ids: string[], rows: unknown[], inventoryStatus = 200, featuredStatus = 200) {
  for (const [url, body, status] of [
    [NVIDIA_MODELS_URL, { data: ids.map((id) => ({ id, object: "model" })) }, inventoryStatus],
    [NVIDIA_FEATURED_MODELS_URL, { "featured-models": rows }, featuredStatus],
  ] as const) {
    const responses = catalogResponses.get(url) ?? [];
    responses.push(Response.json(body, { status }));
    catalogResponses.set(url, responses);
  }
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
    const response = catalogResponses.get(url)?.shift();
    if (!response) {
      throw new Error(`Unexpected catalog request: ${url}`);
    }
    return { response, finalUrl: url, release: vi.fn() };
  });
}

function featured(model: string, name: string, context: number, maxOutput: number) {
  return { model, "model-name": name, context, "max-output": maxOutput };
}

it("uses the model inventory for availability while retaining featured ordering", async () => {
  mockCatalog(
    [
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/unclassified-new-model",
      "nvidia/nemotron-4-340b-reward",
    ],
    [
      featured("z-ai/glm-5.2", "Stale featured model", 202752, 8192),
      featured("nemotron-3.5-super-vl-120b-a12b", "Nemotron 3.5 Super VL", 1048576, 8192),
    ],
  );

  const provider = await buildLiveNvidiaProvider();

  expect(provider.models.map((model) => model.id)).toEqual([
    "nvidia/nemotron-3.5-super-vl-120b-a12b",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
  ]);
  expect(provider.models[0]?.input).toEqual(["text", "image", "video"]);
  expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({
      lookupFn: expect.any(Function),
      policy: { allowedHostnames: ["assets.ngc.nvidia.com"] },
      url: NVIDIA_FEATURED_MODELS_URL,
      requireHttps: true,
    }),
  );
});

it("does not treat featured rows as fresh inventory when model discovery fails", async () => {
  mockCatalog([], [featured("z-ai/glm-5.2", "GLM 5.2", 202752, 8192)], 503);

  await expect(buildLiveNvidiaProvider()).rejects.toThrow("HTTP 503");
});

it("builds the bundled NVIDIA provider defaults", () => {
  const provider = buildNvidiaProvider();

  expect(provider).toMatchObject({
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    apiKey: "NVIDIA_API_KEY",
  });
  expect(provider.models.filter((model) => model.compat?.requiresStringContent !== true)).toEqual(
    [],
  );
  expect(provider.models[0]).toMatchObject({
    contextWindow: 1_048_576,
    maxTokens: 8_192,
    params: {
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    },
  });
  expect(provider.models[2]).toMatchObject({
    id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    input: ["text", "image", "video"],
    contextWindow: 1_048_576,
  });
  for (const [id, input, contextWindow, maxTokens] of [
    ["moonshotai/kimi-k2.6", ["text", "image"], 262_144, 65_536],
    ["nvidia/nemotron-3.5-lightning-30b-a3b", ["text"], 1_048_576, 16_384],
  ] as const) {
    expect(provider.models.find((model) => model.id === id)).toMatchObject({
      input,
      reasoning: true,
      contextWindow,
      maxTokens,
    });
  }
});

it("does not cache successful featured catalog responses with no usable rows", async () => {
  mockCatalog(["moonshotai/kimi-k2.6"], [featured("bad model id", "Bad", 1000, 1000)]);
  mockCatalog(
    ["moonshotai/kimi-k2.6"],
    [featured("moonshotai/kimi-k2.6", "Updated Kimi K2.6", 262144, 8192)],
  );

  await expect(buildLiveNvidiaProvider()).rejects.toThrow("no usable model metadata");
  const second = await buildLiveNvidiaProvider();
  expect(second.models).toMatchObject([
    { id: "moonshotai/kimi-k2.6", name: "Updated Kimi K2.6", contextWindow: 262144 },
  ]);
  expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
});
function buildCatalogContext(apiKey?: string) {
  return {
    config: {},
    env: process.env,
    resolveProviderApiKey: () => ({ apiKey }),
    resolveProviderAuth: () => ({
      apiKey,
      mode: apiKey ? ("api_key" as const) : ("none" as const),
      source: apiKey ? ("env" as const) : ("none" as const),
    }),
  };
}

it("reports public catalog HTTP 401 without rejecting inference credentials", async () => {
  mockCatalog([], [], 401, 401);
  const provider = await registerSingleProviderPlugin(plugin);
  await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toEqual({
    providers: {},
    outcomes: [{ provider: "nvidia", status: "auth-rejected", rejectionScope: "catalog" }],
  });
  for (const [request] of ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls) {
    expect(new Headers(request.init.headers).has("authorization")).toBe(false);
  }
});

it("publishes ready for successful empty inventory", async () => {
  mockCatalog([], []);
  const provider = await registerSingleProviderPlugin(plugin);
  await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toMatchObject({
    provider: { apiKey: "nvapi-test", models: [] },
    outcomes: [{ provider: "nvidia", status: "ready" }],
  });
});

it("registers static and live nvidia model catalog rows", async () => {
  mockCatalog(
    ["moonshotai/kimi-k2.6", "nvidia/nemotron-3.5-lightning-30b-a3b"],
    [
      featured("moonshotai/kimi-k2.6", "Kimi K2.6", 262144, 65536),
      featured("nvidia/nemotron-3.5-lightning-30b-a3b", "Lightning", 1048576, 16384),
    ],
  );
  const registerModelCatalogProvider =
    vi.fn<ReturnType<typeof createTestPluginApi>["registerModelCatalogProvider"]>();
  plugin.register(createTestPluginApi({ registerModelCatalogProvider }));
  const catalogProvider = registerModelCatalogProvider.mock.calls[0]?.[0];
  expect(catalogProvider?.provider).toBe("nvidia");
  expect(catalogProvider?.kinds).toStrictEqual(["text"]);

  const staticRows = await catalogProvider?.staticCatalog?.(buildCatalogContext());
  expect(staticRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
    "static:nvidia/nvidia/nemotron-3-ultra-550b-a55b",
    "static:nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
    "static:nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b",
    "static:nvidia/moonshotai/kimi-k2.6",
  ]);

  await expect(catalogProvider?.liveCatalog?.(buildCatalogContext())).resolves.toEqual([]);

  const liveRows = await catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test"));
  expect(liveRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
    "live:nvidia/moonshotai/kimi-k2.6",
    "live:nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  ]);
});
