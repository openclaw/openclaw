import { describe, expect, it, vi } from "vitest";
import {
  baseEvent,
  createMetricsHarness,
  trusted,
  untrusted,
  withMetricsServer,
} from "./service.test-helpers.js";

// HTTP scrapes in this file exercise an authorized operator; the exporter's scope guard is
// covered in service.http-scope.test.ts.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

describe("diagnostics-prometheus runtime metrics", () => {
  it("exports isolate and native memory plus bounded successful spawn counts", () => {
    const metrics = createMetricsHarness();
    try {
      metrics.record(
        {
          ...baseEvent(),
          type: "diagnostic.memory.sample",
          memory: {
            rssBytes: 1000,
            heapTotalBytes: 500,
            heapUsedBytes: 300,
            externalBytes: 200,
            arrayBuffersBytes: 100,
            workerHeapTotalBytes: 400,
            workerHeapUsedBytes: 250,
            workerCount: 3,
            workerHeapSampledCount: 2,
            workerLifecycle: [
              {
                script: "sqlite-store.worker.js",
                started: 5,
                retired: [{ reason: "idle_timeout", count: 2 }],
              },
            ],
            workerHeaps: [
              { script: "sqlite-store.worker.js", heapUsed: 100, heapTotal: 200 },
              { script: "sqlite-store.worker.js", heapUsed: 150, heapTotal: 200 },
            ],
          },
        },
        trusted,
      );
      for (const count of [2, 3]) {
        metrics.record(
          {
            ...baseEvent(),
            type: "diagnostic.child_process.spawn",
            family: "node",
            count,
            intervalMs: 60_000,
          },
          trusted,
        );
      }
      const rendered = metrics.render();
      for (const [kind, value] of Object.entries({
        rss: 1000,
        heap_total: 500,
        heap_used: 300,
        external: 200,
        array_buffers: 100,
        worker_heap_total: 400,
        worker_heap_used: 250,
      })) {
        expect(rendered).toContain(`openclaw_memory_bytes{kind="${kind}"} ${value}\n`);
      }
      expect(rendered).toContain("openclaw_worker_count 3\n");
      expect(rendered).toContain("openclaw_worker_heap_sampled_count 2\n");
      expect(rendered).toContain(
        'openclaw_worker_heap_used_bytes{script="sqlite-store.worker.js"} 250\n',
      );
      expect(rendered).toContain('openclaw_child_process_spawn_total{family="node"} 5\n');
      expect(rendered).toContain(
        'openclaw_worker_started_total{script="sqlite-store.worker.js"} 5\n',
      );
      expect(rendered).toContain(
        'openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2\n',
      );
      const retiredSample = {
        ...baseEvent(),
        type: "diagnostic.memory.sample" as const,
        memory: {
          rssBytes: 1000,
          heapTotalBytes: 500,
          heapUsedBytes: 300,
          externalBytes: 200,
          arrayBuffersBytes: 100,
          workerHeaps: [{ script: "other", heapUsed: 50, heapTotal: 100 }],
          workerLifecycle: [
            {
              script: "sqlite-store.worker.js",
              started: 5,
              retired: [{ reason: "idle_timeout", count: 2 }],
            },
          ],
        },
      };
      metrics.record(retiredSample, untrusted);
      expect(metrics.render()).toBe(rendered);
      metrics.record(retiredSample, trusted);
      expect(metrics.render()).not.toContain(
        'openclaw_worker_heap_used_bytes{script="sqlite-store',
      );
      expect(metrics.render()).toContain('openclaw_worker_heap_used_bytes{script="other"} 50\n');
      expect(metrics.render()).toContain(
        'openclaw_worker_started_total{script="sqlite-store.worker.js"} 5\n',
      );
      expect(metrics.render()).toContain(
        'openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2\n',
      );
      metrics.record(
        { ...retiredSample, memory: { ...retiredSample.memory, workerHeaps: [] } },
        trusted,
      );
      expect(metrics.render()).not.toContain("openclaw_worker_heap_used_bytes");
      expect(metrics.render()).toContain(
        'openclaw_worker_started_total{script="sqlite-store.worker.js"} 5\n',
      );
    } finally {
      metrics.stop();
    }
  });

  it.each([false, true])(
    "caps series growth while retaining admitted event-loop windows (preseed=%s)",
    (preseed) => {
      const metrics = createMetricsHarness();
      const sample = {
        type: "gateway.event_loop.sample",
        intervalMs: 1_000,
        delayMaxMs: 20,
      } as const;
      try {
        if (preseed) {
          metrics.record(sample);
          metrics.record({ type: "diagnostic.gc", durationMs: 20 });
        }
        for (let index = 0; index < 2100; index += 1) {
          metrics.record({
            type: "model.call.completed",
            runId: `run-${index}`,
            callId: `call-${index}`,
            provider: "openai",
            model: `model.${index}`,
            durationMs: 10,
          });
        }
        const drops = () =>
          Number(
            metrics
              .render()
              .split("\n")
              .find((line) => line.startsWith("openclaw_prometheus_series_dropped_total "))
              ?.split(" ")
              .at(-1),
          );
        const before = drops();
        expect(before).toBeGreaterThan(0);
        metrics.record(sample);
        metrics.record({ type: "diagnostic.gc", durationMs: 20 });
        expect(drops()).toBe(before + (preseed ? 0 : 3));
        const rendered = metrics.render();
        if (preseed) {
          expect(rendered).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 2");
          expect(rendered).toContain("openclaw_gateway_event_loop_observed_seconds_total 2");
          expect(rendered).toContain("openclaw_gc_duration_seconds_count 2");
        } else {
          expect(rendered).not.toContain("openclaw_gateway_event_loop_");
          expect(rendered).not.toContain("openclaw_gc_duration_seconds");
        }
      } finally {
        metrics.stop();
      }
    },
  );

  it("retains runtime durations across repeated HTTP scrapes without labels", async () => {
    const metrics = createMetricsHarness();
    await withMetricsServer(metrics, async (url) => {
      const scrape = async () => {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        return await response.text();
      };
      metrics.record({ type: "gateway.event_loop.sample", intervalMs: 2_000, delayMaxMs: 1_250 });
      metrics.record({ type: "diagnostic.gc", durationMs: 1_250 });
      const first = await scrape();
      expect(first).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 1");
      expect(first).toContain("openclaw_gateway_event_loop_observed_seconds_total 2");
      expect(first).toContain("openclaw_gc_duration_seconds_count 1");
      expect(await scrape()).toBe(first);
      metrics.record(
        { type: "gateway.event_loop.sample", intervalMs: 8_000, delayMaxMs: 20 },
        Object.freeze({ trusted: false, internal: true }),
      );
      metrics.record(
        { type: "diagnostic.gc", durationMs: 20 },
        Object.freeze({ trusted: false, internal: true }),
      );
      metrics.record({ type: "diagnostic.gc", durationMs: 99_000 }, untrusted);
      metrics.record(
        {
          type: "gateway.event_loop.sample",
          intervalMs: 99_000,
          delayMaxMs: 99_000,
        },
        untrusted,
      );
      const second = await scrape();
      for (const expected of [
        'openclaw_gateway_event_loop_delay_max_seconds_bucket{le="1"} 1',
        'openclaw_gateway_event_loop_delay_max_seconds_bucket{le="2.5"} 2',
        "openclaw_gateway_event_loop_delay_max_seconds_count 2",
        "openclaw_gateway_event_loop_delay_max_seconds_sum 1.27",
        "openclaw_gateway_event_loop_observed_seconds_total 10",
        'openclaw_gc_duration_seconds_bucket{le="1"} 1',
        'openclaw_gc_duration_seconds_bucket{le="2.5"} 2',
        "openclaw_gc_duration_seconds_count 2",
        "openclaw_gc_duration_seconds_sum 1.27",
      ]) {
        expect(second).toContain(expected);
      }
      expect(await scrape()).toBe(second);
      expect(second).not.toMatch(/\{(?!le=)/);
    });
  });
});
