import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

const manifestMocks = vi.hoisted(() => ({
  getGatewayPluginMetadataSnapshot: vi.fn(),
  getCurrentPluginMetadataSnapshot: vi.fn(),
  listOpenClawPluginManifestMetadata: vi.fn(),
  loadPluginManifest: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
}));

vi.mock("../../plugins/current-plugin-metadata-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-state.js")>()),
  getGatewayPluginMetadataSnapshot: manifestMocks.getGatewayPluginMetadataSnapshot,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope: (_snapshot: unknown, run: () => unknown) => run(),
}));

vi.mock("../../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: manifestMocks.listOpenClawPluginManifestMetadata,
}));

vi.mock("../../plugins/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest.js")>()),
  loadPluginManifest: manifestMocks.loadPluginManifest,
}));

vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifestMocks.loadPluginManifestRegistryCore,
}));

import {
  createBundledStaticCatalogModelResolver,
  resolveBundledStaticCatalogModel,
} from "./model.static-catalog.js";

const mistralLookup = { provider: "mistral", modelId: "mistral-medium-3-5" };

function createMistralManifestPlugin(id = "mistral-medium-3-5", name = "Mistral Medium 3.5") {
  return {
    id: "mistral",
    origin: "bundled",
    providers: ["mistral"],
    modelCatalog: {
      providers: {
        mistral: {
          baseUrl: "https://api.mistral.ai/v1",
          api: "openai-completions",
          models: [
            {
              id,
              name,
              contextWindow: 262144,
              maxTokens: 8192,
            },
          ],
        },
      },
      discovery: { mistral: "static" },
    },
  } satisfies Partial<PluginManifestRecord>;
}

function setCurrentManifestPlugins(
  plugins: Array<Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">>,
) {
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
  return snapshot;
}

function setManifestPlugins(plugins: ReturnType<typeof createMistralManifestPlugin>[]) {
  const byPluginDir = new Map(
    plugins.map((plugin) => {
      const id = plugin.id;
      return [`/fixtures/${id}`, plugin];
    }),
  );
  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue(
    [...byPluginDir].map(([pluginDir, plugin]) => ({
      pluginDir,
      manifest: plugin,
      origin: plugin.origin,
    })),
  );
  manifestMocks.loadPluginManifest.mockImplementation((pluginDir: string) => {
    const plugin = byPluginDir.get(pluginDir);
    return plugin
      ? { ok: true, manifest: plugin }
      : { ok: false, error: "missing manifest", manifestPath: `${pluginDir}/openclaw.plugin.json` };
  });
}

function personalProviderConfig(baseUrl: string) {
  return {
    models: {
      providers: { personal: { api: "openai-completions" as const, baseUrl, models: [] } },
    },
  };
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const mock of Object.values(manifestMocks)) {
    mock.mockReset();
  }

  manifestMocks.listOpenClawPluginManifestMetadata.mockReturnValue([]);
  manifestMocks.loadPluginManifestRegistryCore.mockReturnValue({ plugins: [] });
});

it("caches native donor facts and misses without unrelated provider hooks", () => {
  const plugin = createMistralManifestPlugin();
  const metadataSnapshot = setCurrentManifestPlugins([plugin]);
  const normalizeTransport = vi.fn(() => undefined);
  const unrelatedTransport = vi.fn(() => {
    throw new Error("Unrelated provider hook reached");
  });
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push(
    {
      pluginId: "mistral",
      source: "test",
      provider: { id: "mistral", label: "Mistral", auth: [], normalizeTransport },
    },
    {
      pluginId: "unrelated",
      source: "test",
      provider: {
        id: "unrelated",
        label: "Unrelated",
        auth: [],
        normalizeTransport: unrelatedTransport,
      },
    },
  );
  const nativeConfig = personalProviderConfig("https://api.mistral.ai/v1");
  const proxyConfig = personalProviderConfig("http://localhost:4000");
  const lookup = { provider: "personal", modelId: "mistral-medium-3-5" };
  withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
    const resolve = createBundledStaticCatalogModelResolver({
      cfg: nativeConfig,
      metadataSnapshot,
    });
    const first = expectDefined(resolve(lookup), "Expected the native donor model");
    first.name = "Changed by caller";
    const second = resolve(lookup);
    expect(second).toMatchObject({ provider: "personal", name: "Mistral Medium 3.5" });
    expect(second).not.toBe(first);
    expect(normalizeTransport).toHaveBeenCalledTimes(1);
    const resolveProxy = createBundledStaticCatalogModelResolver({
      cfg: proxyConfig,
      metadataSnapshot,
    });
    expect(resolveProxy(lookup)).toBeUndefined();
    expect(resolveProxy(lookup)).toBeUndefined();
    expect(normalizeTransport).toHaveBeenCalledTimes(2);
    expect(unrelatedTransport).not.toHaveBeenCalled();
  });
  const replacement = setCurrentManifestPlugins([
    {
      ...plugin,
      modelCatalog: {
        ...plugin.modelCatalog,
        providers: {
          mistral: { ...plugin.modelCatalog.providers.mistral, baseUrl: "http://localhost:4000" },
        },
      },
    },
  ]);
  withPluginRuntimeGenerationScope({ metadataSnapshot: replacement, pluginRegistry }, () => {
    expect(
      resolveBundledStaticCatalogModel({
        ...lookup,
        cfg: proxyConfig,
        metadataSnapshot: replacement,
      }),
    ).toMatchObject({ provider: "personal" });
    expect(normalizeTransport).toHaveBeenCalledTimes(3);
  });
});

it("keeps a static donor miss separate from an allowed refreshable lookup", () => {
  const plugin = createMistralManifestPlugin();
  const metadataSnapshot = setCurrentManifestPlugins([
    {
      ...plugin,
      modelCatalog: { ...plugin.modelCatalog, discovery: { mistral: "refreshable" } },
    },
  ]);
  const cfg = personalProviderConfig("https://api.mistral.ai/v1");
  const lookup = { provider: "personal", modelId: "mistral-medium-3-5", cfg, metadataSnapshot };
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "mistral",
    source: "test",
    provider: { id: "mistral", label: "Mistral", auth: [], normalizeTransport: () => undefined },
  });
  withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
    expect(resolveBundledStaticCatalogModel(lookup)).toBeUndefined();
    expect(
      resolveBundledStaticCatalogModel({ ...lookup, includeRuntimeDiscovery: true }),
    ).toMatchObject({ provider: "personal" });
    expect(resolveBundledStaticCatalogModel(lookup)).toBeUndefined();
  });
});

describe("bundled static model catalog snapshot cache", () => {
  it("observes replacement plugin generations inside a prepared model resolver", () => {
    const cfg = {};
    setCurrentManifestPlugins([createMistralManifestPlugin()]);
    const resolveModel = createBundledStaticCatalogModelResolver({ cfg });

    expect(resolveModel(mistralLookup)?.id).toBe("mistral-medium-3-5");

    const replacementPlugin = createMistralManifestPlugin(
      "mistral-medium-next",
      "Mistral Medium Next",
    );
    setCurrentManifestPlugins([replacementPlugin]);

    expect(resolveModel(mistralLookup)).toBeUndefined();
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })?.name).toBe(
      "Mistral Medium Next",
    );
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("pins lifecycle lookups to the supplied plugin generation", () => {
    const cfg = {};
    const withAlias = (id: string, name: string) => ({
      ...createMistralManifestPlugin(id, name),
      modelIdNormalization: { providers: { mistral: { aliases: { latest: id } } } },
    });
    const capturedPlugin = withAlias("mistral-medium-3-5", "Mistral Medium 3.5");
    const capturedSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [capturedPlugin],
    });
    const resolveModel = createBundledStaticCatalogModelResolver({
      cfg,
      metadataSnapshot: capturedSnapshot,
    });

    const replacementPlugin = withAlias("mistral-medium-next", "Mistral Medium Next");
    setCurrentManifestPlugins([replacementPlugin]);

    expect(resolveModel(mistralLookup)?.id).toBe("mistral-medium-3-5");
    expect(resolveModel({ provider: "mistral", modelId: "latest" })?.id).toBe("mistral-medium-3-5");
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })).toBeUndefined();
    expect(manifestMocks.getCurrentPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("uses the Gateway inventory even when a run supplies its own environment", () => {
    const plugin = createMistralManifestPlugin();
    manifestMocks.getGatewayPluginMetadataSnapshot.mockReturnValue(
      setCurrentManifestPlugins([plugin]),
    );
    expect(
      resolveBundledStaticCatalogModel({
        ...mistralLookup,
        cfg: {},
        env: { HOME: "/run-home" },
        workspaceDir: "/run-workspace",
      })?.id,
    ).toBe("mistral-medium-3-5");
    expect(manifestMocks.listOpenClawPluginManifestMetadata).not.toHaveBeenCalled();
    expect(manifestMocks.loadPluginManifest).not.toHaveBeenCalled();
  });

  it("refreshes a retained no-snapshot resolver at the plugin metadata lifecycle boundary", () => {
    const env = { HOME: "/custom-home" };
    const firstPlugin = createMistralManifestPlugin();
    setManifestPlugins([firstPlugin]);
    const resolveModel = createBundledStaticCatalogModelResolver({ env });

    expect(resolveModel(mistralLookup)?.id).toBe("mistral-medium-3-5");

    const replacementPlugin = createMistralManifestPlugin(
      "mistral-medium-next",
      "Mistral Medium Next",
    );
    setManifestPlugins([replacementPlugin]);
    expect(resolveModel(mistralLookup)?.id).toBe("mistral-medium-3-5");
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })).toBeUndefined();
    clearPluginMetadataLifecycleCaches();

    expect(resolveModel(mistralLookup)).toBeUndefined();
    expect(resolveModel({ provider: "mistral", modelId: "mistral-medium-next" })?.name).toBe(
      "Mistral Medium Next",
    );
    expect(manifestMocks.listOpenClawPluginManifestMetadata).toHaveBeenCalledTimes(2);
  });
});
