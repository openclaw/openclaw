import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createAttemptNestedToolActivityState } from "./attempt-nested-tool-activity.js";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeAfterTurn: vi.fn(),
  completeResult: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  runPrompt: vi.fn(),
  settleStream: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError, warn: mocks.logWarn },
}));
// mock-isolation: Finalization fixtures observe detach without mutating the live native-run owner.
vi.mock("../runs.js", () => ({ detachActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-finalize.js", () => ({
  completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
}));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import { withinTest } from "../../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createSettledStreamResult as settledResult } from "./attempt-stream.test-helpers.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];
type SettleMockInput = {
  state: {
    promptError: unknown;
    promptErrorSource: unknown;
  };
};
type FixtureOverrides = {
  messages?: ReturnType<SessionManager["buildSessionContext"]>["messages"];
  flushPartialAssistantText?: () => void;
  getBeforeAgentFinalizeRevisionEntryId?: () => string | undefined;
  getBeforeAgentFinalizeRevisionReason?: () => string | undefined;
  repairedRejectedProviderReplay?: boolean;
  runAbortController?: AbortController;
  sessionManager?: SettledInput["prepared"]["sessionRuntime"]["sessionManager"];
  waitForPendingEvents?: (options?: { includePartialReplies?: boolean }) => Promise<void>;
};

function createFixture(overrides: FixtureOverrides = {}) {
  const order: string[] = [];
  const repairedMessages = [{ role: "user", content: "repaired" }];
  const activeSession = {
    agent: { state: { messages: overrides.messages ?? [] } },
    getActiveToolNames: vi.fn(() => ["read"]),
    sessionId: "active-session",
  };
  const sessionManager =
    overrides.sessionManager ??
    ({
      appendLeafControlAsync: vi.fn(async () => undefined),
      buildSessionContext: () => ({ messages: repairedMessages }),
      getEntry: vi.fn(),
    } as never);
  const waitForPendingEvents =
    overrides.waitForPendingEvents ??
    vi.fn(async (options?: { includePartialReplies?: boolean }) => {
      order.push(
        options?.includePartialReplies === false ? "pending-event-chain" : "pending-events",
      );
    });
  const flushPartialAssistantText = overrides.flushPartialAssistantText ?? vi.fn();
  const subscription = {
    flushPartialAssistantText,
    isCompacting: vi.fn(() => false),
    unsubscribe: vi.fn(),
    waitForPendingEvents,
  };
  const sessionRuntimeState = {
    prePromptMessageCount: 3,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state: SettledInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  let markYieldAborted: (() => void) | undefined;
  const input = {
    attempt: {
      runId: "run-1",
      sessionFile: "initial.jsonl",
      sessionId: "session-1",
    },
    activeContextEngine: { info: { id: "engine" } },
    runAbortController: overrides.runAbortController ?? new AbortController(),
    prepared: {
      sessionRuntime: {
        agentSession: { activeSession },
        sessionManager,
        state: sessionRuntimeState,
        toolResultPromptProjectionState: {},
        transport: { effectivePromptCacheRetention: undefined },
      },
      toolBase: { nestedToolActivityState: createAttemptNestedToolActivityState() },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation) => await operation()),
    },
    state,
    getRepairedRejectedProviderReplay: () => overrides.repairedRejectedProviderReplay ?? true,
    preparedStreamRuntime: {
      cache: {},
      isProbeSession: false,
      onBlockReplyFlush: undefined,
      stream: {
        subscription,
        queueHandle: { kind: "embedded", runId: "run-1" },
        stopAcceptingSteerMessages: vi.fn(),
        getBeforeAgentFinalizeRevisionReason:
          overrides.getBeforeAgentFinalizeRevisionReason ?? (() => "revision changed"),
        getBeforeAgentFinalizeRevisionEntryId:
          overrides.getBeforeAgentFinalizeRevisionEntryId ?? (() => undefined),
      },
      timeout: {
        getRunAbortDeadlineAtMs: () => 123,
        onRunAbortDeadlineChanged: () => () => {},
        clearTimers: vi.fn(),
      },
    },
  } as unknown as SettledInput;

  mocks.runPrompt.mockImplementation(async (_promptInput, promptState) => {
    markYieldAborted = () => {
      promptState.yieldAborted = true;
    };
    return { promptStartedAt: 100 };
  });
  mocks.settleStream.mockResolvedValue(settledResult());
  mocks.completeAfterTurn.mockResolvedValue(undefined);
  mocks.completeResult.mockImplementation(
    (
      _input,
      _settled,
      prompt: Parameters<typeof import("./attempt-result.js").completeEmbeddedAttemptResult>[2],
    ) => ({ sessionIdUsed: prompt.sessionIdUsed, sessionFileUsed: prompt.sessionFileUsed }),
  );
  mocks.clearActiveEmbeddedRun.mockReturnValue(undefined);

  return {
    activeSession,
    flushPartialAssistantText,
    input,
    markYieldAborted: () => markYieldAborted?.(),
    order,
    repairedMessages,
    sessionRuntimeState,
    state,
  };
}

beforeEach(() => vi.clearAllMocks());

const runBudgetTimeout = { kind: "timeout", phase: "prompt", source: "run_budget" } as const;
const providerFailure = { source: "prompt", error: new Error("provider stream failed") } as const;
const completedAttempt = { sessionIdUsed: "session-1", sessionFileUsed: "initial.jsonl" };

function createTimeoutFixture(waitForPendingEvents: FixtureOverrides["waitForPendingEvents"]) {
  const runAbortController = new AbortController();
  runAbortController.abort(new Error("run budget exceeded"));
  const fixture = createFixture({
    runAbortController,
    waitForPendingEvents,
    flushPartialAssistantText: vi.fn(() => {
      fixture.order.push("flush-partial");
    }),
  });
  fixture.state.terminal = runBudgetTimeout;
  return fixture;
}

describe("runEmbeddedAttemptSettledPhase stream finalization", () => {
  it("does not settle a provider failure before partial presentation finishes", async () => {
    const partial = createDeferredCore();
    const onPartialReply = vi.fn(() => partial.promise);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });
    const failedAssistant = makeAgentAssistantMessage({
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "error",
      errorMessage: "provider failed after partial",
      provider: "test-provider",
      model: "test-model",
    });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
    });
    emit({ type: "message_end", message: failedAssistant });
    emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });

    const fixture = createFixture({
      waitForPendingEvents: subscription.waitForPendingEvents,
      getBeforeAgentFinalizeRevisionReason: () => undefined,
    });
    mocks.settleStream.mockResolvedValue(
      settledResult({
        promptError: new Error("provider failed after partial"),
        promptErrorSource: "prompt",
        messagesSnapshot: [failedAssistant],
        lastAssistant: failedAssistant,
        currentAttemptAssistant: failedAssistant,
        currentAttemptCompletedAssistant: failedAssistant,
      }),
    );

    const finalize = runEmbeddedAttemptSettledPhase(fixture.input);
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(mocks.settleStream).not.toHaveBeenCalled();

    partial.resolve();
    await finalize;
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rewinds rejected history through settlement (failure=%s)",
    async (fails) => {
      const sessionManager = SessionManager.inMemory();
      const promptId = expectDefined(
        await sessionManager.appendMessageAsync(makeUserMessage("Original request", 1)),
        "persisted prompt entry",
      );
      const rejectedId = await sessionManager.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Rejected first answer" }],
          timestamp: 2,
        }),
      );
      await sessionManager.appendCustomEntryAsync("trailing-metadata", { source: "hook" });
      await sessionManager.appendCompactionAsync(
        "Summary including rejected answer",
        promptId,
        100,
      );
      const originalMessages = sessionManager.buildSessionContext().messages;
      const fixture = createFixture({
        messages: originalMessages,
        sessionManager: sessionManager as never,
        repairedRejectedProviderReplay: false,
        getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
      });
      const { activeSession } = fixture;
      const settlementError = new Error("settlement failed");
      const promptError = new Error("prompt failed");
      mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
        expect(activeSession.agent.state.messages).toBe(originalMessages);
        expect(sessionManager.getLeafId()).toBe(promptId);
        if (fails) {
          settleInput.state.promptError = promptError;
          settleInput.state.promptErrorSource = "compaction";
          throw settlementError;
        }
        return settledResult({ messagesSnapshot: originalMessages });
      });
      const result = runEmbeddedAttemptSettledPhase(fixture.input);
      if (fails) {
        await expect(result).rejects.toBe(settlementError);
        expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
        expect(fixture.state.terminal).toEqual({
          kind: "failed",
          error: promptError,
          source: "compaction",
        });
      } else {
        await result;
      }
      expect(mocks.settleStream).toHaveBeenCalledOnce();
      expect(sessionManager.getLeafId()).toBe(promptId);
      const retryMessages = sessionManager.buildSessionContext().messages;
      expect(activeSession.agent.state.messages).toEqual(retryMessages);
      expect(JSON.stringify(retryMessages)).not.toMatch(
        /Rejected first answer|Summary including rejected answer/,
      );
      expect(sessionManager.getEntries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: rejectedId }),
          expect.objectContaining({ type: "custom", customType: "trailing-metadata" }),
          expect.objectContaining({ type: "compaction" }),
        ]),
      );
    },
  );

  it("settles the stream before publishing state and running after-turn work", async () => {
    const pendingError = new Error("pending event failed");
    const reason = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce("revision changed")
      .mockReturnValueOnce(undefined);
    const fixture = createFixture({
      getBeforeAgentFinalizeRevisionReason: reason,
      waitForPendingEvents: vi.fn(async () => {
        fixture.order.push("pending-events");
        fixture.state.terminal = { kind: "failed", error: pendingError, source: "prompt" };
      }),
    });
    const settledStream = settledResult({
      compactionOccurredThisAttempt: true,
      messagesSnapshot: [makeAgentAssistantMessage({ content: [] })],
      sessionIdUsed: "settled-session",
      promptCache: { retention: "short" },
    });
    mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
      fixture.order.push("settle");
      expect(settleInput.state.promptError).toBe(pendingError);
      expect(settleInput.state.promptErrorSource).toBe("prompt");
      fixture.markYieldAborted();
      return settledStream;
    });
    mocks.completeAfterTurn.mockImplementation(async () => {
      expect(fixture.sessionRuntimeState.promptCache).toEqual({ retention: "short" });
      fixture.order.push("settled-published", "after-turn");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "settled-session",
      sessionFileUsed: "initial.jsonl",
    });

    expect(fixture.activeSession.agent.state.messages).toBe(fixture.repairedMessages);
    expect(fixture.order).toEqual(["pending-events", "settle", "settled-published", "after-turn"]);
    expect(mocks.settleStream).toHaveBeenCalledWith(
      expect.objectContaining({
        getRunAbortDeadlineAtMs:
          fixture.input.preparedStreamRuntime.timeout.getRunAbortDeadlineAtMs,
        shouldFlushForContextEngine: true,
      }),
    );
    expect(mocks.completeAfterTurn).toHaveBeenCalledWith(
      fixture.input,
      settledStream,
      expect.objectContaining({
        beforeAgentFinalizeRevisionReason: "revision changed",
        yieldAborted: true,
      }),
    );
  });

  it("proceeds to settlement when pending subscription events never settle", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({
        waitForPendingEvents: vi.fn(() => new Promise<never>(() => {})),
      });

      const finalize = runEmbeddedAttemptSettledPhase(fixture.input);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(mocks.settleStream).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(finalize).resolves.toEqual({
        sessionIdUsed: "session-1",
        sessionFileUsed: "initial.jsonl",
      });
      expect(mocks.settleStream).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { kind: "aborted", source: "external" },
    { ...runBudgetTimeout, failure: providerFailure },
  ] satisfies SettledInput["state"]["terminal"][])(
    "discards buffered partial text when the drain changes terminal ownership: %j",
    async (terminal) => {
      const fixture = createTimeoutFixture(
        vi.fn(async () => {
          fixture.order.push("pending-event-chain");
          fixture.state.terminal = terminal;
        }),
      );
      await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual(
        completedAttempt,
      );
      expect(fixture.order).toEqual(["pending-event-chain"]);
      expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
      expect(mocks.settleStream).toHaveBeenCalledOnce();
    },
  );

  it("skips the bounded drain when a provider failure is already attached before settlement", async ({
    signal,
  }) => {
    // A failed terminal must bypass even a wedged serialized handler.
    const chainGate = new Promise<void>(() => {});
    const waitForPendingEvents = vi.fn(async () => {
      fixture.order.push("pending-event-chain");
      await chainGate;
    });
    const fixture = createTimeoutFixture(waitForPendingEvents);
    fixture.state.terminal = { ...runBudgetTimeout, failure: providerFailure };
    mocks.settleStream.mockResolvedValue(
      settledResult({
        promptError: new Error("provider stream failed"),
        promptErrorSource: "prompt",
      }),
    );

    await expect(
      withinTest(runEmbeddedAttemptSettledPhase(fixture.input), signal),
    ).resolves.toEqual(completedAttempt);

    expect(waitForPendingEvents).not.toHaveBeenCalled();
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("re-drains queued events when the run-budget timeout fires during the abort-aware join", async () => {
    // Timeout during the abort-aware join must re-drain before salvaging the suffix.
    const abortController = new AbortController();
    const { promise: joinGate, resolve: releaseJoin } = createDeferredCore();
    const fixture = createFixture({
      runAbortController: abortController,
      waitForPendingEvents: vi.fn(async (options) => {
        if (options?.includePartialReplies === false) {
          fixture.order.push("pending-event-chain");
          return;
        }
        fixture.order.push("pending-events");
        await joinGate;
      }),
      flushPartialAssistantText: vi.fn(() => {
        fixture.order.push("flush-partial");
      }),
    });
    fixture.state.terminal = { kind: "ok" };

    const settlePromise = runEmbeddedAttemptSettledPhase(fixture.input);
    await vi.waitFor(() => {
      expect(fixture.order).toContain("pending-events");
    });
    fixture.state.terminal = runBudgetTimeout;
    abortController.abort(new Error("run budget exceeded"));
    releaseJoin();

    await expect(settlePromise).resolves.toEqual(completedAttempt);

    expect(fixture.order).toEqual(["pending-events", "pending-event-chain", "flush-partial"]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });
});
