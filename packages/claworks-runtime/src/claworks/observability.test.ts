import { describe, expect, it, beforeEach } from "vitest";
import { globalMetrics } from "../kernel/metrics.js";
import {
  appendDecisionLog,
  listDecisionLog,
  appendObservationEvent,
  listObservationEvents,
  prometheusMetricsText,
  markRuntimeStarted,
  runtimeUptimeSeconds,
} from "./observability.js";

beforeEach(() => {
  // Reset globalMetrics between tests
  globalMetrics.reset();
});

describe("decision log", () => {
  it("appends and retrieves entries", () => {
    appendDecisionLog({ kind: "test", summary: "unit test entry" });
    const log = listDecisionLog(10);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].kind).toBe("test");
    expect(log[0].summary).toBe("unit test entry");
    expect(log[0].id).toMatch(/^dec-/);
    expect(log[0].at).toBeTruthy();
  });
});

describe("observation events", () => {
  it("appends and retrieves events", () => {
    appendObservationEvent("test-source", "test.event", { detail: "ok" });
    const events = listObservationEvents(10);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].source).toBe("test-source");
    expect(events[0].type).toBe("test.event");
    expect(events[0].payload).toEqual({ detail: "ok" });
  });
});

describe("prometheusMetricsText", () => {
  it("includes uptime and decision log size", () => {
    markRuntimeStarted();
    const text = prometheusMetricsText("test-robot");
    expect(text).toContain('claworks_uptime_seconds{robot="test-robot"}');
    expect(text).toContain("claworks_decision_log_entries");
    expect(text).toContain("claworks_observation_events");
  });

  it("includes playbook run counters as claworks_playbook_runs_total", () => {
    globalMetrics.increment("playbook.started", { playbook_id: "daily_self_test" });
    globalMetrics.increment("playbook.completed", { playbook_id: "daily_self_test" });
    globalMetrics.increment("playbook.failed", { playbook_id: "alarm_notify" });
    const text = prometheusMetricsText("test-robot");
    expect(text).toContain("claworks_playbook_runs_total");
    expect(text).toContain('status="started"');
    expect(text).toContain('playbook_id="daily_self_test"');
  });

  it("includes globalMetrics counters when present", () => {
    globalMetrics.increment("playbook.run", { playbook_id: "my_pb" });
    globalMetrics.increment("capability.call", { id: "kb.search" });
    const text = prometheusMetricsText("test-robot");
    expect(text).toContain("claworks_counter_total");
    expect(text).toContain("playbook.run");
    expect(text).toContain("capability.call");
  });

  it("includes histogram p95 when durations recorded", () => {
    globalMetrics.recordDuration("step.duration_ms", 120, { playbook_id: "p1" });
    globalMetrics.recordDuration("step.duration_ms", 80, { playbook_id: "p1" });
    const text = prometheusMetricsText("test-robot");
    expect(text).toContain("claworks_duration_p95_ms");
    expect(text).toContain("step.duration_ms");
  });

  it("emits valid prometheus text format (no crash when no counters)", () => {
    const text = prometheusMetricsText("empty-robot");
    expect(text).toBeTruthy();
    expect(typeof text).toBe("string");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("runtimeUptimeSeconds", () => {
  it("returns non-negative uptime", () => {
    markRuntimeStarted();
    const uptime = runtimeUptimeSeconds();
    expect(uptime).toBeGreaterThanOrEqual(0);
  });
});
