import type { ModelCatalogAlias } from "@openclaw/model-catalog-core/model-catalog-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { createManifestRecord, setManifestPlugins } from "./model.static-catalog.test-helpers.js";

const mistralLookup = { provider: "mistral", modelId: "mistral-medium-3-5" };
const azureAlias = "azure-openai-responses";
const azureEndpoint = "https://example.openai.azure.com/openai/v1";

const manifestMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
}));
const providerMocks = vi.hoisted(() => ({
  normalizePluginDiscoveryResult: vi.fn(),
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProviderRef: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifestMocks.loadPluginManifestRegistryCore,
}));

vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveActivatableProviderOwnerPluginIds: providerMocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: providerMocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: providerMocks.resolveOwningPluginIdsForProviderRef,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-discovery.js")>()),
  normalizePluginDiscoveryResult: providerMocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: providerMocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: providerMocks.runProviderStaticCatalog,
}));

import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  createBundledProviderStaticCatalogContextResolver,
  loadBundledProviderStaticCatalogContextModels,
  resolveBundledProviderStaticCatalogModel,
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata as resolveAlias,
} from "./model.static-catalog.js";

function createMistralManifestPlugin(overrides?: {
  discovery?: "static" | "refreshable" | "runtime";
  origin?: string;
  cost?: ModelDefinitionConfig["cost"];
}) {
  return {
    id: "mistral",
    providers: ["mistral"],
    origin: overrides?.origin ?? "bundled",
    modelCatalog: {
      providers: {
        mistral: {
          baseUrl: "https://api.mistral.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "mistral-medium-3-5",
              name: "Mistral Medium 3.5",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 262144,
              maxTokens: 8192,
              thinkingLevelMap: { off: null, minimal: "low", max: "max" },
              cost: overrides?.cost ?? { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
      discovery: { mistral: overrides?.discovery ?? "static" },
    },
  };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const mock of [...Object.values(manifestMocks), ...Object.values(providerMocks)]) {
    mock.mockReset();
  }
  setManifestPlugins(manifestMocks, []);
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [] });
  providerMocks.resolveActivatableProviderOwnerPluginIds.mockImplementation(
    ({ pluginIds }: { pluginIds: string[] }) => pluginIds,
  );
  providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(undefined);
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
  providerMocks.runProviderStaticCatalog.mockResolvedValue(undefined);
  providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});
});

describe("resolveBundledStaticCatalogModel", () => {
  it("synthesizes a runtime model with normalized tiered pricing", () => {
    const cost: ModelDefinitionConfig["cost"] = {
      input: 1.5,
      output: 7.5,
      cacheRead: 0,
      cacheWrite: 0,
      tieredPricing: [
        { input: 1.5, output: 7.5, cacheRead: 0.1, cacheWrite: 0.2, range: [0, 200_001] },
        { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.4, range: [200_001] },
      ],
    };
    setManifestPlugins(manifestMocks, [createMistralManifestPlugin({ cost })]);
    expect(resolveBundledStaticCatalogModel({ ...mistralLookup, cfg: {} })).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      contextWindow: 262144,
      cost: {
        ...cost,
        tieredPricing: [
          cost.tieredPricing![0],
          { ...cost.tieredPricing![1], range: [200_001, Infinity] },
        ],
      },
      id: "mistral-medium-3-5",
      input: ["text", "image"],
      maxTokens: 8192,
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low", max: "max" },
    });
  });

  it("ignores non-bundled and non-static manifest catalog rows", () => {
    for (const plugin of [
      createMistralManifestPlugin({ origin: "workspace" }),
      createMistralManifestPlugin({ discovery: "refreshable" }),
      createMistralManifestPlugin({ discovery: "runtime" }),
    ]) {
      setManifestPlugins(manifestMocks, [plugin]);

      expect(resolveBundledStaticCatalogModel({ ...mistralLookup, cfg: {} })).toBeUndefined();
    }
  });
});

describe("resolveBundledProviderStaticCatalogModel", () => {
  it("keeps successful provider context rows when another static catalog fails", async () => {
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google", "minimax"]);
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: ["google", "minimax"].map((id) =>
        createManifestRecord(id, {
          providerDiscoverySource: `/fixtures/${id}/provider-discovery.ts`,
        }),
      ),
    });
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockImplementation(
      async ({ onlyPluginIds }: { onlyPluginIds: string[] }) =>
        onlyPluginIds[0] === "google"
          ? [{ id: "google", pluginId: "google", label: "Google", auth: [] }]
          : [{ id: "minimax", pluginId: "minimax", label: "MiniMax", auth: [] }],
    );
    providerMocks.runProviderStaticCatalog.mockImplementation(
      async ({ provider }: { provider: { id: string } }) => {
        if (provider.id === "minimax") {
          throw new Error("catalog unavailable");
        }
        return { marker: "google-static-result" };
      },
    );
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini Pro",
            contextWindow: 1_048_576,
          },
        ],
      },
    });

    await expect(loadBundledProviderStaticCatalogContextModels()).resolves.toEqual([
      expect.objectContaining({ provider: "google", contextWindow: 1_048_576 }),
    ]);
  });

  it("does not load bundled provider static catalogs when owner policy blocks the plugin", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveActivatableProviderOwnerPluginIds.mockReturnValue([]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        cfg: { plugins: { entries: { google: { enabled: false } } } },
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(providerMocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("does not borrow nested provider context across plugin owners", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider }: { provider: string }) =>
        ["openrouter", "anthropic"].includes(provider) ? [provider] : undefined,
    );
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([
      "anthropic",
      "openrouter",
    ]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([
      { id: "openrouter", pluginId: "openrouter", label: "OpenRouter", auth: [] },
    ]);
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});

    const resolveContext = createBundledProviderStaticCatalogContextResolver();
    await expect(
      resolveContext({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });
});

function aliasPlugin(
  id: string,
  aliases: Record<string, ModelCatalogAlias>,
  overrides: Partial<PluginManifestRecord> = {},
): PluginManifestRecord {
  return createManifestRecord(id, {
    id,
    origin: "bundled",
    enabledByDefault: true,
    providers: [id],
    modelCatalog: { aliases },
    ...overrides,
  });
}
function configuredAlias(provider: string, baseUrl: string, api?: ModelCatalogAlias["api"]) {
  return { models: { providers: { [provider]: { baseUrl, api, models: [] } } } };
}
function setPlugins(...plugins: ReturnType<typeof aliasPlugin>[]) {
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins });
}
function conflictingPlugins() {
  setPlugins(
    aliasPlugin("openai", {
      [azureAlias]: { provider: "openai", api: azureAlias },
    }),
    aliasPlugin(
      "workspace-override",
      { [azureAlias]: { provider: "github-copilot" } },
      { origin: "workspace", enabledByDefault: false, providers: ["github-copilot"] },
    ),
  );
}

describe("manifest provider aliases", () => {
  it("reuses the current plugin metadata snapshot for repeated alias lookups", () => {
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({
      plugins: [aliasPlugin("moonshot", { "moonshot-ai": { provider: "moonshot" } })],
    });
    expect(resolveAlias({ provider: "moonshot-ai" })).toEqual({ provider: "moonshot" });
    expect(resolveAlias({ provider: "moonshot-ai" })).toEqual({ provider: "moonshot" });
    expect(manifestMocks.loadPluginManifestRegistryCore).not.toHaveBeenCalled();
  });

  it("keeps custom environments on their own manifest registry context", () => {
    const env = { HOME: "/custom-home" };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
    setPlugins(aliasPlugin("moonshot", { "moonshot-ai": { provider: "moonshot" } }));
    expect(resolveAlias({ provider: "moonshot-ai", env })).toEqual({ provider: "moonshot" });
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("canonicalizes endpoint-less aliases and retains complete transport metadata", () => {
    setPlugins(
      aliasPlugin(
        "openai",
        {},
        {
          modelCatalog: {
            aliases: {
              [azureAlias]: { provider: "openai", api: azureAlias },
              "openai-fixed-endpoint": {
                provider: "openai",
                baseUrl: "https://manifest-alias.example.com/openai/v1",
              },
            },
          },
        },
      ),
    );
    expect(resolveAlias({ provider: azureAlias })).toEqual({ provider: "openai" });
    expect(
      resolveAlias({
        provider: azureAlias,
        modelId: "gpt-5.5",
        cfg: configuredAlias(azureAlias, azureEndpoint),
      }),
    ).toEqual({ provider: azureAlias, transport: { api: azureAlias } });
    expect(
      resolveAlias({
        provider: "openai-fixed-endpoint",
        modelId: "gpt-5.5",
        cfg: configuredAlias(
          "openai-fixed-endpoint",
          "https://configured-alias.example.com/v1",
          "anthropic-messages",
        ),
      }),
    ).toEqual({
      provider: "openai-fixed-endpoint",
      transport: {
        api: "anthropic-messages",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      },
    });
  });

  it("canonicalizes transport aliases with unconditional suppressions", () => {
    setPlugins(
      aliasPlugin(
        "target-provider",
        {},
        {
          modelCatalog: {
            aliases: {
              "conditional-alias": { provider: "target-provider", api: "openai-responses" },
            },
            suppressions: [{ provider: "conditional-alias", model: "conditional-model" }],
          },
        },
      ),
    );
    expect(
      resolveAlias({
        provider: "conditional-alias",
        modelId: "conditional-model",
        cfg: configuredAlias(
          "conditional-alias",
          "https://matching.example.com/v1",
          "openai-responses",
        ),
      }),
    ).toEqual({ provider: "target-provider" });
  });

  it.each([false, true])(
    "rejects conflicting aliases only when the workspace owner is active (%s)",
    (active) => {
      conflictingPlugins();
      const cfg = configuredAlias(azureAlias, azureEndpoint);
      expect(
        resolveAlias({
          provider: azureAlias,
          modelId: "gpt-5.4-mini",
          cfg: active
            ? { ...cfg, plugins: { entries: { "workspace-override": { enabled: true } } } }
            : cfg,
        }),
      ).toEqual(
        active
          ? { provider: azureAlias, ambiguous: true }
          : { provider: azureAlias, transport: { api: azureAlias } },
      );
    },
  );
});
