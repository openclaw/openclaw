import { afterEach, expect, it, vi } from "vitest";
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
import {
  classifySessionAttention,
  isRepeatedModelRequestStalled,
} from "../logging/diagnostic-session-attention.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { createModelObserver } from "./embedded-agent-runner/run/attempt.model-diagnostic-observation.js";
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
    expect(
      getDiagnosticSessionActivitySnapshot(ref, startedAt + 659_000).repeatedRequestNoProgressAgeMs,
    ).toBeDefined();

    // The issue reported successful execution 76 seconds before the false abort.
    vi.setSystemTime(startedAt + 583_000);
    await tool.execute("read-call", {});
    if (outcome === "retired-before-delivery") {
      replaceOwner();
    }
    createModelObserver({ streamContext: {}, capturePromptStats: false }).observeFinalResult(
      modelCall,
      Date.now(),
      {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "toolCall", id: "read-call", name: "read", arguments: {}, async: true }],
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    vi.setSystemTime(startedAt + 659_000);
    const snapshot = getDiagnosticSessionActivitySnapshot(ref, Date.now());
    const stalled = isRepeatedModelRequestStalled(snapshot, STUCK_SESSION_ABORT_MS);
    const attention = classifySessionAttention({
      state: "processing",
      queueDepth: 0,
      activity: snapshot,
      staleMs: STUCK_SESSION_ABORT_MS,
      stuckSessionAbortMs: STUCK_SESSION_ABORT_MS,
    });
    const completed = outcome === "completed";
    expect({ ageMissing: snapshot.repeatedRequestNoProgressAgeMs === undefined, stalled }).toEqual({
      ageMissing: completed,
      stalled: !completed,
    });
    const assertion = expect(attention);
    (completed ? assertion.not : assertion).toMatchObject({
      eventType: "session.stalled",
      reason: "repeated_model_requests_without_progress",
    });
  },
);
