import { expect, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import {
  metricsTest as it,
  expectMetrics,
  expectExcludes,
  createMetricsHarness,
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

const memory = {
  rssBytes: 1000,
  heapTotalBytes: 500,
  heapUsedBytes: 300,
  externalBytes: 200,
  arrayBuffersBytes: 100,
};
type Memory = Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>["memory"];
type WorkerHeap = NonNullable<Memory["workerHeaps"]>[number];
type GcEvent = Omit<Extract<DiagnosticEventPayload, { type: "diagnostic.gc" }>, "seq" | "ts">;
const internal = Object.freeze({ trusted: false, internal: true });
const worker = {
  type: "worker.request",
  kind: "sqlite_writer",
  requestClass: "transcripts",
} as const;
function gc(durationMs: number, fields: Omit<GcEvent, "type" | "durationMs"> = {}) {
  return { type: "diagnostic.gc" as const, durationMs, ...fields };
}
function windowSample(intervalMs: number, delayMaxMs: number) {
  return { type: "gateway.event_loop.sample" as const, intervalMs, delayMaxMs };
}
function spawn(family: string, count: number, operation?: string) {
  return {
    type: "diagnostic.child_process.spawn" as const,
    family,
    count,
    intervalMs: 60_000,
    operation,
  };
}
function memorySample(fields: Partial<Memory> = {}) {
  return { type: "diagnostic.memory.sample" as const, memory: { ...memory, ...fields } };
}
function heap(
  script: string,
  heapUsed: number,
  heapTotal: number,
  fields: Omit<WorkerHeap, "script" | "heapUsed" | "heapTotal"> = {},
) {
  return { script, heapUsed, heapTotal, ...fields };
}

it("attributes main-thread stalls and counts buffer losses", ({ metrics }) => {
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
  metrics.record(batch, internal);
  const rendered = metrics.render();
  for (const [count, bounds] of [
    [1, [0.25, 0.5]],
    [2, [1, 2.5, 5, 10, "+Inf"]],
  ] as const) {
    for (const bound of bounds) {
      expect(rendered).toContain(
        `openclaw_gateway_main_thread_stall_seconds_bucket{le="${bound}",task="rpc.sessions.list"} ${count}\n`,
      );
    }
  }
  expectMetrics(rendered)(`
      openclaw_gateway_main_thread_stall_seconds_count{task="rpc.sessions.list"} 2
      openclaw_gateway_main_thread_stall_seconds_sum{task="rpc.sessions.list"} 1
      openclaw_gateway_main_thread_stall_seconds_count{task="timer.cron"} 1
      openclaw_gateway_main_thread_stall_seconds_count{task="unknown"} 1
      openclaw_gateway_main_thread_stalls_dropped_total 3
    `);
  expect(rendered).not.toContain("/private/session/path");
  expect(metrics.render()).toBe(rendered);
  metrics.record({ type: "gateway.main_thread.stall", stalls: [], dropped: 2 });
  expect(metrics.render()).toContain("openclaw_gateway_main_thread_stalls_dropped_total 5\n");
});

it("separates isolate GC and replaces per-slot memory gauges", ({ metrics }) => {
  for (const [workerSlot, durationMs] of [
    [1, 8],
    [2, 20],
    [1, 12],
  ] as const) {
    metrics.record(
      gc(durationMs, {
        kind: "mark_sweep_compact",
        reason: "forced",
        thread: "code-mode-node.worker.js",
        workerSlot,
      }),
    );
  }
  metrics.record(
    memorySample({
      anonymousRssBytes: 700,
      anonymousSwapBytes: 0,
      workerHeaps: [
        heap("code-mode-node.worker.js", 900, 1000, {
          workerSlot: 1,
          heapSizeLimitBytes: 1024,
          external: 300,
          arrayBuffers: 100,
        }),
        heap("code-mode-node.worker.js", 100, 200, {
          workerSlot: 2,
          heapSizeLimitBytes: 1024,
          external: 50,
          arrayBuffers: 20,
        }),
        // Slot overflow still contributes to script totals; native-only samples lack buffers.
        heap("code-mode-node.worker.js", 10, 20, { external: 50 }),
      ],
    }),
  );
  const before = metrics.render();
  expectMetrics(before)(`
      openclaw_process_anonymous_memory_bytes{kind="rss"} 700
      openclaw_process_anonymous_memory_bytes{kind="swap"} 0
      openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2
      openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="2",thread="code-mode-node.worker.js"} 1
      openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 900
      openclaw_code_mode_worker_heap_bytes{kind="limit",slot="1"} 1024
      openclaw_worker_heap_used_bytes{script="code-mode-node.worker.js"} 1010
      openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 400
      openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 120
    `);
  for (const [slot, external, buffers] of [
    [1, 300, 100],
    [2, 50, 20],
  ]) {
    expectMetrics(before)(`
        openclaw_code_mode_worker_memory_bytes{kind="external",slot="${slot}"} ${external}
        openclaw_code_mode_worker_memory_bytes{kind="array_buffers",slot="${slot}"} ${buffers}
      `);
  }
  // Retirement or stale sampling removes gauges; slot reuse keeps cumulative GC counts.
  metrics.record(
    memorySample({
      workerHeaps: [
        heap("code-mode-node.worker.js", 50, 100, {
          workerSlot: 1,
          external: 0,
          arrayBuffers: 0,
        }),
        heap("sqlite-store.worker.js", 10, 20, { external: 25 }),
      ],
    }),
  );
  const after = metrics.render();
  expectExcludes(
    after,
    "openclaw_process_anonymous_memory_bytes",
    'openclaw_code_mode_worker_heap_bytes{kind="limit"',
    'openclaw_code_mode_worker_heap_bytes{kind="used",slot="2"}',
    'openclaw_worker_array_buffers_bytes{script="sqlite-store.worker.js"}',
  );
  expectMetrics(after)(`
      openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 50
      openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 0
      openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 0
      openclaw_worker_external_bytes{script="sqlite-store.worker.js"} 25
      openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2
    `);
  for (const kind of ["external", "array_buffers"]) {
    expect(after).toContain(`openclaw_code_mode_worker_memory_bytes{kind="${kind}",slot="1"} 0\n`);
    expect(after).not.toContain(`openclaw_code_mode_worker_memory_bytes{kind="${kind}",slot="2"}`);
  }
  metrics.record(memorySample());
  expectExcludes(
    metrics.render(),
    "openclaw_code_mode_worker_heap_bytes",
    "openclaw_code_mode_worker_memory_bytes",
    "openclaw_worker_external_bytes",
    "openclaw_worker_array_buffers_bytes",
  );
});

it("does not recount cumulative worker traffic on repeated samples", ({ metrics }) => {
  const sample = memorySample({
    workerMessages: [
      {
        kind: "sqlite_reply" as const,
        direction: "from_worker" as const,
        messages: 4,
        payloadBytes: 1234,
        unmeasuredMessages: 2,
      },
    ],
  });
  metrics.record(sample, untrusted);
  expect(metrics.render()).not.toContain("openclaw_worker_messages_total");
  metrics.record(sample);
  metrics.record(sample);
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
});

it("exports isolate and native memory plus bounded successful spawn counts", ({ metrics }) => {
  const workerLifecycle = [
    {
      script: "sqlite-store.worker.js",
      started: 5,
      retired: [{ reason: "idle_timeout", count: 2 }],
    },
  ];
  metrics.record(
    memorySample({
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
      workerLifecycle,
      workerHeaps: [
        heap("sqlite-store.worker.js", 100, 200, {
          heapSpaces: [
            { space_name: "old_space", space_used_size: 60 },
            { space_name: "code_space", space_used_size: 40 },
          ],
        }),
        heap("sqlite-store.worker.js", 150, 200, {
          heapSpaces: [
            { space_name: "old_space", space_used_size: 120 },
            { space_name: "code_space", space_used_size: 30 },
            { space_name: "future_v8_space", space_used_size: 0 },
          ],
        }),
      ],
      workerMemoryMissing: [
        { script: "sqlite-store.worker.js", threadId: 3, reason: "pending" },
        { script: "other", threadId: 4, reason: "unavailable" },
      ],
    }),
  );
  for (const count of [2, 3]) {
    metrics.record(spawn("node", count));
  }
  metrics.record(spawn("node", 1, "sqlite.scoped-read.broker"));
  for (const [operation, count] of [
    ["repository.identities", 4],
    ["checkout.diff", 2],
  ] as const) {
    metrics.record(spawn("git", count, operation));
  }
  const rendered = metrics.render();
  expectMetrics(rendered)(`
      openclaw_memory_bytes{kind="rss"} 1000
      openclaw_memory_bytes{kind="heap_total"} 500
      openclaw_memory_bytes{kind="heap_used"} 300
      openclaw_memory_bytes{kind="external"} 200
      openclaw_memory_bytes{kind="array_buffers"} 100
      openclaw_memory_bytes{kind="worker_heap_total"} 400
      openclaw_memory_bytes{kind="worker_heap_used"} 250
      openclaw_worker_count 4
      openclaw_worker_heap_sampled_count 2
      openclaw_worker_count{script="sqlite-store.worker.js"} 3
      openclaw_worker_heap_sampled_count{script="sqlite-store.worker.js"} 2
      openclaw_worker_count{script="other"} 1
      openclaw_worker_heap_sampled_count{script="other"} 0
      openclaw_worker_heap_used_bytes{script="sqlite-store.worker.js"} 250
      openclaw_worker_heap_space_used_bytes{script="sqlite-store.worker.js",space="old_space"} 180
      openclaw_worker_heap_space_used_bytes{script="sqlite-store.worker.js",space="code_space"} 70
      openclaw_worker_heap_space_used_bytes{script="sqlite-store.worker.js",space="future_v8_space"} 0
      openclaw_child_process_spawn_total{family="node",operation="none"} 5
      openclaw_child_process_spawn_total{family="node",operation="sqlite.scoped-read.broker"} 1
      openclaw_child_process_spawn_total{family="git",operation="repository.identities"} 4
      openclaw_child_process_spawn_total{family="git",operation="checkout.diff"} 2
      openclaw_worker_started_total{script="sqlite-store.worker.js"} 5
      openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2
    `);
  for (const space of ["old_space", "future_v8_space"]) {
    expectMetrics(rendered)(`
        openclaw_heap_space_bytes{space="${space}",stat="used"} 101
        openclaw_heap_space_bytes{space="${space}",stat="size"} 202
        openclaw_heap_space_bytes{space="${space}",stat="available"} 0
        openclaw_heap_space_bytes{space="${space}",stat="physical"} 303
      `);
  }
  expect(metrics.render()).toBe(rendered);
  expect(rendered).not.toContain('openclaw_worker_heap_used_bytes{script="other"}');
  expect(rendered).not.toContain('openclaw_worker_heap_space_used_bytes{script="other"');
  for (const { count, workerHeaps, present, absent } of [
    {
      count: 1,
      workerHeaps: [heap("other", 50, 100)],
      present: `openclaw_worker_count{script="other"} 1
        openclaw_worker_heap_sampled_count{script="other"} 1
        openclaw_worker_heap_used_bytes{script="other"} 50
        openclaw_worker_started_total{script="sqlite-store.worker.js"} 5
        openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2`,
      absent: [
        "openclaw_heap_space_bytes",
        "openclaw_worker_heap_space_used_bytes",
        'openclaw_worker_heap_used_bytes{script="sqlite-store',
        'openclaw_worker_count{script="sqlite-store',
        'openclaw_worker_heap_sampled_count{script="sqlite-store',
      ],
    },
    {
      count: 0,
      workerHeaps: [],
      present: `openclaw_worker_count 0
        openclaw_worker_heap_sampled_count 0
        openclaw_worker_started_total{script="sqlite-store.worker.js"} 5`,
      absent: [
        "openclaw_worker_heap_used_bytes",
        "openclaw_worker_count{",
        "openclaw_worker_heap_sampled_count{",
      ],
    },
  ]) {
    const sample = memorySample({
      workerCount: count,
      workerHeapSampledCount: count,
      workerHeaps,
      workerLifecycle,
    });
    const before = metrics.render();
    metrics.record(sample, untrusted);
    expect(metrics.render()).toBe(before);
    metrics.record(sample);
    expectMetrics(metrics.render())(present);
    expectExcludes(metrics.render(), ...absent);
  }
});

it("retains window durations and bounded GC labels across scrapes", async ({ metrics }) => {
  await withMetricsServer(metrics, async (url) => {
    const scrape = async () => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      return await response.text();
    };
    const firstWindow = windowSample(2_000, 1_250);
    // Scrapes cannot publish a producer's window before diagnostics delivers it.
    const beforeDelivery = await scrape();
    expect(beforeDelivery).not.toContain("openclaw_gateway_event_loop_");
    expect(await scrape()).toBe(beforeDelivery);
    metrics.record(firstWindow);
    metrics.record(gc(1_250, { kind: "scavenge", thread: "main" }));
    const first = await scrape();
    expectMetrics(first)(`
        openclaw_gateway_event_loop_delay_max_seconds_count 1
        openclaw_gateway_event_loop_delay_max_seconds_sum 1.25
        openclaw_gateway_event_loop_observed_seconds_total 2
        openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 1
      `);
    expect(await scrape()).toBe(first);
    metrics.record(windowSample(8_000, 20), internal);
    metrics.record(gc(20, { kind: "scavenge", thread: "main" }), internal);
    metrics.record(gc(99_000), untrusted);
    metrics.record(windowSample(99_000, 99_000), untrusted);
    const second = await scrape();
    expectMetrics(second)(`
        openclaw_gateway_event_loop_delay_max_seconds_bucket{le="1"} 1
        openclaw_gateway_event_loop_delay_max_seconds_bucket{le="2.5"} 2
        openclaw_gateway_event_loop_delay_max_seconds_count 2
        openclaw_gateway_event_loop_delay_max_seconds_sum 1.27
        openclaw_gateway_event_loop_observed_seconds_total 10
        openclaw_gc_duration_seconds_bucket{kind="scavenge",le="1",reason="other",thread="main"} 1
        openclaw_gc_duration_seconds_bucket{kind="scavenge",le="2.5",reason="other",thread="main"} 2
        openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 2
        openclaw_gc_duration_seconds_sum{kind="scavenge",reason="other",thread="main"} 1.27
      `);
    expect(await scrape()).toBe(second);
    metrics.record(windowSample(1_000, 0));
    const third = await scrape();
    expectMetrics(third)(`
        openclaw_gateway_event_loop_delay_max_seconds_bucket{le="0.005"} 1
        openclaw_gateway_event_loop_delay_max_seconds_count 3
        openclaw_gateway_event_loop_delay_max_seconds_sum 1.27
        openclaw_gateway_event_loop_observed_seconds_total 11
      `);
    expect(await scrape()).toBe(third);
    metrics.record(gc(8, { kind: "mark_sweep_compact", thread: "sqlite-store.worker.js" }));
    const workerSample = await scrape();
    expectMetrics(workerSample)(`
        openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="other",thread="sqlite-store.worker.js"} 1
        openclaw_gc_duration_seconds_sum{kind="mark_sweep_compact",reason="other",thread="sqlite-store.worker.js"} 0.008
        openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 2
      `);
  });
});

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
    expect(metrics.render()).toContain("openclaw_prometheus_series_dropped_total 2153");
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

it("bounds worker queue and service populations independently of request count", ({ metrics }) => {
  const event = { ...worker, phase: "queued" as const, queueDepth: 2 };

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
    expectMetrics(rendered)(`
      openclaw_worker_${name}_seconds_count{kind="sqlite_writer",request_class="transcripts"} 1000
      openclaw_worker_${name}_seconds_sum{kind="sqlite_writer",request_class="transcripts"} ${sum}
    `);
  }
  const lines = rendered.split("\n");
  expect(lines.filter((line) => line.startsWith("# TYPE openclaw_worker_"))).toHaveLength(3);
  // Sixteen finite buckets, +Inf, sum and count per histogram, plus the gauge.
  expect(lines.filter((line) => line.startsWith("openclaw_worker_"))).toHaveLength(39);
  expect(rendered).not.toContain("series_dropped");
});

it("omits missing and invalid SQLite request phase intervals", ({ metrics }) => {
  const event = {
    ...worker,
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
  const phases = ["dispatch", "delivery", "input", "prepare", "execute", "result", "reply"];
  for (const [index, phase] of phases.entries()) {
    const labels = `{kind="sqlite_writer",phase="${phase}",request_class="transcripts"}`;
    expectMetrics(rendered)(`
      openclaw_worker_request_phase_seconds_sum${labels} ${index + 1}
      openclaw_worker_request_phase_seconds_count${labels} ${phase === "dispatch" ? 2 : 1}
    `);
  }
  expectMetrics(rendered)(`
    openclaw_worker_request_seconds_sum{kind="sqlite_writer",request_class="transcripts"} 28
    openclaw_worker_request_phase_seconds_bucket{kind="sqlite_writer",le="0.005",phase="dispatch",request_class="transcripts"} 1
  `);
  expect(
    rendered
      .split("\n")
      .filter((line) => line.startsWith("openclaw_worker_request_phase_seconds_count")),
  ).toHaveLength(7);
});
