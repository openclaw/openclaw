# Client Lifecycle State Machine

## Purpose

Formalize lifecycle transitions for:

- Client request cards (Trello list progression)
- GHL pipeline stages
- Internal work order statuses
- Cleanup/archival behavior

System must be deterministic and avoid oscillation.

## State Graph (Client Card)

### States (by list)

| State | Trello List |
|-------|-------------|
| `INBOX` | Inbox / Awaiting Details |
| `IN_PROGRESS` | In Progress |
| `NEEDS_REVIEW` | Needs Review / Feedback |
| `APPROVED_READY` | Approved / Ready for Delivery |
| `PUBLISHED_DELIVERED` | Published / Delivered |
| `ARCHIVED` | Archived (internal cleanup target) |

### Allowed Transitions

```
INBOX -> IN_PROGRESS
IN_PROGRESS -> NEEDS_REVIEW
NEEDS_REVIEW -> IN_PROGRESS          (revisions)
NEEDS_REVIEW -> APPROVED_READY
APPROVED_READY -> PUBLISHED_DELIVERED
IN_PROGRESS -> APPROVED_READY        (edge case)
APPROVED_READY -> IN_PROGRESS        (rare rollback)
```

### Disallowed

- `PUBLISHED_DELIVERED -> IN_PROGRESS` (unless forced/manual)

## GHL Stage Mapping

| Trello List | GHL Stage |
|-------------|-----------|
| Inbox / Awaiting Details | Intake |
| In Progress | In Production |
| Needs Review / Feedback | Client Review |
| Approved / Ready for Delivery | Approved |
| Published / Delivered | Delivered |

## Sync Rules

### Trello -> GHL (authoritative)

If client card moves lists, update GHL stage.

### GHL -> Trello (controlled)

Only move Trello card if:

- Mapping exists AND
- No conflict with recent Trello move AND
- Not in DRY_RUN mode

## Lifecycle Events (Timeline)

Each transition produces a timeline event with:

- Title
- Human-readable fields
- Machine JSON snippet
- Correlation ID
- UTC timestamp

## Cleanup

"Soft cleanup" occurs when:

- Delivered + aged beyond threshold OR
- Offer lifecycle ends OR
- Manual close

### Soft cleanup actions

1. Delete Trello webhooks (per-board)
2. Create "Archived" list if missing
3. Move primary card to Archived list
4. Create "Archived" label if missing
5. Apply label to primary card
6. Add cleanup summary comment with JSON snippet

### Board closure

Board closure is disabled by default:

```
TRELLO_CLOSE_BOARD_ON_CLEANUP=false
```

## Related Files

| What | Where |
|------|-------|
| Lifecycle cleanup | `packages/domain/lifecycle_cleanup.py` |
| Stage sync | `packages/domain/sync.py` |
| Timeline logging | `packages/domain/timeline.py` |
| Trello webhook | `services/webhook_gateway/routes/trello.py` |
| GHL webhook | `services/webhook_gateway/routes/ghl.py` |
