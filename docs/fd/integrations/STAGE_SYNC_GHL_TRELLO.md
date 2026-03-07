# Stage Sync: GHL <-> Trello

## Purpose

Synchronize:

- Trello list movement -> GHL Opportunity stage
- GHL stage change -> Trello card list movement

Bidirectional but controlled.

## Mapping Table

| Trello List | GHL Stage |
|-------------|-----------|
| `Inbox / Awaiting Details` | Intake |
| `In Progress` | In Production |
| `Needs Review / Feedback` | Client Review |
| `Approved / Ready for Delivery` | Approved |
| `Published / Delivered` | Delivered |

Configure via:

- `TRELLO_LIST_TO_STAGE_JSON` (Trello list name -> GHL stage ID)
- `STAGE_TO_TRELLO_LIST_JSON` (GHL stage ID -> Trello list name)

## Trello -> GHL

When a card moves between lists:

1. Detect list change (`listBefore` / `listAfter`)
2. Resolve GHL contact via:
   - `contact_board_map` table (fast local index)
   - `fulfillment_jobs` table (fallback)
3. Map `listAfter` name to GHL stage ID via `TRELLO_LIST_TO_STAGE_JSON`
4. Update GHL opportunity stage

## GHL -> Trello

When GHL stage changes (via GHL webhook):

1. Resolve `board_id` from GHL contact custom field (`TrelloBoardId`)
2. Resolve primary card via `fulfillment_jobs.metadata_json`
3. Map GHL stage ID to Trello list name via `STAGE_TO_TRELLO_LIST_JSON`
4. Move card to canonical list

## Idempotency

- If already in correct stage, skip
- If mapping missing, log and exit
- Never create duplicate opportunity
- Trello action ID used for deduplication (`seen_or_mark`)

## Safety Mode

If `DRY_RUN=true`:

- Log intended stage change via audit
- Do not call GHL API
- Do not move Trello card

If `READ_ONLY=true`:

- Raise `ReadOnlyError`
- Do not call any external API

## Timeline

Stage sync events are logged to the client board primary card:

```
Trello Card Moved

Card ID: {card_id}
Card Name: {card_name}
From List: {before_name}
To List: {after_name}
GHL Stage ID: {stage_id}
```

## Related Files

| What | Where |
|------|-------|
| Trello -> GHL sync | `services/webhook_gateway/routes/trello.py` |
| GHL -> Trello sync | `services/webhook_gateway/routes/ghl.py` |
| Stage mapping | `packages/domain/sync.py` |
| Contact resolution | `packages/domain/contact_map.py` |
| Timeline logging | `packages/domain/timeline.py` |
