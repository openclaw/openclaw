import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../model-catalog.types.js";
import { bindPreparedModelRuntimeAuth } from "../prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { resolveReadyNativeModelCatalogEntry } from "./native-model-catalog-resolution.js";
import type { AgentHarness } from "./types.js";

const luna: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-6-luna",
  name: "GPT-6-Luna",
  nativeRuntime: "codex",
  reasoning: true,
  input: ["text", "image"],
  params: { reasoningEffort: "max" },
  compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "max"] },
};
const catalog = (entries: ModelCatalogEntry[]): ModelCatalogSnapshot => ({
  entries,
  routeVariants: entries,
});

function fixture(
  params: {
    config?: OpenClawConfig;
    entries?: ModelCatalogEntry[];
    current?: () => boolean;
    ready?: boolean;
    load?: PreparedModelRuntimeSnapshot["loadFullModelCatalog"];
    loadNative?: PreparedModelRuntimeSnapshot["loadNativeModelCatalog"];
    readFull?: PreparedModelRuntimeSnapshot["readFullModelCatalog"];
    captureSelection?: AgentHarness["captureModelCatalogSelectionAuthority"];
  } = {},
) {
  const config: OpenClawConfig = params.config ?? {
    agents: {
      defaults: {
        model: "openai/gpt-6-luna",
        models: { "openai/gpt-6-luna": { agentRuntime: { id: "codex" } } },
      },
    },
  };
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    authBootstrap: "harness",
    supports: () => ({ supported: true }),
    loadModelCatalog: async () => [],
    readModelCatalogReadiness: () =>
      params.ready === false ? undefined : { accountType: "chatgpt", authMode: "oauth" },
    ...(params.captureSelection
      ? { captureModelCatalogSelectionAuthority: params.captureSelection }
      : {}),
    runAttempt: vi.fn(),
  };
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
  const snapshot: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    agentId: "main",
    agentDir: "/tmp/codex-agent",
    workspaceDir: "/tmp/codex-workspace",
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/codex-workspace" },
    activeProjectKeys: [],
    authModes: { codex: { source: "native", mode: "oauth" } },
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
    }),
    pluginRegistry,
    allowGatewaySubagentBinding: false,
    findConfiguredRuntimeModel: () => undefined,
    isCurrent: params.current ?? (() => true),
    modelCatalog: catalog(params.entries ?? []),
    ...(params.readFull ? { readFullModelCatalog: params.readFull } : {}),
    ...(params.loadNative ? { loadNativeModelCatalog: params.loadNative } : {}),
    ...(params.load ? { loadFullModelCatalog: params.load } : {}),
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("Native catalog resolution must not create execution stores");
    },
  };
  bindPreparedModelRuntimeAuth(snapshot, { store: { version: 1, profiles: {} } });
  return { harness, snapshot };
}

describe("first-turn native model catalog resolution", () => {
  it("resolves a ready Codex row when an unpinned OpenAI auth profile is configured", async () => {
    const { harness, snapshot } = fixture({
      entries: [luna],
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-6-luna",
            models: { "openai/gpt-6-luna": { agentRuntime: { id: "codex" } } },
          },
        },
        auth: {
          profiles: {
            "openai:work": { provider: "openai", mode: "oauth" },
          },
        },
      },
    });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toMatchObject({ entry: luna });
  });

  it("loads a cold exact Luna row and returns it only after readiness", async () => {
    const load = vi.fn(async () => catalog([luna]));
    const { harness, snapshot } = fixture({ load });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toMatchObject({ entry: luna });
    expect(load).toHaveBeenCalledWith({
      refresh: true,
      providerIds: ["openai"],
      foregroundWaitMs: 12_000,
    });
  });

  it("rejects a matching row from a nonauthoritative native refresh", async () => {
    const loadNative = vi.fn<NonNullable<PreparedModelRuntimeSnapshot["loadNativeModelCatalog"]>>(
      async (_selection, options) => {
        options?.onSelectionReady?.(false);
        return { ...catalog([luna]), authoritative: false, refreshFailed: true };
      },
    );
    const { harness, snapshot } = fixture({ loadNative });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();
    expect(loadNative).toHaveBeenCalledOnce();
  });

  it("accepts the exact ready row from a successful partial native acquisition", async () => {
    const assertCurrent = vi.fn();
    const loadNative = vi.fn<NonNullable<PreparedModelRuntimeSnapshot["loadNativeModelCatalog"]>>(
      async (_selection, options) => {
        options?.onSelectionReady?.(true);
        return { ...catalog([luna]), authoritative: false };
      },
    );
    const { harness, snapshot } = fixture({ loadNative, captureSelection: () => assertCurrent });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toMatchObject({ entry: luna, assertCurrent });
    expect(loadNative).toHaveBeenCalledOnce();
  });

  it("accepts a successful selected row when another provider failure remains", async () => {
    const loadNative = vi.fn<NonNullable<PreparedModelRuntimeSnapshot["loadNativeModelCatalog"]>>(
      async (_selection, options) => {
        options?.onSelectionReady?.(true);
        return { ...catalog([luna]), authoritative: false, refreshFailed: true };
      },
    );
    const { harness, snapshot } = fixture({ loadNative });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toMatchObject({ entry: luna });
    expect(loadNative).toHaveBeenCalledOnce();
  });

  it("rejects a matching partial row returned as the timeout fallback", async () => {
    vi.useFakeTimers();
    try {
      const stale = { ...catalog([luna]), authoritative: false };
      const loadNative = vi.fn(
        async (
          _selection: Parameters<
            NonNullable<PreparedModelRuntimeSnapshot["loadNativeModelCatalog"]>
          >[0],
          _options?: Parameters<
            NonNullable<PreparedModelRuntimeSnapshot["loadNativeModelCatalog"]>
          >[1],
        ) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 15_000);
          });
          return { ...catalog([luna]), authoritative: false };
        },
      );
      const { harness, snapshot } = fixture({ loadNative, readFull: () => stale });
      const resolved = resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      });

      await vi.advanceTimersByTimeAsync(12_000);
      await expect(resolved).resolves.toBeUndefined();
      expect(loadNative).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures an execution assertion for the selected native catalog row", async () => {
    const assertCurrent = vi.fn();
    const { harness, snapshot } = fixture({
      entries: [luna],
      captureSelection: () => assertCurrent,
    });

    const selection = await resolveReadyNativeModelCatalogEntry({
      snapshot,
      harness,
      provider: "openai",
      modelId: "gpt-6-luna",
    });

    expect(selection?.entry).toEqual(luna);
    expect(selection?.assertCurrent).toBe(assertCurrent);
  });

  it("rejects a native row when its execution authority cannot be captured", async () => {
    const { harness, snapshot } = fixture({
      entries: [luna],
      captureSelection: () => undefined,
    });

    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();
  });

  it("waits past the default catalog window for a cold native row", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(
        async (
          options?: Parameters<
            NonNullable<PreparedModelRuntimeSnapshot["loadFullModelCatalog"]>
          >[0],
        ) => {
          expect(options?.foregroundWaitMs).toBe(12_000);
          await new Promise((resolve) => {
            setTimeout(resolve, 6_000);
          });
          return catalog([luna]);
        },
      );
      const { harness, snapshot } = fixture({ load });
      let settled = false;
      const resolved = resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }).then((entry) => {
        settled = true;
        return entry;
      });

      await vi.advanceTimersByTimeAsync(5_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      await expect(resolved).resolves.toMatchObject({ entry: luna });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the bounded wait returns a nonauthoritative snapshot", async () => {
    vi.useFakeTimers();
    try {
      const stale = { ...catalog([luna]), authoritative: false };
      const load = vi.fn(
        async (
          options?: Parameters<
            NonNullable<PreparedModelRuntimeSnapshot["loadFullModelCatalog"]>
          >[0],
        ) => {
          expect(options?.foregroundWaitMs).toBe(12_000);
          return await Promise.race([
            new Promise<ModelCatalogSnapshot>((resolve) => {
              setTimeout(() => resolve(catalog([luna])), 15_000);
            }),
            new Promise<ModelCatalogSnapshot>((resolve) => {
              setTimeout(() => resolve(stale), options?.foregroundWaitMs);
            }),
          ]);
        },
      );
      const { harness, snapshot } = fixture({ load });
      const resolved = resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      });

      await vi.advanceTimersByTimeAsync(12_000);
      await expect(resolved).resolves.toBeUndefined();
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the owner becomes stale before the foreground timeout", async () => {
    vi.useFakeTimers();
    try {
      let current = true;
      const { harness, snapshot } = fixture({
        current: () => current,
        readFull: () => {
          if (!current) {
            throw new Error("prepared model runtime owner is stale");
          }
          return catalog([]);
        },
        loadNative: vi.fn(async () => new Promise<ModelCatalogSnapshot>(() => {})),
      });
      const resolved = resolveReadyNativeModelCatalogEntry({
        snapshot,
        harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      });

      current = false;
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(resolved).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unlisted models, stale owners, unavailable accounts, and a different runtime", async () => {
    const unlisted = fixture({ load: async () => catalog([]) });
    await expect(
      resolveReadyNativeModelCatalogEntry({
        ...unlisted,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();

    const stale = fixture({ current: () => false, load: vi.fn(async () => catalog([luna])) });
    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot: stale.snapshot,
        harness: stale.harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();
    expect(stale.snapshot.loadFullModelCatalog).not.toHaveBeenCalled();

    const mismatched = fixture({
      entries: [{ ...luna, nativeRuntime: "other-runtime" }],
      load: async () => catalog([{ ...luna, nativeRuntime: "other-runtime" }]),
    });
    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot: mismatched.snapshot,
        harness: mismatched.harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();

    const unavailable = fixture({ entries: [luna], ready: false });
    await expect(
      resolveReadyNativeModelCatalogEntry({
        snapshot: unavailable.snapshot,
        harness: unavailable.harness,
        provider: "openai",
        modelId: "gpt-6-luna",
      }),
    ).resolves.toBeUndefined();
  });
});
