import { queryObjects } from "node:v8";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { countActiveToolExecutions } from "../../embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

const mocks = vi.hoisted(() => ({ markActiveEmbeddedRunAbandoned: vi.fn() }));

vi.mock("../../embedded-agent-subscribe.handlers.tools.start.js");

vi.mock("../runs.js", () => ({
  markActiveEmbeddedRunAbandoned: mocks.markActiveEmbeddedRunAbandoned,
}));

function createAbortFixture(source = new AbortController()) {
  const state: Pick<EmbeddedAttemptExecutionState, "terminal"> = { terminal: { kind: "ok" } };
  const abort = vi.fn(async (_reason?: unknown) => {});
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort });
  const cleanupAfterEarlyAbort = vi.fn(async () => {});
  const input = {
    abortActiveSession: tracker.abortActiveSession,
    activeSession: { abortCompaction: vi.fn(), isCompacting: false },
    attempt: {
      abortSignal: source.signal,
      onAttemptTimeout: vi.fn(),
      runId: "run-test",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-test",
      sessionKey: "agent:main",
      timeoutMs: 60_000,
    },
    getQueueHandle: (): EmbeddedAgentQueueHandle | undefined => undefined,
    isProbeSession: false,
    log: { warn: vi.fn() },
    runAbortController: new AbortController(),
    state,
  };
  const controller = createEmbeddedAttemptExternalAbortController({
    ...input,
    abortSignal: source.signal,
    cleanupAfterEarlyAbort,
    runId: input.attempt.runId,
  });
  onTestFinished(controller.dispose);
  return { ...input, source, abort, tracker, cleanupAfterEarlyAbort, controller };
}

beforeEach(() => {
  vi.mocked(countActiveToolExecutions).mockReset().mockReturnValue(0);
  mocks.markActiveEmbeddedRunAbandoned.mockReset();
});

describe("embedded attempt abort", () => {
  it("releases session callbacks when disposed controllers remain reachable", () => {
    class SessionPayload {
      active = true;
    }
    const cleanupAfterEarlyAbort = async () => {};
    const createController = () => {
      const payload = new SessionPayload();
      const controller = createEmbeddedAttemptExternalAbortController({
        abortSignal: new AbortController().signal,
        cleanupAfterEarlyAbort,
        runAbortController: new AbortController(),
        runId: "retained-abort-controller",
        state: { terminal: { kind: "ok" } },
      });
      controller.setActiveSessionAbort(async () => {
        payload.active = false;
      });
      controller.setRunAbort(() => {
        payload.active = false;
      });
      controller.setCompactionState({
        isPendingOrRetrying: () => payload.active,
        isInFlight: () => payload.active,
      });
      controller.arm();
      return controller;
    };
    const active = createController();
    const completed = Array.from({ length: 20 }, () => {
      const controller = createController();
      controller.dispose();
      return controller;
    });
    expect(queryObjects(SessionPayload)).toBe(1);
    active.dispose();
    expect(queryObjects(SessionPayload)).toBe(0);
    expect(completed).toHaveLength(20);
  });

  it("preserves external cancellation through active session settlement", async () => {
    const { source, runAbortController, state, abort, tracker, controller } = createAbortFixture();
    controller.setActiveSessionAbort(tracker.abortActiveSession);
    controller.arm();
    const reason = new Error("cancelled");

    source.abort(reason);

    expect(state.terminal).toEqual({
      kind: "aborted",
      source: "external",
      failure: { source: "prompt", error: reason },
    });
    expect(runAbortController.signal.reason).toBe(reason);
    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    await tracker.buildAbortSettlePromise();
  });

  it("classifies timeout during compaction without also blaming a tool", () => {
    const { source, runAbortController, state, controller } = createAbortFixture();
    vi.mocked(countActiveToolExecutions).mockReturnValue(1);
    controller.setCompactionState({ isPendingOrRetrying: () => true, isInFlight: () => false });
    controller.arm();
    const reason = Object.assign(new Error("deadline"), { name: "TimeoutError" });

    source.abort(reason);

    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      timedOut: true,
      timedOutDuringCompaction: true,
      timedOutDuringToolExecution: false,
    });
    expect(runAbortController.signal.reason).toBe(reason);
  });

  it("hands an external timeout to the live attempt exactly once", async () => {
    const fixture = createAbortFixture();
    const { controller } = fixture;
    const abortRun = createEmbeddedAttemptRunAbort({
      ...fixture,
      getQueueHandle: () => ({}) as EmbeddedAgentQueueHandle,
      isProbeSession: true,
    });
    controller.setRunAbort(abortRun);
    controller.setCompactionState({ isPendingOrRetrying: () => false, isInFlight: () => false });
    controller.arm();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: fixture.attempt,
      runAbortSignal: fixture.runAbortController.signal,
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 1_000,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });

    onTestFinished(() => timeout.clearTimers());
    const reason = Object.assign(new Error("upstream request timed out"), {
      name: "TimeoutError",
    });
    fixture.source.abort(reason);
    await fixture.tracker.buildAbortSettlePromise();

    expect(fixture.state.terminal).toEqual({
      kind: "timeout",
      phase: "prompt",
      source: "external",
      aborted: true,
    });
    expect(fixture.attempt.onAttemptTimeout).toHaveBeenCalledOnce();
    expect(fixture.abort).toHaveBeenCalledExactlyOnceWith(reason);
    expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledOnce();
  });

  it("classifies abort after preparation cleanup", async () => {
    const source = new AbortController();
    const reason = Object.assign(new Error("cancelled during setup"), { name: "AbortError" });
    source.abort(reason);
    const { cleanupAfterEarlyAbort, state, controller } = createAbortFixture(source);

    await expect(controller.throwIfFiredAfterPrepCleanup()).rejects.toBe(reason);

    expect(cleanupAfterEarlyAbort).toHaveBeenCalledOnce();
    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      promptError: reason,
      timedOut: false,
    });
    const firstTerminal = state.terminal;
    controller.arm();
    expect(() => controller.throwIfFired()).toThrow(reason);
    expect(state.terminal).toBe(firstTerminal);
  });

  it("settles timeout state, session work, and queue ownership", async () => {
    const fixture = createAbortFixture();
    const { state, attempt, runAbortController } = fixture;
    const timeoutReason = Object.assign(new Error("attempt deadline"), { name: "TimeoutError" });
    const abortCompaction = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const queueHandle = {} as EmbeddedAgentQueueHandle;
    vi.mocked(countActiveToolExecutions).mockReturnValue(1);
    const abortRun = createEmbeddedAttemptRunAbort({
      ...fixture,
      abortActiveSession,
      activeSession: { abortCompaction, isCompacting: true },
      getQueueHandle: () => queueHandle,
    });

    abortRun(true, timeoutReason);
    await Promise.resolve();

    expect(state.terminal).toEqual({
      kind: "timeout",
      phase: "tool_execution",
      source: "runtime",
      aborted: true,
    });
    expect(attempt.onAttemptTimeout).toHaveBeenCalledWith(timeoutReason);
    expect(runAbortController.signal.reason).toBe(timeoutReason);
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(abortActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledWith({
      sessionId: "session-test",
      handle: queueHandle,
      sessionKey: "agent:main",
      sessionFile: "/tmp/session.jsonl",
      reason: "timeout",
    });
  });

  it("preserves a manual abort reason", () => {
    const abortReason = new Error("manual abort");
    const fixture = createAbortFixture();
    const abortRun = createEmbeddedAttemptRunAbort(fixture);

    abortRun(false, abortReason);

    expect(fixture.runAbortController.signal.reason).toBe(abortReason);
  });
});
