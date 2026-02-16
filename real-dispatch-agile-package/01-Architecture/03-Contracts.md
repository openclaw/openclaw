# Core contracts

## DispatchCommand (single mutation envelope)

Required fields:

- tenantId
- toolName
- actor {type, role, id}
- requestId (idempotency)
- correlationId (end-to-end chain)
- trace context (W3C traceparent/tracestate)
- payload (tool-specific)

## PolicyDecision

- decision: ALLOW | DENY | REQUIRE_APPROVAL | REQUIRE_EVIDENCE
- reasonCode (machine)
- explanation (human)
- requiredApprovals (optional)
- requiredEvidenceKeys (optional)
- effectivePolicy {bundleVersion, bundleHash}

## EvidenceRecord

- object pointer (s3/minio uri)
- sha256 hash
- retention class
- redaction state + redacted pointer (optional)
- linkage to ticket/case and command/audit chain

## OutboxEvent

- eventId, tenantId
- aggregateType + aggregateId
- eventType + version
- occurredAt
- correlationId + trace context (optional)
- minimal payload (canonical fact)

## CommsEnvelope

- inbound/outbound, channel, peer
- body/transcript/media
- provider metadata + raw payload
- linked ticket/case + correlationId
- becomes evidence/timeline artifact
