# visitor.inquiry.detected

## Purpose

Minimal public-safe event for detecting that a new external inquiry entered the company intake path.

## Source of truth

- Initial source: direct Formspree webhook delivery
- Ingestion path: `POST /hooks/formspree` -> intake session -> `ops`

## Privacy rule

Do not emit the inquiry body or personally identifying content into public surfaces.
Use trigger presence and safe metadata only.

## Canonical event

```json
{
  "type": "visitor.inquiry.detected",
  "source": "formspree",
  "received_at": "2026-03-17T18:05:00Z",
  "has_sender": true,
  "has_subject": true,
  "raw_subject": "資料請求",
  "category": "document_request"
}
```

## Required fields

- `type`: fixed as `visitor.inquiry.detected`
- `source`: fixed as `formspree`
- `received_at`: ISO 8601 timestamp
- `has_sender`: boolean
- `has_subject`: boolean
- `category`: one of:
  - `inquiry`
  - `document_request`
  - `consultation`
  - `sales`
  - `other`

## Internal companion object

This event is not the whole intake session.
The internal `formspree_intake_session` keeps:

- raw email
- company
- phone
- service
- subject
- message

## Public surface rule

Public scene should react only to event presence, not inquiry content.
Example use:

- show a temporary visitor event
- switch business operations role summary to `問い合わせ対応中`

## Routing note

- `service` stays in the intake session, not in the public event
- `ops` receives the intake first
- later a dedicated `intake` agent may take ownership
