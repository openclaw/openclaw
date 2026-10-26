import { vi, type Mock } from "vitest";
import {
  createPluginExecutionFrame,
  getPluginExecutionFrame,
} from "../../plugins/plugin-instance-invocation.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLeaseOptions,
} from "../prepared-model-runtime.types.js";
import type { AuthStorage } from "../sessions/auth-storage.js";

export type CompactHooksQueuedCompaction = (
  params: Parameters<typeof import("./compact.queued.js").compactEmbeddedAgentSession>[0],
  host?: Partial<Parameters<typeof import("./compact.queued.js").compactEmbeddedAgentSession>[1]>,
) => ReturnType<typeof import("./compact.queued.js").compactEmbeddedAgentSession>;

const emptyPluginMetadataSnapshot = createEmptyPluginMetadataSnapshot();

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

export function mockCompactHooksContextEngine(resolveContextEngine: () => Promise<unknown>): void {
  // mock-isolation: The compaction fixture does not initialize live plugin registrations.
  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));

  // mock-isolation: This harness supplies synthetic engines without registering live plugins.
  vi.doMock("../../context-engine/registry.js", () => ({
    hasSameContextEngineInstance: (left: unknown, right: unknown) => left === right,
    isContextEngineAbortRejection: (error: unknown, signal?: AbortSignal) =>
      signal?.aborted === true && error === signal.reason,
    resolveContextEngine,
    resolveContextEngineOwnerPluginId: vi.fn(() => "lossless-claw"),
    resolveLogicalTurnContextEngines: async () => {
      const ref = { engine: await resolveContextEngine(), registeredId: "legacy" };
      return { configured: ref, configuredId: "legacy", fallback: ref };
    },
  }));
}

function withEmptyRuntimeStores<T extends object>(identity: T) {
  return {
    ...identity,
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => ({ authStorage: {}, modelRegistry: {} }),
  };
}

export async function acquireCompactHooksPreparedModelRuntime(
  input: PreparedModelRuntimeInput,
  _options?: PreparedModelRuntimeLeaseOptions,
) {
  return {
    snapshot: withEmptyRuntimeStores({
      isCurrent: () => true,
      agentId: input.agentId,
      agentDir: input.agentDir,
      config: input.config,
      workspaceDir: input.workspaceDir,
      metadataSnapshot: { ...emptyPluginMetadataSnapshot, workspaceDir: input.workspaceDir },
    }),
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
  return withEmptyRuntimeStores(input);
}

export function createCompactHooksResolvedModel(
  provider = "openai",
  modelId = "fake",
): MockResolvedModel {
  const runtimeKeys = new Map<string, string>();
  return {
    logicalRef: { provider, model: modelId },
    model: {
      provider,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: modelId,
      input: [],
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn((providerKey: string, apiKey: string) => {
        runtimeKeys.set(providerKey, apiKey);
      }),
      getApiKey: vi.fn(async (providerKey: string) => runtimeKeys.get(providerKey)),
    },
    modelRegistry: {},
  };
}

export const resolveCompactHooksApiKeyMock = vi.fn<
  typeof import("./stream-resolution.js").resolveEmbeddedAgentApiKey
>(async ({ provider, resolvedApiKey, authStorage }) => {
  const apiKey = resolvedApiKey?.trim();
  return apiKey || (await authStorage?.getApiKey(provider));
});

export type MockResolvedModel = {
  logicalRef: { provider: string; model: string };
  model: Pick<
    ProviderRuntimeModel,
    "provider" | "api" | "id" | "contextWindow" | "requestTimeoutMs"
  > & {
    baseUrl?: string;
    input: unknown[];
  };
  error: null;
  authStorage: Pick<AuthStorage, "setRuntimeApiKey" | "getApiKey">;
  modelRegistry: Record<string, never> | import("../sessions/model-registry.js").ModelRegistry;
};
