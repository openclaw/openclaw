import { context as otelContextApi, trace, TraceFlags } from "@opentelemetry/api";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { normalizeDiagnosticTraceContext } from "openclaw/plugin-sdk/diagnostic-runtime";

function traceFlagsToOtel(traceFlags: string | undefined): TraceFlags {
  const parsed = Number.parseInt(traceFlags ?? "00", 16);
  return (parsed & TraceFlags.SAMPLED) !== 0 ? TraceFlags.SAMPLED : TraceFlags.NONE;
}

export function contextForTraceContext(traceContext: DiagnosticTraceContext | undefined) {
  if (!traceContext?.spanId) {
    return undefined;
  }
  return trace.setSpanContext(otelContextApi.active(), {
    traceId: traceContext.traceId,
    spanId: traceContext.spanId,
    traceFlags: traceFlagsToOtel(traceContext.traceFlags),
    isRemote: true,
  });
}

export function normalizedTrustedTraceContext(
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): DiagnosticTraceContext | undefined {
  return metadata.trusted || metadata.trustedTraceContext === true
    ? normalizeDiagnosticTraceContext(evt.trace)
    : undefined;
}
