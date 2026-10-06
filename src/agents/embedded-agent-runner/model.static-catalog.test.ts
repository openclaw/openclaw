import type { ModelCatalogAlias } from "@openclaw/model-catalog-core/model-catalog-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { createManifestRecord } from "./model.static-catalog.test-helpers.js";

const mistralLookup = { provider: "mistral", modelId: "mistral-medium-3-5" };

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

import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  createBundledProviderStaticCatalogContextResolver,
  loadBundledProviderStaticCatalogContextModels,
  resolveBundledProviderStaticCatalogModel,
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata as resolveAlias,
} from "./model.static-catalog.js";

function setManifestPlugins(plugins: unknown[]) {
  // Static catalog resolution reads scan metadata first, then loads the manifest
  // from disk; the mock preserves that two-step contract.
  const byPluginDir = new Map(
    plugins.map((plugin) => {
      const id = (plugin as { id?: string }).id ?? "plugin";
      return [`/fixtures/${id}`, plugin];
    }),
  );
  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue(
    [...byPluginDir].map(([pluginDir, plugin]) => ({
      pluginDir,
      manifest: plugin,
      origin: (plugin as { origin?: string }).origin,
    })),
  );
  manifestMocks.loadPluginManifest.mockImplementation((pluginDir: string) => {
    const plugin = byPluginDir.get(pluginDir);
    return plugin
      ? { ok: true, manifest: plugin }
      : { ok: false, error: "missing manifest", manifestPath: `${pluginDir}/openclaw.plugin.json` };
  });
}

function createMistralManifestPlugin(overrides?: {
  discovery?: "static" | "refreshable" | "runtime";
  origin?: string;
  cost?: ModelDefinitionConfig["cost"];
}) {
  return {
    id: "mistral",
    origin: overrides?.origin ?? "bundled",
    providers: ["mistral"],
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
              mediaInput: {
                image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
              },
            },
          ],
        },
      },
      discovery: {
        mistral: overrides?.discovery ?? "static",
      },
    },
  };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const mock of [...Object.values(manifestMocks), ...Object.values(providerMocks)]) {
    mock.mockReset();
  }
  setManifestPlugins([]);
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
  it("keeps static catalog plans inside their metadata owner for the same env and config", () => {
    const plugin = createMistralManifestPlugin();
    setManifestPlugins([plugin]);
    const env = {};
    const cfg = {};
    const lookup = { ...mistralLookup, cfg, env };
    expect(resolveBundledStaticCatalogModel(lookup)?.contextWindow).toBe(262144);
    const updated = createMistralManifestPlugin();
    updated.modelCatalog.providers.mistral.models[0]!.contextWindow = 524288;
    setManifestPlugins([updated]);

    expect(resolveBundledStaticCatalogModel(lookup)?.contextWindow).toBe(262144);
    expect(
      withPluginCache(createPluginCache(), () => resolveBundledStaticCatalogModel(lookup))
        ?.contextWindow,
    ).toBe(524288);
    expect(resolveBundledStaticCatalogModel(lookup)?.contextWindow).toBe(262144);
  });

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
    setManifestPlugins([createMistralManifestPlugin({ cost })]);
    expect(
      resolveBundledStaticCatalogModel({
        ...mistralLookup,
        cfg: {},
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      compat: undefined,
      contextTokens: undefined,
      contextWindow: 262144,
      cost: {
        ...cost,
        tieredPricing: [
          cost.tieredPricing![0],
          { ...cost.tieredPricing![1], range: [200_001, Infinity] },
        ],
      },
      headers: undefined,
      id: "mistral-medium-3-5",
      input: ["text", "image"],
      maxTokens: 8192,
      mediaInput: { image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" } },
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: "low", max: "max" },
    });
  });

  it("ignores non-bundled and non-static manifest catalog rows", () => {
    // Workspace plugins and refreshable/runtime catalogs are not process-stable
    // enough for this fallback path.
    for (const plugin of [
      createMistralManifestPlugin({ origin: "workspace" }),
      createMistralManifestPlugin({ discovery: "refreshable" }),
      createMistralManifestPlugin({ discovery: "runtime" }),
    ]) {
      setManifestPlugins([plugin]);

      expect(
        resolveBundledStaticCatalogModel({
          ...mistralLookup,
          cfg: {},
        }),
      ).toBeUndefined();
    }
  });
});

function staticProvider(id: string) {
  return { id, pluginId: id, label: id, auth: [], staticCatalog: { run: vi.fn() } };
}

describe("resolveBundledProviderStaticCatalogModel", () => {
  it("keeps successful provider context rows when another static catalog fails", async () => {
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google", "minimax"]);
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        createManifestRecord("google", {
          providerDiscoverySource: "/fixtures/google/provider-discovery.ts",
        }),
        createManifestRecord("minimax", {
          providerDiscoverySource: "/fixtures/minimax/provider-discovery.ts",
        }),
      ],
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

  it("runs each prepared provider static catalog once", async () => {
    const provider = staticProvider("google");
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini Pro", contextWindow: 1_048_576 }],
      },
    });

    const resolveModel = createBundledProviderStaticCatalogContextResolver();
    await expect(
      resolveModel({ provider: "google", modelId: "gemini-3.1-pro-preview" }),
    ).resolves.toEqual({ contextWindow: 1_048_576 });
    await expect(
      resolveModel({ provider: "google", modelId: "missing-model" }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledTimes(1);
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not borrow nested provider context across plugin owners", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockImplementation(
      ({ provider }: { provider: string }) => {
        if (provider === "openrouter") {
          return ["openrouter"];
        }
        if (provider === "anthropic") {
          return ["anthropic"];
        }
        return undefined;
      },
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
) {
  return {
    id,
    origin: "bundled",
    enabledByDefault: true,
    providers: [id],
    modelCatalog: { aliases },
    ...overrides,
  };
}
function configuredAlias(provider: string, baseUrl: string, api?: ModelCatalogAlias["api"]) {
  return { models: { providers: { [provider]: { baseUrl, api, models: [] } } } };
}
function setPlugins(...plugins: ReturnType<typeof aliasPlugin>[]) {
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins });
}
function suppressedAliasPlugin() {
  return aliasPlugin(
    "target-provider",
    {},
    {
      modelCatalog: {
        aliases: { "conditional-alias": { provider: "target-provider", api: "openai-responses" } },
        suppressions: [
          {
            provider: "conditional-alias",
            model: "conditional-model",
          },
        ],
      },
    },
  );
}
function conflictingPlugins() {
  setPlugins(
    aliasPlugin("openai", {
      "azure-openai-responses": { provider: "openai", api: "azure-openai-responses" },
    }),
    aliasPlugin(
      "workspace-override",
      { "azure-openai-responses": { provider: "github-copilot" } },
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
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).toHaveBeenLastCalledWith({
      config: undefined,
      env: process.env,
      requireDefaultDiscoveryContext: true,
      workspaceDir: undefined,
    });
  });

  it("keeps custom environments on their own manifest registry context", () => {
    const env = { HOME: "/custom-home" };
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
    setPlugins(aliasPlugin("moonshot", { "moonshot-ai": { provider: "moonshot" } }));
    expect(resolveAlias({ provider: "moonshot-ai", env })).toEqual({ provider: "moonshot" });
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifestRegistryCore).toHaveBeenCalledWith({
      config: undefined,
      env,
      workspaceDir: undefined,
    });
  });

  it("canonicalizes endpoint-less aliases and retains complete transport metadata", () => {
    setPlugins(
      aliasPlugin(
        "openai",
        {},
        {
          modelCatalog: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                models: [{ id: "gpt-5.5", name: "gpt-5.5" }],
              },
            },
            aliases: {
              "azure-openai-responses": { provider: "openai", api: "azure-openai-responses" },
              "openai-fixed-endpoint": {
                provider: "openai",
                baseUrl: "https://manifest-alias.example.com/openai/v1",
              },
            },
            discovery: { openai: "runtime" },
          },
        },
      ),
    );
    expect(resolveAlias({ provider: "azure-openai-responses" })).toEqual({ provider: "openai" });
    expect(
      resolveAlias({
        provider: "azure-openai-responses",
        modelId: "gpt-5.5",
        cfg: configuredAlias(
          "azure-openai-responses",
          "https://example.openai.azure.com/openai/v1",
        ),
      }),
    ).toEqual({ provider: "azure-openai-responses", transport: { api: "azure-openai-responses" } });
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
    setPlugins(suppressedAliasPlugin());
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
      const cfg = configuredAlias(
        "azure-openai-responses",
        "https://example.openai.azure.com/openai/v1",
      );
      expect(
        resolveAlias({
          provider: "azure-openai-responses",
          modelId: "gpt-5.4-mini",
          cfg: active
            ? { ...cfg, plugins: { entries: { "workspace-override": { enabled: true } } } }
            : cfg,
        }),
      ).toEqual(
        active
          ? { provider: "azure-openai-responses", ambiguous: true }
          : { provider: "azure-openai-responses", transport: { api: "azure-openai-responses" } },
      );
    },
  );
});
