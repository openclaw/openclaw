// Capability reads retain published facts without acquiring missing inventory.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { withPreparedModelRuntimePluginGenerationScope } from "./prepared-model-runtime-generation-scope.js";
import { capturePreparedModelRuntimeCatalog } from "./prepared-model-runtime.capture.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const manifestCatalogMock = vi.fn((): ModelCatalogEntry[] => []);
const scopedCatalogMock = vi.fn(async (): Promise<ModelCatalogSnapshot> => ({
  entries: [],
  routeVariants: [],
}));
const publishedSnapshotMock =
  vi.fn<(input: PreparedModelRuntimeInput) => PreparedModelRuntimeSnapshot | undefined>();
const preparedSnapshotMock =
  vi.fn<(input: PreparedModelRuntimeInput) => Promise<PreparedModelRuntimeSnapshot>>();
const acquireSnapshotMock =
  vi.fn<(input: PreparedModelRuntimeInput) => Promise<PreparedModelRuntimeSnapshot>>();
const releaseSnapshotMock = vi.fn();
const augmentCatalogMock =
  vi.fn<(params: { snapshot: ModelCatalogSnapshot }) => Promise<ModelCatalogSnapshot>>();

vi.mock("./harness/model-catalog.js", () => ({
  augmentModelCatalogWithAgentHarness: (params: { snapshot: ModelCatalogSnapshot }) =>
    augmentCatalogMock(params),
}));

vi.mock("./model-catalog.js", () => ({ loadManifestModelCatalog: () => manifestCatalogMock() }));
vi.mock("./prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-runtime.js")>()),
  getPreparedModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) =>
    publishedSnapshotMock(input),
  prepareModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) => preparedSnapshotMock(input),
  acquireReadOnlyPreparedModelRuntime: async (input: PreparedModelRuntimeInput) => ({
    snapshot: await acquireSnapshotMock(input),
    [Symbol.asyncDispose]: releaseSnapshotMock,
  }),
}));
vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: () => scopedCatalogMock(),
}));

function owner(config: OpenClawConfig, entries: ModelCatalogEntry[]): PreparedModelRuntimeSnapshot {
  return {
    agentDir: "/tmp/model-catalog-passive-test",
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
    activeProjectKeys: [],
    catalogOwner: undefined,
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    }),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries, routeVariants: entries },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("Passive capability reads must not create stores");
    },
  };
}

function withAdmitted<T>(snapshot: PreparedModelRuntimeSnapshot, run: () => T, active = true): T {
  return withPreparedModelRuntimePluginGenerationScope(
    {
      remoteCatalog: null,
      pluginMetadataSnapshot: snapshot.metadataSnapshot,
      inlineProviderModels: [],
      configuredCatalogEntries: snapshot.modelCatalog.entries,
    },
    run,
    () => (active ? snapshot : undefined),
  );
}

const entry = {
  provider: "acme",
  id: "selected",
  name: "Selected",
  api: "openai-responses",
  baseUrl: "https://provider.invalid/v1",
} satisfies ModelCatalogEntry;

describe("loadProviderScopedThinkingCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manifestCatalogMock.mockReturnValue([]);
    scopedCatalogMock.mockResolvedValue({ entries: [], routeVariants: [] });
    publishedSnapshotMock.mockReturnValue(undefined);
    preparedSnapshotMock.mockImplementation(async (input) => {
      const published = publishedSnapshotMock(input);
      if (!published) {
        throw new PreparedModelRuntimeOwnerNotPublishedError("No published test owner");
      }
      return published;
    });
    acquireSnapshotMock.mockImplementation(async (input) => owner(input.config, []));
    augmentCatalogMock.mockImplementation(async ({ snapshot }) => snapshot);
  });

  it("reuses paired completed catalogs for thinking capabilities", async () => {
    const config = {};
    const completedEntry: ModelCatalogEntry = {
      ...entry,
      reasoning: true,
      input: ["text", "image"],
    };
    const completed: ModelCatalogSnapshot = {
      entries: [completedEntry],
      routeVariants: [completedEntry],
    };
    setPreparedModelFullCatalogAuth(completed, {
      providerAuthLabels: new Map(),
      authStore: { version: 1, profiles: {} },
      authModes: {},
    });
    const loadFullModelCatalog = vi.fn(async () => completed);
    const snapshot = {
      ...owner(config, [entry]),
      readFullModelCatalog: () => completed,
      loadFullModelCatalog,
    };
    publishedSnapshotMock.mockReturnValue(snapshot);
    const { getPreparedModelCatalogSnapshot, loadProviderScopedThinkingCatalog } =
      await import("./prepared-model-catalog.js");
    expect(getPreparedModelCatalogSnapshot({ config })).toBe(completed);
    const catalog = await loadProviderScopedThinkingCatalog({
      config,
      provider: entry.provider,
      model: entry.id,
    });
    expect(catalog).toEqual([completedEntry]);
    expect(loadFullModelCatalog).not.toHaveBeenCalled();
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedCatalogMock).not.toHaveBeenCalled();
    expect(acquireSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps ownerless native observations passive", async () => {
    const config = {};
    const staticEntry = { ...entry, reasoning: true };
    acquireSnapshotMock.mockResolvedValue(owner(config, [staticEntry]));
    const entries = [{ ...staticEntry, nativeRuntime: "test-harness" }];
    augmentCatalogMock.mockResolvedValue({ entries, routeVariants: entries });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    expect(
      await loadProviderScopedThinkingCatalog({
        config,
        provider: entry.provider,
        model: entry.id,
      }),
    ).toEqual(entries);
    expect(acquireSnapshotMock).not.toHaveBeenCalled();
    expect(releaseSnapshotMock).not.toHaveBeenCalled();
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedCatalogMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "same-route account switch", replacementKey: "fixture-account-b", native: false },
    { name: "route-free native observation", replacementKey: "fixture-account-b", native: true },
  ])("retains admitted capabilities across $name", async ({ replacementKey, native }) => {
    const config: OpenClawConfig = {
      models: {
        providers: { acme: { baseUrl: entry.baseUrl, apiKey: "fixture-account-a", models: [] } },
      },
    };
    const replaced: OpenClawConfig = {
      ...config,
      models: {
        providers: { acme: { baseUrl: entry.baseUrl, apiKey: replacementKey, models: [] } },
      },
      skills: { entries: { marker: { enabled: false } } },
    };
    const admittedEntry: ModelCatalogEntry = native
      ? {
          provider: entry.provider,
          id: entry.id,
          name: entry.name,
          nativeRuntime: "native-one",
          reasoning: true,
        }
      : { ...entry, reasoning: true, input: ["text", "image"] };
    const completed = { entries: [admittedEntry], routeVariants: [admittedEntry] };
    const readFullModelCatalog = vi.fn(() => completed);
    const source = { ...owner(config, [entry]), readFullModelCatalog };
    const admitted = capturePreparedModelRuntimeCatalog(source, source);
    readFullModelCatalog.mockImplementation(() => {
      throw new Error("retired owner");
    });
    publishedSnapshotMock.mockReturnValue(
      owner(replaced, [{ ...entry, reasoning: false, input: ["text"] }]),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const result = await withAdmitted(admitted, () =>
      loadProviderScopedThinkingCatalog({
        config,
        agentDir: admitted.agentDir,
        provider: entry.provider,
        model: entry.id,
        ...(native
          ? { agentRuntime: "native-one" }
          : { requiredInputRoute: { api: entry.api, baseUrl: entry.baseUrl } }),
      }),
    );
    expect(result).toEqual([admittedEntry]);
    expect(preparedSnapshotMock).not.toHaveBeenCalled();
    expect(augmentCatalogMock).not.toHaveBeenCalled();
    expect(readFullModelCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "same-id physical route",
      nativeId: entry.id,
      runtime: "openclaw",
      publishedSelected: false,
    },
    { label: "native route", nativeId: entry.id, runtime: "native-one", publishedSelected: false },
    {
      label: "published physical facts",
      nativeId: "native-only",
      runtime: "openclaw",
      publishedSelected: true,
    },
  ])(
    "retains native and physical capture facts: $label",
    async ({ nativeId, runtime, publishedSelected }) => {
      const config = {};
      const configured: ModelCatalogEntry = publishedSelected
        ? entry
        : { ...entry, reasoning: false, input: ["text", "image"] };
      const discovered: ModelCatalogEntry = {
        ...entry,
        id: publishedSelected ? entry.id : "discovered",
        name: "Discovered",
        reasoning: true,
        input: ["text", "image"],
      };
      const native: ModelCatalogEntry = {
        provider: entry.provider,
        id: nativeId,
        name: entry.name,
        nativeRuntime: "native-one",
        reasoning: true,
        input: ["text"],
      };
      let current = true;
      const readFullModelCatalog = vi.fn(() => ({
        entries: [native, discovered],
        routeVariants: [native, discovered],
      }));
      const loadNativeModelCatalog = vi.fn(async () => {
        throw new Error("A retired owner cannot supply new native observations");
      });
      const source = {
        ...owner(config, [configured]),
        isCurrent: () => current,
        readFullModelCatalog,
        loadNativeModelCatalog,
      };
      const admitted = capturePreparedModelRuntimeCatalog(source, source);
      current = false;
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const result = await withAdmitted(admitted, () =>
        loadProviderScopedThinkingCatalog({
          config,
          agentDir: admitted.agentDir,
          provider: entry.provider,
          model: entry.id,
          agentRuntime: runtime,
          ...(runtime === "openclaw"
            ? { requiredInputRoute: { api: entry.api, baseUrl: entry.baseUrl } }
            : {}),
        }),
      );
      const physical = publishedSelected ? discovered : configured;
      expect(result).toContainEqual(runtime === "openclaw" ? physical : native);
      expect(result).toContainEqual(discovered);
      expect(readFullModelCatalog).toHaveBeenCalledOnce();
      expect(loadNativeModelCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(["ready", "retired", "failure"] as const)(
    "preserves admitted native observations: %s",
    async (outcome) => {
      const config = {};
      const native: ModelCatalogEntry = {
        provider: entry.provider,
        id: entry.id,
        name: entry.name,
        nativeRuntime: "native-one",
        reasoning: true,
      };
      let current = true;
      const failure = new Error("native observation unavailable");
      const loadNativeModelCatalog = vi.fn(async () => {
        if (outcome === "retired") {
          current = false;
          throw new PreparedModelRuntimePublicationSupersededError("retired during observation");
        }
        if (outcome === "failure") {
          throw failure;
        }
        return { entries: [native], routeVariants: [native] };
      });
      const admitted = {
        ...owner(config, outcome === "retired" ? [native] : [{ ...entry, reasoning: false }]),
        isCurrent: () => current,
        loadNativeModelCatalog,
      };
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const result = withAdmitted(admitted, () =>
        loadProviderScopedThinkingCatalog({
          config,
          agentDir: admitted.agentDir,
          provider: entry.provider,
          model: entry.id,
          agentRuntime: "native-one",
        }),
      );
      if (outcome === "failure") {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toEqual([native]);
      }
      expect(loadNativeModelCatalog).toHaveBeenCalledOnce();
      expect(preparedSnapshotMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "a capability change",
      configured: [entry],
      firstEntries: [{ ...entry, reasoning: true }],
      secondEntries: [{ ...entry, reasoning: false }],
    },
    {
      name: "populated to empty inventory",
      configured: [],
      firstEntries: [entry],
      secondEntries: [],
    },
    {
      name: "configured facts followed by empty inventory",
      configured: [entry],
      firstEntries: undefined,
      secondEntries: [],
    },
  ])("keeps earlier captures across $name", async ({ configured, firstEntries, secondEntries }) => {
    const config = {};
    const readFullModelCatalog = vi
      .fn<() => ModelCatalogSnapshot | undefined>()
      .mockReturnValue(
        firstEntries ? { entries: firstEntries, routeVariants: firstEntries } : undefined,
      );
    const source = { ...owner(config, configured), readFullModelCatalog };
    const first = capturePreparedModelRuntimeCatalog(source, source);
    readFullModelCatalog.mockReturnValue({ entries: secondEntries, routeVariants: secondEntries });
    const second = capturePreparedModelRuntimeCatalog(source, source);
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const read = () =>
      loadProviderScopedThinkingCatalog({
        config,
        agentDir: source.agentDir,
        provider: entry.provider,
        model: entry.id,
      });
    await expect(withAdmitted(first, read)).resolves.toEqual(firstEntries ?? configured);
    await expect(withAdmitted(second, read)).resolves.toEqual(secondEntries);
  });

  it.each(["missing admission", "closed lease", "other agent", "other workspace"])(
    "cannot borrow replacement facts with %s",
    async (mismatch) => {
      const config = { skills: { entries: { marker: { enabled: true } } } };
      const replaced = { skills: { entries: { marker: { enabled: false } } } };
      const admitted = owner(config, [{ ...entry, reasoning: true }]);
      publishedSnapshotMock.mockReturnValue(owner(replaced, [{ ...entry, reasoning: false }]));
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const read = () =>
        loadProviderScopedThinkingCatalog({
          config,
          agentDir: mismatch === "other agent" ? "/tmp/other-agent" : admitted.agentDir,
          ...(mismatch === "other workspace" ? { workspaceDir: "/tmp/other-workspace" } : {}),
          provider: entry.provider,
          model: entry.id,
        });
      const result = await (mismatch === "missing admission"
        ? read()
        : withAdmitted(admitted, read, mismatch !== "closed lease"));
      expect(result).toEqual([]);
      expect(scopedCatalogMock).not.toHaveBeenCalled();
    },
  );

  it("rejects published capabilities from a different route", async () => {
    const config = {};
    const model: ModelCatalogEntry = { ...entry, reasoning: true, input: ["text", "image"] };
    publishedSnapshotMock.mockReturnValue(owner(config, [model]));
    scopedCatalogMock.mockResolvedValue({
      entries: [{ ...entry, reasoning: true, input: ["text", "image"] }],
      routeVariants: [],
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config,
      provider: entry.provider,
      model: entry.id,
      requiredInputRoute: { ...entry, baseUrl: "https://custom.invalid/v1" },
    });
    expect(catalog).toEqual([]);
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedCatalogMock).not.toHaveBeenCalled();
  });
});
