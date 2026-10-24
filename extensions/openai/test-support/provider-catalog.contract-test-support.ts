import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectAugmentedCodexCatalog,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
  importProviderRuntimeCatalogModule,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolvePluginProviders = (params?: { onlyPluginIds?: string[] }) => ProviderPlugin[];
const resolveProviders = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveOwners = vi.hoisted(() =>
  vi.fn<(params: { provider: string }) => string[] | undefined>(),
);
const resolveCatalogIds = vi.hoisted(() => vi.fn<(_params: unknown) => string[]>(() => []));

vi.mock("openclaw/plugin-sdk/provider-catalog-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/provider-catalog-runtime")
  >("openclaw/plugin-sdk/provider-catalog-runtime");
  return {
    ...actual,
    augmentModelCatalogWithProviderPlugins: async (params: {
      context: Parameters<NonNullable<ProviderPlugin["augmentModelCatalog"]>>[0];
    }) => {
      const supplemental = [];
      for (const provider of resolveProviders({
        onlyPluginIds: resolveCatalogIds(params),
      })) {
        const entries = await provider.augmentModelCatalog?.(params.context);
        supplemental.push(...(entries ?? []));
      }
      return supplemental;
    },
    resolveOwningPluginIdsForProvider: resolveOwners,
    resolveCatalogHookProviderPluginIds: resolveCatalogIds,
    isPluginProvidersLoadInFlight: () => false,
    resolvePluginProviders: resolveProviders,
  };
});

export function describeOpenAIProviderCatalogContract() {
  const contractDepsPromise = (async () => {
    vi.resetModules();
    const { providers: openaiProviders } = await registerProviderPlugin({
      plugin: (await import("../index.js")).default,
      id: "openai",
      name: "OpenAI",
    });
    const openaiProvider = requireRegisteredProvider(openaiProviders, "openai", "provider");
    const { augmentModelCatalogWithProviderPlugins } = await importProviderRuntimeCatalogModule();
    return { augmentModelCatalogWithProviderPlugins, openaiProviders, openaiProvider };
  })();

  describe("openai provider catalog contract", { timeout: 300_000 }, () => {
    beforeEach(async () => {
      const { openaiProviders } = await contractDepsPromise;

      resolveProviders
        .mockReset()
        .mockImplementation(({ onlyPluginIds }: { onlyPluginIds?: string[] } = {}) =>
          !onlyPluginIds?.length || onlyPluginIds.includes("openai") ? openaiProviders : [],
        );

      resolveOwners
        .mockReset()
        .mockImplementation(({ provider }) =>
          ["azure-openai-responses", "openai"].includes(provider) ? ["openai"] : undefined,
        );

      resolveCatalogIds.mockReset().mockReturnValue(["openai"]);
    });

    it("keeps codex-only missing-auth hints wired through the provider runtime", async () => {
      const { openaiProvider } = await contractDepsPromise;
      expectCodexMissingAuthHint(
        (params) => openaiProvider.buildMissingAuthMessage?.(params.context) ?? undefined,
        "openai/gpt-6-astra",
      );
    });

    it("keeps bundled model augmentation wired through the provider runtime", async () => {
      const { augmentModelCatalogWithProviderPlugins } = await contractDepsPromise;
      await expectAugmentedCodexCatalog(
        augmentModelCatalogWithProviderPlugins,
        expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
      );
    });

    it("stops catalog template searches after the preferred rows match", async () => {
      const { openaiProvider } = await contractDepsPromise;
      const preferredIds = ["gpt-5.4-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"];
      const cost = { input: 2, output: 8, cacheRead: 1, cacheWrite: 0 };
      let providerReads = 0;
      const entries = Array.from({ length: 1_000 }, (_, index) => ({
        get provider() {
          providerReads += 1;
          return "openai";
        },
        id: preferredIds[index] ?? `unrelated-${index}`,
        name: `Catalog row ${index}`,
        api: "openai-responses" as const,
        baseUrl: "https://api.example/v1",
        cost,
      }));
      const before = structuredClone(entries);
      providerReads = 0;

      const result = await openaiProvider.augmentModelCatalog?.({ env: {}, entries });
      const observedReads = providerReads;
      expect(result).toEqual(
        expectedOpenaiPluginCodexCatalogEntriesWithGpt55.map((entry, index) =>
          Object.assign(
            {
              ...entry,
              api: "openai-responses",
              baseUrl: "https://api.example/v1",
              cost,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: index < 3 ? 1_050_000 : 400_000,
            },
            index === 0 ? { contextTokens: 272_000 } : {},
          ),
        ),
      );
      expect(entries).toEqual(before);
      expect(observedReads).toBeLessThan(32);
    });
  });
}
