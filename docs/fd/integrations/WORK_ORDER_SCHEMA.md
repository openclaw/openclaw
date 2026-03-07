# Work Order Schema

## Purpose

Define the canonical structure for "work orders" across:

- Client board request cards
- Internal fulfillment cards
- DB truth
- GHL linkage
- Automation logs

## Canonical Work Order Fields

### Identity

| Field | Type | Description |
|-------|------|-------------|
| `work_order_id` | TEXT | System-generated (`wo_{uuid}`) |
| `correlation_id` | TEXT | Required for all events |
| `source` | TEXT | `trello` / `ghl` / `manychat` / `stripe` |
| `source_event_id` | TEXT | Idempotency key |

### Client linkage

| Field | Type | Description |
|-------|------|-------------|
| `client_board_id` | TEXT | Trello board ID |
| `client_card_id` | TEXT | Optional |
| `ghl_contact_id` | TEXT | Optional |

### Work content

| Field | Type | Description |
|-------|------|-------------|
| `request_type` | TEXT | Classified type (enum-ish) |
| `priority` | TEXT | `high` / `medium` / `low` |
| `brief_text` | TEXT | Normalized request text |
| `payload_json` | TEXT | Original webhook payload (JSON) |

### Production state

| Field | Type | Description |
|-------|------|-------------|
| `status` | TEXT | See status enum below |
| `assigned_role` | TEXT | Matched role |
| `assigned_to` | TEXT | Assignee ID |
| `internal_card_id` | TEXT | Internal fulfillment board card |

### Timestamps

| Field | Type | Description |
|-------|------|-------------|
| `created_ts` | INTEGER | UNIX timestamp |
| `assigned_ts` | INTEGER | Optional |
| `updated_ts` | INTEGER | Optional |

## Status Enum

```
new -> mirrored -> assigned -> in_progress -> needs_review -> approved -> delivered -> archived
                                                                                   -> closed
```

## Trello Card Template Requirements

### Client Card (minimal)

- Title: freeform
- Description: encouraged to include:
  - Aspect ratio
  - Release date
  - Links (Dropbox, refs)

### Internal Card (system-generated)

Title format:

```
[{Client Name}] — {Card Title}
```

Description must include:

```
CLIENT_BOARD_ID: {board_id}
CLIENT_CARD_ID: {card_id}
CLIENT_CARD_URL: https://trello.com/c/{card_id}
REQUEST_TYPE: {type}
PRIORITY: {priority}
ROLE: {role}
GHL_CONTACT_ID: {id or N/A}
CORRELATION_ID: {correlation_id}

REQUEST_TEXT:
{brief text}
```

## Idempotency Keys

Every work order must have:

- `source_event_id` unique per `source`
- Enforced in DB via check before INSERT
- Duplicate attempts return existing work order without side effects

## DB Table

```sql
CREATE TABLE IF NOT EXISTS work_orders (
  work_order_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  correlation_id TEXT,
  request_type TEXT NOT NULL,
  priority TEXT NOT NULL,
  assigned_role TEXT,
  assigned_to TEXT,
  assigned_at INTEGER,
  status TEXT NOT NULL,
  client_board_id TEXT,
  client_card_id TEXT,
  internal_card_id TEXT,
  ghl_contact_id TEXT,
  payload_json TEXT NOT NULL
)
```

## Related Files

| What | Where |
|------|-------|
| Work order creation | `packages/domain/internal_fulfillment.py` |
| Request routing | `packages/domain/request_routing.py` |
| DB schema | `packages/common/db.py` |
| Intake mirror | `packages/domain/trello_intake_mirror.py` |
