---
summary: "Complete guide to the Orchestration system - workspaces, projects, tasks, goals, and more."
updated: "2026-03-25"
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

## Workspace Agent Management

**Table:** `op1_workspace_agents`

Tracks which agents are assigned to which workspaces, along with their role and operational status.

### Schema

| Field               | Type    | Description                                       |
| ------------------- | ------- | ------------------------------------------------- |
| `workspace_id`      | TEXT FK | Parent workspace (PK component)                   |
| `agent_id`          | TEXT    | Agent identifier (PK component)                   |
| `role`              | TEXT    | Optional role label (e.g., `lead`, `contributor`) |
| `joined_at`         | INTEGER | Unix timestamp when agent was assigned            |
| `status`            | TEXT    | `active` \| `inactive` \| `paused`                |
| `capabilities_json` | TEXT    | JSON array of capability strings (optional)       |

### RPC Methods

| Method                         | Scope | Description                              |
| ------------------------------ | ----- | ---------------------------------------- |
| `workspaces.agents`            | READ  | List agents assigned to a workspace      |
| `workspaces.assignAgent`       | WRITE | Assign an agent to a workspace           |
| `workspaces.removeAgent`       | WRITE | Remove an agent from a workspace         |
| `workspaces.updateAgentStatus` | WRITE | Update an agent's status or capabilities |

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
| `workspace_id`      | TEXT FK | Parent workspace (added by migration v18)       |
| `created_at`        | INTEGER | Unix timestamp                                  |
| `updated_at`        | INTEGER | Unix timestamp                                  |

### Session Binding

Projects can bind to agent sessions for context injection:

```json
// RPC: projects.bindSession
{ "projectId": "operator1", "sessionKey": "agent:neo:main" }
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

**Table:** `op1_task_comments`

| Field         | Type    | Description                   |
| ------------- | ------- | ----------------------------- |
| `id`          | TEXT PK | UUID                          |
| `task_id`     | TEXT FK | Parent task                   |
| `author_id`   | TEXT    | Author identifier             |
| `author_type` | TEXT    | `agent` \| `user` \| `system` |
| `body`        | TEXT    | Comment body                  |
| `created_at`  | INTEGER | Unix timestamp                |

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

| Method                  | Scope | Description                         |
| ----------------------- | ----- | ----------------------------------- |
| `tasks.list`            | READ  | List tasks (filterable)             |
| `tasks.get`             | READ  | Get task by id                      |
| `tasks.getByIdentifier` | READ  | Get task by workspace + identifier  |
| `tasks.create`          | WRITE | Create a new task                   |
| `tasks.update`          | WRITE | Update task (status, assignee, etc) |
| `tasks.listComments`    | READ  | List comments for a task            |
| `tasks.addComment`      | WRITE | Add a comment to a task             |

### Task Status Lifecycle

![Task Status Lifecycle](/images/task-status-lifecycle.png)

_Task status flow: backlog → todo → in_progress → in_review → done (with blocked and cancelled branches)._

## Task Documents & Attachments

**Tables:** `op1_task_documents`, `op1_task_attachments`

Tasks can have rich documents (markdown bodies) and binary attachments linked to them.

### op1_task_documents Schema

| Field        | Type    | Description                                         |
| ------------ | ------- | --------------------------------------------------- |
| `id`         | TEXT PK | UUID                                                |
| `task_id`    | TEXT FK | Parent task                                         |
| `title`      | TEXT    | Document title (optional)                           |
| `format`     | TEXT    | `markdown` \| `plain` \| `html` (default: markdown) |
| `body`       | TEXT    | Document content                                    |
| `created_by` | TEXT    | Creator identifier (optional)                       |
| `updated_by` | TEXT    | Last updater identifier (optional)                  |
| `created_at` | INTEGER | Unix timestamp                                      |
| `updated_at` | INTEGER | Unix timestamp                                      |

### op1_task_attachments Schema

| Field          | Type    | Description                   |
| -------------- | ------- | ----------------------------- |
| `id`           | TEXT PK | UUID                          |
| `task_id`      | TEXT FK | Parent task                   |
| `filename`     | TEXT    | Original filename             |
| `mime_type`    | TEXT    | MIME type (optional)          |
| `size_bytes`   | INTEGER | File size in bytes (optional) |
| `storage_path` | TEXT    | Path to stored file           |
| `created_by`   | TEXT    | Creator identifier (optional) |
| `created_at`   | INTEGER | Unix timestamp                |

### RPC Methods

| Method                     | Scope | Description                      |
| -------------------------- | ----- | -------------------------------- |
| `tasks.documents.list`     | READ  | List documents for a task        |
| `tasks.documents.get`      | READ  | Get a document by id             |
| `tasks.documents.create`   | WRITE | Create a new task document       |
| `tasks.documents.update`   | WRITE | Update a task document           |
| `tasks.documents.delete`   | WRITE | Delete a task document           |
| `tasks.attachments.list`   | READ  | List attachments for a task      |
| `tasks.attachments.create` | WRITE | Upload/register a new attachment |
| `tasks.attachments.delete` | WRITE | Delete an attachment             |

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

| Method         | Scope | Description                              |
| -------------- | ----- | ---------------------------------------- |
| `goals.list`   | READ  | List goals (filterable by status/parent) |
| `goals.tree`   | READ  | Return the full goal tree (adjacency)    |
| `goals.get`    | READ  | Get goal by id                           |
| `goals.create` | WRITE | Create a new goal                        |
| `goals.update` | WRITE | Update goal (status, progress)           |
| `goals.delete` | WRITE | Delete a goal                            |

## Exec Approvals

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

## Organizational Approvals

**Tables:** `op1_approvals`, `op1_approval_comments`

Organizational approval flow for high-level governance decisions — agent hiring, budget overrides, and config changes. Separate from the exec-level `security_exec_approvals` system.

### op1_approvals Schema

| Field            | Type    | Description                                                   |
| ---------------- | ------- | ------------------------------------------------------------- |
| `id`             | TEXT PK | UUID                                                          |
| `workspace_id`   | TEXT FK | Parent workspace                                              |
| `type`           | TEXT    | `agent_hire` \| `budget_override` \| `config_change`          |
| `status`         | TEXT    | `pending` \| `revision_requested` \| `approved` \| `rejected` |
| `requester_id`   | TEXT    | Requesting agent or user identifier                           |
| `requester_type` | TEXT    | `agent` \| `user` \| `system`                                 |
| `payload_json`   | TEXT    | JSON payload describing the requested action                  |
| `decision_note`  | TEXT    | Human note on the decision (optional)                         |
| `decided_by`     | TEXT    | Identifier of the approver                                    |
| `decided_at`     | INTEGER | Unix timestamp when decision was made                         |
| `created_at`     | INTEGER | Unix timestamp                                                |
| `updated_at`     | INTEGER | Unix timestamp                                                |

### op1_approval_comments Schema

| Field         | Type    | Description                   |
| ------------- | ------- | ----------------------------- |
| `id`          | TEXT PK | UUID                          |
| `approval_id` | TEXT FK | Parent approval               |
| `author_id`   | TEXT    | Comment author                |
| `author_type` | TEXT    | `agent` \| `user` \| `system` |
| `body`        | TEXT    | Comment text                  |
| `created_at`  | INTEGER | Unix timestamp                |

### Status Lifecycle

```
pending → revision_requested → pending (revised)
                             → approved
                             → rejected
pending → approved
pending → rejected
```

### RPC Methods

| Method                    | Scope | Description                                |
| ------------------------- | ----- | ------------------------------------------ |
| `approvals.list`          | READ  | List approvals (filterable by status/type) |
| `approvals.get`           | READ  | Get approval by id                         |
| `approvals.create`        | WRITE | Submit a new approval request              |
| `approvals.updatePayload` | WRITE | Update the payload of a pending approval   |
| `approvals.decide`        | ADMIN | Approve or reject an approval request      |
| `approvals.comments.list` | READ  | List comments on an approval               |
| `approvals.comments.add`  | WRITE | Add a comment to an approval               |

## Activity Log

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

### RPC Methods

| Method              | Scope | Description                                      |
| ------------------- | ----- | ------------------------------------------------ |
| `activityLogs.list` | READ  | List activity log entries (filterable/paginated) |

## Budget Policy Engine

**Tables:** `op1_budget_policies`, `op1_budget_incidents`, `op1_cost_events`

A full policy engine for budget enforcement across workspaces, agents, and projects. Policies define spending limits; incidents are raised when limits are breached; cost events record individual spend.

Microcent conversion: `1 USD = 100,000 microcents`.

### op1_budget_policies Schema

| Field               | Type    | Description                                              |
| ------------------- | ------- | -------------------------------------------------------- |
| `id`                | TEXT PK | UUID                                                     |
| `workspace_id`      | TEXT FK | Parent workspace                                         |
| `scope_type`        | TEXT    | `workspace` \| `agent` \| `project`                      |
| `scope_id`          | TEXT    | ID of the scoped entity (workspace/agent/project id)     |
| `amount_microcents` | INTEGER | Budget limit in microcents                               |
| `window_kind`       | TEXT    | `calendar_month_utc` \| `lifetime`                       |
| `warn_percent`      | INTEGER | Percentage at which a warning incident is raised (0-100) |
| `hard_stop`         | INTEGER | If 1, block spend when limit is reached                  |
| `created_at`        | INTEGER | Unix timestamp                                           |
| `updated_at`        | INTEGER | Unix timestamp                                           |

### op1_budget_incidents Schema

| Field              | Type    | Description                                  |
| ------------------ | ------- | -------------------------------------------- |
| `id`               | TEXT PK | UUID                                         |
| `workspace_id`     | TEXT FK | Parent workspace                             |
| `policy_id`        | TEXT FK | Triggering policy                            |
| `type`             | TEXT    | `warning` \| `hard_stop` \| `resolved`       |
| `agent_id`         | TEXT    | Agent that triggered the incident (optional) |
| `spent_microcents` | INTEGER | Spend at the time of the incident            |
| `limit_microcents` | INTEGER | Policy limit at the time of the incident     |
| `message`          | TEXT    | Human-readable description                   |
| `resolved_at`      | INTEGER | Unix timestamp when resolved (null = active) |
| `created_at`       | INTEGER | Unix timestamp                               |

### op1_cost_events Schema

| Field             | Type    | Description                            |
| ----------------- | ------- | -------------------------------------- |
| `id`              | TEXT PK | UUID                                   |
| `workspace_id`    | TEXT FK | Parent workspace                       |
| `agent_id`        | TEXT    | Agent that incurred the cost           |
| `session_id`      | TEXT    | Associated session (optional)          |
| `task_id`         | TEXT    | Associated task (optional)             |
| `project_id`      | TEXT    | Associated project (optional)          |
| `provider`        | TEXT    | Model provider (e.g., `anthropic`)     |
| `model`           | TEXT    | Model name (e.g., `claude-sonnet-4-6`) |
| `input_tokens`    | INTEGER | Input token count                      |
| `output_tokens`   | INTEGER | Output token count                     |
| `cost_microcents` | INTEGER | Total cost in microcents               |
| `occurred_at`     | INTEGER | Unix timestamp                         |

### RPC Methods

| Method                      | Scope | Description                                      |
| --------------------------- | ----- | ------------------------------------------------ |
| `budgets.policies.list`     | READ  | List budget policies (filterable by scope)       |
| `budgets.policies.get`      | READ  | Get a policy by id                               |
| `budgets.policies.create`   | WRITE | Create a new budget policy                       |
| `budgets.policies.update`   | WRITE | Update policy amount, warn percent, or hard stop |
| `budgets.policies.delete`   | WRITE | Delete a budget policy                           |
| `budgets.incidents.list`    | READ  | List budget incidents (filterable)               |
| `budgets.incidents.resolve` | WRITE | Mark an incident resolved                        |
| `costs.events.list`         | READ  | List cost events (filterable by agent/task/time) |

## Finance Events

**Table:** `op1_finance_events`

High-level financial ledger events that supplement raw cost tracking. While `op1_cost_events` records LLM inference spend, finance events capture the full range of financial activity including manual credits, debits, and refunds.

### Schema

| Field               | Type    | Description                                                                                                       |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                | TEXT PK | UUID                                                                                                              |
| `workspace_id`      | TEXT FK | Parent workspace                                                                                                  |
| `agent_id`          | TEXT    | Associated agent (optional)                                                                                       |
| `task_id`           | TEXT    | Associated task (optional)                                                                                        |
| `project_id`        | TEXT    | Associated project (optional)                                                                                     |
| `goal_id`           | TEXT    | Associated goal (optional)                                                                                        |
| `cost_event_id`     | TEXT    | Linked cost event (optional)                                                                                      |
| `billing_code`      | TEXT    | Billing/cost center code (optional)                                                                               |
| `description`       | TEXT    | Human-readable description                                                                                        |
| `event_kind`        | TEXT    | `llm_inference` \| `tool_call` \| `budget_adjustment` \| `manual_credit` \| `manual_debit` \| `refund` \| `other` |
| `direction`         | TEXT    | `debit` \| `credit`                                                                                               |
| `provider`          | TEXT    | Model provider (optional)                                                                                         |
| `model`             | TEXT    | Model name (optional)                                                                                             |
| `amount_microcents` | INTEGER | Amount in microcents                                                                                              |
| `created_at`        | INTEGER | Unix timestamp                                                                                                    |

### Indexes

- `idx_finance_events_workspace` — `(workspace_id)`
- `idx_finance_events_agent` — `(agent_id)`
- `idx_finance_events_created` — `(created_at)`

## Execution Workspaces

**Tables:** `op1_execution_workspaces`, `op1_workspace_operations`

Execution workspaces represent isolated environments (worktrees, sandboxes, or local directories) where agents perform code work. Operations record individual steps taken within a workspace.

### op1_execution_workspaces Schema

| Field            | Type    | Description                                         |
| ---------------- | ------- | --------------------------------------------------- |
| `id`             | TEXT PK | UUID                                                |
| `workspace_id`   | TEXT FK | Parent workspace (default: `default`)               |
| `project_id`     | TEXT    | Associated project (optional)                       |
| `task_id`        | TEXT    | Associated task (optional)                          |
| `agent_id`       | TEXT    | Owning agent (optional)                             |
| `name`           | TEXT    | Human-readable name                                 |
| `mode`           | TEXT    | Execution mode (default: `local_fs`)                |
| `status`         | TEXT    | `active` \| `archived` \| `cleanup_pending`         |
| `workspace_path` | TEXT    | Filesystem path of the workspace                    |
| `base_ref`       | TEXT    | Git base ref (branch or commit)                     |
| `branch_name`    | TEXT    | Working branch name                                 |
| `opened_at`      | INTEGER | Unix timestamp when workspace was created           |
| `closed_at`      | INTEGER | Unix timestamp when workspace was closed (nullable) |
| `metadata_json`  | TEXT    | Arbitrary JSON metadata                             |

### op1_workspace_operations Schema

| Field                    | Type    | Description                                       |
| ------------------------ | ------- | ------------------------------------------------- |
| `id`                     | TEXT PK | UUID                                              |
| `execution_workspace_id` | TEXT FK | Parent execution workspace                        |
| `operation_type`         | TEXT    | Type of operation (e.g., `git_clone`, `test_run`) |
| `status`                 | TEXT    | `pending` \| `running` \| `completed` \| `failed` |
| `details_json`           | TEXT    | JSON payload with operation details               |
| `started_at`             | INTEGER | Unix timestamp                                    |
| `completed_at`           | INTEGER | Unix timestamp (nullable)                         |

### RPC Methods

| Method                                  | Scope | Description                                |
| --------------------------------------- | ----- | ------------------------------------------ |
| `executionWorkspaces.create`            | WRITE | Create a new execution workspace           |
| `executionWorkspaces.get`               | READ  | Get an execution workspace by id           |
| `executionWorkspaces.list`              | READ  | List execution workspaces (filterable)     |
| `executionWorkspaces.update`            | WRITE | Update status, path, or metadata           |
| `executionWorkspaces.archive`           | WRITE | Archive an execution workspace             |
| `executionWorkspaces.operations.record` | WRITE | Record a new operation                     |
| `executionWorkspaces.operations.list`   | READ  | List operations for an execution workspace |

## Agent Wakeup Requests

**Table:** `op1_agent_wakeup_requests`

Async wakeup queue for agents. When a task is assigned or an event occurs that requires agent attention, a wakeup request is enqueued. The agent polls and processes it on its next cycle.

### Schema

| Field          | Type    | Description                                          |
| -------------- | ------- | ---------------------------------------------------- |
| `id`           | TEXT PK | UUID                                                 |
| `workspace_id` | TEXT FK | Parent workspace (default: `default`)                |
| `agent_id`     | TEXT    | Target agent                                         |
| `task_id`      | TEXT    | Associated task (optional)                           |
| `reason`       | TEXT    | Wake reason (default: `task_assigned`)               |
| `status`       | TEXT    | `pending` \| `processing` \| `completed` \| `failed` |
| `payload_json` | TEXT    | JSON payload with additional context                 |
| `created_at`   | INTEGER | Unix timestamp                                       |
| `processed_at` | INTEGER | Unix timestamp when picked up by agent (nullable)    |

### RPC Methods

| Method            | Scope | Description                                        |
| ----------------- | ----- | -------------------------------------------------- |
| `wakeup.create`   | WRITE | Enqueue a wakeup request for an agent              |
| `wakeup.list`     | READ  | List pending wakeup requests (filterable by agent) |
| `wakeup.process`  | WRITE | Mark a wakeup request as processing                |
| `wakeup.complete` | WRITE | Mark a wakeup request as completed                 |

## Agent API Keys

**Table:** `op1_agent_api_keys`

Per-agent API keys used for authentication. Keys are stored as bcrypt hashes; only the prefix is stored in plaintext for identification.

### Schema

| Field          | Type    | Description                                   |
| -------------- | ------- | --------------------------------------------- |
| `id`           | TEXT PK | UUID                                          |
| `agent_id`     | TEXT    | Owning agent                                  |
| `workspace_id` | TEXT FK | Associated workspace (default: `default`)     |
| `name`         | TEXT    | Human-readable label for the key              |
| `key_hash`     | TEXT    | Bcrypt hash of the API key                    |
| `key_prefix`   | TEXT    | First few characters of the key (for display) |
| `last_used_at` | INTEGER | Unix timestamp of last use (nullable)         |
| `revoked_at`   | INTEGER | Unix timestamp when revoked (nullable)        |
| `created_at`   | INTEGER | Unix timestamp                                |

### RPC Methods

| Method                  | Scope | Description                       |
| ----------------------- | ----- | --------------------------------- |
| `agents.apiKeys.create` | WRITE | Create a new API key for an agent |
| `agents.apiKeys.list`   | READ  | List API keys for an agent        |
| `agents.apiKeys.revoke` | WRITE | Revoke an API key                 |

## Agent Config Revisions

**Table:** `op1_agent_config_revisions`

Immutable audit trail of agent configuration changes (SOUL.md, identity files, etc.). Supports rollback to any prior revision.

### Schema

| Field          | Type    | Description                                     |
| -------------- | ------- | ----------------------------------------------- |
| `id`           | TEXT PK | UUID                                            |
| `workspace_id` | TEXT FK | Parent workspace                                |
| `agent_id`     | TEXT    | Target agent                                    |
| `config_json`  | TEXT    | Full config content at the time of the revision |
| `changed_by`   | TEXT    | Identifier of who made the change               |
| `change_note`  | TEXT    | Human-readable description of the change        |
| `created_at`   | INTEGER | Unix timestamp                                  |

### RPC Methods

| Method                      | Scope | Description                               |
| --------------------------- | ----- | ----------------------------------------- |
| `revisions.config.list`     | READ  | List config revisions for an agent        |
| `revisions.config.get`      | READ  | Get a specific revision by id             |
| `revisions.config.rollback` | ADMIN | Restore a prior revision to the workspace |

## Agent Metrics

Agent performance and department-level budget summaries. Metrics are derived from cost events and task history.

### RPC Methods

| Method                       | Scope | Description                                               |
| ---------------------------- | ----- | --------------------------------------------------------- |
| `agents.metrics.get`         | READ  | Get performance metrics for a single agent in a workspace |
| `agents.metrics.list`        | READ  | List metrics for all agents in a workspace                |
| `budgets.department.summary` | READ  | Get budget spend aggregated by department for a workspace |

## Dashboard

High-level aggregated summary of the orchestration system state. Useful for UI overview screens and health monitoring.

### dashboard.summary Response

| Field                   | Type    | Description                                      |
| ----------------------- | ------- | ------------------------------------------------ |
| `workspaceCount`        | INTEGER | Non-archived workspace count                     |
| `agentCount`            | INTEGER | Distinct agents across all workspace assignments |
| `tasksTotal`            | INTEGER | Total task count                                 |
| `tasksInProgress`       | INTEGER | Tasks with status `in_progress`                  |
| `tasksDone`             | INTEGER | Tasks with status `done`                         |
| `goalsActive`           | INTEGER | Goals with status `planned` or `in_progress`     |
| `goalsAchieved`         | INTEGER | Goals with status `achieved`                     |
| `pendingApprovals`      | INTEGER | Organizational approvals awaiting decision       |
| `activeBudgetIncidents` | INTEGER | Budget incidents with `resolved_at IS NULL`      |
| `totalSpendMicrocents`  | INTEGER | Sum of all cost events                           |
| `pendingWakeups`        | INTEGER | Wakeup requests with status `pending`            |

### sidebar.badges Response

| Field                   | Type    | Description                                    |
| ----------------------- | ------- | ---------------------------------------------- |
| `pendingApprovals`      | INTEGER | Count of pending organizational approvals      |
| `activeBudgetIncidents` | INTEGER | Count of unresolved budget incidents           |
| `tasksInProgress`       | INTEGER | Count of in-progress tasks                     |
| `unreadCount`           | INTEGER | Unread messaging count (placeholder, always 0) |

### RPC Methods

| Method              | Scope | Description                                    |
| ------------------- | ----- | ---------------------------------------------- |
| `dashboard.summary` | READ  | Aggregated orchestration summary (single call) |
| `sidebar.badges`    | READ  | Badge counts for sidebar navigation indicators |

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
> 6. **Approval flow** — exec approvals via `security_exec_approvals`; org approvals via `op1_approvals`
> 7. **Budget policy engine** — spend accumulates in `op1_cost_events`; policies enforced via `op1_budget_policies`
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

### Workspace Agent Management

| Method                         | Scope | Description                      |
| ------------------------------ | ----- | -------------------------------- |
| `workspaces.agents`            | READ  | List agents in a workspace       |
| `workspaces.assignAgent`       | WRITE | Assign agent to workspace        |
| `workspaces.removeAgent`       | WRITE | Remove agent from workspace      |
| `workspaces.updateAgentStatus` | WRITE | Update agent status/capabilities |

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

| Method                  | Scope | Description                        |
| ----------------------- | ----- | ---------------------------------- |
| `tasks.list`            | READ  | List tasks (filterable)            |
| `tasks.get`             | READ  | Get task by id                     |
| `tasks.getByIdentifier` | READ  | Get task by workspace + identifier |
| `tasks.create`          | WRITE | Create a new task                  |
| `tasks.update`          | WRITE | Update task                        |
| `tasks.listComments`    | READ  | List task comments                 |
| `tasks.addComment`      | WRITE | Add a comment to a task            |

### Task Documents & Attachments

| Method                     | Scope | Description                 |
| -------------------------- | ----- | --------------------------- |
| `tasks.documents.list`     | READ  | List documents for a task   |
| `tasks.documents.get`      | READ  | Get a document by id        |
| `tasks.documents.create`   | WRITE | Create a task document      |
| `tasks.documents.update`   | WRITE | Update a task document      |
| `tasks.documents.delete`   | WRITE | Delete a task document      |
| `tasks.attachments.list`   | READ  | List attachments for a task |
| `tasks.attachments.create` | WRITE | Register a new attachment   |
| `tasks.attachments.delete` | WRITE | Delete an attachment        |

### Goals

| Method         | Scope | Description             |
| -------------- | ----- | ----------------------- |
| `goals.list`   | READ  | List goals (filterable) |
| `goals.tree`   | READ  | Full goal tree          |
| `goals.get`    | READ  | Get goal by id          |
| `goals.create` | WRITE | Create a new goal       |
| `goals.update` | WRITE | Update goal             |
| `goals.delete` | WRITE | Delete a goal           |

### Exec Approvals

| Method                       | Scope     | Description                |
| ---------------------------- | --------- | -------------------------- |
| `exec.approvals.get`         | ADMIN     | Get approval policy        |
| `exec.approvals.set`         | ADMIN     | Set approval policy        |
| `exec.approval.request`      | APPROVALS | Request approval           |
| `exec.approval.waitDecision` | APPROVALS | Wait for approval decision |
| `exec.approval.resolve`      | APPROVALS | Resolve approval request   |

### Organizational Approvals

| Method                    | Scope | Description                        |
| ------------------------- | ----- | ---------------------------------- |
| `approvals.list`          | READ  | List approvals                     |
| `approvals.get`           | READ  | Get approval by id                 |
| `approvals.create`        | WRITE | Submit an approval request         |
| `approvals.updatePayload` | WRITE | Update payload of pending approval |
| `approvals.decide`        | ADMIN | Approve or reject                  |
| `approvals.comments.list` | READ  | List approval comments             |
| `approvals.comments.add`  | WRITE | Add approval comment               |

### Budget Policy Engine

| Method                      | Scope | Description               |
| --------------------------- | ----- | ------------------------- |
| `budgets.policies.list`     | READ  | List budget policies      |
| `budgets.policies.get`      | READ  | Get policy by id          |
| `budgets.policies.create`   | WRITE | Create a budget policy    |
| `budgets.policies.update`   | WRITE | Update a budget policy    |
| `budgets.policies.delete`   | WRITE | Delete a budget policy    |
| `budgets.incidents.list`    | READ  | List budget incidents     |
| `budgets.incidents.resolve` | WRITE | Resolve a budget incident |
| `costs.events.list`         | READ  | List cost events          |

### Agent Wakeup Requests

| Method            | Scope | Description                  |
| ----------------- | ----- | ---------------------------- |
| `wakeup.create`   | WRITE | Enqueue a wakeup request     |
| `wakeup.list`     | READ  | List pending wakeup requests |
| `wakeup.process`  | WRITE | Mark request as processing   |
| `wakeup.complete` | WRITE | Mark request as completed    |

### Agent API Keys

| Method                  | Scope | Description             |
| ----------------------- | ----- | ----------------------- |
| `agents.apiKeys.create` | WRITE | Create an agent API key |
| `agents.apiKeys.list`   | READ  | List agent API keys     |
| `agents.apiKeys.revoke` | WRITE | Revoke an agent API key |

### Agent Config Revisions

| Method                      | Scope | Description                  |
| --------------------------- | ----- | ---------------------------- |
| `revisions.config.list`     | READ  | List config revisions        |
| `revisions.config.get`      | READ  | Get a revision by id         |
| `revisions.config.rollback` | ADMIN | Rollback to a prior revision |

### Agent Metrics

| Method                       | Scope | Description                           |
| ---------------------------- | ----- | ------------------------------------- |
| `agents.metrics.get`         | READ  | Get metrics for a single agent        |
| `agents.metrics.list`        | READ  | List metrics for all agents           |
| `budgets.department.summary` | READ  | Department-level budget spend summary |

### Execution Workspaces

| Method                                  | Scope | Description                   |
| --------------------------------------- | ----- | ----------------------------- |
| `executionWorkspaces.create`            | WRITE | Create an execution workspace |
| `executionWorkspaces.get`               | READ  | Get by id                     |
| `executionWorkspaces.list`              | READ  | List (filterable)             |
| `executionWorkspaces.update`            | WRITE | Update status or metadata     |
| `executionWorkspaces.archive`           | WRITE | Archive workspace             |
| `executionWorkspaces.operations.record` | WRITE | Record an operation           |
| `executionWorkspaces.operations.list`   | READ  | List operations               |

### Dashboard

| Method              | Scope | Description                  |
| ------------------- | ----- | ---------------------------- |
| `dashboard.summary` | READ  | Full orchestration summary   |
| `sidebar.badges`    | READ  | Badge counts for sidebar nav |

### Activity Log

| Method              | Scope | Description               |
| ------------------- | ----- | ------------------------- |
| `activityLogs.list` | READ  | List activity log entries |

### State DB (Direct Access)

| Method                | Scope | Description                              |
| --------------------- | ----- | ---------------------------------------- |
| `state.info`          | READ  | DB path, size, schema version, integrity |
| `state.tables`        | READ  | List all tables with row counts          |
| `state.schema`        | READ  | Get CREATE TABLE DDL                     |
| `state.inspect`       | READ  | Paginated row browser                    |
| `state.query`         | READ  | Execute read-only SELECT                 |
| `state.settings.list` | READ  | List settings in a store/scope           |
| `state.settings.get`  | READ  | Read a single setting                    |
| `state.settings.set`  | ADMIN | Write a setting                          |
| `state.audit`         | READ  | Query the audit_state trail              |
| `state.export`        | READ  | Export one or all tables as JSON         |

## Related Documentation

- [Agent Hierarchy](/operator1/agent-hierarchy) — Organization structure
- [RPC Reference](/operator1/rpc) — Complete RPC method documentation
- [Architecture](/operator1/architecture) — System design overview
- [Configuration](/operator1/configuration) — Config file reference
