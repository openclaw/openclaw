import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicySurface from "../plugins/provider-policy-surface.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import {
  harnessRegistry,
  model,
  providerConfig,
  row,
  runtimeConfig,
  snapshot,
} from "./model-catalog-fixtures.test-support.js";
import {
  createModelCatalogView,
  loadPreparedModelCatalogView,
  prepareModelCatalogView,
  selectModelCatalogRuntimeEntry,
} from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";

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

const facts = (cfg: OpenClawConfig = {}) => ({
  cfg,
  agentId: "main",
  agentDir: "/tmp/catalog-view-agent",
  workspaceDir: "/tmp/catalog-view-workspace",
  snapshot: snapshot([]),
  metadataSnapshot: createPluginMetadataSnapshotFixture(),
});
type ViewOptions = Parameters<typeof prepareModelCatalogView>[0];
const prepare = (options: Partial<ViewOptions> = {}) =>
  prepareModelCatalogView({ ...facts(options.cfg), ...options });
const paired = (entry: ModelCatalogEntry) => ({ entry, runtimeEntry: entry });

describe("prepared model catalog view", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadata.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.loadOwner.mockImplementation(() => {
      throw new Error("Scoped browsing acquired the full catalog");
    });
  });

  it("groups physical variants without merging distinct model IDs", () => {
    vi.spyOn(providerPolicySurface, "resolveDirectBundledProviderPolicySurface").mockImplementation(
      (provider) =>
        provider === "fixture"
          ? { normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^vendor\//u, "") }
          : null,
    );
    const canonical = [row("fixture", "model-0"), row("fixture", "model-1")];
    const physical = canonical.map((entry) => ({ ...entry, id: `vendor/${entry.id}` }));
    const distinct = [row("unknown", "Reader"), row("unknown", "reader@variant")];
    const view = createModelCatalogView({
      cfg: {},
      catalog: [...canonical, ...physical, ...distinct],
    });

    expect(view.logicalEntries).toEqual([...canonical, ...distinct]);
    const variant = physical[0]!;
    expect(view.variantsOf(variant)).toEqual([canonical[0], variant]);
  });

  it("captures provider overrides until a new view is prepared", () => {
    const providers: Record<string, ModelProviderConfig> = { fixture: { baseUrl: "", models: [] } };
    const cfg = { models: { providers } };
    const catalog = [row("fixture", "model-0"), row("fixture", "model-1")];
    const keyOf = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
      `${entry.provider}/${entry.id}`;
    const params = { cfg, catalog, keyOf };
    const view = createModelCatalogView(params);
    expect(
      catalog.map((entry) => view.readProjection(entry, { kind: "unmanaged" }, keyOf(entry))),
    ).toEqual(catalog.map(paired));

    providers.fixture = {
      baseUrl: "",
      models: [{ ...model("model-0", "Configured"), maxTokens: 4096 }],
    };
    const freshEntry = row("fixture", "model-0");
    expect(view.readProjection(freshEntry, { kind: "unmanaged" }, keyOf(freshEntry))).toEqual(
      paired(freshEntry),
    );
    const nextView = createModelCatalogView(params);
    const expected: ModelCatalogEntry = {
      ...freshEntry,
      name: "Configured",
      reasoning: false,
      configuredReasoning: false,
      input: ["text"],
    };
    expect(nextView.readProjection(freshEntry, { kind: "unmanaged" }, keyOf(freshEntry))).toEqual(
      paired(expected),
    );
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
    bindPreparedModelRuntimeAuth(owner, {
      labels: new Map([["openai", { all: missing, apiKey: missing }]]),
      store: { version: 1, profiles: {} },
    });
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

  it("enriches permitted static choices and current metadata while preserving committed rows", () => {
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
    const choices = (view: ViewOptions["view"], retainedModel?: ViewOptions["retainedModel"]) =>
      prepare({ cfg, snapshot: captured, view, retainedModel }).catalog;
    expect(choices("configured")).toEqual([committed, row("custom", "extra")]);
    expect(choices("default")).toEqual([committed, row("custom", "extra")]);
    expect(choices("configured", { provider: "custom", model: "model" })).toEqual([
      committed,
      row("custom", "model"),
      row("custom", "extra"),
    ]);
  });

  it("sorts authored inventory independently of picker allowlists, using canonical route metadata", () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "custom/allowlisted": {} } } },
      ...providerConfig("custom", {
        baseUrl: "https://authored.example/v1",
        models: [model("private"), model("kept")],
      }),
    };
    const canonical: ModelCatalogEntry = {
      ...row("custom", "kept"),
      api: "openai-responses",
      baseUrl: "https://canonical.example/v1",
    };
    const inventory = prepare({ cfg }).providerInventory(cfg, [canonical, row("custom", "other")]);
    expect(inventory).toMatchObject([canonical, { provider: "custom", id: "private" }]);
    expect(inventory.map(({ id }) => id)).toEqual(["kept", "private"]);
  });

  it.each(["refreshable", "static"] as const)(
    "distinguishes omitted from empty %s inventory",
    (discovery) => {
      const provider = { baseUrl: "https://catalog.example/v1", models: [] };
      const cfg: OpenClawConfig = { models: { providers: { custom: provider } } };
      const view = prepare({
        cfg,
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

  it("scopes nvidia acquisition and all returned facts to the canonical provider", async () => {
    let refreshFailed = false;
    const provider = "nvidia";
    const scoped = {
      authoritative: false,
      entries: [row(provider, "chosen")],
      routeVariants: [row(provider, "physical")],
      staticEntries: [row(provider, "static")],
      providerOutcomes: [{ provider, status: "unavailable" }],
    };
    mocks.loadSnapshot.mockResolvedValue({
      ...scoped,
      get refreshFailed() {
        return refreshFailed;
      },
      entries: [...scoped.entries, row("other", "hidden")],
      routeVariants: [...scoped.routeVariants, row("other", "hidden")],
      staticEntries: [...scoped.staticEntries, row("other", "hidden")],
      providerOutcomes: [...scoped.providerOutcomes, { provider: "other", status: "ready" }],
    });
    const result = await loadPreparedModelCatalogView({
      kind: "picker",
      config: {},
      preferredProvider: provider.toUpperCase(),
      preferLiveProviderCatalog: true,
      providerScoped: true,
      agentDir: "/tmp/catalog-view-agent",
      workspaceDir: "/tmp/catalog-view-workspace",
      env: {},
    });
    expect(result.snapshot).toEqual({ ...scoped, refreshFailed: false });
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        providerDiscoveryProviderIds: [provider],
        scopedLiveProviderDiscovery: true,
      }),
    );
    expect(mocks.loadOwner).not.toHaveBeenCalled();
    refreshFailed = true;
    expect(result.snapshot.refreshFailed).toBe(true);
  });
});

const nativeEntry = { ...row("custom", "native-model"), nativeRuntime: "native-test" };
const host: ModelAuthAvailabilityEvaluation = { availability: false, routeResolution: null };
const subscriptionReadiness = () => ({ accountType: "subscription", authMode: "oauth" });
const apiEntry = { ...nativeEntry, nativeRuntime: undefined };
const nativeResult = (
  availability: boolean | undefined,
  extra: Partial<ModelAuthAvailabilityEvaluation> = {},
) => ({ availability, runtimeAuth: { id: "native-test", source: "native" }, ...extra });
function nativeReader(entry: ModelCatalogEntry = apiEntry, overrides: Partial<ViewOptions> = {}) {
  const view = prepare({
    snapshot: { entries: [entry], routeVariants: [entry, nativeEntry] },
    pluginRegistry: nativeRegistry(subscriptionReadiness),
    ...overrides,
  });
  return (evaluation = host, runtime?: string) => view.evaluateNative(entry, evaluation, runtime);
}
function nativeRegistry(readiness: () => { accountType: string; authMode: string } | undefined) {
  return harnessRegistry("native-test", {
    authBootstrap: "harness",
    readModelCatalogReadiness: readiness,
  });
}

describe("prepared native catalog readiness", () => {
  it("does not let an uncredentialed API catalog twin hide a discovered native offering", () => {
    const read = nativeReader(row("custom", "native-model", { api: "openai-responses" }));
    expect(read()).toMatchObject(nativeResult(true));
  });

  it.each(["direct", "profile"] as const)(
    "preserves runtime-materialized host %s credentials",
    (source) => {
      const api = { ...nativeEntry, nativeRuntime: undefined, api: "openai-responses" as const };
      const read = nativeReader(api);
      const credentialed: ModelAuthAvailabilityEvaluation = {
        ...host,
        availability: true,
        evidence: "runtime",
        selectedAuthMode: "api_key",
        selectedCredential:
          source === "direct"
            ? { source, provider: "custom", identityKey: "direct:custom" }
            : { source, profileId: "custom:test", identityKey: "profile:custom:test" },
      };
      expect(read(credentialed)).toBe(credentialed);
    },
  );

  it.each([false, true])(
    "does not infer between native owners, regardless of row order (%s)",
    (reverse) => {
      const variants = [apiEntry, nativeEntry, { ...nativeEntry, nativeRuntime: "another-native" }];
      if (reverse) {
        variants.reverse();
      }
      const read = nativeReader(apiEntry, {
        snapshot: { entries: [apiEntry], routeVariants: variants },
      });
      expect(read()).toBe(host);
    },
  );

  it("keeps native readiness unknown before the first discovery", () => {
    const logical = row("custom", "native-model");
    const read = nativeReader(logical, {
      snapshot: snapshot([logical]),
      pluginRegistry: nativeRegistry(() => undefined),
    });
    expect(read(host, "native-test")).toMatchObject(nativeResult(undefined));
  });

  it("evaluates configured rows using another runtime", () => {
    const logical = row("custom", "native-model");
    const cfg = runtimeConfig({ "custom/native-model": "native-test" });
    const registry = nativeRegistry(() => undefined);
    delete registry.agentHarnesses[0]!.harness.readModelCatalogReadiness;
    registry.agentHarnesses[0]!.harness.loadModelCatalog = () => {
      throw new Error("Projection must not discover native models");
    };
    const read = nativeReader(logical, {
      cfg,
      snapshot: {
        entries: [logical],
        routeVariants: [{ ...nativeEntry, nativeRuntime: "other-native" }],
      },
      pluginRegistry: registry,
    });
    const decision = read({ ...host, unavailableReason: "missing-auth" });
    expect(decision).toMatchObject(nativeResult(undefined, { availabilityAuthoritative: true }));
    expect(decision.unavailableReason).toBeUndefined();
  });

  it("observes live native readiness and selection until retirement", () => {
    let ready = true;
    let current = true;
    const cfg = providerConfig("custom", {
      baseUrl: "",
      models: [model("native-model"), model("other-model")],
    });
    const read = nativeReader(nativeEntry, {
      cfg,
      snapshot: snapshot([nativeEntry]),
      observationConfig: cfg,
      pluginRegistry: nativeRegistry(() =>
        ready ? { accountType: "apiKey", authMode: "oauth" } : undefined,
      ),
      isCurrent: () => current,
    });
    const observed = nativeResult(true, { selectedAuthMode: "oauth" });
    expect(read(host, "native-test")).toMatchObject(observed);
    expect(read(host, "openclaw")).toEqual(host);
    expect(read({ ...host, requestedRuntimeId: "native-test" })).toMatchObject({
      ...observed,
      requestedRuntimeId: "native-test",
    });
    ready = false;
    expect(read(host, "native-test")).toMatchObject({ availability: false });
    ready = true;
    current = false;
    expect(read(host, "native-test")).toMatchObject({ availability: false });
  });

  it.each([
    { name: "required worker", cfg: { cloudWorkers: { requiredProfile: "worker" } } },
    {
      name: "authored route",
      cfg: providerConfig("custom", { baseUrl: "https://host.example/v1", models: [] }),
    },
    { name: "request parameters", cfg: { agents: { defaults: { params: { temperature: 0.2 } } } } },
  ])("keeps $name under host authentication", ({ cfg, name }) => {
    const read = nativeReader(apiEntry, { cfg });
    expect(read(host, name === "required worker" ? undefined : "native-test")).toEqual(host);
  });
});

const base: ModelCatalogEntry = {
  provider: "fixture",
  id: "model",
  name: "Model",
  contextWindows: [{ id: "32k", label: "32K", contextWindow: 32_000 }],
};
it.each([
  ["unrelated", [row("fixture", "other")], "openclaw", true, base.contextWindows],
  [
    "native-without-window",
    [{ ...row("fixture", "model"), nativeRuntime: "native-fixture" }],
    "native-fixture",
    true,
    undefined,
  ],
  ["native-without-api-fallback", [base], "native-fixture", false, undefined],
  [
    "native-before-api",
    [base, { ...base, nativeRuntime: "native-fixture", contextWindows: undefined }],
    "native-fixture",
    true,
    undefined,
  ],
] as const)(
  "preserves logical fallback without borrowing native windows (%s)",
  (_, routeVariants, runtimeId, allowApiFallback, expected) => {
    const selected = selectModelCatalogRuntimeEntry({
      entry: base,
      routeVariants,
      runtimeId,
      allowApiFallback,
    });
    expect(selected.entry.contextWindows).toEqual(expected);
    const view = createModelCatalogView({ cfg: {}, catalog: [base], routeVariants });
    expect(view.selectRuntimeEntry({ entry: base, runtimeId, allowApiFallback })).toEqual(selected);
  },
);
