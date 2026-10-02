import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

const CATALOG_LIST_METHOD = "sessions.catalog.list";
const CATALOG_LIST_PHASE_PREFIX = `${CATALOG_LIST_METHOD}.`;
const CATALOG_LIST_PHASES = new Set([
  "projection_initial",
  "planning",
  "provider",
  "coalesced",
  "projection_final",
  "delivery",
]);

export function recordGatewayRpcEvent(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "gateway.rpc" | "diagnostic.phase.completed" }>,
  metadata: DiagnosticEventMetadata,
): void {
  switch (evt.type) {
    case "diagnostic.phase.completed": {
      if (!metadata.trusted || !evt.name.startsWith(CATALOG_LIST_PHASE_PREFIX)) {
        return;
      }
      const phase = evt.name.slice(CATALOG_LIST_PHASE_PREFIX.length);
      const duration = seconds(evt.durationMs);
      if (!CATALOG_LIST_PHASES.has(phase) || duration === undefined) {
        return;
      }
      const labels = { method: CATALOG_LIST_METHOD, phase };
      store.histogram(
        "openclaw_gateway_rpc_stage_seconds",
        "Elapsed time for completed Gateway RPC owner stages.",
        labels,
        duration,
      );
      const cpu = evt.details?.threadCpuMs;
      if ((phase === "planning" || phase === "delivery") && typeof cpu === "number") {
        store.histogram(
          "openclaw_gateway_rpc_stage_thread_cpu_seconds",
          "Current-thread CPU for synchronous Gateway RPC owner stages.",
          labels,
          seconds(cpu),
        );
      }
      return;
    }
    case "gateway.rpc": {
      const labels = { method: evt.method };
      if (evt.phase === "received") {
        store.counter(
          "openclaw_gateway_rpc_requests_total",
          "Authenticated Gateway WebSocket requests received.",
          labels,
        );
        return;
      }
      store.counter(
        "openclaw_gateway_rpc_outcomes_total",
        "Gateway RPC observations by phase and outcome.",
        { phase: evt.phase, outcome: evt.outcome },
      );
      if (evt.phase === "response" && (evt.outcome === "ok" || evt.outcome === "error")) {
        store.histogram(
          "openclaw_gateway_rpc_first_response_seconds",
          "Elapsed time until the first Gateway RPC response is sent.",
          labels,
          seconds(evt.durationMs),
        );
      } else if (evt.phase === "handler") {
        store.histogram(
          "openclaw_gateway_rpc_handler_seconds",
          "Gateway RPC handler duration until return or throw.",
          labels,
          seconds(evt.durationMs),
        );
        store.histogram(
          "openclaw_gateway_rpc_admission_seconds",
          "Elapsed time from Gateway RPC receipt until handler invocation.",
          labels,
          seconds(evt.admissionMs),
        );
      } else if (evt.phase === "dispatch") {
        store.histogram(
          "openclaw_gateway_rpc_queue_wait_seconds",
          "Gateway operator request start queue wait.",
          labels,
          seconds(evt.queueWaitMs),
        );
      }
    }
  }
}
