import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { expect, vi } from "vitest";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "../../../context-engine/types.js";
import type { EmbeddedContextFile } from "../../pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "../../workspace.js";

const hoisted = vi.hoisted(() => {
  type BootstrapContext = {
    bootstrapFiles: WorkspaceBootstrapFile[];
    contextFiles: EmbeddedContextFile[];
  };
  const spawnSubagentDirectMock = vi.fn();
  const createAgentSessionMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const resolveSandboxContextMock = vi.fn();
  const subscribeEmbeddedPiSessionMock = vi.fn();
  const acquireSessionWriteLockMock = vi.fn();
  const resolveBootstrapContextForRunMock = vi.fn<() => Promise<BootstrapContext>>(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  }));
  const getGlobalHookRunnerMock = vi.fn<() => unknown>(() => undefined);
  const initializeGlobalHookRunnerMock = vi.fn();
  const runContextEngineMaintenanceMock = vi.fn(async (_params?: unknown) => undefined);
  const sessionManager = {
    getLeafEntry: vi.fn(() => null),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    buildSessionContext: vi.fn<() => { messages: AgentMessage[] }>(() => ({ messages: [] })),
    appendCustomEntry: vi.fn(),
  };
  return {
    spawnSubagentDirectMock,
    createAgentSessionMock,
    sessionManagerOpenMock,
    resolveSandboxContextMock,
    subscribeEmbeddedPiSessionMock,
    acquireSessionWriteLockMock,
    resolveBootstrapContextForRunMock,
    getGlobalHookRunnerMock,
    initializeGlobalHookRunnerMock,
    runContextEngineMaintenanceMock,
    sessionManager,
  };
});

export function getHoisted() {
  return hoisted;
}

vi.mock("@mariozechner/pi-coding-agent", () => {
  class AuthStorage {}
  class DefaultResourceLoader {
    async reload() {}
  }
  class ModelRegistry {}

  return {
    AuthStorage,
    createAgentSession: (...args: unknown[]) => hoisted.createAgentSessionMock(...args),
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager: {
      open: (...args: unknown[]) => hoisted.sessionManagerOpenMock(...args),
    },
  };
});

vi.mock("../../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../../sandbox.js", () => ({
  resolveSandboxContext: (...args: unknown[]) => hoisted.resolveSandboxContextMock(...args),
}));

vi.mock("../../session-tool-result-guard-wrapper.js", () => ({
  guardSessionManager: () => hoisted.sessionManager,
}));

vi.mock("../../pi-embedded-subscribe.js", () => ({
  subscribeEmbeddedPiSession: (...args: unknown[]) =>
    hoisted.subscribeEmbeddedPiSessionMock(...args),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunnerMock,
  initializeGlobalHookRunner: hoisted.initializeGlobalHookRunnerMock,
}));

vi.mock("../../../infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "test-host",
}));

vi.mock("../../../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: () => {},
  ensureGlobalUndiciStreamTimeouts: () => {},
}));

vi.mock("../../bootstrap-files.js", () => ({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
}));

vi.mock("../../skills.js", () => ({
  applySkillEnvOverrides: () => () => {},
  applySkillEnvOverridesFromSnapshot: () => () => {},
  resolveSkillsPromptForRun: () => "",
}));

vi.mock("../skills-runtime.js", () => ({
  resolveEmbeddedRunSkillEntries: () => ({
    shouldLoadSkillEntries: false,
    skillEntries: undefined,
  }),
}));

vi.mock("../context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: (params: unknown) => hoisted.runContextEngineMaintenanceMock(params),
}));

vi.mock("../../docs-path.js", () => ({
  resolveOpenClawDocsPath: async () => undefined,
}));

vi.mock("../../pi-project-settings.js", () => ({
  createPreparedEmbeddedPiSettingsManager: () => ({}),
}));

vi.mock("../../pi-settings.js", () => ({
  applyPiAutoCompactionGuard: () => {},
}));

vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: () => [],
}));

vi.mock("../google.js", () => ({
  logToolSchemasForGoogle: () => {},
  sanitizeSessionHistory: async ({ messages }: { messages: unknown[] }) => messages,
  sanitizeToolsForGoogle: ({ tools }: { tools: unknown[] }) => tools,
}));

vi.mock("../../session-file-repair.js", () => ({
  repairSessionFileIfNeeded: async () => {},
}));

vi.mock("../session-manager-cache.js", () => ({
  prewarmSessionFile: async () => {},
  trackSessionManagerAccess: () => {},
}));

vi.mock("../session-manager-init.js", () => ({
  prepareSessionManagerForRun: async () => {},
}));

vi.mock("../../session-write-lock.js", () => ({
  acquireSessionWriteLock: (...args: unknown[]) => hoisted.acquireSessionWriteLockMock(...args),
  resolveSessionLockMaxHoldFromTimeout: () => 1,
}));

vi.mock("../tool-result-context-guard.js", () => ({
  installToolResultContextGuard: () => () => {},
}));

vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: async () => {},
}));

vi.mock("../runs.js", () => ({
  setActiveEmbeddedRun: () => {},
  clearActiveEmbeddedRun: () => {},
  updateActiveEmbeddedRunSnapshot: () => {},
}));

vi.mock("./images.js", () => ({
  detectAndLoadPromptImages: async () => ({ images: [] }),
}));

vi.mock("../../system-prompt-params.js", () => ({
  buildSystemPromptParams: () => ({
    runtimeInfo: {},
    userTimezone: "UTC",
    userTime: "00:00",
    userTimeFormat: "24h",
  }),
}));

vi.mock("../../system-prompt-report.js", () => ({
  buildSystemPromptReport: () => undefined,
}));

vi.mock("../system-prompt.js", () => ({
  applySystemPromptOverrideToSession: () => {},
  buildEmbeddedSystemPrompt: () => "system prompt",
  createSystemPromptOverride: (prompt: string) => () => prompt,
}));

vi.mock("../extra-params.js", () => ({
  applyExtraParamsToAgent: () => {},
}));

vi.mock("../../openai-ws-stream.js", () => ({
  createOpenAIWebSocketStreamFn: vi.fn(),
  releaseWsSession: () => {},
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: () => undefined,
}));

vi.mock("../../cache-trace.js", () => ({
  createCacheTrace: () => undefined,
}));

vi.mock("../../pi-tools.js", () => ({
  createOpenClawCodingTools: (options?: { workspaceDir?: string; spawnWorkspaceDir?: string }) => [
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
  ],
  resolveToolLoopDetectionConfig: () => undefined,
}));

vi.mock("../../pi-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: async () => undefined,
}));

vi.mock("../../pi-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: async () => undefined,
}));

vi.mock("../../../image-generation/runtime.js", () => ({
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: () => [],
}));

vi.mock("../../model-selection.js", () => ({
  normalizeProviderId: (providerId?: string) => providerId?.trim().toLowerCase() ?? "",
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-test" }),
}));

vi.mock("../../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: vi.fn(),
}));

vi.mock("../../custom-api-registry.js", () => ({
  ensureCustomApiRegistered: () => {},
}));

vi.mock("../../model-auth.js", () => ({
  resolveModelAuthMode: () => undefined,
}));

vi.mock("../../model-tool-support.js", () => ({
  supportsModelTools: () => true,
}));

vi.mock("../../ollama-stream.js", () => ({
  createConfiguredOllamaStreamFn: vi.fn(),
}));

vi.mock("../../owner-display.js", () => ({
  resolveOwnerDisplaySetting: () => ({
    ownerDisplay: undefined,
    ownerDisplaySecret: undefined,
  }),
}));

vi.mock("../../sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    mode: "off",
    sandboxed: false,
    toolPolicy: { allow: [], deny: [], sources: { allow: { key: "" }, deny: { key: "" } } },
  }),
}));

vi.mock("../../tool-call-id.js", () => ({
  sanitizeToolCallIdsForCloudCodeAssist: <T>(messages: T) => messages,
}));

vi.mock("../../tool-fs-policy.js", () => ({
  resolveEffectiveToolFsWorkspaceOnly: () => false,
}));

vi.mock("../../tool-policy.js", () => ({
  normalizeToolName: (name: string) => name,
}));

vi.mock("../../transcript-policy.js", () => ({
  resolveTranscriptPolicy: () => ({
    allowSyntheticToolResults: false,
  }),
}));

vi.mock("../cache-ttl.js", () => ({
  appendCacheTtlTimestamp: (
    sessionManager: { appendCustomEntry?: (customType: string, data: unknown) => void },
    data: unknown,
  ) => sessionManager.appendCustomEntry?.("openclaw.cache-ttl", data),
  isCacheTtlEligibleProvider: (provider?: string) => provider === "anthropic",
}));

vi.mock("../compaction-runtime-context.js", () => ({
  buildEmbeddedCompactionRuntimeContext: () => ({}),
}));

vi.mock("../compaction-safety-timeout.js", () => ({
  resolveCompactionTimeoutMs: () => undefined,
}));

vi.mock("../history.js", () => ({
  getDmHistoryLimitFromSessionKey: () => undefined,
  limitHistoryTurns: <T>(messages: T) => messages,
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

vi.mock("../message-action-discovery-input.js", () => ({
  buildEmbeddedMessageActionDiscoveryInput: () => undefined,
}));

vi.mock("../model.js", () => ({
  buildModelAliasLines: () => [],
}));

vi.mock("../sandbox-info.js", () => ({
  buildEmbeddedSandboxInfo: () => undefined,
}));

vi.mock("../thinking.js", () => ({
  dropThinkingBlocks: <T>(messages: T) => messages,
}));

vi.mock("../tool-name-allowlist.js", () => ({
  collectAllowedToolNames: () => undefined,
}));

vi.mock("../tool-split.js", () => ({
  splitSdkTools: ({ tools }: { tools: unknown[] }) => ({
    builtInTools: [],
    customTools: tools,
  }),
}));

vi.mock("../utils.js", () => ({
  describeUnknownError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  mapThinkingLevel: () => undefined,
}));

vi.mock("./compaction-retry-aggregate-timeout.js", () => ({
  waitForCompactionRetryWithAggregateTimeout: async () => ({
    timedOut: false,
    aborted: false,
  }),
}));

vi.mock("./compaction-timeout.js", () => ({
  resolveRunTimeoutDuringCompaction: () => "abort",
  resolveRunTimeoutWithCompactionGraceMs: ({
    runTimeoutMs,
    compactionTimeoutMs,
  }: {
    runTimeoutMs: number;
    compactionTimeoutMs: number;
  }) => runTimeoutMs + compactionTimeoutMs,
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

vi.mock("./history-image-prune.js", () => ({
  pruneProcessedHistoryImages: <T>(messages: T) => messages,
}));

let runEmbeddedAttemptPromise:
  | Promise<typeof import("./attempt.js").runEmbeddedAttempt>
  | undefined;

async function loadRunEmbeddedAttempt() {
  runEmbeddedAttemptPromise ??= import("./attempt.js").then((mod) => mod.runEmbeddedAttempt);
  return await runEmbeddedAttemptPromise;
}

export type MutableSession = {
  sessionId: string;
  messages: unknown[];
  isCompacting: boolean;
  isStreaming: boolean;
  agent: {
    streamFn?: unknown;
    replaceMessages: (messages: unknown[]) => void;
  };
  prompt: (prompt: string, options?: { images?: unknown[] }) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  steer: (text: string) => Promise<void>;
};

export function createSubscriptionMock() {
  return {
    assistantTexts: [] as string[],
    toolMetas: [] as Array<{ toolName: string; meta?: string }>,
    unsubscribe: () => {},
    waitForCompactionRetry: async () => {},
    getMessagingToolSentTexts: () => [] as string[],
    getMessagingToolSentMediaUrls: () => [] as string[],
    getMessagingToolSentTargets: () => [] as unknown[],
    getSuccessfulCronAdds: () => 0,
    didSendViaMessagingTool: () => false,
    didSendDeterministicApprovalPrompt: () => false,
    getLastToolError: () => undefined,
    getUsageTotals: () => undefined,
    getCompactionCount: () => 0,
    isCompacting: () => false,
  };
}

export function resetEmbeddedAttemptHarness(
  params: {
    includeSpawnSubagent?: boolean;
    subscribeImpl?: () => ReturnType<typeof createSubscriptionMock>;
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
  hoisted.sessionManagerOpenMock.mockReset().mockReturnValue(hoisted.sessionManager);
  hoisted.resolveSandboxContextMock.mockReset();
  hoisted.acquireSessionWriteLockMock.mockReset().mockResolvedValue({
    release: async () => {},
  });
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
  hoisted.getGlobalHookRunnerMock.mockReset().mockReturnValue(undefined);
  hoisted.runContextEngineMaintenanceMock.mockReset().mockResolvedValue(undefined);
  hoisted.sessionManager.getLeafEntry.mockReset().mockReturnValue(null);
  hoisted.sessionManager.branch.mockReset();
  hoisted.sessionManager.resetLeaf.mockReset();
  hoisted.sessionManager.buildSessionContext
    .mockReset()
    .mockReturnValue({ messages: params.sessionMessages ?? [] });
  hoisted.sessionManager.appendCustomEntry.mockReset();
  if (params.subscribeImpl) {
    hoisted.subscribeEmbeddedPiSessionMock.mockReset().mockImplementation(params.subscribeImpl);
  }
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
  prompt?: (
    session: MutableSession,
    prompt: string,
    options?: { images?: unknown[] },
  ) => Promise<void>;
}): MutableSession {
  const session: MutableSession = {
    sessionId: "embedded-session",
    messages: [],
    isCompacting: false,
    isStreaming: false,
    agent: {
      replaceMessages: (messages: unknown[]) => {
        session.messages = [...messages];
      },
    },
    prompt: async (prompt, options) => {
      if (params?.prompt) {
        await params.prompt(session, prompt, options);
        return;
      }
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 },
      ];
    },
    abort: async () => {},
    dispose: () => {},
    steer: async () => {},
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

export function expectCalledWithSessionKey(mock: ReturnType<typeof vi.fn>, sessionKey: string) {
  expect(mock).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey,
    }),
  );
}

export const testModel = {
  api: "openai-completions",
  provider: "openai",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

export const cacheTtlEligibleModel = {
  api: "anthropic",
  provider: "anthropic",
  compat: {},
  contextWindow: 8192,
  input: ["text"],
} as unknown as Model<Api>;

export async function createContextEngineAttemptRunner(params: {
  contextEngine: {
    bootstrap?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
    }) => Promise<BootstrapResult>;
    maintain?:
      | boolean
      | ((params: {
          sessionId: string;
          sessionKey?: string;
          sessionFile: string;
          runtimeContext?: Record<string, unknown>;
        }) => Promise<{
          changed: boolean;
          bytesFreed: number;
          rewrittenEntries: number;
          reason?: string;
        }>);
    assemble: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
      tokenBudget?: number;
      model?: string;
    }) => Promise<AssembleResult>;
    afterTurn?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: AgentMessage[];
      prePromptMessageCount: number;
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    }) => Promise<void>;
    ingestBatch?: (params: {
      sessionId: string;
      sessionKey?: string;
      messages: AgentMessage[];
    }) => Promise<IngestBatchResult>;
    ingest?: (params: {
      sessionId: string;
      sessionKey?: string;
      message: AgentMessage;
    }) => Promise<IngestResult>;
    compact?: (params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      tokenBudget?: number;
    }) => Promise<CompactResult>;
    info?: Partial<ContextEngineInfo>;
  };
  sessionKey: string;
  tempPaths: string[];
}) {
  const { maintain: rawMaintain, ...contextEngineRest } = params.contextEngine;
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-workspace-"));
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ctx-engine-agent-"));
  const sessionFile = path.join(workspaceDir, "session.jsonl");
  params.tempPaths.push(workspaceDir, agentDir);
  await fs.writeFile(sessionFile, "", "utf8");
  const seedMessages: AgentMessage[] = [
    { role: "user", content: "seed", timestamp: 1 } as AgentMessage,
  ];
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
    .mockReturnValue({ messages: seedMessages });

  hoisted.createAgentSessionMock.mockImplementation(async () => ({
    session: createDefaultEmbeddedSession(),
  }));

  const runEmbeddedAttempt = await loadRunEmbeddedAttempt();
  return await runEmbeddedAttempt({
    sessionId: "embedded-session",
    sessionKey: params.sessionKey,
    sessionFile,
    workspaceDir,
    agentDir,
    config: {},
    prompt: "hello",
    timeoutMs: 10_000,
    runId: "run-context-engine-forwarding",
    provider: "openai",
    modelId: "gpt-test",
    model: testModel,
    authStorage: {} as never,
    modelRegistry: {} as never,
    thinkLevel: "off",
    senderIsOwner: true,
    disableMessageTool: true,
    contextTokenBudget: 2048,
    contextEngine: {
      ...contextEngineRest,
      ingest:
        params.contextEngine.ingest ??
        (async () => ({
          ingested: true,
        })),
      compact:
        params.contextEngine.compact ??
        (async () => ({
          ok: false,
          compacted: false,
          reason: "not used in this test",
        })),
      ...(maintain ? { maintain } : {}),
      info: {
        id: infoId,
        name: infoName,
        version: infoVersion,
      },
    },
  });
}
