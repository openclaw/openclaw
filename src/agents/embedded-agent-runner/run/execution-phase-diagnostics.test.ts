import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { withExecutionPhaseDiagnostics } from "./execution-phase-diagnostics.js";

describe("withExecutionPhaseDiagnostics", () => {
  const identity = {
    runId: "run-1",
    sessionId: "sid-1",
    sessionKey: "agent:main:mattermost:channel:town-square",
  };
  const phase = { phase: "model_call_started", firstModelCallStarted: true } as const;
  let events: DiagnosticEventPayload[];
  let types: string[];
  let stop: () => void;
  const makeParams = (
    overrides: Partial<Parameters<typeof withExecutionPhaseDiagnostics>[0]> = {},
  ) => withExecutionPhaseDiagnostics({ ...identity, ...overrides });
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(true);
    events = [];
    types = ["run.execution_phase"];
    stop = onDiagnosticEvent((event) => {
      if (types.includes(event.type)) {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    setDiagnosticsEnabledForProcess(false);
    resetDiagnosticEventsForTest();
  });

  test("forwards phases without emitting when diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const seen = vi.fn();
    makeParams({ onExecutionPhase: seen }).onExecutionPhase(phase);
    await waitForDiagnosticEventsDrained();
    expect(seen.mock.calls).toEqual([[phase]]);
    expect(events).toEqual([]);
  });

  test("delivers phases through the async lane, ordered after earlier model events", async () => {
    types.push("model.call.started");

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "run-1:model:1",
      provider: "anthropic",
      model: "claude",
    });
    const seen = vi.fn();
    makeParams({ onExecutionPhase: seen }).onExecutionPhase(phase);
    expect(events).toEqual([]);
    await waitForDiagnosticEventsDrained();

    expect(seen.mock.calls).toEqual([[phase]]);
    expect(events).toMatchObject([
      { type: "model.call.started" },
      { type: "run.execution_phase", ...identity, ...phase },
    ]);
  });

  test("tracks session rotation so later phases carry the current session id", async () => {
    const adopted = vi.fn();
    const params = makeParams({ sessionId: "sid-before", onSessionIdChanged: adopted });

    params.onExecutionPhase({ phase: "context_assembled" });
    params.onSessionIdChanged("sid-after");
    params.onExecutionPhase(phase);
    await waitForDiagnosticEventsDrained();
    expect(adopted.mock.calls).toEqual([["sid-after"]]);
    expect(events).toMatchObject([
      { phase: "context_assembled", sessionId: "sid-before" },
      { phase: "model_call_started", sessionId: "sid-after" },
    ]);
  });
});
