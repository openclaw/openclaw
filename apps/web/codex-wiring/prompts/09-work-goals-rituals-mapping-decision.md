# Ticket 09 — Workstreams/Goals/Rituals/Jobs Mapping Decision (Spec Clarification)

## Goal
Make a **single, explicit mapping decision** for how `apps/web` Workstreams, Goals, Rituals, and Jobs are backed by gateway systems. The outcome must be unambiguous and ready for low‑reasoning implementation in Ticket 10.

## Inputs (Read First)
- `apps/web/ux-opus-design/06-INFORMATION-ARCHITECTURE.md`
- `apps/web/ux-opus-design/08-AGENT-CONFIGURATION-DESIGN.md`
- `apps/web/ux-opus-design/10-UX-PATTERNS-AND-FLOWS.md`
- Current UI routes:
  - Workstreams: `apps/web/src/routes/workstreams/*`
  - Goals: `apps/web/src/routes/goals/*`
  - Rituals: `apps/web/src/routes/rituals/*`
  - Jobs: `apps/web/src/routes/jobs/*`
- Gateway systems available today:
  - Overseer: `overseer.*`
  - Automations: `automations.*`
  - Cron: `cron.*`

## Definitions (Must Use)
- **Workstream**: A container for multi‑step work with tasks and dependency graph (see current Workstreams UI: DAG + list).
- **Goal**: A top‑level objective with milestones and progress (see Goals UI).
- **Ritual**: A scheduled recurring automation (see Rituals UI).
- **Job**: A low‑level schedule/run unit (Cron‑like; see Jobs UI).

## Required Functional Coverage per Surface

### Workstreams
UI expects (based on current screens):
- `Workstream`: id, name, description, status, progress, ownerId, createdAt, updatedAt, dueDate, tags
- `Task`: id, workstreamId, title, description, status, priority, assigneeId, dueDate, createdAt, updatedAt, dependencies
- Actions: create workstream, update status, view DAG, update task status/fields

### Goals
UI expects:
- `Goal`: id, title, description, status, progress, milestones[], dueDate, createdAt, updatedAt, tags
- Actions: create goal, pause/resume, update progress/milestones

### Rituals
UI expects:
- `Ritual`: id, name, description, schedule/cron, frequency, status, nextRun, lastRun, agentId, tags
- `RitualExecution`: status, startedAt, completedAt, result/error, sessionKey
- Actions: create, enable/disable, run now, view executions

### Jobs
UI expects:
- `Job`: id, name, schedule, command, enabled, status, lastRun, nextRun, createdAt
- Actions: create, edit, enable/disable, delete, run now, view runs

## Decision Options (Pick One)

### Option A — Overseer + Cron (recommended if you want minimal new backend)
- Workstreams → `overseer.status` + `overseer.work.update` (map work nodes to tasks)
- Goals → `overseer.goal.*`
- Rituals + Jobs → `cron.*`

### Option B — Automations + Cron
- Workstreams → `automations.*` (map automation graph/history to tasks)
- Goals → `overseer.goal.*` OR new goals API
- Rituals + Jobs → `cron.*`

### Option C — New Workstreams/Rituals APIs
- Workstreams → new `workstreams.*`
- Goals → `overseer.goal.*`
- Rituals → new `rituals.*`
- Jobs → `cron.*`

## Decision Criteria (Must Explicitly Evaluate)
1. **Data model fit** (fields above must map cleanly).
2. **Actions coverage** (create/run/pause/etc.).
3. **UI parity** with current screens (DAG, executions, history).
4. **Implementation risk** (new APIs vs reuse).
5. **Long‑term architecture** (alignment with Opus vision).

## Deliverables (Required)
Create **one** decision document at:
- `apps/web/codex-wiring/workstreams-goals-rituals-mapping.md`

The decision doc **must include**:
1. **Final mapping table** (Workstreams/Goals/Rituals/Jobs → APIs).
2. **RPC inventory** per surface (exact method names).
3. **Field mapping table** showing how UI fields map to gateway payloads (or missing fields).
4. **Gaps list** (new RPCs or gateway changes required).
5. **Change impact** on Ticket 10 (explicit note of required UI changes).

## Acceptance Criteria
- There is a single, explicit mapping with no open ambiguity.
- All UI fields are either mapped or flagged as missing (with a fix plan).
- Ticket 10 can be executed in low‑reasoning mode without additional decisions.

## Out of Scope
- Do **not** modify UI code here; decision doc only.

## Notes
- If no option satisfies required fields without heavy loss, explicitly recommend **UI changes** and list them in the decision doc.
