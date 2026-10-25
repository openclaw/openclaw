import { beforeEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { noteCommittedSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
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
function expectUnused(...mocks: Array<ReturnType<typeof vi.fn>>) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

// mock-isolation: Keep harness discovery behind the controlled catalog fixture.
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

function catalog(entries: ModelCatalogEntry[]): ModelCatalogSnapshot {
  return { entries, routeVariants: entries };
}

function owner(config: OpenClawConfig, entries: ModelCatalogEntry[]): PreparedModelRuntimeSnapshot {
  return {
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
    ...createEmptyPreparedModelRuntimeFixture({
      agentDir: "/tmp/model-catalog-passive-test",
      config,
      metadataSnapshot: createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
      createStores: () => {
        throw new Error("Passive capability reads must not create stores");
      },
    }),
    modelCatalog: catalog(entries),
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
const inputRoute = { api: entry.api, baseUrl: entry.baseUrl };

async function readThinking(
  config: OpenClawConfig,
  options: Omit<
    Parameters<typeof import("./prepared-model-catalog.js").loadProviderScopedThinkingCatalog>[0],
    "config" | "provider" | "model"
  > = {},
) {
  const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
  return loadProviderScopedThinkingCatalog({
    config,
    provider: entry.provider,
    model: entry.id,
    ...options,
  });
}

function readAdmitted(
  snapshot: PreparedModelRuntimeSnapshot,
  options: Parameters<typeof readThinking>[1] = {},
) {
  return withAdmitted(snapshot, () =>
    readThinking(snapshot.config, { agentDir: snapshot.agentDir, ...options }),
  );
}

function physicalEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return { ...entry, reasoning: true, input: ["text", "image"], ...overrides };
}

function nativeEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    provider: entry.provider,
    id: entry.id,
    name: entry.name,
    nativeRuntime: "native-one",
    reasoning: true,
    ...overrides,
  };
}

function accountConfig(apiKey: string): OpenClawConfig {
  return { models: { providers: { acme: { baseUrl: entry.baseUrl, apiKey, models: [] } } } };
}

beforeEach(() => {
  noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
  vi.clearAllMocks();
  publishedSnapshotMock.mockReturnValue(undefined);
  preparedSnapshotMock.mockImplementation(async (input) => {
    const published = publishedSnapshotMock(input);
    if (!published) {
      throw new PreparedModelRuntimeOwnerNotPublishedError("No published test owner");
    }
    return published;
  });
  augmentCatalogMock.mockImplementation(async ({ snapshot }) => snapshot);
});

it("reuses paired completed catalogs for thinking capabilities", async () => {
  const config = {};
  const completedEntry = physicalEntry();
  const completed = catalog([completedEntry]);
  setPreparedModelFullCatalogAuth(completed, {
    providerAuthLabels: new Map(),
    authStore: { version: 1, profiles: {} },
    authModes: {},
  });
  const loadFullModelCatalog = vi.fn(async () => completed);
  publishedSnapshotMock.mockReturnValue({
    ...owner(config, [entry]),
    readFullModelCatalog: () => completed,
    loadFullModelCatalog,
  });
  expect(await readThinking(config)).toEqual([completedEntry]);
  expectUnused(loadFullModelCatalog, manifestCatalogMock, scopedCatalogMock, acquireSnapshotMock);
});

it("keeps ownerless native observations passive", async () => {
  const config = {};
  const entries = [{ ...entry, reasoning: true, nativeRuntime: "test-harness" }];
  augmentCatalogMock.mockResolvedValue(catalog(entries));
  expect(await readThinking(config)).toEqual(entries);
  expectUnused(acquireSnapshotMock, releaseSnapshotMock, manifestCatalogMock, scopedCatalogMock);
});

it.each([
  { name: "same-route account switch", replacementKey: "fixture-account-b", native: false },
  { name: "route-free native observation", replacementKey: "fixture-account-b", native: true },
])("retains admitted capabilities across $name", async ({ replacementKey, native }) => {
  const config = accountConfig("fixture-account-a");
  const replaced: OpenClawConfig = {
    ...accountConfig(replacementKey),
    skills: { entries: { marker: { enabled: false } } },
  };
  const admittedEntry: ModelCatalogEntry = native ? nativeEntry() : physicalEntry();
  const completed = catalog([admittedEntry]);
  const readFullModelCatalog = vi.fn(() => completed);
  const source = { ...owner(config, [entry]), readFullModelCatalog };
  const admitted = capturePreparedModelRuntimeCatalog(source, source);
  readFullModelCatalog.mockImplementation(() => {
    throw new Error("retired owner");
  });
  publishedSnapshotMock.mockReturnValue(
    owner(replaced, [{ ...entry, reasoning: false, input: ["text"] }]),
  );
  const result = await readAdmitted(
    admitted,
    native ? { agentRuntime: "native-one" } : { requiredInputRoute: inputRoute },
  );
  expect(result).toEqual([admittedEntry]);
  expectUnused(preparedSnapshotMock, augmentCatalogMock);
  expect(readFullModelCatalog).toHaveBeenCalledOnce();
});

it.each([
  ["same-id physical route", entry.id, "openclaw", false],
  ["native route", entry.id, "native-one", false],
  ["published physical facts", "native-only", "openclaw", true],
] as const)(
  "retains native and physical capture facts: %s",
  async (_label, nativeId, runtime, publishedSelected) => {
    const config = {};
    const configured: ModelCatalogEntry = publishedSelected
      ? entry
      : physicalEntry({ reasoning: false });
    const discovered = physicalEntry({
      id: publishedSelected ? entry.id : "discovered",
      name: "Discovered",
    });
    const native: ModelCatalogEntry = nativeEntry({ id: nativeId, input: ["text"] });
    let current = true;
    const readFullModelCatalog = vi.fn(() => catalog([native, discovered]));
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
    const result = await readAdmitted(admitted, {
      agentRuntime: runtime,
      ...(runtime === "openclaw" ? { requiredInputRoute: inputRoute } : {}),
    });
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
    const native: ModelCatalogEntry = nativeEntry();
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
      return catalog([native]);
    });
    const admitted = {
      ...owner(config, outcome === "retired" ? [native] : [{ ...entry, reasoning: false }]),
      isCurrent: () => current,
      loadNativeModelCatalog,
    };
    const result = readAdmitted(admitted, { agentRuntime: "native-one" });
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
  { configured: [], before: [entry] },
  { configured: [entry], before: undefined },
])(
  "keeps captured facts after an empty inventory is published ($before)",
  async ({ configured, before }) => {
    const config = {};
    const readFullModelCatalog = vi
      .fn<() => ModelCatalogSnapshot | undefined>()
      .mockReturnValue(before ? catalog(before) : undefined);
    const source = { ...owner(config, configured), readFullModelCatalog };
    const first = capturePreparedModelRuntimeCatalog(source, source);
    readFullModelCatalog.mockReturnValue(catalog([]));
    const second = capturePreparedModelRuntimeCatalog(source, source);
    await expect(readAdmitted(first)).resolves.toEqual(before ?? configured);
    await expect(readAdmitted(second)).resolves.toEqual([]);
  },
);

it.each(["missing admission", "closed lease", "other agent", "other workspace"])(
  "cannot borrow replacement facts with %s",
  async (mismatch) => {
    const config = { skills: { entries: { marker: { enabled: true } } } };
    const replaced = { skills: { entries: { marker: { enabled: false } } } };
    const admitted = owner(config, [{ ...entry, reasoning: true }]);
    publishedSnapshotMock.mockReturnValue(owner(replaced, [{ ...entry, reasoning: false }]));
    const read = () =>
      readThinking(config, {
        agentDir: mismatch === "other agent" ? "/tmp/other-agent" : admitted.agentDir,
        ...(mismatch === "other workspace" ? { workspaceDir: "/tmp/other-workspace" } : {}),
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
  publishedSnapshotMock.mockReturnValue(owner(config, [physicalEntry()]));
  expect(
    await readThinking(config, {
      requiredInputRoute: { ...entry, baseUrl: "https://custom.invalid/v1" },
    }),
  ).toEqual([]);
  expectUnused(manifestCatalogMock, scopedCatalogMock);
});
