import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload } from "../api.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

/** Git launches carry a bounded owner label; every other executable family reports `none`. */
export function recordChildProcessSpawn(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "diagnostic.child_process.spawn" }>,
): void {
  store.counter(
    "openclaw_child_process_spawn_total",
    "Successful child launches through the shared spawn and exec owners.",
    {
      family: normalizeDiagnosticValue(evt.family),
      operation: normalizeDiagnosticValue(
        evt.operation ?? (evt.family === "git" ? "unknown" : "none"),
      ),
    },
    numericValue(evt.count) ?? 0,
  );
}
