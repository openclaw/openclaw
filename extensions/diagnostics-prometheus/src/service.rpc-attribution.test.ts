import { expect, it } from "vitest";
import { createMetricsHarness, untrusted } from "./service.test-helpers.js";

it("counts trusted baseline retirements and successful base misses with bounded labels", () => {
  const metrics = createMetricsHarness();
  try {
    for (const cause of [
      "projection-revision",
      "config",
      "identity",
      "selection-reset",
      "view-evicted",
      "history-evicted",
    ] as const) {
      const event = { type: "sessions.list.baseline.retired", cause } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_baseline_retirements_total{cause="${cause}"} 1\n`,
      );
    }
    for (const reason of ["unknown-base", "all-rows-changed"] as const) {
      const event = {
        type: "gateway.rpc",
        method: "sessions.list",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        sessionsList: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          callerSource: "sidebar",
          rowMode: "sidebar",
          filter: "general",
          rowsOutcome: "full-with-base",
          baseMissReason: reason,
        },
      } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      metrics.record({ ...event, firstResponse: false });
      metrics.record({ ...event, outcome: "unavailable" });
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_base_misses_total{reason="${reason}"} 1\n`,
      );
    }
  } finally {
    metrics.stop();
  }
});

it("accounts for session response bytes by sidebar row outcome", () => {
  const metrics = createMetricsHarness();
  try {
    for (const rowsOutcome of [
      "delta",
      "unchanged",
      "full-no-base",
      "full-with-base",
      "not-sidebar",
    ] as const) {
      const event = {
        type: "gateway.rpc",
        method: "sessions.list",
        phase: "response",
        outcome: "ok",
        durationMs: 1,
        responseBytes: 1234,
        sessionsList: {
          clientKind: "openclaw-control-ui",
          source: "wire",
          callerSource: "sidebar",
          rowMode: rowsOutcome === "not-sidebar" ? "compact" : "sidebar",
          filter: "general",
          rowsOutcome,
        },
      } as const;
      metrics.record(event);
      metrics.record(event, untrusted);
      metrics.record({ ...event, firstResponse: false, responseBytes: 42 });
      expect(metrics.render()).toContain(
        `openclaw_sessions_list_response_bytes_total{caller_source="sidebar",client_kind="openclaw-control-ui",filter="general",row_mode="${event.sessionsList.rowMode}",rows_outcome="${rowsOutcome}",source="wire"} 1276\n`,
      );
    }
    expect(metrics.render()).toContain(
      'openclaw_gateway_rpc_response_bytes_sum{method="sessions.list"} 6380\n',
    );
  } finally {
    metrics.stop();
  }
});

it.each([
  { metric: "requests", expected: 1 },
  { metric: "response_bytes", expected: 1276 },
])(
  "accounts for chat history $metric by bounded request and response shape",
  ({ metric, expected }) => {
    const metrics = createMetricsHarness();
    try {
      for (const query of [
        { shape: "cursor", limitBucket: "<=20", outcome: "delta", source: "wire" },
        { shape: "older", limitBucket: "<=80", outcome: "page", source: "wire" },
        { shape: "receipt", limitBucket: "<=200", outcome: "reset", source: "internal" },
        { shape: "anchor", limitBucket: "<=200", outcome: "page", source: "wire" },
      ] as const) {
        const event = {
          type: "gateway.rpc",
          method: "chat.history",
          phase: "response",
          outcome: "ok",
          durationMs: 1,
          responseBytes: 1234,
          chatHistory: { clientKind: "openclaw-control-ui", ...query },
        } as const;
        metrics.record(event);
        metrics.record(event, untrusted);
        metrics.record({ ...event, firstResponse: false, responseBytes: 42 });
        expect(metrics.render()).toContain(
          `openclaw_chat_history_${metric}_total{client_kind="openclaw-control-ui",limit_bucket="${query.limitBucket}",outcome="${query.outcome}",shape="${query.shape}",source="${query.source}"} ${expected}\n`,
        );
      }
      expect(metrics.render()).toContain(
        'openclaw_gateway_rpc_response_bytes_sum{method="chat.history"} 5104\n',
      );
    } finally {
      metrics.stop();
    }
  },
);
