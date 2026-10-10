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
            heapSpaces: ["old_space", "future_v8_space"].map((space_name) => ({
              space_name,
              space_used_size: 101,
              space_size: 202,
              space_available_size: 0,
              physical_space_size: 303,
            })),
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
      for (const [operation, count] of [
        ["repository.identities", 4],
        ["checkout.diff", 2],
      ] as const) {
        metrics.record(
          {
            ...baseEvent(),
            type: "diagnostic.child_process.spawn",
            family: "git",
            operation,
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
      for (const space of ["old_space", "future_v8_space"]) {
        for (const [stat, value] of Object.entries({
          used: 101,
          size: 202,
          available: 0,
          physical: 303,
        })) {
          expect(rendered).toContain(
            `openclaw_heap_space_bytes{space="${space}",stat="${stat}"} ${value}\n`,
          );
        }
      }
      expect(metrics.render()).toBe(rendered);
      expect(rendered).toContain("openclaw_worker_count 3\n");
      expect(rendered).toContain("openclaw_worker_heap_sampled_count 2\n");
      expect(rendered).toContain(
        'openclaw_worker_heap_used_bytes{script="sqlite-store.worker.js"} 250\n',
      );
      expect(rendered).toContain(
        'openclaw_child_process_spawn_total{family="node",operation="none"} 5\n',
      );
      expect(rendered).toContain(
        'openclaw_child_process_spawn_total{family="git",operation="repository.identities"} 4\n',
      );
      expect(rendered).toContain(
        'openclaw_child_process_spawn_total{family="git",operation="checkout.diff"} 2\n',
      );
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
      expect(metrics.render()).not.toContain("openclaw_heap_space_bytes");
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

describe("diagnostics-prometheus runtime identity", () => {
  it("does not read or publish runtime identity when diagnostics are disabled at startup", () => {
    const readIdentity = vi.fn(() => ({
      processInstanceId: "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea",
    }));
    const metrics = createMetricsHarness(readIdentity, { diagnostics: { enabled: false } });
    expect(readIdentity).not.toHaveBeenCalled();
    expect(metrics.render()).toBe("");
    metrics.stop();
  });

  it.each([undefined, "2026.9.1-fixture-build"])(
    "captures runtime identity once with build ID %s and keeps it through saturation",
    (buildId) => {
      const identity = {
        processInstanceId: "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea",
        ...(buildId ? { buildId } : {}),
      };
      const readIdentity = vi.fn(() => identity);
      const metrics = createMetricsHarness(readIdentity);
      const info = `openclaw_gateway_build_info{${buildId ? `build_id="${buildId}",` : ""}process_instance_id="${identity.processInstanceId}"} 1`;
      const initial = metrics.render();
      expect(initial).toContain("# TYPE openclaw_gateway_build_info gauge");
      expect(initial).toContain(info);
      identity.processInstanceId = "a-different-value-after-service-start";
      expect(metrics.render()).toBe(initial);
      expect(readIdentity).toHaveBeenCalledOnce();
      for (let index = 0; index < 2100; index += 1) {
        metrics.record({ type: "gateway.rpc", method: `method.${index}`, phase: "received" });
      }
      expect(metrics.render()).toContain(info);
      expect(metrics.render()).toContain("openclaw_prometheus_series_dropped_total 53");
      metrics.stop();
      expect(metrics.render()).toBe("");
      identity.processInstanceId = "a6aa1fc7-1f10-4b56-8ae8-4ff8c4dc02ea";
      metrics.start();
      expect(metrics.render()).toContain(info);
      expect(metrics.render()).not.toContain("openclaw_prometheus_series_dropped_total");
      expect(readIdentity).toHaveBeenCalledTimes(2);
      metrics.stop();
    },
  );
});

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
