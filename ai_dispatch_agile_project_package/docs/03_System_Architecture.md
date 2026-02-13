# System Architecture — Dispatch API Enforcement + Closed Toolset

## 1) Key principle
**Agents do not mutate state directly.**  
They call a closed set of tools, and tools call **dispatch-api**, which enforces:
- state machine validity
- role-based authorization
- idempotency
- audit event emission

## 2) Logical components

```mermaid
flowchart LR
    C[Customer / Site] -->|SMS/Web/Email| G[Gateway / Ingress]
    G -->|create/triage| A[Agent Runtime]
    A -->|tool call| T[Tool Bridge (closed toolset)]
    T -->|command| D[dispatch-api]
    D --> P[(Postgres)]
    D --> S[(Object store: MinIO/S3)]:::store
    D --> E[Event bus / Outbox]:::bus
    E --> W[Workers: notifications, SLA timers, QA sampling]
    classDef store fill:#eef,stroke:#88a;
    classDef bus fill:#efe,stroke:#8a8;
```

### Component responsibilities
- **Gateway/Ingress**: normalizes inbound channels, assigns correlation IDs, authenticates callers
- **Agent Runtime**: proposes actions, asks follow-up questions, drafts messages
- **Tool Bridge**: the only capability surface; strict allowlist; converts tool calls → dispatch-api commands
- **dispatch-api**: source of truth for ticket state, validations, audit, and events
- **Workers**: async tasks (reminders, SLA evaluation, QA sampling, invoice generation)

## 3) API style: command endpoints
Dispatch is mutation-heavy with strong invariants. Prefer command endpoints:

- `POST /tickets` create
- `POST /tickets/{id}/triage`
- `POST /tickets/{id}/schedule/propose`
- `POST /tickets/{id}/schedule/confirm`
- `POST /tickets/{id}/assignment/dispatch`
- `POST /tickets/{id}/tech/check-in`
- `POST /tickets/{id}/tech/request-change`
- `POST /tickets/{id}/approval/decide`
- `POST /tickets/{id}/tech/complete`
- `POST /tickets/{id}/qa/verify`
- `POST /tickets/{id}/billing/generate-invoice`

Read endpoints can be REST-like:
- `GET /tickets/{id}`
- `GET /tickets?state=...`
- `GET /tickets/{id}/timeline`
- `GET /sites/{id}`
- `GET /assets/{id}`

## 4) Idempotency strategy
### Requirements
- Every command must be safely retryable.
- A client-provided `request_id` (UUID) is mandatory (or `Idempotency-Key` header).
- The server stores `(actor_id, request_id, route)` → response hash/payload.

### Pattern
- `idempotency_keys` table:
  - `id` (uuid)
  - `request_id`
  - `actor_id`
  - `endpoint`
  - `request_hash`
  - `response_code`
  - `response_body`
  - timestamps
  - unique constraint: `(actor_id, endpoint, request_id)`

On replay:
- if same request_hash → return stored response
- if different request_hash → return 409 conflict (“idempotency key reuse with different body”)

## 5) Audit + outbox event emission
### Append-only audit log
Every successful mutation writes an `audit_events` row with:
- before/after state
- actor identity and role
- tool_name
- correlation ids (correlation_id, trace_id)
- payload (sanitized)
- version, timestamps

### Outbox
Also write an `outbox_events` row (or reuse audit as outbox) to trigger:
- notification jobs
- SLA timer evaluation
- QA sampling
- invoice generation

Workers poll outbox deterministically.

## 6) Concurrency control
Use optimistic locking:
- `tickets.version` increments each mutation
- commands include optional `expected_version` for strict concurrency; otherwise accept latest but record.

## 7) Storage of evidence artifacts
Evidence payloads are stored in object storage (S3/MinIO), and referenced by:
- `evidence_items` table (ticket_id, type, uri, checksum, metadata)

## 8) Policy enforcement boundaries
Enforcement rules live in dispatch-api:
- role-based authz
- state transitions
- required fields and evidence

AI agent logic is advisory; it can suggest and draft, but cannot bypass enforcement.

