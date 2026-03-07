# GHL_SETUP.md — GoHighLevel Configuration Specification

## 0) Purpose

Define GoHighLevel as the authoritative CRM and pipeline system for:

- Full Digital service leads
- CUTMV SaaS leads (optional)

GoHighLevel must act as the single source of truth for:

- lead lifecycle
- pipeline status
- booking events
- deal outcome

Automation system reads and writes to GHL through API only.

---

## 1) Required Entities in GHL

### 1.1 Pipelines

Create pipeline:

Name: Full Digital Sales

Stages:

1. New Lead
2. Qualified
3. Booked
4. Call Completed
5. Won
6. Lost

Store stage IDs in environment variables.

---

### 1.2 Required Tags

```
lead
cutmv
fulldigital
high_intent
low_budget
enterprise
```

---

### 1.3 Required Custom Fields

```
OfferIntent       (text)
BudgetRange       (dropdown)
Timeline          (dropdown)
SourcePlatform    (dropdown)
ExternalCorrelationID (text)
```

---

## 2) API Access

Generate sub-account API key.

Store:

```
GHL_API_KEY
GHL_PIPELINE_ID
GHL_STAGE_NEW_ID
GHL_STAGE_BOOKED_ID
GHL_STAGE_WON_ID
```

---

## 3) Lead Creation Logic

When event = `lead.captured`:

System must:

- create contact if not exists
- update if exists
- attach tags
- set stage = NEW
- store correlation_id in custom field

Must be idempotent.

---

## 4) Booking Logic

When `booking.created`:

- update pipeline stage → BOOKED
- add note with booking timestamp
- update custom fields if new info exists

---

## 5) Deal Won Logic

When `payment.paid`:

- set stage → WON
- store Stripe payment ID
- emit `fulfillment.created` event

---

## 6) Read-Only Safety Mode

When `READ_ONLY=true`:

- system may fetch contacts
- system may fetch pipeline info
- system must not create/update contacts

---

## 7) Failure Handling

If GHL returns 429:

- exponential retry with jitter
- max 5 attempts

If 5xx:

- retry

If 4xx:

- log audit failure and stop
