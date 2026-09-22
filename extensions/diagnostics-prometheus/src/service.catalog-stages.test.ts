import { describe, expect, it } from "vitest";
import { baseEvent, createMetricsHarness, trusted, untrusted } from "./service.test-helpers.js";

describe("catalog list stage metrics", () => {
  it("exports elapsed and synchronous CPU populations with fixed labels and no diagnostic content", () => {
    const metrics = createMetricsHarness();
    const event = {
      ...baseEvent(),
      type: "diagnostic.phase.completed" as const,
      name: "sessions.catalog.list.planning",
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      details: { threadCpuMs: 2.5, privateText: "synthetic-private-content" },
    };
    try {
      metrics.record(event, trusted);
      metrics.record({ ...event, durationMs: 0, details: undefined }, trusted);
      for (const phase of ["projection_initial", "provider", "coalesced", "projection_final"]) {
        metrics.record({ ...event, name: `sessions.catalog.list.${phase}` }, trusted);
      }
      metrics.record({ ...event, name: "sessions.catalog.list.delivery" }, trusted);
      const rendered = metrics.render();
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="planning"} 2\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.01\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="planning"} 1\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_rpc_stage_thread_cpu_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.0025\n',
      );
      const cpuLines = rendered
        .split("\n")
        .filter((line) => line.startsWith("openclaw_gateway_rpc_stage_thread_cpu_seconds"));
      expect(cpuLines.every((line) => /phase="(?:planning|delivery)"/.test(line))).toBe(true);
      expect(rendered).not.toContain("synthetic-private-content");
      expect(rendered).not.toContain("privateText");
      expect(metrics.render()).toBe(rendered);
    } finally {
      metrics.stop();
    }
  });

  it("rejects untrusted, unknown and malformed phase observations without creating series", () => {
    const metrics = createMetricsHarness();
    const event = {
      ...baseEvent(),
      type: "diagnostic.phase.completed" as const,
      name: "sessions.catalog.list.provider",
      startedAt: 10,
      durationMs: 10,
    };
    try {
      const before = metrics.render();
      metrics.record(event, untrusted);
      metrics.record(event, { trusted: false, internal: true });
      for (const name of [
        "startup.fixture",
        "sessions.catalog.list.private-session",
        "other.delivery",
      ]) {
        metrics.record({ ...event, name }, trusted);
      }
      for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        metrics.record({ ...event, durationMs }, trusted);
      }
      expect(metrics.render()).toBe(before);
      metrics.record(
        { ...event, name: "sessions.catalog.list.delivery", details: { threadCpuMs: "2.5" } },
        trusted,
      );
      expect(metrics.render()).toContain(
        'openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="delivery"} 1\n',
      );
      expect(metrics.render()).not.toContain("openclaw_gateway_rpc_stage_thread_cpu_seconds");
    } finally {
      metrics.stop();
    }
  });
});
