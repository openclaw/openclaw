---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Paperclip Orchestration: Workspaces, Tasks, Goals, Budgets, Governance"
description: "Adapt Paperclip's company orchestration model into Operator1 with workspaces, task assignment, cost budgets, and approval governance."
dartboard: "Operator1/Tasks"
type: Project
status: "In Progress"
priority: high
assignee: "rohit sharma"
tags: [feature, backend, ui, migration, paperclip]
startAt: "2026-03-17"
dueAt:
dart_project_id:
# ──────────────────────────────────────────────────────────────────────────────
---

# Paperclip Orchestration: Workspaces, Tasks, Goals, Budgets, Governance

**Created:** 2026-03-17
**Status:** Planning
**Depends on:** Onboarding GUI (complete), SQLite v17 schema, existing project/cron/usage/approval infrastructure

---

## 1. Overview

Adapt Paperclip's company-level AI orchestration model into Operator1's single-operator architecture. Paperclip manages companies, agent org charts, task/issue assignment, cost budgets, approval governance, and heartbeat scheduling across multi-tenant environments. Operator1 already has a Matrix tier hierarchy (34 agents in 3 tiers), SQLite DB (v17), cron/heartbeat, projects, session-level usage tracking, exec approvals, and a ui-next control panel. This project maps Paperclip's "company" to Operator1's "workspace" (the org-level isolation unit), makes tasks first-class with agent assignment and status tracking, adds cost budgets with enforcement, extends the approval system, and builds goal hierarchy linking strategic objectives down to individual tasks.

---

## 2. Goals

- Multi-workspace isolation so agents can be organized into logical groupings with separate task boards, budgets, and activity logs
- Persistent task system with identifier generation (e.g. "OP1-001"), status workflows, agent assignment, and comments
- Goal hierarchy (vision to key result to task) so every task traces back to a strategic objective
- Cost budgets at workspace, project, and agent level with configurable enforcement (warnings and hard stops)
- Extended approval system covering agent hire, budget overrides, and config changes
- Activity audit log for full traceability of all mutations
- All features surfaced in the ui-next control panel with dedicated pages

## 3. Out of Scope

- Multi-tenant auth isolation (Operator1 remains single-operator; workspaces are logical, not auth-separated)
- Agent API keys / per-agent authentication (gateway auth handles this)
- Real-time billing integration with external payment providers
- Migrating existing team-run tasks into the new task system (follow-up)
- Goal hierarchy auto-generation from external tools
- Mobile-specific UI (web control panel only)
- Agent adapter system (Operator1 uses Pi agent runtime, not Paperclip's pluggable adapters)

---

## 4. Design Decisions

| Decision                            | Options Considered                                   | Chosen                                       | Reason                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace isolation model           | Separate DB per workspace, single DB with FK scoping | Single DB with `workspace_id` FK             | Matches existing pattern (one `operator1.db`). Simpler queries. No multi-DB management.                                                                                                                                                                                         |
| Task system vs extending team tasks | Extend `op1_team_tasks`, new `op1_tasks` table       | New `op1_tasks` table                        | Team tasks are ephemeral and scoped to a team run. New tasks are long-lived, workspace-scoped, with identifiers, priority, comments, and goal links.                                                                                                                            |
| Cost event storage                  | Write to session JSONL, write to SQLite              | SQLite `op1_cost_events` table               | Enables cross-session, cross-agent aggregation. Session JSONL remains for detailed replay; cost events table is the rollup.                                                                                                                                                     |
| Budget enforcement point            | Gateway middleware, agent runtime hook               | Post-call recording + periodic cron sweep    | Pre-call cost estimation is not possible (costs are only known after LLM response). Post-call hook records actuals; cron sweep reconciles totals and triggers incidents at monthly boundary. Hard-stop enforcement requires a prompt-token rate table for estimation; see §5.4. |
| Goal hierarchy depth                | Flat goals, tree hierarchy                           | Tree with `parent_id` self-reference         | Mirrors Paperclip's vision-to-subtask levels. Enables OKR-style cascading.                                                                                                                                                                                                      |
| Approval system                     | Extend exec approvals, new table                     | New `op1_approvals` table                    | Exec approvals are security-focused (command allowlists). New approvals cover organizational governance. Different lifecycle.                                                                                                                                                   |
| Default workspace                   | No default, auto-create on first boot                | Auto-create "default" workspace on migration | Backward compatibility. Existing projects and sessions bind to default workspace without manual migration.                                                                                                                                                                      |

---

## 5. Technical Spec

### 5.1 SQLite Schema Additions (Migrations v18-v23)

#### v18: Workspaces

```sql
CREATE TABLE op1_workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived', 'suspended')),
  task_prefix   TEXT NOT NULL DEFAULT 'OP1',
  task_counter  INTEGER NOT NULL DEFAULT 0,
  budget_monthly_microcents INTEGER,
  spent_monthly_microcents  INTEGER NOT NULL DEFAULT 0,
  brand_color   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE op1_workspace_agents (
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  role          TEXT,
  joined_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, agent_id)
);
CREATE INDEX idx_ws_agents_agent ON op1_workspace_agents(agent_id);

-- Seed default workspace
INSERT INTO op1_workspaces (id, name, description, task_prefix)
VALUES ('default', 'Default Workspace', 'Auto-created default workspace', 'OP1');

-- Add workspace_id to existing projects table
ALTER TABLE op1_projects ADD COLUMN workspace_id TEXT REFERENCES op1_workspaces(id);
UPDATE op1_projects SET workspace_id = 'default' WHERE workspace_id IS NULL;
```

#### v19: Tasks and Task Comments

```sql
CREATE TABLE op1_tasks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  -- project_id and goal_id are intentionally bare TEXT (no FK); SQLite cannot add FK
  -- constraints retroactively, and goals table (v20) is created after tasks (v19).
  -- Referential integrity is enforced at the application layer in the store functions.
  project_id      TEXT,
  goal_id         TEXT,
  parent_id       TEXT REFERENCES op1_tasks(id) ON DELETE SET NULL,
  identifier      TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'backlog'
                  CHECK (status IN ('backlog','todo','in_progress','in_review','blocked','done','cancelled')),
  priority        TEXT NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','critical')),
  assignee_agent_id TEXT,
  billing_code    TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at    INTEGER
);
CREATE INDEX idx_tasks_workspace ON op1_tasks(workspace_id, status);
CREATE INDEX idx_tasks_assignee ON op1_tasks(assignee_agent_id);
CREATE INDEX idx_tasks_project ON op1_tasks(project_id);
CREATE INDEX idx_tasks_goal ON op1_tasks(goal_id);
CREATE UNIQUE INDEX idx_tasks_identifier ON op1_tasks(workspace_id, identifier);

CREATE TABLE op1_task_comments (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES op1_tasks(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL,
  author_type   TEXT NOT NULL DEFAULT 'agent'
                CHECK (author_type IN ('agent', 'user', 'system')),
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_task_comments_task ON op1_task_comments(task_id, created_at);
```

#### v20: Goals

```sql
CREATE TABLE op1_goals (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES op1_goals(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  -- 'task' and 'subtask' levels are intentionally excluded; op1_tasks handles
  -- that layer. Goals top out at key_result; tasks reference goals via goal_id.
  level         TEXT NOT NULL DEFAULT 'objective'
                CHECK (level IN ('vision','objective','key_result')),
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','in_progress','achieved','abandoned')),
  owner_agent_id TEXT,
  progress      INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_goals_workspace ON op1_goals(workspace_id, status);
CREATE INDEX idx_goals_parent ON op1_goals(parent_id);
CREATE INDEX idx_goals_owner ON op1_goals(owner_agent_id);
```

#### v21: Cost Events and Budget Policies

```sql
CREATE TABLE op1_cost_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  session_id    TEXT,
  task_id       TEXT,
  project_id    TEXT,
  provider      TEXT,
  model         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- cost stored as INTEGER micro-cents (cost * 1_000_000) to avoid float accumulation
  -- error across thousands of events. spent_monthly_cents on workspaces uses the same unit.
  -- Display layer divides by 1_000_000 to render dollars.
  cost_microcents INTEGER NOT NULL DEFAULT 0,
  occurred_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_cost_events_workspace ON op1_cost_events(workspace_id, occurred_at);
CREATE INDEX idx_cost_events_agent ON op1_cost_events(agent_id, occurred_at);
CREATE INDEX idx_cost_events_project ON op1_cost_events(project_id);
CREATE INDEX idx_cost_events_task ON op1_cost_events(task_id);

CREATE TABLE op1_budget_policies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('workspace','agent','project')),
  scope_id      TEXT NOT NULL,
  amount_microcents INTEGER NOT NULL,
  window_kind   TEXT NOT NULL DEFAULT 'calendar_month_utc'
                CHECK (window_kind IN ('calendar_month_utc','lifetime')),
  warn_percent  INTEGER NOT NULL DEFAULT 80,
  hard_stop     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_budget_policies_scope ON op1_budget_policies(scope_type, scope_id);

CREATE TABLE op1_budget_incidents (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  policy_id     TEXT NOT NULL REFERENCES op1_budget_policies(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('warning','hard_stop','resolved')),
  agent_id      TEXT,
  spent_microcents INTEGER NOT NULL,
  limit_microcents INTEGER NOT NULL,
  message       TEXT,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_budget_incidents_workspace ON op1_budget_incidents(workspace_id, created_at);
```

#### v22: Approvals and Activity Log

```sql
CREATE TABLE op1_approvals (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('agent_hire','budget_override','config_change')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','revision_requested','approved','rejected')),
  requester_id    TEXT NOT NULL,
  requester_type  TEXT NOT NULL DEFAULT 'agent'
                  CHECK (requester_type IN ('agent','user','system')),
  payload_json    TEXT,
  decision_note   TEXT,
  decided_by      TEXT,
  decided_at      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_approvals_workspace ON op1_approvals(workspace_id, status);

CREATE TABLE op1_activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL DEFAULT 'system'
                CHECK (actor_type IN ('user','agent','system')),
  actor_id      TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  details_json  TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_activity_log_workspace ON op1_activity_log(workspace_id, created_at);
CREATE INDEX idx_activity_log_entity ON op1_activity_log(entity_type, entity_id);
```

#### v23: Agent Config Revisions

```sql
CREATE TABLE op1_agent_config_revisions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES op1_workspaces(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  changed_by    TEXT,
  change_note   TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_agent_config_revisions ON op1_agent_config_revisions(agent_id, created_at);
```

### 5.2 RPC Method Signatures

#### Workspace RPCs

| Method                   | Scope | Params                                             | Returns                                  |
| ------------------------ | ----- | -------------------------------------------------- | ---------------------------------------- |
| `workspaces.list`        | READ  | `{}`                                               | `{ workspaces: Workspace[] }`            |
| `workspaces.get`         | READ  | `{ id }`                                           | `Workspace` with agent count, task count |
| `workspaces.create`      | ADMIN | `{ name, description?, taskPrefix?, brandColor? }` | `Workspace`                              |
| `workspaces.update`      | ADMIN | `{ id, name?, description?, brandColor? }`         | `Workspace`                              |
| `workspaces.archive`     | ADMIN | `{ id }`                                           | `Workspace`                              |
| `workspaces.agents`      | READ  | `{ workspaceId }`                                  | `{ agents: WorkspaceAgent[] }`           |
| `workspaces.assignAgent` | ADMIN | `{ workspaceId, agentId, role? }`                  | `{ ok: true }`                           |
| `workspaces.removeAgent` | ADMIN | `{ workspaceId, agentId }`                         | `{ ok: true }`                           |

#### Task RPCs

| Method                | Scope | Params                                                                                   | Returns                                 |
| --------------------- | ----- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| `tasks.list`          | READ  | `{ workspaceId, status?, assignee?, projectId?, limit?, offset? }`                       | `{ tasks: Task[], total }`              |
| `tasks.get`           | READ  | `{ id }` or `{ identifier }`                                                             | `Task`                                  |
| `tasks.create`        | WRITE | `{ workspaceId, title, description?, priority?, projectId?, goalId?, assigneeAgentId? }` | `Task` (with auto-generated identifier) |
| `tasks.update`        | WRITE | `{ id, title?, description?, priority?, projectId?, goalId? }`                           | `Task`                                  |
| `tasks.assign`        | WRITE | `{ id, agentId }` or `{ id, agentId: null }`                                             | `Task`                                  |
| `tasks.transition`    | WRITE | `{ id, status }`                                                                         | `Task` (validates allowed transition)   |
| `tasks.comments.list` | READ  | `{ taskId, limit?, offset? }`                                                            | `{ comments: TaskComment[], total }`    |
| `tasks.comments.add`  | WRITE | `{ taskId, body, authorId?, authorType? }`                                               | `TaskComment`                           |

#### Goal RPCs

| Method         | Scope | Params                                                                   | Returns                         |
| -------------- | ----- | ------------------------------------------------------------------------ | ------------------------------- |
| `goals.list`   | READ  | `{ workspaceId, level?, status? }`                                       | `{ goals: Goal[] }`             |
| `goals.get`    | READ  | `{ id }`                                                                 | `Goal` with children            |
| `goals.create` | WRITE | `{ workspaceId, title, description?, level?, parentId?, ownerAgentId? }` | `Goal`                          |
| `goals.update` | WRITE | `{ id, title?, description?, status?, progress? }`                       | `Goal`                          |
| `goals.delete` | ADMIN | `{ id }`                                                                 | `{ ok: true }`                  |
| `goals.tree`   | READ  | `{ workspaceId }`                                                        | `{ tree: GoalNode[] }` (nested) |

#### Budget RPCs

| Method                      | Scope | Params                                                                                                      | Returns                           |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `budgets.policies.list`     | READ  | `{ workspaceId }`                                                                                           | `{ policies: BudgetPolicy[] }`    |
| `budgets.policies.create`   | ADMIN | `{ workspaceId, scopeType, scopeId, amountMicrocents, windowKind?, warnPercent?, hardStop? }`               | `BudgetPolicy`                    |
| `budgets.policies.update`   | ADMIN | `{ id, amountMicrocents?, warnPercent?, hardStop? }`                                                        | `BudgetPolicy`                    |
| `budgets.policies.delete`   | ADMIN | `{ id }`                                                                                                    | `{ ok: true }`                    |
| `budgets.spend`             | READ  | `{ workspaceId, from?, to?, groupBy? }`                                                                     | Spend summary                     |
| `budgets.incidents.list`    | READ  | `{ workspaceId }`                                                                                           | `{ incidents: BudgetIncident[] }` |
| `budgets.incidents.resolve` | ADMIN | `{ id, resolution }`                                                                                        | `BudgetIncident`                  |
| `cost.record`               | WRITE | `{ workspaceId, agentId, sessionId?, taskId?, provider, model, inputTokens, outputTokens, costMicrocents }` | `CostEvent`                       |

#### Approval RPCs

| Method              | Scope | Params                                            | Returns                     |
| ------------------- | ----- | ------------------------------------------------- | --------------------------- |
| `approvals.list`    | READ  | `{ workspaceId, type?, status? }`                 | `{ approvals: Approval[] }` |
| `approvals.get`     | READ  | `{ id }`                                          | `Approval`                  |
| `approvals.request` | WRITE | `{ workspaceId, type, payload, requesterId? }`    | `Approval`                  |
| `approvals.decide`  | ADMIN | `{ id, decision: "approved"\|"rejected", note? }` | `Approval`                  |
| `approvals.revise`  | ADMIN | `{ id, note? }`                                   | `Approval`                  |

#### Activity RPCs

| Method          | Scope | Params                                                                 | Returns                                  |
| --------------- | ----- | ---------------------------------------------------------------------- | ---------------------------------------- |
| `activity.list` | READ  | `{ workspaceId, entityType?, entityId?, actorType?, limit?, offset? }` | `{ entries: ActivityLogEntry[], total }` |

### 5.3 Task Identifier Generation

Each workspace has a `task_prefix` (e.g., "OP1") and a monotonically increasing `task_counter`. When a task is created:

1. Run inside an explicit write transaction to prevent races across concurrent gateway connections.
2. Atomically increment counter: `UPDATE op1_workspaces SET task_counter = task_counter + 1, updated_at = unixepoch() WHERE id = ? RETURNING task_counter`
3. Format identifier: `${task_prefix}-${String(counter).padStart(3, '0')}` (e.g., "OP1-001")
4. Store in `op1_tasks.identifier`

`DatabaseSync` (node:sqlite) is synchronous but the transaction wrapper is still required to keep the counter increment and task insert atomic within a single gateway request.

### 5.4 Budget Enforcement Architecture

**Known limitation: pre-call cost is not knowable.** Costs are only available in LLM responses (token counts × rate). There is no mechanism to estimate cost before a call completes. The enforcement model is therefore:

1. **Post-call recording (real-time):** The actual hook point is the Pi agent runtime where LLM responses arrive with usage data — specifically `src/agents/usage.ts` (`normalizeUsage`) which is called after each turn. After normalization, look up the session's `project_id`, resolve its `workspace_id` via `op1_projects`, then call `cost.record`. This workspace attribution chain (`session → project_id → workspace_id`) must be resolved at call time since `session_entries` has no direct `workspace_id` column. This is a deliberate tradeoff: workspace is project-scoped, not session-scoped.

2. **Hard-stop estimation (optional, phase 2):** To support pre-call hard stops, a model rate table (`src/orchestration/model-rate-table.ts`) can estimate cost from prompt token count × rate. This requires: (a) a maintained rate table per provider/model, (b) a pre-call token count estimate. If this complexity is not warranted, hard stops should be removed from the schema and replaced with post-call incident + agent pause.

3. **Periodic reconciliation (cron):** Hourly job reconciles `op1_cost_events` totals against `op1_budget_policies`. Updates `spent_monthly_microcents` on workspace. At month boundary, resets monthly spend counters and resolves expired incidents.

4. **Audit vs activity log boundary:** `audit_state` (schema v9) covers security-sensitive table mutations via SQLite triggers. `op1_activity_log` covers organizational events (task created, goal updated, approval resolved). Do not double-log: activity log records are written explicitly by RPC handlers, not by triggers, and must not duplicate what `audit_state` already captures.

### 5.5 Task Status Transitions

```
backlog → todo, cancelled
todo → in_progress, cancelled
in_progress → in_review, blocked, done, cancelled
in_review → in_progress, done
blocked → in_progress, cancelled
done → (terminal)
cancelled → (terminal)
```

### 5.6 File Structure

```
src/orchestration/
  types.ts                          # All domain type definitions
  workspace-store-sqlite.ts         # Workspace CRUD
  task-store-sqlite.ts              # Task + comment CRUD
  goal-store-sqlite.ts              # Goal CRUD + tree traversal
  cost-event-store-sqlite.ts        # Cost event recording + aggregation
  budget-store-sqlite.ts            # Budget policy CRUD + enforcement
  approval-store-sqlite.ts          # Approval CRUD + status transitions
  activity-log-sqlite.ts            # Activity log append + query
  agent-config-revision-sqlite.ts   # Config revision tracking

src/gateway/server-methods/
  workspaces.ts                     # Workspace RPC handlers
  tasks.ts                          # Task RPC handlers
  goals.ts                          # Goal RPC handlers
  budgets.ts                        # Budget + cost RPC handlers
  approvals-org.ts                  # Org approval handlers (distinct from exec-approvals.ts)
  activity.ts                       # Activity log RPC handlers

src/gateway/protocol/schema/
  workspaces.ts                     # TypeBox schemas
  tasks.ts
  goals.ts
  budgets.ts
  approvals-org.ts
  activity.ts

ui-next/src/pages/
  workspaces.tsx                    # Workspace management (settings only — low priority)
  tasks.tsx                         # Task board — lower priority; primary surface is org view
  task-detail.tsx                   # Task detail — lower priority
  goals.tsx                         # Goals — lower priority
  budgets.tsx                       # Cost dashboard — lower priority
  approvals-org.tsx                 # Approval inbox — lower priority
  activity.tsx                      # Activity feed — lower priority

ui-next/src/components/agents/
  agent-flow-node.tsx               # Extend AgentNodeData with workspace/task/budget fields
  org-workspace-bar.tsx             # NEW: workspace stats bar above the canvas
  org-agent-panel.tsx               # NEW: slide-out side panel (tasks, goals, cost, activity)
  org-workspace-selector.tsx        # NEW: workspace dropdown (parallel to bundle selector)
```

> **UI Architecture Decision (updated):** The primary UI surface for all orchestration
> features is the **existing Agent Organization page** (`/agents/organization`), augmented
> in-place. Separate dedicated pages (`/tasks`, `/goals`, `/budgets`, etc.) are lower
> priority and built only after the org view augmentation is complete. This approach keeps
> the workflow in one place — you see your agents, their workspace, task load, health, and
> budget all in a single canvas view.

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` checkbox = one Dart Subtask (child of its Task)
> - `**Status:**` on line 1 of each task syncs with Dart status field
> - Task titles and subtask text must match Dart exactly (used for sync matching)
> - `dart_project_id` in frontmatter is filled after first sync
> - **Dates:** `dueAt` and per-task `**Due:**` dates must be confirmed with the user before syncing to Dart — never auto-generate from estimates
> - **Estimates:** use hours (`**Est:** Xh`), not days — AI-assisted implementation is much faster than manual dev
> - **Subtasks:** every `- [ ]` item must include a brief inline description after `—` so it is self-contained when read in Dart without the MD file

### Task 1: Phase 1 — Workspace Foundation

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 8h

Build the workspace isolation layer. Adds `op1_workspaces` and `op1_workspace_agents` tables, CRUD store, RPC handlers, protocol schemas, and UI workspace selector. Seeds a "default" workspace on migration. Adds optional `workspace_id` FK to `op1_projects`. See SS5.1 (v18 migration).

- [x] 1.1 Schema migration v18 — add `op1_workspaces` and `op1_workspace_agents` tables with default workspace seed, plus `workspace_id` column on `op1_projects`
- [x] 1.2 Workspace store — create `src/orchestration/workspace-store-sqlite.ts` with CRUD functions following `project-store-sqlite.ts` pattern
- [x] 1.3 Workspace types — create `src/orchestration/types.ts` with Workspace and agent assignment types
- [x] 1.4 Protocol schemas — create `src/gateway/protocol/schema/workspaces.ts` with TypeBox params following `teams.ts` pattern
- [x] 1.5 RPC handlers — create `src/gateway/server-methods/workspaces.ts` with 8 workspace handlers
- [x] 1.6 Registration — add to `server-methods.ts`, `server-methods-list.ts`, `method-scopes.ts`
- [x] 1.7 Protocol exports — add validators to `src/gateway/protocol/index.ts`
- [ ] 1.8 UI workspace page — `/workspaces` settings page for CRUD (create/rename/archive/brand-color); workspace switching is handled by the org view selector (6.7), not a sidebar switcher
- [ ] 1.9 Tests — store + handler unit tests with in-memory DB

### Task 2: Phase 2 — Task System

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 12h

Build the persistent task system with identifier generation, status workflow, agent assignment, and comments. See SS5.1 (v19), SS5.3 (identifier gen), SS5.5 (status transitions).

- [x] 2.1 Schema migration v19 — add `op1_tasks` and `op1_task_comments` tables
- [x] 2.2 Task store — create `src/orchestration/task-store-sqlite.ts` with CRUD, atomic identifier generation, status transition validation, comment append
- [x] 2.3 Task types — add Task, TaskStatus, TaskPriority, TaskComment to types.ts
- [x] 2.4 Status transition validation — implement allowed transitions map per SS5.5
- [x] 2.5 Protocol schemas — create `src/gateway/protocol/schema/tasks.ts`
- [x] 2.6 RPC handlers — create `src/gateway/server-methods/tasks.ts` with 8 task handlers
- [x] 2.7 Registration — add to server-methods.ts, server-methods-list.ts, method-scopes.ts
- [ ] 2.8 UI task board — `/tasks` page (secondary; primary task surface is org view agent side panel 6.10); kanban columns, list view, create dialog, filters
- [ ] 2.9 UI task detail — `/tasks/:id` with status transitions, assignee picker, comment thread (secondary)
- [ ] 2.10 Tests — store tests (identifier gen, transitions, comments) + handler tests

### Task 3: Phase 3 — Goal Hierarchy

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** | **Est:** 8h

Build goal hierarchy: vision to objective to key_result to task. Tasks reference goals for traceability. See SS5.1 (v20).

- [x] 3.1 Schema migration v20 — add `op1_goals` table with self-referential parent_id
- [x] 3.2 Goal store — create `src/orchestration/goal-store-sqlite.ts` with CRUD and tree traversal
- [x] 3.3 Goal types — add Goal, GoalLevel, GoalStatus to types.ts
- [x] 3.4 Protocol schemas — create `src/gateway/protocol/schema/goals.ts`
- [x] 3.5 RPC handlers — create `src/gateway/server-methods/goals.ts` with 6 goal handlers
- [x] 3.6 Registration — add to server-methods.ts, server-methods-list.ts, method-scopes.ts
- [x] 3.7 Task-goal linking — extend task create/update to accept goalId, show goal ancestry on task detail
- [ ] 3.8 UI goals page — `/goals` with indented tree view, create dialog, progress bars
- [ ] 3.9 Tests — store tests (tree operations, progress) + handler tests

### Task 4: Phase 4 — Cost Budgets and Enforcement

**Status:** In Progress | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 14h

Cost event recording, budget policies, enforcement, and incident tracking. Hooks into existing usage pipeline. See SS5.1 (v21), SS5.4 (enforcement architecture).

- [x] 4.1 Schema migration v21 — add `op1_cost_events`, `op1_budget_policies`, `op1_budget_incidents`
- [x] 4.2 Cost event store — create `src/orchestration/cost-event-store-sqlite.ts` with insert + aggregation queries
- [x] 4.3 Budget store — create `src/orchestration/budget-store-sqlite.ts` with policy CRUD + incident tracking
- [x] 4.4 Cost recording hook — hook into `src/agents/usage.ts` (`normalizeUsage` call site in Pi agent runtime) post-LLM-response; resolve workspace_id via session → project_id → op1_projects join, then insert cost event
- [x] 4.5 Workspace attribution helper — `resolveWorkspaceForSession(sessionId, db)` returning workspaceId via project*id FK; used by cost recording hook and budget enforcement *(deviation: implemented as `resolveAgentWorkspace(agentId)` via `op1_workspace_agents` lookup — agent-scoped rather than session→project→workspace chain; simpler and avoids the indirect FK join)\_
- [x] 4.6 Budget reconciliation cron — hourly cron to reconcile totals, reset monthly counters, create incidents
- [x] 4.7 Protocol schemas — create `src/gateway/protocol/schema/budgets.ts`
- [x] 4.8 RPC handlers — create `src/gateway/server-methods/budgets.ts` with 8 budget/cost handlers
- [x] 4.9 Registration — add to server-methods.ts, server-methods-list.ts, method-scopes.ts
- [ ] 4.10 Gateway events — emit `budget.warning` and `budget.exceeded` for real-time UI notifications
- [ ] 4.11 UI cost dashboard — `/budgets` with spend charts, policy CRUD, incident list, alert badges
- [ ] 4.12 Tests — cost recording, budget enforcement (warn/block), reconciliation, handler tests

### Task 5: Phase 5 — Governance and Approvals

**Status:** In Progress | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** | **Est:** 10h

Organizational approval workflow + activity audit log + agent config revision tracking. See SS5.1 (v22-v23).

- [x] 5.1 Schema migration v22 — add `op1_approvals` and `op1_activity_log` tables
- [x] 5.2 Schema migration v23 — add `op1_agent_config_revisions` table
- [x] 5.3 Approval store — create `src/orchestration/approval-store-sqlite.ts` with CRUD + status transitions
- [x] 5.4 Activity log store — create `src/orchestration/activity-log-sqlite.ts` with append + paginated query
- [x] 5.5 Config revision store — create `src/orchestration/agent-config-revision-sqlite.ts`
- [x] 5.6 Activity log integration — add recording calls to all mutation handlers via shared helper
- [x] 5.7 Protocol schemas — create `src/gateway/protocol/schema/approvals-org.ts` and `activity.ts`
- [x] 5.8 RPC handlers — create `src/gateway/server-methods/approvals-org.ts` and `activity.ts`
- [x] 5.9 Registration — add to server-methods.ts, server-methods-list.ts, method-scopes.ts
- [x] 5.10 Gateway events — emit `approval.requested` and `approval.resolved` for real-time notification
- [ ] 5.11 UI approval inbox — `/approvals` with pending list, approve/reject/revise buttons
- [ ] 5.12 UI activity feed — `/activity` with filterable, paginated timeline
- [ ] 5.13 Tests — approval transitions, activity log, config revisions, handler tests

### Task 6: Phase 6 — Agent Lifecycle and Integration

**Status:** In Progress | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** | **Est:** 14h

Workspace-aware agent status, performance metrics, department budget aggregation, and workspace context injection into agent sessions. Note: 6.5 (context injection) touches the Pi agent runtime's prompt construction pipeline and is a significant integration — treat it as a separate investigation before implementation.

- [x] 6.1 Agent status tracking — extend `op1_workspace_agents` with status and capabilities columns
- [x] 6.2 Session-workspace binding — document and enforce the `session → project_id → workspace_id` attribution chain; extend `sessions.list` to surface resolved workspaceId; note this is an indirect FK (no workspace_id column on session_entries) and must join through op1_projects
- [x] 6.3 Agent performance metrics — query cost events + tasks for per-agent metrics (completed, cost, tokens, response time)
- [x] 6.4 Department budget aggregation — aggregate cost events by department using Matrix tier map (`ui-next/src/lib/matrix-tier-map.ts`)
- [x] 6.5 Workspace context injection (investigation) — identify exact prompt construction call site in Pi agent runtime; determine injection point, payload shape (goals summary, active tasks, budget status), and size budget; produce a design note before implementation
- [x] 6.6 Workspace context injection (implementation) — implement context injection per design note from 6.5; validate prompt size stays within model context limits (`src/orchestration/workspace-context.ts`, injected in `attempt.ts` gated on `promptMode !== "minimal"`, hard cap 800 chars)
- [ ] 6.7 UI org chart — workspace selector dropdown (parallel to Bundle selector; fetches `workspaces.list`, filters canvas by workspace membership via `workspaces.agents`)
- [ ] 6.8 UI org chart — agent node augmentation: extend `AgentNodeData` with `agentStatus`, `taskCount`, `budgetPctUsed`, `workspaceName`; render status ring (active=green/inactive=grey/paused=amber), open task count badge, budget micro-bar on each node card; fetch `agents.metrics.list` + `workspaces.agents` in parallel with existing agents/health calls
- [ ] 6.9 UI org chart — workspace stats bar: compact strip above the canvas showing selected workspace name, tasks in-progress, active goals, monthly spend %, pending approvals count (badge); fetches `workspaces.get` + `approvals.list{status:pending}` + `goals.list{status:in_progress}`
- [ ] 6.10 UI org chart — agent side panel: slide-out panel when clicking a node (replaces preview-only dialog); shows assigned tasks list (`tasks.list{assigneeAgentId}`), owned goals, monthly cost from `agents.metrics.get`, recent activity from `activityLogs.list`; inline task status transitions
- [ ] 6.11 UI org chart — department legend augmentation: add budget % bar per department in the legend using `budgets.department.summary`; color-coded to warn/exceeded thresholds
- [ ] 6.12 UI org chart — workspace assignment actions: add assign/remove workspace buttons to node hover action bar (calling `workspaces.assignAgent` / `workspaces.removeAgent`); show agent status toggle (active/inactive/paused) via `workspaces.updateAgentStatus`
- [ ] 6.13 UI secondary pages — task board (`/tasks`), goals tree (`/goals`), approvals inbox (`/approvals`), activity feed (`/activity`): implement after 6.7–6.12; use DataTable + Dialog patterns from projects.tsx
- [ ] 6.14 Tests — session binding, workspace attribution, metrics computation, department aggregation tests

> **Data flows for org view augmentation:**
>
> - `workspaces.list` → workspace selector options
> - `workspaces.agents { workspaceId }` → agent status (active/inactive/paused) per agent in selected workspace
> - `agents.metrics.list { workspaceId }` → taskCount + monthlyCostMicrocents per agent (fetched once, keyed by agentId)
> - `budgets.department.summary { workspaceId }` → departmentBudgetPct per department for legend bars
> - `approvals.list { status: "pending" }` → count for stats bar badge
> - `goals.list { workspaceId, status: "in_progress" }` → active goal count for stats bar
> - `tasks.list { assigneeAgentId }` → task list for agent side panel (fetched on panel open)
> - `activityLogs.list { actorId, limit: 10 }` → recent activity for agent side panel
>
> **Key constraint:** All new RPCs added to the existing `fetchAndLayout` callback in
> `organization.tsx` using `Promise.all` — same loading cycle, no extra round-trips.
> `AgentNodeData` extended (not replaced) so existing node rendering is unchanged.

---

## 7. References

- Paperclip source: `https://github.com/paperclipai/paperclip` (MIT licensed, cherry-pick `-x` attribution)
- Related spec: `Project-tasks/onboarding-gui-implementation.md` (completed — onboarding wizard)
- Key source files:
  - `src/infra/state-db/schema.ts` — migration system (v17), new migrations v18-v23
  - `src/infra/state-db/connection.ts` — singleton DB connection
  - `src/projects/project-store-sqlite.ts` — reference SQLite store pattern
  - `src/teams/team-store-sqlite.ts` — reference team CRUD pattern
  - `src/gateway/server-methods/projects.ts` — reference RPC handler pattern
  - `src/gateway/server-methods/teams.ts` — reference team handler pattern
  - `src/gateway/protocol/schema/teams.ts` — reference TypeBox schema pattern
  - `src/gateway/server-methods.ts` — handler registration
  - `src/gateway/server-methods-list.ts` — method name list
  - `src/gateway/method-scopes.ts` — scope classification
  - `src/gateway/protocol/index.ts` — protocol export barrel
  - `src/gateway/server-methods/usage.ts` — existing usage tracking (JSONL scan-based, read-only)
  - `src/infra/provider-usage.ts` — barrel re-export only; not a hook point
  - `src/agents/usage.ts` — actual per-call usage normalization; cost recording hook goes here
  - `src/infra/session-cost-usage.ts` — post-hoc JSONL session cost scanning (reference for data shape)
  - `src/infra/state-db/schema.ts` v9 — existing `audit_state` table (triggers on security tables; do not duplicate in activity log)
  - `ui-next/src/lib/matrix-tier-map.ts` — Matrix tier hierarchy
  - `ui-next/src/app.tsx` — route registration
  - `ui-next/src/pages/projects.tsx` — reference UI page pattern
- Dart project: _(filled after first sync)_

---

_Template version: 1.0 — do not remove the frontmatter or alter heading levels_
