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
  return {
    ...actual,
    createEmbeddedAttemptRunAbort: mocks.createRunAbort,
  };
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
  const attemptAbortController = new AbortController();
  if (options.aborted) {
    attemptAbortController.abort(new Error("already aborted"));
  }
  const runAbort = vi.fn();
  const toolSearchCatalogExecutor = vi.fn();
  const subscription = {
    isCompacting: vi.fn(() => false),
  };
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const streamResult = {
    subscription,
    queueHandle,
    toolSearchCatalogExecutor,
    getBeforeAgentFinalizeRevisionReason: vi.fn(),
    stopAcceptingSteerMessages: vi.fn(),
  };
  const timeoutResult = {
    getRunAbortDeadlineAtMs: vi.fn(() => 123),
    clearTimers: vi.fn(),
  };
  const setContextReplacementHook = vi.fn();
  const activeSession = {
    [agentSessionSetContextReplacementHook]: setContextReplacementHook,
    agent: { streamFn: vi.fn() },
    dispose: vi.fn(),
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => undefined),
    sessionId: "active-session",
  };
  const sessionManager = {};
  const abortActiveSession = vi.fn(async () => undefined);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const externalAbortController = {
    setRunAbort: vi.fn(() => order.push("set-run-abort")),
    setCompactionState: vi.fn(() => order.push("set-compaction-state")),
  };
  const prepStages = { mark: vi.fn(() => order.push("stream-ready")) };
  const emitPrepStageSummary = vi.fn();
  const setToolSearchCatalogExecutor = vi.fn(() => order.push("set-catalog"));
  const replaySafeTool = { name: "read" };
  const result = { messages: [] };
  const state = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" as const },
    trajectoryEndRecorded: false,
  };
  const skillInstructionDeliveryCache = new Map([["skill", Promise.resolve(true)]]);
  const sessionRuntime = {
    agentSession: {
      activeSession,
      allCustomTools: [{ name: "custom" }],
      builtinToolNames: new Set(["read"]),
      clientToolCallSlots: [],
      hasDeliveredSourceReply: vi.fn(() => false),
      hookRunner: {},
      markSourceReplyDelivered: vi.fn(),
      replaySafeToolNames: new Set(["read"]),
      replaySafeTools: new Set([replaySafeTool]),
      trustedLocalMediaToolNames: new Set(["read"]),
      setActiveSessionSystemPrompt: vi.fn(),
      settingsManager: {},
    },
    anthropicPayloadLogger: {},
    boundary: { orphanRepair: { removeLeaf: true } },
    cacheTrace: {},
    contextGuards: { checkMidTurnPrecheck: vi.fn(), recordCacheTouch: vi.fn() },
    isOpenAIResponsesApi: true,
    sessionManager,
    settleTracker: { abortActiveSession, trackPromptSettlePromise },
    state: { systemPromptText: "system prompt" },
    transcriptPolicy: { repairToolUseResultPairing: true },
    transport: {
      effectiveAgentTransport: "sse",
      providerTextTransforms: { input: [] },
    },
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
    activeContextEngine: { info: { id: "engine" } },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    externalAbortController,
    prepared: {
      bootstrap: {},
      bundleTools: {},
      sessionRuntime,
      systemPrompt: { runtimeChannel: "telegram" },
      toolBase: {
        skillInstructionDeliveryCache,
        nestedToolActivityState: createAttemptNestedToolActivityState(),
      },
      toolCatalog: {
        toolSearchRunPlan: {
          capabilityToolNames: new Set(["read"]),
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
      withOwnedTranscriptWrite: vi.fn(),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      emitPrepStageSummary,
      prepStages,
      sandbox: null,
      sandboxSessionKey: "sandbox-1",
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
      setToolSearchCatalogExecutor,
    },
  } as unknown as ExecutionInput;

  mocks.abortable.mockImplementation((_signal, promise) => promise);
  mocks.installStreamGuards.mockImplementation(() => {
    order.push("guards");
    return {
      onModelRequest: vi.fn(),
      onModelUsage: vi.fn(),
      getPromptCacheObservation: vi.fn(),
    };
  });
  mocks.prepareHistory.mockImplementation(async () => {
    order.push("history");
    return {
      contextEnginePromptAuthority: "assembled",
      contextEngineAssemblySucceeded: true,
    };
  });
  mocks.createRunAbort.mockImplementation(() => {
    order.push("abort");
    return runAbort;
  });
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
    return timeoutResult;
  });
  mocks.runSettledPhase.mockImplementation(async (settledInput) => {
    order.push("settled-phase");
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(false);
    mocks.installStreamGuards.mock.calls[0]?.[1].onRejectedProviderReplayRepaired();
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(true);
    return result;
  });

  return {
    admission,
    abortActiveSession,
    activeSession,
    emitPrepStageSummary,
    externalAbortController,
    input,
    order,
    prepStages,
    replaySafeTool,
    result,
    runAbort,
    sessionManager,
    setContextReplacementHook,
    skillInstructionDeliveryCache,
    setToolSearchCatalogExecutor,
    state,
    streamResult,
    subscription,
    timeoutResult,
    toolSearchCatalogExecutor,
    trackPromptSettlePromise,
  };
}
