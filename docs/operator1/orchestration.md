---
summary: "Complete guide to the Orchestration system - workspaces, projects, tasks, goals, and more."
updated: "2026-03-23"
title: "Orchestration"
tags: ["orchestration", "workspaces", "tasks", "goals", "projects", "infographics"]
---

# Orchestration

## Overview

The Orchestration system is Operator1's task and resource management layer. It provides hierarchical organization through workspaces, projects, tasks, and goals — enabling agents to track work, manage budgets, and maintain audit trails across the entire organization.

## Organization

The Orchestration layer maps to the [Agent Hierarchy](/operator1/agent-hierarchy):

```
Workspace (Organization)
    |
    +-- Projects (Code repositories / products)
    |       |
    |       +-- Tasks (Work items)
    |
    +-- Goals (OKR hierarchy)
            |
            +-- vision → objective → key_result
```

Each workspace is owned by the CEO (human operator) and delegated through Operator1 to department heads (Neo, Morpheus, Trinity). Tasks and goals inherit workspace context, enabling scoped tracking and reporting.

### Data Model

![Orchestration Data Model](/images/orchestration-data-model.png)

_The Orchestration data model showing workspaces, projects, tasks, and goals hierarchy._

## Workspaces

**Table:** `op1_workspaces`

The top-level container for all orchestration entities. Every project, task, and goal belongs to a workspace.

### Schema

| Field                       | Type    | Description                               |
| --------------------------- | ------- | ----------------------------------------- |
| `id`                        | TEXT PK | Unique identifier (e.g., `default`)       |
| `name`                      | TEXT    | Display name                              |
| `description`               | TEXT    | Optional description                      |
| `status`                    | TEXT    | `active` \| `archived` \| `suspended`     |
| `task_prefix`               | TEXT    | Prefix for task identifiers (e.g., `OP1`) |
| `task_counter`              | INTEGER | Auto-incrementing counter for task IDs    |
| `budget_monthly_microcents` | INTEGER | Monthly budget cap (microcents, nullable) |
| `spent_monthly_microcents`  | INTEGER | Current month spend (microcents)          |
| `brand_color`               | TEXT    | Optional hex color for UI                 |
| `created_at`                | INTEGER | Unix timestamp                            |
| `updated_at`                | INTEGER | Unix timestamp                            |

### Task Identifiers

Tasks are auto-numbered per workspace using `task_prefix` + `task_counter`:

```
OP1-001, OP1-002, OP1-003...  (workspace with prefix "OP1")
ENG-001, ENG-002...           (engineering workspace)
```

### RPC Methods

| Method               | Scope | Description                       |
| -------------------- | ----- | --------------------------------- |
| `workspaces.list`    | READ  | List all workspaces               |
| `workspaces.get`     | READ  | Get workspace by id               |
| `workspaces.create`  | WRITE | Create a new workspace            |
| `workspaces.update`  | WRITE | Update workspace metadata         |
| `workspaces.archive` | WRITE | Archive a workspace (soft delete) |

## Projects

**Table:** `op1_projects`

Code project management. Projects represent repositories, products, or logical groupings of work. Each project can bind to sessions for context injection.

### Schema

| Field               | Type    | Description                                     |
| ------------------- | ------- | ----------------------------------------------- |
| `id`                | TEXT PK | Unique identifier (e.g., `operator1`)           |
| `name`              | TEXT    | Display name                                    |
| `path`              | TEXT    | Local filesystem path (e.g., `~/dev/operator1`) |
| `type`              | TEXT    | Project type (optional)                         |
| `tech`              | TEXT    | Technology stack (e.g., `TypeScript, Bun`)      |
| `status`            | TEXT    | Project status (default: `active`)              |
| `is_default`        | INTEGER | Default project for workspace (0 or 1)          |
| `keywords_json`     | TEXT    | JSON array of keywords for classification       |
| `telegram_group`    | TEXT    | Linked Telegram group (optional)                |
| `telegram_topic_id` | INTEGER | Linked Telegram topic (optional)                |
| `workspace_id`      | TEXT FK | Parent workspace                                |
| `created_at`        | INTEGER | Unix timestamp                                  |
| `updated_at`        | INTEGER | Unix timestamp                                  |

### Session Binding

Projects can bind to agent sessions for context injection:

```json
// RPC: projects.bindSession
{ "id": "operator1", "sessionKey": "agent:neo:main" }
```

Bound sessions receive project context (AGENTS.md, USER.md, etc.) in their system prompt.

### RPC Methods

| Method                   | Scope | Description                    |
| ------------------------ | ----- | ------------------------------ |
| `projects.list`          | READ  | List all projects              |
| `projects.get`           | READ  | Get project by id              |
| `projects.getContext`    | READ  | Get project context for agents |
| `projects.add`           | ADMIN | Create a new project           |
| `projects.update`        | ADMIN | Update project metadata        |
| `projects.archive`       | ADMIN | Archive a project              |
| `projects.bindSession`   | ADMIN | Bind session to project        |
| `projects.unbindSession` | ADMIN | Unbind session from project    |

## Tasks

**Table:** `op1_tasks`

Work item tracking. Tasks support hierarchical subtasks via `parent_id` and can be assigned to agents or humans.

### Schema

| Field               | Type    | Description                                                                               |
| ------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `id`                | TEXT PK | UUID                                                                                      |
| `workspace_id`      | TEXT FK | Parent workspace (required)                                                               |
| `project_id`        | TEXT FK | Associated project (optional)                                                             |
| `goal_id`           | TEXT FK | Associated goal (optional)                                                                |
| `parent_id`         | TEXT FK | Parent task for subtasks (self-referential)                                               |
| `identifier`        | TEXT    | Human-readable ID (e.g., `OP1-001`)                                                       |
| `title`             | TEXT    | Short title                                                                               |
| `description`       | TEXT    | Full description (markdown)                                                               |
| `status`            | TEXT    | `backlog` \| `todo` \| `in_progress` \| `in_review` \| `blocked` \| `done` \| `cancelled` |
| `priority`          | TEXT    | `low` \| `medium` \| `high` \| `critical`                                                 |
| `assignee_agent_id` | TEXT    | Assigned agent (optional)                                                                 |
| `billing_code`      | TEXT    | Billing/cost center code                                                                  |
| `created_at`        | INTEGER | Unix timestamp                                                                            |
| `updated_at`        | INTEGER | Unix timestamp                                                                            |
| `completed_at`      | INTEGER | Unix timestamp (nullable)                                                                 |

### Indexes

- `idx_tasks_workspace` — `(workspace_id, status)`
- `idx_tasks_assignee` — `(assignee_agent_id)`
- `idx_tasks_project` — `(project_id)`
- `idx_tasks_goal` — `(goal_id)`
- `idx_tasks_identifier` — `UNIQUE (workspace_id, identifier)`

### Subtasks

Tasks can be nested via `parent_id`:

```
OP1-001 (parent)
  ├── OP1-002 (subtask)
  └── OP1-003 (subtask)
```

### RPC Methods

| Method         | Scope | Description                         |
| -------------- | ----- | ----------------------------------- |
| `tasks.list`   | READ  | List tasks (filterable)             |
| `tasks.get`    | READ  | Get task by id                      |
| `tasks.create` | WRITE | Create a new task                   |
| `tasks.update` | WRITE | Update task (status, assignee, etc) |
| `tasks.delete` | WRITE | Delete a task                       |

### Task Status Lifecycle

![Task Status Lifecycle](/images/task-status-lifecycle.png)

_Task status flow: backlog → todo → in_progress → in_review → done (with blocked and cancelled branches)._

## Goals

**Table:** `op1_goals`

OKR-style goal hierarchy. Goals form a tree: vision → objective → key_result.

### Schema

| Field            | Type    | Description                                             |
| ---------------- | ------- | ------------------------------------------------------- |
| `id`             | TEXT PK | UUID                                                    |
| `workspace_id`   | TEXT FK | Parent workspace (required)                             |
| `parent_id`      | TEXT FK | Parent goal (self-referential)                          |
| `title`          | TEXT    | Goal title                                              |
| `description`    | TEXT    | Full description                                        |
| `level`          | TEXT    | `vision` \| `objective` \| `key_result`                 |
| `status`         | TEXT    | `planned` \| `in_progress` \| `achieved` \| `abandoned` |
| `owner_agent_id` | TEXT    | Responsible agent                                       |
| `progress`       | INTEGER | Progress percentage (0-100)                             |
| `created_at`     | INTEGER | Unix timestamp                                          |
| `updated_at`     | INTEGER | Unix timestamp                                          |

### Hierarchy Levels

```
vision (top-level)
  └── objective (department/quarterly)
        └── key_result (measurable outcome)
```

Example:

```
Vision: "Become the leading AI agent framework"
  └── Objective: "Launch v2.0 with enterprise features"
        ├── KR: "Achieve 99.9% gateway uptime"
        ├── KR: "Onboard 10 enterprise pilot customers"
        └── KR: "Complete SOC2 compliance"
```

### Indexes

- `idx_goals_workspace` — `(workspace_id, status)`
- `idx_goals_parent` — `(parent_id)`
- `idx_goals_owner` — `(owner_agent_id)`

### RPC Methods

| Method         | Scope | Description                    |
| -------------- | ----- | ------------------------------ |
| `goals.list`   | READ  | List goals (filterable)        |
| `goals.get`    | READ  | Get goal by id                 |
| `goals.create` | WRITE | Create a new goal              |
| `goals.update` | WRITE | Update goal (status, progress) |
| `goals.delete` | WRITE | Delete a goal                  |

## Approvals

**Table:** `security_exec_approvals`

Exec approval flow for elevated shell commands. When agents request elevated commands, they enter a pending approval state until a human resolves them.

### Schema

| Field                | Type    | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| `approval_id`        | TEXT PK | Unique approval request ID                  |
| `agent_id`           | TEXT    | Requesting agent                            |
| `kind`               | TEXT    | `allowlist` \| `denylist` \| `elevated`     |
| `pattern`            | TEXT    | Command pattern (glob)                      |
| `scope`              | TEXT    | Scope of approval                           |
| `session_key`        | TEXT    | Agent session that requested                |
| `approved_by`        | TEXT    | User who approved (nullable until resolved) |
| `last_used_at`       | INTEGER | Last usage timestamp                        |
| `last_used_command`  | TEXT    | Last command executed under this approval   |
| `last_resolved_path` | TEXT    | Path resolution for script approvals        |
| `created_at`         | INTEGER | Request timestamp                           |
| `expires_at`         | INTEGER | Expiration timestamp (nullable)             |

### Approval Flow

![Approval Flow](/images/approval-flow.png)

_The exec approval workflow: request → pending → operator decision → granted/denied._

```
1. Agent requests elevated command
   ↓
2. exec.approval.request() → { requestId, status: "pending" }
   ↓
3. Human receives exec.approval.requested event
   ↓
4. Human calls exec.approval.resolve({ requestId, approved: true/false })
   ↓
5. Agent's exec.approval.waitDecision() returns result
   ↓
6. Command executes or is denied
```

### Audit Trail

The `security_exec_approvals` table has automatic audit triggers:

- `audit_exec_approvals_insert` — logs new approvals
- `audit_exec_approvals_update` — logs changes
- `audit_exec_approvals_delete` — log deletions

All changes are recorded in `audit_state` table.

### RPC Methods

| Method                       | Scope     | Description                    |
| ---------------------------- | --------- | ------------------------------ |
| `exec.approvals.get`         | ADMIN     | Get approval policy            |
| `exec.approvals.set`         | ADMIN     | Set approval policy            |
| `exec.approvals.node.get`    | ADMIN     | Get per-node policy            |
| `exec.approvals.node.set`    | ADMIN     | Set per-node policy            |
| `exec.approval.request`      | APPROVALS | Request approval               |
| `exec.approval.waitDecision` | APPROVALS | Wait for approval decision     |
| `exec.approval.resolve`      | APPROVALS | Resolve (approve/deny) request |

## Activity

**Table:** `op1_activity_log`

Audit log for all orchestration mutations. Records who did what to which entity.

### Schema

| Field          | Type       | Description                                  |
| -------------- | ---------- | -------------------------------------------- |
| `id`           | INTEGER PK | Auto-increment ID                            |
| `workspace_id` | TEXT FK    | Workspace context                            |
| `actor_type`   | TEXT       | `user` \| `agent` \| `system`                |
| `actor_id`     | TEXT       | User ID or agent ID                          |
| `action`       | TEXT       | Action type (e.g., `created`, `updated`)     |
| `entity_type`  | TEXT       | `task` \| `goal` \| `project` \| `workspace` |
| `entity_id`    | TEXT       | Entity UUID                                  |
| `details_json` | TEXT       | JSON payload with action details             |
| `created_at`   | INTEGER    | Unix timestamp                               |

### Indexes

- `idx_activity_log_workspace` — `(workspace_id, created_at)`
- `idx_activity_log_entity` — `(entity_type, entity_id)`

### Example Entries

```json
// Task created
{ "actor_type": "system", "action": "created", "entity_type": "task",
  "entity_id": "c5213aba-...", "details_json": "{\"title\":\"...\",\"identifier\":\"OP1-001\"}" }

// Goal progress updated
{ "actor_type": "agent", "actor_id": "neo", "action": "updated",
  "entity_type": "goal", "details_json": "{\"progress\":75}" }
```

### Query Patterns

```sql
-- Recent activity for a workspace
SELECT * FROM op1_activity_log
WHERE workspace_id = 'default'
ORDER BY created_at DESC LIMIT 50;

-- Activity for a specific task
SELECT * FROM op1_activity_log
WHERE entity_type = 'task' AND entity_id = 'c5213aba-...';
```

## Budgets

Workspace budget tracking using microcents (1 USD = 100,000 microcents).

### Fields

| Field                       | Location         | Description         |
| --------------------------- | ---------------- | ------------------- |
| `budget_monthly_microcents` | `op1_workspaces` | Monthly budget cap  |
| `spent_monthly_microcents`  | `op1_workspaces` | Current month spend |

### Microcent Conversion

```
1 cent    = 1,000 microcents
$1 USD   = 100,000 microcents
$10 USD  = 1,000,000 microcents
```

Example:

```sql
-- Set $50/month budget
UPDATE op1_workspaces
SET budget_monthly_microcents = 5000000
WHERE id = 'default';
```

### Budget Enforcement

Budget checks are advisory by default. To enforce:

1. Check `spent_monthly_microcents` before operations
2. Compare against `budget_monthly_microcents`
3. Block or warn if exceeded

### RPC Methods

| Method              | Scope | Description                     |
| ------------------- | ----- | ------------------------------- |
| `workspaces.budget` | READ  | Get budget status for workspace |
| `usage.cost`        | READ  | Cost breakdown by model         |

## Architecture Diagram

> **Placeholder for NotebookLM infographic**
>
> The architecture diagram should illustrate:
>
> 1. **Workspace as root container** — holding projects, tasks, goals
> 2. **Task hierarchy** — parent/subtask relationships via `parent_id`
> 3. **Goal hierarchy** — vision → objective → key_result levels
> 4. **Cross-references** — tasks linked to projects and goals
> 5. **Activity stream** — all mutations flow to `op1_activity_log`
> 6. **Approval flow** — elevated commands route through `security_exec_approvals`
> 7. **Budget tracking** — spend accumulates against `budget_monthly_microcents`
>
> Visual style: Match existing Operator1 architecture diagrams (clean, minimal, dark theme).

## RPC Reference

Quick reference for orchestration RPC methods. See [RPC Reference](/operator1/rpc) for full details.

### Workspaces

| Method               | Scope | Description               |
| -------------------- | ----- | ------------------------- |
| `workspaces.list`    | READ  | List all workspaces       |
| `workspaces.get`     | READ  | Get workspace by id       |
| `workspaces.create`  | WRITE | Create a new workspace    |
| `workspaces.update`  | WRITE | Update workspace metadata |
| `workspaces.archive` | WRITE | Archive a workspace       |

### Projects

| Method                   | Scope | Description                    |
| ------------------------ | ----- | ------------------------------ |
| `projects.list`          | READ  | List all projects              |
| `projects.get`           | READ  | Get project by id              |
| `projects.getContext`    | READ  | Get project context for agents |
| `projects.add`           | ADMIN | Create a new project           |
| `projects.update`        | ADMIN | Update project metadata        |
| `projects.archive`       | ADMIN | Archive a project              |
| `projects.bindSession`   | ADMIN | Bind session to project        |
| `projects.unbindSession` | ADMIN | Unbind session from project    |

### Tasks

| Method         | Scope | Description             |
| -------------- | ----- | ----------------------- |
| `tasks.list`   | READ  | List tasks (filterable) |
| `tasks.get`    | READ  | Get task by id          |
| `tasks.create` | WRITE | Create a new task       |
| `tasks.update` | WRITE | Update task             |
| `tasks.delete` | WRITE | Delete a task           |

### Goals

| Method         | Scope | Description             |
| -------------- | ----- | ----------------------- |
| `goals.list`   | READ  | List goals (filterable) |
| `goals.get`    | READ  | Get goal by id          |
| `goals.create` | WRITE | Create a new goal       |
| `goals.update` | WRITE | Update goal             |
| `goals.delete` | WRITE | Delete a goal           |

### Approvals

| Method                       | Scope     | Description                |
| ---------------------------- | --------- | -------------------------- |
| `exec.approvals.get`         | ADMIN     | Get approval policy        |
| `exec.approvals.set`         | ADMIN     | Set approval policy        |
| `exec.approval.request`      | APPROVALS | Request approval           |
| `exec.approval.waitDecision` | APPROVALS | Wait for approval decision |
| `exec.approval.resolve`      | APPROVALS | Resolve approval request   |

### State DB (Direct Access)

| Method          | Scope | Description                     |
| --------------- | ----- | ------------------------------- |
| `state.tables`  | READ  | List all tables with row counts |
| `state.schema`  | READ  | Get CREATE TABLE DDL            |
| `state.inspect` | READ  | Paginated row browser           |
| `state.query`   | READ  | Execute read-only SELECT        |

## Related Documentation

- [Agent Hierarchy](/operator1/agent-hierarchy) — Organization structure
- [RPC Reference](/operator1/rpc) — Complete RPC method documentation
- [Architecture](/operator1/architecture) — System design overview
- [Configuration](/operator1/configuration) — Config file reference
