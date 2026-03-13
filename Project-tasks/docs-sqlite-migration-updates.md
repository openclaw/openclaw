---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Docs: SQLite Migration Updates"
description: "Update operator1 docs to reflect the completed SQLite state migration (Phases 0–8B)"
dartboard: "Operator1/Tasks"
type: Project
status: "Done"
priority: high
assignee: "rohit sharma"
tags: [docs, migration, sqlite]
startAt: "2026-03-13"
dueAt: "2026-03-15"
dart_project_id:
# ──────────────────────────────────────────────────────────────────────────────
---

# Docs: SQLite Migration Updates

**Created:** 2026-03-13
**Status:** Planning
**Depends on:** SQLite migration Phases 0–8B (all complete)

---

## 1. Overview

The SQLite consolidation migration is complete (Phases 0–8B). The operator1 docs still describe the pre-migration world (JSON files, scattered state, no project-scoped memory). These tasks update each affected doc to reflect the current architecture: unified `operator1.db`, project-scoped memory, session→project binding, and subagent inheritance.

---

## 2. Goals

- Every operator1 doc accurately reflects the post-migration architecture
- New users reading the docs get the correct mental model (SQLite-first, not JSON-first)
- No stale references to removed JSON state files

## 3. Out of Scope

- Rewriting docs from scratch — these are targeted section updates
- Upstream OpenClaw docs (only operator1-specific docs)
- UI component docs (chat.md, visualize.md) — no state-layer changes affect them
- New docs pages — only updating existing ones

---

## 4. Design Decisions

| Decision | Options Considered                  | Chosen                            | Reason                            |
| -------- | ----------------------------------- | --------------------------------- | --------------------------------- |
| Scope    | Update all 17 docs vs only affected | Only affected (11 docs)           | 6 docs have zero SQLite relevance |
| Ordering | One big PR vs per-doc commits       | Grouped by priority (must/should) | Keeps reviews focused             |

---

## 5. Technical Spec

### 5.1 What Changed (reference for all tasks)

| Component         | Before                                | After                                                                     |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| State storage     | Scattered JSON/YAML in `~/.openclaw/` | `~/.openclaw/operator1.db` (SQLite, WAL, schema v10)                      |
| Config source     | `openclaw.json` only                  | `openclaw.json` + `op1_config` table (registries, projects, agent scopes) |
| Agent scopes      | JSON in `openclaw.json`               | `agent_scopes` table                                                      |
| Projects          | Not persisted                         | `op1_projects` table (internal + external types)                          |
| Project memory    | N/A                                   | `~/.openclaw/workspace/projects/{id}/memory/` with auto-indexing          |
| Session binding   | No project association                | `project_id` column on `session_entries`, auto-bind by Telegram topic     |
| Subagent sessions | No inheritance                        | Child sessions inherit parent's `project_id`                              |
| Health checks     | Basic                                 | `openclaw doctor` checks SQLite health, schema version, WAL status        |

### 5.2 Key source files

- `src/infra/state-db/schema.ts` — table definitions, schema version
- `src/infra/state-db/state-db.ts` — DB init, WAL, migrations
- `src/config/agent-scope.ts` — agent scope read/write from SQLite
- `src/gateway/server-startup.ts` — migration runner at gateway start
- `src/commands/doctor-state-db.ts` — doctor health checks

---

## 6. Implementation Plan

### Task 1: configuration.md — Add SQLite state backend

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 1h

Update `docs/operator1/configuration.md` to document the SQLite state layer alongside `openclaw.json`. This is the highest-impact doc — it's the config reference page.

- [ ] 1.1 Add "State Database" section — document `operator1.db` location, WAL mode, schema versioning, auto-migration at startup
- [ ] 1.2 Update registries section — registries now stored in `op1_config` table, not just `$include` JSON files
- [ ] 1.3 Update agent scope section — `agent_scopes` table replaces JSON-only scope config; explain hybrid read (DB + JSON fallback)
- [ ] 1.4 Add projects config — `op1_projects` table, internal vs external project types, project binding to agents

### Task 2: memory-system.md — Project-scoped memory layer

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 1h

Update `docs/operator1/memory-system.md` to add the new project-scoped memory tier and auto-discovery.

- [ ] 2.1 Update architecture diagram — three-layer → four-layer (daily notes, MEMORY.md, project memory, QMD search)
- [ ] 2.2 Add project memory section — path convention `~/.openclaw/workspace/projects/{id}/memory/`, isolation model, never pollutes external repos
- [ ] 2.3 Update memory search — `extraPaths` auto-discovery of project memory dirs, cross-project search behavior
- [ ] 2.4 Update RPC reference — any new memory RPCs or changed parameters for project context

### Task 3: architecture.md — Unified state principle

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 30m

Update `docs/operator1/architecture.md` to add SQLite as a core architectural principle.

- [ ] 3.1 Add "Unified SQLite State" to design principles — single DB, WAL mode, 38 tables, schema migrations
- [ ] 3.2 Update integration stack — mention state-db layer between gateway and filesystem
- [ ] 3.3 Add brief data flow note — how config reads merge `openclaw.json` + `op1_config` at runtime

### Task 4: deployment.md — DB setup & doctor checks

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 30m

Update `docs/operator1/deployment.md` with DB-related setup and troubleshooting steps.

- [ ] 4.1 Update prerequisites — mention SQLite auto-creates on first gateway start, no manual DB setup needed
- [ ] 4.2 Add doctor checks — `openclaw doctor` now validates SQLite health (schema version, WAL, table integrity)
- [ ] 4.3 Update troubleshooting — common DB issues (locked DB, corrupt WAL, schema mismatch) and recovery steps

### Task 5: spawning.md — Project binding & inheritance

**Status:** Done | **Priority:** High | **Assignee:** rohit sharma | **Est:** 30m

Update `docs/operator1/spawning.md` to document project-scoped sessions and subagent inheritance.

- [ ] 5.1 Update session schema — `project_id` dedicated column on `session_entries`
- [ ] 5.2 Add project binding section — auto-bind by Telegram topic, manual bind via RPC
- [ ] 5.3 Add inheritance section — child sessions auto-inherit parent's `project_id`, system prompt injection with project context

### Task 6: index.md — Overview quick reference

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 20m

Light update to `docs/operator1/index.md` to mention the unified state layer in the system overview.

- [ ] 6.1 Update system description — mention `operator1.db` as the unified state backend
- [ ] 6.2 Update "What's Inside" or equivalent section — add state/DB to the list of core components

### Task 7: rpc.md — Project & session RPCs

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 30m

Update `docs/operator1/rpc.md` if new RPCs were added for project CRUD and session-project binding.

- [ ] 7.1 Audit new RPCs — check `server-methods/` for any project/session/scope RPCs added during migration
- [ ] 7.2 Update projects section — document any new project CRUD methods
- [ ] 7.3 Update sessions section — document `project_id` parameter in session methods

### Task 8: agent-configs.md — Project memory paths

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 20m

Update `docs/operator1/agent-configs.md` to document the project memory path convention.

- [ ] 8.1 Add project memory to workspace files — `~/.openclaw/workspace/projects/{id}/memory/` path convention
- [ ] 8.2 Clarify isolation — project memory is centralized, never created inside external repo directories

### Task 9: channels.md — Telegram topic auto-bind

**Status:** Done | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 20m

Update `docs/operator1/channels.md` Telegram section for auto-bind behavior.

- [ ] 9.1 Add topic→project binding — sessions in Telegram topics auto-bind to the matching project
- [ ] 9.2 Document binding resolution — how topic name maps to project ID

### Task 10: agent-hierarchy.md — Scope storage note

**Status:** Done | **Priority:** Low | **Assignee:** rohit sharma | **Est:** 15m

Minor update to `docs/operator1/agent-hierarchy.md` if agent scope storage is referenced.

- [ ] 10.1 Add note — agent marketplace scopes now persisted in `agent_scopes` SQLite table

---

## 7. References

- Completed migration spec: `Project-tasks/operator1-config-sqlite.md`
- Key source files:
  - `src/infra/state-db/schema.ts`
  - `src/infra/state-db/state-db.ts`
  - `src/config/agent-scope.ts`
  - `src/gateway/server-startup.ts`
  - `src/commands/doctor-state-db.ts`
- Docs directory: `docs/operator1/`
- Dart project: _(filled after first sync)_

---

_Template version: 1.0 — do not remove the frontmatter or alter heading levels_
