import { afterEach, beforeEach, expect, test } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { withExecutionPhaseDiagnostics } from "./execution-phase-diagnostics.js";

let events: DiagnosticEventPayload[];
let stop: () => void;
beforeEach(() => {
  resetDiagnosticEventsForTest();
  events = [];
  stop = onDiagnosticEvent((event) => {
    if (event.type === "model.call.started" || event.type === "run.execution_phase") {
      events.push(event);
    }
  });
});
afterEach(() => {
  stop();
  setDiagnosticsEnabledForProcess(false);
  resetDiagnosticEventsForTest();
});

test.each([true, false])("orders phases across rotation (enabled=%s)", async (enabled) => {
  setDiagnosticsEnabledForProcess(enabled);
  const identity = { runId: "run-1", sessionId: "sid-before", sessionKey: "test" };
  const forwarded: unknown[] = [];
  const params = withExecutionPhaseDiagnostics({
    ...identity,
    onExecutionPhase: (phase) => {
      forwarded.push(phase);
    },
    onSessionIdChanged: (id) => {
      forwarded.push(id);
    },
  });
  const before = { phase: "context_assembled" } as const;
  const after = { phase: "model_call_started", firstModelCallStarted: true } as const;
  emitDiagnosticEvent({
    type: "model.call.started",
    runId: identity.runId,
    callId: "run-1:model:1",
    provider: "anthropic",
    model: "claude",
  });
  params.onExecutionPhase(before);
  params.onSessionIdChanged("sid-after");
  params.onExecutionPhase(after);
  expect(events).toEqual([]);
  await waitForDiagnosticEventsDrained();
  expect(forwarded).toEqual([before, "sid-after", after]);
  expect(events).toMatchObject(
    enabled
      ? [
          { type: "model.call.started" },
          { type: "run.execution_phase", ...identity, ...before },
          { type: "run.execution_phase", ...identity, sessionId: "sid-after", ...after },
        ]
      : [],
  );
});
