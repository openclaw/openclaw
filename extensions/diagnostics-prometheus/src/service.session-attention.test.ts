import { describe, expect, it } from "vitest";
import { createMetricsHarness, untrusted } from "./service.test-helpers.js";

describe("session attention observations", () => {
  it("counts repeated stalls and long-running observations without exposing identities", () => {
    const metrics = createMetricsHarness();
    const base = {
      state: "processing" as const,
      ageMs: 900_000,
      sessionKey: "agent:main:private-session",
      sessionId: "private-session-id",
      activeToolName: "private-tool",
      activeToolCallId: "private-call",
    };
    try {
      const blocked = {
        ...base,
        type: "session.stalled" as const,
        classification: "blocked_tool_call" as const,
        reason: "blocked_tool_call",
        activeWorkKind: "tool_call" as const,
      };
      metrics.record(blocked);
      metrics.record(blocked);
      metrics.record(blocked, untrusted);
      metrics.record({
        ...base,
        type: "session.stalled",
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "embedded_run",
      });
      metrics.record({
        ...base,
        type: "session.long_running",
        classification: "long_running",
        reason: "active_work_progressing",
        activeWorkKind: "model_call",
      });
      metrics.record({
        ...base,
        type: "session.stuck",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
      });
      const text = metrics.render();
      expect(text).toContain(
        'openclaw_session_stalled_total{active_work_kind="tool_call",classification="blocked_tool_call",reason="blocked_tool_call",state="processing"} 2\n',
      );
      expect(text).toContain(
        'openclaw_session_stalled_total{active_work_kind="embedded_run",classification="stalled_agent_run",reason="active_work_without_progress",state="processing"} 1\n',
      );
      expect(text).toContain(
        'openclaw_session_long_running_total{active_work_kind="model_call",reason="active_work_progressing",state="processing"} 1\n',
      );
      expect(text).toContain(
        'openclaw_session_stuck_total{reason="queued_work_without_active_run",state="processing"} 1\n',
      );
      expect(text).not.toContain("private-");
    } finally {
      metrics.stop();
    }
    expect(metrics.render()).toBe("");
  });

  it.each([
    ["model_call", "active_model_call_without_progress"],
    ["model_call", "provider_retry_wait"],
    ["tool_call", "tool_execution_wait"],
  ] as const)("counts permitted %s waits without promising progress", (activeWorkKind, reason) => {
    const metrics = createMetricsHarness();
    try {
      metrics.record({
        type: "session.long_running",
        classification: "long_running",
        state: "processing",
        ageMs: 900_000,
        activeWorkKind,
        reason,
      });
      expect(metrics.render()).toContain(
        `openclaw_session_long_running_total{active_work_kind="${activeWorkKind}",reason="${reason}",state="processing"} 1\n`,
      );
    } finally {
      metrics.stop();
    }
  });

  it("normalizes optional diagnostic dimensions", () => {
    const metrics = createMetricsHarness();
    try {
      metrics.record({
        type: "session.long_running",
        classification: "long_running",
        state: "processing",
        ageMs: 30_000,
        reason: "agent:main:private-session",
      });
      expect(metrics.render()).toContain(
        'openclaw_session_long_running_total{active_work_kind="none",reason="none",state="processing"} 1\n',
      );
    } finally {
      metrics.stop();
    }
  });
});
