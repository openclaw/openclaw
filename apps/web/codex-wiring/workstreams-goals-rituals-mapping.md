# Workstreams / Goals / Rituals / Jobs — Mapping Decision

## Decision Summary
**Chosen mapping:** **Option A — Overseer + Cron**
- **Workstreams** → Overseer (goal plan/work graph)
- **Goals** → Overseer goals
- **Rituals** → Cron jobs (agentTurn payload)
- **Jobs** → Cron jobs (systemEvent or agentTurn payload)

**Rationale:** Overseer is the only gateway system with a task/graph structure that can support Workstreams + Goals. Cron is the only built‑in scheduler that matches Rituals/Jobs timing semantics. Automations are schedule‑based but lack a dependency graph for workstreams and overlap with Cron for scheduling.

---

## Mapping Table (Surface → RPCs)

| Surface | List | Detail | Create | Update | Run/Execute | Delete | History |
|---|---|---|---|---|---|---|---|
| Workstreams | `overseer.status` | `overseer.goal.status` | `overseer.goal.create` | `overseer.work.update` (node status) | `overseer.tick` (optional) | — | — |
| Goals | `overseer.status` | `overseer.goal.status` | `overseer.goal.create` | `overseer.goal.pause` / `overseer.goal.resume` / `overseer.goal.update` | — | — | — |
| Rituals | `cron.list` | `cron.list` (single id) | `cron.add` | `cron.update` | `cron.run` | `cron.remove` | `cron.runs` |
| Jobs | `cron.list` | `cron.list` (single id) | `cron.add` | `cron.update` | `cron.run` | `cron.remove` | `cron.runs` |

---

## RPC Inventory by Surface (Exact Method Names)

### Workstreams
- `overseer.status`
- `overseer.goal.status`
- `overseer.goal.create`
- `overseer.work.update`
- `overseer.tick`

### Goals
- `overseer.status`
- `overseer.goal.status`
- `overseer.goal.create`
- `overseer.goal.pause`
- `overseer.goal.resume`
- `overseer.goal.update`

### Rituals
- `cron.list`
- `cron.add`
- `cron.update`
- `cron.run`
- `cron.remove`
- `cron.runs`

### Jobs
- `cron.list`
- `cron.add`
- `cron.update`
- `cron.run`
- `cron.remove`
- `cron.runs`

---

## Field Mapping (UI → Gateway)

### Workstream
| UI Field | Source | Notes / Transform |
|---|---|---|
| `id` | `overseer.goal.status.goalId` | One workstream per goal |
| `name` | `overseer.goal.status.title` | direct |
| `description` | `overseer.goal.status.problemStatement` | best available text |
| `status` | `overseer.goal.status.status` | map to UI statuses (`active/paused/completed/archived`) |
| `progress` | derived from plan node statuses | **computed** (see gaps) |
| `ownerId` | `overseer.goal.status.owner` | optional |
| `createdAt` | `overseer.goal.status.createdAt` | convert ms→ISO |
| `updatedAt` | `overseer.goal.status.updatedAt` | convert ms→ISO |
| `dueDate` | **missing** | gap |
| `tags` | `overseer.goal.status.tags` | direct |

### Task
| UI Field | Source | Notes / Transform |
|---|---|---|
| `id` | `plan node id` | from goal plan nodes |
| `workstreamId` | `goalId` | parent goal |
| `title` | `plan node name` | direct |
| `description` | `objective` or `expectedOutcome` | choose best available |
| `status` | `plan node status` | direct |
| `priority` | **missing** | gap |
| `assigneeId` | `suggestedAgentId` | optional |
| `dueDate` | **missing** | gap |
| `createdAt` | `plan node createdAt` | ms→ISO |
| `updatedAt` | `plan node updatedAt` | ms→ISO |
| `dependencies` | `plan node dependsOn` | direct |
| `tags` | **missing** | gap |

### Goal
| UI Field | Source | Notes / Transform |
|---|---|---|
| `id` | `overseer.goal.status.goalId` | direct |
| `title` | `overseer.goal.status.title` | direct |
| `description` | `problemStatement` | direct |
| `status` | `overseer.goal.status.status` | map to UI statuses |
| `progress` | derived from plan node statuses | **computed** |
| `milestones` | `successCriteria[]` | map to milestones |
| `dueDate` | **missing** | gap |
| `createdAt` | `createdAt` | ms→ISO |
| `updatedAt` | `updatedAt` | ms→ISO |
| `tags` | `tags[]` | direct |

### Ritual (Cron Job)
| UI Field | Source | Notes / Transform |
|---|---|---|
| `id` | `cron job id` | direct |
| `name` | `cron job name` | direct |
| `description` | `cron job description` | direct |
| `schedule` | `cron.schedule` | serialize to cron string when `kind=cron` |
| `frequency` | derived from schedule | hourly/daily/weekly/monthly/custom |
| `status` | `enabled` + `state.lastStatus` | map to `active/paused/completed/failed` |
| `nextRun` | `state.nextRunAtMs` | ms→ISO |
| `lastRun` | `state.lastRunAtMs` | ms→ISO |
| `agentId` | `agentId` | direct |

### Job (Cron Job)
| UI Field | Source | Notes / Transform |
|---|---|---|
| `id` | `cron job id` | direct |
| `name` | `cron job name` | direct |
| `schedule` | `cron.schedule` | serialize to cron string |
| `command` | **missing** | gap; map to payload.kind/message if defined |
| `enabled` | `enabled` | direct |
| `status` | `state.lastStatus` | map to idle/running/success/failed |
| `lastRun` | `state.lastRunAtMs` | ms→Date |
| `nextRun` | `state.nextRunAtMs` | ms→Date |
| `createdAt` | `createdAtMs` | ms→Date |

---

## Gaps / Required Backend Changes

1. **Workstream progress**: no explicit progress on Overseer goals. Must compute from plan nodes (e.g., % done) or add a derived field.
2. **Task priority / dueDate / tags**: Overseer plan nodes don’t include these. Either extend Overseer schema or accept UI omissions.
3. **Goal dueDate**: not present in Overseer; needs extension if UI requires deadlines.
4. **Ritual execution history**: `cron.runs` lacks sessionKey/tokens/cost/tool counts. Extend `cron.runs` or adjust Ritual UI.
5. **Job command**: Cron payload does not expose a `command` string; UI must map to `payload.kind` + `message` or add `command` field to cron payload.
6. **Ritual vs Job separation**: Cron jobs are a single pool. If both surfaces are kept, we need a marker/tag to separate “rituals” vs “jobs”.

---

## Impact on Ticket 10 (Implementation)

- **Workstreams UI** must read Overseer goal plans and build task DAG from plan nodes.
- **Goals UI** must derive progress from plan node statuses and map `successCriteria` → milestones.
- **Rituals/Jobs UI** must translate cron schedule objects ↔ cron strings and map payloads into UI fields.
- Any missing fields (due dates, priority, tags, command) must be either hidden in UI or added to gateway schemas.
