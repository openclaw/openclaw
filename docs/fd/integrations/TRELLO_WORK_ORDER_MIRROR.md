# Trello Work Order Mirror

## Purpose

Mirror client request cards from a Client Board into a centralized Internal Fulfillment Board without requiring paid Trello seats across all boards.

This system:

- Preserves client board as delivery truth
- Uses internal board as assignment truth
- Avoids paid Trello member duplication
- Maintains bidirectional traceability
- Supports safe-mode and dry-run execution

## Trigger Conditions

Mirror is triggered when:

1. A card is **created** in:
   - `Inbox / Awaiting Details`
   - `Request`
   - `Requests`

2. A card is **moved** into one of the above lists

Configurable via `CLIENT_REQUEST_LIST_NAMES_JSON`.

## Workflow

### Step 1 — Validate Request List

Check if `list_name` is in `CLIENT_REQUEST_LIST_NAMES_JSON`.

If not, exit silently.

### Step 2 — Idempotency Check

Query `intake_requests` table for existing mapping with same `client_card_id`.

If mapping already exists:
- Do not create duplicate internal card
- Add audit entry
- Exit safely

### Step 3 — Create Internal Work Order

Create a new card on:

- **Board**: `INTERNAL_FULFILLMENT_TRELLO_BOARD_ID`
- **List**: `INTERNAL_FULFILLMENT_INBOX_LIST_NAME`

Card name format:

```
[{Client Board Name}] — {Original Card Name}
```

Card description must include:

```
CLIENT_BOARD_ID: {board_id}
CLIENT_CARD_ID: {card_id}
CLIENT_CARD_URL: https://trello.com/c/{card_id}
REQUEST_TEXT: {card_desc or card_name}
```

### Step 4 — Persist Mapping

Persist in `intake_requests` table:

| Field | Value |
|-------|-------|
| `client_card_id` | Trello card ID |
| `client_board_id` | Board ID |
| `internal_card_id` | New internal card ID |
| `ghl_contact_id` | Nullable |
| `correlation_id` | Required |

### Step 5 — Comment on Client Card

Add comment on client card:

```
Work order created.

Internal Card ID: {internal_card_id}

[OPENCLAW_JSON]
{"event":"work_order_created","internal_card_id":"{id}","correlation_id":"{correlation_id}"}
```

No emoji.

## Safety Mode

If `DRY_RUN=true`:

- Do not create internal card
- Log simulated card creation via audit
- Return payload as if created

## Failure Handling

If Trello API fails:

- Log via Sentry
- Write audit entry
- Do NOT retry indefinitely
- Do NOT duplicate

## Related Files

| What | Where |
|------|-------|
| Mirror logic | `packages/domain/trello_intake_mirror.py` |
| Work order creation | `packages/domain/internal_fulfillment.py` |
| Request routing | `packages/domain/request_routing.py` |
| Trello webhook handler | `services/webhook_gateway/routes/trello.py` |
| DB schema | `packages/common/db.py` (`intake_requests` table) |
