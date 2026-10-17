import { expect, onTestFinished, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import type { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";

const mocks = vi.hoisted(() => ({
  abortable: vi.fn(),
  createRunAbort: vi.fn(),
  flushPendingToolResultsAfterIdle: vi.fn(),
  installStreamGuards: vi.fn(),
  prepareHistory: vi.fn(),
  prepareStream: vi.fn(),
  prepareTimeout: vi.fn(),
  runSettledPhase: vi.fn(),
}));

vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: mocks.flushPendingToolResultsAfterIdle,
}));
vi.mock("./abortable.js", () => ({ abortable: mocks.abortable }));
vi.mock("./attempt-finalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attempt-finalize.js")>();
  return { ...actual, createEmbeddedAttemptRunAbort: mocks.createRunAbort };
});
vi.mock("./attempt-history-prepare.js", () => ({
  prepareEmbeddedAttemptHistory: mocks.prepareHistory,
}));
vi.mock("./attempt-settle.js", () => ({
  runEmbeddedAttemptSettledPhase: mocks.runSettledPhase,
}));
vi.mock("./attempt-stream-prepare.js", () => ({
  prepareEmbeddedAttemptStream: mocks.prepareStream,
}));
vi.mock("./attempt-stream.js", () => ({
  installEmbeddedAttemptStreamGuards: mocks.installStreamGuards,
}));
vi.mock("./attempt-timeout-prepare.js", () => ({
  prepareEmbeddedAttemptTimeout: mocks.prepareTimeout,
}));

export { mocks };

type ExecutionInput = Parameters<typeof runEmbeddedAttemptExecutionPhase>[0];

export async function createFixture(
  options: {
    aborted?: boolean;
    exerciseTerminalMerges?: boolean;
  } = {},
) {
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "execution-phase-test");
  onTestFinished(admission.close);
  const admittedRunContext = await admission.admit("embedded");
  const order: string[] = [];
  const record = <T>(stage: string, value: T): T => {
    order.push(stage);
    return value;
  };
  const attemptAbortController = new AbortController();
  if (options.aborted) {
    attemptAbortController.abort(new Error("already aborted"));
  }
  const fixture = {
    admission,
    order,
    subscription: { isCompacting: vi.fn(() => false) },
    runAbort: vi.fn(),
    toolSearchCatalogExecutor: vi.fn(),
    timeoutResult: {},
    setContextReplacementHook: vi.fn(),
    sessionManager: {},
    abortActiveSession: vi.fn(async () => undefined),
    trackPromptSettlePromise: vi.fn((promise: Promise<void>) => promise),
    externalAbortController: {
      setRunAbort: vi.fn(() => order.push("set-run-abort")),
      setCompactionState: vi.fn(() => order.push("set-compaction-state")),
    },
    prepStages: { mark: vi.fn(() => order.push("stream-ready")) },
    emitPrepStageSummary: vi.fn(),
    setToolSearchCatalogExecutor: vi.fn(() => order.push("set-catalog")),
    replaySafeTool: { name: "read" },
    result: { messages: [] },
    state: { terminal: { kind: "ok" as const } },
    skillInstructionDeliveryCache: new Map([["skill", Promise.resolve(true)]]),
  };
  const streamResult = {
    subscription: fixture.subscription,
    queueHandle: { kind: "embedded", runId: "run-1" },
    toolSearchCatalogExecutor: fixture.toolSearchCatalogExecutor,
  };
  const activeSession = {
    [agentSessionSetContextReplacementHook]: fixture.setContextReplacementHook,
    agent: { streamFn: vi.fn() },
    dispose: vi.fn(),
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => undefined),
    sessionId: "active-session",
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      replaySafeTools: new Set([fixture.replaySafeTool]),
      trustedLocalMediaToolNames: new Set(["read"]),
    },
    contextGuards: { checkMidTurnPrecheck: vi.fn(), recordCacheTouch: vi.fn() },
    isOpenAIResponsesApi: true,
    sessionManager: fixture.sessionManager,
    settleTracker: fixture,
    state: { systemPromptText: "system prompt" },
    transcriptPolicy: { repairToolUseResultPairing: true },
    transport: { effectiveAgentTransport: "sse", providerTextTransforms: { input: [] } },
  };
  const input = {
    attempt: {
      admittedRunContext,
      abortSignal: attemptAbortController.signal,
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: 30_000,
    },
    runAbortController: new AbortController(),
    externalAbortController: fixture.externalAbortController,
    prepared: {
      sessionRuntime,
      systemPrompt: { runtimeChannel: "telegram" },
      toolBase: {
        skillInstructionDeliveryCache: fixture.skillInstructionDeliveryCache,
        nestedToolActivityState: createAttemptNestedToolActivityState(),
      },
      toolCatalog: {
        toolSearchRunPlan: {
          liveAllowedToolNames: new Set(["read"]),
          replayAllowedToolNames: new Set(["read"]),
        },
      },
    },
    sessionLock: {
      compactionTimeoutMs: 1_000,
      ownedTranscriptWriteContext: {
        withTranscriptWrite: async <T>(operation: () => T | Promise<T>) => await operation(),
      },
    },
    setup: {
      emitPrepStageSummary: fixture.emitPrepStageSummary,
      prepStages: fixture.prepStages,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {} },
    state: fixture.state,
    lifecycle: {
      readYieldState: () => ({ yieldDetected: true }),
      setToolSearchCatalogExecutor: fixture.setToolSearchCatalogExecutor,
    },
  } as unknown as ExecutionInput;

  mocks.abortable.mockImplementation((_signal, promise) => promise);
  mocks.installStreamGuards.mockImplementation(() =>
    record("guards", {
      onModelRequest: vi.fn(),
      onModelUsage: vi.fn(),
      getPromptCacheObservation: vi.fn(),
    }),
  );
  mocks.prepareHistory.mockImplementation(async () =>
    record("history", { contextEnginePromptAuthority: "assembled" }),
  );
  mocks.createRunAbort.mockImplementation(() => record("abort", fixture.runAbort));
  mocks.prepareStream.mockImplementation((streamInput) => {
    order.push("stream");
    if (options.exerciseTerminalMerges !== false) {
      const idleError = new Error("idle timeout");
      mocks.installStreamGuards.mock.calls[0]?.[1].onIdleTimeout(idleError);
      streamInput.markExternalAbort();
    }
    return streamResult;
  });
  mocks.prepareTimeout.mockImplementation((timeoutInput) => {
    order.push("timeout");
    if (options.exerciseTerminalMerges !== false) {
      timeoutInput.markTimedOutDuringCompaction();
      timeoutInput.markTimedOutByRunBudget();
    }
    return fixture.timeoutResult;
  });
  mocks.runSettledPhase.mockImplementation(async (settledInput) => {
    order.push("settled-phase");
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(false);
    mocks.installStreamGuards.mock.calls[0]?.[1].onRejectedProviderReplayRepaired();
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(true);
    return fixture.result;
  });

  return { ...fixture, activeSession, input, streamResult };
}
