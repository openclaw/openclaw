# Formspree Intake Session

## Goal

Treat one Formspree webhook delivery as one intake session inside OpenClaw.
The intake session keeps full internal inquiry data for ops, while exposing only a public-safe visitor event to scene surfaces.

## Incoming payload

Current Formspree intake fields:

- `email`
- `company`
- `phone`
- `service`
- `message`
- optional `subject`

OpenClaw should accept the full payload first, then split it into internal and public-safe views.

## Canonical intake session

```json
{
  "session_type": "formspree_intake_session",
  "source": "formspree",
  "received_at": "2026-03-17T18:05:00Z",
  "public_event": {
    "type": "visitor.inquiry.detected",
    "source": "formspree",
    "received_at": "2026-03-17T18:05:00Z",
    "has_sender": true,
    "has_subject": true,
    "raw_subject": "資料請求",
    "category": "document_request"
  },
  "contact": {
    "has_email": true,
    "has_company": true,
    "has_phone": true
  },
  "routing": {
    "category": "document_request",
    "service": "AI Agent導入支援",
    "initial_owner": "ops"
  },
  "raw": {
    "email": "person@example.com",
    "company": "Example Inc.",
    "phone": "03-0000-0000",
    "service": "AI Agent導入支援",
    "subject": "資料請求",
    "message": "資料をお願いします"
  }
}
```

## Public/internal split

### Internal only

Keep inside OpenClaw intake session and ops handling:

- `raw.email`
- `raw.company`
- `raw.phone`
- `raw.service`
- `raw.subject`
- `raw.message`

### Public-safe for scene

Use only:

- `public_event.type`
- `public_event.source`
- `public_event.received_at`
- `public_event.has_sender`
- `public_event.has_subject`
- `public_event.category`

Scene should never show raw sender, phone, company, or message body.

## Why ops owns the first intake

- ops already handles operational triage
- inquiry arrival is an intake/triage problem before it becomes sales or planning work
- this keeps the first version small and reversible

## Routing note

Keep `routing.service` even in the first version.
It is the cleanest future hint for handoff such as:

- information systems
- business operations
- management planning
- future sales/accounting roles

## Scene usage

The public scene only needs to know that a visitor-like inquiry arrived.
Recommended effect:

- temporary visitor appears at the entrance
- business operations role changes to `問い合わせ対応中`
- no raw inquiry content is displayed
