import { vi } from "vitest";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { AgentHarnessHostCapabilities } from "./harness/host-capability-types.js";
import type { AgentHarness } from "./harness/types.js";
const streamSimpleMock = vi.fn();
const readFileMock = vi.fn();
const parseSessionEntriesMock = vi.fn();
const migrateSessionEntriesMock = vi.fn();
const buildSessionContextMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn();
const loadPreparedModelRuntimeSnapshotMock = vi.fn();
const snapshotResources: { acquire?: () => { release: () => Promise<void> } } = {};
const discoverAuthStorageMock = vi.fn();
const discoverModelsMock = vi.fn();
const getModelRegistryRuntimeMock = vi.fn();
const resolveModelWithRegistryMock = vi.fn();
const ensureAuthProfileStoreMock = vi.fn();
const ensureAuthProfileStoreWithoutExternalProfilesMock = vi.fn();
const resolveModelAsyncMock = vi.fn();
const getApiKeyForModelMock = vi.fn();
const requireApiKeyMock = vi.fn();
const resolveSessionAuthSelectionMock = vi.fn();
const getActiveEmbeddedRunSnapshotMock = vi.fn();
const resolveSessionAgentIdMock = vi.fn();
const resolveSessionAgentIdsMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const listAgentEntriesMock = vi.fn();
const prepareProviderRuntimeAuthMock = vi.fn();
const registerProviderStreamForModelMock = vi.fn();
const resolveEmbeddedAgentStreamMock = vi.fn();
const prepareCliRunContextMock = vi.fn();
const executePreparedCliRunMock = vi.fn();
const diagDebugMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();
const createAgentHarnessHostCapabilitiesMock = vi.fn();
const closeAgentHarnessHostCapabilitiesMock = vi.fn();
const agentHarnessHostCapabilitiesMock: AgentHarnessHostCapabilities = Object.freeze({
  kind: "agent-harness-host-capability",
  version: 1,
  assertActive: vi.fn(),
  bindToolSurface: vi.fn((tools) => tools),
  runBeforeToolCall: vi.fn(),
  requestApproval: vi.fn(),
  waitForApproval: vi.fn(),
});
const listSessionEntriesCoreMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const loadTranscriptEventsMock = vi.fn();
const builtInOpenClawHarnesses = new WeakSet<object>();
const shouldPreferExplicitConfigApiKeyAuthMock = vi.fn((..._args: unknown[]) => false);
const hasUsableCustomProviderApiKeyMock = vi.fn((..._args: unknown[]) => false);
const resolveProviderEntryApiKeyProfileReferenceMock = vi.fn((_params?: unknown): unknown => ({
  kind: "none",
}));
const preparedRuntimeSnapshotState = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  useSnapshotPluginRegistry: false,
}));

vi.mock("../llm/stream.js", async () => {
  const original = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...original,
    streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      readFile: (...args: unknown[]) => readFileMock(...args),
    },
    readFile: (...args: unknown[]) => readFileMock(...args),
  };
});

vi.mock("./sessions/session-manager.js", () => ({
  buildSessionContext: (...args: unknown[]) => buildSessionContextMock(...args),
  generateSummary: vi.fn(async () => "summary"),
  migrateSessionEntries: (...args: unknown[]) => migrateSessionEntriesMock(...args),
  parseSessionEntries: (...args: unknown[]) => parseSessionEntriesMock(...args),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModels: (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: (...args: unknown[]) => getModelRegistryRuntimeMock(...args),
}));

vi.mock("./prepared-model-runtime.js", () => {
  const loadSnapshot = async (params: {
    agentId?: string;
    agentDir: string;
    config: unknown;
    inheritedAuthDir?: string;
    workspaceDir?: string;
    allowGatewaySubagentBinding?: boolean;
  }) => {
    loadPreparedModelRuntimeSnapshotMock(params);
    const workspaceOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : {};
    await ensureOpenClawModelsJsonMock(params.config, params.agentDir, workspaceOptions);
    const authStorage = discoverAuthStorageMock(params.agentDir, {
      config: params.config,
      ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
      ...workspaceOptions,
    });
    const modelRegistry = discoverModelsMock(authStorage, params.agentDir, {
      config: params.config,
      ...workspaceOptions,
    });
    return {
      ...(preparedRuntimeSnapshotState.snapshot as object),
      ...(preparedRuntimeSnapshotState.useSnapshotPluginRegistry
        ? {}
        : { pluginRegistry: getActivePluginRegistry() }),
      agentId: params.agentId,
      agentDir: params.agentDir,
      config: params.config,
      workspaceDir: params.workspaceDir,
      configuredRuntimeModels: [],
      findConfiguredRuntimeModel: () => undefined,
      inlineProviderModels: [],
      createStores: () => ({ authStorage, modelRegistry }),
    };
  };
  return {
    preparedModelRuntimeConfigsMatch: (left: unknown, right: unknown) => left === right,
    loadPreparedModelRuntimeSnapshot: loadSnapshot,
    acquirePublishedPreparedModelRuntime: async (params: Parameters<typeof loadSnapshot>[0]) => {
      const snapshot = await loadSnapshot(params);
      return {
        snapshot,
        [Symbol.asyncDispose]: snapshotResources.acquire?.().release ?? (async () => {}),
      };
    },
  };
});

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: (...args: unknown[]) => resolveModelAsyncMock(...args),
  resolveModelWithRegistry: (...args: unknown[]) => resolveModelWithRegistryMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  ensureAuthProfileStoreWithoutExternalProfiles: (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(...args),
  getApiKeyForModelCore: (...args: unknown[]) => getApiKeyForModelMock(...args),
  hasUsableCustomProviderApiKey: (...args: unknown[]) => hasUsableCustomProviderApiKeyMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
  resolveProviderEntryApiKeyProfileReference: (params: unknown) =>
    resolveProviderEntryApiKeyProfileReferenceMock(params),
  shouldPreferExplicitConfigApiKeyAuth: (...args: unknown[]) =>
    shouldPreferExplicitConfigApiKeyAuthMock(...args),
}));

vi.mock("./model-runtime-aliases.js", () => ({
  isCliRuntimeAliasForProvider: ({ runtime, provider }: { runtime?: string; provider?: string }) =>
    runtime === "claude-cli" && provider === "anthropic",
  resolveCliRuntimeExecutionProvider: ({
    provider,
    cfg,
    modelId,
    authProfileId,
  }: {
    provider?: string;
    cfg?: {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { id?: string } }>;
        };
      };
      auth?: {
        order?: Record<string, string[]>;
        profiles?: Record<string, { provider?: string }>;
      };
    };
    modelId?: string;
    authProfileId?: string;
  }) => {
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    if ((!runtime || runtime === "auto") && authProfileId?.trim()) {
      return cfg?.auth?.profiles?.[authProfileId]?.provider === "claude-cli"
        ? "claude-cli"
        : undefined;
    }
    if (!runtime || runtime === "auto") {
      for (const profileId of cfg?.auth?.order?.[provider ?? ""] ?? []) {
        if (cfg?.auth?.profiles?.[profileId]?.provider === "claude-cli") {
          return "claude-cli";
        }
      }
    }
    return runtime === "claude-cli" ? runtime : undefined;
  },
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: (...args: unknown[]) => prepareCliRunContextMock(...args),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: (...args: unknown[]) => executePreparedCliRunMock(...args),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (...args: unknown[]) =>
    ensureSelectedAgentHarnessPluginMock(...args),
}));

// Selection and host-capability owner suites execute the embedded runner and capability surface.
// BTW only needs their identities while it verifies side-question orchestration.
vi.mock("./harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: (): AgentHarness => {
    const harness: AgentHarness = {
      id: "openclaw",
      label: "OpenClaw embedded agent",
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt: vi.fn(),
    };
    builtInOpenClawHarnesses.add(harness);
    return harness;
  },
  isBuiltInOpenClawAgentHarness: (harness: AgentHarness) => builtInOpenClawHarnesses.has(harness),
}));

vi.mock("./harness/host-capability.js", () => {
  return {
    createAgentHarnessHostCapabilities: (params: unknown) => {
      createAgentHarnessHostCapabilitiesMock(params);
      return {
        capabilities: agentHarnessHostCapabilitiesMock,
        close: closeAgentHarnessHostCapabilitiesMock,
      };
    },
  };
});

vi.mock("./embedded-agent-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
}));

vi.mock("./agent-scope.js", () => ({
  listAgentEntries: (...args: unknown[]) => listAgentEntriesMock(...args),
  resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
    cfg.agents?.list?.find((entry) => entry.id === agentId),
  resolveSessionAgentIds: (...args: unknown[]) => resolveSessionAgentIdsMock(...args),
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentDir: () => "/tmp/agent",
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: (...args: unknown[]) => prepareProviderRuntimeAuthMock(...args),
}));

// Provider ownership and public-surface loading have dedicated owner suites. BTW stubs those
// boundaries so its orchestration tests do not rediscover every plugin.
vi.mock("../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" as const }),
}));

vi.mock("../plugins/provider-policy-surface.js", () => ({
  // Provider route policy has dedicated adapter and OpenAI owner suites. BTW needs only a
  // deterministic route fixture so orchestration tests do not load plugin public surfaces.
  resolveDirectBundledProviderPolicySurface: (provider: string) => {
    if (provider.trim().toLowerCase() !== "openai") {
      return null;
    }
    return {
      normalizeModelCatalogId: ({ modelId }: { modelId: string }) => modelId,
      resolveModelRoutes: ({
        requestTransportOverrides = "none",
      }: ProviderResolveModelRoutesContext) => {
        const compatibleIds =
          requestTransportOverrides === "none" ? ["openclaw", "codex"] : ["openclaw"];
        return {
          kind: "routes" as const,
          defaultRuntimeId: requestTransportOverrides === "none" ? "codex" : "openclaw",
          routes: [
            {
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key" as const,
              requestTransportOverrides,
              runtimePolicy: { compatibleIds },
            },
            {
              api: "openai-chatgpt-responses" as const,
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authRequirement: "subscription" as const,
              requestTransportOverrides,
              runtimePolicy: { compatibleIds },
            },
          ],
        };
      },
    };
  },
  resolveTrustedExternalProviderPolicySurface: () => null,
}));

vi.mock("./provider-stream.js", () => ({
  registerProviderStreamForModel: (...args: unknown[]) =>
    registerProviderStreamForModelMock(...args),
}));

vi.mock("./embedded-agent-runner/stream-resolution.js", () => ({
  resolveEmbeddedAgentStream: (...args: unknown[]) => resolveEmbeddedAgentStreamMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: (...args: unknown[]) => resolveSessionAuthSelectionMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: vi.fn(async () => undefined),
  listSessionEntriesCore: (...args: unknown[]) => listSessionEntriesCoreMock(...args),
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  loadTranscriptEvents: (...args: unknown[]) => loadTranscriptEventsMock(...args),
}));

export {
  streamSimpleMock,
  readFileMock,
  parseSessionEntriesMock,
  migrateSessionEntriesMock,
  buildSessionContextMock,
  ensureOpenClawModelsJsonMock,
  loadPreparedModelRuntimeSnapshotMock,
  snapshotResources,
  discoverAuthStorageMock,
  discoverModelsMock,
  getModelRegistryRuntimeMock,
  resolveModelWithRegistryMock,
  ensureAuthProfileStoreMock,
  ensureAuthProfileStoreWithoutExternalProfilesMock,
  resolveModelAsyncMock,
  getApiKeyForModelMock,
  requireApiKeyMock,
  resolveSessionAuthSelectionMock,
  getActiveEmbeddedRunSnapshotMock,
  resolveSessionAgentIdMock,
  resolveSessionAgentIdsMock,
  resolveAgentWorkspaceDirMock,
  listAgentEntriesMock,
  prepareProviderRuntimeAuthMock,
  registerProviderStreamForModelMock,
  resolveEmbeddedAgentStreamMock,
  prepareCliRunContextMock,
  executePreparedCliRunMock,
  diagDebugMock,
  ensureSelectedAgentHarnessPluginMock,
  createAgentHarnessHostCapabilitiesMock,
  closeAgentHarnessHostCapabilitiesMock,
  agentHarnessHostCapabilitiesMock,
  listSessionEntriesCoreMock,
  loadSessionEntryMock,
  loadTranscriptEventsMock,
  shouldPreferExplicitConfigApiKeyAuthMock,
  hasUsableCustomProviderApiKeyMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  preparedRuntimeSnapshotState,
};
