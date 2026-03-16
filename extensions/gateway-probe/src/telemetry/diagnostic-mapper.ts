import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import { PROBE_EVENT_TYPES, type ProbeEventSeverity } from "../types.js";
import type { ProbeMappedEventInput } from "./collector.js";

function traceIdForEvent(evt: DiagnosticEventPayload): string | undefined {
  if ("runId" in evt && typeof evt.runId === "string") {
    return evt.runId;
  }
  if ("sessionId" in evt && typeof evt.sessionId === "string") {
    return evt.sessionId;
  }
  if ("sessionKey" in evt && typeof evt.sessionKey === "string") {
    return evt.sessionKey;
  }
  return undefined;
}

export function mapDiagnosticEvent(evt: DiagnosticEventPayload): ProbeMappedEventInput[] {
  const occurredAt = evt.ts;

  switch (evt.type) {
    case "webhook.error":
      return [
        {
          eventType: PROBE_EVENT_TYPES.REALTIME_WEBHOOK_ERROR,
          source: "diagnostic",
          severity: "error",
          occurredAt,
          payload: {
            seq: evt.seq,
            channel: evt.channel,
            updateType: evt.updateType ?? null,
            chatId: evt.chatId ?? null,
            error: evt.error,
          },
        },
      ];

    case "message.processed": {
      const severity: ProbeEventSeverity = evt.outcome === "error" ? "error" : "info";
      return [
        {
          eventType: PROBE_EVENT_TYPES.REALTIME_MESSAGE_PROCESSED,
          source: "diagnostic",
          severity,
          occurredAt,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          traceId: traceIdForEvent(evt),
          payload: {
            seq: evt.seq,
            channel: evt.channel,
            messageId: evt.messageId ?? null,
            chatId: evt.chatId ?? null,
            durationMs: evt.durationMs ?? null,
            outcome: evt.outcome,
            reason: evt.reason ?? null,
            error: evt.error ?? null,
          },
        },
      ];
    }

    case "session.stuck": {
      const severity: ProbeEventSeverity = evt.ageMs >= 10 * 60 * 1000 ? "critical" : "warn";
      return [
        {
          eventType: PROBE_EVENT_TYPES.REALTIME_SESSION_STUCK,
          source: "diagnostic",
          severity,
          occurredAt,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          traceId: traceIdForEvent(evt),
          payload: {
            seq: evt.seq,
            state: evt.state,
            ageMs: evt.ageMs,
            queueDepth: evt.queueDepth ?? null,
          },
        },
      ];
    }

    case "tool.loop":
      return [
        {
          eventType: PROBE_EVENT_TYPES.REALTIME_TOOL_LOOP,
          source: "diagnostic",
          severity: evt.level === "critical" ? "critical" : "warn",
          occurredAt,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          traceId: traceIdForEvent(evt),
          payload: {
            seq: evt.seq,
            toolName: evt.toolName,
            level: evt.level,
            action: evt.action,
            detector: evt.detector,
            count: evt.count,
            message: evt.message,
            pairedToolName: evt.pairedToolName ?? null,
          },
        },
      ];

    default:
      return [];
  }
}
