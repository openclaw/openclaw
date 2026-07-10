// Novita tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildNovitaProvider, NOVITA_MODELS_URL } from "./provider-catalog.js";

const ssrfRuntimeMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ssrfRuntimeMocks);

afterEach(() => {
  clearLiveCatalogCacheForTests();
  ssrfRuntimeMocks.fetchWithSsrFGuard.mockReset();
});

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("novita provider plugin", () => {
  it("registers NovitaAI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("novita");
    expect(provider.aliases).toEqual(["novita-ai", "novitaai"]);
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("deepseek/deepseek-v3-0324");
  });

  it("discovers authenticated Novita models for listing and runtime registration", async () => {
    ssrfRuntimeMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: Response.json({
        data: [
          {
            id: "deepseek/deepseek-v4-flash",
            object: "model",
            title: "DeepSeek V4 Flash",
            context_size: 1_048_576,
          },
        ],
      }),
      finalUrl: "https://api.novita.ai/openai/v1/models",
      release: vi.fn(async () => undefined),
    });
    const provider = await registerSingleProviderPlugin(plugin);
    const context = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({
        apiKey: "novita-runtime-key",
        discoveryApiKey: "novita-discovery-key",
      }),
      resolveProviderAuth: () => ({
        apiKey: "novita-runtime-key",
        discoveryApiKey: "novita-discovery-key",
        mode: "api_key" as const,
        source: "env" as const,
      }),
    };

    const catalog = await provider.catalog?.run(context as never);
    const catalogProvider = requireCatalogProvider(catalog);
    expect(catalogProvider.models).toContainEqual(
      expect.objectContaining({
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1_048_576,
      }),
    );

    const entries = await provider.augmentModelCatalog?.({
      ...context,
      agentDir: "/tmp/openclaw-agent",
      entries: [],
    } as never);
    expect(entries).toContainEqual({
      provider: "novita",
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextWindow: 1_048_576,
      reasoning: false,
      input: ["text"],
    });
    expect(ssrfRuntimeMocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
    const headers = ssrfRuntimeMocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBe("Bearer novita-discovery-key");
    expect((headers as Headers).get("content-type")).toBe("application/json");
  });

  it("activates live discovery and runtime augmentation through the manifest (#103532)", () => {
    // Without these manifest declarations the catalog.run/augmentModelCatalog
    // hooks are inert in production: provider-filtered listing returns static
    // rows before catalog.run, and bundled loading skips augmentModelCatalog.
    expect(manifest.modelCatalog.runtimeAugment).toBe(true);
    expect(manifest.modelCatalog.discovery.novita).toBe("refreshable");
  });

  it("keeps curated static metadata for known models but stays conservative for new routes", async () => {
    const provider = await buildNovitaProvider({
      discoveryApiKey: "novita-discovery-key",
      fetchGuard: (async () => ({
        response: Response.json({
          data: [
            // A model the manifest already curates, returned with a sparse live row.
            { id: "moonshotai/kimi-k2.5", title: "Kimi (live)", context_size: 4096 },
            // A brand-new account-only route the manifest does not know.
            {
              id: "deepseek/deepseek-v4-flash",
              title: "DeepSeek V4 Flash",
              context_size: 1_048_576,
            },
          ],
        }),
        finalUrl: NOVITA_MODELS_URL,
        release: async () => undefined,
      })) as never,
    });

    const known = provider.models.find((model) => model.id === "moonshotai/kimi-k2.5");
    // Curated reasoning/vision/context survive the sparse live row.
    expect(known?.reasoning).toBe(true);
    expect(known?.input).toContain("image");
    expect(known?.contextWindow).toBe(262_144);

    const fresh = provider.models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    // New route: conservative synthesis, but honoring the live context size.
    expect(fresh?.reasoning).toBe(false);
    expect(fresh?.input).toEqual(["text"]);
    expect(fresh?.contextWindow).toBe(1_048_576);
  });
});
