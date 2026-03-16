import { describe, expect, it } from "vitest";
import { PROBE_EVENT_TYPES, type ProbeEvent } from "../types.js";
import { createTelemetryCollector } from "./collector.js";

function createCollectorHarness() {
  const emitted: ProbeEvent[] = [];

  const collector = createTelemetryCollector({
    pluginVersion: "2026.3.2",
    probeId: "probe-1",
    probeName: "probe-main",
    labels: { env: "test" },
    emit(event) {
      emitted.push(event);
    },
  });

  return { collector, emitted };
}

describe("TelemetryCollector", () => {
  it("emits audit.session.started with a normalized envelope", () => {
    const { collector, emitted } = createCollectorHarness();

    collector.recordSessionStart({
      sessionId: "s1",
      agentId: "a1",
      sessionKey: "sk1",
      resumedFrom: "s0",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      schemaVersion: "1.0",
      pluginVersion: "2026.3.2",
      probeId: "probe-1",
      probeName: "probe-main",
      labels: { env: "test" },
      eventType: PROBE_EVENT_TYPES.AUDIT_SESSION_STARTED,
      source: "session_hook",
      severity: "info",
      sessionId: "s1",
      sessionKey: "sk1",
      agentId: "a1",
      payload: {
        resumedFrom: "s0",
      },
    });
    expect(emitted[0].eventId).toBeTruthy();
    expect(new Date(emitted[0].occurredAt).toString()).not.toBe("Invalid Date");
  });

  it("emits warn severity for failed tool calls", () => {
    const { collector, emitted } = createCollectorHarness();

    collector.recordToolCallFinished({
      toolName: "exec",
      durationMs: 42,
      error: "permission denied",
      sessionKey: "sk1",
      agentId: "a1",
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.AUDIT_TOOL_CALL_FINISHED,
      severity: "warn",
      payload: {
        toolName: "exec",
        durationMs: 42,
        error: "permission denied",
      },
    });
  });

  it("emits only terminal model-response events", () => {
    const { collector, emitted } = createCollectorHarness();

    collector.recordModelResponseUsage({
      runId: "run-1",
      provider: "openai",
      model: "gpt-4.1",
      sessionId: "s1",
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.AUDIT_MODEL_RESPONSE_USAGE,
      traceId: "run-1",
      payload: {
        runId: "run-1",
        provider: "openai",
        model: "gpt-4.1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    });

    expect(emitted[1]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.REALTIME_TRACE_ACTION_SPAN,
      traceId: "run-1",
      spanId: "run-1:model.response",
      payload: {
        stage: "model.response",
        status: "completed",
      },
    });
  });

  it("normalizes mapped events and converts numeric timestamps to ISO", () => {
    const { collector, emitted } = createCollectorHarness();

    collector.recordMappedEvent({
      eventType: "custom.event",
      source: "diagnostic",
      severity: "warn",
      occurredAt: 1_700_000_000_000,
      payload: {
        key: "value",
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      eventType: "custom.event",
      source: "diagnostic",
      severity: "warn",
      payload: { key: "value" },
    });
    expect(emitted[0].occurredAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});
