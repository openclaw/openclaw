/**
 * Telemetry collector facade consumed by hook handlers and mappers.
 *
 * It normalizes all probe events into a single envelope and emits them through
 * the provided sink callback.
 */

import { randomUUID } from "node:crypto";
import {
  PROBE_EVENT_TYPES,
  type ProbeEvent,
  type ProbeEventSeverity,
  type ProbeEventSource,
} from "../types.js";
import { redactSensitiveText } from "./redact.js";

interface CollectorContext {
  pluginVersion: string;
  probeId: string;
  probeName: string;
  labels: Record<string, string>;
  emit(event: ProbeEvent): void;
}

type UsageMetrics = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export interface ProbeMappedEventInput {
  eventType: string;
  source: ProbeEventSource;
  severity?: ProbeEventSeverity;
  occurredAt?: string | number | Date;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  traceId?: string;
  spanId?: string;
  payload?: Record<string, unknown>;
}

export interface TelemetryCollector {
  recordSessionStart(attrs: {
    sessionId: string;
    agentId?: string;
    sessionKey?: string;
    resumedFrom?: string;
  }): void;
  recordSessionEnd(attrs: {
    sessionId: string;
    agentId?: string;
    durationMs?: number;
    messageCount: number;
  }): void;
  recordGatewayStart(attrs: { port?: number }): void;
  recordGatewayStop(attrs: { reason?: string }): void;
  recordToolCallFinished(attrs: {
    toolName: string;
    durationMs?: number;
    error?: string;
    agentId?: string;
    sessionKey?: string;
  }): void;
  recordModelResponseUsage(attrs: {
    runId: string;
    provider: string;
    model: string;
    usage?: UsageMetrics;
    agentId?: string;
    sessionId?: string;
  }): void;
  recordMappedEvent(input: ProbeMappedEventInput): void;
}

function sanitizePayloadValue(value: unknown, depth = 0): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 5) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizePayloadValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 80)) {
      out[key] = sanitizePayloadValue(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

function normalizeOccurredAt(input: ProbeMappedEventInput["occurredAt"]): string {
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    return new Date(input).toISOString();
  }
  if (input instanceof Date) {
    return input.toISOString();
  }
  return new Date().toISOString();
}

export function createTelemetryCollector(context: CollectorContext): TelemetryCollector {
  const emitProbeEvent = (input: ProbeMappedEventInput): void => {
    const payload = (sanitizePayloadValue(input.payload ?? {}, 0) as Record<string, unknown>) ?? {};
    context.emit({
      schemaVersion: "1.0",
      pluginVersion: context.pluginVersion,
      eventId: randomUUID(),
      probeId: context.probeId,
      probeName: context.probeName,
      labels: context.labels,
      eventType: input.eventType,
      occurredAt: normalizeOccurredAt(input.occurredAt),
      source: input.source,
      severity: input.severity ?? "info",
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.spanId ? { spanId: input.spanId } : {}),
      payload,
    });
  };

  return {
    recordSessionStart({ sessionId, agentId, sessionKey, resumedFrom }) {
      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_SESSION_STARTED,
        source: "session_hook",
        agentId,
        sessionId,
        sessionKey,
        payload: { resumedFrom: resumedFrom ?? null },
      });
    },

    recordSessionEnd({ sessionId, agentId, durationMs, messageCount }) {
      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_SESSION_ENDED,
        source: "session_hook",
        agentId,
        sessionId,
        payload: {
          durationMs: durationMs ?? null,
          messageCount,
        },
      });
    },

    recordGatewayStart({ port }) {
      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_GATEWAY_STARTED,
        source: "session_hook",
        payload: { port: port ?? null },
      });
    },

    recordGatewayStop({ reason }) {
      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_GATEWAY_STOPPED,
        source: "session_hook",
        payload: { reason: reason ?? null },
      });
    },

    recordToolCallFinished({ toolName, durationMs, error, agentId, sessionKey }) {
      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_TOOL_CALL_FINISHED,
        source: "session_hook",
        severity: error ? "warn" : "info",
        agentId,
        sessionKey,
        payload: {
          toolName,
          durationMs: durationMs ?? null,
          error: error ? redactSensitiveText(error) : null,
        },
      });
    },

    recordModelResponseUsage({ runId, provider, model, usage, agentId, sessionId }) {
      const input = usage?.input ?? 0;
      const output = usage?.output ?? 0;
      const cacheRead = usage?.cacheRead ?? 0;
      const cacheWrite = usage?.cacheWrite ?? 0;
      const total = usage?.total ?? input + output + cacheRead + cacheWrite;

      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.AUDIT_MODEL_RESPONSE_USAGE,
        source: "session_hook",
        agentId,
        sessionId,
        traceId: runId,
        payload: {
          runId,
          provider,
          model,
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            total,
          },
        },
      });

      emitProbeEvent({
        eventType: PROBE_EVENT_TYPES.REALTIME_TRACE_ACTION_SPAN,
        source: "session_hook",
        agentId,
        sessionId,
        traceId: runId,
        spanId: `${runId}:model.response`,
        payload: {
          stage: "model.response",
          provider,
          model,
          status: "completed",
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite,
            total,
          },
        },
      });
    },

    recordMappedEvent(input) {
      emitProbeEvent(input);
    },
  };
}
