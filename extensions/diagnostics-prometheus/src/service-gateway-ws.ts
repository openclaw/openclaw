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
