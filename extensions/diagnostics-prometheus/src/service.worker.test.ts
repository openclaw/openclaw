import { expect, it } from "vitest";
import { createMetricsHarness, untrusted } from "./service.test-helpers.js";

it("exports worker queue and service populations without adding series per request", () => {
  const metrics = createMetricsHarness();
  const event = {
    type: "worker.request" as const,
    kind: "sqlite_writer" as const,
    requestClass: "transcripts",
    phase: "queued" as const,
    queueDepth: 2,
  };
  try {
    metrics.record(event, untrusted);
    metrics.record(event, { trusted: false, internal: true });
    expect(metrics.render()).not.toContain("openclaw_worker_");
    metrics.record(event);
    expect(metrics.render()).toContain('openclaw_worker_queue_depth{kind="sqlite_writer"} 2\n');
    for (let index = 0; index < 1000; index++) {
      metrics.record({ ...event, phase: "started", queueDepth: 0, queueWaitMs: 25 });
      metrics.record({ ...event, phase: "completed", queueDepth: 0, durationMs: 50 });
    }
    // A queued cancellation changes depth without inventing a dispatched request.
    metrics.record({ ...event, phase: "completed", queueDepth: 0 });
    const rendered = metrics.render();
    expect(rendered).toContain('openclaw_worker_queue_depth{kind="sqlite_writer"} 0\n');
    for (const [name, sum] of [
      ["queue_wait", 25],
      ["request", 50],
    ] as const) {
      expect(rendered).toContain(
        `openclaw_worker_${name}_seconds_count{kind="sqlite_writer",request_class="transcripts"} 1000\n`,
      );
      expect(rendered).toContain(
        `openclaw_worker_${name}_seconds_sum{kind="sqlite_writer",request_class="transcripts"} ${sum}\n`,
      );
    }
    expect(
      rendered.split("\n").filter((line) => line.startsWith("# TYPE openclaw_worker_")),
    ).toHaveLength(3);
    // Sixteen finite buckets, +Inf, sum and count per histogram, plus the gauge.
    expect(rendered.split("\n").filter((line) => line.startsWith("openclaw_worker_"))).toHaveLength(
      39,
    );
    expect(rendered).not.toContain("series_dropped");
  } finally {
    metrics.stop();
  }
});
