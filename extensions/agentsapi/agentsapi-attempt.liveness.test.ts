import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runAgentsApiAttempt } from "./agentsapi-attempt.js";
import {
  completedTurn,
  createAttemptFixture,
  message,
  nativeFailure,
} from "./agentsapi-attempt.liveness.test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock:
    vi.fn<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    // Node's named ESM timer export does not follow Vitest's CommonJS timer replacement.
    setTimeout: <T = void>(
      delay?: number,
      value?: T,
      options?: Parameters<typeof actual.setTimeout>[2],
    ) =>
      new Promise<T | undefined>((resolve, reject) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("Fixture timer aborted", { cause: signal?.reason }));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
      }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  fetchWithSsrFGuardMock.mockReset();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

describe("Agents API ordinary attempt completion liveness", () => {
  it("commits the completed reply after a quiet stream outlives genuine native work", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    const reconciliation = vi.fn();
    fixture.saved.beforeItems = reconciliation;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconciliation).toHaveBeenCalled();
    expect(running.completed()).toBe(false);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);

    fixture.complete();
    // Cross the original prompt deadline, so the unfixed reader fails as a timeout.
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await running.result;

    expectCompletedReply(fixture, result);
    expect(fixture.onRunProgress).not.toHaveBeenCalled();
  });

  it("retries terminal and idle events whose saved input receipt arrives after the stream goes quiet", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    fixture.saved.turns = [completedTurn];
    fixture.saved.items = [message("answer-fixture", "assistant", "The completed answer.")];
    fixture.saved.session.status = "idle";

    const terminalRead = fixture.nextSessionRead();
    await fixture.stream.send({ type: "agent.session.turn.completed", turn: completedTurn });
    await terminalRead;
    const idleRead = fixture.nextSessionRead();
    await fixture.stream.send({ type: "agent.session.idle" });
    await idleRead;
    await vi.advanceTimersByTimeAsync(0);
    expect(running.completed()).toBe(false);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();

    fixture.complete();
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await running.result;

    expectCompletedReply(fixture, result);
    expect(fixture.onRunProgress.mock.calls.map(([event]) => event.reason)).toEqual([
      "agent.session.turn.completed",
      "agent.session.idle",
    ]);
  });

  it.each(["missing admitted input", "extra foreign input"] as const)(
    "keeps a quiet completed turn pending with %s until the caller aborts",
    async (condition) => {
      const fixture = await createAttempt();
      const running = await fixture.start();
      const reconciliation = vi.fn();
      fixture.saved.beforeItems = reconciliation;
      fixture.complete();
      if (condition === "missing admitted input") {
        fixture.saved.items = fixture.saved.items.filter((item) => item.role !== "user");
      } else {
        fixture.saved.items.push(message("foreign-input", "user", "Another request."));
      }

      await vi.advanceTimersByTimeAsync(2_000);
      expect(reconciliation).toHaveBeenCalled();
      expect(running.completed()).toBe(false);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);
      fixture.controller.abort(new Error("Fixture caller stopped the unsettled attempt"));
      const result = await running.result;

      expect(result.terminal).toEqual({ kind: "aborted", source: "external" });
      expect(result.assistantTexts).toEqual([]);
      expect(fixture.transcript()).toEqual([]);
      expect(fixture.inputEvents).toEqual([
        "agent.session.input.message",
        "agent.session.input.cancel",
      ]);
    },
  );

  it("preserves a genuine native failure discovered while the stream is quiet", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    fixture.saved.turns = [{ ...completedTurn, status: "failed", error: nativeFailure }];
    fixture.saved.session.status = "idle";

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await running.result;

    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { message: nativeFailure.message },
    });
    expect(result.assistantTexts).toEqual([]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
    expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);
  });

  it("keeps quiet required actions pending without executing tools before native completion", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    const reconciliation = vi.fn();
    fixture.saved.beforeItems = reconciliation;
    fixture.saved.turns = [{ ...completedTurn, status: "waiting", completed_at: null }];
    fixture.saved.session.status = "requires_action";
    fixture.saved.session.required_actions = [
      {
        type: "function_call",
        turn_id: completedTurn.id,
        call_id: "pending-function-fixture",
        name: "unavailable_fixture_tool",
        arguments: {},
      },
    ];

    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconciliation).toHaveBeenCalled();
    expect(running.completed()).toBe(false);
    expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();

    fixture.complete();
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await running.result;

    expectCompletedReply(fixture, result);
    expect(fixture.onRunProgress).not.toHaveBeenCalled();
  });

  it("dispatches a required action while a quiet saved-state read is stalled", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    const stalledRead = fixture.delayNextSessionRead();
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(stalledRead.started).toBe(true);
      fixture.saved.turns = [{ ...completedTurn, status: "waiting", completed_at: null }];
      fixture.saved.session.status = "requires_action";
      fixture.saved.session.required_actions = [
        {
          type: "function_call",
          turn_id: completedTurn.id,
          call_id: "arriving-function-fixture",
          name: "unavailable_fixture_tool",
          arguments: {},
        },
      ];

      // Awaiting the event receipt here would hang behind the stalled read on the defect.
      void fixture.stream.send({ type: "agent.session.requires_action" });
      await vi.advanceTimersByTimeAsync(0);

      const toolStarts = fixture.onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "tool" && event.data.phase === "start");
      expect(toolStarts).toMatchObject([
        {
          stream: "tool",
          data: {
            phase: "start",
            name: "unavailable_fixture_tool",
            toolCallId: "arriving-function-fixture",
            args: {},
          },
        },
      ]);
      expect(stalledRead.released).toBe(false);
      expect(running.completed()).toBe(false);
      expect(
        fixture.inputEvents.filter((type) => type === "agent.session.input.message"),
      ).toHaveLength(1);
    } finally {
      fixture.controller.abort(new Error("Fixture caller stopped after observing action dispatch"));
      stalledRead.release();
    }
    const result = await running.result;
    expect(result.terminal).toEqual({ kind: "aborted", source: "external" });
  });

  it.each([
    { resource: "turns", status: 429 },
    { resource: "items", status: 503 },
    { resource: "session", status: 503 },
  ] as const)(
    "retries a quiet $resource probe after HTTP $status without replaying native input",
    async ({ resource, status }) => {
      const fixture = await createAttempt();
      const running = await fixture.start();
      fixture.failNextRead(resource, status);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.failedReads).toEqual([{ resource, status }]);
      expect(running.completed()).toBe(false);
      expect(fixture.onPartialReply).not.toHaveBeenCalled();
      expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);

      fixture.complete();
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await running.result;

      expectCompletedReply(fixture, result);
      expect(fixture.onRunProgress).not.toHaveBeenCalled();
    },
  );

  it("surfaces HTTP 401 from a quiet session probe without replaying native input", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    fixture.failNextRead("session", 401);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await running.result;

    expect(fixture.failedReads).toEqual([{ resource: "session", status: 401 }]);
    expect(result.terminal).toMatchObject({
      kind: "failed",
      error: { status: 401, message: expect.stringContaining("Fixture session read failed (401)") },
    });
    expect(result.assistantTexts).toEqual([]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.onRunProgress).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
    expect(fixture.inputEvents).toEqual([
      "agent.session.input.message",
      "agent.session.input.cancel",
    ]);
  });

  it("requires current ownership after the quiet-stream saved-state read", async () => {
    const fixture = await createAttempt();
    const running = await fixture.start();
    fixture.complete();
    const failure = new Error("Fixture owner was revoked during reconciliation");
    fixture.saved.beforeItems = () => fixture.revoke(failure);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await running.result;

    expect(result.terminal).toMatchObject({ kind: "failed", error: failure });
    expect(result.assistantTexts).toEqual([]);
    expect(fixture.onPartialReply).not.toHaveBeenCalled();
    expect(fixture.transcript()).toEqual([]);
  });
});

function expectCompletedReply(
  fixture: Awaited<ReturnType<typeof createAttempt>>,
  result: Awaited<ReturnType<typeof runAgentsApiAttempt>>,
) {
  expect(result.terminal).toEqual({ kind: "ok" });
  expect(result.assistantTexts).toEqual(["The completed answer."]);
  expect(result.currentAttemptCompletedAssistant).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "The completed answer." }],
    stopReason: "stop",
  });
  expect(result.assistantTranscriptOwned).toBe(true);
  expect(result.assistantTranscriptIdempotencyKey).toBe("agentsapi:session-fixture:turn-fixture");
  expect(fixture.transcript()).toEqual([result.currentAttemptCompletedAssistant]);
  expect(result.messagesSnapshot).toEqual(fixture.transcript());
  expect(fixture.onPartialReply).toHaveBeenCalledExactlyOnceWith({ text: "The completed answer." });
  expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  expect(fixture.inputEvents).toEqual(["agent.session.input.message"]);
}

function createAttempt() {
  return createAttemptFixture({
    workspaceDir: tempDirs.make("agentsapi-attempt-liveness-"),
    fetch: fetchWithSsrFGuardMock,
    cleanups,
  });
}
