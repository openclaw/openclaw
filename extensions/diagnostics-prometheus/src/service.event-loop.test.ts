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
  it("counts attributed main-thread stalls by task and reports bounded-buffer losses", () => {
    const metrics = createMetricsHarness();
    try {
      metrics.record({ type: "gateway.main_thread.stall", stalls: [], dropped: 0 });
      expect(metrics.render()).not.toContain("openclaw_gateway_main_thread_stall");
      const batch = {
        type: "gateway.main_thread.stall" as const,
        stalls: [
          { task: "rpc.sessions.list", durationMs: 250 },
          { task: "rpc.sessions.list", durationMs: 750 },
          { task: "timer.cron", durationMs: 2_000 },
          { task: "/private/session/path", durationMs: 500 },
        ],
        dropped: 3,
      };
      metrics.record(batch, untrusted);
      expect(metrics.render()).not.toContain("openclaw_gateway_main_thread_stall");
      metrics.record(batch, Object.freeze({ trusted: false, internal: true }));
      const rendered = metrics.render();
      for (const [bound, count] of [
        ["0.25", 1],
        ["0.5", 1],
        ["1", 2],
        ["2.5", 2],
        ["5", 2],
        ["10", 2],
        ["+Inf", 2],
      ] as const) {
        expect(rendered).toContain(
          `openclaw_gateway_main_thread_stall_seconds_bucket{le="${bound}",task="rpc.sessions.list"} ${count}\n`,
        );
      }
      expect(rendered).toContain(
        'openclaw_gateway_main_thread_stall_seconds_count{task="rpc.sessions.list"} 2\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_main_thread_stall_seconds_sum{task="rpc.sessions.list"} 1\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_main_thread_stall_seconds_count{task="timer.cron"} 1\n',
      );
      expect(rendered).toContain(
        'openclaw_gateway_main_thread_stall_seconds_count{task="unknown"} 1\n',
      );
      expect(rendered).not.toContain("/private/session/path");
      expect(rendered).toContain("openclaw_gateway_main_thread_stalls_dropped_total 3\n");
      expect(metrics.render()).toBe(rendered);
      metrics.record({ type: "gateway.main_thread.stall", stalls: [], dropped: 2 });
      expect(metrics.render()).toContain("openclaw_gateway_main_thread_stalls_dropped_total 5\n");
    } finally {
      metrics.stop();
    }
  });

  it("separates Code Mode isolate GC and replaces live memory gauges at each sample", () => {
    const metrics = createMetricsHarness();
    const memory = {
      rssBytes: 1000,
      heapTotalBytes: 500,
      heapUsedBytes: 300,
      externalBytes: 200,
      arrayBuffersBytes: 100,
    };
    try {
      for (const [workerSlot, durationMs] of [
        [1, 8],
        [2, 20],
        [1, 12],
      ] as const) {
        metrics.record({
          type: "diagnostic.gc",
          kind: "mark_sweep_compact",
          reason: "forced",
          thread: "code-mode-node.worker.js",
          workerSlot,
          durationMs,
        });
      }
      metrics.record({
        type: "diagnostic.memory.sample",
        memory: {
          ...memory,
          workerHeaps: [
            {
              script: "code-mode-node.worker.js",
              workerSlot: 1,
              heapUsed: 900,
              heapTotal: 1000,
              heapSizeLimitBytes: 1024,
              external: 300,
              arrayBuffers: 100,
            },
            {
              script: "code-mode-node.worker.js",
              workerSlot: 2,
              heapUsed: 100,
              heapTotal: 200,
              heapSizeLimitBytes: 1024,
              external: 50,
              arrayBuffers: 20,
            },
            // Slot overflow still contributes to script totals; native-only samples lack buffers.
            { script: "code-mode-node.worker.js", heapUsed: 10, heapTotal: 20, external: 50 },
          ],
        },
      });
      const before = metrics.render();
      expect(before).toContain(
        'openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2\n',
      );
      expect(before).toContain(
        'openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="2",thread="code-mode-node.worker.js"} 1\n',
      );
      expect(before).toContain('openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 900\n');
      expect(before).toContain(
        'openclaw_code_mode_worker_heap_bytes{kind="limit",slot="1"} 1024\n',
      );
      expect(before).toContain(
        'openclaw_worker_heap_used_bytes{script="code-mode-node.worker.js"} 1010\n',
      );
      expect(before).toContain(
        'openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 400\n',
      );
      expect(before).toContain(
        'openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 120\n',
      );
      for (const [slot, external, buffers] of [
        [1, 300, 100],
        [2, 50, 20],
      ]) {
        expect(before).toContain(
          `openclaw_code_mode_worker_memory_bytes{kind="external",slot="${slot}"} ${external}\n`,
        );
        expect(before).toContain(
          `openclaw_code_mode_worker_memory_bytes{kind="array_buffers",slot="${slot}"} ${buffers}\n`,
        );
      }
      // Retirement or stale sampling removes gauges; slot reuse keeps cumulative GC counts.
      metrics.record({
        type: "diagnostic.memory.sample",
        memory: {
          ...memory,
          workerHeaps: [
            {
              script: "code-mode-node.worker.js",
              workerSlot: 1,
              heapUsed: 50,
              heapTotal: 100,
              external: 0,
              arrayBuffers: 0,
            },
            { script: "sqlite-store.worker.js", heapUsed: 10, heapTotal: 20, external: 25 },
          ],
        },
      });
      const after = metrics.render();
      expect(after).toContain('openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 50\n');
      expect(after).not.toContain('openclaw_code_mode_worker_heap_bytes{kind="limit"');
      expect(after).not.toContain('openclaw_code_mode_worker_heap_bytes{kind="used",slot="2"}');
      expect(after).toContain(
        'openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 0\n',
      );
      expect(after).toContain(
        'openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 0\n',
      );
      expect(after).toContain(
        'openclaw_worker_external_bytes{script="sqlite-store.worker.js"} 25\n',
      );
      expect(after).not.toContain(
        'openclaw_worker_array_buffers_bytes{script="sqlite-store.worker.js"}',
      );
      for (const kind of ["external", "array_buffers"]) {
        expect(after).toContain(
          `openclaw_code_mode_worker_memory_bytes{kind="${kind}",slot="1"} 0\n`,
        );
        expect(after).not.toContain(
          `openclaw_code_mode_worker_memory_bytes{kind="${kind}",slot="2"}`,
        );
      }
      expect(after).toContain(
        'openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2\n',
      );
      metrics.record({ type: "diagnostic.memory.sample", memory });
      expect(metrics.render()).not.toContain("openclaw_code_mode_worker_heap_bytes");
      expect(metrics.render()).not.toContain("openclaw_code_mode_worker_memory_bytes");
      expect(metrics.render()).not.toContain("openclaw_worker_external_bytes");
      expect(metrics.render()).not.toContain("openclaw_worker_array_buffers_bytes");
    } finally {
      metrics.stop();
    }
  });

  it("exports cumulative worker traffic without recounting repeated memory samples", () => {
    const metrics = createMetricsHarness();
    try {
      const sample = {
        ...baseEvent(),
        type: "diagnostic.memory.sample" as const,
        memory: {
          rssBytes: 1000,
          heapTotalBytes: 500,
          heapUsedBytes: 300,
          externalBytes: 200,
          arrayBuffersBytes: 100,
          workerMessages: [
            {
              kind: "sqlite_reply" as const,
              direction: "from_worker" as const,
              messages: 4,
              payloadBytes: 1234,
              unmeasuredMessages: 2,
            },
          ],
        },
      };
      metrics.record(sample, untrusted);
      expect(metrics.render()).not.toContain("openclaw_worker_messages_total");
      metrics.record(sample, trusted);
      metrics.record(sample, trusted);
      const rendered = metrics.render();
      for (const [metric, value] of [
        ["messages_total", 4],
        ["message_payload_bytes_total", 1234],
        ["message_unmeasured_total", 2],
      ] as const) {
        expect(rendered).toContain(
          `openclaw_worker_${metric}{direction="from_worker",kind="sqlite_reply"} ${value}\n`,
        );
      }
    } finally {
      metrics.stop();
    }
  });

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
            workerCount: 4,
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
            workerMemoryMissing: [
              { script: "sqlite-store.worker.js", threadId: 3, reason: "pending" },
              { script: "other", threadId: 4, reason: "unavailable" },
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
      metrics.record(
        {
          ...baseEvent(),
          type: "diagnostic.child_process.spawn",
          family: "node",
          operation: "sqlite.scoped-read.broker",
          count: 1,
          intervalMs: 60_000,
        },
        trusted,
      );
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
      expect(rendered).toContain("openclaw_worker_count 4\n");
      expect(rendered).toContain("openclaw_worker_heap_sampled_count 2\n");
      expect(rendered).toContain('openclaw_worker_count{script="sqlite-store.worker.js"} 3\n');
      expect(rendered).toContain(
        'openclaw_worker_heap_sampled_count{script="sqlite-store.worker.js"} 2\n',
      );
      expect(rendered).toContain('openclaw_worker_count{script="other"} 1\n');
      expect(rendered).toContain('openclaw_worker_heap_sampled_count{script="other"} 0\n');
      expect(rendered).not.toContain('openclaw_worker_heap_used_bytes{script="other"}');
      expect(rendered).toContain(
        'openclaw_worker_heap_used_bytes{script="sqlite-store.worker.js"} 250\n',
      );
      expect(rendered).toContain(
        'openclaw_child_process_spawn_total{family="node",operation="none"} 5\n',
      );
      expect(rendered).toContain(
        'openclaw_child_process_spawn_total{family="node",operation="sqlite.scoped-read.broker"} 1\n',
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
          workerCount: 1,
          workerHeapSampledCount: 1,
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
      expect(metrics.render()).not.toContain('openclaw_worker_count{script="sqlite-store');
      expect(metrics.render()).not.toContain(
        'openclaw_worker_heap_sampled_count{script="sqlite-store',
      );
      expect(metrics.render()).toContain('openclaw_worker_count{script="other"} 1\n');
      expect(metrics.render()).toContain('openclaw_worker_heap_sampled_count{script="other"} 1\n');
      expect(metrics.render()).toContain('openclaw_worker_heap_used_bytes{script="other"} 50\n');
      expect(metrics.render()).toContain(
        'openclaw_worker_started_total{script="sqlite-store.worker.js"} 5\n',
      );
      expect(metrics.render()).toContain(
        'openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2\n',
      );
      metrics.record(
        {
          ...retiredSample,
          memory: {
            ...retiredSample.memory,
            workerCount: 0,
            workerHeapSampledCount: 0,
            workerHeaps: [],
          },
        },
        trusted,
      );
      expect(metrics.render()).not.toContain("openclaw_worker_heap_used_bytes");
      expect(metrics.render()).not.toContain("openclaw_worker_count{");
      expect(metrics.render()).not.toContain("openclaw_worker_heap_sampled_count{");
      expect(metrics.render()).toContain("openclaw_worker_count 0\n");
      expect(metrics.render()).toContain("openclaw_worker_heap_sampled_count 0\n");
      expect(metrics.render()).toContain(
        'openclaw_worker_started_total{script="sqlite-store.worker.js"} 5\n',
      );
    } finally {
      metrics.stop();
    }
  });

  it("retains runtime durations across scrapes with bounded GC kind and thread labels", async () => {
    const metrics = createMetricsHarness();
    await withMetricsServer(metrics, async (url) => {
      const scrape = async () => {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        return await response.text();
      };
      const firstWindow = {
        type: "gateway.event_loop.sample",
        intervalMs: 2_000,
        delayMaxMs: 1_250,
      } as const;
      // Scrapes cannot publish a producer's window before diagnostics delivers it.
      const beforeDelivery = await scrape();
      expect(beforeDelivery).not.toContain("openclaw_gateway_event_loop_");
      expect(await scrape()).toBe(beforeDelivery);
      metrics.record(firstWindow);
      metrics.record({
        type: "diagnostic.gc",
        kind: "scavenge",
        thread: "main",
        durationMs: 1_250,
      });
      const first = await scrape();
      expect(first).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 1\n");
      expect(first).toContain("openclaw_gateway_event_loop_delay_max_seconds_sum 1.25\n");
      expect(first).toContain("openclaw_gateway_event_loop_observed_seconds_total 2\n");
      expect(first).toContain(
        'openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 1',
      );
      expect(await scrape()).toBe(first);
      metrics.record(
        { type: "gateway.event_loop.sample", intervalMs: 8_000, delayMaxMs: 20 },
        Object.freeze({ trusted: false, internal: true }),
      );
      metrics.record(
        { type: "diagnostic.gc", kind: "scavenge", thread: "main", durationMs: 20 },
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
        'openclaw_gc_duration_seconds_bucket{kind="scavenge",le="1",reason="other",thread="main"} 1',
        'openclaw_gc_duration_seconds_bucket{kind="scavenge",le="2.5",reason="other",thread="main"} 2',
        'openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 2',
        'openclaw_gc_duration_seconds_sum{kind="scavenge",reason="other",thread="main"} 1.27',
      ]) {
        expect(second).toContain(`${expected}\n`);
      }
      expect(await scrape()).toBe(second);
      metrics.record({ type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 0 });
      const third = await scrape();
      expect(third).toContain(
        'openclaw_gateway_event_loop_delay_max_seconds_bucket{le="0.005"} 1\n',
      );
      expect(third).toContain("openclaw_gateway_event_loop_delay_max_seconds_count 3\n");
      expect(third).toContain("openclaw_gateway_event_loop_delay_max_seconds_sum 1.27\n");
      expect(third).toContain("openclaw_gateway_event_loop_observed_seconds_total 11\n");
      expect(await scrape()).toBe(third);
      metrics.record({
        type: "diagnostic.gc",
        kind: "mark_sweep_compact",
        thread: "sqlite-store.worker.js",
        durationMs: 8,
      });
      const workerSample = await scrape();
      expect(workerSample).toContain(
        'openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="other",thread="sqlite-store.worker.js"} 1',
      );
      expect(workerSample).toContain(
        'openclaw_gc_duration_seconds_sum{kind="mark_sweep_compact",reason="other",thread="sqlite-store.worker.js"} 0.008',
      );
      expect(workerSample).toContain(
        'openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 2',
      );
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

it("exports completed SQLite request phases without inventing missing or invalid intervals", () => {
  const metrics = createMetricsHarness();
  const event = {
    type: "worker.request" as const,
    kind: "sqlite_writer" as const,
    requestClass: "transcripts",
    phase: "completed" as const,
    queueDepth: 0,
    durationMs: 28_000,
    timing: {
      dispatched: 1_000,
      posted: 2_000,
      postFinished: 9_000,
      received: 4_000,
      inputReady: 7_000,
      executeStarted: 11_000,
      executeFinished: 16_000,
      serialized: 17_000,
      replied: 22_000,
      replyReceived: 29_000,
    },
  };
  try {
    metrics.record(event, untrusted);
    metrics.record(event, { trusted: false, internal: true });
    metrics.record({ ...event, phase: "queued", durationMs: undefined });
    metrics.record({ ...event, phase: "started", durationMs: undefined });
    expect(metrics.render()).not.toContain("openclaw_worker_request_phase_seconds");
    metrics.record(event);
    metrics.record({
      ...event,
      durationMs: undefined,
      timing: {
        dispatched: 1,
        posted: 1,
        received: 0,
        inputReady: Number.NaN,
        executeStarted: Number.POSITIVE_INFINITY,
        replied: 2,
      },
    });
    metrics.record({ ...event, durationMs: undefined, timing: undefined });
    const rendered = metrics.render();
    for (const [phase, seconds, count] of [
      ["dispatch", 1, 2],
      ["delivery", 2, 1],
      ["input", 3, 1],
      ["prepare", 4, 1],
      ["execute", 5, 1],
      ["result", 6, 1],
      ["reply", 7, 1],
    ] as const) {
      const labels = `{kind="sqlite_writer",phase="${phase}",request_class="transcripts"}`;
      expect(rendered).toContain(`openclaw_worker_request_phase_seconds_sum${labels} ${seconds}\n`);
      expect(rendered).toContain(`openclaw_worker_request_phase_seconds_count${labels} ${count}\n`);
    }
    expect(rendered).toContain(
      'openclaw_worker_request_seconds_sum{kind="sqlite_writer",request_class="transcripts"} 28\n',
    );
    expect(rendered).toContain(
      'openclaw_worker_request_phase_seconds_bucket{kind="sqlite_writer",le="0.005",phase="dispatch",request_class="transcripts"} 1\n',
    );
    expect(
      rendered
        .split("\n")
        .filter((line) => line.startsWith("openclaw_worker_request_phase_seconds_count")),
    ).toHaveLength(7);
  } finally {
    metrics.stop();
  }
});
