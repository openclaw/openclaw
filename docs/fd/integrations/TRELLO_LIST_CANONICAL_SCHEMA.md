# Trello List Canonical Schema

## Purpose

Define the canonical Trello list names that the automation system depends on.

System must NOT rely on list positions.
System must match by name only.

## Client Board Canonical Lists

| List Name | Purpose |
|-----------|---------|
| `Inbox / Awaiting Details` | New requests |
| `In Progress` | Active production |
| `Needs Review / Feedback` | Awaiting client feedback |
| `Approved / Ready for Delivery` | Approved but scheduled |
| `Published / Delivered` | Completed work |
| `Reference & Links` | Static resource storage |

## Internal Fulfillment Board Lists

| List Name | Purpose |
|-----------|---------|
| `Inbox` | New mirrored requests |
| `Assigned` | Assigned to team |
| `In Progress` | Active internal work |
| `Review` | Internal review |
| `Completed` | Delivered |
| `Archived` | Soft-cleanup target |

## Configuration

Client board list names are configurable via environment variables:

| Variable | Default |
|----------|---------|
| `CLIENT_REQUEST_LIST_NAMES_JSON` | `["Inbox / Awaiting Details"]` |
| `CLIENT_IN_PROGRESS_LIST_NAMES_JSON` | `["In Progress"]` |
| `CLIENT_NEEDS_REVIEW_LIST_NAMES_JSON` | `["Needs Review / Feedback"]` |
| `CLIENT_APPROVED_READY_LIST_NAMES_JSON` | `["Approved / Ready for Delivery"]` |
| `CLIENT_PUBLISHED_LIST_NAMES_JSON` | `["Published / Delivered"]` |
| `CLIENT_REFERENCE_LIST_NAMES_JSON` | `["Reference & Links"]` |

Internal board lists are configured via:

| Variable | Default |
|----------|---------|
| `INTERNAL_FULFILLMENT_INBOX_LIST_NAME` | `Inbox` |
| `INTERNAL_FULFILLMENT_LISTS_JSON` | `["Inbox","Assigned","In Progress","Needs Review","Ready","Done","Blocked"]` |

## Enforcement Rules

- System must auto-create missing lists (safe-mode first)
- Must never delete lists
- Must never rename lists automatically

## List Resolution Strategy

When resolving list by name:

1. Exact match
2. Case-insensitive match
3. Fallback error

Never match partial strings.

## Related Files

| What | Where |
|------|-------|
| Standard lists | `packages/integrations/trello/client.py` (`standard_lists()`) |
| List resolution | `packages/domain/internal_fulfillment.py` (`_ensure_list_id()`) |
| Config | `packages/common/config.py` |
