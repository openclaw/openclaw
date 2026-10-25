import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { harnessRegistry } from "../model-catalog-fixtures.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { mergePreparedNativeCatalog } from "../prepared-model-runtime.catalog-publication.js";
import {
  augmentModelCatalogWithAgentHarness,
  augmentPreparedModelCatalogWithAgentHarness,
  isPreparedNativeModelCatalogReady,
} from "./model-catalog.js";

function row(id: string, fields: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return { provider: "fixture", id, name: id, ...fields };
}
const catalog = (entries: ModelCatalogEntry[]): ModelCatalogSnapshot => ({
  entries,
  routeVariants: entries,
});

const cfg = {
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-sol" } },
    entries: {
      main: {
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    },
  },
} as OpenClawConfig;

const openaiRow = (id: string, fields: Partial<ModelCatalogEntry> = {}) =>
  row(id, { provider: "openai", ...fields });
const apiModel = openaiRow("gpt-5.6-sol", {
  name: "GPT-5.6 Sol (API)",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
});
const nativeRoute = {
  provider: "openai",
  api: "openai-chatgpt-responses" as const,
  baseUrl: "https://chatgpt.com/backend-api/codex",
};
const nativeRow = (id: string, fields: Partial<ModelCatalogEntry> = {}) =>
  openaiRow(id, { ...nativeRoute, reasoning: true, ...fields });
const standardEfforts = ["low", "medium", "high", "xhigh", "max"];
const reasoningCompat = (efforts = standardEfforts) => ({
  supportsReasoningEffort: true,
  supportedReasoningEfforts: [...efforts],
});
const snapshot: ModelCatalogSnapshot = {
  entries: [{ ...apiModel, compat: reasoningCompat() }],
  routeVariants: [apiModel],
  staticEntries: [
    nativeRow("gpt-5.6-sol", {
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      params: { providerFact: "kept", codexAppServerRuntimeModel: "stale-runtime" },
      compat: {
        ...reasoningCompat(),
        supportsTools: false,
      },
    }),
    nativeRow("gpt-5.6-terra", {
      name: "GPT-5.6 Terra",
      compat: reasoningCompat([...standardEfforts, "ultra"]),
    }),
    openaiRow("provider-empty-reasoner", { compat: { supportedReasoningEfforts: [] } }),
  ],
};

function catalogRegistry(loaders: Record<string, () => Promise<readonly ModelCatalogEntry[]>>) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses = Object.entries(loaders).flatMap(
    ([id, loadModelCatalog]) => harnessRegistry(id, { loadModelCatalog }).agentHarnesses,
  );
  return registry;
}
const registryWithCatalog = (load: () => Promise<readonly ModelCatalogEntry[]>) =>
  catalogRegistry({ codex: load });
const pickerInput = (config: OpenClawConfig) => ({
  config,
  agentId: "main",
  agentDir: "/tmp/picker-agent",
  workspaceDir: "/tmp/picker-workspace",
});
const modelInput = {
  cfg,
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
  defaultModel: "openai/gpt-5.6-sol",
};
function pickerConfig(
  runtime: string,
  name = "model",
  extraModels = {},
  runtimes = ["native-two"],
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: `fixture/${name}`,
        models: {
          [`fixture/${name}`]: { agentRuntime: { id: runtime }, pickerRuntimes: runtimes },
          ...extraModels,
        },
      },
    },
  };
}
function sharedRuntimes(snapshotToInspect: ModelCatalogSnapshot) {
  return snapshotToInspect.routeVariants
    .filter((entry) => entry.provider === "fixture" && entry.id === "shared")
    .map((entry) => entry.nativeRuntime)
    .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
}

describe("agent harness model catalog", () => {
  it.each([
    { baseRuntime: "openclaw", agentRuntime: undefined, observedRuntime: undefined },
    { baseRuntime: "native-one", agentRuntime: undefined, observedRuntime: "native-one" },
    { baseRuntime: "openclaw", agentRuntime: "native-one", observedRuntime: "native-one" },
    { baseRuntime: "native-one", agentRuntime: "openclaw", observedRuntime: undefined },
  ])(
    "observes only the selected runtime with configured=$baseRuntime selected=$agentRuntime",
    async ({ baseRuntime, agentRuntime, observedRuntime }) => {
      const config = pickerConfig(baseRuntime);
      const host = row("model", { name: "Host model", reasoning: true });
      const initial = catalog([host]);
      const loadOne = vi.fn(async () => [{ ...host, nativeRuntime: "native-one" }]);
      const loadTwo = vi.fn(async () => [{ ...host, nativeRuntime: "native-two" }]);
      const registry = catalogRegistry({ "native-one": loadOne, "native-two": loadTwo });
      const result = await augmentModelCatalogWithAgentHarness({
        cfg: config,
        agentId: "main",
        agentDir: "/tmp/picker-agent",
        workspaceDir: "/tmp/picker-workspace",
        defaultProvider: "fixture",
        defaultModel: "fixture/model",
        agentRuntime,
        snapshot: initial,
        pluginRegistry: registry,
      });
      expect(loadOne).toHaveBeenCalledTimes(observedRuntime === "native-one" ? 1 : 0);
      expect(loadTwo).toHaveBeenCalledTimes(observedRuntime === "native-two" ? 1 : 0);
      expect(result.entries[0]?.nativeRuntime).toBe(observedRuntime);
    },
  );

  it.each([false, true])(
    "acquires picker runtimes once and preserves their refresh ownership (provider scoped: %s)",
    async (providerScoped) => {
      const config = pickerConfig(
        "openclaw",
        "shared",
        {
          "fixture/second": { pickerRuntimes: ["native-one", "native-two"] },
          "other/third": { pickerRuntimes: ["native-one"] },
        },
        ["native-one", "native-two"],
      );
      const host = row("shared", { name: "Host model", reasoning: false });
      const foreign = row("foreign", {
        provider: "other",
        name: "Foreign model",
        nativeRuntime: "native-two",
      });
      const initial = catalog([host, foreign]);
      const first = row("shared", { name: "Native one", nativeRuntime: "native-one" });
      const second = { ...first, name: "Native two", nativeRuntime: "native-two" };
      const stale: ModelCatalogEntry = { ...first, id: "retired" };
      const other: ModelCatalogEntry = { ...first, provider: "other", id: "third" };
      const loadOne = vi.fn(async () => [first, stale, other]);
      const loadTwo = vi.fn(async () => [second]);
      const registry = catalogRegistry({ "native-one": loadOne, "native-two": loadTwo });
      const onDiscoveryStarted = vi.fn();
      const onDiscoveryCompleted = vi.fn();
      const params = {
        input: pickerInput(config),
        pluginRegistry: registry,
        onDiscoveryStarted,
        onDiscoveryCompleted,
        ...(providerScoped
          ? { includesProvider: (provider: string) => provider === "fixture" }
          : {}),
      };
      const discovered = await augmentPreparedModelCatalogWithAgentHarness({
        ...params,
        snapshot: initial,
      });
      expect(loadOne).toHaveBeenCalledOnce();
      expect(loadTwo).toHaveBeenCalledOnce();
      expect(
        discovered.entries.find((entry) => entry.provider === "fixture" && entry.id === "shared"),
      ).toEqual(host);
      expect(sharedRuntimes(discovered)).toEqual(["native-one", "native-two", undefined]);
      const published = mergePreparedNativeCatalog(discovered, initial);
      expect(sharedRuntimes(published)).toEqual(["native-one", "native-two", undefined]);
      expect(onDiscoveryCompleted).toHaveBeenCalledExactlyOnceWith(
        providerScoped ? [first, stale, second] : [first, stale, other, second],
      );
      expect(
        onDiscoveryStarted.mock.calls
          .map(([provider]) => provider)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(providerScoped ? ["fixture", "fixture"] : ["fixture", "fixture", "other"]);
      loadOne.mockResolvedValue([]);
      loadTwo.mockResolvedValue([]);
      const refreshed = await augmentPreparedModelCatalogWithAgentHarness({
        ...params,
        snapshot: discovered,
      });
      expect(refreshed.entries.some((entry) => entry.id === "retired")).toBe(false);
      expect(refreshed.routeVariants.some((entry) => entry.id === "retired")).toBe(false);
      expect(refreshed.entries.some((entry) => entry.id === "foreign")).toBe(providerScoped);
      expect(refreshed.entries.find((entry) => entry.id === "shared")).toEqual(host);
    },
  );

  it("enriches host rows while preserving native-owned capabilities", async () => {
    const native = openaiRow("native-owned", {
      name: "Native model",
      nativeRuntime: "codex",
      reasoning: true,
    });
    const loadModelCatalog = vi.fn(async () => [
      native,
      openaiRow("gpt-5.6-terra", {
        name: "GPT-5.6 Terra",
        reasoning: false,
        compat: { supportedReasoningEfforts: [] },
      }),
      nativeRow("gpt-5.6-sol", {
        name: "GPT-5.6 Sol (account)",
        params: { codexAppServerRuntimeModel: "gpt-5.6-sol-runtime" },
        compat: {
          ...reasoningCompat(["high", "ultra"]),
          supportsTools: true,
        },
      }),
      ...["custom-reasoner", "provider-empty-reasoner"].map((id) =>
        openaiRow(id, { compat: { supportedReasoningEfforts: ["high"] } }),
      ),
    ]);

    const result = await augmentModelCatalogWithAgentHarness({
      ...modelInput,
      defaultProvider: "anthropic",
      snapshot: {
        ...snapshot,
        staticEntries: [...snapshot.staticEntries!, { ...apiModel, id: native.id }],
      },
      pluginRegistry: registryWithCatalog(loadModelCatalog),
    });

    const [owned, disabled, enriched, custom, empty] = result.entries;
    expect(owned).toEqual(native);
    expect(result.routeVariants).toContainEqual(native);
    expect(disabled).toMatchObject({
      id: "gpt-5.6-terra",
      ...nativeRoute,
      reasoning: false,
      compat: { supportedReasoningEfforts: [] },
    });
    expect(enriched).toMatchObject({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (account)",
      contextWindow: 1_050_000,
      params: {
        providerFact: "kept",
        codexAppServerRuntimeModel: "gpt-5.6-sol-runtime",
      },
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        supportsTools: true,
      },
    });
    expect(custom).toMatchObject({
      id: "custom-reasoner",
      compat: { supportedReasoningEfforts: ["high"] },
    });
    expect(empty).toMatchObject({
      id: "provider-empty-reasoner",
      compat: { supportedReasoningEfforts: ["high"] },
    });
  });
});

it("checks resident native readiness with linear catalog work and observes revocation", () => {
  let inspectedRows = 0;
  let ready = true;
  const rows: ModelCatalogEntry[] = Array.from({ length: 240 }, (_, index) => ({
    get provider() {
      inspectedRows++;
      return "fixture";
    },
    id: `model-${index}`,
    name: `Model ${index}`,
    ...(index >= 200 ? { nativeRuntime: "native-test" } : {}),
  }));
  const readModelCatalogReadiness = vi.fn(() =>
    ready ? { accountType: "apiKey" as const } : undefined,
  );
  const pluginRegistry = harnessRegistry("native-test", { readModelCatalogReadiness });
  const params = {
    input: {
      config: cfg,
      agentId: "main",
      agentDir: "/tmp/native-readiness-agent",
      workspaceDir: "/tmp/native-readiness-workspace",
    },
    pluginGeneration: {
      remoteCatalog: null,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      pluginRegistry,
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    },
    snapshot: catalog(rows),
    catalogAcquired: true,
  };
  expect(isPreparedNativeModelCatalogReady(params)).toBe(true);
  expect(readModelCatalogReadiness).toHaveBeenCalledTimes(40);
  // Bound row inspections, not elapsed time: a known member must not trigger a full rescan.
  expect(inspectedRows).toBeLessThan(rows.length * 2);
  ready = false;
  expect(isPreparedNativeModelCatalogReady(params)).toBe(false);
  expect(isPreparedNativeModelCatalogReady({ ...params, catalogAcquired: false })).toBe(false);
  expect(
    isPreparedNativeModelCatalogReady({
      ...params,
      snapshot: {
        ...params.snapshot,
        nativeProviderOutcomes: { "native-test": [{ provider: "fixture", status: "unavailable" }] },
      },
    }),
  ).toBe(true);
  ready = true;
  for (const [modelId, runtime, expected] of [
    ["model-239", "native-test", true],
    ["model-0", "native-test", false],
    ["missing", "native-test", false],
    ["model-239", "other-runtime", false],
  ] as const) {
    expect(
      isPreparedNativeModelCatalogReady({
        ...params,
        selection: { provider: "fixture", modelId, runtime },
      }),
    ).toBe(expected);
  }
});
