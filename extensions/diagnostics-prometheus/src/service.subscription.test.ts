import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import { createMetricsHarness, untrusted } from "./service.test-helpers.js";

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
