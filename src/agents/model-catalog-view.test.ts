import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { loadPreparedModelCatalogView, prepareModelCatalogView } from "./model-catalog-view.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  setPreparedModelRuntimeAuthLabels,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";

const mocks = vi.hoisted(() => ({ loadSnapshot: vi.fn(), loadOwner: vi.fn(), metadata: vi.fn() }));
vi.mock("./prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: mocks.loadSnapshot,
  loadPreparedModelCatalogOwnerSnapshot: mocks.loadOwner,
  getPublishedPreparedModelCatalogOwnerSnapshot: () => undefined,
  materializePreparedModelCatalogOwner: (owner: object) => owner,
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => {
  const { rebasePluginMetadataSnapshotManifestRegistry } =
    await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>();
  return {
    rebasePluginMetadataSnapshotManifestRegistry,
    resolvePluginMetadataSnapshot: mocks.metadata,
  };
});

const row = (provider: string, id: string): ModelCatalogEntry => ({ provider, id, name: id });
const snapshot = (entries: ModelCatalogEntry[]): ModelCatalogSnapshot => ({
  entries,
  routeVariants: entries,
});
const facts = (cfg: OpenClawConfig = {}) => ({
  cfg,
  agentId: "main",
  agentDir: "/tmp/catalog-view-agent",
  workspaceDir: "/tmp/catalog-view-workspace",
  snapshot: snapshot([]),
  metadataSnapshot: createPluginMetadataSnapshotFixture(),
});

describe("prepared model catalog view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadata.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.loadOwner.mockImplementation(() => {
      throw new Error("Scoped browsing acquired the full catalog");
    });
  });

  it("keeps missing runtime credentials labeled missing", async () => {
    const prepared = facts();
    const owner = { ...prepared, config: prepared.cfg, modelCatalog: prepared.snapshot };
    const missing = {
      provider: "openai",
      profiles: {},
      fallback: "missing",
      source: "auth profile store",
      apiKeyOnly: false,
    };
    setPreparedModelRuntimeAuthLabels(
      owner,
      new Map([["openai", { all: missing, apiKey: missing }]]),
    );
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
    mocks.loadOwner.mockResolvedValue(owner);
    const view = await loadPreparedModelCatalogView({
      kind: "status",
      config: {},
      agentId: "main",
      agentDir: prepared.agentDir,
      workspaceDir: prepared.workspaceDir,
      entries: [row("codex", "unavailable")],
      sessionEntry: { agentRuntimeOverride: "codex" },
    });
    expect(view.providerAuthLabels.get("codex")).toBe("missing");
  });

  it("keeps exact provider display endpoints separate from captured model routes", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "z.ai": {
            baseUrl: " https://api.z.ai/api/paas/v4 ",
            api: "openai-responses",
            models: [],
          },
          zai: { baseUrl: "https://other.example/v1", models: [] },
        },
      },
    };
    const entries: ModelCatalogEntry[] = [
      { ...row("z.ai", "first"), baseUrl: "https://first.example/v1", api: "openai-completions" },
      { ...row("z.ai", "second"), baseUrl: "https://second.example/v1", api: "openai-responses" },
      {
        ...row("openai", "built-in"),
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
      },
    ];
    const view = prepareModelCatalogView({ ...facts(cfg), snapshot: snapshot(entries) });
    expect(view.providerEndpoints.get("z.ai")).toEqual({
      endpoint: "https://api.z.ai/api/paas/v4",
      api: "openai-responses",
    });
    expect(view.providerEndpoints.get("openai")).toBeUndefined();
    expect(view.catalog).toEqual(entries);
  });

  it("includes only configured static identities and preserves committed rows", () => {
    const committed = { ...row("custom", "vendor/model"), name: "Committed" };
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "custom/vendor/model", models: { "custom/extra": {} } } },
    };
    const captured = {
      ...snapshot([committed]),
      staticEntries: [
        row("custom", "vendor/model"),
        row("custom", "model"),
        row("custom", "extra"),
      ],
    };
    expect(
      prepareModelCatalogView({ ...facts(cfg), snapshot: captured, view: "configured" }).catalog,
    ).toEqual([committed, row("custom", "extra")]);
    expect(
      prepareModelCatalogView({ ...facts(cfg), snapshot: captured, view: "default" }).catalog,
    ).toEqual([committed]);
  });

  it("uses authored inventory membership with canonical route metadata", () => {
    const model = (id: string): ModelDefinitionConfig => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 1024,
    });
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://authored.example/v1",
            models: [model("kept"), model("private")],
          },
        },
      },
    };
    const canonical: ModelCatalogEntry = {
      ...row("custom", "kept"),
      api: "openai-responses",
      baseUrl: "https://canonical.example/v1",
    };
    const inventory = prepareModelCatalogView(facts(cfg)).providerInventory(cfg, [
      canonical,
      row("custom", "other"),
    ]);
    expect(inventory).toMatchObject([canonical, { provider: "custom", id: "private" }]);
    expect(inventory.map(({ id }) => id)).toEqual(["kept", "private"]);
  });

  it.each(["runtime", "refreshable", "static"] as const)(
    "distinguishes omitted from empty %s inventory",
    (discovery) => {
      const provider = { baseUrl: "https://catalog.example/v1", models: [] };
      const cfg: OpenClawConfig = { models: { providers: { custom: provider } } };
      const view = prepareModelCatalogView({
        ...facts(cfg),
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "custom",
              providers: ["custom"],
              modelCatalog: { discovery: { custom: discovery } },
            },
          ],
        }),
      });
      const canonical = [row("custom", "discovered"), row("other", "hidden")];
      expect(view.providerInventory(cfg, canonical)).toEqual([]);
      // Authored provider declarations can omit inventory before config normalization.
      Reflect.deleteProperty(provider, "models");
      expect(view.providerInventory(cfg, canonical)).toEqual(
        discovery === "static" ? [] : [row("custom", "discovered")],
      );
    },
  );

  it.each(["nvidia", "kimi"])(
    "scopes %s acquisition and all returned facts to the canonical provider",
    async (requested) => {
      let refreshFailed = false;
      const provider = requested === "kimi" ? "moonshot" : "nvidia";
      mocks.metadata.mockReturnValue(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "moonshot",
              providers: ["moonshot"],
              modelCatalog: { aliases: { kimi: { provider: "moonshot" } } },
            },
          ],
        }),
      );
      mocks.loadSnapshot.mockResolvedValue({
        get refreshFailed() {
          return refreshFailed;
        },
        authoritative: false,
        entries: [row(provider, "chosen"), row("other", "hidden")],
        routeVariants: [row(provider, "physical"), row("other", "hidden")],
        staticEntries: [row(provider, "static"), row("other", "hidden")],
        providerOutcomes: [
          { provider, status: "unavailable" },
          { provider: "other", status: "ready" },
        ],
      });
      const result = await loadPreparedModelCatalogView({
        kind: "picker",
        config: {},
        preferredProvider: requested.toUpperCase(),
        preferLiveProviderCatalog: true,
        providerScoped: true,
        agentDir: "/tmp/catalog-view-agent",
        workspaceDir: "/tmp/catalog-view-workspace",
        env: {},
      });
      expect(result.snapshot).toEqual({
        refreshFailed: false,
        authoritative: false,
        entries: [row(provider, "chosen")],
        routeVariants: [row(provider, "physical")],
        staticEntries: [row(provider, "static")],
        providerOutcomes: [{ provider, status: "unavailable" }],
      });
      expect(mocks.loadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          readOnly: true,
          providerDiscoveryProviderIds: [provider],
          scopedLiveProviderDiscovery: true,
          agentDir: "/tmp/catalog-view-agent",
          workspaceDir: "/tmp/catalog-view-workspace",
          env: {},
        }),
      );
      expect(mocks.loadOwner).not.toHaveBeenCalled();
      refreshFailed = true;
      expect(result.snapshot.refreshFailed).toBe(true);
    },
  );
});

const nativeEntry = { ...row("custom", "native-model"), nativeRuntime: "native-test" };
const host: ModelAuthAvailabilityEvaluation = { availability: false, routeResolution: null };
function nativeRegistry(readiness: () => { accountType: string; authMode: string } | undefined) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "native-test",
    source: "fixture",
    harness: {
      id: "native-test",
      label: "Native test",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      readModelCatalogReadiness: readiness,
      async runAttempt() {
        throw new Error("Catalog reads must not run a model");
      },
    },
  });
  return registry;
}

describe("prepared native catalog readiness", () => {
  it("reads prepared native rows without discovering a harness catalog", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "custom/native-model",
          models: { "custom/native-model": { agentRuntime: { id: "native-test" } } },
        },
      },
    };
    const registry = nativeRegistry(() => ({ accountType: "apiKey", authMode: "oauth" }));
    const loadModelCatalog = vi.fn(async () => [nativeEntry]);
    registry.agentHarnesses[0]!.harness.loadModelCatalog = loadModelCatalog;
    const result = await loadPreparedModelCatalogView({
      kind: "prepared",
      ...facts(cfg),
      snapshot: snapshot([nativeEntry]),
      pluginRegistry: registry,
      refreshNative: false,
    });
    expect(result.catalog).toEqual([nativeEntry]);
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("observes revoked login and generation without retaining prior readiness", () => {
    let ready = true;
    let current = true;
    const cfg: OpenClawConfig = {};
    const view = prepareModelCatalogView({
      ...facts(cfg),
      snapshot: snapshot([nativeEntry]),
      observationConfig: cfg,
      pluginRegistry: nativeRegistry(() =>
        ready ? { accountType: "apiKey", authMode: "oauth" } : undefined,
      ),
      isCurrent: () => current,
    });
    expect(view.evaluateNative(nativeEntry, host, "native-test")).toMatchObject({
      availability: true,
      runtimeAuth: { id: "native-test", source: "native" },
      selectedAuthMode: "oauth",
    });
    ready = false;
    expect(view.evaluateNative(nativeEntry, host, "native-test")).toMatchObject({
      availability: false,
    });
    ready = true;
    current = false;
    expect(view.evaluateNative(nativeEntry, host, "native-test")).toMatchObject({
      availability: false,
    });
  });

  it("reads the captured registry while an unrelated registry is active", () => {
    const previous = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(nativeRegistry(() => undefined));
    try {
      const cfg: OpenClawConfig = {};
      const view = prepareModelCatalogView({
        ...facts(cfg),
        snapshot: snapshot([nativeEntry]),
        observationConfig: cfg,
        isCurrent: () => true,
        pluginRegistry: nativeRegistry(() => ({ accountType: "apiKey", authMode: "oauth" })),
      });
      expect(view.evaluateNative(nativeEntry, host, "native-test").availability).toBe(true);
    } finally {
      restoreActivePluginRegistrySnapshot(previous);
    }
  });

  it.each([
    { name: "preferred account", preferredProfileId: "custom:chosen", cfg: {} },
    { name: "pinned account", pinnedProfileId: "custom:chosen", cfg: {} },
    {
      name: "authored route",
      cfg: {
        models: { providers: { custom: { baseUrl: "https://host.example/v1", models: [] } } },
      },
    },
    { name: "request parameters", cfg: { agents: { defaults: { params: { temperature: 0.2 } } } } },
  ])("keeps $name under host authentication", ({ cfg, ...selection }) => {
    const view = prepareModelCatalogView({
      ...facts(cfg),
      ...selection,
      snapshot: snapshot([nativeEntry]),
      observationConfig: cfg,
      isCurrent: () => true,
      pluginRegistry: nativeRegistry(() => ({ accountType: "apiKey", authMode: "oauth" })),
    });
    expect(view.evaluateNative(nativeEntry, host, "native-test")).toEqual(host);
  });
});
