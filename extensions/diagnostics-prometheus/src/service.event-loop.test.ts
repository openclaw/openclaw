import { expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import {
  expectMetrics,
  expectExcludes,
  createMetricsHarness,
  type TrustedExporterInternalDiagnostics,
  untrusted,
} from "./service.test-helpers.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

const memoryDefaults = {
  rssBytes: 1000,
  heapTotalBytes: 500,
  heapUsedBytes: 300,
  externalBytes: 200,
  arrayBuffersBytes: 100,
};
function memorySample(
  memory: Partial<Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>["memory"]>,
) {
  return { type: "diagnostic.memory.sample" as const, memory: { ...memoryDefaults, ...memory } };
}

it("keeps the latest major-GC heap and observation time through scavenges", () => {
  using metrics = createMetricsHarness();
  expect(metrics.render()).not.toContain("openclaw_heap_used_after_major_gc");
  for (const thread of ["main", "sqlite-store.worker.js"]) {
    const sample = {
      type: "diagnostic.gc" as const,
      thread,
      durationMs: 1,
      heapUsedAfterMajorGcBytes: 1024,
      heapUsedAfterMajorGcTimestampSeconds: 1700000000,
    };
    metrics.record({ ...sample, kind: "mark_sweep_compact" });
    metrics.record({ ...sample, kind: "mark_sweep_compact", heapUsedAfterMajorGcBytes: 512 });
    metrics.record({
      ...sample,
      kind: "scavenge",
      heapUsedAfterMajorGcBytes: 9999,
      heapUsedAfterMajorGcTimestampSeconds: 1700000010,
    });
    expectMetrics(metrics.render())(`openclaw_heap_used_after_major_gc_bytes{thread="${thread}"} 512
openclaw_heap_used_after_major_gc_timestamp_seconds{thread="${thread}"} 1700000000`);
  }
});

it("exports worst-isolate headroom and retires missing baselines", () => {
  using metrics = createMetricsHarness();
  const memory = { heapSizeLimitBytes: 1000, oldGenerationAfterGcBytes: 200 };
  const heap = (
    script: string,
    heapUsed: number,
    heapSizeLimitBytes: number,
    oldGenerationAfterGcBytes: number,
  ) => ({ script, heapUsed, heapTotal: 1000, heapSizeLimitBytes, oldGenerationAfterGcBytes });
  metrics.record(
    memorySample({
      ...memory,
      workerHeaps: [
        { ...heap("sqlite-store.worker.js", 900, 1000, 800), threadId: 101 },
        heap("sqlite-store.worker.js", 100, 2000, 50),
        heap("other", 0, 500, 0),
      ],
    }),
  );
  const rendered = metrics.render();
  expectMetrics(rendered)(`openclaw_heap_size_limit_bytes{thread="sqlite-store.worker.js"} 1000
openclaw_heap_used_ratio{thread="sqlite-store.worker.js"} 0.9
openclaw_heap_old_generation_after_gc_bytes{thread="sqlite-store.worker.js"} 800
openclaw_heap_old_generation_after_gc_ratio{thread="sqlite-store.worker.js"} 0.8
openclaw_heap_used_ratio{thread="main"} 0.3
openclaw_heap_old_generation_after_gc_ratio{thread="other"} 0`);
  expect(rendered).not.toMatch(/threadId|thread="101"/);
  metrics.record(
    memorySample({
      ...memory,
      oldGenerationAfterGcBytes: undefined,
      workerHeaps: [{ script: "other", heapUsed: 10, heapTotal: 20, heapSizeLimitBytes: 100 }],
    }),
  );
  const next = metrics.render();
  expectExcludes(next, "openclaw_heap_old_generation_after_gc", 'thread="sqlite-store.worker.js"');
  expectMetrics(next)('openclaw_heap_used_ratio{thread="other"} 0.1');
  metrics.record(memorySample({ ...memory, heapSizeLimitBytes: undefined }));
  expect(metrics.render()).not.toContain("openclaw_heap_used_ratio");
});

it("counts attributed main-thread stalls by task and reports bounded-buffer losses", () => {
  using metrics = createMetricsHarness();
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
  expectMetrics(
    rendered,
  )(`openclaw_gateway_main_thread_stall_seconds_bucket{le="0.25",task="rpc.sessions.list"} 1
openclaw_gateway_main_thread_stall_seconds_bucket{le="1",task="rpc.sessions.list"} 2`);
  expectMetrics(
    rendered,
  )(`openclaw_gateway_main_thread_stall_seconds_count{task="rpc.sessions.list"} 2
openclaw_gateway_main_thread_stall_seconds_sum{task="rpc.sessions.list"} 1
openclaw_gateway_main_thread_stall_seconds_count{task="timer.cron"} 1
openclaw_gateway_main_thread_stall_seconds_count{task="unknown"} 1`);
  expect(rendered).not.toContain("/private/session/path");
  expectMetrics(rendered)(`openclaw_gateway_main_thread_stalls_dropped_total 3`);
  metrics.record({ type: "gateway.main_thread.stall", stalls: [], dropped: 2 });
  expectMetrics(metrics.render())(`openclaw_gateway_main_thread_stalls_dropped_total 5`);
});

it("separates Code Mode isolate GC and replaces live memory gauges at each sample", () => {
  using metrics = createMetricsHarness();
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
  metrics.record(
    memorySample({
      anonymousRssBytes: 700,
      anonymousSwapBytes: 0,
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
    }),
  );
  const before = metrics.render();
  expectMetrics(before)(`openclaw_process_anonymous_memory_bytes{kind="rss"} 700
openclaw_process_anonymous_memory_bytes{kind="swap"} 0
openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2
openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="2",thread="code-mode-node.worker.js"} 1
openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 900
openclaw_code_mode_worker_heap_bytes{kind="limit",slot="1"} 1024
openclaw_worker_heap_used_bytes{script="code-mode-node.worker.js"} 1010
openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 400
openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 120`);
  expectMetrics(before)(`openclaw_code_mode_worker_memory_bytes{kind="external",slot="1"} 300
openclaw_code_mode_worker_memory_bytes{kind="array_buffers",slot="2"} 20`);
  // Retirement or stale sampling removes gauges; slot reuse keeps cumulative GC counts.
  metrics.record(
    memorySample({
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
    }),
  );
  const after = metrics.render();
  expect(after).not.toContain("openclaw_process_anonymous_memory_bytes");
  expectMetrics(after)(`openclaw_code_mode_worker_heap_bytes{kind="used",slot="1"} 50`);
  expect(after).not.toContain('openclaw_code_mode_worker_heap_bytes{kind="limit"');
  expect(after).not.toContain('openclaw_code_mode_worker_heap_bytes{kind="used",slot="2"}');
  expectMetrics(after)(`openclaw_worker_external_bytes{script="code-mode-node.worker.js"} 0
openclaw_worker_array_buffers_bytes{script="code-mode-node.worker.js"} 0
openclaw_worker_external_bytes{script="sqlite-store.worker.js"} 25`);
  expect(after).not.toContain(
    'openclaw_worker_array_buffers_bytes{script="sqlite-store.worker.js"}',
  );
  expectMetrics(after)(`openclaw_code_mode_worker_memory_bytes{kind="external",slot="1"} 0
openclaw_code_mode_worker_memory_bytes{kind="array_buffers",slot="1"} 0`);
  expectExcludes(
    after,
    'openclaw_code_mode_worker_memory_bytes{kind="external",slot="2"}',
    'openclaw_code_mode_worker_memory_bytes{kind="array_buffers",slot="2"}',
  );
  expectMetrics(after)(
    `openclaw_gc_duration_seconds_count{kind="mark_sweep_compact",reason="forced",slot="1",thread="code-mode-node.worker.js"} 2`,
  );
  metrics.record(memorySample({}));
  expect(metrics.render()).not.toContain("openclaw_code_mode_worker_heap_bytes");
  expect(metrics.render()).not.toContain("openclaw_code_mode_worker_memory_bytes");
  expect(metrics.render()).not.toContain("openclaw_worker_external_bytes");
  expect(metrics.render()).not.toContain("openclaw_worker_array_buffers_bytes");
});

it("retains cumulative worker work, messages, selections and GC across retirement", () => {
  using metrics = createMetricsHarness();
  const worker = {
    workerClass: "compute" as const,
    script: "provider-prompt-state.worker.js",
    tasksCompleted: 3,
    heapUsedHighWaterBytes: 4000,
    gc: [{ kind: "scavenge" as const, count: 7, durationMs: 15, reclaimedBytes: 9000 }],
  };
  for (const retired of [false, true]) {
    const current = retired
      ? {
          ...worker,
          tasksCompleted: 5,
          heapUsedHighWaterBytes: 5000,
          gc: [{ kind: "scavenge" as const, count: 9, durationMs: 20, reclaimedBytes: 12000 }],
        }
      : worker;
    const sample = memorySample({
      workerCount: retired ? 0 : 1,
      workerTaskMetrics: [current],
      workerMessages: [
        {
          kind: "sqlite_reply" as const,
          direction: "from_worker" as const,
          messages: 4,
          payloadBytes: 1234,
          payloadBytesByRequestClass: { "audit.writer.process": 1000, other: 234 },
          unmeasuredMessages: 2,
        },
        {
          kind: "authority",
          direction: "from_worker",
          messages: 3,
          payloadBytes: 567,
          payloadBytesByRequestClass: { "session.actor.completeTurn": 500, other: 67 },
          unmeasuredMessages: 1,
        },
        {
          kind: "authority",
          direction: "to_worker",
          messages: 1,
          payloadBytes: 0,
          unmeasuredMessages: 1,
        },
      ],
      sessionRowSelections: {
        selections: [{ kind: "parent" as const, task: "control-ui-pr", calls: 4, rows: 12 }],
        resets: 2,
        partitions: [{ task: "sessions.list", hits: 63, misses: 1 }],
        partitionRevisions: [{ reason: "metadata", changes: 3 }],
        materialization: {
          created: 0,
          reused: 0,
          rebuilt: 0,
          skipped: 0,
          deepComparisons: 0,
          sampledFirstDifferences: {},
        },
      },
    });
    if (!retired) {
      metrics.record(sample, untrusted);
      expectExcludes(
        metrics.render(),
        "openclaw_worker_messages_total",
        "openclaw_session_row_selections_total",
      );
    }
    metrics.record(sample);
    metrics.record(sample);
    if (retired) {
      metrics.record(memorySample({ workerCount: 0 }));
    }
    const labels = 'script="provider-prompt-state.worker.js",worker_class="compute"';
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_worker_tasks_completed_total{${labels}} ${current.tasksCompleted}
openclaw_worker_heap_used_high_water_bytes{${labels}} ${current.heapUsedHighWaterBytes}
openclaw_worker_gc_collections_total{kind="scavenge",${labels}} ${current.gc[0]!.count}
openclaw_worker_gc_reclaimed_bytes_total{kind="scavenge",${labels}} ${current.gc[0]!.reclaimedBytes}
openclaw_worker_gc_duration_seconds_total{kind="scavenge",${labels}} ${current.gc[0]!.durationMs / 1000}`);
  }
  expectMetrics(metrics.render())(`openclaw_worker_count 0
openclaw_worker_messages_total{direction="from_worker",kind="sqlite_reply"} 4
openclaw_worker_message_payload_bytes_total{direction="from_worker",kind="sqlite_reply",request_class="audit.writer.process"} 1000
openclaw_worker_message_payload_bytes_total{direction="from_worker",kind="sqlite_reply",request_class="other"} 234
openclaw_worker_message_unmeasured_total{direction="from_worker",kind="sqlite_reply"} 2
openclaw_worker_message_payload_bytes_total{direction="from_worker",kind="authority",request_class="session.actor.completeTurn"} 500
openclaw_worker_message_payload_bytes_total{direction="from_worker",kind="authority",request_class="other"} 67
openclaw_worker_message_payload_bytes_total{direction="to_worker",kind="authority",request_class="other"} 0
openclaw_worker_messages_total{direction="from_worker",kind="authority"} 3
openclaw_worker_message_unmeasured_total{direction="from_worker",kind="authority"} 1
openclaw_session_row_selections_total{kind="parent",task="control-ui-pr"} 4
openclaw_session_row_selection_rows_total{kind="parent",task="control-ui-pr"} 12
openclaw_session_row_selection_resets_total 2
openclaw_session_row_partition_cache_total{outcome="hit",task="sessions.list"} 63
openclaw_session_row_partition_cache_total{outcome="miss",task="sessions.list"} 1
openclaw_session_row_partition_revisions_total{reason="metadata"} 3`);
});

it("exports native memory, missing workers, lifecycle totals and attributed spawns", () => {
  using metrics = createMetricsHarness();
  const script = "sqlite-store.worker.js";
  const lifecycle = [
    { script, started: 5, retired: [{ reason: "idle_timeout" as const, count: 2 }] },
  ];
  const worker = { script, heapUsed: 100, heapTotal: 200 };
  metrics.record(
    memorySample({
      heapSpaces: [
        {
          space_name: "old_space",
          space_used_size: 101,
          space_size: 202,
          space_available_size: 0,
          physical_space_size: 303,
        },
      ],
      workerHeapTotalBytes: 400,
      workerHeapUsedBytes: 250,
      workerCount: 4,
      workerHeapSampledCount: 2,
      workerLifecycle: lifecycle,
      workerHeaps: [
        { ...worker, heapSpaces: [{ space_name: "old_space", space_used_size: 60 }] },
        {
          ...worker,
          heapUsed: 150,
          heapSpaces: [
            { space_name: "old_space", space_used_size: 120 },
            { space_name: "future_v8_space", space_used_size: 0 },
          ],
        },
      ],
      workerMemoryMissing: [
        { script, threadId: 3, reason: "pending" },
        { script: "other", threadId: 4, reason: "unavailable" },
      ],
    }),
  );
  const rendered = metrics.render();
  expectMetrics(rendered)(`openclaw_memory_bytes{kind="rss"} 1000
openclaw_heap_space_bytes{space="old_space",stat="used"} 101
openclaw_heap_space_bytes{space="old_space",stat="available"} 0`);
  expectMetrics(rendered)(`openclaw_worker_count 4
openclaw_worker_heap_sampled_count 2
openclaw_worker_count{script="sqlite-store.worker.js"} 3
openclaw_worker_heap_sampled_count{script="sqlite-store.worker.js"} 2
openclaw_worker_count{script="other"} 1
openclaw_worker_heap_sampled_count{script="other"} 0
openclaw_worker_heap_used_bytes{script="sqlite-store.worker.js"} 250
openclaw_worker_heap_space_used_bytes{script="sqlite-store.worker.js",space="old_space"} 180
openclaw_worker_heap_space_used_bytes{script="sqlite-store.worker.js",space="future_v8_space"} 0`);
  expect(rendered).not.toContain('openclaw_worker_heap_used_bytes{script="other"}');
  metrics.record(
    memorySample({
      workerCount: 0,
      workerHeapSampledCount: 0,
      workerHeaps: [],
      workerLifecycle: lifecycle,
    }),
  );
  const retired = metrics.render();
  expectExcludes(
    retired,
    "openclaw_heap_space_bytes",
    "openclaw_worker_heap_space_used_bytes",
    "openclaw_worker_heap_used_bytes",
    "openclaw_worker_count{",
    "openclaw_worker_heap_sampled_count{",
  );
  expectMetrics(retired)(`openclaw_worker_count 0
openclaw_worker_heap_sampled_count 0
openclaw_worker_started_total{script="sqlite-store.worker.js"} 5
openclaw_worker_retired_total{reason="idle_timeout",script="sqlite-store.worker.js"} 2`);
  for (const [family, operation, count] of [
    ["node", undefined, 2],
    ["node", undefined, 3],
    ["node", "sqlite.scoped-read.broker", 1],
    ["git", "repository.identities", 4],
  ] as const) {
    metrics.record({
      type: "diagnostic.child_process.spawn",
      family,
      operation,
      count,
      intervalMs: 60_000,
    });
  }
  expectMetrics(
    metrics.render(),
  )(`openclaw_child_process_spawn_total{family="node",operation="none"} 5
openclaw_child_process_spawn_total{family="node",operation="sqlite.scoped-read.broker"} 1
openclaw_child_process_spawn_total{family="git",operation="repository.identities"} 4`);
});

it("accumulates trusted and internal runtime windows without recounting scrapes", () => {
  using metrics = createMetricsHarness();
  const recordWindow = (
    intervalMs: number,
    delayMaxMs: number,
    metadata: Parameters<Parameters<TrustedExporterInternalDiagnostics["onEvent"]>[0]>[1] = {
      trusted: true,
    },
  ) => {
    metrics.record({ type: "gateway.event_loop.sample", intervalMs, delayMaxMs }, metadata);
    metrics.record(
      { type: "diagnostic.gc", kind: "scavenge", thread: "main", durationMs: delayMaxMs },
      metadata,
    );
  };
  recordWindow(2000, 1250);
  recordWindow(8000, 20, { trusted: false, internal: true });
  recordWindow(99000, 99000, untrusted);
  metrics.record({ type: "gateway.event_loop.sample", intervalMs: 1000, delayMaxMs: 0 });
  const rendered = metrics.render();
  expectMetrics(rendered)(`openclaw_gateway_event_loop_delay_max_seconds_count 3
openclaw_gateway_event_loop_delay_max_seconds_sum 1.27
openclaw_gateway_event_loop_delay_max_seconds_bucket{le="0.005"} 1
openclaw_gateway_event_loop_observed_seconds_total 11
openclaw_gc_duration_seconds_count{kind="scavenge",reason="other",thread="main"} 2
openclaw_gc_duration_seconds_sum{kind="scavenge",reason="other",thread="main"} 1.27`);
  expect(metrics.render()).toBe(rendered);
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
    expect(initial).toContain(info);
    identity.processInstanceId = "a-different-value-after-service-start";
    expect(metrics.render()).toBe(initial);
    for (let index = 0; index < 2100; index += 1) {
      metrics.record({ type: "gateway.rpc", method: `method.${index}`, phase: "received" });
    }
    expect(metrics.render()).toContain(info);
    expect(metrics.render()).toMatch(/openclaw_prometheus_series_dropped_total [1-9][0-9]*\n/);
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

it("exports completed SQLite request phases without inventing missing or invalid intervals", () => {
  using metrics = createMetricsHarness();
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
  metrics.record({
    ...event,
    phase: "queued",
    queueDepth: 2,
    durationMs: undefined,
    timing: undefined,
  });
  expectMetrics(metrics.render())('openclaw_worker_queue_depth{kind="sqlite_writer"} 2');
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
  expectMetrics(rendered)('openclaw_worker_queue_depth{kind="sqlite_writer"} 0');
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
  expectMetrics(
    rendered,
  )(`openclaw_worker_request_seconds_sum{kind="sqlite_writer",request_class="transcripts"} 28
openclaw_worker_request_phase_seconds_bucket{kind="sqlite_writer",le="0.005",phase="dispatch",request_class="transcripts"} 1`);
  expect(
    rendered
      .split("\n")
      .filter((line) => line.startsWith("openclaw_worker_request_phase_seconds_count")),
  ).toHaveLength(7);
});
