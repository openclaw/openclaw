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
import { makeZeroUsageSnapshot } from "../../usage.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";
import type { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
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
  const subscription = {
    ...createSubscriptionMock(),
    // Do not supply lifecycle capabilities that this settlement fixture never had.
    answerSegments: undefined,
    runToolLifecycle: undefined,
    flushPartialAssistantText: undefined,
    isCompacting: undefined,
    getAssistantTurnCount: vi.fn(() => 1),
    getPendingToolMediaReply: vi.fn(() => undefined),
    getSuccessfulCronAdds: vi.fn(() => []),
    getUsageTotals: vi.fn(() => ({ input: 1, output: 2, total: 3 })),
    toolMetas: [{ toolName: "exec", isError: false }],
    unsubscribe,
  };
  const detachBackend = vi.fn(() => order.push("detach-backend"));
  const clearTimers = vi.fn(() => order.push("clear-timers"));
  const getBeforeAgentFinalizeRevisionReason = vi.fn(() => "revision");
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: { ...makeZeroUsageSnapshot(), input: 1, output: 2, totalTokens: 3 },
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
  };
  const sessionManager = {
    kind: "session-manager",
    appendMessageAsync: vi.fn(async (message) => messages.push(message)),
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    getSessionTarget: vi.fn(() => undefined),
    getSessionId: () => "active-session",
  };
  const trajectoryRecorder = { recordEvent: vi.fn(), flush: vi.fn(async () => undefined) };
  const toolResultPromptProjectionState = { kind: "tool-result-projection" };
  const sessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 2,
    promptCache: undefined,
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
    isProbeSession: false,
    onBlockReplyFlush: vi.fn(),
    stream: {
      subscription,
      queueHandle,
      getBeforeAgentFinalizeRevisionReason,
      getBeforeAgentFinalizeRevisionEntryId: vi.fn(),
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
      hookRunner: { hasHooks: vi.fn(() => false) },
    },
    sessionManager,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transport: { effectivePromptCacheRetention: "long" },
  };
  // SAFETY: Mocked preparation phases omit unrelated runtime fields; this fixture
  // supplies settlement's exercised state, and persistence cases install a real manager.
  const input = {
    attempt: {
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      config: {},
      model: { api: "openai-responses" },
      modelId: "model",
      provider: "openai",
      replyOperation: { detachBackend, turnKind: "visible" },
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main",
      trigger: "user",
      workspaceDir: "/workspace",
    },
    runAbortController: new AbortController(),
    prepared: {
      bootstrap: { bootstrapPromptWarning: {} },
      sessionRuntime,
      systemPrompt: { systemPromptReport: { chars: 13 } },
      toolBase: { nestedToolActivityState: createAttemptNestedToolActivityState() },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
    },
    setup: { sessionAgentId: "main" },
    diagnostics: { diagnosticTrace: {} },
    state,
    lifecycle: { readYieldState: () => ({ yieldDetected: true }) },
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
      attemptUsage: { input: 1, output: 2, total: 3 },
      promptCache: { cacheRead: 1 },
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
    clearTimers,
    detachBackend,
    input,
    order,
    queueHandle,
    result,
    sessionManager,
    sessionRuntimeState,
    state,
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
  const manager = await SessionManager.openAsync(target, testState.workspaceDir);
  const activeSession = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
  if (!reopen) {
    await manager.appendMessageAsync({
      role: "user",
      content: "Describe this image",
      timestamp: 1,
    });
    for (const message of activeSession.messages) {
      if (message.role !== "assistant") {
        throw new Error("Expected the completed assistant turn in the settlement fixture");
      }
      await manager.appendMessageAsync(message);
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
