import type { DiagnosticEventPayload } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

export function recordWorkerRequest(
  store: PrometheusMetricStore,
  event: Extract<DiagnosticEventPayload, { type: "worker.request" }>,
): void {
  store.gauge(
    "openclaw_worker_queue_depth",
    "Requests awaiting dispatch across worker owners of this kind.",
    { kind: event.kind },
    event.queueDepth,
  );
  const labels = { kind: event.kind, request_class: event.requestClass };
  store.histogram(
    "openclaw_worker_queue_wait_seconds",
    "Elapsed time from worker request enqueue to dispatch.",
    labels,
    seconds(event.queueWaitMs),
  );
  store.histogram(
    "openclaw_worker_request_seconds",
    "Elapsed time from worker dispatch to reply or failure, including preparation and transport.",
    labels,
    seconds(event.durationMs),
  );
}
