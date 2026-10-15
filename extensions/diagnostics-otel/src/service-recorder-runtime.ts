import type { DiagnosticsMetrics } from "./service-metrics.js";
import type { DiagnosticsTraceRuntime } from "./service-traces.js";

export type DiagnosticsRecorderRuntime = DiagnosticsMetrics &
  DiagnosticsTraceRuntime & {
    captureContent: boolean;
    tracesEnabled: boolean;
  };
