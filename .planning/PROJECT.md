# OpenClaw Project Management System

## What This Is

A local, markdown-based project management system for OpenClaw that enables humans and agents to create, track, and collaborate on projects through structured files on disk. Projects live in `~/.openclaw/projects/`, are readable/writable by any agent, and are surfaced through a new Projects tab in the web UI. This is a feature addition to an existing, mature TypeScript platform (OpenClaw) — not a standalone product.

## Core Value

Agents and humans can seamlessly track, claim, and execute project work through structured markdown files that survive context compaction and agent interruptions.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ OpenClaw gateway with WebSocket protocol — existing
- ✓ Lit-based web UI with sidebar navigation — existing
- ✓ Agent system with SOUL.md, AGENTS.md, IDENTITY.md bootstrap files — existing
- ✓ Post-compaction context system reads from cwd (AGENTS.md) — existing
- ✓ agent:bootstrap hook system for per-session file injection — existing
- ✓ Heartbeat system for periodic agent tasks — existing
- ✓ Plugin/extension architecture with SDK contracts — existing

### Active

<!-- Current scope. Building toward these. -->

- [ ] Project folder structure at `~/.openclaw/projects/` with PROJECT.md, queue.md, tasks/
- [ ] Sub-project support (one level deep)
- [ ] YAML frontmatter on PROJECT.md and task files for structured metadata
- [ ] Auto-generated `.index/` JSON from markdown via file watcher sync process
- [x] PROJECT.md context injection via cwd-based pickup (extend post-compaction loader)
- [x] PROJECT.md context injection via channel hook (agent:bootstrap hook)
- [x] Capability tags in agent IDENTITY.md for work routing
- [x] Heartbeat task pickup — agents scan queue.md, match capabilities, claim work
- [x] File-level .lock for concurrent queue write prevention
- [ ] Kanban board state in task frontmatter (configurable columns with defaults)
- [ ] Task files with checkpoint and log sections for interruption/resume
- [ ] WebSocket events from file watcher for near-real-time UI updates
- [ ] Sidebar "Projects" tab in web UI
- [ ] Project list view (reads .index/project.json per project)
- [ ] Project dashboard with configurable widgets per project
- [ ] Read-only kanban board with live agent indicators and session peek
- [ ] CLI: `openclaw projects create`, `list`, `status`, `reindex`

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Drag-and-drop kanban — Phase 2, after read-only board proves the data model
- Workflow state machine engine — Phase 2, builds on Phase 1 task/queue foundation
- Orchestration agent creating workflows — Phase 2, needs workflow engine first
- Project manager agent stale detection loop — Phase 2, needs agent-to-agent messaging
- Workflow templates — Phase 2, needs workflow engine
- Agent-proposed tasks — Phase 2, needs approval UI
- Sub-sub-projects — keeps structure flat and navigable; one level is sufficient
- Database/SQLite for project state — markdown is the source of truth for agent accessibility

## Context

**Existing codebase:** OpenClaw is a mature TypeScript (ESM) platform with:

- **UI:** Lit 3.x web components, Vite 8.x build, sidebar with tab groups (Chat, Control, Agent, Settings)
- **Navigation:** `ui/src/ui/navigation.ts` defines sidebar tabs and routing
- **Gateway:** WebSocket server at `127.0.0.1:18789`, typed event system
- **Agents:** Bootstrap files (SOUL.md, AGENTS.md, USER.md, IDENTITY.md, TOOLS.md) loaded from `~/.openclaw/workspace/`
- **Context injection:** `src/auto-reply/reply/post-compaction-context.ts` reads AGENTS.md from `process.cwd()` — this is the seam for PROJECT.md pickup
- **Hooks:** `src/agents/bootstrap-hooks.ts` — `agent:bootstrap` hook allows per-session file injection
- **Config:** `~/.openclaw/openclaw.json`, state dir at `~/.openclaw/`
- **File watching:** No existing project file watcher, but gateway has WebSocket event emission infrastructure

**Design spec:** Full design at `docs/superpowers/specs/2026-03-26-project-management-design.md`

**Architecture pattern:** Markdown + Auto-Generated JSON. Agents write markdown (single source of truth). UI reads auto-generated JSON from `.index/`. If JSON corrupts, delete `.index/` and regenerate.

## Constraints

- **Tech stack**: TypeScript (ESM), Lit 3.x for UI, must follow existing patterns (Oxlint, Oxfmt, Vitest)
- **Runtime**: Node 22+, keep Bun paths working
- **Compatibility**: Must not break existing agent bootstrap flow — extend, don't replace
- **File size**: Keep files under ~700 LOC per CLAUDE.md guidelines
- **Testing**: Vitest with V8 coverage, colocated `*.test.ts` files, forks pool only
- **Plugin boundaries**: New code lives in core (`src/`) and UI (`ui/`), not as an extension — this is a platform feature

## Key Decisions

| Decision                                       | Rationale                                                                       | Outcome   |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| Markdown + auto-generated JSON                 | Agents write markdown natively; UI reads JSON for speed; single source of truth | — Pending |
| Projects at `~/.openclaw/projects/`            | Central location alongside existing config; not per-repo                        | — Pending |
| PROJECT.md (not AGENTS.md) for project context | Avoids collision with industry-standard AGENTS.md in repos; unambiguous         | — Pending |
| Capability tags over agent name matching       | More flexible; agents can fulfill multiple roles                                | Phase 5  |
| File-level .lock for queue writes              | Simple concurrency without database; lock held only during brief write          | — Pending |
| Configurable columns with defaults             | Projects have different needs; Backlog/In Progress/Review/Done as default       | — Pending |
| Configurable dashboard widgets                 | No one-size-fits-all; good defaults with per-project override                   | — Pending |
| Read-only kanban in Phase 1                    | Prove data model before adding interaction complexity                           | — Pending |
| PM agent investigates stale tasks (Phase 2)    | Prevents false positives from timer-based detection; tries revival first        | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-03-27 after Phase 6 (Queue & Heartbeat) completion_
