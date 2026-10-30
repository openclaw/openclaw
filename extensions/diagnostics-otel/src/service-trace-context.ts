import { context as otelContextApi, trace, TraceFlags } from "@opentelemetry/api";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
} from "openclaw/plugin-sdk/diagnostic-runtime";

export function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

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
    ? normalizeTraceContext(evt.trace)
    : undefined;
}
