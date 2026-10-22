import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  baseEvent,
  createMetricsHarness,
  scrapeMetrics,
  untrusted,
} from "./service.test-helpers.js";

// mock-isolation: Keep Gateway runtime initialization outside the fixture; scrape as a read-authorized operator.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

it("exports trusted WebSocket event totals and the current operator socket count", () => {
  const metrics = createMetricsHarness();
  try {
    metrics.record({ type: "gateway.ws.connections", operators: 2 });
    metrics.record({ type: "gateway.ws.event", event: "chat", count: 2, bytes: 256 });
    metrics.record({ type: "gateway.ws.event", event: "chat", count: 1, bytes: 128 });
    metrics.record({ type: "gateway.ws.event", event: "other", count: 1, bytes: 64 });
    metrics.record({ type: "gateway.ws.connections", operators: 0 });
    for (const metadata of [untrusted, { trusted: false, internal: true }]) {
      metrics.record(
        { type: "gateway.ws.event", event: "private-untrusted", count: 99, bytes: 999 },
        metadata,
      );
      metrics.record({ type: "gateway.ws.connections", operators: 99 }, metadata);
    }

    const rendered = metrics.render();
    expect(rendered).toContain("# TYPE openclaw_gateway_ws_events_total counter\n");
    expect(rendered).toContain("# TYPE openclaw_gateway_ws_event_bytes_total counter\n");
    expect(rendered).toContain("# TYPE openclaw_gateway_ws_operator_connections gauge\n");
    expect(rendered.split("\n").filter((line) => line.startsWith("openclaw_gateway_ws_"))).toEqual([
      'openclaw_gateway_ws_event_bytes_total{event="chat"} 384',
      'openclaw_gateway_ws_event_bytes_total{event="other"} 64',
      'openclaw_gateway_ws_events_total{event="chat"} 3',
      'openclaw_gateway_ws_events_total{event="other"} 1',
      "openclaw_gateway_ws_operator_connections 0",
    ]);
  } finally {
    metrics.stop();
  }
});

it("exports codec bytes separately and cumulative raw frame-size buckets", () => {
  const metrics = createMetricsHarness();
  const observation = {
    type: "gateway.ws.event",
    event: "chat",
    count: 3,
    bytes: 1_536,
    frameBytes: {
      "256": 0,
      "512": 2,
      "1024": 3,
      "2048": 3,
      "4096": 3,
      "8192": 3,
      "16384": 3,
      "65536": 3,
      "+Inf": 3,
    },
  } as const;
  try {
    metrics.record(observation);
    metrics.record({ type: "gateway.ws.event", event: "chat", count: 0, bytes: 0, wireBytes: 600 });
    metrics.record({
      type: "gateway.ws.event",
      event: "chat",
      count: 0,
      bytes: 0,
      frameBytes: { "512": 0 },
    });
    metrics.record({
      type: "gateway.ws.event",
      event: "chat",
      count: 1,
      bytes: 70_000,
      wireBytes: 700,
      frameBytes: { "+Inf": 1 },
    });
    metrics.record({ type: "gateway.ws.event", event: "other", count: 1, bytes: 64 });
    metrics.record({ ...observation, wireBytes: 999 }, untrusted);
    const rendered = metrics.render();
    expect(rendered).toContain('openclaw_gateway_ws_events_total{event="chat"} 4');
    expect(rendered).toContain('openclaw_gateway_ws_event_bytes_total{event="chat"} 71536');
    expect(rendered).toContain('openclaw_gateway_ws_event_wire_bytes_total{event="chat"} 1300');
    expect(rendered).not.toContain('openclaw_gateway_ws_event_wire_bytes_total{event="other"}');
    expect(rendered).not.toContain('openclaw_gateway_ws_event_frame_bytes{event="other"');
    for (const [le, count] of [
      ["256", 0],
      ["512", 2],
      ["1024", 3],
      ["2048", 3],
      ["4096", 3],
      ["8192", 3],
      ["16384", 3],
      ["65536", 3],
      ["+Inf", 4],
    ]) {
      expect(rendered).toContain(
        `openclaw_gateway_ws_event_frame_bytes{event="chat",le="${le}"} ${count}`,
      );
    }
  } finally {
    metrics.stop();
  }
});

it("exports session traffic attribution while keeping aggregate event labels unchanged", () => {
  const metrics = createMetricsHarness();
  try {
    for (const [event, reason] of [
      ["sessions.changed", "agent.run.started"],
      ["session.message", "assistant"],
    ] as const) {
      for (const delivery of ["subscribed", "roster"] as const) {
        const observation = {
          type: "gateway.ws.event",
          event,
          count: 2,
          bytes: 256,
          sessionEvent: { reason, delivery },
        } as const;
        metrics.record(observation);
        metrics.record({ ...observation, count: 1, bytes: 128 });
        metrics.record(observation, untrusted);
      }
    }
    const rendered = metrics.render();
    for (const [event, reason] of [
      ["sessions.changed", "agent.run.started"],
      ["session.message", "assistant"],
    ]) {
      expect(rendered).toContain(`openclaw_gateway_ws_events_total{event="${event}"} 6`);
      expect(rendered).toContain(`openclaw_gateway_ws_event_bytes_total{event="${event}"} 768`);
      for (const delivery of ["subscribed", "roster"]) {
        const labels = `delivery="${delivery}",event="${event}",reason="${reason}"`;
        expect(rendered).toContain(`openclaw_gateway_ws_session_event_frames_total{${labels}} 3`);
        expect(rendered).toContain(`openclaw_gateway_ws_session_event_bytes_total{${labels}} 384`);
      }
    }
  } finally {
    metrics.stop();
  }
});

it("exports presence frame counts and bytes by delivery mode", () => {
  const metrics = createMetricsHarness();
  try {
    for (const presenceMode of ["delta", "reset", "legacy"] as const) {
      const observation = {
        type: "gateway.ws.event",
        event: "presence",
        count: 2,
        bytes: 256,
        presenceMode,
      } as const;
      metrics.record(observation);
      metrics.record({ ...observation, count: 1, bytes: 128 });
      metrics.record(observation, untrusted);
    }
    const rendered = metrics.render();
    expect(rendered).toContain('openclaw_gateway_ws_events_total{event="presence"} 9');
    expect(rendered).toContain('openclaw_gateway_ws_event_bytes_total{event="presence"} 1152');
    for (const mode of ["delta", "reset", "legacy"]) {
      expect(rendered).toContain(`openclaw_gateway_ws_presence_frames_total{mode="${mode}"} 3`);
      expect(rendered).toContain(`openclaw_gateway_ws_presence_bytes_total{mode="${mode}"} 384`);
    }
  } finally {
    metrics.stop();
  }
});

it("exports trusted session retention gauges and clears them on retirement", () => {
  const metrics = createMetricsHarness();
  const retentionLines = () =>
    metrics
      .render()
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("openclaw_sessions_list_retained_") ||
          line.startsWith("openclaw_session_event_rows_retained_"),
      );
  try {
    metrics.record({ type: "sessions.list.retention", views: 3, refs: 17, estimatedBytes: 3_504 });
    metrics.record({
      type: "sessions.event.retention",
      entries: 25_600,
      estimatedBytes: 24_985_600,
    });
    for (const metadata of [untrusted, { trusted: false, internal: true }]) {
      metrics.record(
        { type: "sessions.list.retention", views: 99, refs: 999, estimatedBytes: 99_999 },
        metadata,
      );
      metrics.record(
        { type: "sessions.event.retention", entries: 99_999, estimatedBytes: 99_999 },
        metadata,
      );
    }
    for (const suffix of ["views", "refs", "bytes"]) {
      expect(metrics.render()).toContain(
        `# TYPE openclaw_sessions_list_retained_${suffix} gauge\n`,
      );
    }
    for (const suffix of ["entries", "bytes"]) {
      expect(metrics.render()).toContain(
        `# TYPE openclaw_session_event_rows_retained_${suffix} gauge\n`,
      );
    }
    expect(retentionLines()).toEqual([
      "openclaw_session_event_rows_retained_bytes 24985600",
      "openclaw_session_event_rows_retained_entries 25600",
      "openclaw_sessions_list_retained_bytes 3504",
      "openclaw_sessions_list_retained_refs 17",
      "openclaw_sessions_list_retained_views 3",
    ]);
    metrics.record({ type: "sessions.list.retention", views: 0, refs: 0, estimatedBytes: 0 });
    metrics.record({ type: "sessions.event.retention", entries: 0, estimatedBytes: 0 });
    expect(retentionLines()).toEqual([
      "openclaw_session_event_rows_retained_bytes 0",
      "openclaw_session_event_rows_retained_entries 0",
      "openclaw_sessions_list_retained_bytes 0",
      "openclaw_sessions_list_retained_refs 0",
      "openclaw_sessions_list_retained_views 0",
    ]);
  } finally {
    metrics.stop();
  }
});

it("counts retired wire baselines by cause without accepting untrusted resets", () => {
  const metrics = createMetricsHarness();
  try {
    for (const cause of [
      "close",
      "delivery-lost",
      "generation",
      "evicted",
      "projection",
    ] as const) {
      metrics.record({ type: "sessions.event.rows.reset", cause, count: 3 });
      metrics.record({ type: "sessions.event.rows.reset", cause, count: 2 });
      for (const metadata of [untrusted, { trusted: false, internal: true }]) {
        metrics.record({ type: "sessions.event.rows.reset", cause, count: 99 }, metadata);
      }
    }
    const rendered = metrics.render();
    expect(rendered).toContain("# TYPE openclaw_session_event_rows_reset_total counter\n");
    expect(
      rendered.split("\n").filter((line) => line.startsWith("openclaw_session_event_rows_reset_")),
    ).toEqual([
      'openclaw_session_event_rows_reset_total{cause="close"} 5',
      'openclaw_session_event_rows_reset_total{cause="delivery-lost"} 5',
      'openclaw_session_event_rows_reset_total{cause="evicted"} 5',
      'openclaw_session_event_rows_reset_total{cause="generation"} 5',
      'openclaw_session_event_rows_reset_total{cause="projection"} 5',
    ]);
  } finally {
    metrics.stop();
  }
});

it("records terminal metrics without reading logs or private diagnostic content", async () => {
  const exporter = createDiagnosticsPrometheusExporter();
  const readPrivateContent = vi.fn(() => ({ toolInput: { text: "private tool input" } }));
  const readLogAttribute = vi.fn(() => "synthetic log attribute");
  const emitLog = () =>
    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "synthetic log",
      attributes: {
        get detail() {
          return readLogAttribute();
        },
      },
    });
  exporter.service.start({
    config: {},
    stateDir: "/tmp/openclaw-prometheus-test",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    internalDiagnostics: {
      emit() {},
      onEvent: onTrustedInternalDiagnosticEvent,
    },
  });
  try {
    emitLog();
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "synthetic",
        toolSource: "core",
        durationMs: 3,
      },
      {
        get toolContent() {
          return readPrivateContent();
        },
      },
    );
    await waitForDiagnosticEventsDrained();
    expect(scrapeMetrics(exporter.handler)).toContain(
      'openclaw_tool_execution_total{error_category="none",outcome="completed",params_kind="unknown",tool="synthetic",tool_owner="none",tool_source="core"} 1',
    );
    expect(readPrivateContent).not.toHaveBeenCalled();
    expect(readLogAttribute).not.toHaveBeenCalled();
    const logs = vi.fn();
    const stopLogs = onTrustedInternalDiagnosticEvent(logs, { include: ["log.record"] });
    try {
      emitLog();
      await waitForDiagnosticEventsDrained();
      expect(logs).toHaveBeenCalledOnce();
      expect(logs.mock.calls[0]?.[0].attributes).toEqual({ detail: "synthetic log attribute" });
      expect(readLogAttribute).toHaveBeenCalledOnce();
    } finally {
      stopLogs();
    }
  } finally {
    exporter.service.stop?.();
    await waitForDiagnosticEventsDrained();
  }
  expect(scrapeMetrics(exporter.handler)).toBe("");
});

it("exports production-shaped worker, WebSocket, and late RPC populations without drops", () => {
  const metrics = createMetricsHarness();
  expect(metrics.render()).not.toContain("openclaw_gc_duration_seconds");
  const queue = {
    ...baseEvent(),
    type: "queue.lane.dequeue" as const,
    lane: "main",
    queueSize: 1,
    waitMs: 10,
  };
  metrics.record(queue);
  // Worker/RPC startup traffic precedes the first completed run and memory sample.
  for (let index = 0; index < 400; index++) {
    metrics.record({
      type: "worker.request",
      kind: "sqlite_writer",
      requestClass: `request.${index}`,
      phase: "completed",
      queueDepth: 0,
      queueWaitMs: 1,
      durationMs: 7,
    });
  }
  // Cover 400 worker request/queue sets and 400 phase sets (57 complete + one partial).
  for (let index = 0; index < 58; index++) {
    metrics.record({
      type: "worker.request",
      kind: "sqlite_writer",
      requestClass: `request.${index}`,
      phase: "completed",
      queueDepth: 0,
      timing: {
        dispatched: 0,
        posted: 1,
        ...(index < 57
          ? {
              received: 2,
              inputReady: 3,
              executeStarted: 4,
              executeFinished: 5,
              replied: 6,
              replyReceived: 7,
            }
          : {}),
      },
    });
  }
  for (let index = 0; index < 200; index++) {
    metrics.record({
      type: "gateway.ws.event",
      event: `event.${index}`,
      count: 1,
      bytes: 256,
      wireBytes: 128,
      sessionEvent: { reason: "assistant", delivery: "subscribed" },
      frameBytes: {
        "256": 1,
        "512": 1,
        "1024": 1,
        "2048": 1,
        "4096": 1,
        "8192": 1,
        "16384": 1,
        "65536": 1,
        "+Inf": 1,
      },
    });
  }
  // RPC arrives after worker and WebSocket traffic; sessions.list is the last method.
  for (let index = 0; index < 170; index += 1) {
    const base = {
      ...baseEvent(),
      type: "gateway.rpc" as const,
      method: index === 169 ? "sessions.list" : `core.method.${index}`,
    };
    for (const event of [
      { ...base, phase: "received", clientKind: "control-ui" },
      { ...base, phase: "received", clientKind: "cli" },
      { ...base, phase: "response", outcome: "ok", durationMs: 10, responseBytes: 1024 },
      {
        ...base,
        phase: "handler",
        outcome: "returned",
        durationMs: 10,
        admissionMs: 1,
        heapDeltaBytes: -1024,
      },
      {
        ...base,
        phase: "dispatch",
        outcome: "returned",
        durationMs: 11,
        queueWaitMs: 1,
        response: "sent",
      },
    ] satisfies DiagnosticEventPayload[]) {
      metrics.record(event);
    }
  }
  metrics.record({ ...queue, queueSize: 2 });
  const existing = metrics.render();
  expect(existing).toContain('openclaw_queue_lane_size{lane="main"} 2');
  expect(existing).toContain('openclaw_queue_lane_wait_seconds_count{lane="main"} 2');

  metrics.record({ ...queue, lane: "later" });

  for (let index = 0; index < 64; index++) {
    const model = `model-${index}`;
    metrics.record({
      type: "run.completed",
      runId: `run-${index}`,
      model,
      outcome: "completed",
      durationMs: 10,
    });
    metrics.record({
      type: "harness.run.completed",
      runId: `run-${index}`,
      harnessId: "synthetic",
      model,
      outcome: "completed",
      durationMs: 10,
    });
    metrics.record({
      type: "model.call.completed",
      callId: `call-${index}`,
      provider: "synthetic",
      runId: `run-${index}`,
      model,
      durationMs: 10,
    });
    metrics.record({
      type: "model.usage",
      model,
      usage: { input: 10, output: 20 },
      durationMs: 10,
    });
    metrics.record({
      type: "tool.execution.completed",
      runId: `run-${index}`,
      toolCallId: `call-${index}`,
      toolName: `tool-${index}`,
      durationMs: 10,
    });
  }
  metrics.record({
    type: "diagnostic.phase.completed",
    name: "worktree.preparation",
    startedAt: 0,
    durationMs: 10,
    details: { kind: "managed", template: "warm", outcome: "returned" },
  });
  metrics.record({ type: "secret.egress", outcome: "forwarded", substituted: true });
  metrics.record({ type: "gateway.http.cancelled", source: "client" });
  const sample = {
    type: "diagnostic.memory.sample" as const,
    memory: {
      rssBytes: 1000,
      heapUsedBytes: 300,
      heapTotalBytes: 500,
      heapSizeLimitBytes: 1000,
      externalBytes: 20,
      arrayBuffersBytes: 10,
      workerCount: 12,
      workerHeaps: Array.from({ length: 12 }, (_, index) => ({
        script: `worker-${index % 8}.js`,
        workerSlot: index + 1,
        heapUsed: 100,
        heapTotal: 200,
        heapSizeLimitBytes: 1000,
      })),
      workerTaskMetrics: Array.from({ length: 100 }, (_, index) => ({
        workerClass: "compute" as const,
        script: `worker-${index}.js`,
        tasksCompleted: 3,
        heapUsedHighWaterBytes: 100,
        gc: [{ kind: "scavenge" as const, count: 7, durationMs: 15, reclaimedBytes: 9000 }],
      })),
    },
  };
  metrics.record(sample);
  // Rebuilding gauges must not donate their reserved slots to cumulative worker counters.
  metrics.record(sample);
  for (const kind of [
    "scavenge",
    "mark_sweep_compact",
    "incremental",
    "weak_processing",
  ] as const) {
    metrics.record({
      type: "diagnostic.gc",
      kind,
      reason: "other",
      thread: "main",
      durationMs: 20,
    });
    metrics.record({
      type: "diagnostic.gc",
      kind,
      reason: "other",
      thread: "main",
      durationMs: 30,
    });
    const labels = `kind="${kind}",reason="other",thread="main"`;
    const rendered = metrics.render();
    expect(rendered).toContain(`openclaw_gc_duration_seconds_count{${labels}} 2\n`);
    expect(rendered).toContain(`openclaw_gc_duration_seconds_sum{${labels}} 0.05\n`);
    expect(rendered).toContain(
      `openclaw_gc_duration_seconds_bucket{kind="${kind}",le="0.025",reason="other",thread="main"} 1\n`,
    );
  }
  for (const phase of [
    "authority",
    "admission",
    "preparation",
    "attachments",
    "replyContext",
    "authoring",
    "persist",
    "runAdmission",
    "replyInitialization",
    "snapshot",
    "worktree",
    "effects",
    "response",
    "dispatch",
  ]) {
    metrics.record({
      type: "diagnostic.phase.completed",
      name: `chat.send.${phase}`,
      startedAt: 0,
      durationMs: 1,
      details: { stage: "request" },
    });
  }
  const core = metrics.render();
  const expectedFamilies = {
    worker_request_seconds_count: 400,
    worker_queue_wait_seconds_count: 400,
    worker_request_phase_seconds_count: 400,
    gateway_ws_event_frame_bytes: 1800,
    gateway_ws_events_total: 200,
    gateway_ws_event_bytes_total: 200,
    gateway_ws_event_wire_bytes_total: 200,
    gateway_ws_session_event_frames_total: 200,
    gateway_ws_session_event_bytes_total: 200,
    gateway_rpc_handler_seconds_count: 170,
    gateway_rpc_admission_seconds_count: 170,
    gateway_rpc_first_response_seconds_count: 170,
    gateway_rpc_queue_wait_seconds_count: 170,
    gateway_rpc_response_bytes_count: 170,
    gateway_rpc_handler_heap_delta_bytes_count: 170,
    gateway_rpc_requests_total: 170,
    gateway_rpc_client_requests_total: 340,
    run_completed_total: 64,
    run_duration_seconds_count: 64,
    harness_run_total: 64,
    harness_run_duration_seconds_count: 64,
    model_call_total: 64,
    model_call_duration_seconds_count: 64,
    model_usage_duration_seconds_count: 64,
    tool_execution_total: 64,
    tool_execution_duration_seconds_count: 64,
    gen_ai_client_token_usage_count: 128,
    worktree_preparation_seconds_count: 1,
    secret_egress_requests_total: 1,
    gateway_http_cancelled_total: 1,
    heap_used_ratio: 9,
    worker_count: 9,
    code_mode_worker_heap_bytes: 24,
    chat_send_phase_seconds_count: 14,
    gc_duration_seconds_count: 4,
  };
  const actualFamilies = Object.fromEntries(
    Object.keys(expectedFamilies).map((name) => [
      name,
      core
        .split("\n")
        .filter(
          (line) => line.startsWith(`openclaw_${name}{`) || line.startsWith(`openclaw_${name} `),
        ).length,
    ]),
  );
  expect(actualFamilies).toEqual(expectedFamilies);
  expect(core).not.toContain("openclaw_prometheus_series_dropped_total");
  expect(core).toContain('openclaw_gateway_rpc_handler_seconds_count{method="sessions.list"} 1');
  expect(core).toContain(
    'openclaw_worker_gc_collections_total{kind="scavenge",script="worker-0.js",worker_class="compute"} 7',
  );
  expect(core).toContain('openclaw_queue_lane_size{lane="later"} 1');
  metrics.stop();
});

it("exports bounded family drop counts and warns once per process across exporter restarts", () => {
  const saturate = (metrics: ReturnType<typeof createMetricsHarness>) => {
    for (let index = 0; index < 130; index++) {
      metrics.record({
        type: "skill.used",
        skillName: `synthetic-${index}`,
        skillSource: "bundled",
        activation: "read",
      });
    }
    // Rejected observations are counted each time; these are not unique-series counts.
    metrics.record({
      type: "skill.used",
      skillName: "synthetic-129",
      skillSource: "bundled",
      activation: "read",
    });
  };
  const first = createMetricsHarness();
  const warn = vi.spyOn(first.logger, "warn");
  saturate(first);
  expect(first.render()).toContain(
    'openclaw_prometheus_family_series_dropped_total{family="openclaw_skill_used_total"} 3\n',
  );
  expect(first.render()).toContain("openclaw_prometheus_series_dropped_total 3\n");
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("openclaw_skill_used_total");
  expect(warn.mock.calls[0]?.[0]).not.toContain("synthetic-");
  first.stop();
  first.start();
  saturate(first);
  expect(warn).toHaveBeenCalledOnce();
  expect(first.render()).toContain("openclaw_prometheus_series_dropped_total 3\n");
  first.stop();
  const next = createMetricsHarness();
  const nextWarn = vi.spyOn(next.logger, "warn");
  saturate(next);
  expect(nextWarn).not.toHaveBeenCalled();
  expect(next.render()).toContain(
    'openclaw_prometheus_family_series_dropped_total{family="openclaw_skill_used_total"} 3\n',
  );
  next.stop();
});
