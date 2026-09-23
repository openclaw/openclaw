import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { mergePreparedNativeCatalog } from "../prepared-model-runtime.full-catalog.js";
import {
  augmentModelCatalogWithAgentHarness,
  augmentPreparedModelCatalogWithAgentHarness,
} from "./model-catalog.js";

const cfg = {
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-sol" } },
    list: [
      {
        id: "main",
        default: true,
        models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    ],
  },
} as OpenClawConfig;

const snapshot: ModelCatalogSnapshot = {
  entries: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (API)",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    },
  ],
  routeVariants: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (API)",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
  ],
  staticEntries: [
    {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      params: { providerFact: "kept", codexAppServerRuntimeModel: "stale-runtime" },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        supportsTools: false,
      },
    },
    {
      provider: "openai",
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    },
    {
      provider: "openai",
      id: "provider-empty-reasoner",
      name: "Provider Empty Reasoner",
      compat: { supportedReasoningEfforts: [] },
    },
  ],
};

function registryWithCatalog(loadModelCatalog: () => Promise<readonly never[]>) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "test",
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      loadModelCatalog,
    } as never,
  });
  return registry;
}

describe("agent harness model catalog", () => {
  it.each([
    { baseRuntime: "openclaw", agentRuntime: undefined, observedRuntime: undefined },
    { baseRuntime: "native-one", agentRuntime: undefined, observedRuntime: "native-one" },
    { baseRuntime: "openclaw", agentRuntime: "native-one", observedRuntime: "native-one" },
    { baseRuntime: "native-one", agentRuntime: "openclaw", observedRuntime: undefined },
    { baseRuntime: "native-one", agentRuntime: "native-two", observedRuntime: "native-two" },
  ])(
    "observes only the selected runtime with configured=$baseRuntime selected=$agentRuntime",
    async ({ baseRuntime, agentRuntime, observedRuntime }) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture/model",
            models: {
              "fixture/model": {
                agentRuntime: { id: baseRuntime },
                pickerRuntimes: ["native-two"],
              },
            },
          },
        },
      };
      const host: ModelCatalogEntry = {
        provider: "fixture",
        id: "model",
        name: "Host model",
        reasoning: true,
      };
      const initial: ModelCatalogSnapshot = { entries: [host], routeVariants: [host] };
      const loadOne = vi.fn(async () => [{ ...host, nativeRuntime: "native-one" }]);
      const loadTwo = vi.fn(async () => [{ ...host, nativeRuntime: "native-two" }]);
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog] of [
        ["native-one", loadOne],
        ["native-two", loadTwo],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "test",
          harness: {
            id,
            label: id,
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            loadModelCatalog,
          },
        });
      }
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
    "retains successful default acquisition unless a failed alternative revokes the generation (revoked: %s)",
    async (revokeOnFailure) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture/model",
            models: {
              "fixture/model": {
                agentRuntime: { id: "native-one" },
                pickerRuntimes: ["native-two"],
              },
            },
          },
        },
      };
      const initial: ModelCatalogSnapshot = { entries: [], routeVariants: [] };
      const observed: ModelCatalogEntry = {
        provider: "fixture",
        id: "model",
        name: "Observed model",
        nativeRuntime: "native-one",
      };
      const failure = new Error("Alternative catalog is unavailable");
      let current = true;
      const successfulLoad = vi.fn(async () => [observed]);
      const failedLoad = vi.fn(async () => {
        current = !revokeOnFailure;
        throw failure;
      });
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog] of [
        ["native-one", successfulLoad],
        ["native-two", failedLoad],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "test",
          harness: {
            id,
            label: id,
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            loadModelCatalog,
          },
        });
      }
      const onError = vi.fn();
      const onDiscoveryCompleted = vi.fn();
      const result = await augmentPreparedModelCatalogWithAgentHarness({
        input: {
          config,
          agentId: "main",
          agentDir: "/tmp/picker-agent",
          workspaceDir: "/tmp/picker-workspace",
        },
        snapshot: initial,
        pluginRegistry: registry,
        isCurrent: () => current,
        onError,
        onDiscoveryCompleted,
      });
      expect(successfulLoad).toHaveBeenCalledOnce();
      expect(failedLoad).toHaveBeenCalledOnce();
      if (revokeOnFailure) {
        expect(result).toBe(initial);
        expect(onDiscoveryCompleted).not.toHaveBeenCalled();
      } else {
        expect(result.entries).toEqual([observed]);
        expect(result.routeVariants).toEqual([observed]);
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure, ["fixture"]);
        expect(onDiscoveryCompleted).toHaveBeenCalledExactlyOnceWith([observed]);
      }
    },
  );

  it.each([false, true])(
    "acquires picker runtimes once and preserves their refresh ownership (provider scoped: %s)",
    async (providerScoped) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "fixture/shared",
            models: {
              "fixture/shared": {
                agentRuntime: { id: "openclaw" },
                pickerRuntimes: ["native-one", "native-two"],
              },
              "fixture/second": { pickerRuntimes: ["native-one", "native-two"] },
              "other/third": { pickerRuntimes: ["native-one"] },
            },
          },
        },
      };
      const host: ModelCatalogEntry = {
        provider: "fixture",
        id: "shared",
        name: "Host model",
        reasoning: false,
      };
      const foreign: ModelCatalogEntry = {
        provider: "other",
        id: "foreign",
        name: "Foreign model",
        nativeRuntime: "native-two",
      };
      const initial: ModelCatalogSnapshot = {
        entries: [host, foreign],
        routeVariants: [host, foreign],
      };
      const first: ModelCatalogEntry = {
        provider: "fixture",
        id: "shared",
        name: "Native one",
        nativeRuntime: "native-one",
      };
      const second: ModelCatalogEntry = {
        ...first,
        name: "Native two",
        nativeRuntime: "native-two",
      };
      const stale: ModelCatalogEntry = { ...first, id: "retired" };
      const other: ModelCatalogEntry = { ...first, provider: "other", id: "third" };
      const loadOne = vi.fn(async () => [first, stale, other]);
      const loadTwo = vi.fn(async () => [second]);
      const registry = createEmptyPluginRegistry();
      for (const [id, loadModelCatalog] of [
        ["native-one", loadOne],
        ["native-two", loadTwo],
      ] as const) {
        registry.agentHarnesses.push({
          pluginId: id,
          source: "test",
          harness: {
            id,
            label: id,
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            loadModelCatalog,
          },
        });
      }
      const onDiscoveryStarted = vi.fn();
      const onDiscoveryCompleted = vi.fn();
      const params = {
        input: {
          config,
          agentId: "main",
          agentDir: "/tmp/picker-agent",
          workspaceDir: "/tmp/picker-workspace",
        },
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
      expect(
        discovered.routeVariants
          .filter((entry) => entry.provider === "fixture" && entry.id === "shared")
          .map((entry) => entry.nativeRuntime)
          .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(
        [undefined, "native-one", "native-two"].toSorted((left, right) =>
          (left ?? "").localeCompare(right ?? ""),
        ),
      );
      const published = mergePreparedNativeCatalog(discovered, initial);
      expect(
        published.routeVariants
          .filter((entry) => entry.provider === "fixture" && entry.id === "shared")
          .map((entry) => entry.nativeRuntime)
          .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(
        [undefined, "native-one", "native-two"].toSorted((left, right) =>
          (left ?? "").localeCompare(right ?? ""),
        ),
      );
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
      let current = true;
      loadOne.mockImplementationOnce(async () => {
        current = false;
        return [first];
      });
      const revoked = await augmentPreparedModelCatalogWithAgentHarness({
        ...params,
        snapshot: refreshed,
        isCurrent: () => current,
      });
      expect(revoked).toBe(refreshed);
      expect(loadOne).toHaveBeenCalledTimes(3);
      expect(loadTwo).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "does not donate host transport or capabilities to native-owned rows (host sibling: %s)",
    async (includeHostRow) => {
      const native = {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "Native model",
        nativeRuntime: "codex",
        reasoning: true,
      };
      const host = { provider: "openai", id: "gpt-5.6-terra", name: "Host model" };
      const result = await augmentModelCatalogWithAgentHarness({
        cfg,
        agentId: "main",
        agentDir: "/tmp/main-agent",
        workspaceDir: "/tmp/workspace",
        defaultProvider: "openai",
        defaultModel: "openai/gpt-5.6-sol",
        snapshot: { entries: [], routeVariants: [] },
        preparedSnapshot: snapshot,
        pluginRegistry: registryWithCatalog(
          async () => (includeHostRow ? [native, host] : [native]) as never,
        ),
      });
      expect(result.entries[0]).toEqual(native);
      expect(result.routeVariants[0]).toEqual(native);
      if (includeHostRow) {
        expect(result.entries[1]).toMatchObject({
          id: "gpt-5.6-terra",
          name: "Host model",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          reasoning: true,
        });
      }
    },
  );
  it("merges account-scoped harness models into the prepared generation", async () => {
    const loadModelCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: false,
        compat: { supportedReasoningEfforts: [] },
      },
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (account)",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        params: { codexAppServerRuntimeModel: "gpt-5.6-sol-runtime" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["high", "ultra"],
          supportsTools: true,
        },
      },
      {
        provider: "openai",
        id: "custom-reasoner",
        name: "Custom Reasoner",
        compat: { supportedReasoningEfforts: ["high"] },
      },
      {
        provider: "openai",
        id: "provider-empty-reasoner",
        name: "Provider Empty Reasoner",
        compat: { supportedReasoningEfforts: ["high"] },
      },
    ]);

    const result = await augmentModelCatalogWithAgentHarness({
      cfg,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(loadModelCatalog as never),
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
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      configuredModelRefs: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-5.6-sol" },
      ],
    });
  });

  it("prepares configured refs for the selected agent without including other agents", async () => {
    const selectedConfig: OpenClawConfig = {
      agents: {
        defaults: cfg.agents?.defaults,
        entries: {
          main: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              "openai/synthetic-configured": {},
            },
          },
          another: { model: { primary: "openai/synthetic-other-agent" } },
        },
      },
    };
    const loadModelCatalog = vi.fn(async () => []);
    await augmentModelCatalogWithAgentHarness({
      cfg: selectedConfig,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(loadModelCatalog),
    });

    expect(loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: selectedConfig,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      configuredModelRefs: [
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "openai", model: "synthetic-configured" },
      ],
    });
  });

  it("keeps prepared rows when harness discovery fails", async () => {
    const onError = vi.fn();
    const result = await augmentModelCatalogWithAgentHarness({
      cfg,
      agentId: "main",
      agentDir: "/tmp/main-agent",
      workspaceDir: "/tmp/workspace",
      defaultProvider: "anthropic",
      defaultModel: "openai/gpt-5.6-sol",
      snapshot,
      pluginRegistry: registryWithCatalog(async () => {
        throw new Error("model/list unavailable");
      }),
      onError,
    });

    expect(result).toBe(snapshot);
    expect(onError).toHaveBeenCalledOnce();
  });
});
