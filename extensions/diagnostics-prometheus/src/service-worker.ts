import type { OpenClawPluginServiceContext } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

type WorkerRequestMetricsListener = Parameters<
  NonNullable<
    NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>["onWorkerRequestMetrics"]
  >
>[0];

export function createWorkerRequestMetricsRecorder(
  store: PrometheusMetricStore,
): WorkerRequestMetricsListener {
  return (kind, requestClass, requestPhase, queueDepth, queueWaitMs, durationMs, timing) => {
    store.gauge(
      "openclaw_worker_queue_depth",
      "Requests awaiting dispatch across worker owners of this kind.",
      { kind },
      queueDepth,
    );
    const labels = { kind, request_class: requestClass };
    store.histogram(
      "openclaw_worker_queue_wait_seconds",
      "Elapsed time from worker request enqueue to dispatch.",
      labels,
      seconds(queueWaitMs),
    );
    store.histogram(
      "openclaw_worker_request_seconds",
      "Elapsed time from worker dispatch to reply or failure, including preparation and transport.",
      labels,
      seconds(durationMs),
    );
    if (requestPhase !== "completed" || !timing) {
      return;
    }
    // postFinished overlaps worker execution. These boundaries partition the
    // request instead, including preparation and every input/result frame.
    for (const [phase, start, end] of [
      ["dispatch", "dispatched", "posted"],
      ["delivery", "posted", "received"],
      ["input", "received", "inputReady"],
      ["prepare", "inputReady", "executeStarted"],
      ["execute", "executeStarted", "executeFinished"],
      ["result", "executeFinished", "replied"],
      ["reply", "replied", "replyReceived"],
    ] as const) {
      const started = timing[start];
      const finished = timing[end];
      if (started === undefined || finished === undefined) {
        continue;
      }
      store.histogram(
        "openclaw_worker_request_phase_seconds",
        "Elapsed time within an observed SQLite worker request phase, including transport.",
        { ...labels, phase },
        seconds(finished - started),
      );
    }
  };
}
