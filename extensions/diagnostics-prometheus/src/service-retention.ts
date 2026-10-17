import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export function recordSessionRetention(
  store: PrometheusMetricStore,
  evt: Extract<
    DiagnosticEventPayload,
    { type: "sessions.list.retention" | "sessions.event.retention" }
  >,
) {
  if (evt.type === "sessions.list.retention") {
    store.gauge(
      "openclaw_sessions_list_retained_views",
      "Retained session-list views across all publications.",
      {},
      evt.views,
    );
    store.gauge(
      "openclaw_sessions_list_retained_refs",
      "Row references and selection entries retained by session-list views.",
      {},
      evt.refs,
    );
    store.gauge(
      "openclaw_sessions_list_retained_bytes",
      "Estimated memory retained by session-list views.",
      {},
      evt.estimatedBytes,
    );
    return;
  }
  store.gauge(
    "openclaw_session_event_rows_retained_entries",
    "Session-event field-hash vectors retained across all connections.",
    {},
    evt.entries,
  );
  store.gauge(
    "openclaw_session_event_rows_retained_bytes",
    "Estimated memory retained by session-event field-hash vectors.",
    {},
    evt.estimatedBytes,
  );
}
