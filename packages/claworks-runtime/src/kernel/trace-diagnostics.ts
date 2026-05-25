/**
 * Lightweight trace diagnostics for EventKernel publishes.
 * Surfaces W3C trace context via observation events (REST /v1/observation-events?type=...)
 * so operators can correlate with Gateway diagnostics-otel / log traceId.
 */
import { appendObservationEvent } from "../claworks/observability.js";
import { parseTraceparent } from "./trace-context.js";
import type { CwEvent, CwEventMatch } from "./types.js";

export const CLAWORKS_TRACE_OBSERVATION_TYPE = "claworks.trace.event_published";

export type ClaworksTraceDiagnostic = {
  event_id: string;
  event_type: string;
  source: string;
  trace_id?: string;
  traceparent?: string;
  span_id?: string;
  correlation_id?: string;
  playbook_matches: number;
};

export function buildTraceDiagnostic(
  event: CwEvent,
  matches: CwEventMatch[] = [],
): ClaworksTraceDiagnostic {
  const parsed = event.traceparent ? parseTraceparent(event.traceparent) : undefined;
  return {
    event_id: event.id,
    event_type: event.type,
    source: event.source,
    trace_id: event.traceId ?? parsed?.traceId,
    traceparent: event.traceparent,
    span_id: parsed?.spanId,
    correlation_id: event.correlationId,
    playbook_matches: matches.length,
  };
}

/** Record trace context for each EventKernel publish (no external OTEL SDK required). */
export function recordEventTraceDiagnostic(event: CwEvent, matches: CwEventMatch[] = []): void {
  const diagnostic = buildTraceDiagnostic(event, matches);
  appendObservationEvent("trace-diagnostics", CLAWORKS_TRACE_OBSERVATION_TYPE, diagnostic);
}
