import type { OpenClawPluginServiceContext } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

type GatewayWsMetricsListener = Parameters<
  NonNullable<
    NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>["onGatewayWsMetrics"]
  >
>[0];

export function createGatewayWsMetricsRecorder(
  store: PrometheusMetricStore,
): GatewayWsMetricsListener {
  // Store operations consume label values synchronously; no per-flush label snapshots are needed.
  const labels = { event: "" };
  const frameLabels = { event: "", le: "" };
  const presenceLabels = { mode: "" };
  const sessionLabels = { event: "", reason: "", delivery: "" };
  return (event, count, bytes, wireBytes, buckets, bucketLabels, sessionEvent, presenceMode) => {
    labels.event = frameLabels.event = sessionLabels.event = event;
    store.counter(
      "openclaw_gateway_ws_events_total",
      "Outbound Gateway WebSocket event frames accepted by the sender per socket.",
      labels,
      count,
    );
    store.counter(
      "openclaw_gateway_ws_event_bytes_total",
      "Encoded outbound Gateway WebSocket event bytes before framing or compression per socket.",
      labels,
      bytes,
    );
    if (wireBytes !== undefined) {
      store.counter(
        "openclaw_gateway_ws_event_wire_bytes_total",
        "Outbound Gateway WebSocket payload bytes after compression per socket, excluding framing.",
        labels,
        wireBytes,
      );
    }
    if (count > 0) {
      let cumulative = 0;
      for (let i = 0; i < bucketLabels.length; i++) {
        cumulative += buckets[i]!;
        frameLabels.le = bucketLabels[i]!;
        // Seed empty buckets without changing other counters' zero-increment behavior.
        const record = cumulative === 0 ? store.counterValue : store.counter;
        record(
          "openclaw_gateway_ws_event_frame_bytes",
          "Cumulative counts of accepted raw Gateway event frames by byte-size upper bound.",
          frameLabels,
          cumulative,
        );
      }
    }
    if (presenceMode) {
      presenceLabels.mode = presenceMode;
      store.counter(
        "openclaw_gateway_ws_presence_frames_total",
        "Outbound presence frames accepted by the sender per socket, by delivery mode.",
        presenceLabels,
        count,
      );
      store.counter(
        "openclaw_gateway_ws_presence_bytes_total",
        "Encoded outbound presence bytes before framing or compression per socket, by delivery mode.",
        presenceLabels,
        bytes,
      );
    }
    if (sessionEvent) {
      sessionLabels.reason = sessionEvent.reason;
      sessionLabels.delivery = sessionEvent.delivery;
      store.counter(
        "openclaw_gateway_ws_session_event_frames_total",
        "Outbound session event frames by reason and exact message subscription per socket.",
        sessionLabels,
        count,
      );
      store.counter(
        "openclaw_gateway_ws_session_event_bytes_total",
        "Encoded outbound session event bytes by reason and exact message subscription per socket.",
        sessionLabels,
        bytes,
      );
    }
  };
}

export function recordGatewayWsConnections(store: PrometheusMetricStore, operators: number): void {
  store.gauge(
    "openclaw_gateway_ws_operator_connections",
    "Connected authenticated Gateway operator WebSockets.",
    {},
    operators,
  );
}
