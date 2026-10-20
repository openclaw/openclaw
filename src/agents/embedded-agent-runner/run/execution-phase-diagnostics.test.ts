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
  let events: DiagnosticEventPayload[];
  let types: string[];
  let stop: () => void;
  const makeParams = (
    overrides: Partial<Parameters<typeof withExecutionPhaseDiagnostics>[0]> = {},
  ) =>
    withExecutionPhaseDiagnostics({
      runId: "run-1",
      sessionId: "sid-1",
      sessionKey: "agent:main:mattermost:channel:town-square",
      ...overrides,
    });
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

  test("publishes run.execution_phase and forwards to the wrapped callback", async () => {
    const seen = vi.fn();
    const params = makeParams({ onExecutionPhase: seen });

    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    await waitForDiagnosticEventsDrained();
    expect(seen.mock.calls).toEqual([
      [{ phase: "model_call_started", firstModelCallStarted: true }],
    ]);
    expect(events).toMatchObject([
      {
        type: "run.execution_phase",
        runId: "run-1",
        sessionId: "sid-1",
        sessionKey: "agent:main:mattermost:channel:town-square",
        phase: "model_call_started",
        firstModelCallStarted: true,
      },
    ]);
  });

  test("delivers phases through the async lane, ordered after earlier model events", async () => {
    types.push("model.call.started");
    const params = makeParams();

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "run-1:model:1",
      provider: "anthropic",
      model: "claude",
    });
    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    // Nothing is delivered synchronously: both event kinds ride the async lane.
    expect(events).toEqual([]);
    await waitForDiagnosticEventsDrained();

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "run.execution_phase",
    ]);
  });

  test("tracks session rotation so later phases carry the current session id", async () => {
    const adopted = vi.fn();
    const params = makeParams({
      sessionId: "sid-before",
      onSessionIdChanged: adopted,
    });

    params.onExecutionPhase({ phase: "context_assembled" });
    params.onSessionIdChanged("sid-after");
    params.onExecutionPhase({ phase: "model_call_started", firstModelCallStarted: true });
    await waitForDiagnosticEventsDrained();
    expect(adopted.mock.calls).toEqual([["sid-after"]]);
    expect(events).toMatchObject([
      { phase: "context_assembled", sessionId: "sid-before" },
      { phase: "model_call_started", sessionId: "sid-after" },
    ]);
  });

  test("stays silent when process diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const seen = vi.fn();
    const params = makeParams({ onExecutionPhase: seen });

    params.onExecutionPhase({ phase: "auth" });
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([]);
    expect(seen.mock.calls).toEqual([[{ phase: "auth" }]]);
  });
});
