import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export function recordSessionRetention(
  store: PrometheusMetricStore,
  evt: Extract<
    DiagnosticEventPayload,
    {
      type:
        | "sessions.list.retention"
        | "sessions.projection.retention"
        | "sessions.event.retention"
        | "sessions.event.rows.reset";
    }
  >,
) {
  if (evt.type === "sessions.event.rows.reset") {
    store.counter(
      "openclaw_session_event_rows_reset_total",
      "Retained session-event wire baselines retired by cause.",
      { cause: evt.cause },
      evt.count,
    );
    return;
  }
  if (evt.type === "sessions.projection.retention") {
    store.gauge(
      "openclaw_session_projection_owners",
      "Live resident session-row projections.",
      {},
      evt.projections,
    );
    store.gauge(
      "openclaw_session_projection_rows_retained_entries",
      "Resident entries in session-row projection maps.",
      {},
      evt.entries,
    );
    store.gauge(
      "openclaw_session_projection_rows_retained_bytes",
      "Bounded estimate of data reachable from resident session-row maps; excludes closure and native storage.",
      {},
      evt.estimatedBytes,
    );
    store.gauge(
      "openclaw_session_projection_rows_estimate_truncated",
      "Projections whose retained-data estimate reached a bound or unsupported value.",
      {},
      evt.truncatedProjections,
    );
    return;
  }
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
