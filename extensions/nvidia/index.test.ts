import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn((baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

type RegisteredModelCatalogProvider = Parameters<
  ReturnType<typeof createTestPluginApi>["registerModelCatalogProvider"]
>[0];

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
  ssrfRuntimeMocks.ssrfPolicyFromHttpBaseUrlAllowedHostname.mockClear();
});

function mockFeaturedCatalogResponse(payload: unknown, status = 200) {
  const featured =
    (payload as { "featured-models"?: Array<{ model: string }> })["featured-models"] ?? [];
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response: Response.json(
      url === NVIDIA_FEATURED_MODELS_URL
        ? payload
        : {
            data: featured.map(({ model }) => ({
              id: model.includes("/") ? model : `nvidia/${model}`,
            })),
          },
      { status },
    ),
    finalUrl: url,
    release: vi.fn(),
  }));
}

function registerNvidiaPluginApi() {
  const registeredModelCatalogProviders: RegisteredModelCatalogProvider[] = [];

  plugin.register(
    createTestPluginApi({
      registerModelCatalogProvider(provider) {
        registeredModelCatalogProviders.push(provider);
      },
    }),
  );

  return { registeredModelCatalogProviders };
}

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

describe("nvidia provider hooks", () => {
  it("reports public catalog HTTP 401 without rejecting inference credentials", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 401);
    const provider = await registerSingleProviderPlugin(plugin);
    await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toEqual({
      providers: {},
      outcomes: [
        {
          provider: "nvidia",
          status: "auth-rejected",
          rejectionScope: "catalog",
        },
      ],
    });
    for (const [request] of ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls) {
      expect(new Headers(request.init.headers).has("authorization")).toBe(false);
    }
  });

  it("publishes ready for successful empty inventory", async () => {
    mockFeaturedCatalogResponse({ "featured-models": [] });
    const provider = await registerSingleProviderPlugin(plugin);
    await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toMatchObject({
      provider: { apiKey: "nvapi-test", models: [] },
      outcomes: [{ provider: "nvidia", status: "ready" }],
    });
  });

  it("registers static and live nvidia model catalog rows", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "moonshotai/kimi-k2.6",
          "model-name": "Kimi K2.6",
          context: 262144,
          "max-output": 65536,
        },
        {
          model: "nvidia/nemotron-3.5-lightning-30b-a3b",
          "model-name": "Nemotron 3.5 Lightning 30B",
          context: 1048576,
          "max-output": 16384,
        },
      ],
    });
    const { registeredModelCatalogProviders } = registerNvidiaPluginApi();
    const catalogProvider = registeredModelCatalogProviders[0];

    expect(catalogProvider?.provider).toBe("nvidia");
    expect(catalogProvider?.kinds).toStrictEqual(["text"]);

    const staticRows = await catalogProvider?.staticCatalog?.(buildCatalogContext());
    expect(staticRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
      "static:nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      "static:nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
      "static:nvidia/nvidia/nemotron-3-super-120b-a12b",
      "static:nvidia/moonshotai/kimi-k2.6",
    ]);

    await expect(catalogProvider?.liveCatalog?.(buildCatalogContext())).resolves.toEqual([]);

    const liveRows = await catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test"));
    expect(liveRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
      "live:nvidia/moonshotai/kimi-k2.6",
      "live:nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
    ]);
  });
});
