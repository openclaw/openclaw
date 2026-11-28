import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../logging/diagnostic-run-activity.js";
import { classifySessionAttention } from "../logging/diagnostic-session-attention.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { testing as controllerTesting } from "../sessions/session-controller.test-support.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createModelObserver } from "./embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
import type { AgentToolResult } from "./runtime/index.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

const STUCK_SESSION_ABORT_MS = 360_000;

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
  resetDiagnosticSessionStateForTest();
});

it.each(["completed", "error", "blocked", "retired-during-execution", "retired-before-delivery"])(
  "accounts for %s tool execution independently of a length-terminated response",
  async (outcome) => {
    const sessionId = "tool-progress";
    const ref = { sessionId, sessionKey: `agent:main:${sessionId}`, runId: "reused-run" };
    const modelCall = { ...ref, callId: "request", provider: "mock", model: "mock" };
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-10-08T20:02:20Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    const replaceOwner = () => {
      closeDiagnosticEmbeddedRunOwner(owner);
      const replacement = createDiagnosticEmbeddedRunOwner(ref);
      markDiagnosticEmbeddedRunStarted({ ...ref, owner: replacement });
    };
    // Tools are built before the diagnostic owner is registered in real attempts.
    const tool = wrapToolWithBeforeToolCallHook(
      {
        ...createStubTool("read"),
        execute: async () => {
          if (outcome === "retired-during-execution") {
            replaceOwner();
          }
          return { content: [], details: { status: outcome } };
        },
      },
      ref,
    );
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    for (const callId of ["first", "second"]) {
      emitCoreModelRequestStartedDiagnosticEvent({ ...modelCall, callId }, owner.generation);
    }
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    // The issue reported successful execution 76 seconds before the false abort.
    vi.setSystemTime(startedAt + 583_000);
    await tool.execute("read-call", {});
    if (outcome === "retired-before-delivery") {
      replaceOwner();
    }
    createModelObserver({
      streamContext: {},
      capturePromptStats: false,
      captureByteStats: false,
    }).observeFinalResult(modelCall, Date.now(), {
      role: "assistant",
      stopReason: "length",
      content: [{ type: "toolCall", id: "read-call", name: "read", arguments: {}, async: true }],
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    vi.setSystemTime(startedAt + 659_000);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref, Date.now());
    const attention = classifySessionAttention({
      state: "processing",
      queueDepth: 0,
      activity: snapshot,
      staleMs: STUCK_SESSION_ABORT_MS,
      stuckSessionAbortMs: STUCK_SESSION_ABORT_MS,
    });
    const completed = outcome === "completed";
    expect(snapshot.repeatedRequestNoProgressAgeMs === undefined).toBe(completed);
    const assertion = expect(attention);
    (completed ? assertion.not : assertion).toMatchObject({
      eventType: "session.stalled",
      reason: "repeated_model_requests_without_progress",
    });
  },
);

it.each(["completed", "nonzero-exit", "error-result", "thrown", "aborted"])(
  "restarts the session watchdog horizon only when a long tool settles without abort: %s",
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sessionId = `long-tool-${outcome}`;
    const ref = { sessionId, sessionKey: `agent:main:${sessionId}`, runId: sessionId };
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", runId: sessionId, cancel: () => {} });
    const watchdogAttempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const controller = new AbortController();
    const settle = createDeferred<AgentToolResult<unknown>>();
    const tool = wrapToolWithBeforeToolCallHook(
      { ...createStubTool("exec"), execute: async () => await settle.promise },
      { ...ref, watchdogAttempt },
    );
    try {
      const execution = tool.execute("exec-call", {}, controller.signal).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      // Past the six-minute semantic horizon, inside the open tool's quiet allowance.
      vi.setSystemTime(10 * 60_000);
      expect(operation.watchdog.snapshot().tools).toHaveLength(1);
      expect(operation.watchdog.decide().action).toBe("observe");

      const details = {
        completed: { status: "completed", exitCode: 0 },
        "nonzero-exit": { status: "failed", exitCode: 137 },
        "error-result": { status: "error", error: "killed by exec memory budget" },
      }[outcome];
      if (outcome === "aborted") {
        controller.abort(new Error("stopped"));
        settle.reject(controller.signal.reason);
      } else if (outcome === "thrown") {
        settle.reject(new Error("tool crashed"));
      } else {
        settle.resolve({ content: [], details });
      }
      await execution;

      expect(operation.watchdog.snapshot().tools).toEqual([]);
      expect(operation.watchdog.decide().action).toBe(outcome === "aborted" ? "stop" : "observe");
    } finally {
      operation.complete();
      controllerTesting.resetSessionControllerForTest();
    }
  },
);
