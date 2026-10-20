import { expect } from "vitest";
import { metricsTest as it, expectMetrics, untrusted } from "./service.test-helpers.js";

const response = { type: "gateway.rpc", phase: "response", outcome: "ok", durationMs: 1 } as const;
const sidebar = {
  clientKind: "openclaw-control-ui",
  source: "wire",
  callerSource: "sidebar",
  rowMode: "sidebar",
  filter: "general",
} as const;

it("counts trusted baseline retirements and first-response base misses", ({ metrics }) => {
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
      ...response,
      method: "sessions.list",
      sessionsList: { ...sidebar, rowsOutcome: "full-with-base", baseMissReason: reason },
    } as const;
    metrics.record(event);
    metrics.record(event, untrusted);
    metrics.record({ ...event, firstResponse: false });
    metrics.record({ ...event, outcome: "unavailable" });
    expect(metrics.render()).toContain(
      `openclaw_sessions_list_base_misses_total{reason="${reason}"} 1\n`,
    );
  }
});

it("accounts for session response bytes by sidebar row outcome", ({ metrics }) => {
  const outcomes = ["delta", "unchanged", "full-no-base", "full-with-base", "not-sidebar"] as const;
  for (const rowsOutcome of outcomes) {
    const event = {
      ...response,
      method: "sessions.list",
      responseBytes: 1234,
      sessionsList: {
        ...sidebar,
        rowMode: rowsOutcome === "not-sidebar" ? "compact" : "sidebar",
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
});

it("attributes chat history requests and response bytes", ({ metrics }) => {
  for (const query of [
    { shape: "cursor", limitBucket: "<=20", outcome: "delta", source: "wire" },
    { shape: "older", limitBucket: "<=80", outcome: "page", source: "wire" },
    { shape: "receipt", limitBucket: "<=200", outcome: "reset", source: "internal" },
    { shape: "anchor", limitBucket: "<=200", outcome: "page", source: "wire" },
  ] as const) {
    const event = {
      ...response,
      method: "chat.history",
      responseBytes: 1234,
      chatHistory: { clientKind: "openclaw-control-ui", ...query },
    } as const;
    metrics.record(event);
    metrics.record(event, untrusted);
    metrics.record({ ...event, firstResponse: false, responseBytes: 42 });
    const labels = `client_kind="openclaw-control-ui",limit_bucket="${query.limitBucket}",outcome="${query.outcome}",shape="${query.shape}",source="${query.source}"`;
    expectMetrics(metrics.render())(`
      openclaw_chat_history_requests_total{${labels}} 1
      openclaw_chat_history_response_bytes_total{${labels}} 1276
    `);
  }
  expect(metrics.render()).toContain(
    'openclaw_gateway_rpc_response_bytes_sum{method="chat.history"} 5104\n',
  );
});
