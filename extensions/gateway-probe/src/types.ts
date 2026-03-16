/**
 * Shared types for the gateway-probe plugin.
 *
 * Scope: observe existing gateway/runtime events, normalize them, and optionally
 * forward them to Kafka. The plugin never blocks or mutates core behavior.
 */

export interface GatewayProbeConfig {
  probe?: {
    /** Unique probe identifier (persistent local UUID if empty). */
    probeId?: string;
    /** Human-readable name for this gateway node. */
    name?: string;
  };
  /** Extra labels attached to every emitted event. */
  labels?: Record<string, string>;
  kafka?: {
    /** Enable Kafka publishing. Disabled by default for a zero-egress baseline. */
    enabled?: boolean;
    /** Kafka brokers (for example ["127.0.0.1:9092"]). */
    brokers?: string[];
    /** Destination topic for probe events. */
    topic?: string;
    /** Kafka client id. */
    clientId?: string;
    /** Batch flush interval in milliseconds. */
    flushIntervalMs?: number;
    /** Maximum events sent in one Kafka request. */
    batchMaxSize?: number;
    /** In-memory queue cap before dropping oldest events. */
    maxQueueSize?: number;
  };
}

export const PROBE_EVENT_TYPES = {
  AUDIT_SESSION_STARTED: "audit.session.started",
  AUDIT_SESSION_ENDED: "audit.session.ended",
  AUDIT_GATEWAY_STARTED: "audit.gateway.started",
  AUDIT_GATEWAY_STOPPED: "audit.gateway.stopped",
  AUDIT_TOOL_CALL_FINISHED: "audit.tool.call.finished",
  AUDIT_MODEL_RESPONSE_USAGE: "audit.model.response.usage",
  OPS_SUBSYSTEM_ERROR: "ops.subsystem.error",
  SECURITY_WS_UNAUTHORIZED: "security.ws.unauthorized",
  SECURITY_HTTP_TOOL_INVOKE_FAILED: "security.http.tool_invoke.failed",
  SECURITY_HTTP_MALFORMED_OR_RESET: "security.http.malformed_or_reset",
  SECURITY_DEVICE_ROLE_ESCALATION: "security.device.role_escalation",
  REALTIME_WEBHOOK_ERROR: "realtime.webhook.error",
  REALTIME_MESSAGE_PROCESSED: "realtime.message.processed",
  REALTIME_SESSION_STUCK: "realtime.session.stuck",
  REALTIME_TOOL_LOOP: "realtime.tool.loop",
  REALTIME_TRACE_ACTION_SPAN: "realtime.trace.action_span",
} as const;

export type ProbeEventType = (typeof PROBE_EVENT_TYPES)[keyof typeof PROBE_EVENT_TYPES];

export type ProbeEventSource = "session_hook" | "diagnostic" | "app_log";

export type ProbeEventSeverity = "info" | "warn" | "error" | "critical";

export interface ProbeEvent {
  schemaVersion: "1.0";
  pluginVersion: string;
  eventId: string;
  probeId: string;
  probeName: string;
  labels: Record<string, string>;
  eventType: ProbeEventType | string;
  occurredAt: string;
  source: ProbeEventSource;
  severity: ProbeEventSeverity;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  payload: Record<string, unknown>;
}

export interface ResolvedProbeConfig {
  probe: {
    probeId: string;
    name: string;
  };
  labels: Record<string, string>;
  kafka: {
    enabled: boolean;
    brokers: string[];
    topic: string;
    clientId: string;
    flushIntervalMs: number;
    batchMaxSize: number;
    maxQueueSize: number;
  };
}
