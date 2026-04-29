import { beforeEach, describe, expect, it, vi } from "vitest";

const { diagnosticEvents } = vi.hoisted(() => ({
  diagnosticEvents: [] as unknown[],
}));

vi.mock("../../../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: (event: unknown) => {
    diagnosticEvents.push(event);
  },
}));

import { startRunLifecycleDiagnostics } from "./attempt-lifecycle.js";

describe("attempt-lifecycle", () => {
  beforeEach(() => {
    diagnosticEvents.length = 0;
  });

  it("emits started and one completed run diagnostic event", () => {
    const diagnostics = startRunLifecycleDiagnostics({
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "openai",
      modelId: "gpt-5.4",
      trigger: "manual",
      messageChannel: "telegram",
      messageProvider: "telegram",
    });

    diagnostics.emitCompleted("completed");
    diagnostics.emitCompleted("error", new Error("ignored"));

    expect(diagnosticEvents).toHaveLength(2);
    expect(diagnosticEvents[0]).toMatchObject({
      type: "run.started",
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "openai",
      model: "gpt-5.4",
      trigger: "manual",
      channel: "telegram",
    });
    expect(diagnosticEvents[1]).toMatchObject({
      type: "run.completed",
      runId: "run-1",
      outcome: "completed",
    });
  });

  it("includes error category on failed completion", () => {
    const diagnostics = startRunLifecycleDiagnostics({
      runId: "run-2",
      provider: "anthropic",
      modelId: "claude-opus",
      trigger: "manual",
    });

    diagnostics.emitCompleted("error", new Error("boom"));

    expect(diagnosticEvents[1]).toMatchObject({
      type: "run.completed",
      runId: "run-2",
      outcome: "error",
      errorCategory: "Error",
    });
  });

  it("emits aborted completion once", () => {
    const diagnostics = startRunLifecycleDiagnostics({
      runId: "run-3",
      provider: "openai",
      modelId: "gpt-5.4",
      trigger: "manual",
    });

    diagnostics.emitCompleted("aborted");
    diagnostics.emitCompleted("completed");

    expect(diagnosticEvents).toHaveLength(2);
    expect(diagnosticEvents[1]).toMatchObject({
      type: "run.completed",
      runId: "run-3",
      outcome: "aborted",
    });
  });
});
