# Marketing Overlay Service

Phase 1 and Phase 2 shadow-mode marketing overlay for Prestigio.

This service:

- reads Prestigio truth directly from Supabase using isolated credentials
- writes additive overlay files under `~/.openclaw/workspace/marketing/`
- folds append-only human review actions into persistent review state
- never writes to Prestigio tables
- never posts publicly
- never changes Prestigio app workflows

## Scope

Implemented here:

- backfill mode for the last 180 days of qualifying completed items
- incremental mode for newly qualifying or recently updated items
- requestId-scoped build requests and build responses
- shadow-only candidate packet generation
- conservative redaction and privacy defaults
- append-only approval action files
- review-state rehydration across rebuilds
- health endpoint

Explicitly not implemented here:

- Instagram publishing
- outreach sending
- website publishing
- any approval UI beyond the Stitch file-based skill surface
- any Prestigio operational writes

## Output tree

```text
~/.openclaw/workspace/marketing/
  build-requests/
  build-responses/
  build-status.json
  overrides.json
  approvals/
    <requestId>.json
  review-state.json
  candidates/
    summary.json
    by-id/
      cand_<order_item_id>.json
```

## Candidate rules

An item becomes a shadow candidate only when all of these are true:

- `status` is `work_complete`, `ready for pick up`, or `collected`
- `completion_photos` is non-empty
- item is not canceled
- item is not on hold
- item is not excluded by `overrides.json`

Every candidate always defaults to:

- `status: "shadow"`
- `eligibility.public_ready: "pending_human_review"`
- `approvals.instagram/site/outreach: "pending"`

Review decisions are stored separately from candidate generation:

- `approvals/*.json` is the append-only action log
- `review-state.json` is the reduced current state
- rebuilds rehydrate candidate files from the approval log so prior human decisions persist

## Redaction rules

Public-facing draft text never uses raw client names by default and applies conservative sanitation:

- strips client and project names from draft text
- strips address-like and location-like details
- excludes internal-only notes from public assets

Internal source truth is still preserved in packet `source` fields so the shadow queue remains explainable.

## Overrides

`overrides.json` supports these arrays:

```json
{
  "exclude_projects": [],
  "exclude_clients": [],
  "exclude_order_items": [],
  "exclude_categories": []
}
```

Each exclude bucket accepts IDs or names. Matching is normalized case-insensitively.

## Review actions

Phase 2 approval actions are written as request-scoped JSON files:

```json
{
  "requestId": "approve-instagram-20260324T120000",
  "candidate_id": "cand_123",
  "actor": "chris",
  "action": "approve",
  "channel": "instagram",
  "edits": null,
  "reason": null,
  "snooze_until": null,
  "created_at": "2026-03-24T12:00:00-07:00"
}
```

Supported actions:

- `approve`
- `reject`
- `snooze`
- `reopen`

Rejected candidates stop resurfacing until reopened. Snoozed candidates stay out of the visible queue until `snooze_until` expires.

## Build requests

Drop a JSON file into `build-requests/`:

```json
{
  "requestId": "backfill-20260324",
  "mode": "backfill",
  "days": 180
}
```

Or for incremental:

```json
{
  "requestId": "incremental-20260324",
  "mode": "incremental",
  "since": "2026-03-24T00:00:00Z"
}
```

The service writes the matching response to `build-responses/<requestId>.json`.

## Health

`GET /health`

Returns last build metadata, queue depth, candidate counts, and the last error if any.

## Local run

```bash
cd /Users/chrisreyes/openclaw/marketing-overlay-service
node index.js --once --mode backfill
```

The service will also load `/Users/chrisreyes/openclaw/.env` if `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are not already in the environment.
