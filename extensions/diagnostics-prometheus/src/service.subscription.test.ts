import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import {
  metricsTest as it,
  expectMetrics,
  expectExcludes,
  untrusted,
} from "./service.test-helpers.js";

type WsEvent = Omit<Extract<DiagnosticEventPayload, { type: "gateway.ws.event" }>, "seq" | "ts">;
function ws(event: string, fields: Partial<Omit<WsEvent, "type" | "event">> = {}): WsEvent {
  return { type: "gateway.ws.event", event, count: 2, bytes: 256, ...fields };
}

it("updates the trusted operator socket gauge", ({ metrics }) => {
  metrics.record({ type: "gateway.ws.connections", operators: 2 });
  metrics.record({ type: "gateway.ws.connections", operators: 0 });
  for (const metadata of [untrusted, { trusted: false, internal: true }]) {
    metrics.record({ type: "gateway.ws.connections", operators: 99 }, metadata);
  }
  const rendered = metrics.render();
  expect(rendered).toContain("# TYPE openclaw_gateway_ws_operator_connections gauge\n");
  expect(rendered.split("\n").filter((line) => line.startsWith("openclaw_gateway_ws_"))).toEqual([
    "openclaw_gateway_ws_operator_connections 0",
  ]);
});

it("exports codec bytes separately and cumulative raw frame-size buckets", ({ metrics }) => {
  const observation = ws("chat", {
    count: 3,
    bytes: 1_536,
    frameBytes: {
      "256": 0,
      "512": 2,
      "1024": 3,
      "+Inf": 3,
    },
  });

  metrics.record(observation);
  metrics.record(ws("chat", { count: 0, bytes: 0, wireBytes: 600 }));
  metrics.record(ws("chat", { count: 0, bytes: 0, frameBytes: { "512": 0 } }));
  metrics.record(
    ws("chat", { count: 1, bytes: 70_000, wireBytes: 700, frameBytes: { "+Inf": 1 } }),
  );
  metrics.record(ws("other", { count: 1, bytes: 64 }));
  metrics.record({ ...observation, wireBytes: 999 }, untrusted);
  const rendered = metrics.render();
  expectMetrics(rendered)(`
    # TYPE openclaw_gateway_ws_events_total counter
    # TYPE openclaw_gateway_ws_event_bytes_total counter
    openclaw_gateway_ws_events_total{event="chat"} 4
    openclaw_gateway_ws_event_bytes_total{event="chat"} 71536
    openclaw_gateway_ws_event_wire_bytes_total{event="chat"} 1300
    openclaw_gateway_ws_events_total{event="other"} 1
    openclaw_gateway_ws_event_bytes_total{event="other"} 64
  `);
  expectExcludes(
    rendered,
    'openclaw_gateway_ws_event_wire_bytes_total{event="other"}',
    'openclaw_gateway_ws_event_frame_bytes{event="other"',
  );
  expectMetrics(rendered)(`
    openclaw_gateway_ws_event_frame_bytes{event="chat",le="256"} 0
    openclaw_gateway_ws_event_frame_bytes{event="chat",le="512"} 2
    openclaw_gateway_ws_event_frame_bytes{event="chat",le="1024"} 3
    openclaw_gateway_ws_event_frame_bytes{event="chat",le="+Inf"} 4
  `);
});

it("attributes session traffic without changing aggregate labels", ({ metrics }) => {
  for (const [event, reason] of [
    ["sessions.changed", "agent.run.started"],
    ["session.message", "assistant"],
  ] as const) {
    for (const delivery of ["subscribed", "roster"] as const) {
      const observation = ws(event, { sessionEvent: { reason, delivery } });
      metrics.record(observation);
      metrics.record({ ...observation, count: 1, bytes: 128 });
      metrics.record(observation, untrusted);
    }
    const rendered = metrics.render();
    expectMetrics(rendered)(`
      openclaw_gateway_ws_events_total{event="${event}"} 6
      openclaw_gateway_ws_event_bytes_total{event="${event}"} 768
    `);
    for (const delivery of ["subscribed", "roster"]) {
      const labels = `delivery="${delivery}",event="${event}",reason="${reason}"`;
      expectMetrics(rendered)(`
        openclaw_gateway_ws_session_event_frames_total{${labels}} 3
        openclaw_gateway_ws_session_event_bytes_total{${labels}} 384
      `);
    }
  }
});

it("exports presence frame counts and bytes by delivery mode", ({ metrics }) => {
  for (const presenceMode of ["delta", "reset", "legacy"] as const) {
    const observation = ws("presence", { presenceMode });
    metrics.record(observation);
    metrics.record({ ...observation, count: 1, bytes: 128 });
    metrics.record(observation, untrusted);
  }
  const rendered = metrics.render();
  expectMetrics(rendered)(`
    openclaw_gateway_ws_events_total{event="presence"} 9
    openclaw_gateway_ws_event_bytes_total{event="presence"} 1152
  `);
  for (const mode of ["delta", "reset", "legacy"]) {
    expectMetrics(rendered)(`
      openclaw_gateway_ws_presence_frames_total{mode="${mode}"} 3
      openclaw_gateway_ws_presence_bytes_total{mode="${mode}"} 384
    `);
  }
});

it("exports trusted session retention gauges and clears them on retirement", ({ metrics }) => {
  const retentionLines = () =>
    metrics
      .render()
      .split("\n")
      .filter((line) => /^openclaw_(sessions_list|session_event_rows)_retained_/.test(line));

  metrics.record({ type: "sessions.list.retention", views: 3, refs: 17, estimatedBytes: 3_504 });
  metrics.record({ type: "sessions.event.retention", entries: 25_600, estimatedBytes: 24_985_600 });
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
    expect(metrics.render()).toContain(`# TYPE openclaw_sessions_list_retained_${suffix} gauge\n`);
  }
  for (const suffix of ["entries", "bytes"]) {
    expect(metrics.render()).toContain(
      `# TYPE openclaw_session_event_rows_retained_${suffix} gauge\n`,
    );
  }
  const retained = [
    "openclaw_session_event_rows_retained_bytes 24985600",
    "openclaw_session_event_rows_retained_entries 25600",
    "openclaw_sessions_list_retained_bytes 3504",
    "openclaw_sessions_list_retained_refs 17",
    "openclaw_sessions_list_retained_views 3",
  ];
  expect(retentionLines()).toEqual(retained);
  metrics.record({ type: "sessions.list.retention", views: 0, refs: 0, estimatedBytes: 0 });
  metrics.record({ type: "sessions.event.retention", entries: 0, estimatedBytes: 0 });
  expect(retentionLines()).toEqual(retained.map((line) => line.replace(/\d+$/, "0")));
});

it("counts retired wire baselines by cause without accepting untrusted resets", ({ metrics }) => {
  for (const cause of ["close", "delivery-lost", "generation", "evicted", "projection"] as const) {
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
    internalDiagnostics: { emit() {}, onEvent: onTrustedInternalDiagnosticEvent },
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
    expect(exporter.render()).toContain(
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
  expect(exporter.render()).toBe("");
});
