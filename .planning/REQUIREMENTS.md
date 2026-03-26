# Requirements: OpenClaw Project Management System

**Defined:** 2026-03-26
**Core Value:** Agents and humans can seamlessly track, claim, and execute project work through structured markdown files that survive context compaction and agent interruptions.

## v1 Requirements

Requirements for Phase 1 release. Each maps to roadmap phases.

### Data Model

- [ ] **DATA-01**: Project folder structure exists at `~/.openclaw/projects/<name>/` with PROJECT.md, queue.md, and tasks/ directory
- [ ] **DATA-02**: Sub-project folders supported one level deep under a parent project
- [ ] **DATA-03**: PROJECT.md contains YAML frontmatter with name, status, description, owner, tags, columns, dashboard widgets
- [ ] **DATA-04**: Task files in `tasks/TASK-NNN.md` contain YAML frontmatter with title, status, priority, assignee, capabilities, depends_on, created, updated
- [ ] **DATA-05**: Queue.md contains sections (Available, Claimed, Blocked) with task references and metadata
- [ ] **DATA-06**: Task IDs are auto-generated sequential integers per project (TASK-001, TASK-002, etc.)
- [ ] **DATA-07**: Task frontmatter supports `depends_on` field referencing other task IDs
- [ ] **DATA-08**: Kanban column names are configurable per project via PROJECT.md frontmatter with defaults (Backlog, In Progress, Review, Done)

### Frontmatter Parsing

- [ ] **PARSE-01**: Typed frontmatter parser at `src/projects/frontmatter.ts` returns arrays, nested objects, and typed values (not flat strings)
- [ ] **PARSE-02**: Zod schemas validate PROJECT.md, task file, and queue.md frontmatter
- [ ] **PARSE-03**: Parse failures use `.safeParse()` — skip corrupt files, log warning with file path and line number
- [ ] **PARSE-04**: Existing `parseFrontmatterBlock()` in `src/markdown/frontmatter.ts` is not modified

### Sync Process

- [ ] **SYNC-01**: File watcher (chokidar) monitors `~/.openclaw/projects/` for changes to markdown files
- [ ] **SYNC-02**: Watcher uses `awaitWriteFinish` with stabilityThreshold to prevent reading partial writes
- [ ] **SYNC-03**: Watcher callbacks are debounced (300ms) to batch rapid changes
- [ ] **SYNC-04**: On file change, frontmatter is parsed and `.index/` JSON files are regenerated
- [ ] **SYNC-05**: `.index/` JSON is written atomically (write to temp file, then rename)
- [ ] **SYNC-06**: Full `.index/` regeneration runs on gateway startup to catch any drift
- [ ] **SYNC-07**: `.index/` directory is always deletable and fully regeneratable from markdown

### Concurrency

- [ ] **CONC-01**: File-level `.lock` via `mkdir` (atomic on POSIX) prevents concurrent queue.md writes
- [ ] **CONC-02**: Lock is held only during queue read-modify-write cycle (<100ms)
- [ ] **CONC-03**: Lock file contains PID and timestamp for diagnostics
- [ ] **CONC-04**: Stale locks older than 60 seconds are force-cleared
- [ ] **CONC-05**: Validate after write: re-read queue.md to confirm claim persisted

### Agent Integration

- [ ] **AGNT-01**: Agents detect PROJECT.md via cwd-based pickup in post-compaction context (extending existing AGENTS.md flow)
- [ ] **AGNT-02**: Agents receive PROJECT.md context via `agent:bootstrap` channel hook for project-scoped channels
- [ ] **AGNT-03**: Context injection is additive — existing AGENTS.md loading is not modified
- [ ] **AGNT-04**: Capability tags in agent IDENTITY.md (e.g., `capabilities: [code, git, testing, ui]`) are used for task matching
- [ ] **AGNT-05**: On heartbeat, agents scan queue.md of assigned projects for Available tasks matching their capabilities
- [ ] **AGNT-06**: Agents claim tasks by updating queue.md (moving from Available to Claimed) with lock protection
- [ ] **AGNT-07**: Task files include checkpoint and log sections for interruption/resume across context compactions
- [ ] **AGNT-08**: Agent with an active claimed task skips queue scanning on heartbeat (short-circuit)
- [ ] **AGNT-09**: Task dependencies are checked during claim — tasks with unfinished `depends_on` are skipped

### Gateway

- [ ] **GATE-01**: ProjectService starts/stops with gateway lifecycle
- [ ] **GATE-02**: WebSocket RPC methods: `projects.list`, `projects.get`, `projects.board.get`, `projects.queue.get`
- [ ] **GATE-03**: WebSocket events: `projects.changed`, `projects.board.changed`, `projects.queue.changed`
- [ ] **GATE-04**: Gateway methods registered in `server-methods-list.ts` following existing patterns

### UI

- [ ] **UI-01**: "Projects" tab appears in web UI sidebar navigation
- [ ] **UI-02**: Project list view shows all projects with name, status, task counts from `.index/project.json`
- [ ] **UI-03**: Project dashboard with configurable widgets (task summary, recent activity, agent status)
- [ ] **UI-04**: Dashboard widgets are configurable per project via PROJECT.md frontmatter with sensible defaults
- [ ] **UI-05**: Read-only kanban board with configurable columns populated from task frontmatter status
- [ ] **UI-06**: Kanban board shows live agent indicators (pulsing badge, agent name) on claimed tasks
- [ ] **UI-07**: Agent session peek on hover/click shows current task checkpoint and recent log entries
- [ ] **UI-08**: UI updates near-real-time via WebSocket event subscriptions
- [ ] **UI-09**: Sub-project navigation from parent project view

### CLI

- [ ] **CLI-01**: `openclaw projects create <name>` scaffolds project folder with PROJECT.md, queue.md, tasks/
- [ ] **CLI-02**: `openclaw projects list` shows all projects with status summary
- [ ] **CLI-03**: `openclaw projects status <name>` shows detailed project status including task counts and agent activity
- [ ] **CLI-04**: `openclaw projects reindex` regenerates all `.index/` JSON files and clears stale locks
- [ ] **CLI-05**: `openclaw projects validate` checks all frontmatter for parse errors

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Workflow Engine

- **WF-01**: Workflow state machine engine for multi-step task sequences
- **WF-02**: Workflow templates for common patterns (feature, bugfix, release)
- **WF-03**: Orchestration agent creating and managing workflows

### Advanced UI

- **AUI-01**: Drag-and-drop kanban board for manual task reordering
- **AUI-02**: Inline task editing from kanban cards
- **AUI-03**: Task creation form in UI

### PM Agent

- **PMA-01**: PM agent detects stale tasks via heartbeat monitoring
- **PMA-02**: PM agent checks agent session liveness before reassigning
- **PMA-03**: PM agent messages agent to revive before reclaiming task
- **PMA-04**: PM agent clears stale locks on heartbeat

### Agent Collaboration

- **COLLAB-01**: Agent-proposed tasks with human approval UI
- **COLLAB-02**: Agent-to-agent messaging for task handoff
- **COLLAB-03**: Sub-sub-project support (deeper nesting)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Database/SQLite for project state | Markdown is source of truth for agent accessibility; database breaks the core promise |
| Sprint management | Human ceremony concept that doesn't map to agent workflows |
| External integrations (Jira, Linear sync) | Sync complexity distracts from core value; revisit only if proven demand |
| Real-time collaborative editing | Projects are single-writer (one agent or human at a time per file) |
| Time tracking / estimates | Not relevant to agent-driven development |
| Drag-and-drop kanban (Phase 1) | Prove data model with read-only board before adding interaction complexity |
| Sub-sub-projects | One level of nesting is sufficient; keeps structure flat and navigable |
| Custom task statuses beyond columns | Configurable columns already handle this; free-form statuses add complexity without value |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | TBD | Pending |
| DATA-02 | TBD | Pending |
| DATA-03 | TBD | Pending |
| DATA-04 | TBD | Pending |
| DATA-05 | TBD | Pending |
| DATA-06 | TBD | Pending |
| DATA-07 | TBD | Pending |
| DATA-08 | TBD | Pending |
| PARSE-01 | TBD | Pending |
| PARSE-02 | TBD | Pending |
| PARSE-03 | TBD | Pending |
| PARSE-04 | TBD | Pending |
| SYNC-01 | TBD | Pending |
| SYNC-02 | TBD | Pending |
| SYNC-03 | TBD | Pending |
| SYNC-04 | TBD | Pending |
| SYNC-05 | TBD | Pending |
| SYNC-06 | TBD | Pending |
| SYNC-07 | TBD | Pending |
| CONC-01 | TBD | Pending |
| CONC-02 | TBD | Pending |
| CONC-03 | TBD | Pending |
| CONC-04 | TBD | Pending |
| CONC-05 | TBD | Pending |
| AGNT-01 | TBD | Pending |
| AGNT-02 | TBD | Pending |
| AGNT-03 | TBD | Pending |
| AGNT-04 | TBD | Pending |
| AGNT-05 | TBD | Pending |
| AGNT-06 | TBD | Pending |
| AGNT-07 | TBD | Pending |
| AGNT-08 | TBD | Pending |
| AGNT-09 | TBD | Pending |
| GATE-01 | TBD | Pending |
| GATE-02 | TBD | Pending |
| GATE-03 | TBD | Pending |
| GATE-04 | TBD | Pending |
| UI-01 | TBD | Pending |
| UI-02 | TBD | Pending |
| UI-03 | TBD | Pending |
| UI-04 | TBD | Pending |
| UI-05 | TBD | Pending |
| UI-06 | TBD | Pending |
| UI-07 | TBD | Pending |
| UI-08 | TBD | Pending |
| UI-09 | TBD | Pending |
| CLI-01 | TBD | Pending |
| CLI-02 | TBD | Pending |
| CLI-03 | TBD | Pending |
| CLI-04 | TBD | Pending |
| CLI-05 | TBD | Pending |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 0 (TBD — populated during roadmap creation)
- Unmapped: 49

---
*Requirements defined: 2026-03-26*
*Last updated: 2026-03-26 after initial definition*
