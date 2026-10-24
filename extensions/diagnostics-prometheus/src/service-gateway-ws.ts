import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export function recordGatewayWsEvent(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "gateway.ws.event" | "gateway.ws.connections" }>,
): void {
  switch (evt.type) {
    case "gateway.ws.event": {
      const labels = { event: evt.event };
      store.counter(
        "openclaw_gateway_ws_events_total",
        "Outbound Gateway WebSocket event frames accepted by the sender per socket.",
        labels,
        evt.count,
      );
      store.counter(
        "openclaw_gateway_ws_event_bytes_total",
        "Encoded outbound Gateway WebSocket event bytes before framing or compression per socket.",
        labels,
        evt.bytes,
      );
      if (evt.wireBytes !== undefined) {
        store.counter(
          "openclaw_gateway_ws_event_wire_bytes_total",
          "Outbound Gateway WebSocket payload bytes after compression per socket, excluding framing.",
          labels,
          evt.wireBytes,
        );
      }
      for (const [le, count] of Object.entries(evt.frameBytes ?? {})) {
        // Seed empty buckets without changing other counters' zero-increment behavior.
        const record = count === 0 ? store.counterValue : store.counter;
        record(
          "openclaw_gateway_ws_event_frame_bytes",
          "Cumulative counts of accepted raw Gateway event frames by byte-size upper bound.",
          { ...labels, le },
          count,
        );
      }
      if (evt.presenceMode) {
        const presenceLabels = { mode: evt.presenceMode };
        store.counter(
          "openclaw_gateway_ws_presence_frames_total",
          "Outbound presence frames accepted by the sender per socket, by delivery mode.",
          presenceLabels,
          evt.count,
        );
        store.counter(
          "openclaw_gateway_ws_presence_bytes_total",
          "Encoded outbound presence bytes before framing or compression per socket, by delivery mode.",
          presenceLabels,
          evt.bytes,
        );
      }
      if (evt.sessionEvent) {
        const sessionLabels = { event: evt.event, ...evt.sessionEvent };
        store.counter(
          "openclaw_gateway_ws_session_event_frames_total",
          "Outbound session event frames by reason and exact message subscription per socket.",
          sessionLabels,
          evt.count,
        );
        store.counter(
          "openclaw_gateway_ws_session_event_bytes_total",
          "Encoded outbound session event bytes by reason and exact message subscription per socket.",
          sessionLabels,
          evt.bytes,
        );
      }
      return;
    }
    case "gateway.ws.connections":
      store.gauge(
        "openclaw_gateway_ws_operator_connections",
        "Connected authenticated Gateway operator WebSockets.",
        {},
        evt.operators,
      );
  }
}
