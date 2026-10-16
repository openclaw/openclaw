import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
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

import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { SessionManager } from "../../sessions/index.js";
import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];
type SettleMockInput = {
  state: {
    promptError: unknown;
    promptErrorSource: unknown;
  };
};
type FixtureOverrides = {
  activeSession?: SettledInput["prepared"]["sessionRuntime"]["agentSession"]["activeSession"];
  flushPartialAssistantText?: () => void;
  getBeforeAgentFinalizeRevisionEntryId?: () => string | undefined;
  getBeforeAgentFinalizeRevisionReason?: () => string | undefined;
  repairedRejectedProviderReplay?: boolean;
  runAbortController?: AbortController;
  sessionManager?: SettledInput["prepared"]["sessionRuntime"]["sessionManager"];
  waitForPendingEvents?: (options?: { includePartialReplies?: boolean }) => Promise<void>;
};

function createSettledStream<T extends object>(overrides: T) {
  return {
    promptError: null,
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    messagesSnapshot: [],
    sessionIdUsed: "session-1",
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: undefined,
    attemptUsage: undefined,
    lastCallUsage: undefined,
    promptCache: undefined,
    ...overrides,
  };
}

function createFixture(overrides: FixtureOverrides = {}) {
  const order: string[] = [];
  const repairedMessages = [{ role: "user", content: "repaired" }];
  const activeSession =
    overrides.activeSession ??
    ({
      agent: { state: { messages: [] } },
      sessionId: "active-session",
    } as never);
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
  const getBeforeAgentFinalizeRevisionReason =
    overrides.getBeforeAgentFinalizeRevisionReason ?? (() => "revision changed");
  const getBeforeAgentFinalizeRevisionEntryId =
    overrides.getBeforeAgentFinalizeRevisionEntryId ?? (() => undefined);
  const flushPartialAssistantText = overrides.flushPartialAssistantText ?? vi.fn();
  const unsubscribe = vi.fn();
  const subscription = {
    flushPartialAssistantText,
    unsubscribe,
    waitForPendingEvents,
  };
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const sessionRuntimeState = {
    prePromptMessageCount: 3,
    promptCache: undefined,
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
      abortable: async <T>(promise: Promise<T>) => await promise,
      cache: {},
      isProbeSession: false,
      onBlockReplyFlush: undefined,
      stream: {
        subscription,
        queueHandle,
        getBeforeAgentFinalizeRevisionReason,
        getBeforeAgentFinalizeRevisionEntryId,
      },
      timeout: {
        getRunAbortDeadlineAtMs: () => 123,
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
  mocks.settleStream.mockResolvedValue(createSettledStream({}));
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

function createRewindFixture(withDescendants = false) {
  const sessionManager = SessionManager.inMemory();
  const promptId = sessionManager.appendMessage(makeUserMessage("Original request", 1));
  const rejectedId = sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Rejected first answer" }],
    stopReason: "stop",
    timestamp: 2,
  } as never);
  if (withDescendants) {
    sessionManager.appendCustomEntry("trailing-metadata", { source: "hook" });
    sessionManager.appendCompaction("Summary including rejected answer", promptId, 100);
  }
  const originalMessages = sessionManager.buildSessionContext().messages;
  const activeSession = {
    agent: { state: { messages: originalMessages } },
    sessionId: "active-session",
  };
  const fixture = createFixture({
    activeSession: activeSession as never,
    sessionManager: sessionManager as never,
    repairedRejectedProviderReplay: false,
    getBeforeAgentFinalizeRevisionEntryId: () => rejectedId,
  });
  return { fixture, sessionManager, promptId, rejectedId, originalMessages, activeSession };
}

function createTimeoutFixture(terminalAfterDrain?: SettledInput["state"]["terminal"]) {
  const runAbortController = new AbortController();
  runAbortController.abort(new Error("run budget exceeded"));
  const fixture = createFixture({
    runAbortController,
    waitForPendingEvents: vi.fn(async () => {
      fixture.order.push("pending-event-chain");
      if (terminalAfterDrain) {
        fixture.state.terminal = terminalAfterDrain;
      } else {
        await new Promise<void>(() => {});
      }
    }),
    flushPartialAssistantText: vi.fn(() => {
      fixture.order.push("flush-partial");
    }),
  });
  fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
  return fixture;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptSettledPhase stream finalization", () => {
  it("does not settle a provider failure before partial presentation finishes", async () => {
    let resolvePartial: (() => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePartial = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "error",
      errorMessage: "provider failed after partial",
      provider: "test-provider",
      model: "test-model",
    };
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
      createSettledStream({
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

    resolvePartial?.();
    await finalize;
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("rewinds the exact rejected branch before the hidden retry can choose NO_REPLY", async () => {
    const { fixture, sessionManager, promptId, rejectedId, originalMessages, activeSession } =
      createRewindFixture(true);
    mocks.settleStream.mockImplementation(async () => {
      expect(activeSession.agent.state.messages).toBe(originalMessages);
      expect(sessionManager.getLeafId()).toBe(promptId);
      return createSettledStream({ messagesSnapshot: originalMessages });
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    const retryMessages = sessionManager.buildSessionContext().messages;
    const retryTranscript = JSON.stringify(retryMessages);
    expect(retryTranscript).not.toContain("Rejected first answer");
    expect(retryTranscript).not.toContain("Summary including rejected answer");
    const revisedText = retryTranscript.includes("Rejected first answer")
      ? "NO_REPLY"
      : "Authoritative revised answer";
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: revisedText }],
      stopReason: "stop",
      timestamp: 3,
    } as never);
    expect(revisedText).toBe("Authoritative revised answer");
    expect(JSON.stringify(sessionManager.buildSessionContext().messages)).toContain(
      "Authoritative revised answer",
    );
    expect(sessionManager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejectedId }),
        expect.objectContaining({ type: "custom", customType: "trailing-metadata" }),
        expect.objectContaining({ type: "compaction" }),
      ]),
    );
  });

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
    const settledStream = createSettledStream({
      compactionOccurredThisAttempt: true,
      messagesSnapshot: [{ role: "assistant", content: [] }],
      sessionIdUsed: "settled-session",
      promptCache: { published: true },
    });
    mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
      fixture.order.push("settle");
      expect(settleInput.state.promptError).toBe(pendingError);
      expect(settleInput.state.promptErrorSource).toBe("prompt");
      fixture.markYieldAborted();
      return settledStream;
    });
    mocks.completeAfterTurn.mockImplementation(async () => {
      expect(fixture.sessionRuntimeState.promptCache).toEqual({ published: true });
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

  it("restores the rewound in-memory branch when settlement fails", async () => {
    const { fixture, sessionManager, promptId, activeSession } = createRewindFixture();
    const settlementError = new Error("settlement failed");
    const promptError = new Error("prompt failed");
    mocks.settleStream.mockImplementation(async (settleInput: SettleMockInput) => {
      settleInput.state.promptError = promptError;
      settleInput.state.promptErrorSource = "compaction";
      throw settlementError;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(settlementError);

    expect(sessionManager.getLeafId()).toBe(promptId);
    expect(JSON.stringify(activeSession.agent.state.messages)).not.toContain(
      "Rejected first answer",
    );
    expect(mocks.settleStream).toHaveBeenCalledOnce();
    expect(mocks.completeAfterTurn).not.toHaveBeenCalled();
    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      error: promptError,
      source: "compaction",
    });
  });

  it("discards buffered partial text when an external abort supersedes the run-budget timeout during the drain", async () => {
    // A terminal replacement during the drain must revoke partial-output ownership.
    const fixture = createTimeoutFixture({ kind: "aborted", source: "external" });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "initial.jsonl",
    });

    expect(fixture.order).toEqual(["pending-event-chain"]);
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("discards buffered partial text when a provider failure is attached before the terminal-owned flush", async () => {
    // A provider failure attached during the drain must suppress partial-output salvage.
    const fixture = createTimeoutFixture({
      kind: "timeout",
      phase: "prompt",
      source: "run_budget",
      failure: { source: "prompt", error: new Error("provider stream failed") },
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "initial.jsonl",
    });

    expect(fixture.order).toEqual(["pending-event-chain"]);
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("skips the bounded drain when a provider failure is already attached before settlement", async () => {
    // The fixture's wedged event chain must never delay an already-failed terminal.
    const fixture = createTimeoutFixture();
    fixture.state.terminal = {
      kind: "timeout",
      phase: "prompt",
      source: "run_budget",
      failure: { source: "prompt", error: new Error("provider stream failed") },
    };
    mocks.settleStream.mockResolvedValue(
      createSettledStream({
        promptError: new Error("provider stream failed"),
        promptErrorSource: "prompt",
      }),
    );

    // Fail fast if the 120s bounded drain is entered by mistake.
    await expect(
      Promise.race([
        runEmbeddedAttemptSettledPhase(fixture.input),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("settlement stalled on the bounded drain")),
            5_000,
          ).unref?.();
        }),
      ]),
    ).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "initial.jsonl",
    });

    expect(
      fixture.input.preparedStreamRuntime.stream.subscription.waitForPendingEvents,
    ).not.toHaveBeenCalled();
    expect(fixture.flushPartialAssistantText).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });

  it("re-drains queued events when the run-budget timeout fires during the abort-aware join", async () => {
    // An abort-aware join can exit without draining; salvage must re-drain the queued suffix.
    const abortController = new AbortController();
    let releaseJoin!: () => void;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
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
    // Fire the timeout only after the abort-aware join starts.
    await vi.waitFor(() => {
      expect(fixture.order).toContain("pending-events");
    });
    fixture.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
    abortController.abort(new Error("run budget exceeded"));
    releaseJoin();

    await expect(settlePromise).resolves.toEqual({
      sessionIdUsed: "session-1",
      sessionFileUsed: "initial.jsonl",
    });

    // Exact order also guards against duplicate joins or re-drains.
    expect(fixture.order).toEqual(["pending-events", "pending-event-chain", "flush-partial"]);
    expect(mocks.settleStream).toHaveBeenCalledOnce();
  });
});
