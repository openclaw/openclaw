// Capability reads retain published facts and use static ownership when no owner exists.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const manifestCatalogMock = vi.fn((): ModelCatalogEntry[] => []);
const scopedStaticMock = vi.fn(async (): Promise<ModelCatalogSnapshot> => ({
  entries: [],
  routeVariants: [],
}));
const scopedLiveMock = vi.fn(async (): Promise<ModelCatalogSnapshot> => ({
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

vi.mock("./model-catalog.js", () => ({ loadManifestModelCatalog: () => manifestCatalogMock() }));
vi.mock("./prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prepared-model-runtime.js")>()),
  getPreparedModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) =>
    publishedSnapshotMock(input),
  prepareModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) => preparedSnapshotMock(input),
  acquireReadOnlyPreparedModelRuntime: async (input: PreparedModelRuntimeInput) => ({
    snapshot: await acquireSnapshotMock(input),
    release: releaseSnapshotMock,
  }),
}));
vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: () => scopedStaticMock(),
  prepareScopedReadOnlyLiveModelCatalog: () => scopedLiveMock(),
}));

function owner(config: OpenClawConfig, entries: ModelCatalogEntry[]): PreparedModelRuntimeSnapshot {
  return {
    agentDir: "/tmp/model-catalog-passive-test",
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
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("Passive capability reads must not create stores");
    },
  };
}

const entry: ModelCatalogEntry = {
  provider: "acme",
  id: "selected",
  name: "Selected",
  api: "openai-responses",
  baseUrl: "https://provider.invalid/v1",
};

describe("loadProviderScopedThinkingCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manifestCatalogMock.mockReturnValue([]);
    scopedStaticMock.mockResolvedValue({ entries: [], routeVariants: [] });
    scopedLiveMock.mockResolvedValue({ entries: [], routeVariants: [] });
    publishedSnapshotMock.mockReturnValue(undefined);
    preparedSnapshotMock.mockImplementation(async (input) => {
      const published = publishedSnapshotMock(input);
      if (!published) {
        throw new PreparedModelRuntimeOwnerNotPublishedError("No published test owner");
      }
      return published;
    });
    acquireSnapshotMock.mockImplementation(async (input) => owner(input.config, []));
  });

  it.each(["thinking", "input"] as const)(
    "keeps missing published %s facts passive",
    async (capability) => {
      const config = {};
      const missingEntry: ModelCatalogEntry = {
        provider: "acme",
        id: "selected",
        name: "Selected",
        api: "openai-responses",
        baseUrl: "https://provider.invalid/v1",
      };
      const snapshot: PreparedModelRuntimeSnapshot = {
        agentDir: "/tmp/model-catalog-passive-test",
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
        modelCatalog: { entries: [missingEntry], routeVariants: [missingEntry] },
        configuredRuntimeModels: [],
        inlineProviderModels: [],
        createStores: () => {
          throw new Error("Passive capability reads must not create stores");
        },
      };
      publishedSnapshotMock.mockReturnValue(snapshot);
      preparedSnapshotMock.mockResolvedValue(snapshot);
      scopedStaticMock.mockResolvedValue({
        entries: [{ ...missingEntry, reasoning: true, input: ["text", "image"] }],
        routeVariants: [],
      });
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const catalog = await loadProviderScopedThinkingCatalog({
        config,
        provider: missingEntry.provider,
        model: missingEntry.id,
        ...(capability === "input"
          ? { requiredInputRoute: { api: missingEntry.api, baseUrl: missingEntry.baseUrl } }
          : {}),
      });

      if (capability === "input") {
        expect(catalog).toEqual([]);
      } else {
        expect(catalog).toEqual([missingEntry]);
      }
      expect(manifestCatalogMock).not.toHaveBeenCalled();
      expect(scopedStaticMock).not.toHaveBeenCalled();
      expect(scopedLiveMock).not.toHaveBeenCalled();
    },
  );

  it.each(["thinking", "input"] as const)(
    "reuses paired completed catalogs for %s capabilities",
    async (capability) => {
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
        authStore: { version: 1, profiles: {} },
        authModes: {},
      });
      const loadFullModelCatalog = vi.fn(async () => completed);
      const snapshot = {
        ...owner(config, []),
        readFullModelCatalog: () => completed,
        loadFullModelCatalog,
      };
      publishedSnapshotMock.mockReturnValue(snapshot);
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
      const catalog = await loadProviderScopedThinkingCatalog({
        config,
        provider: entry.provider,
        model: entry.id,
        ...(capability === "input"
          ? { requiredInputRoute: { api: entry.api, baseUrl: entry.baseUrl } }
          : {}),
      });
      expect(catalog).toEqual([completedEntry]);
      expect(loadFullModelCatalog).not.toHaveBeenCalled();
      expect(manifestCatalogMock).not.toHaveBeenCalled();
      expect(scopedStaticMock).not.toHaveBeenCalled();
      expect(scopedLiveMock).not.toHaveBeenCalled();
      expect(acquireSnapshotMock).not.toHaveBeenCalled();
    },
  );

  it("uses and releases a static owner when no published owner exists", async () => {
    const config = {};
    const staticEntry = { ...entry, reasoning: true };
    acquireSnapshotMock.mockResolvedValue(owner(config, [staticEntry]));
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    expect(
      await loadProviderScopedThinkingCatalog({
        config,
        provider: entry.provider,
        model: entry.id,
      }),
    ).toEqual([staticEntry]);
    expect(releaseSnapshotMock).toHaveBeenCalledOnce();
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("rejects an owner whose configuration was replaced", async () => {
    const config = { skills: { entries: { marker: { enabled: true } } } };
    const replaced = { skills: { entries: { marker: { enabled: false } } } };
    publishedSnapshotMock.mockReturnValue(owner(replaced, [{ ...entry, reasoning: true }]));
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    await expect(
      loadProviderScopedThinkingCatalog({ config, provider: entry.provider, model: entry.id }),
    ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "vision",
      input: ["text", "image"],
      expected: ["text", "image"],
      baseUrl: entry.baseUrl,
    },
    { name: "text only", input: ["text"], expected: ["text"], baseUrl: entry.baseUrl },
    { name: "missing input", input: undefined, expected: undefined, baseUrl: entry.baseUrl },
    {
      name: "different route",
      input: ["text", "image"],
      expected: undefined,
      baseUrl: "https://custom.invalid/v1",
    },
  ] satisfies Array<{
    name: string;
    input: ModelCatalogEntry["input"];
    expected: ModelCatalogEntry["input"];
    baseUrl: string | undefined;
  }>)("keeps input independent of reasoning: $name", async (testCase) => {
    const config = {};
    publishedSnapshotMock.mockReturnValue(
      owner(config, [{ ...entry, reasoning: true, input: testCase.input }]),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");
    const catalog = await loadProviderScopedThinkingCatalog({
      config,
      provider: entry.provider,
      model: entry.id,
      requiredInputRoute: { api: entry.api, baseUrl: testCase.baseUrl },
    });
    if (testCase.expected) {
      expect(catalog[0]?.input).toEqual(testCase.expected);
    } else {
      expect(catalog).toEqual([]);
    }
    expect(manifestCatalogMock).not.toHaveBeenCalled();
    expect(scopedStaticMock).not.toHaveBeenCalled();
    expect(scopedLiveMock).not.toHaveBeenCalled();
  });

  it("returns the completed catalog to nonblocking readers without a refresh", async () => {
    const config = {};
    const completed: ModelCatalogSnapshot = {
      entries: [{ ...entry, reasoning: true }],
      routeVariants: [],
    };
    const loadFullModelCatalog = vi.fn(async () => completed);
    publishedSnapshotMock.mockReturnValue({
      ...owner(config, [entry]),
      readFullModelCatalog: () => completed,
      loadFullModelCatalog,
    });
    const { getPreparedModelCatalogSnapshot } = await import("./prepared-model-catalog.js");
    expect(getPreparedModelCatalogSnapshot({ config })).toBe(completed);
    expect(loadFullModelCatalog).not.toHaveBeenCalled();
    expect(acquireSnapshotMock).not.toHaveBeenCalled();
  });
});
