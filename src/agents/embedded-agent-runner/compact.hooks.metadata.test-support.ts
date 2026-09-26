import { vi, type Mock } from "vitest";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
} from "../../plugins/plugin-instance-invocation.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../prepared-model-runtime.types.js";

export type CompactHooksQueuedCompaction = (
  params: Parameters<typeof import("./compact.queued.js").compactEmbeddedAgentSession>[0],
  host?: Partial<Parameters<typeof import("./compact.queued.js").compactEmbeddedAgentSession>[1]>,
) => ReturnType<typeof import("./compact.queued.js").compactEmbeddedAgentSession>;

const emptyPluginIndex: PluginMetadataSnapshot["index"] = {
  version: 1,
  hostContractVersion: "test",
  compatRegistryVersion: "test",
  migrationVersion: 1,
  policyHash: "",
  generatedAtMs: 1,
  installRecords: {},
  plugins: [],
  diagnostics: [],
};
export const emptyPluginMetadataSnapshot: PluginMetadataSnapshot = {
  policyHash: "",
  index: emptyPluginIndex,
  registryIndex: emptyPluginIndex,
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  declaredProviderOwners: new Map(),
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    providerAuthContributions: [],
    modelIdNormalizationPolicies: new Map(),
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

export const getCurrentPluginMetadataSnapshotMock: Mock<
  typeof import("../../plugins/current-plugin-metadata-snapshot.js").getCurrentPluginMetadataSnapshot
> = vi.fn(() => emptyPluginMetadataSnapshot);

export function mockCompactHooksPluginMetadata(): void {
  vi.doMock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
    getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
    isCurrentPluginMetadataSnapshotRuntimeGeneration: () => false,
    resolvePluginMetadataControlPlaneFingerprint: vi.fn(() => "test-plugin-fingerprint"),
    createPluginMetadataSnapshotFrame: () =>
      getPluginExecutionFrame() ?? createPluginExecutionFrame({}, undefined),
    withPluginMetadataSnapshotScope: (_snapshot: unknown, run: () => unknown) => run(),
    runOutsidePluginMetadataSnapshotScope: <T>(run: () => T): T => run(),
  }));
}

export async function acquireCompactHooksPreparedModelRuntime(
  input: PreparedModelRuntimeInput,
  _options?: PreparedModelRuntimeLeaseOptions,
) {
  return {
    snapshot: {
      isCurrent: () => true,
      agentId: input.agentId,
      agentDir: input.agentDir,
      config: input.config,
      workspaceDir: input.workspaceDir,
      metadataSnapshot: { ...emptyPluginMetadataSnapshot, workspaceDir: input.workspaceDir },
      configuredRuntimeModels: [],
      findConfiguredRuntimeModel: () => undefined,
      inlineProviderModels: [],
      createStores: () => ({ authStorage: {}, modelRegistry: {} }),
    },
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

export function createCompactHooksPreparedModelRuntime(input: {
  agentId: string;
  agentDir: string;
  config: PreparedModelRuntimeInput["config"];
  workspaceDir: string;
  metadataSnapshot: PluginMetadataSnapshot;
}) {
  return {
    ...input,
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => ({ authStorage: {}, modelRegistry: {} }),
  };
}

export type MockResolvedModel = {
  logicalRef: { provider: string; model: string };
  model: {
    provider: string;
    api: string;
    baseUrl?: string;
    id: string;
    input: unknown[];
    contextWindow?: number;
    requestTimeoutMs?: number;
  };
  error: null;
  authStorage: Pick<import("../sessions/auth-storage.js").AuthStorage, "setRuntimeApiKey">;
  modelRegistry: Record<string, never> | import("../sessions/model-registry.js").ModelRegistry;
};
