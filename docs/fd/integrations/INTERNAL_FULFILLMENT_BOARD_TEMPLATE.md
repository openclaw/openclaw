# Internal Fulfillment Board Template

## Purpose

Define centralized assignment board structure.
Avoid Trello paid seat explosion.

## Board Name

```
Full Digital – Internal Fulfillment
```

## Lists

1. `Inbox`
2. `Assigned`
3. `In Progress`
4. `Review`
5. `Completed`
6. `Archived`

## Configuration

| Variable | Purpose |
|----------|---------|
| `INTERNAL_FULFILLMENT_TRELLO_BOARD_ID` | Board ID (must exist) |
| `INTERNAL_FULFILLMENT_INBOX_LIST_NAME` | Where new work orders land |
| `INTERNAL_FULFILLMENT_AUTOCREATE_LISTS` | Auto-create missing lists |
| `INTERNAL_FULFILLMENT_LISTS_JSON` | List names to auto-create |

## Work Order Card Structure

Each work order card must include:

```
CLIENT_BOARD_ID: {board_id}
CLIENT_CARD_ID: {card_id}
CLIENT_CARD_URL: https://trello.com/c/{card_id}
REQUEST_TYPE: {cover_art|flyer|motion|lyric_video|branding|unknown}
ASPECT_RATIO: {detected or N/A}
ASSIGNED_TO: {role or name}
CORRELATION_ID: {correlation_id}
```

## Attachments

Each work order card gets:

- **Client Board** link: `https://trello.com/b/{client_board_id}`
- **Client Card** link: `https://trello.com/c/{client_card_id}` (if exists)

## Assignment Model

Assignment handled by:

- DB round-robin from `team_members` table
- Skill tags matching request type to role
- Capacity tracking

Trello member assignment is optional.
Prefer label-based assignment:

```
Assigned: Maya
Assigned: Jordan
```

## Sync Rules

When internal card moves:

- Do NOT auto-move client card
- Only client board movement updates GHL stage

Internal board is execution truth only.

## Related Files

| What | Where |
|------|-------|
| Work order creation | `packages/domain/internal_fulfillment.py` |
| Request routing | `packages/domain/request_routing.py` |
| Intake mirror | `packages/domain/trello_intake_mirror.py` |
| Assignment engine | `packages/domain/assignment.py` |
