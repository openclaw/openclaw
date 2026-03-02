# OpenClaw Project Management Proposal

> **Status:** Draft for Developer Review
> **Last Updated:** 2026-03-02
> **Purpose:** Project & task management layer for OpenClaw with workspace-aware storage

---

## Overview

This document proposes a project management system for OpenClaw that:

1. **Persists across sessions** — Projects and tasks survive chat restarts
2. **Links conversations to work** — Session binding for context injection
3. **Aggregates tasks from multiple sources** — Manual, team runs, GitHub
4. **Provides visual overview** — Feeds the Matrix canvas with real-time data
5. **Integrates with memory** — Tasks indexed by QMD for semantic search

---

## Table of Contents

1. [Storage Architecture](#1-storage-architecture)
2. [Data Model](#2-data-model)
3. [Gateway API Reference](#3-gateway-api-reference)
4. [Session Binding](#4-session-binding)
5. [Integration Points](#5-integration-points)
6. [Memory System Integration (QMD)](#6-memory-system-integration-qmd)
7. [File Structure](#7-file-structure)
8. [Implementation Phases](#8-implementation-phases)
9. [Open Questions](#9-open-questions)

---

## 1. Storage Architecture

### Hybrid SQLite Approach

We use a **hybrid storage model** with SQLite:

| Layer                | Storage            | Location                               | Purpose                     |
| -------------------- | ------------------ | -------------------------------------- | --------------------------- |
| **Project Registry** | Central SQLite     | `~/.openclaw/projects/registry.db`     | List all projects, metadata |
| **Tasks**            | Per-project SQLite | `{workspace}/.openclaw/tasks.db`       | Tasks travel with project   |
| **Task Exports**     | Markdown files     | `~/.openclaw/projects/exported-tasks/` | QMD indexing                |

### Why Hybrid?

| Benefit                 | Explanation                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| **Cross-project view**  | Central registry shows all projects in one query                        |
| **Project portability** | Move workspace = move tasks; no broken references                       |
| **Isolation**           | Each project's tasks in separate DB; no lock contention                 |
| **Agent access**        | Any agent can query any project via Gateway RPCs                        |
| **Concurrency**         | SQLite handles concurrent reads; per-project DBs reduce write conflicts |
| **Semantic search**     | Exported tasks indexed by QMD alongside memory                          |

### Directory Layout

```
~/.openclaw/
├── projects/
│   ├── registry.db              # Central project registry
│   └── exported-tasks/          # Task exports for QMD indexing
│       ├── ui-next/
│       │   ├── task-001.md
│       │   └── task-002.md
│       └── auth-refactor/
│           └── task-003.md
│
├── agents/
│   └── main/
│       └── qmd/
│           ├── xdg-cache/qmd/index.sqlite   # QMD vector index
│           └── sessions/                    # Session exports
│
└── workspaces/                  # Project workspaces (can be external)
    ├── ui-next/
    │   └── .openclaw/
    │       └── tasks.db         # Tasks for ui-next project
    │
    └── auth-refactor/
        └── .openclaw/
            └── tasks.db         # Tasks for auth-refactor project

# External project directories:
~/dev/
├── operator1/
│   └── .openclaw/
│       └── tasks.db             # Tasks for operator1
│
└── my-other-project/
    └── .openclaw/
        └── tasks.db             # Tasks for that project
```

### Database Schemas

#### Central Registry (`~/.openclaw/projects/registry.db`)

```sql
-- Projects table
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- planning, active, on_hold, completed, archived
  priority TEXT NOT NULL DEFAULT 'p2',    -- p0, p1, p2, p3
  tags TEXT,                              -- JSON array
  owner TEXT,                             -- agentId or userId

  -- Workspace binding
  workspace_path TEXT NOT NULL,           -- Path to project workspace
  git_remote TEXT,
  git_branch TEXT,

  -- External links (JSON)
  links TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_owner ON projects(owner);
CREATE INDEX idx_projects_workspace ON projects(workspace_path);

-- Session bindings table
CREATE TABLE session_bindings (
  session_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  bound_by TEXT,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_bindings_project ON session_bindings(project_id);
```

#### Per-Project Tasks (`{workspace}/.openclaw/tasks.db`)

```sql
-- Tasks table
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,               -- Reference back to registry
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',    -- todo, in_progress, blocked, done, cancelled
  priority TEXT NOT NULL DEFAULT 'p2',

  -- Assignment
  assignee TEXT,                          -- agentId, userId, or NULL

  -- Source tracking
  source TEXT NOT NULL DEFAULT 'manual',  -- manual, team_run, github_issue, linear, notion
  source_ref TEXT,                        -- e.g., "github:issue:42"

  -- Dependencies (JSON array of task IDs)
  blocked_by TEXT,

  -- Session linkage
  session_key TEXT,                       -- Originating chat session

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due_date INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);
CREATE INDEX idx_tasks_source ON tasks(source);

-- Full-text search virtual table
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title,
  description,
  content='tasks',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;

CREATE TRIGGER tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.rowid, old.title, old.description);
END;

CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.rowid, old.title, old.description);
  INSERT INTO tasks_fts(rowid, title, description)
  VALUES (new.rowid, new.title, new.description);
END;
```

---

## 2. Data Model

### TypeScript Types

```typescript
// ─── Project ─────────────────────────────────────────────────────────

type ProjectStatus = "planning" | "active" | "on_hold" | "completed" | "archived";
type Priority = "p0" | "p1" | "p2" | "p3";

type Project = {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  priority: Priority;
  tags: string[];
  owner?: string;

  // Workspace binding
  workspacePath: string;
  git?: {
    remote?: string;
    branch?: string;
  };

  // External links
  links?: {
    github?: string;
    docs?: string;
    slack?: string;
    notion?: string;
  };

  // Computed metrics (derived on query)
  metrics?: {
    tasksTotal: number;
    tasksDone: number;
    lastActivityAt: number;
  };

  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

// ─── Task ────────────────────────────────────────────────────────────

type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled";
type TaskSource = "manual" | "team_run" | "github_issue" | "linear" | "notion";

type Task = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;

  assignee?: string;
  source: TaskSource;
  sourceRef?: string;
  blockedBy: string[];
  sessionKey?: string;

  createdAt: number;
  updatedAt: number;
  dueDate?: number;
  completedAt?: number;
};

// ─── Session Binding ─────────────────────────────────────────────────

type SessionProjectBinding = {
  sessionKey: string;
  projectId: string;
  boundAt: number;
  boundBy?: string;
};
```

---

## 3. Gateway API Reference

### Projects Domain

```typescript
// projects.create
{
  name: string;
  description?: string;
  priority?: Priority;
  workspacePath: string;
  links?: { github?: string; ... };
}
→ Project

// projects.list
{
  status?: ProjectStatus[];
  owner?: string;
  tags?: string[];
  limit?: number;
}
→ Project[]

// projects.get
{
  id: string;
  includeMetrics?: boolean;
}
→ Project

// projects.update
{
  id: string;
  patch: Partial<Pick<Project, 'name' | 'description' | 'status' | 'priority' | 'tags' | 'links'>>;
}
→ Project

// projects.archive
{
  id: string;
}
→ Project

// projects.getByWorkspace
{
  workspacePath: string;
}
→ Project | null
```

### Tasks Domain

```typescript
// tasks.create
{
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  assignee?: string;
  blockedBy?: string[];
  dueDate?: number;
  source?: TaskSource;
  sourceRef?: string;
}
→ Task

// tasks.list
{
  projectId: string;
  status?: TaskStatus[];
  assignee?: string;
  source?: TaskSource[];
  limit?: number;
}
→ Task[]

// tasks.update
{
  projectId: string;
  taskId: string;
  patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'blockedBy' | 'dueDate'>>;
}
→ Task

// tasks.delete
{
  projectId: string;
  taskId: string;
}
→ { ok: true }

// tasks.search
{
  projectId: string;
  query: string;
  limit?: number;
}
→ Task[]

// tasks.crossProject (admin view)
{
  status?: TaskStatus[];
  assignee?: string;
  limit?: number;
}
→ { projectId: string; tasks: Task[] }[]
```

### Session Bindings

```typescript
// projects.bindSession
{
  sessionKey: string;
  projectId: string;
}
→ SessionProjectBinding

// projects.unbindSession
{
  sessionKey: string;
}
→ { ok: true }

// projects.getContext
{
  sessionKey: string;
}
→ { project: Project | null; recentTasks: Task[] }
```

---

## 4. Session Binding

### Flow

When a user says "let's work on the ui-next project":

1. Agent calls `projects.bindSession({ sessionKey, projectId: "ui-next" })`
2. Binding stored in central registry
3. All subsequent messages in that session are tagged with project context
4. Agent system prompt includes project summary
5. Tasks created in that session auto-link to the project
6. Spawned subagents inherit project context

### Context Injection

When a session is bound to a project, the agent's context includes:

```markdown
## Project Context

You are working on **ui-next** (active, p1).

**Workspace:** ~/dev/operator1/ui-next
**Git:** github.com/openclaw/openclaw (main)

**Progress:** 8/12 tasks done (67%)
**Recent activity:** 2 hours ago

**Open tasks:**

- [ ] Add dark mode toggle (in_progress)
- [ ] Write integration tests (blocked)
- [ ] Deploy to staging (todo)

Use `tasks.create`, `tasks.list`, `tasks.update` RPCs to manage tasks.
```

---

## 5. Integration Points

### Team Runs → Projects

```typescript
// When creating a team run for a project:
createTeamRun({
  name: "auth-refactor",
  projectId: "ui-next", // Link to project
  leader: "neo",
  leaderSession: "agent:neo:main",
});

// Team tasks sync to project task list with source: "team_run"
```

### GitHub Issues → Tasks

```typescript
// Bi-directional sync (optional, per-project config)
{
  links: { github: "https://github.com/openclaw/openclaw" },
  sync: { github: { enabled: true, labelFilter: ["project: ui-next"] } }
}

// On sync:
// - GitHub issue created → Task with source: "github_issue"
// - Task marked done → Close issue (optional)
```

### Memory Extraction → Tasks

```typescript
// Parse MEMORY.md for actionable items
const memory = `## 2026-03-02
- Discussed auth refactor
- [ ] Research JWT libraries
- [ ] Implement middleware (blocked by: research)
`;

// Extracted tasks:
// - "Research JWT libraries" → Task
// - "Implement middleware" → Task with blockedBy
```

---

## 6. Memory System Integration (QMD)

### Overview

OpenClaw's existing QMD memory system can index project tasks alongside MEMORY.md and session transcripts. This enables **semantic search across all project context** — memories, conversations, and tasks in one query.

### How QMD Works Today

QMD indexes **collections** of markdown files:

```
~/.openclaw/agents/main/qmd/
├── xdg-cache/qmd/index.sqlite    # Vector index
└── sessions/                     # Exported sessions → indexed
    ├── session-abc123.md
    └── session-def456.md
```

Each collection is a directory of `.md` files that QMD embeds and indexes for semantic search.

### Task Export Pipeline

To index tasks, we export them as markdown files that QMD can consume:

```
Task Created/Updated in SQLite
            │
            ▼
Export to ~/.openclaw/projects/exported-tasks/{projectId}/task-{id}.md
            │
            ▼
QMD indexes on next sync (via collection config)
```

### Task Export Format

Each task is exported as structured markdown:

```markdown
# Add dark mode toggle

- **Project:** ui-next
- **Status:** in_progress
- **Assignee:** tank
- **Priority:** p1
- **Blocked by:** none
- **Created:** 2026-03-02
- **Source:** manual

## Description

Implement a dark mode toggle in the settings panel.
Should persist preference to localStorage and respect
system preference by default.

## Context

- **Origin:** session agent:main:main
- **Related:** auth-refactor project
```

### QMD Collection Configuration

Add to `openclaw.json`:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "collections": [
        {
          "name": "project-tasks",
          "path": "~/.openclaw/projects/exported-tasks",
          "pattern": "**/*.md",
          "kind": "tasks"
        }
      ]
    }
  }
}
```

### Implementation

#### Task Exporter (`src/projects/task-exporter.ts`)

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { Task, Project } from "./types.js";

const EXPORT_DIR = path.join(os.homedir(), ".openclaw", "projects", "exported-tasks");

export async function exportTaskForQmd(project: Project, task: Task): Promise<void> {
  const projectDir = path.join(EXPORT_DIR, project.id);
  await fs.mkdir(projectDir, { recursive: true });

  const content = buildTaskMarkdown(project, task);
  const filePath = path.join(projectDir, `task-${task.id}.md`);

  await fs.writeFile(filePath, content, "utf-8");
}

export async function deleteTaskExport(projectId: string, taskId: string): Promise<void> {
  const filePath = path.join(EXPORT_DIR, projectId, `task-${taskId}.md`);
  await fs.unlink(filePath).catch(() => {}); // Ignore if not found
}

function buildTaskMarkdown(project: Project, task: Task): string {
  const frontMatter = [
    `# ${task.title}`,
    "",
    `- **Project:** ${project.name}`,
    `- **Status:** ${task.status}`,
    `- **Priority:** ${task.priority}`,
  ];

  if (task.assignee) {
    frontMatter.push(`- **Assignee:** ${task.assignee}`);
  }

  if (task.blockedBy.length > 0) {
    frontMatter.push(`- **Blocked by:** ${task.blockedBy.join(", ")}`);
  }

  frontMatter.push(`- **Created:** ${new Date(task.createdAt).toISOString().split("T")[0]}`);
  frontMatter.push(`- **Source:** ${task.source}`);

  const sections = [frontMatter.join("\n")];

  if (task.description) {
    sections.push("", "## Description", "", task.description);
  }

  if (task.sessionKey) {
    sections.push("", "## Context", "", `- **Origin:** ${task.sessionKey}`);
  }

  return sections.join("\n") + "\n";
}
```

#### Integration with Task Store

```typescript
// In task-store.ts

import { exportTaskForQmd, deleteTaskExport } from "./task-exporter.js";
import { getProject } from "./registry-store.js";

export function createTask(opts: TaskCreateOptions): Task {
  const task = insertTask(opts);

  // Export for QMD indexing (async, non-blocking)
  const project = getProject(opts.projectId);
  if (project) {
    exportTaskForQmd(project, task).catch((err) => {
      log.warn(`Failed to export task for QMD: ${err}`);
    });
  }

  return task;
}

export function updateTask(projectId: string, taskId: string, patch: TaskPatch): Task | null {
  const task = updateTaskInDb(projectId, taskId, patch);

  if (task) {
    const project = getProject(projectId);
    if (project) {
      exportTaskForQmd(project, task).catch((err) => {
        log.warn(`Failed to re-export task for QMD: ${err}`);
      });
    }
  }

  return task;
}

export function deleteTask(projectId: string, taskId: string): boolean {
  const result = deleteTaskFromDb(projectId, taskId);

  if (result) {
    deleteTaskExport(projectId, taskId).catch((err) => {
      log.warn(`Failed to delete task export: ${err}`);
    });
  }

  return result;
}
```

#### QMD Manager Integration

```typescript
// In qmd-manager.ts - add "tasks" as a source kind

type MemorySource = "memory" | "custom" | "sessions" | "tasks";

// Collections config will include:
{
  name: "project-tasks",
  path: "~/.openclaw/projects/exported-tasks",
  pattern: "**/*.md",
  kind: "tasks"
}
```

### What This Enables

#### Unified Semantic Search

```typescript
// Search across memory + sessions + tasks
memory_search({ query: "authentication security login" });

// Returns (ranked by relevance):
// - MEMORY.md#auth-setup (score: 0.94) "## Auth Setup\nWe decided on JWT..."
// - task-003.md (score: 0.91) "# Implement JWT middleware"
// - session-abc123.md (score: 0.87) "Discussed auth patterns with team"
// - task-007.md (score: 0.85) "# Add rate limiting to auth endpoints"
```

#### Cross-Project Task Discovery

```typescript
// Find similar tasks across projects
memory_search({ query: "database optimization performance" });

// Returns:
// - task-012.md (ui-next) "Optimize React renders"
// - task-045.md (auth-service) "Add database connection pooling"
// - MEMORY.md#performance (score: 0.82)
```

#### Context-Aware Task Creation

```typescript
// When creating a task, check for duplicates/related work
const existing = await memory_search({
  query: `task ${newTaskTitle}`,
  minScore: 0.85,
});

if (existing.length > 0) {
  // Suggest: "Similar task exists: task-012.md"
}
```

### Benefits Summary

| Benefit                     | Example                                               |
| --------------------------- | ----------------------------------------------------- |
| **Unified search**          | One query returns memories + sessions + tasks         |
| **Semantic matching**       | "performance issue" finds "Optimize database queries" |
| **Cross-project discovery** | Find related work across all projects                 |
| **Duplicate detection**     | Warn when similar task already exists                 |
| **Context continuity**      | Past decisions inform new tasks                       |
| **No extra infrastructure** | Reuses existing QMD setup                             |

### Sync Strategy

| Event                    | Action                    |
| ------------------------ | ------------------------- |
| Task created             | Export to `.md` file      |
| Task updated             | Re-export to `.md` file   |
| Task deleted             | Remove `.md` file         |
| QMD sync (boot/interval) | Re-indexes task directory |

---

## 7. File Structure

### Backend (OpenClaw Core)

```
src/
├── projects/
│   ├── index.ts                 # Exports
│   ├── types.ts                 # TypeScript types
│   ├── registry-store.ts        # Central project registry (SQLite)
│   ├── task-store.ts            # Per-project task store (SQLite)
│   ├── task-exporter.ts         # Export tasks for QMD indexing
│   ├── session-binding.ts       # Session → Project mapping
│   ├── context-injector.ts      # Agent context injection
│   └── sync/
│       ├── github-sync.ts       # GitHub issue sync
│       └── memory-extract.ts    # Parse [ ] from memory
│
├── memory/
│   ├── qmd-manager.ts           # MODIFY: add "tasks" source kind
│   └── ...
│
├── gateway/
│   ├── server-methods/
│   │   └── projects.ts          # Gateway RPC handlers
│   └── protocol/schema/
│       └── projects.ts          # TypeBox validation schemas
│
└── cli/
    └── projects-cli.ts          # `openclaw projects` command
```

### Frontend (ui-next)

```
ui-next/src/
├── store/
│   ├── project-store.ts         # Zustand store for projects
│   └── task-store.ts            # Zustand store for tasks
│
├── hooks/
│   ├── use-projects.ts          # Project CRUD hooks
│   └── use-tasks.ts             # Task CRUD hooks
│
├── pages/
│   └── projects.tsx             # Projects page
│
└── components/
    └── projects/
        ├── projects-panel.tsx   # Project list
        ├── project-card.tsx     # Single project card
        └── task-list.tsx        # Task list component
```

### Data Store

```
~/.openclaw/
├── projects/
│   ├── registry.db              # Central SQLite registry
│   └── exported-tasks/          # Task exports for QMD
│       └── {projectId}/
│           └── task-{id}.md
│
├── agents/
│   └── main/
│       ├── agent/
│       │   ├── SOUL.md
│       │   └── MEMORY.md
│       └── qmd/
│           ├── xdg-cache/qmd/index.sqlite
│           └── sessions/
│
└── teams/
    └── teams.json

# Per-project (in workspace):
{workspace}/
└── .openclaw/
    └── tasks.db                 # Project tasks (SQLite)
```

---

## 8. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)

| Task                                 | Effort       |
| ------------------------------------ | ------------ |
| SQLite helper utilities              | 0.5 day      |
| Registry store (`registry-store.ts`) | 1 day        |
| Task store (`task-store.ts`)         | 1 day        |
| Task exporter (`task-exporter.ts`)   | 0.5 day      |
| Session binding                      | 0.5 day      |
| Gateway RPCs                         | 1 day        |
| Unit tests                           | 1 day        |
| **Total**                            | **6.5 days** |

### Phase 2: Memory Integration (Week 2)

| Task                                 | Effort       |
| ------------------------------------ | ------------ |
| Add "tasks" source kind to QMD       | 0.5 day      |
| Test unified search (memory + tasks) | 0.5 day      |
| Update QMD collection config         | 0.5 day      |
| **Total**                            | **1.5 days** |

### Phase 3: UI (Week 2-3)

| Task                | Effort     |
| ------------------- | ---------- |
| Zustand stores      | 0.5 day    |
| React hooks         | 0.5 day    |
| Projects panel      | 1 day      |
| Task list component | 0.5 day    |
| Routing             | 0.5 day    |
| **Total**           | **3 days** |

### Phase 4: Integrations (Week 3-4)

| Task                         | Effort     |
| ---------------------------- | ---------- |
| Team run → project sync      | 1 day      |
| Context injection for agents | 1 day      |
| Canvas zone integration      | 1 day      |
| **Total**                    | **3 days** |

### Phase 5: External Sync (Week 5+)

| Task                            | Effort     |
| ------------------------------- | ---------- |
| GitHub issue sync               | 2 days     |
| Memory extraction ([ ] → tasks) | 1 day      |
| CLI commands                    | 1 day      |
| **Total**                       | **4 days** |

---

## 9. Open Questions

### Decided

| Question               | Decision                                        |
| ---------------------- | ----------------------------------------------- |
| **Store backend**      | SQLite (hybrid: central registry + per-project) |
| **Memory integration** | Export tasks as `.md` for QMD indexing          |

### For Developer Review

1. **Task uniqueness** — If same task mentioned in multiple chats, dedupe or link?
   - [ ] Dedupe by title similarity
   - [ ] Create separate tasks, link via reference

2. **Completion criteria** — How to mark tasks done?
   - [ ] Manual only
   - [ ] Infer from agent output
   - [ ] Require explicit `/task done` command

3. **Workspace validation** — What if project directory doesn't exist?
   - [ ] Auto-create `.openclaw/` directory
   - [ ] Show warning, require manual creation
   - [ ] Allow workspace-less projects (planning only)

4. **Project nesting** — Support sub-projects?
   - [ ] Yes, with `parentId` field
   - [ ] No, use tags instead

5. **Permissions** — Who can see/modify which projects?
   - [ ] All projects visible to all users
   - [ ] Project-level ACLs
   - [ ] Owner-only edit, read-all

6. **Real-time updates** — How to push changes to UI?
   - [ ] Polling (5s interval)
   - [ ] WebSocket events
   - [ ] Server-sent events

7. **QMD sync timing** — When to re-index tasks?
   - [ ] Immediate on task change (may be slow)
   - [ ] On next QMD sync interval (may be stale)
   - [ ] Hybrid: immediate + debounced batch

---

## Appendix A: Quick Reference

### Create Project

```typescript
projects.create({
  name: "ui-next",
  workspacePath: "~/dev/operator1/ui-next",
  priority: "p1",
  links: { github: "https://github.com/openclaw/openclaw" },
});
```

### Create Task

```typescript
tasks.create({
  projectId: "ui-next",
  title: "Add dark mode toggle",
  assignee: "tank",
  source: "manual",
});
```

### Bind Session

```typescript
projects.bindSession({
  sessionKey: "agent:main:main",
  projectId: "ui-next",
});
```

### Spawn with Project Context

```typescript
sessions_spawn({
  task: "Implement dark mode",
  agentId: "tank",
  projectId: "ui-next", // Inherits workspace + context
});
```

### Search Tasks via Memory

```typescript
// Unified search across memory + sessions + tasks
memory_search({ query: "authentication implementation" });

// Returns ranked results from all sources
```

---

## Appendix B: Task Export Schema

### Markdown Template

```markdown
# {title}

- **Project:** {projectName}
- **Status:** {status}
- **Priority:** {priority}
- **Assignee:** {assignee}
- **Blocked by:** {blockedBy}
- **Created:** {createdAt}
- **Source:** {source}

## Description

{description}

## Context

- **Origin:** {sessionKey}
- **Source Ref:** {sourceRef}
```

### Example Output

```markdown
# Add dark mode toggle

- **Project:** ui-next
- **Status:** in_progress
- **Priority:** p1
- **Assignee:** tank
- **Blocked by:** none
- **Created:** 2026-03-02
- **Source:** manual

## Description

Implement a dark mode toggle in the settings panel.
Should persist preference to localStorage and respect
system preference by default.

## Context

- **Origin:** session agent:main:main
- **Source Ref:** none
```

---

_End of Proposal_

**Next Steps:**

1. Developers review and approve architecture
2. Prioritize phases
3. Begin Phase 1 implementation
