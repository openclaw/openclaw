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
  expectMetrics,
  expectExcludes,
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

function phaseEvent(
  name: string,
  durationMs: number,
  details?: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>["details"],
) {
  return { type: "diagnostic.phase.completed" as const, name, startedAt: 10, durationMs, details };
}

function frameBuckets(first = 1, second = first, rest = second, overflow = rest) {
  return {
    "256": first,
    "512": second,
    "1024": rest,
    "2048": rest,
    "4096": rest,
    "8192": rest,
    "16384": rest,
    "65536": rest,
    "+Inf": overflow,
  };
}

function invalidDurations(event: ReturnType<typeof phaseEvent>) {
  return [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY].map((durationMs) =>
    Object.assign({}, event, { durationMs }),
  );
}

const document = phaseEvent("control-ui.document.total", 125, { route: "synthetic-private" });
const catalog = phaseEvent("sessions.catalog.list.planning", 10, {
  threadCpuMs: 2.5,
  privateText: "synthetic-private",
});
const startup = phaseEvent("chat.startup.pending_inputs", 1_250, {
  privateText: "synthetic-private",
  threadCpuMs: 999,
});
const send = phaseEvent("chat.send.snapshot", 10, {
  stage: "request",
  privateText: "synthetic-private",
});
const preparation = phaseEvent("worktree.preparation", 1200, {
  kind: "sandbox",
  template: "warm",
  outcome: "returned",
  allocate: 100,
  setup: 0,
  sessionKey: "synthetic-private",
});
const diff = phaseEvent("sessions.diff", 160, {
  outcome: "cache-miss",
  missReason: "cold",
  "cache-validate": 150,
  "git-wall": 0,
  revision: "synthetic-private",
});

it.each([
  {
    name: "Control UI document",
    events: [document, { ...document, durationMs: 0 }],
    samples: `openclaw_control_ui_document_duration_seconds_sum{stage="total"} 0.125
openclaw_control_ui_document_duration_seconds_count{stage="total"} 2
openclaw_control_ui_document_duration_seconds_bucket{le="0.1",stage="total"} 1
openclaw_control_ui_document_duration_seconds_bucket{le="0.25",stage="total"} 2`,
    ignored: [
      ...invalidDurations(document),
      { ...document, name: "control-ui.document.private-session" },
      { ...document, name: "other.total" },
    ],
    absent: [],
  },
  {
    name: "catalog elapsed and synchronous CPU",
    events: [
      catalog,
      { ...catalog, durationMs: 0, details: undefined },
      { ...catalog, name: "sessions.catalog.list.provider" },
      { ...catalog, name: "sessions.catalog.list.delivery" },
      { ...catalog, name: "sessions.catalog.list.delivery", details: { threadCpuMs: "2.5" } },
    ],
    samples: `openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="planning"} 2
openclaw_gateway_rpc_stage_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.01
openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="planning"} 1
openclaw_gateway_rpc_stage_thread_cpu_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.0025
openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="delivery"} 2
openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="delivery"} 1`,
    ignored: [
      ...invalidDurations(catalog),
      { ...catalog, name: "sessions.catalog.list.private-session" },
      { ...catalog, name: "startup.fixture" },
    ],
    absent: [
      'openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="provider"}',
    ],
  },
  {
    name: "chat startup phases without asynchronous CPU attribution",
    events: [startup, { ...startup, name: "chat.startup.projection_final", durationMs: 0 }],
    samples: `openclaw_gateway_rpc_stage_seconds_count{method="chat.startup",phase="pending_inputs"} 1
openclaw_gateway_rpc_stage_seconds_sum{method="chat.startup",phase="pending_inputs"} 1.25
openclaw_gateway_rpc_stage_seconds_count{method="chat.startup",phase="projection_final"} 1`,
    ignored: [
      ...invalidDurations(startup),
      { ...startup, name: "chat.startup.private-session" },
      { ...startup, name: "chat.history.pending_inputs" },
    ],
    absent: ["thread_cpu", "privateText"],
  },
  {
    name: "chat.send request, startup and deferred delivery",
    events: [
      send,
      { ...send, durationMs: 0 },
      { ...send, durationMs: 3000, details: { stage: "startup" } },
      ...["steer", "queued"].map((stage) => phaseEvent("chat.send.dispatch", 120001, { stage })),
    ],
    samples: `openclaw_chat_send_phase_seconds_count{phase="snapshot",stage="request"} 2
openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="request"} 0.01
openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="startup"} 3
openclaw_chat_send_phase_seconds_sum{phase="dispatch",stage="steer"} 120.001
openclaw_chat_send_phase_seconds_sum{phase="dispatch",stage="queued"} 120.001`,
    ignored: [
      ...invalidDurations(send),
      { ...send, name: "chat.send.private-session" },
      { ...send, details: { stage: "private-session" } },
      { ...send, details: undefined },
    ],
    absent: [],
  },
  {
    name: "warm and cold worktree preparation",
    events: [
      preparation,
      { ...preparation, details: { ...preparation.details, template: "cold", setup: 10000 } },
    ],
    samples: `openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="total",template="warm"} 1.2
openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="allocate",template="warm"} 0.1
openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="setup",template="warm"} 0
openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="setup",template="cold"} 10`,
    ignored: [{ ...preparation, details: { ...preparation.details, template: "private-key" } }],
    absent: ['phase="checkout"'],
  },
  {
    name: "diff elapsed stages and bounded cache miss reasons",
    events: [
      diff,
      { ...diff, name: "checkout.diff", details: { ...diff.details, outcome: "cache-hit" } },
    ],
    samples: `openclaw_diff_stage_seconds_sum{method="sessions.diff",outcome="cache-miss",stage="cache-validate"} 0.15
openclaw_diff_stage_seconds_sum{method="checkout.diff",outcome="cache-hit",stage="git-wall"} 0
openclaw_diff_cache_misses_total{method="sessions.diff",reason="cold"} 1`,
    ignored: [
      { ...diff, name: "sessions.diff.private" },
      { ...diff, details: { outcome: "private" } },
      ...[-1, Number.NaN, Number.POSITIVE_INFINITY, "150"].map((elapsed) =>
        Object.assign({}, diff, { details: { outcome: "cache-hit", "cache-validate": elapsed } }),
      ),
      ...["private-revision", "revision-changed-/private/path", 1, true].map((missReason) =>
        Object.assign({}, diff, { details: { outcome: "cache-miss", missReason } }),
      ),
    ],
    absent: [],
  },
])(
  "exports trusted $name without private or malformed series",
  ({ events, samples, ignored, absent }) => {
    using metrics = createMetricsHarness();
    for (const event of events) {
      metrics.record(event);
    }
    const rendered = metrics.render();
    expectMetrics(rendered)(samples);
    expectExcludes(rendered, "synthetic-private", ...absent);
    for (const event of events) {
      metrics.record(event, untrusted);
      metrics.record(event, { trusted: false, internal: true });
    }
    for (const event of ignored) {
      metrics.record(event);
    }
    expect(metrics.render()).toBe(rendered);
  },
);

it("exports the current operator socket count and rejects untrusted updates", () => {
  using metrics = createMetricsHarness();
  metrics.record({ type: "gateway.ws.connections", operators: 2 });
  expectMetrics(metrics.render())("openclaw_gateway_ws_operator_connections 2");
  metrics.record({ type: "gateway.ws.connections", operators: 0 });
  for (const metadata of [untrusted, { trusted: false, internal: true }]) {
    metrics.record({ type: "gateway.ws.connections", operators: 99 }, metadata);
  }
  expectMetrics(metrics.render())(`# TYPE openclaw_gateway_ws_operator_connections gauge
openclaw_gateway_ws_operator_connections 0`);
});

it("exports codec bytes separately and cumulative raw frame-size buckets", () => {
  using metrics = createMetricsHarness();
  const observation = {
    type: "gateway.ws.event",
    event: "chat",
    count: 3,
    bytes: 1_536,
    frameBytes: frameBuckets(0, 2, 3),
  } as const;
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
  for (const metadata of [untrusted, { trusted: false, internal: true }]) {
    metrics.record({ ...observation, event: "private-untrusted", wireBytes: 999 }, metadata);
  }
  const rendered = metrics.render();
  expectMetrics(rendered)(`# TYPE openclaw_gateway_ws_events_total counter
# TYPE openclaw_gateway_ws_event_bytes_total counter
openclaw_gateway_ws_events_total{event="chat"} 4
openclaw_gateway_ws_event_bytes_total{event="chat"} 71536
openclaw_gateway_ws_event_wire_bytes_total{event="chat"} 1300`);
  expectExcludes(
    rendered,
    "private-untrusted",
    'openclaw_gateway_ws_event_wire_bytes_total{event="other"}',
    'openclaw_gateway_ws_event_frame_bytes{event="other"',
  );
  for (const [le, count] of Object.entries(frameBuckets(0, 2, 3, 4))) {
    expect(rendered).toContain(
      `openclaw_gateway_ws_event_frame_bytes{event="chat",le="${le}"} ${count}`,
    );
  }
});

it.each([
  {
    event: "session.message",
    sessionEvent: { reason: "assistant", delivery: "subscribed" },
    family: "session_event",
    labels: 'delivery="subscribed",event="session.message",reason="assistant"',
  },
  { event: "presence", presenceMode: "delta", family: "presence", labels: 'mode="delta"' },
] as const)(
  "attributes $event frames without changing aggregate labels",
  ({ family, labels, ...attributes }) => {
    using metrics = createMetricsHarness();
    const event = { type: "gateway.ws.event", count: 2, bytes: 256, ...attributes } as const;
    metrics.record(event);
    metrics.record({ ...event, count: 1, bytes: 128 });
    metrics.record(event, untrusted);
    expectMetrics(metrics.render())(`openclaw_gateway_ws_events_total{event="${event.event}"} 3
openclaw_gateway_ws_event_bytes_total{event="${event.event}"} 384
openclaw_gateway_ws_${family}_frames_total{${labels}} 3
openclaw_gateway_ws_${family}_bytes_total{${labels}} 384`);
  },
);

it("replaces trusted retention gauges and clears them on retirement", () => {
  using metrics = createMetricsHarness();
  const list = {
    type: "sessions.list.retention",
    views: 3,
    refs: 17,
    estimatedBytes: 3504,
  } as const;
  const rows = {
    type: "sessions.event.retention",
    entries: 25600,
    estimatedBytes: 24985600,
  } as const;
  metrics.record(list);
  metrics.record(rows);
  const retained = metrics.render();
  expectMetrics(retained)(`openclaw_session_event_rows_retained_bytes 24985600
openclaw_session_event_rows_retained_entries 25600
openclaw_sessions_list_retained_bytes 3504
openclaw_sessions_list_retained_refs 17
openclaw_sessions_list_retained_views 3`);
  for (const metadata of [untrusted, { trusted: false, internal: true }]) {
    metrics.record({ ...list, views: 99 }, metadata);
    metrics.record({ ...rows, entries: 99 }, metadata);
  }
  expect(metrics.render()).toBe(retained);
  metrics.record({ ...list, views: 0, refs: 0, estimatedBytes: 0 });
  metrics.record({ ...rows, entries: 0, estimatedBytes: 0 });
  expectMetrics(metrics.render())(`openclaw_session_event_rows_retained_bytes 0
openclaw_session_event_rows_retained_entries 0
openclaw_sessions_list_retained_bytes 0
openclaw_sessions_list_retained_refs 0
openclaw_sessions_list_retained_views 0`);
});

it("counts trusted wire-baseline retirements", () => {
  using metrics = createMetricsHarness();
  const event = { type: "sessions.event.rows.reset", cause: "close", count: 3 } as const;
  metrics.record(event);
  metrics.record({ ...event, count: 2 });
  for (const metadata of [untrusted, { trusted: false, internal: true }]) {
    metrics.record({ ...event, count: 99 }, metadata);
  }
  expectMetrics(metrics.render())('openclaw_session_event_rows_reset_total{cause="close"} 5');
});

it("records terminal metrics without reading logs or private diagnostic content", async () => {
  const exporter = createDiagnosticsPrometheusExporter();
  const readPrivateContent = vi.fn(() => ({ toolInput: { text: "private tool input" } }));
  const readLogAttribute = vi.fn(() => "synthetic log attribute");
  const readWsBuckets = vi.fn(() => frameBuckets());
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
    internalDiagnostics: { emit() {}, onEvent: onTrustedInternalDiagnosticEvent },
  });
  try {
    emitLog();
    emitTrustedDiagnosticEventWithPrivateData({
      type: "gateway.ws.event",
      event: "chat",
      count: 1,
      bytes: 256,
      get frameBytes() {
        return readWsBuckets();
      },
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
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
    expect(readWsBuckets).not.toHaveBeenCalled();
  } finally {
    exporter.service.stop?.();
    await waitForDiagnosticEventsDrained();
  }
  expect(scrapeMetrics(exporter.handler)).toBe("");
});

it("exports production-shaped worker, WebSocket, and late RPC populations without drops", () => {
  using metrics = createMetricsHarness();
  expect(metrics.render()).not.toContain("openclaw_gc_duration_seconds");
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
      frameBytes: frameBuckets(),
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
  metrics.record({ type: "secret.egress", outcome: "forwarded", substituted: true });
  metrics.record({ type: "secret.egress", outcome: "forwarded", substituted: true }, untrusted);
  metrics.record({ type: "tool.catalog", source: "client", mode: "code-mode", toolCount: 10 });
  metrics.record({ type: "tool.catalog", source: "client", mode: "code-mode", toolCount: 12 });
  metrics.record(
    { type: "tool.catalog", source: "client", mode: "code-mode", toolCount: 99 },
    untrusted,
  );
  for (const source of ["client", "client", "shutdown"] as const) {
    metrics.record({ type: "gateway.http.cancelled", source }, { trusted: false, internal: true });
  }
  metrics.record({ type: "gateway.http.cancelled", source: "client" }, untrusted);
  const sample = {
    type: "diagnostic.memory.sample" as const,
    memory: {
      rssBytes: 1000,
      heapUsedBytes: 300,
      heapTotalBytes: 500,
      heapSizeLimitBytes: 1000,
      externalBytes: 20,
      arrayBuffersBytes: 10,
      workerCount: 39,
      workerHeaps: Array.from({ length: 39 }, (_, index) => ({
        script: `worker-${index}.js`,
        workerSlot: index + 1,
        heapUsed: 100,
        heapTotal: 200,
        heapSizeLimitBytes: 1000,
        heapSpaces: Array.from({ length: 10 }, (_value, space) => ({
          space_name: `space_${space}`,
          space_used_size: 10,
        })),
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
    for (let workerSlot = 1; workerSlot <= 61; workerSlot++) {
      metrics.record({
        type: "diagnostic.gc",
        kind,
        reason: "other",
        thread: "code-mode-node.worker.js",
        workerSlot,
        durationMs: 10,
      });
    }
    for (const durationMs of [20, 30]) {
      metrics.record({
        type: "diagnostic.gc",
        kind,
        reason: "other",
        thread: "main",
        durationMs,
      });
    }
    const labels = `kind="${kind}",reason="other",thread="main"`;
    const rendered = metrics.render();
    expectMetrics(rendered)(`openclaw_gc_duration_seconds_count{${labels}} 2
openclaw_gc_duration_seconds_sum{${labels}} 0.05
openclaw_gc_duration_seconds_bucket{kind="${kind}",le="0.025",reason="other",thread="main"} 1`);
  }
  for (const reason of ["forced", "none"] as const) {
    metrics.record({
      type: "diagnostic.gc",
      kind: "scavenge",
      reason,
      thread: "main",
      durationMs: 10,
    });
  }
  const core = metrics.render();
  for (const [name, count] of [
    ["worker_request_seconds_count", 400],
    ["worker_request_phase_seconds_count", 400],
    ["gateway_ws_event_frame_bytes", 1800],
    ["gateway_rpc_handler_seconds_count", 170],
    ["worker_heap_space_used_bytes", 390],
    ["gc_duration_seconds_count", 250],
  ] as const) {
    expect(core.split("\n").filter((line) => line.startsWith(`openclaw_${name}{`))).toHaveLength(
      count,
    );
  }
  expect(core).not.toContain("openclaw_prometheus_series_dropped_total");
  expectMetrics(core)(`openclaw_gateway_rpc_handler_seconds_count{method="sessions.list"} 1
openclaw_gc_duration_seconds_count{kind="weak_processing",reason="other",slot="61",thread="code-mode-node.worker.js"} 1
openclaw_gc_duration_seconds_count{kind="scavenge",reason="forced",thread="main"} 1
openclaw_secret_egress_requests_total{outcome="forwarded",substituted="true"} 1
openclaw_tool_catalog_total{mode="code-mode",source="client"} 2
openclaw_tool_catalog_tools_total{mode="code-mode",source="client"} 22
openclaw_gateway_http_cancelled_total{source="client"} 2
openclaw_gateway_http_cancelled_total{source="shutdown"} 1`);
});

it("exports bounded family drop counts and warns once per process across exporter restarts", () => {
  const saturate = (metrics: ReturnType<typeof createMetricsHarness>) => {
    for (let index = 0; index < 130; index++) {
      metrics.record({
        type: "skill.used",
        skillName: `synthetic-${index}`,
        agentId: "main",
        runId: "private-run",
        sessionKey: "private-session",
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
  expectMetrics(first.render())(
    'openclaw_skill_used_total{activation="read",agent="main",skill="synthetic-0",source="bundled"} 1',
  );
  expectExcludes(first.render(), "private-run", "private-session");
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
