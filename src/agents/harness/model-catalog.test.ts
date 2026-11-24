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

const apiModel: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol (API)",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const nativeRoute = {
  provider: "openai",
  api: "openai-chatgpt-responses" as const,
  baseUrl: "https://chatgpt.com/backend-api/codex",
};
const standardEfforts = ["low", "medium", "high", "xhigh", "max"];
const reasoningCompat = (efforts = standardEfforts) => ({
  supportsReasoningEffort: true,
  supportedReasoningEfforts: [...efforts],
});
const snapshot: ModelCatalogSnapshot = {
  entries: [{ ...apiModel, compat: reasoningCompat() }],
  routeVariants: [apiModel],
  staticEntries: [
    {
      ...nativeRoute,
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      reasoning: true,
      params: { providerFact: "kept", codexAppServerRuntimeModel: "stale-runtime" },
      compat: {
        ...reasoningCompat(),
        supportsTools: false,
      },
    },
    {
      ...nativeRoute,
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      reasoning: true,
      compat: reasoningCompat([...standardEfforts, "ultra"]),
    },
    row("provider-empty-reasoner", {
      provider: "openai",
      compat: { supportedReasoningEfforts: [] },
    }),
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

  it("retains successful default acquisition when an alternative fails", async () => {
    const config = pickerConfig("native-one");
    const initial = catalog([]);
    const observed = row("model", { name: "Observed model", nativeRuntime: "native-one" });
    const failure = new Error("Alternative catalog is unavailable");
    const successfulLoad = vi.fn(async () => [observed]);
    const failedLoad = vi.fn(async () => {
      throw failure;
    });
    const registry = catalogRegistry({ "native-one": successfulLoad, "native-two": failedLoad });
    const onError = vi.fn();
    const onDiscoveryCompleted = vi.fn();
    const result = await augmentPreparedModelCatalogWithAgentHarness({
      input: pickerInput(config),
      snapshot: initial,
      pluginRegistry: registry,
      onError,
      onDiscoveryCompleted,
    });
    expect(successfulLoad).toHaveBeenCalledOnce();
    expect(failedLoad).toHaveBeenCalledOnce();
    expect([result.entries, result.routeVariants]).toEqual([[observed], [observed]]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, ["fixture"]);
    expect(onDiscoveryCompleted).toHaveBeenCalledExactlyOnceWith([observed]);
  });

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
      const second: ModelCatalogEntry = {
        ...first,
        name: "Native two",
        nativeRuntime: "native-two",
      };
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

  it("does not donate host transport or capabilities to native-owned rows beside host rows", async () => {
    const native = {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "Native model",
      nativeRuntime: "codex",
      reasoning: true,
    };
    const host = { provider: "openai", id: "gpt-5.6-terra", name: "Host model" };
    const result = await augmentModelCatalogWithAgentHarness({
      ...modelInput,
      defaultProvider: "openai",
      snapshot: catalog([]),
      preparedSnapshot: snapshot,
      pluginRegistry: registryWithCatalog(async () => [native, host]),
    });
    expect(result.entries[0]).toEqual(native);
    expect(result.routeVariants[0]).toEqual(native);
    expect(result.entries[1]).toMatchObject({
      id: "gpt-5.6-terra",
      name: "Host model",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
    });
  });
  it("merges account-scoped harness models into the prepared generation", async () => {
    const loadModelCatalog = vi.fn(async () => [
      {
        ...nativeRoute,
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: false,
        compat: { supportedReasoningEfforts: [] },
      },
      {
        ...nativeRoute,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (account)",
        reasoning: true,
        params: { codexAppServerRuntimeModel: "gpt-5.6-sol-runtime" },
        compat: {
          ...reasoningCompat(["high", "ultra"]),
          supportsTools: true,
        },
      },
      row("custom-reasoner", {
        provider: "openai",
        compat: { supportedReasoningEfforts: ["high"] },
      }),
      row("provider-empty-reasoner", {
        provider: "openai",
        compat: { supportedReasoningEfforts: ["high"] },
      }),
    ]);

    const result = await augmentModelCatalogWithAgentHarness({
      ...modelInput,
      defaultProvider: "anthropic",
      snapshot,
      pluginRegistry: registryWithCatalog(loadModelCatalog),
    });

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "custom-reasoner",
      "provider-empty-reasoner",
    ]);
    expect(result.entries[0]?.compat?.supportedReasoningEfforts).toEqual([]);
    expect(result.entries[1]).toMatchObject({
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
    expect(result.entries[2]?.compat?.supportedReasoningEfforts).toEqual(["high"]);
    expect(result.entries[3]?.compat?.supportedReasoningEfforts).toEqual(["high"]);
    expect(result.routeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }),
        expect.objectContaining({ id: "gpt-5.6-sol", api: "openai-responses" }),
      ]),
    );
    expect(loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      agentId: modelInput.agentId,
      agentDir: modelInput.agentDir,
      workspaceDir: modelInput.workspaceDir,
      configuredModelRefs: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-5.6-sol" },
      ],
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
