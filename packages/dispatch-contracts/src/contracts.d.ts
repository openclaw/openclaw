export const DECISION_VALUES: readonly ["ALLOW", "DENY", "REQUIRE_APPROVAL", "REQUIRE_EVIDENCE"];
export const COMMS_DIRECTIONS: readonly ["INBOUND", "OUTBOUND"];
export const RETENTION_CLASS_VALUES: readonly ["SHORT", "STANDARD", "LONG_TERM", "REGULATORY"];
export const REDACTION_STATES: readonly ["NONE", "PENDING", "REDACTED"];

export type DispatchDecision = (typeof DECISION_VALUES)[number];
export type CommsDirection = (typeof COMMS_DIRECTIONS)[number];
export type RetentionClass = (typeof RETENTION_CLASS_VALUES)[number];
export type RedactionState = (typeof REDACTION_STATES)[number];

export interface DispatchActor {
  id: string;
  role: string;
  type: string;
}

export interface DispatchCommand<TPayload = Record<string, unknown>> {
  tenantId: string;
  toolName: string;
  actor: DispatchActor;
  requestId: string;
  correlationId: string;
  traceparent?: string | null;
  tracestate?: string | null;
  payload: TPayload;
}

export interface PolicyDecision {
  decision: DispatchDecision;
  reasonCode: string;
  explanation: string;
  effectivePolicy: {
    bundleVersion: string;
    bundleHash: string;
  };
}

export interface OutboxEvent {
  eventId: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  version: string;
  correlationId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface EvidenceRecord {
  ticketId: string;
  objectUri: string;
  sha256: string;
  retentionClass: RetentionClass;
  redactionState?: RedactionState;
}

export interface CommsEnvelope<TBody = Record<string, unknown>> {
  envelopeId: string;
  tenantId: string;
  ticketId: string;
  direction: CommsDirection;
  channel: string;
  peer: string;
  correlationId: string;
  body: TBody;
}
