# Internal Assignment Engine

## Purpose

Provide deterministic, automatable assignment of work orders to internal team capacity without requiring Trello paid seats across client boards.

Assignment must:

- Be reproducible (same inputs -> same result)
- Be safe-mode compatible
- Store truth in DB (not Trello membership)
- Optionally reflect assignment on internal Trello card via label/comment

## Inputs

Assignment is triggered when a new work order is created (mirrored), or when a work order is re-opened.

### Required inputs

- `work_order_id`
- `request_type` (e.g., `cover_art`, `motion`)
- `priority` (e.g., `high`, `medium`, `low`)
- `client_board_id`
- `correlation_id`

### Optional inputs

- `client_card_id` (optional if originated from GHL/ManyChat intake)
- `preferred_assignee`
- `deadline`
- `skill_overrides`
- `internal_card_id`

## Data Model

### Assignment truth (DB)

Assignment truth is stored in `work_orders` table:

| Field | Type | Description |
|-------|------|-------------|
| `assigned_to` | TEXT | Assignee ID |
| `assigned_role` | TEXT | Role matched |
| `assignment_reason` | TEXT | Why this assignee was picked |
| `assigned_at` | INTEGER | UNIX timestamp |

### Capacity table

Load-bearing capacity table for deterministic selection:

```sql
CREATE TABLE IF NOT EXISTS team_capacity (
  assignee_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
)
```

## Assignment Strategy

### Baseline (V1)

Rule-based routing:

1. Determine `role` from `request_type` via `request_routing.route()`
2. Query enabled assignees whose `roles_json` includes the role
3. Choose lowest `(active_jobs / weight)` score
4. Tie-breaker: lexicographic `assignee_id`

### Optional improvements (V2+)

- SLA-aware (deadline proximity)
- Time-window capacity
- "Client affinity" routing (prefer same assignee for same client)
- Skill tags (After Effects vs Photoshop vs Blender)

## Side Effects

After assignment:

1. Persist assignment in `work_orders` table (`assigned_to`, `assigned_role`, `assigned_at`)
2. Increment `team_capacity.active_jobs` for assignee
3. Add lifecycle timeline event: `work_order.assigned`
4. If internal Trello card exists:
   - Ensure label `Assigned: {display_name}` exists on internal board
   - Apply label to internal card
   - Add professional comment with JSON snippet

## Safety / Idempotency

- If already assigned -> do not reassign unless `force=true`
- If `DRY_RUN=true` -> log intended assignment only
- No infinite retries
- Always write an audit entry

## Output

```json
{
  "ok": true,
  "work_order_id": "wo_...",
  "assigned_to": "maya",
  "role": "designer_motion",
  "priority": "high",
  "mode": "dry_run|live"
}
```

## Related Files

| What | Where |
|------|-------|
| Assignment engine | `packages/domain/internal_assignment.py` |
| Existing assignment | `packages/domain/assignment.py` |
| Work order creation | `packages/domain/internal_fulfillment.py` |
| Request routing | `packages/domain/request_routing.py` |
| Team members | `packages/common/db.py` (`team_capacity` table) |
