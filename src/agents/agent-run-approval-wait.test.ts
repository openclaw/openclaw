import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  observeAgentRunApprovalWait,
  observeAgentRunHumanWait,
} from "./agent-run-approval-wait.js";

describe("observeAgentRunApprovalWait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts overlapping approvals once, ignores foreign sessions, and supports per-call baselines", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const wait = observeAgentRunApprovalWait({ runId: "run-1", sessionId: "session-1" });
    const event = (phase: string, approvalId: string, sessionId = "session-1") =>
      emitAgentEvent({
        runId: "run-1",
        sessionId,
        stream: "lifecycle",
        data: { phase, approvalId },
      });
    try {
      event("waiting-approval", "foreign", "session-2");
      expect(wait.pending).toBe(false);
      event("waiting-approval", "first");
      vi.advanceTimersByTime(5000);
      const baseline = wait.pausedMs;
      event("waiting-approval", "second");
      vi.advanceTimersByTime(200);
      event("approval-resolved", "first");
      expect(wait.pending).toBe(true);
      vi.advanceTimersByTime(300);
      event("approval-resolved", "second");
      expect(wait.pending).toBe(false);
      expect(wait.pausedMs - baseline).toBe(500);
      vi.advanceTimersByTime(100);
      expect(wait.pausedMs - baseline).toBe(500);
    } finally {
      wait.dispose();
    }
    event("waiting-approval", "after-dispose");
    expect(wait.pending).toBe(false);
  });

  it("keeps approval/input waits closed until exact execution resumes", () => {
    const runId = "run-human-wait";
    const sessionKey = "agent:main:discord:channel:wait";
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId: "session-1" });
    const event = (input: {
      stream: string;
      data: Record<string, unknown>;
      runId?: string;
      sessionKey?: string;
      sessionId?: string;
    }) =>
      emitAgentEvent({
        runId: input.runId ?? runId,
        sessionKey: input.sessionKey ?? sessionKey,
        sessionId: input.sessionId ?? "session-1",
        stream: input.stream,
        data: input.data,
      });

    event({ stream: "lifecycle", data: { phase: "waiting-approval", approvalId: "approve-1" } });
    expect(wait.waiting).toBe(true);
    expect(wait.resumeRequired).toBe(false);
    event({ stream: "lifecycle", data: { phase: "approval-resolved", approvalId: "approve-1" } });
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(true);
    wait.markExecutionResumed();
    expect(wait.resumeRequired).toBe(false);

    event({
      stream: "execution",
      data: {
        state: "waiting",
        wait: { kind: "user_input" },
        sourceId: "ask_user",
        executionId: "question-1",
      },
    });
    expect(wait.waiting).toBe(true);
    event({
      stream: "execution",
      data: { state: "unknown", sourceId: "ask_user", executionId: "question-1" },
    });
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(true);
    event({
      runId: "another-run",
      stream: "execution",
      data: {
        state: "waiting",
        wait: { kind: "user_input" },
        sourceId: "ask_user",
        executionId: "other",
      },
    });
    expect(wait.resumeRequired).toBe(true);
    wait.markExecutionResumed();
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(false);
    wait.dispose();
  });

  it("releases unidentified execution placeholders only after confirmed resume", () => {
    const runId = "run-unidentified-wait";
    const sessionKey = "agent:main:discord:channel:unidentified-wait";
    const sessionId = "session-unidentified-wait";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    const event = (
      stream: string,
      data: Record<string, unknown>,
      overrides: { runId?: string; sessionKey?: string; sessionId?: string } = {},
    ) =>
      emitAgentEvent({
        runId: overrides.runId ?? runId,
        sessionKey: overrides.sessionKey ?? sessionKey,
        sessionId: overrides.sessionId ?? sessionId,
        stream,
        data,
      });

    // Seed the observer from the real run context with a legacy wait missing its id.
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      wait: { kind: "user_input" },
    });
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    try {
      expect(wait.waiting).toBe(true);
      event("execution", { state: "running", sourceId: "ask_user" });
      event("execution", { state: "running", sourceId: "other-source" });
      event(
        "execution",
        { state: "running", sourceId: "ask_user", executionId: "question-1" },
        { runId: "foreign-run" },
      );
      event(
        "execution",
        { state: "running", sourceId: "ask_user", executionId: "question-1" },
        { sessionId: "foreign-session" },
      );
      expect(wait.waiting).toBe(true);

      wait.markExecutionResumed();
      expect(wait.waiting).toBe(false);

      for (const data of [
        { state: "waiting", sourceId: "ask_user", wait: { kind: "user_input" } },
        { state: "waiting", sourceId: "ask_user", executionId: "", wait: { kind: "user_input" } },
        { state: "waiting", sourceId: "ask_user", id: "", wait: { kind: "user_input" } },
      ]) {
        event("execution", data);
        expect(wait.waiting).toBe(true);
        wait.markExecutionResumed();
        expect(wait.waiting).toBe(false);
      }
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("keeps identified questions and approvals when confirmed resume clears a fallback collision", () => {
    const runId = "run-fallback-collision";
    const sessionKey = "agent:main:discord:channel:fallback-collision";
    const sessionId = "session-fallback-collision";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    const event = (
      stream: string,
      data: Record<string, unknown>,
      overrides: { runId?: string; sessionKey?: string; sessionId?: string } = {},
    ) =>
      emitAgentEvent({
        runId: overrides.runId ?? runId,
        sessionKey: overrides.sessionKey ?? sessionKey,
        sessionId: overrides.sessionId ?? sessionId,
        stream,
        data,
      });
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      wait: { kind: "user_input" },
    });
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    try {
      // This strong id intentionally equals the source-id fallback key.
      event("execution", {
        state: "waiting",
        sourceId: "ask_user",
        executionId: "ask_user",
        wait: { kind: "user_input" },
      });
      event("execution", {
        state: "waiting",
        sourceId: "ask_user",
        executionId: "question-2",
        wait: { kind: "user_input" },
      });
      event("lifecycle", { phase: "waiting-approval", approvalId: "approval-1" });
      event("execution", { state: "running", sourceId: "ask_user" });
      event("execution", { state: "running", sourceId: "other-source", executionId: "question-2" });
      event("execution", {
        state: "running",
        sourceId: "ask_user",
        executionId: "different-question",
      });
      event(
        "execution",
        { state: "running", sourceId: "ask_user", executionId: "question-2" },
        { runId: "foreign-run" },
      );
      event(
        "execution",
        { state: "running", sourceId: "ask_user", executionId: "question-2" },
        { sessionId: "foreign-session" },
      );
      expect(wait.waiting).toBe(true);

      wait.markExecutionResumed();
      expect(wait.waiting).toBe(true);
      event("execution", { state: "running", sourceId: "ask_user", executionId: "ask_user" });
      expect(wait.waiting).toBe(true);
      event("execution", { state: "running", sourceId: "ask_user", executionId: "question-2" });
      expect(wait.waiting).toBe(true);
      event("lifecycle", { phase: "approval-resolved", approvalId: "approval-1" });
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(true);
      wait.markExecutionResumed();
      expect(wait.resumeRequired).toBe(false);
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("releases only the exact execution when one source has simultaneous human waits", () => {
    const runId = "run-concurrent-human-waits";
    const sessionKey = "agent:main:discord:channel:concurrent-waits";
    const sessionId = "session-concurrent-waits";
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    const event = (
      data: Record<string, unknown>,
      overrides: {
        runId?: string;
        sessionKey?: string;
        sessionId?: string;
      } = {},
    ) =>
      emitAgentEvent({
        runId: overrides.runId ?? runId,
        sessionKey: overrides.sessionKey ?? sessionKey,
        sessionId: overrides.sessionId ?? sessionId,
        stream: "execution",
        data,
      });
    const inputWait = (executionId: string) =>
      event({ state: "waiting", sourceId: "ask_user", executionId, wait: { kind: "user_input" } });
    const running = (executionId: string) =>
      event({ state: "running", sourceId: "ask_user", executionId });

    inputWait("question-1");
    inputWait("question-2");
    expect(wait.waiting).toBe(true);
    running("question-1");
    expect(wait.waiting).toBe(true);
    expect(wait.resumeRequired).toBe(false);
    running("question-2");
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(false);
    wait.dispose();
    running("late-after-dispose");
    inputWait("late-wait-after-dispose");
    expect(wait.waiting).toBe(false);
  });

  it("ignores unrelated, unidentified, foreign-run, and foreign-session resumes", () => {
    const runId = "run-human-wait-identity";
    const sessionKey = "agent:main:discord:channel:identity-wait";
    const sessionId = "session-identity-wait";
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    const event = (
      data: Record<string, unknown>,
      overrides: {
        runId?: string;
        sessionKey?: string;
        sessionId?: string;
      } = {},
    ) =>
      emitAgentEvent({
        runId: overrides.runId ?? runId,
        sessionKey: overrides.sessionKey ?? sessionKey,
        sessionId: overrides.sessionId ?? sessionId,
        stream: "execution",
        data,
      });
    event({
      state: "waiting",
      sourceId: "ask_user",
      executionId: "question-1",
      wait: { kind: "user_input" },
    });
    event({ state: "running", sourceId: "ask_user", executionId: "other-question" });
    event({ state: "running", sourceId: "ask_user" });
    event(
      { state: "running", sourceId: "ask_user", executionId: "question-1" },
      { runId: "foreign-run" },
    );
    event(
      { state: "running", sourceId: "ask_user", executionId: "question-1" },
      { sessionId: "foreign-session" },
    );
    event({ state: "running", sourceId: "other-source", executionId: "question-1" });
    expect(wait.waiting).toBe(true);
    event({ state: "running", sourceId: "ask_user", executionId: "question-1" });
    expect(wait.waiting).toBe(false);
    wait.dispose();
  });

  it("preserves approval waits when an execution resumes", () => {
    const runId = "run-human-wait-approval";
    const wait = observeAgentRunHumanWait({
      runId,
      sessionKey: "agent:main:discord:channel:approval-wait",
    });
    const event = (stream: string, data: Record<string, unknown>) =>
      emitAgentEvent({
        runId,
        sessionKey: "agent:main:discord:channel:approval-wait",
        stream,
        data,
      });
    event("lifecycle", { phase: "waiting-approval", approvalId: "approval-1" });
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      executionId: "question-1",
      wait: { kind: "user_input" },
    });
    event("execution", { state: "running", sourceId: "ask_user", executionId: "question-1" });
    expect(wait.waiting).toBe(true);
    expect(wait.resumeRequired).toBe(false);
    event("lifecycle", { phase: "approval-resolved", approvalId: "approval-1" });
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(true);
    wait.markExecutionResumed();
    expect(wait.resumeRequired).toBe(false);
    wait.dispose();
  });

  it("keeps a seeded approval wait closed until exact execution resumes", () => {
    const runId = "run-seeded-unknown-resume";
    const sessionKey = "agent:main:discord:channel:seeded-unknown-resume";
    const sessionId = "session-seeded-unknown-resume";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    const event = (
      stream: string,
      data: Record<string, unknown>,
      overrides: { runId?: string; sessionKey?: string; sessionId?: string } = {},
    ) =>
      emitAgentEvent({
        runId: overrides.runId ?? runId,
        sessionKey: overrides.sessionKey ?? sessionKey,
        sessionId: overrides.sessionId ?? sessionId,
        stream,
        data,
      });

    // Seed the observer from the real run context: no pending approval IDs, only an exact execution owner.
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      executionId: "question-unknown",
      wait: { kind: "approval" },
    });
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    const changes = vi.fn();
    wait.onChange = changes;
    try {
      expect(wait.waiting).toBe(true);
      expect(wait.resumeRequired).toBe(false);

      event("execution", {
        state: "unknown",
        sourceId: "ask_user",
        executionId: "foreign-question",
      });
      event("execution", {
        state: "unknown",
        sourceId: "other-source",
        executionId: "question-unknown",
      });
      event("execution", { state: "unknown", sourceId: "ask_user" });
      event(
        "execution",
        { state: "unknown", sourceId: "ask_user", executionId: "question-unknown" },
        { runId: "foreign-run" },
      );
      event(
        "execution",
        { state: "unknown", sourceId: "ask_user", executionId: "question-unknown" },
        { sessionId: "foreign-session" },
      );
      expect(wait.waiting).toBe(true);
      expect(wait.resumeRequired).toBe(false);
      expect(changes).not.toHaveBeenCalled();

      event("execution", {
        state: "unknown",
        sourceId: "ask_user",
        executionId: "question-unknown",
      });
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(true);
      expect(changes).toHaveBeenLastCalledWith({ waiting: false, resumeRequired: true });

      event("execution", {
        state: "running",
        sourceId: "ask_user",
        executionId: "question-unknown",
      });
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(false);
      expect(changes).toHaveBeenLastCalledWith({ waiting: false, resumeRequired: false });
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("audits wait-end transitions with waiting and resumeRequired state", () => {
    type WaitEvent = { stream: string; data: Record<string, unknown> };
    type Scenario = {
      name: string;
      seeded?: WaitEvent[];
      initial?: WaitEvent[];
      finish:
        | { kind: "event"; event: WaitEvent }
        | { kind: "confirmed-resume" }
        | { kind: "dispose"; late: WaitEvent[] };
      expected: { waiting: boolean; resumeRequired: boolean };
    };
    const executionWait = (
      state: string,
      executionId?: string,
      kind = "user_input",
    ): WaitEvent => ({
      stream: "execution",
      data: {
        state,
        sourceId: "ask_user",
        ...(executionId ? { executionId } : {}),
        ...(state === "waiting" ? { wait: { kind } } : {}),
      },
    });
    const scenarios: Scenario[] = [
      {
        name: "approval-resolved",
        initial: [
          { stream: "lifecycle", data: { phase: "waiting-approval", approvalId: "approval" } },
        ],
        finish: {
          kind: "event",
          event: {
            stream: "lifecycle",
            data: { phase: "approval-resolved", approvalId: "approval" },
          },
        },
        expected: { waiting: false, resumeRequired: true },
      },
      {
        name: "last-known-execution-unknown",
        initial: [executionWait("waiting", "known-input")],
        finish: { kind: "event", event: executionWait("unknown", "known-input") },
        expected: { waiting: false, resumeRequired: true },
      },
      {
        name: "last-seeded-unknown-wait-unknown",
        seeded: [executionWait("waiting", "seeded-approval", "approval")],
        finish: { kind: "event", event: executionWait("unknown", "seeded-approval") },
        expected: { waiting: false, resumeRequired: true },
      },
      {
        name: "unidentified-confirmed-resume",
        seeded: [executionWait("waiting")],
        finish: { kind: "confirmed-resume" },
        expected: { waiting: false, resumeRequired: false },
      },
      {
        name: "actual-running",
        initial: [executionWait("waiting", "running-input")],
        finish: { kind: "event", event: executionWait("running", "running-input") },
        expected: { waiting: false, resumeRequired: false },
      },
      {
        name: "terminal",
        initial: [
          {
            stream: "lifecycle",
            data: { phase: "waiting-approval", approvalId: "terminal-approval" },
          },
          executionWait("waiting", "terminal-input"),
        ],
        finish: { kind: "event", event: { stream: "lifecycle", data: { phase: "end" } } },
        expected: { waiting: false, resumeRequired: false },
      },
      {
        name: "terminal-error",
        seeded: [executionWait("waiting", "terminal-error-approval", "approval")],
        finish: { kind: "event", event: { stream: "lifecycle", data: { phase: "error" } } },
        expected: { waiting: false, resumeRequired: false },
      },
      {
        name: "dispose",
        initial: [executionWait("waiting", "disposed-input")],
        finish: { kind: "dispose", late: [executionWait("unknown", "disposed-input")] },
        expected: { waiting: true, resumeRequired: false },
      },
    ];

    for (const scenario of scenarios) {
      const suffix = scenario.name.replaceAll("-", "_");
      const runId = `run-transition-${suffix}`;
      const sessionKey = `agent:main:discord:channel:transition-${suffix}`;
      const sessionId = `session-transition-${suffix}`;
      registerAgentRunContext(runId, { sessionKey, sessionId });
      const emit = (event: WaitEvent) =>
        emitAgentEvent({ runId, sessionKey, sessionId, stream: event.stream, data: event.data });
      try {
        for (const event of scenario.seeded ?? []) {
          emit(event);
        }
        const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
        const snapshots: Array<{ waiting: boolean; resumeRequired: boolean }> = [];
        wait.onChange = (snapshot) => snapshots.push(snapshot);
        try {
          for (const event of scenario.initial ?? []) {
            emit(event);
          }
          if (scenario.finish.kind === "event") {
            emit(scenario.finish.event);
          } else if (scenario.finish.kind === "confirmed-resume") {
            wait.markExecutionResumed();
          } else {
            wait.dispose();
            const callbackCountAtDispose = snapshots.length;
            for (const event of scenario.finish.late) {
              emit(event);
            }
            expect(snapshots).toHaveLength(callbackCountAtDispose);
          }
          expect({ waiting: wait.waiting, resumeRequired: wait.resumeRequired }).toEqual(
            scenario.expected,
          );
          expect(snapshots.at(-1)).toEqual(scenario.expected);
        } finally {
          wait.dispose();
        }
      } finally {
        clearAgentRunContext(runId);
      }
    }
  });

  it("keeps a seeded unknown wait separate from identified execution and approval waits", () => {
    const runId = "run-seeded-unknown-mixed";
    const sessionKey = "agent:main:discord:channel:seeded-unknown-mixed";
    const sessionId = "session-seeded-unknown-mixed";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    const event = (stream: string, data: Record<string, unknown>) =>
      emitAgentEvent({ runId, sessionKey, sessionId, stream, data });
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      executionId: "seeded-approval",
      wait: { kind: "approval" },
    });
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    try {
      event("execution", {
        state: "waiting",
        sourceId: "ask_user",
        executionId: "identified-input",
        wait: { kind: "user_input" },
      });
      event("lifecycle", { phase: "waiting-approval", approvalId: "identified-approval" });
      event("execution", {
        state: "unknown",
        sourceId: "ask_user",
        executionId: "seeded-approval",
      });
      expect(wait.waiting).toBe(true);
      expect(wait.resumeRequired).toBe(false);

      event("execution", {
        state: "unknown",
        sourceId: "ask_user",
        executionId: "identified-input",
      });
      expect(wait.waiting).toBe(true);
      expect(wait.resumeRequired).toBe(false);
      event("lifecycle", { phase: "approval-resolved", approvalId: "identified-approval" });
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(true);
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("releases an unknown approval wait only for its exact execution", () => {
    const runId = "run-unknown-exact";
    const sessionKey = "agent:main:discord:channel:unknown-exact";
    const sessionId = "session-unknown-exact";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    emitAgentEvent({
      runId,
      sessionKey,
      sessionId,
      stream: "execution",
      data: {
        state: "waiting",
        sourceId: "ask_user",
        executionId: "question-unknown",
        wait: { kind: "approval" },
      },
    });
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    const running = (data: Record<string, unknown>) =>
      emitAgentEvent({ runId, sessionKey, sessionId, stream: "execution", data });
    try {
      expect(wait.waiting).toBe(true);
      running({ state: "running", sourceId: "ask_user", executionId: "foreign-execution" });
      expect(wait.waiting).toBe(true);
      running({ state: "running", sourceId: "ask_user" });
      expect(wait.waiting).toBe(true);
      running({ state: "running", sourceId: "ask_user", executionId: "question-unknown" });
      expect(wait.waiting).toBe(false);
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("keeps unidentifiable approval overflow fail-closed until confirmed resume", () => {
    const runId = "run-unknown-overflow";
    const sessionKey = "agent:main:discord:channel:unknown-overflow";
    const sessionId = "session-unknown-overflow";
    registerAgentRunContext(runId, { sessionKey, sessionId });
    for (let index = 0; index < 65; index += 1) {
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "waiting-approval", approvalId: `overflow-${index}` },
      });
    }
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    try {
      expect(wait.waiting).toBe(true);
      for (let index = 0; index < 64; index += 1) {
        emitAgentEvent({
          runId,
          sessionKey,
          sessionId,
          stream: "lifecycle",
          data: { phase: "approval-resolved", approvalId: `overflow-${index}` },
        });
      }
      expect(wait.waiting).toBe(true);
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "execution",
        data: { state: "running", sourceId: "ask_user", executionId: "unrelated" },
      });
      expect(wait.waiting).toBe(true);
      wait.markExecutionResumed();
      expect(wait.waiting).toBe(false);
      expect(wait.resumeRequired).toBe(false);
    } finally {
      wait.dispose();
      clearAgentRunContext(runId);
    }
  });

  it("clears waits on terminal and ignores late events after disposal", () => {
    const runId = "run-human-wait-terminal";
    const sessionKey = "agent:main:discord:channel:terminal-wait";
    const sessionId = "session-terminal-wait";
    const wait = observeAgentRunHumanWait({ runId, sessionKey, sessionId });
    const changed = vi.fn();
    wait.onChange = changed;
    const event = (stream: string, data: Record<string, unknown>) =>
      emitAgentEvent({ runId, sessionKey, sessionId, stream, data });
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      executionId: "question-terminal",
      wait: { kind: "user_input" },
    });
    expect(wait.waiting).toBe(true);
    event("execution", { state: "waiting", sourceId: "ask_user", wait: { kind: "user_input" } });
    expect(wait.waiting).toBe(true);
    event("lifecycle", { phase: "end" });
    expect(wait.waiting).toBe(false);
    expect(wait.resumeRequired).toBe(false);
    wait.dispose();
    const changesAtDisposal = changed.mock.calls.length;
    event("execution", {
      state: "waiting",
      sourceId: "ask_user",
      executionId: "late-question",
      wait: { kind: "user_input" },
    });
    event("execution", { state: "waiting", sourceId: "ask_user", wait: { kind: "user_input" } });
    event("lifecycle", { phase: "waiting-approval", approvalId: "late-approval" });
    expect(wait.waiting).toBe(false);
    expect(changed).toHaveBeenCalledTimes(changesAtDisposal);
  });

  it("does not report a negative pause when the wall clock rolls back", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(100);
    const wait = observeAgentRunApprovalWait({ runId: "run-1", sessionId: "session-1" });

    emitAgentEvent({
      runId: "run-1",
      sessionId: "session-1",
      stream: "lifecycle",
      data: { phase: "waiting-approval", approvalId: "approval-1" },
    });
    vi.advanceTimersByTime(25);
    vi.setSystemTime(50);
    emitAgentEvent({
      runId: "run-1",
      sessionId: "session-1",
      stream: "lifecycle",
      data: { phase: "approval-resolved", approvalId: "approval-1" },
    });

    expect(wait.pausedMs).toBe(25);
    wait.dispose();
  });
});
