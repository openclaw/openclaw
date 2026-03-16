import { describe, expect, it } from "vitest";
import { PROBE_EVENT_TYPES } from "../types.js";
import { mapDiagnosticEvent } from "./diagnostic-mapper.js";

describe("mapDiagnosticEvent", () => {
  it("ignores high-frequency non-terminal diagnostics", () => {
    expect(
      mapDiagnosticEvent({
        type: "model.usage",
        ts: 1_700_000_000_000,
        seq: 1,
        sessionId: "s1",
        sessionKey: "sk1",
        provider: "openai",
        model: "gpt-4.1",
        usage: { input: 10, output: 5, total: 15 },
        costUsd: 0.002,
        durationMs: 120,
      }),
    ).toEqual([]);

    expect(
      mapDiagnosticEvent({
        type: "message.queued",
        ts: 1_700_000_000_100,
        seq: 2,
        sessionId: "s2",
        sessionKey: "sk2",
        source: "telegram",
      }),
    ).toEqual([]);
  });

  it("maps message.processed into a single terminal event", () => {
    const events = mapDiagnosticEvent({
      type: "message.processed",
      ts: 1_700_000_000_200,
      seq: 3,
      sessionId: "s3",
      sessionKey: "sk3",
      channel: "telegram",
      messageId: "m1",
      chatId: "c1",
      durationMs: 320,
      outcome: "completed",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.REALTIME_MESSAGE_PROCESSED,
      severity: "info",
      sessionId: "s3",
      payload: {
        channel: "telegram",
        messageId: "m1",
        durationMs: 320,
        outcome: "completed",
      },
    });
  });

  it("maps session.stuck severity to critical when age exceeds threshold", () => {
    const events = mapDiagnosticEvent({
      type: "session.stuck",
      ts: 1_700_000_000_300,
      seq: 4,
      sessionId: "s4",
      sessionKey: "sk4",
      state: "processing",
      ageMs: 11 * 60 * 1000,
      queueDepth: 9,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.REALTIME_SESSION_STUCK,
      severity: "critical",
      sessionId: "s4",
      payload: {
        ageMs: 11 * 60 * 1000,
        queueDepth: 9,
      },
    });
  });

  it("maps webhook.error and tool.loop as low-frequency abnormal events", () => {
    const webhookEvents = mapDiagnosticEvent({
      type: "webhook.error",
      ts: 1_700_000_000_400,
      seq: 5,
      channel: "telegram",
      chatId: "c1",
      updateType: "message",
      error: "timeout",
    });
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.REALTIME_WEBHOOK_ERROR,
      severity: "error",
    });

    const loopEvents = mapDiagnosticEvent({
      type: "tool.loop",
      ts: 1_700_000_000_500,
      seq: 6,
      sessionId: "s6",
      sessionKey: "sk6",
      toolName: "read",
      level: "warning",
      action: "warn",
      detector: "generic_repeat",
      count: 4,
      message: "repeated tool loop",
    });
    expect(loopEvents).toHaveLength(1);
    expect(loopEvents[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.REALTIME_TOOL_LOOP,
      severity: "warn",
    });
  });
});
