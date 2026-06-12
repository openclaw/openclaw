// Coverage for resolving bundled static manifest model catalog rows.
import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
}));
const providerMocks = vi.hoisted(() => ({
  normalizePluginDiscoveryResult: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveOwningPluginIdsForProviderRef: vi.fn(),
  resolveRuntimePluginDiscoveryProviders: vi.fn(),
  runProviderStaticCatalog: vi.fn(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveBundledProviderCompatPluginIds: providerMocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef: providerMocks.resolveOwningPluginIdsForProviderRef,
}));

vi.mock("../../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-discovery.js")>()),
  normalizePluginDiscoveryResult: providerMocks.normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders: providerMocks.resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog: providerMocks.runProviderStaticCatalog,
}));

import { getModelProviderRequestTransport } from "../provider-request-config.js";
import {
  resolveBundledProviderStaticCatalogModel,
  resolveBundledStaticCatalogModel,
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
}) {
  // Mistral fixture represents a bundled plugin with a static modelCatalog row.
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
              cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
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
  manifestMocks.listOpenClawPluginManifestMetadata.mockReset();
  manifestMocks.loadPluginManifest.mockReset();
  providerMocks.normalizePluginDiscoveryResult.mockReset();
  providerMocks.resolveBundledProviderCompatPluginIds.mockReset();
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReset();
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockReset();
  providerMocks.runProviderStaticCatalog.mockReset();
  setManifestPlugins([]);
  providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);
  providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(undefined);
  providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([]);
  providerMocks.runProviderStaticCatalog.mockResolvedValue(undefined);
  providerMocks.normalizePluginDiscoveryResult.mockReturnValue({});
});

describe("resolveBundledStaticCatalogModel", () => {
  it("synthesizes a runtime model from an exact bundled static manifest catalog row", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
    });

    expect(model).toEqual({
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      compat: undefined,
      contextTokens: undefined,
      contextWindow: 262144,
      cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
      headers: undefined,
      id: "mistral-medium-3-5",
      input: ["text", "image"],
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
      name: "Mistral Medium 3.5",
      provider: "mistral",
      reasoning: true,
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
          provider: "mistral",
          modelId: "mistral-medium-3-5",
          cfg: {},
        }),
      ).toBeUndefined();
    }
  });

  it("can include bundled runtime-discovery manifest catalog rows for configured fallbacks", () => {
    setManifestPlugins([createMistralManifestPlugin({ discovery: "runtime" })]);

    const model = resolveBundledStaticCatalogModel({
      provider: "mistral",
      modelId: "mistral-medium-3-5",
      cfg: {},
      includeRuntimeDiscovery: true,
    });

    expect(model?.maxTokens).toBe(8192);
  });

  it("requires an exact provider and model match", () => {
    setManifestPlugins([createMistralManifestPlugin()]);

    expect(
      resolveBundledStaticCatalogModel({
        provider: "mistral",
        modelId: "mistral-medium-2508",
        cfg: {},
      }),
    ).toBeUndefined();
    expect(
      resolveBundledStaticCatalogModel({
        provider: "openrouter",
        modelId: "mistral-medium-3-5",
        cfg: {},
      }),
    ).toBeUndefined();
  });
});

describe("resolveBundledProviderStaticCatalogModel", () => {
  it("resolves exact rows from bundled provider static catalogs", async () => {
    const cfg = { plugins: { entries: { google: { enabled: true } } } };
    const provider = {
      id: "google",
      pluginId: "google",
      label: "Google",
      auth: [],
      staticCatalog: { run: vi.fn() },
    };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.runProviderStaticCatalog.mockResolvedValue({ marker: "static-result" });
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "google-generative-ai",
        authHeader: true,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        request: { headers: { "X-Static-Catalog": "yes" } },
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 1_048_576,
            maxTokens: 65_536,
            mediaInput: { image: { maxSidePx: 3072, tokenMode: "provider" } },
          },
        ],
      },
    });

    const model = await resolveBundledProviderStaticCatalogModel({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg,
    });

    expect(model).toMatchObject({
      api: "google-generative-ai",
      authHeader: true,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      contextTokens: undefined,
      contextWindow: 1_048_576,
      cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
      headers: { "X-Static-Catalog": "yes" },
      id: "gemini-3.1-pro-preview",
      input: ["text", "image"],
      maxTokens: 65_536,
      mediaInput: { image: { maxSidePx: 3072, tokenMode: "provider" } },
      name: "Gemini 3.1 Pro Preview",
      provider: "google",
      reasoning: true,
    });
    expect(getModelProviderRequestTransport(model!)).toEqual({
      headers: { "X-Static-Catalog": "yes" },
    });
    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: undefined,
      env: process.env,
      onlyPluginIds: ["google"],
      includeUntrustedWorkspacePlugins: false,
      requireCompleteDiscoveryEntryCoverage: true,
      discoveryEntriesOnly: true,
      includeManifestModelCatalogProviders: false,
    });
    expect(providerMocks.runProviderStaticCatalog).toHaveBeenCalledWith({
      provider,
      config: cfg,
      workspaceDir: undefined,
      env: process.env,
    });
  });

  it("does not load provider catalogs when the provider owner is not bundled and enabled", async () => {
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue([]);

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        cfg: {},
      }),
    ).resolves.toBeUndefined();

    expect(providerMocks.resolveRuntimePluginDiscoveryProviders).not.toHaveBeenCalled();
    expect(providerMocks.runProviderStaticCatalog).not.toHaveBeenCalled();
  });

  it("requires an exact provider and model match", async () => {
    const provider = { id: "google", pluginId: "google", label: "Google", auth: [] };
    providerMocks.resolveOwningPluginIdsForProviderRef.mockReturnValue(["google"]);
    providerMocks.resolveBundledProviderCompatPluginIds.mockReturnValue(["google"]);
    providerMocks.resolveRuntimePluginDiscoveryProviders.mockResolvedValue([provider]);
    providerMocks.normalizePluginDiscoveryResult.mockReturnValue({
      google: {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }],
      },
      "google-vertex": {
        api: "google-vertex",
        baseUrl: "https://aiplatform.googleapis.com/v1",
        models: [{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" }],
      },
    });

    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "google",
        modelId: "gemini-2.5-pro",
        cfg: {},
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveBundledProviderStaticCatalogModel({
        provider: "openrouter",
        modelId: "gemini-3.1-pro-preview",
        cfg: {},
      }),
    ).resolves.toBeUndefined();
  });
});
