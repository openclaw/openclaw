import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import { readStoredModelsConfigRaw, writeStoredModelsConfigRaw } from "./models-config-store.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";

const planOpenClawModelCatalogMock = vi.fn();

installModelsConfigTestHooks();

let ensureOpenClawModelCatalog: typeof import("./models-config.js").ensureOpenClawModelCatalog;
let clearCurrentPluginMetadataSnapshot: typeof import("../plugins/current-plugin-metadata-snapshot.js").clearCurrentPluginMetadataSnapshot;
let setCurrentPluginMetadataSnapshot: typeof import("../plugins/current-plugin-metadata-snapshot.js").setCurrentPluginMetadataSnapshot;

function createPluginMetadataSnapshot(workspaceDir: string): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  return {
    policyHash,
    workspaceDir,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
}

async function expectMissingPath(operation: Promise<unknown>) {
  let error: NodeJS.ErrnoException | undefined;
  try {
    await operation;
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }
  expect(error?.code).toBe("ENOENT");
}

function planParamsAt(callIndex: number): {
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  providerDiscoveryProviderIds?: string[];
  providerDiscoveryTimeoutMs?: number;
  workspaceDir?: string;
} {
  const call = planOpenClawModelCatalogMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected models planner call #${callIndex + 1}`);
  }
  return call[0] as {
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    providerDiscoveryProviderIds?: string[];
    providerDiscoveryTimeoutMs?: number;
    workspaceDir?: string;
  };
}

beforeAll(async () => {
  vi.doMock("./models-config.plan.js", () => ({
    planOpenClawModelCatalog: (...args: unknown[]) => planOpenClawModelCatalogMock(...args),
  }));
  ({ ensureOpenClawModelCatalog } = await import("./models-config.js"));
  ({ clearCurrentPluginMetadataSnapshot, setCurrentPluginMetadataSnapshot } =
    await import("../plugins/current-plugin-metadata-snapshot.js"));
});

beforeEach(() => {
  clearCurrentPluginMetadataSnapshot();
  planOpenClawModelCatalogMock
    .mockReset()
    .mockImplementation(async (params: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG }) => ({
      action: "write",
      contents: `${JSON.stringify({ providers: params.cfg?.models?.providers ?? {} }, null, 2)}\n`,
    }));
});

describe("models-config write serialization", () => {
  it("does not reuse default workspace plugin metadata for explicit agent dirs without workspace", async () => {
    await withModelsTempHome(async (home) => {
      const snapshot = createPluginMetadataSnapshot(path.join(home, "default-workspace"));
      setCurrentPluginMetadataSnapshot(snapshot, { config: {} });
      const agentDir = path.join(home, "agent-non-default");

      await ensureOpenClawModelCatalog({}, agentDir);

      const params = planOpenClawModelCatalogMock.mock.calls[0]?.[0] as
        | { pluginMetadataSnapshot?: PluginMetadataSnapshot }
        | undefined;
      expect(params?.pluginMetadataSnapshot).not.toBe(snapshot);
    });
  });

  it("reuses current plugin metadata for explicit agent dirs with matching workspace", async () => {
    await withModelsTempHome(async (home) => {
      const workspaceDir = path.join(home, "agent-workspace");
      const snapshot = createPluginMetadataSnapshot(workspaceDir);
      setCurrentPluginMetadataSnapshot(snapshot, { config: {} });
      const agentDir = path.join(home, "agent-non-default");

      await ensureOpenClawModelCatalog({}, agentDir, { workspaceDir });

      const params = planOpenClawModelCatalogMock.mock.calls[0]?.[0] as
        | { workspaceDir?: string; pluginMetadataSnapshot?: PluginMetadataSnapshot }
        | undefined;
      expect(params?.workspaceDir).toBe(workspaceDir);
      expect(params?.pluginMetadataSnapshot).toBe(snapshot);
    });
  });

  it("writes implicit model catalog config into SQLite for the configured default agent dir", async () => {
    await withModelsTempHome(async (home) => {
      const cfg = {
        agents: {
          list: [{ id: "main" }, { id: "ops", default: true }],
        },
      };

      const result = await ensureOpenClawModelCatalog(cfg);

      expect(result.agentDir).toBe(path.join(home, ".openclaw", "agents", "ops", "agent"));
      expect(readStoredModelsConfigRaw(result.agentDir)?.raw).toContain('"providers"');
      await expectMissingPath(fs.access(path.join(result.agentDir, "models.json")));
      await expectMissingPath(
        fs.access(path.join(home, ".openclaw", "agents", "main", "agent", "models.json")),
      );
    });
  });

  it("does not reuse scoped startup discovery cache for a different provider scope", async () => {
    await withModelsTempHome(async (home) => {
      planOpenClawModelCatalogMock.mockImplementation(async () => ({ action: "skip" }));
      const agentDir = path.join(home, "agent");
      await ensureOpenClawModelCatalog({}, agentDir, {
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
      });
      await ensureOpenClawModelCatalog({}, agentDir, {
        providerDiscoveryProviderIds: ["anthropic"],
        providerDiscoveryTimeoutMs: 5000,
      });

      expect(planOpenClawModelCatalogMock).toHaveBeenCalledTimes(2);
      const params = planOpenClawModelCatalogMock.mock.calls[1]?.[0] as
        | {
            providerDiscoveryProviderIds?: string[];
            providerDiscoveryTimeoutMs?: number;
          }
        | undefined;
      expect(params?.providerDiscoveryProviderIds).toEqual(["anthropic"]);
      expect(params?.providerDiscoveryTimeoutMs).toBe(5000);
    });
  });

  it("keeps the ready cache warm after the model catalog is written", async () => {
    await withModelsTempHome(async () => {
      await ensureOpenClawModelCatalog(CUSTOM_PROXY_MODELS_CONFIG);
      await ensureOpenClawModelCatalog(CUSTOM_PROXY_MODELS_CONFIG);

      expect(planOpenClawModelCatalogMock).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates the ready cache when stored model catalog config changes externally", async () => {
    await withModelsTempHome(async () => {
      await ensureOpenClawModelCatalog(CUSTOM_PROXY_MODELS_CONFIG);
      await ensureOpenClawModelCatalog(CUSTOM_PROXY_MODELS_CONFIG);

      writeStoredModelsConfigRaw(
        resolveDefaultAgentDir({}),
        `${JSON.stringify({ providers: { external: { models: [] } } })}\n`,
        { now: () => Date.now() + 2_000 },
      );
      await ensureOpenClawModelCatalog(CUSTOM_PROXY_MODELS_CONFIG);

      expect(planOpenClawModelCatalogMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps distinct config fingerprints cached without evicting each other", async () => {
    await withModelsTempHome(async () => {
      planOpenClawModelCatalogMock.mockImplementation(async () => ({ action: "noop" }));
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      first.agents = { defaults: { model: "openai/gpt-5.4" } };
      second.agents = { defaults: { model: "anthropic/claude-sonnet-4-5" } };

      await ensureOpenClawModelCatalog(first);
      await ensureOpenClawModelCatalog(second);
      await ensureOpenClawModelCatalog(first);

      expect(planOpenClawModelCatalogMock).toHaveBeenCalledTimes(2);
    });
  });

  it("serializes concurrent model catalog config writes to avoid overlap", async () => {
    await withModelsTempHome(async () => {
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const firstModel = first.models?.providers?.["custom-proxy"]?.models?.[0];
      const secondModel = second.models?.providers?.["custom-proxy"]?.models?.[0];
      if (!firstModel || !secondModel) {
        throw new Error("custom-proxy fixture missing expected model entries");
      }
      firstModel.name = "Proxy A";
      secondModel.name = "Proxy B with longer name";

      let inFlightPlans = 0;
      let maxInFlightPlans = 0;
      let markFirstModelsWriteStarted: () => void = () => {};
      const firstModelsWriteStarted = new Promise<void>((resolve) => {
        markFirstModelsWriteStarted = resolve;
      });
      let releaseModelsWrites: () => void = () => {};
      const modelsWritesCanContinue = new Promise<void>((resolve) => {
        releaseModelsWrites = resolve;
      });
      let planCount = 0;
      planOpenClawModelCatalogMock.mockImplementation(
        async (params: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG }) => {
          planCount += 1;
          inFlightPlans += 1;
          if (inFlightPlans > maxInFlightPlans) {
            maxInFlightPlans = inFlightPlans;
          }
          if (planCount === 1) {
            markFirstModelsWriteStarted();
            await modelsWritesCanContinue;
          }
          try {
            return {
              action: "write",
              contents: `${JSON.stringify({ providers: params.cfg?.models?.providers ?? {} }, null, 2)}\n`,
            };
          } finally {
            inFlightPlans -= 1;
          }
        },
      );

      const writes = Promise.all([
        ensureOpenClawModelCatalog(first),
        ensureOpenClawModelCatalog(second),
      ]);
      await firstModelsWriteStarted;
      await Promise.resolve();
      releaseModelsWrites();
      await writes;

      expect(maxInFlightPlans).toBe(1);
      const stored = readStoredModelsConfigRaw(resolveDefaultAgentDir({}));
      if (!stored) {
        throw new Error("expected stored model catalog config");
      }
      const parsed = JSON.parse(stored.raw) as {
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      };
      expect(["Proxy A", "Proxy B with longer name"]).toContain(
        parsed.providers["custom-proxy"]?.models?.[0]?.name,
      );
    });
  }, 60_000);
});
