import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  expectMetrics,
  expectExcludes,
  baseEvent,
  createMetricsHarness,
  scrapeMetrics,
  trusted,
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

it("exports trusted Control UI document timings in seconds with only bounded stage labels", () => {
  using metrics = createMetricsHarness();
  const event = phaseEvent("control-ui.document.total", 125, {
    route: "/chat/synthetic-private-session",
    user: "synthetic-private-user",
  });
  for (const stage of "auth_grants identity_avatar plugin_catalog git_branch preferences render total".split(
    " ",
  )) {
    metrics.record({ ...event, name: `control-ui.document.${stage}` });
    metrics.record({ ...event, name: `control-ui.document.${stage}`, durationMs: 0 });
  }
  const rendered = metrics.render();
  expect(rendered).toContain("# TYPE openclaw_control_ui_document_duration_seconds histogram\n");
  const sums = rendered
    .split("\n")
    .filter((line) => line.startsWith("openclaw_control_ui_document_duration_seconds_sum"));
  expect(sums).toEqual([
    'openclaw_control_ui_document_duration_seconds_sum{stage="auth_grants"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="git_branch"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="identity_avatar"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="plugin_catalog"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="preferences"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="render"} 0.125',
    'openclaw_control_ui_document_duration_seconds_sum{stage="total"} 0.125',
  ]);
  expectMetrics(rendered)(`openclaw_control_ui_document_duration_seconds_count{stage="total"} 2
openclaw_control_ui_document_duration_seconds_bucket{le="0.1",stage="total"} 1
openclaw_control_ui_document_duration_seconds_bucket{le="0.25",stage="total"} 2`);
  expect(rendered).not.toContain("synthetic-private");

  metrics.record(event, untrusted);
  metrics.record(event, { trusted: false, internal: true });
  for (const name of ["control-ui.document.private-session", "other.total"]) {
    metrics.record({ ...event, name });
  }
  for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    metrics.record({ ...event, durationMs });
  }
  expect(metrics.render()).toBe(rendered);
});

describe("catalog list stage metrics", () => {
  it("exports elapsed and synchronous CPU populations with fixed labels and no diagnostic content", () => {
    using metrics = createMetricsHarness();
    const event = phaseEvent("sessions.catalog.list.planning", 10, {
      threadCpuMs: 2.5,
      privateText: "synthetic-private-content",
    });
    metrics.record(event, trusted);
    metrics.record({ ...event, durationMs: 0, details: undefined }, trusted);
    for (const phase of ["projection_initial", "provider", "coalesced", "projection_final"]) {
      metrics.record({ ...event, name: `sessions.catalog.list.${phase}` }, trusted);
    }
    metrics.record({ ...event, name: "sessions.catalog.list.delivery" }, trusted);
    const rendered = metrics.render();
    expectMetrics(
      rendered,
    )(`openclaw_gateway_rpc_stage_seconds_count{method="sessions.catalog.list",phase="planning"} 2
openclaw_gateway_rpc_stage_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.01
openclaw_gateway_rpc_stage_thread_cpu_seconds_count{method="sessions.catalog.list",phase="planning"} 1
openclaw_gateway_rpc_stage_thread_cpu_seconds_sum{method="sessions.catalog.list",phase="planning"} 0.0025`);
    const cpuLines = rendered
      .split("\n")
      .filter((line) => line.startsWith("openclaw_gateway_rpc_stage_thread_cpu_seconds"));
    expect(cpuLines.every((line) => /phase="(?:planning|delivery)"/.test(line))).toBe(true);
    expectExcludes(rendered, "synthetic-private-content", "privateText");
    expect(metrics.render()).toBe(rendered);
  });

  it("rejects untrusted, unknown and malformed phase observations without creating series", () => {
    using metrics = createMetricsHarness();
    const event = phaseEvent("sessions.catalog.list.provider", 10);
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
  });
});

it("exports chat.send startup and deferred histograms with bounded, trusted labels", () => {
  using metrics = createMetricsHarness();
  const event = phaseEvent("chat.send.snapshot", 10, {
    stage: "request",
    privateText: "synthetic-private-content",
  });
  metrics.record(event, trusted);
  metrics.record({ ...event, durationMs: 0 }, trusted);
  metrics.record({ ...event, durationMs: 3_000, details: { stage: "startup" } }, trusted);
  metrics.record(
    { ...event, name: "chat.send.replyInitialization", details: { stage: "startup" } },
    trusted,
  );
  for (const stage of ["steer", "queued"]) {
    metrics.record(
      { ...event, name: "chat.send.dispatch", durationMs: 120_001, details: { stage } },
      trusted,
    );
  }
  const rendered = metrics.render();
  expectMetrics(
    rendered,
  )(`openclaw_chat_send_phase_seconds_count{phase="snapshot",stage="request"} 2
openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="request"} 0.01
openclaw_chat_send_phase_seconds_sum{phase="snapshot",stage="startup"} 3
openclaw_chat_send_phase_seconds_count{phase="replyInitialization",stage="startup"} 1`);
  for (const stage of ["steer", "queued"]) {
    expect(rendered).toContain(
      `openclaw_chat_send_phase_seconds_sum{phase="dispatch",stage="${stage}"} 120.001\n`,
    );
  }
  expectExcludes(rendered, "synthetic-private-content", "privateText");

  metrics.record(event, untrusted);
  metrics.record({ ...event, name: "chat.send.private-session" }, trusted);
  metrics.record({ ...event, details: { stage: "private-session" } }, trusted);
  metrics.record({ ...event, details: undefined }, trusted);
  for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    metrics.record({ ...event, durationMs }, trusted);
  }
  expect(metrics.render()).toBe(rendered);
});

it("exports warm/cold preparation phases without identifiers or untrusted series", () => {
  using metrics = createMetricsHarness();
  const event = phaseEvent("worktree.preparation", 1_200, {
    kind: "sandbox",
    template: "warm",
    outcome: "returned",
    allocate: 100,
    templateApply: 20,
    setup: 0,
    sessionKey: "synthetic-private-session",
  });
  const before = metrics.render();
  metrics.record(event, untrusted);
  metrics.record(event, { trusted: false, internal: true });
  metrics.record({ ...event, details: { ...event.details, template: "private-key" } }, trusted);
  expect(metrics.render()).toBe(before);
  metrics.record(event, trusted);
  metrics.record(
    { ...event, details: { ...event.details, template: "cold", setup: 10_000 } },
    trusted,
  );
  const rendered = metrics.render();
  for (const [phase, sum] of [
    ["total", 1.2],
    ["allocate", 0.1],
    ["templateApply", 0.02],
    ["setup", 0],
  ] as const) {
    expect(rendered).toContain(
      `openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="${phase}",template="warm"} ${sum}\n`,
    );
  }
  expect(rendered).toContain(
    'openclaw_worktree_preparation_seconds_sum{kind="sandbox",outcome="returned",phase="setup",template="cold"} 10\n',
  );
  expectExcludes(rendered, "synthetic-private-session", "sessionKey", 'phase="checkout"');
});

it("bounds diff histograms to two methods, six stages and two cache outcomes in seconds", () => {
  using metrics = createMetricsHarness();
  const event = phaseEvent("sessions.diff", 160, {
    outcome: "cache-hit",
    admission: 1,
    "checkout-resolve": 2,
    "cache-validate": 150,
    "worker-queue": 100,
    "git-wall": 0,
    encode: 7,
    "/synthetic/private/checkout": 99,
    sessionKey: "synthetic-private-session",
  });
  for (const name of ["sessions.diff", "checkout.diff"]) {
    for (const outcome of ["cache-hit", "cache-miss"]) {
      metrics.record({ ...event, name, details: { ...event.details, outcome } }, trusted);
    }
  }
  const rendered = metrics.render();
  const counts = rendered
    .split("\n")
    .filter((line) => line.startsWith("openclaw_diff_stage_seconds_count"));
  expect(counts).toHaveLength(24);
  expectMetrics(
    rendered,
  )(`openclaw_diff_stage_seconds_sum{method="sessions.diff",outcome="cache-hit",stage="cache-validate"} 0.15
openclaw_diff_stage_seconds_sum{method="checkout.diff",outcome="cache-miss",stage="git-wall"} 0`);
  expect(rendered).not.toContain("synthetic");
  metrics.record(event, untrusted);
  metrics.record(event, { trusted: false, internal: true });
  metrics.record({ ...event, name: "sessions.diff.private" }, trusted);
  metrics.record({ ...event, details: { ...event.details, outcome: "private" } }, trusted);
  for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY, "150"]) {
    metrics.record(
      { ...event, details: { outcome: "cache-hit", "cache-validate": elapsed } },
      trusted,
    );
  }
  expect(metrics.render()).toBe(rendered);
});

it("bounds diff miss reasons without exporting revision keys or caller supplied labels", () => {
  using metrics = createMetricsHarness();
  const event = phaseEvent("sessions.diff", 1, {
    outcome: "cache-miss",
    missReason: "cold",
    revision: "private-revision",
  });
  for (const name of ["sessions.diff", "checkout.diff"]) {
    for (const missReason of `cold evicted pending no-revision no-revision-environment no-revision-platform
no-revision-metadata no-revision-git-installation no-revision-config no-revision-reftable
no-revision-alternates no-revision-symlink no-revision-nested-repository no-revision-status
no-revision-unmerged no-revision-submodule no-revision-permission no-revision-missing
no-revision-io oversized revision-changed-head revision-changed-index
revision-changed-untracked-set revision-changed-worktree-mtime revision-changed-metadata`.split(
      /\s+/,
    )) {
      metrics.record({ ...event, name, details: { ...event.details, missReason } }, trusted);
    }
  }
  const rendered = metrics.render();
  const counters = rendered
    .split("\n")
    .filter((line) => line.startsWith("openclaw_diff_cache_misses_total{"));
  expect(counters).toHaveLength(50);
  expect(counters.every((line) => line.endsWith(" 1"))).toBe(true);
  expect(rendered).not.toContain("private");
  metrics.record(event, untrusted);
  metrics.record({ ...event, name: "sessions.diff.private" }, trusted);
  metrics.record({ ...event, details: { ...event.details, outcome: "cache-hit" } }, trusted);
  for (const missReason of ["private-revision", "revision-changed-/private/path", 1, true]) {
    metrics.record({ ...event, details: { ...event.details, missReason } }, trusted);
  }
  expect(metrics.render()).toBe(rendered);
});

describe("subscription metrics", () => {
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

  it("exports session traffic attribution while keeping aggregate event labels unchanged", () => {
    using metrics = createMetricsHarness();
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
      expectMetrics(rendered)(`openclaw_gateway_ws_events_total{event="${event}"} 6
openclaw_gateway_ws_event_bytes_total{event="${event}"} 768`);
      for (const delivery of ["subscribed", "roster"]) {
        const labels = `delivery="${delivery}",event="${event}",reason="${reason}"`;
        expectMetrics(rendered)(`openclaw_gateway_ws_session_event_frames_total{${labels}} 3
openclaw_gateway_ws_session_event_bytes_total{${labels}} 384`);
      }
    }
  });

  it("exports presence frame counts and bytes by delivery mode", () => {
    using metrics = createMetricsHarness();
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
    expectMetrics(rendered)(`openclaw_gateway_ws_events_total{event="presence"} 9
openclaw_gateway_ws_event_bytes_total{event="presence"} 1152`);
    for (const mode of ["delta", "reset", "legacy"]) {
      expectMetrics(rendered)(`openclaw_gateway_ws_presence_frames_total{mode="${mode}"} 3
openclaw_gateway_ws_presence_bytes_total{mode="${mode}"} 384`);
    }
  });

  it("exports trusted session retention gauges and clears them on retirement", () => {
    using metrics = createMetricsHarness();
    const retentionLines = () =>
      metrics
        .render()
        .split("\n")
        .filter(
          (line) =>
            line.startsWith("openclaw_sessions_list_retained_") ||
            line.startsWith("openclaw_session_event_rows_retained_"),
        );
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
  });

  it("counts retired wire baselines by cause without accepting untrusted resets", () => {
    using metrics = createMetricsHarness();
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
    using metrics = createMetricsHarness();
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
    metrics.record({ ...queue, queueSize: 2 });
    const existing = metrics.render();
    expectMetrics(existing)(`openclaw_queue_lane_size{lane="main"} 2
openclaw_queue_lane_wait_seconds_count{lane="main"} 2`);

    metrics.record({ ...queue, lane: "later" });

    for (let index = 0; index < 64; index++) {
      const model = `model-${index}`;
      const run = { runId: `run-${index}`, durationMs: 10 };
      metrics.record({ ...run, type: "run.completed", model, outcome: "completed" });
      metrics.record({
        ...run,
        type: "harness.run.completed",
        model,
        harnessId: "synthetic",
        outcome: "completed",
      });
      metrics.record({
        ...run,
        type: "model.call.completed",
        model,
        callId: `call-${index}`,
        provider: "synthetic",
      });
      metrics.record({
        type: "model.usage",
        model,
        usage: { input: 10, output: 20 },
        durationMs: 10,
      });
      metrics.record({
        ...run,
        type: "tool.execution.completed",
        toolCallId: `call-${index}`,
        toolName: `tool-${index}`,
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
    for (const phase of `authority admission preparation attachments replyContext authoring persist runAdmission
replyInitialization snapshot worktree effects response dispatch`.split(/\s+/)) {
      metrics.record({
        type: "diagnostic.phase.completed",
        name: `chat.send.${phase}`,
        startedAt: 0,
        durationMs: 1,
        details: { stage: "request" },
      });
    }
    const core = metrics.render();
    const expectedFamilies = Object.fromEntries(
      Object.entries({
        400: "worker_request_seconds_count worker_queue_wait_seconds_count worker_request_phase_seconds_count",
        1800: "gateway_ws_event_frame_bytes",
        200: "gateway_ws_events_total gateway_ws_event_bytes_total gateway_ws_event_wire_bytes_total gateway_ws_session_event_frames_total gateway_ws_session_event_bytes_total",
        170: "gateway_rpc_handler_seconds_count gateway_rpc_admission_seconds_count gateway_rpc_first_response_seconds_count gateway_rpc_queue_wait_seconds_count gateway_rpc_response_bytes_count gateway_rpc_handler_heap_delta_bytes_count gateway_rpc_requests_total",
        340: "gateway_rpc_client_requests_total",
        64: "run_completed_total run_duration_seconds_count harness_run_total harness_run_duration_seconds_count model_call_total model_call_duration_seconds_count model_usage_duration_seconds_count tool_execution_total tool_execution_duration_seconds_count",
        128: "gen_ai_client_token_usage_count",
        1: "worktree_preparation_seconds_count secret_egress_requests_total gateway_http_cancelled_total",
        40: "heap_used_ratio worker_count",
        78: "code_mode_worker_heap_bytes",
        390: "worker_heap_space_used_bytes",
        14: "chat_send_phase_seconds_count",
        250: "gc_duration_seconds_count",
      }).flatMap(([count, names]) =>
        names.split(" ").map((name) => [name, Number(count)] as const),
      ),
    );
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
    expectMetrics(core)(`openclaw_gateway_rpc_handler_seconds_count{method="sessions.list"} 1
openclaw_gc_duration_seconds_count{kind="weak_processing",reason="other",slot="61",thread="code-mode-node.worker.js"} 1
openclaw_gc_duration_seconds_count{kind="scavenge",reason="forced",thread="main"} 1
openclaw_worker_gc_collections_total{kind="scavenge",script="worker-0.js",worker_class="compute"} 7
openclaw_queue_lane_size{lane="later"} 1`);
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
});
