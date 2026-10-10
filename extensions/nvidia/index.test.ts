import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
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
  it.each([401, 503])(
    "reports public catalog HTTP %s without rejecting inference credentials",
    async (status) => {
      mockFeaturedCatalogResponse({ error: "unavailable" }, status);
      const provider = await registerSingleProviderPlugin(plugin);
      const rejected = status === 401;
      await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toEqual({
        providers: {},
        outcomes: [
          {
            provider: "nvidia",
            status: rejected ? "auth-rejected" : "unavailable",
            ...(rejected ? { rejectionScope: "catalog" } : {}),
          },
        ],
      });
      for (const [request] of ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls) {
        expect(new Headers(request.init.headers).has("authorization")).toBe(false);
      }
    },
  );

  it("publishes ready for successful empty inventory", async () => {
    mockFeaturedCatalogResponse({ "featured-models": [] });
    const provider = await registerSingleProviderPlugin(plugin);
    await expect(provider.catalog?.run(buildCatalogContext("nvapi-test"))).resolves.toMatchObject({
      provider: { apiKey: "nvapi-test", models: [] },
      outcomes: [{ provider: "nvidia", status: "ready" }],
    });
  });

  it("registers API-key auth choice metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nvidia-api-key",
    });
    expect(choice?.provider.id).toBe("nvidia");
    expect(choice?.method.id).toBe("api-key");
  });

  it("keeps nvidia wizard setup metadata aligned", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.wizard?.setup).toStrictEqual({
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
      methodId: "api-key",
      modelSelection: {
        promptWhenAuthChoiceProvided: true,
        allowKeepCurrent: false,
      },
    });
  });

  it("opts into literal provider-prefix preservation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    // The nvidia/ vendor namespace must survive provider-prefix deduplication.
    expect(provider.preserveLiteralProviderPrefix).toBe(true);
  });

  it("registers static and live nvidia model catalog rows", async () => {
    mockFeaturedCatalogResponse({
      "featured-models": [
        {
          model: "minimaxai/minimax-m3",
          "model-name": "Minimax M3",
          context: 196608,
          "max-output": 8192,
        },
        {
          model: "qwen/qwen3.5-397b-a17b",
          "model-name": "Qwen3.5 397B A17B",
          context: 262144,
          "max-output": 32768,
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
      "static:nvidia/z-ai/glm-5.2",
      "static:nvidia/moonshotai/kimi-k2.6",
      "static:nvidia/minimaxai/minimax-m3",
      "static:nvidia/deepseek-ai/deepseek-v4-pro",
    ]);

    await expect(catalogProvider?.liveCatalog?.(buildCatalogContext())).resolves.toEqual([]);

    const liveRows = await catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test"));
    expect(liveRows?.map((entry) => `${entry.source}:${entry.provider}/${entry.model}`)).toEqual([
      "live:nvidia/minimaxai/minimax-m3",
      "live:nvidia/qwen/qwen3.5-397b-a17b",
    ]);
  });

  it("keeps static rows out of the live catalog when discovery is unavailable", async () => {
    mockFeaturedCatalogResponse({ error: "unavailable" }, 503);
    const { registeredModelCatalogProviders } = registerNvidiaPluginApi();
    const catalogProvider = registeredModelCatalogProviders[0];

    await expect(
      catalogProvider?.liveCatalog?.(buildCatalogContext("nvapi-test")),
    ).resolves.toEqual([]);
  });
});
