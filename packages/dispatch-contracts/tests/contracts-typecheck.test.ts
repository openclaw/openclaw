import type {
  DispatchCommand,
  PolicyDecision,
  OutboxEvent,
  EvidenceRecord,
  CommsEnvelope,
} from "../src/contracts.d.ts";

const dispatchCommand: DispatchCommand = {
  tenantId: "tenant-1",
  toolName: "ticket.create",
  actor: {
    id: "actor-1",
    role: "dispatcher",
    type: "AGENT",
  },
  requestId: "req-1",
  correlationId: "corr-1",
  payload: {
    issue: "Door jam",
  },
};

const policyDecision: PolicyDecision = {
  decision: "ALLOW",
  reasonCode: "policy.allow",
  explanation: "Policy checks passed",
  effectivePolicy: {
    bundleVersion: "v1",
    bundleHash: "abc123",
  },
};

const outboxEvent: OutboxEvent = {
  eventId: "evt-1",
  tenantId: "tenant-1",
  aggregateType: "ticket",
  aggregateId: "ticket-1",
  eventType: "ticket.opened",
  version: "v1",
  correlationId: "corr-1",
  occurredAt: "2026-02-16T00:00:00.000Z",
  payload: {
    severity: "high",
  },
};

const evidenceRecord: EvidenceRecord = {
  ticketId: "ticket-1",
  objectUri: "s3://bucket/evidence/1.jpg",
  sha256: "abc123",
  retentionClass: "STANDARD",
  redactionState: "NONE",
};

const commsEnvelope: CommsEnvelope = {
  envelopeId: "env-1",
  tenantId: "tenant-1",
  ticketId: "ticket-1",
  direction: "INBOUND",
  channel: "sms",
  peer: "+10000000000",
  correlationId: "corr-1",
  body: {
    text: "Customer report",
  },
};

const invalidOutboxEvent: OutboxEvent = {
  eventId: "evt-2",
  // @ts-expect-error tenantId must be a string
  tenantId: 123,
  aggregateType: "ticket",
  aggregateId: "ticket-2",
  eventType: "ticket.closed",
  version: "v1",
  correlationId: "corr-2",
  occurredAt: "2026-02-16T00:00:00.000Z",
  payload: {},
};

export {
  dispatchCommand,
  policyDecision,
  outboxEvent,
  evidenceRecord,
  commsEnvelope,
  invalidOutboxEvent,
};
