import type { ClaworksTraceDiagnostic } from "@claworks/runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

/** Bridge ClaWorks EventKernel traceparent → diagnostics-otel span (trusted phase event). */
export function emitClaworksTraceToOtel(diag: ClaworksTraceDiagnostic): void {
  const now = Date.now();
  emitTrustedDiagnosticEvent({
    type: "diagnostic.phase.completed",
    name: `claworks.event.${diag.event_type}`,
    startedAt: now - 1,
    endedAt: now,
    durationMs: 1,
    details: {
      event_id: diag.event_id,
      source: diag.source,
      event_type: diag.event_type,
      playbook_matches: diag.playbook_matches,
      ...(diag.correlation_id ? { correlation_id: diag.correlation_id } : {}),
    },
    trace:
      diag.trace_id && diag.span_id
        ? {
            traceId: diag.trace_id,
            spanId: diag.span_id,
            traceFlags: "01",
          }
        : undefined,
  });
}
