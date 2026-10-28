import "./attempt-spawn-workspace.session-mocks.test-support.js";
import "./attempt-spawn-workspace.tools-mock.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { vi } from "vitest";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
} from "../../../context-engine/types.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
// Shared harness and mocks for embedded attempt spawn-workspace tests.
// Preserve snapshot-reader and lifecycle registration before the attempt graph loads.
import "../../../plugins/current-plugin-metadata.test-support.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { createEmptyPluginMetadataSnapshot } from "../../../plugins/plugin-metadata-empty.test-support.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { createLazyPromise } from "../../../shared/lazy-runtime.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers/context-file.js";
import type { Agent, AgentMessage, StreamFn } from "../../runtime/index.js";
import { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "../../sessions/agent-session-prompting.js";
import type { AgentSession, CreateAgentSessionOptions } from "../../sessions/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
} from "../../sessions/model-registry-runtime.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { WorkspaceBootstrapFile } from "../../workspace.js";
import {
  createTestPromptContextQueue,
  runPreparedTestPrompt,
  type MutableSession,
} from "./attempt-prompt-admission.test-support.js";
import { getSkillMocks, resetSkillMocks } from "./attempt-skills-mock.test-support.js";
import {
  readMockSessionCacheTtlTimestamp,
  resetSessionManagerMocks,
  type SessionManagerMocks,
} from "./attempt-spawn-workspace.session-manager-mock.test-support.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type SubscribeEmbeddedAgentSessionFn =
  typeof import("../../embedded-agent-subscribe.js").subscribeEmbeddedAgentSession;
type GuardSessionManagerFn =
  typeof import("../../session-tool-result-guard-wrapper.js").guardSessionManager;
type ShouldPreemptivelyCompactBeforePromptFn =
  typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;
type CreateCodingToolsFn = (
  ...args: Parameters<typeof import("../../agent-tools.js").createOpenClawCodingToolsInternal>
) => unknown;

type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type CapturedTrajectoryEvent = {
  data?: Record<string, unknown>;
  type: string;
  workspaceDir?: string;
};

const normalizeMockProviderId = normalizeLowercaseStringOrEmpty;

const hoisted = vi.hoisted(() => {
  const mock = () => vi.fn<(...args: unknown[]) => unknown>();
  const asyncMock = (implementation: (...args: unknown[]) => Promise<unknown>) =>
    vi.fn(implementation);
  // Hoisted mocks must exist before the runner module graph is imported, because
  // runEmbeddedAttempt captures these dependencies at module load.
  const resolveBootstrapContextForRunMock = vi.fn<() => Promise<BootstrapContext>>(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  }));
  const getBranch = vi.fn(() => []);
  const sessionManager: SessionManagerMocks = {
    getSessionTarget: vi.fn(() => undefined),
    getSessionId: vi.fn(() => "embedded-session"),
    getAppendParentId: vi.fn<() => string | null>(() => null),
    getHeader: vi.fn(() => ({ version: 3 })),
    getLeafId: vi.fn<() => string | null>(() => null),
    getLeafEntry: vi.fn(() => null),
    hasLoadedTranscriptTail: () => true,
    getEntry: vi.fn(() => undefined),
    getEntries: vi.fn(() => []),
    getBranch,
    getToolResultProjectionEntries: getBranch,
    getBoundaryCount: vi.fn(() => 0),
    branchAsync: vi.fn(async () => undefined),
    resetLeafAsync: vi.fn(async () => undefined),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendThinkingLevelChange: vi.fn(),
    appendModelChange: vi.fn(),
    appendCustomEntryAsync: vi.fn(async (..._args: unknown[]) => undefined),
    appendMessageAsync: vi.fn(async (..._args: unknown[]) => undefined),
    appendSessionInfoAsync: vi.fn(async (..._args: unknown[]) => undefined),
    appendLabelChangeAsync: vi.fn(async (..._args: unknown[]) => undefined),
    flushPendingPersistence: vi.fn(),
    flushPendingToolResultsAsync: vi.fn(async () => undefined),
    clearPendingToolResults: vi.fn(),
    reloadPersistedTranscriptAsync: vi.fn(async () => undefined),
    setNextUserMessagePersistence: vi.fn(),
    removeTrailingEntriesAsync: vi.fn(async () => 0),
  };
  return {
    spawnSubagentDirectMock: mock(),
    createAgentSessionMock: vi.fn<(options: CreateAgentSessionOptions) => unknown>(),
    applyExtraParamsToAgentMock: mock(),
    sessionManagerOpenMock: mock(),
    guardSessionManagerMock: vi.fn<GuardSessionManagerFn>((manager) => manager),
    defaultResourceLoaderInitMock: mock(),
    resolveSandboxContextMock: mock(),
    ensureGlobalUndiciEnvProxyDispatcherMock: mock(),
    ensureGlobalUndiciDispatcherStreamTimeoutsMock: mock(),
    createOpenClawCodingToolsMock: vi.fn<CreateCodingToolsFn>(() => []),
    subscribeEmbeddedAgentSessionMock: vi.fn<SubscribeEmbeddedAgentSessionFn>(() =>
      createSubscriptionMock(),
    ),
    installToolResultContextGuardMock: mock().mockImplementation(() => () => {}),
    installContextEngineLoopHookMock: mock().mockImplementation(() => () => {}),
    flushPendingToolResultsAfterIdleMock: asyncMock(async () => {}),
    resolveBootstrapFilesForRunMock: vi.fn(
      async (..._args: unknown[]) => (await resolveBootstrapContextForRunMock()).bootstrapFiles,
    ),
    resolveBootstrapContextForRunMock,
    isWorkspaceBootstrapPendingMock: vi.fn<(workspaceDir: string) => Promise<boolean>>(
      async () => false,
    ),
    resolveContextInjectionModeMock: vi.fn<() => "always" | "continuation-skip">(() => "always"),
    hasCompletedBootstrapTurnMock: vi.fn<() => Promise<boolean>>(async () => false),
    supportsModelToolsMock: vi.fn<(model?: unknown) => boolean>(() => true),
    getGlobalHookRunnerMock: vi.fn<typeof getGlobalHookRunner>(() => null),
    initializeGlobalHookRunnerMock: mock(),
    runContextEngineMaintenanceMock: vi.fn<
      (...args: unknown[]) => Promise<ContextEngineMaintenanceResult | undefined>
    >(async () => undefined),
    detectAndLoadPromptImagesMock: asyncMock(async () => ({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 0,
      skippedCount: 0,
    })),
    getHistoryLimitFromSessionKeyMock: vi.fn<
      (sessionKey: string | undefined, config: unknown, route?: unknown) => number | undefined
    >(() => undefined),
    limitHistoryTurnsMock: vi.fn<<T>(messages: T, limit: number | undefined) => T>(
      (messages) => messages,
    ),
    preemptiveCompactionCalls: Array<Parameters<ShouldPreemptivelyCompactBeforePromptFn>[0]>(),
    compactionReserveTokens: 0,
    systemPromptTexts: Array<string>(),
    embeddedSystemPromptInputs: Array<unknown>(),
    trajectoryEvents: Array<CapturedTrajectoryEvent>(),
    sessionManager,
  };
});

export function getHoisted() {
  return Object.assign(hoisted, getSkillMocks());
}

const emptyPluginMetadataSnapshot: PluginMetadataSnapshot = createEmptyPluginMetadataSnapshot();

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  isPluginMetadataSnapshotCompatible: () => true,
  listPluginOriginsFromMetadataSnapshot: () => new Map(),
  loadPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const { getModelProviderRuntimePluginHandle } =
    await importOriginal<typeof import("../../../plugins/provider-hook-runtime.js")>();
  return {
    getModelProviderRuntimePluginHandle,
    ensureProviderRuntimePluginHandle: (params: Record<string, unknown>) =>
      params.runtimeHandle ?? params,
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    resolveProviderRuntimePluginHandle: (params: Record<string, unknown>) => params,
    wrapProviderStreamFn: () => undefined,
  };
});

vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryArtifacts: (params: Record<string, unknown>) => params,
  buildTrajectoryRunMetadata: () => ({ source: "test" }),
}));

vi.mock("../../../trajectory/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../trajectory/runtime.js")>(
    "../../../trajectory/runtime.js",
  );
  return {
    ...actual,
    createTrajectoryRuntimeRecorder: async (
      params: Parameters<typeof actual.createTrajectoryRuntimeRecorder>[0],
    ) => {
      const recorder = await actual.createTrajectoryRuntimeRecorder(params);
      return {
        enabled: true as const,
        describeFlushState: () => recorder?.describeFlushState(),
        flush: async () => {
          await recorder?.flush();
        },
        recordEvent: (type: string, data?: Record<string, unknown>) => {
          hoisted.trajectoryEvents.push({
            type,
            ...(data ? { data } : {}),
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          });
          recorder?.recordEvent(type, data);
        },
      };
    },
  };
});

vi.mock("../../sessions/resource-loader.js", () => ({
  DefaultResourceLoader: class {
    constructor(...args: unknown[]) {
      hoisted.defaultResourceLoaderInitMock(...args);
    }
    async reload() {}
  },
}));

// mock-isolation: Keep session storage and provider runtime inside the in-memory attempt fixture.
vi.mock("../../sessions/index.js", () => {
  function AuthStorage() {}
  function ModelRegistry() {}
  const estimateTokens = (value: unknown) =>
    Math.max(1, Math.ceil(JSON.stringify(value ?? "").length / 4));

  return {
    AuthStorage,
    createAgentSession: hoisted.createAgentSessionMock,
    estimateTokens,
    generateSummary: async () => "",
    ModelRegistry,
    SessionManager: {
      inMemory: hoisted.sessionManagerOpenMock,
      openAsync: async (...args: unknown[]) => hoisted.sessionManagerOpenMock(...args),
    },
  };
});

// mock-isolation: Keep session storage and provider runtime outside the attempt fixture.
vi.mock("../../sessions/sdk.js", () => ({
  createAgentSession: hoisted.createAgentSessionMock,
}));

// mock-isolation: Observe child dispatch without launching a real subagent.
vi.mock("../../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: hoisted.spawnSubagentDirectMock,
}));

vi.mock("../../sandbox/context.js", async () => ({
  ...(await vi.importActual<typeof import("../../sandbox/context.js")>("../../sandbox/context.js")),
  resolveSandboxContext: hoisted.resolveSandboxContextMock,
}));

// mock-isolation: The fixture owns its synthetic session manager and tool-result capture.
vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: hoisted.guardSessionManagerMock,
}));

// mock-isolation: Supply explicit stream callbacks without starting real session subscriptions.
vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: hoisted.subscribeEmbeddedAgentSessionMock,
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
  initializeGlobalHookRunner: hoisted.initializeGlobalHookRunnerMock,
}));

vi.mock("../../../plugins/provider-runtime.js", () => ({
  resolveProviderReasoningOutputModeWithPlugin: () => undefined,
  resolveProviderSystemPromptContribution: () => undefined,
  resolveProviderTextTransforms: () => undefined,
  transformProviderSystemPrompt: ({ context }: { context: { systemPrompt?: string } }) =>
    context.systemPrompt,
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "test-host",
}));

// mock-isolation: attempt orchestration observes setup without replacing the process dispatcher.
vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  DEFAULT_UNDICI_STREAM_TIMEOUT_MS: 120_000,
  ensureGlobalUndiciEnvProxyDispatcher: hoisted.ensureGlobalUndiciEnvProxyDispatcherMock,
  ensureGlobalUndiciDispatcherStreamTimeouts:
    hoisted.ensureGlobalUndiciDispatcherStreamTimeoutsMock,
}));

vi.mock("../../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: () => undefined,
  resolveModelOverridePolicy: () => undefined,
  setTtsMachinePrefsPathResolver: () => undefined,
}));

vi.mock("../../bootstrap-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../bootstrap-files.js")>()),
  makeBootstrapWarn: () => () => {},
  isWorkspaceBootstrapPending: hoisted.isWorkspaceBootstrapPendingMock,
  resolveBootstrapFilesForRun: hoisted.resolveBootstrapFilesForRunMock,
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
  resolveContextInjectionMode: hoisted.resolveContextInjectionModeMock,
  hasCompletedBootstrapTurn: hoisted.hasCompletedBootstrapTurnMock,
}));

vi.mock("../../workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workspace.js")>()),
  isWorkspaceBootstrapPending: hoisted.isWorkspaceBootstrapPendingMock,
}));

// mock-isolation: Observe maintenance admission without running background engine work.
vi.mock("../context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: hoisted.runContextEngineMaintenanceMock,
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawReferencePaths: async () => ({ docsPath: undefined, sourcePath: undefined }),
}));

// mock-isolation: Attempt fixtures use in-memory settings without reading project or user settings.
vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: () => ({
    reload: async () => {},
    getCompactionEnabled: () => true,
    getCompactionReserveTokens: () => hoisted.compactionReserveTokens,
    getCompactionKeepRecentTokens: () => 40_000,
    getDefaultThinkingLevel: () => undefined,
    getBlockImages: () => false,
    getSteeringMode: () => undefined,
    getFollowUpMode: () => undefined,
    getTransport: () => undefined,
    getThinkingBudgets: () => undefined,
    getProviderRetrySettings: () => ({ maxRetryDelayMs: undefined }),
    getGlobalSettings: () => ({}),
    applyOverrides: () => {},
    setCompactionEnabled: () => {},
  }),
}));

vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: () => [],
}));

vi.mock("../replay-history.js", () => ({
  normalizeAssistantReplayContent: <T>(messages: T) => messages,
  sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
  validateReplayTurns: async ({ messages }: { messages: unknown[] }) => messages,
}));

vi.mock("../tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: () => {},
  normalizeProviderToolSchemas: ({ tools }: { tools: unknown[] }) => tools,
}));

vi.mock("../tool-result-context-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-result-context-guard.js")>()),
  installToolResultContextGuard: hoisted.installToolResultContextGuardMock,
  installContextEngineLoopHook: hoisted.installContextEngineLoopHookMock,
}));

// mock-isolation: The fixture controls pending tool results instead of waiting on a real stream.
vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: hoisted.flushPendingToolResultsAfterIdleMock,
}));

// mock-isolation: Workspace tests supply synthetic media without filesystem hydration.
vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: hoisted.detectAndLoadPromptImagesMock,
  hydratePromptMediaMessages: async (messages: AgentMessage[]) => messages,
}));

// mock-isolation: Workspace tests supply runtime facts without host discovery.
vi.mock("../../system-prompt-params.js", () => ({
  buildSystemPromptParams: () => ({
    runtimeInfo: {},
  }),
}));

vi.mock("../../system-prompt-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../system-prompt-config.js")>()),
  buildConfiguredAgentSystemPrompt: (params: unknown) => {
    hoisted.embeddedSystemPromptInputs.push(params);
    return "system prompt";
  },
}));

vi.mock("../extra-params.js", async () => {
  const actual = await vi.importActual<typeof import("../extra-params.js")>("../extra-params.js");
  return {
    ...actual,
    applyExtraParamsToAgent: (...args: unknown[]) => {
      hoisted.applyExtraParamsToAgentMock(...args);
      return { effectiveExtraParams: {} };
    },
    resolvePreparedExtraParams: (params: {
      cfg?: unknown;
      provider: string;
      modelId: string;
      agentId?: string;
      extraParamsOverride?: Record<string, unknown>;
    }) => ({
      ...actual.resolveExtraParams({
        cfg: params.cfg as Parameters<typeof actual.resolveExtraParams>[0]["cfg"],
        provider: params.provider,
        modelId: params.modelId,
        agentId: params.agentId,
      }),
      ...(params.extraParamsOverride
        ? Object.fromEntries(
            Object.entries(params.extraParamsOverride).filter(([, value]) => value !== undefined),
          )
        : undefined),
    }),
    resolveAgentTransportOverride: () => undefined,
  };
});

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: () => undefined,
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: () => undefined,
}));

// mock-isolation: Exercise attempt workspace routing without constructing unrelated tools.
vi.mock("../../agent-tools.js", () => ({
  createOpenClawCodingToolsInternalAsync: hoisted.createOpenClawCodingToolsMock,
  resolveToolLoopDetectionConfig: () => undefined,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: async () => undefined,
  acquireSessionMcpRuntime: async () => undefined,
  materializeBundleMcpToolsForRun: async () => undefined,
  retireSessionMcpRuntime: async () => true,
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: async () => undefined,
}));

vi.mock("../../../image-generation/runtime.js", () => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: () => [],
}));

// mock-isolation: Workspace attempts pin synthetic models without loading the provider registry.
vi.mock("../../model-selection.js", () => ({
  findNormalizedProviderValue,
  normalizeProviderId: normalizeMockProviderId,
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-test" }),
}));

vi.mock("../../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: vi.fn(),
}));

vi.mock("../../custom-api-registry.js", () => ({
  ensureCustomApiRegistered: () => {},
}));

// mock-isolation: Workspace attempts do not resolve auth mode from host profiles or environment keys.
vi.mock("../../model-auth.js", () => ({
  resolveModelAuthModeAsync: () => undefined,
}));

vi.mock("../../model-tool-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-tool-support.js")>()),
  supportsModelTools: hoisted.supportsModelToolsMock,
}));

vi.mock("../../provider-stream.js", () => ({
  registerProviderStreamForModel: vi.fn(),
}));

vi.mock(
  "../../sandbox/runtime-status.js",
  () => import("./attempt-spawn-workspace.sandbox-mock.test-support.js"),
);

vi.mock("../../tool-fs-policy.js", () => ({
  resolveSessionPermissionExecMode: (policy: { mode: string }) =>
    ({ "read-only": "deny", guarded: "ask", workspace: "auto", full: "full" })[policy.mode],
  resolveEffectiveToolFsWorkspaceOnly: () => false,
}));

vi.mock("../cache-ttl.js", () => ({
  appendCacheTtlTimestamp: (
    sessionManager: { appendCustomEntryAsync?: (customType: string, data: unknown) => void },
    data: unknown,
  ) => sessionManager.appendCustomEntryAsync?.("openclaw.cache-ttl", data),
  isCacheTtlEligibleProvider: (provider?: string) => provider === "anthropic",
  readLastCacheTtlTimestamp: (...args: Parameters<typeof readMockSessionCacheTtlTimestamp>) =>
    readMockSessionCacheTtlTimestamp(...args),
}));

vi.mock("../compaction-runtime-context.js", () => ({
  buildEmbeddedCompactionRuntimeContext: () => ({}),
}));

vi.mock("./preemptive-compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preemptive-compaction.js")>();
  return {
    ...actual,
    shouldPreemptivelyCompactBeforePrompt: (
      params: Parameters<typeof actual.shouldPreemptivelyCompactBeforePrompt>[0],
    ) => {
      hoisted.preemptiveCompactionCalls.push(params);
      return actual.shouldPreemptivelyCompactBeforePrompt(params);
    },
  };
});

vi.mock("../compaction-safety-timeout.js", () => ({
  resolveCompactionTimeoutMs: () => undefined,
}));

// mock-isolation: Supply explicit history limits independently of runtime configuration.
vi.mock("../history.js", () => ({
  getHistoryLimitFromSessionKey: hoisted.getHistoryLimitFromSessionKeyMock,
  limitHistoryTurns: hoisted.limitHistoryTurnsMock,
}));

vi.mock("../logger.js", () => ({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    isEnabled: () => false,
  },
}));

vi.mock("../model.js", () => ({
  buildModelAliasLines: () => [],
}));

vi.mock("../sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: () => undefined,
  resolveEmbeddedSandboxInfoExecPolicy: () => ({}),
}));

vi.mock("../thinking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thinking.js")>()),
  dropReasoningFromHistory: <T>(messages: T) => messages,
  dropThinkingBlocks: <T>(messages: T) => messages,
}));

vi.mock("./compaction-retry-aggregate-timeout.js", () => ({
  hasActiveCompactionRetryWork: ({
    isCompactionInFlight,
    isSessionStreaming,
  }: {
    isCompactionInFlight: boolean;
    isSessionStreaming: boolean;
  }) => isCompactionInFlight || isSessionStreaming,
  waitForCompactionRetryWithAggregateTimeout: async () => ({
    timedOut: false,
    aborted: false,
  }),
}));

vi.mock("./compaction-timeout.js", () => ({
  resolveRunTimeoutDuringCompaction: () => "abort",
  selectCompactionTimeoutSnapshot: ({
    currentSnapshot,
    currentSessionId,
  }: {
    currentSnapshot: unknown[];
    currentSessionId: string;
  }) => ({
    messagesSnapshot: currentSnapshot,
    sessionIdUsed: currentSessionId,
    source: "current",
  }),
  shouldFlagCompactionTimeout: () => false,
}));

export type EmbeddedAttemptSession = Omit<MutableSession, "agent"> & {
  agent: MutableSession["agent"] | Agent;
};

type SessionPromptOverride = (
  session: MutableSession,
  prompt: string,
  options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void },
) => Promise<void>;

function createCompletedAssistantStream() {
  return {
    result: async () => ({ role: "assistant", content: "done" }),
    [Symbol.asyncIterator]: () => (async function* () {})(),
  };
}
const ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER = "./attempt.ts?spawn-workspace-test";

const loadRunEmbeddedAttempt = createLazyPromise(
  () =>
    (import(ATTEMPT_SPAWN_WORKSPACE_TEST_SPECIFIER) as Promise<typeof import("./attempt.js")>).then(
      (mod) => mod.runEmbeddedAttempt,
    ),
  { cacheRejections: true },
);

export async function preloadRunEmbeddedAttemptForTests(): Promise<void> {
  await loadRunEmbeddedAttempt();
}

export function resetEmbeddedAttemptHarness(
  params: {
    includeSpawnSubagent?: boolean;
    subscribeImpl?: Parameters<
      (typeof hoisted.subscribeEmbeddedAgentSessionMock)["mockImplementation"]
    >[0];
    sessionMessages?: AgentMessage[];
  } = {},
) {
  if (params.includeSpawnSubagent) {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:child",
      runId: "run-child",
    });
  }
  hoisted.createAgentSessionMock.mockReset();
  hoisted.applyExtraParamsToAgentMock.mockReset();
  hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
  hoisted.guardSessionManagerMock
    .mockReset()
    .mockImplementation((sessionManager) => sessionManager);
  hoisted.defaultResourceLoaderInitMock.mockReset();
  hoisted.resolveSandboxContextMock.mockReset();
  hoisted.ensureGlobalUndiciEnvProxyDispatcherMock.mockReset();
  hoisted.ensureGlobalUndiciDispatcherStreamTimeoutsMock.mockReset();
  hoisted.createOpenClawCodingToolsMock.mockReset().mockImplementation((...args: unknown[]) => {
    const options = args[0] as
      | {
          workspaceDir?: string;
          spawnWorkspaceDir?: string;
        }
      | undefined;
    return [
      {
        name: "sessions_spawn",
        execute: async (
          _callId: string,
          input: { task?: string },
          _session?: unknown,
          _abortSignal?: unknown,
          _ctx?: unknown,
        ) =>
          await hoisted.spawnSubagentDirectMock(
            {
              task: input.task ?? "",
            },
            {
              workspaceDir: options?.spawnWorkspaceDir ?? options?.workspaceDir,
            },
          ),
      },
    ];
  });
  hoisted.subscribeEmbeddedAgentSessionMock
    .mockReset()
    .mockImplementation(params.subscribeImpl ?? (() => createSubscriptionMock()));
  hoisted.installToolResultContextGuardMock.mockReset().mockReturnValue(() => {});
  hoisted.installContextEngineLoopHookMock.mockReset().mockReturnValue(() => {});
  hoisted.flushPendingToolResultsAfterIdleMock.mockReset().mockResolvedValue(undefined);
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
  hoisted.resolveBootstrapFilesForRunMock.mockReset().mockImplementation(async () => {
    const context = await hoisted.resolveBootstrapContextForRunMock();
    return context.bootstrapFiles;
  });
  hoisted.isWorkspaceBootstrapPendingMock.mockReset().mockResolvedValue(false);
  hoisted.resolveContextInjectionModeMock.mockReset().mockReturnValue("always");
  hoisted.hasCompletedBootstrapTurnMock.mockReset().mockResolvedValue(false);
  resetSkillMocks();
  hoisted.supportsModelToolsMock.mockReset().mockReturnValue(true);
  hoisted.getGlobalHookRunnerMock.mockReset().mockReturnValue(null);
  hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  hoisted.getHistoryLimitFromSessionKeyMock.mockReset().mockReturnValue(undefined);
  hoisted.limitHistoryTurnsMock.mockReset().mockImplementation((messages) => messages);
  hoisted.preemptiveCompactionCalls.length = 0;
  hoisted.compactionReserveTokens = 0;
  hoisted.systemPromptTexts.length = 0;
  hoisted.embeddedSystemPromptInputs.length = 0;
  hoisted.trajectoryEvents.length = 0;
  resetSessionManagerMocks(hoisted.sessionManager, params.sessionMessages);
}

export async function cleanupTempPaths(tempPaths: string[]) {
  while (tempPaths.length > 0) {
    const target = tempPaths.pop();
    if (target) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
}

export function createDefaultEmbeddedSession(params?: {
  initialMessages?: unknown[];
  prompt?: SessionPromptOverride;
}): MutableSession {
  let activeToolNames: string[] = [];
  let configuredTools: Agent["state"]["tools"] = [];
  const promptContextQueue = createTestPromptContextQueue((message) => {
    session.messages = [...session.messages, message];
  });
  let promptPreparation: Parameters<AgentSession[typeof agentSessionSetPromptPreparation]>[0];
  let promptPreparationInstalled = false;
  let pendingPrompt:
    | {
        prompt: string;
        options?: { images?: unknown[]; preflightResult?: (submitted: boolean) => void };
      }
    | undefined;
  const appendDone = () => {
    session.messages = [...session.messages, { role: "assistant", content: "done", timestamp: 2 }];
  };
  const session: MutableSession = {
    sessionId: "embedded-session",
    messages: [...(params?.initialMessages ?? [])],
    isCompacting: false,
    isStreaming: false,
    subscribe: () => () => {},
    agent: {
      convertToLlm,
      prompt: async (prompt, options) => {
        pendingPrompt = {
          prompt: String(prompt),
          options: options as Parameters<MutableSession["prompt"]>[1],
        };
        await session.agent.streamFn?.(
          testModel,
          {
            systemPrompt: session.agent.state.systemPrompt,
            messages: session.messages as Parameters<StreamFn>[1]["messages"],
            tools: session.agent.state.tools,
          },
          {},
        );
      },
      streamFn: async () => {
        if (params?.prompt && pendingPrompt) {
          const currentPrompt = pendingPrompt;
          pendingPrompt = undefined;
          currentPrompt.options?.preflightResult?.(true);
          await params.prompt(session, currentPrompt.prompt, currentPrompt.options);
        }
        return createCompletedAssistantStream();
      },
      reset: () => {
        session.messages = [];
      },
      // Production cleanup hooks subscribe for lifecycle events; the default
      // session double never emits them.
      subscribe: () => () => {},
      state: {
        systemPrompt: "",
        get tools() {
          return configuredTools.filter((tool) => activeToolNames.includes(tool.name));
        },
        set tools(tools) {
          configuredTools = [...tools];
          activeToolNames = tools.map((tool) => tool.name);
        },
        get messages() {
          return session.messages;
        },
        set messages(messages: unknown[]) {
          session.messages = [...messages];
        },
      },
    },
    getActiveToolNames: () => [...activeToolNames],
    getToolDefinition: () => undefined,
    setActiveToolsByName: (toolNames) => {
      activeToolNames = [...toolNames];
    },
    setBaseSystemPrompt: (systemPrompt) => {
      hoisted.systemPromptTexts.push(systemPrompt);
      session.agent.state.systemPrompt = systemPrompt;
    },
    prompt: async (prompt, options) => {
      promptContextQueue.flush();
      await session.agent.prompt?.(prompt, options);
      if (params?.prompt) {
        return;
      }
      appendDone();
    },
    sendCustomMessage: async (message, options) => {
      session.messages = [...session.messages, { role: "custom", timestamp: 1, ...message }];
      if (options?.deliverAs !== "nextTurn" && options?.triggerTurn) {
        appendDone();
      }
    },
    abort: async () => {},
    dispose: () => {
      promptPreparation = undefined;
    },
    steer: async () => {},
    [agentSessionQueuePromptContext]: promptContextQueue.queue,
    [agentSessionSetContextReplacementHook]: () => {},
    [agentSessionSetPromptPreparation]: (prepare) => {
      promptPreparation = prepare;
      if (promptPreparationInstalled) {
        return;
      }
      promptPreparationInstalled = true;
      // Cases can replace prompt with a real Agent bridge before runner setup.
      // Wrap the composed entrypoint so every fake model-start honors the host hook.
      const prompt = session.prompt;
      session.prompt = (...args) =>
        runPreparedTestPrompt(
          () => promptPreparation,
          () => {
            promptContextQueue.flush();
            return prompt(...args);
          },
        );
    },
  };

  return session;
}

export function createContextEngineBootstrapAndAssemble() {
  return {
    bootstrap: vi.fn(async (_params: { sessionKey?: string }) => ({ bootstrapped: true })),
    assemble: vi.fn(
      async ({ messages }: { messages: AgentMessage[]; sessionKey?: string; model?: string }) => ({
        messages,
        estimatedTokens: 1,
      }),
    ),
  };
}

const testModel = makeProviderModelFixture({
  id: "gpt-test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 8192,
});

const testAuthStorage = {
  getApiKey: async () => undefined,
};

export async function createContextEngineAttemptRunner(params: {
  contextEngine: Pick<ContextEngine, "assemble"> &
    Partial<
      Pick<ContextEngine, "bootstrap" | "afterTurn" | "ingestBatch" | "ingest" | "compact">
    > & {
      maintain?: boolean | ContextEngine["maintain"];
      info?: Partial<ContextEngineInfo>;
    };
  attemptOverrides?: Partial<Parameters<Awaited<ReturnType<typeof loadRunEmbeddedAttempt>>>[0]>;
  createSession?: () => EmbeddedAttemptSession;
  sessionMessages?: AgentMessage[];
  sessionMessagesAfterRepair?: AgentMessage[];
  sessionPrompt?: SessionPromptOverride;
  sessionKey: string;
  tempPaths: string[];
  trajectory?: boolean;
}) {
  const { maintain: rawMaintain, ...contextEngineRest } = params.contextEngine;
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-workspace-"));
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-agent-"));
  const sessionStore = path.join(workspaceDir, "sessions.json");
  params.tempPaths.push(workspaceDir, agentDir);
  const seedMessages: AgentMessage[] =
    params.sessionMessages ?? ([{ role: "user", content: "seed", timestamp: 1 }] as AgentMessage[]);
  const infoId = params.contextEngine.info?.id ?? "test-context-engine";
  const infoName = params.contextEngine.info?.name ?? "Test Context Engine";
  const infoVersion = params.contextEngine.info?.version ?? "0.0.1";
  const maintain =
    typeof rawMaintain === "function"
      ? rawMaintain
      : rawMaintain
        ? async () => ({
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "test maintenance",
          })
        : undefined;

  hoisted.sessionManager.buildSessionContext
    .mockReset()
    .mockReturnValue({ messages: params.sessionMessagesAfterRepair ?? seedMessages });

  const modelRegistry = { getApiKeyAndHeaders: async () => ({ ok: true as const }) };
  initializeModelRegistryRuntime(modelRegistry);
  const modelRuntime = getModelRegistryRuntime(modelRegistry).llmRuntime;
  hoisted.createAgentSessionMock.mockImplementation(async (options) => {
    const session =
      params.createSession?.() ??
      createDefaultEmbeddedSession({
        initialMessages: seedMessages,
        prompt: params.sessionPrompt,
      });
    session.agent.state.systemPrompt = options.systemPrompt;
    hoisted.systemPromptTexts.push(options.systemPrompt);
    session.agent.state.tools = (options.customTools ?? [])
      .filter((tool) => options.tools.includes(tool.name))
      .map((tool) => wrapToolDefinition(tool));
    session.setActiveToolsByName(session.agent.state.tools.map((tool) => tool.name));
    // Nested tool observations append through the same manager the runner prepared.
    session.sessionManager = options.sessionManager;
    const definitions = new Map((options.customTools ?? []).map((tool) => [tool.name, tool]));
    session.getToolDefinition = (name) => definitions.get(name);
    if (session.agent.streamFn) {
      bindStreamLlmRuntime(session.agent.streamFn, modelRuntime);
    }
    return { session };
  });

  return await withEnvAsync(
    {
      OPENCLAW_TRAJECTORY: params.trajectory === true ? undefined : "0",
      OPENCLAW_TRAJECTORY_DIR: params.trajectory === true ? workspaceDir : undefined,
    },
    async () => {
      const attempt: Omit<EmbeddedRunAttemptParams, "admittedRunContext"> = {
        sessionId: "embedded-session",
        sessionKey: params.sessionKey,
        sessionFile: params.sessionKey,
        sessionTarget: {
          agentId: "main",
          sessionId: "embedded-session",
          sessionKey: params.sessionKey,
          storePath: sessionStore,
        },
        workspaceDir,
        agentDir,
        config: { session: { store: sessionStore } },
        prompt: "hello",
        timeoutMs: 10_000,
        runId: "run-context-engine-forwarding",
        provider: "openai",
        modelId: "gpt-test",
        model: testModel,
        authStorage: testAuthStorage as never,
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: modelRegistry as never,
        thinkLevel: "off",
        disableTools: true,
        disableMessageTool: true,
        contextTokenBudget: 2048,
        contextEngine: {
          ...contextEngineRest,
          ingest: params.contextEngine.ingest ?? (async () => ({ ingested: true })),
          compact:
            params.contextEngine.compact ??
            (async () => ({ ok: false, compacted: false, reason: "not used in this test" })),
          ...(maintain ? { maintain } : {}),
          info: {
            ...params.contextEngine.info,
            id: infoId,
            name: infoName,
            version: infoVersion,
          },
        },
        ...params.attemptOverrides,
      };
      const admittedRunContext = params.attemptOverrides?.admittedRunContext;
      const runAttempt = async (context: NonNullable<typeof admittedRunContext>) => {
        if (attempt.replyOperation) {
          return await (
            await loadRunEmbeddedAttempt()
          )({ ...attempt, admittedRunContext: context });
        }
        return await withSessionTurn(
          {
            sessionKey: attempt.sessionKey,
            sessionId: attempt.sessionId,
            agentId: attempt.agentId,
            sessionTarget: attempt.sessionTarget,
          },
          async (replyOperation) =>
            await (
              await loadRunEmbeddedAttempt()
            )({ ...attempt, admittedRunContext: context, replyOperation }),
        );
      };
      if (admittedRunContext) {
        return await runAttempt(admittedRunContext);
      }
      const admission = prepareSystemAgentRunAdmission(
        attempt.config ?? {},
        attempt.runId,
        attempt.agentId ?? "main",
        "embedded-attempt-test",
      );
      try {
        return await runAttempt(await admission.admit("embedded"));
      } finally {
        admission.close();
      }
    },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
