import path from "node:path";
import { vi, type Mock } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import type { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];

export function createFixture(mocks: {
  runPrompt: Mock;
  settleStream: Mock;
  completeAfterTurn: Mock;
  completeResult: Mock;
  clearActiveEmbeddedRun: Mock;
}) {
  const order: string[] = [];
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const unsubscribe = vi.fn(() => order.push("unsubscribe"));
  const waitForPendingEvents = vi.fn(async () => undefined);
  const subscription = {
    assistantTexts: [],
    didSendDeterministicApprovalPrompt: vi.fn(() => false),
    didSendViaMessagingTool: vi.fn(() => false),
    getAcceptedSessionSpawns: vi.fn(() => []),
    getAssistantTurnCount: vi.fn(() => 1),
    getCompactionCount: vi.fn(() => 0),
    getCurrentAttemptAssistant: vi.fn(() => undefined),
    getHeartbeatToolResponse: vi.fn(() => undefined),
    getItemLifecycle: vi.fn(() => ({ startedCount: 0, completedCount: 0, activeCount: 0 })),
    getLastAssistantTextMessageIndex: vi.fn(() => undefined),
    getLastAssistantUsage: vi.fn(() => undefined),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
    getLastToolError: vi.fn(() => undefined),
    getLatestMcpAppChannelView: vi.fn(() => undefined),
    getLatestMcpConnectAction: vi.fn(() => undefined),
    getMessagingToolSentMediaUrls: vi.fn(() => []),
    getMessagingToolSentTargets: vi.fn(() => []),
    getMessagingToolSentTexts: vi.fn(() => []),
    getMessagingToolSourceReplyPayloads: vi.fn(() => []),
    getSourceReplyDelivered: vi.fn(() => undefined),
    getSourceReplyDeliveryState: vi.fn(() => undefined),
    getPendingToolMediaReply: vi.fn(() => undefined),
    getToolAutoDeliveryMediaUrls: vi.fn(() => []),
    getReplayState: vi.fn(() => ({ replayInvalid: false, hadPotentialSideEffects: false })),
    getSuccessfulCronAdds: vi.fn(() => []),
    getUsageTotals: vi.fn(() => ({ input: 1, output: 2, total: 3 })),
    getVisibleBlockReplyCount: vi.fn(() => 0),
    hasToolMediaBlockReply: vi.fn(() => false),
    hasSuccessfulModelResponse: vi.fn(() => false),
    isCompactionInFlight: vi.fn(() => false),
    setTerminalLifecycleMeta: vi.fn(),
    toolMetas: [{ toolName: "exec", isError: false }],
    unsubscribe,
    waitForCompactionRetry: vi.fn(async () => undefined),
    waitForPendingEvents,
  };
  const detachBackend = vi.fn(() => order.push("detach-backend"));
  const clearTimers = vi.fn(() => order.push("clear-timers"));
  const getBeforeAgentFinalizeRevisionReason = vi.fn(() => "revision");
  const getBeforeAgentFinalizeRevisionEntryId = vi.fn(() => undefined);
  const promptActiveSession = vi.fn(async () => undefined);
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 100,
    },
  ];
  const activeSession = {
    agent: { state: { messages } },
    isCompacting: false,
    isStreaming: false,
    messages,
    sessionId: "active-session",
    getActiveToolNames: vi.fn(() => ["read"]),
  };
  const sessionManager = {
    kind: "session-manager",
    appendMessage: vi.fn((message) => messages.push(message)),
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    getSessionTarget: vi.fn(() => undefined),
    getSessionId: () => "active-session",
  };
  const hookRunner = { hasHooks: vi.fn(() => false) };
  const cacheTrace = { recordStage: vi.fn() };
  const trajectoryRecorder = { recordEvent: vi.fn(), flush: vi.fn(async () => undefined) };
  const toolResultPromptProjectionState = { kind: "tool-result-projection" };
  const sessionPromptState = { toolResults: toolResultPromptProjectionState };
  const sessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 2,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state: SettledInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const result = { messages: [{ role: "assistant", content: "done" }] };
  const preparedStreamRuntime = {
    abortable: (promise: Promise<unknown>) => promise,
    cache: {},
    history: {
      contextEnginePromptAuthority: "assembled",
      contextEngineAssemblySucceeded: true,
      unwindowedContextEngineMessagesForPrecheck: [{ role: "user", content: "history" }],
    },
    isProbeSession: false,
    onBlockReplyFlush: vi.fn(),
    promptActiveSession,
    stream: {
      subscription,
      queueHandle,
      stopAcceptingSteerMessages: vi.fn(),
      getBeforeAgentFinalizeRevisionReason,
      getBeforeAgentFinalizeRevisionEntryId,
    },
    timeout: {
      getRunAbortDeadlineAtMs: vi.fn(() => 123),
      clearTimers,
    },
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: vi.fn(() => true),
      hookRunner,
      setActiveSessionSystemPrompt: vi.fn(),
      settingsManager: { getCompactionReserveTokens: vi.fn(() => 1_000) },
    },
    anthropicPayloadLogger: {},
    boundary: {
      boundaryTimezone: "UTC",
      includeBoundaryTimestamp: true,
      orphanRepair: undefined,
      setCurrentUserTimestampOverride: vi.fn(),
    },
    cacheTrace,
    contextGuards: {
      getAfterTurnCheckpoint: vi.fn(() => 2),
      takePendingMidTurnPrecheckRequest: vi.fn(() => null),
    },
    preparedUserTurnMessage: {
      role: "user",
      content: "hello",
      timestamp: 100,
      __openclaw: { senderName: "Alice" },
    },
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy: { appendOnlyRuntimeContext: true },
    transport: {
      effectiveAgentTransport: "sse",
      effectiveExtraParams: {},
      effectivePromptCacheRetention: "long",
      streamStrategy: "provider",
    },
  };
  // SAFETY: Mocked preparation phases omit unrelated runtime fields; this fixture
  // supplies settlement's exercised state, and persistence cases install a real manager.
  const input = {
    attempt: {
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      config: {},
      model: { api: "openai-responses" },
      modelId: "model",
      promptCacheKey: undefined,
      provider: "openai",
      replyOperation: { detachBackend, turnKind: "visible" },
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main",
      trigger: "user",
      workspaceDir: "/workspace",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    prepared: {
      promptToolPolicy: { apply: vi.fn(), refresh: vi.fn(), current: {} },
      bootstrap: {
        bootstrapPromptWarning: {},
        shouldRecordCompletedBootstrapTurn: false,
      },
      bundleTools: {
        tools: [{ name: "read" }],
        uncompactedEffectiveTools: [{ name: "read" }],
      },
      sessionRuntime,
      systemPrompt: {
        runtimeInfo: { model: { id: "model" } },
        systemPromptReport: { chars: 13 },
      },
      toolBase: { nestedToolActivities: [] },
      toolCatalog: {
        effectiveTools: [{ name: "read" }],
        emptyExplicitToolAllowlistError: undefined,
        toolSearch: { compacted: false },
      },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      sandbox: null,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    state,
    lifecycle: {
      readYieldState: () => ({
        yieldAbortSettled: null,
        yieldDetected: true,
        yieldMessage: "yield",
      }),
    },
    getRepairedRejectedProviderReplay: () => true,
    preparedStreamRuntime,
  } as unknown as SettledInput;

  mocks.runPrompt.mockImplementation(async (promptInput, promptState) => {
    order.push("prompt");
    Object.assign(promptState, {
      contextBudgetStatus: { status: "ok" },
      preflightRecovery: { attempted: false },
      finalPromptText: "final prompt",
    });
    promptInput.prepared.sessionRuntime.state.prePromptMessageCount = 4;
    promptInput.state.beforeAgentRunBlockedBy = "before_agent";
    return { promptStartedAt: 100, transcriptLeafId: "before-prompt" };
  });
  mocks.settleStream.mockImplementation(async () => {
    order.push("finalize");
    return {
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      sessionIdUsed: "settled-session",
      lastAssistant: { role: "assistant", content: "done" },
      currentAttemptAssistant: { role: "assistant", content: "done" },
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: { input: 1, output: 2, total: 3 },
      promptCache: { cacheRead: 1 },
      lastCallUsage: undefined,
      compactionOccurredThisAttempt: false,
    };
  });
  mocks.completeAfterTurn.mockResolvedValue(undefined);
  mocks.completeResult.mockImplementation(() => {
    order.push("result");
    return result;
  });
  mocks.clearActiveEmbeddedRun.mockImplementation(() => order.push("clear-active-run"));

  return {
    cacheTrace,
    clearTimers,
    detachBackend,
    getBeforeAgentFinalizeRevisionReason,
    input,
    order,
    queueHandle,
    result,
    sessionManager,
    sessionRuntimeState,
    state,
    subscription,
    trajectoryRecorder,
    unsubscribe,
  };
}

export async function createPersistedImageNoteFixture(
  mocks: Parameters<typeof createFixture>[0],
  testState: OpenClawTestState,
  storage: "file-backed" | "incognito" = "file-backed",
  reopen = false,
) {
  const fixture = createFixture(mocks);
  const target = {
    agentId: "main",
    sessionId: "image-note",
    sessionKey:
      storage === "incognito"
        ? "agent:main:dashboard:incognito-image-note"
        : "agent:main:image-note",
    storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
  };
  const entry = reopen
    ? loadSessionEntryReadOnly(target)
    : await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "image-note-generation",
        activeWriterRunId: fixture.input.attempt.runId,
        ...(storage === "incognito" ? { incognito: true } : {}),
      });
  if (!entry?.lifecycleRevision) {
    throw new Error("Expected a durable lifecycle revision for the admitted image-note writer");
  }
  const manager = reopen
    ? await SessionManager.openAsync(target, testState.workspaceDir)
    : SessionManager.open(target, testState.workspaceDir);
  const activeSession = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
  if (!reopen) {
    manager.appendMessage({ role: "user", content: "Describe this image", timestamp: 1 });
    for (const message of activeSession.messages) {
      if (message.role !== "assistant") {
        throw new Error("Expected the completed assistant turn in the settlement fixture");
      }
      manager.appendMessage(message);
    }
  }
  await waitForSessionTranscriptProjection(target);
  const before = await loadTranscriptEvents(target);
  const previousLeaf = manager.getLeafId();
  const previousMessages = manager.buildSessionContext().messages;
  activeSession.agent.state.messages = [...previousMessages];
  Object.defineProperty(activeSession, "messages", {
    get: () => activeSession.agent.state.messages,
  });
  fixture.input.prepared.sessionRuntime.sessionManager = manager;
  fixture.input.attempt.sessionTarget = target;
  fixture.input.attempt.sessionId = target.sessionId;
  fixture.input.attempt.sessionKey = target.sessionKey;
  fixture.input.getRepairedRejectedProviderReplay = () => false;
  fixture.input.preparedStreamRuntime.stream.getBeforeAgentFinalizeRevisionReason = () => undefined;
  fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
  const settleStream = mocks.settleStream.getMockImplementation()!;
  mocks.settleStream.mockImplementationOnce(async (...args) => ({
    ...(await settleStream(...args)),
    messagesSnapshot: [...previousMessages],
  }));
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle(fixture.input.attempt);
  fixture.input.sessionLock.withOwnedTranscriptWrite = (operation) =>
    withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...target,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: fixture.input.attempt.runId,
        },
        assertCommitAllowed: () => fixture.input.runAbortController.signal.throwIfAborted(),
        withTranscriptWrite: (write) => lifecycle.withTranscriptWrite(write),
      },
      () => lifecycle.withTranscriptWrite(operation),
    );
  return {
    fixture,
    target,
    manager,
    activeSession,
    before,
    previousLeaf,
    previousMessages,
    lifecycle,
  };
}
