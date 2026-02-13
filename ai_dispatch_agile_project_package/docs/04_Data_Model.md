# Postgres Data Model (v0)

## Design principles
- **Tickets** store current state + denormalized hot fields
- **Audit events** are append-only and explain every mutation
- **Transitions** are explicit and validated
- **Evidence** is structured and incident-type-driven
- **Idempotency** is first-class

---

## Core tables (v0)

### 1) accounts, sites, contacts
- accounts: customer org
- sites: physical locations
- contacts: authorized contacts, escalation ladder

### 2) assets (optional v0, but recommended)
- door/operator/lock/etc.
- service history linkage

### 3) tickets
- one row per work order
- holds current state, priority, incident type, NTE, schedule window, assignment

### 4) ticket_state_transitions
- one row per state transition
- references audit event

### 5) audit_events (append-only)
- actor identity + tool name
- before/after state
- payload and correlation IDs

### 6) idempotency_keys
- request de-dupe and safe retries

### 7) approvals
- NTE increases and proposals

### 8) evidence_items
- photos, signatures, documents, measurements
- stored in object store; referenced here

### 9) messages
- outbound and inbound communications (SMS/email), for audit + customer support

---

## Migration scripts included
See `db/migrations/` for a runnable schema starting point.

> Note: adjust types/constraints to your stack and required fields.

