# Roadmap: OpenClaw Project Management System

**Created:** 2026-03-26
**Granularity:** Fine
**Total phases:** 10
**Coverage:** 51/51 v1 requirements mapped (corrected from stated 49 -- actual count: DATA:8 + PARSE:4 + SYNC:7 + CONC:5 + AGNT:9 + GATE:4 + UI:9 + CLI:5)

## Phases

- [x] **Phase 1: Types & Schemas** - Zod schemas, typed frontmatter parser, data model definitions including task dependencies (completed 2026-03-26)
- [ ] **Phase 2: File Structure & Scaffolding** - Project folder creation, task ID generation, sub-project support
- [ ] **Phase 3: Sync Pipeline** - File watcher, .index/ JSON generation, atomic writes, startup reindex
- [ ] **Phase 4: Concurrency** - mkdir-based file locking for queue write safety
- [ ] **Phase 5: Context Injection** - PROJECT.md cwd pickup, bootstrap hook, capability tags
- [x] **Phase 6: Queue & Heartbeat** - Agent task claiming, checkpoint/resume, dependency resolution (completed 2026-03-27)
- [ ] **Phase 7: Gateway Service** - ProjectService lifecycle, WebSocket RPC methods, event broadcasting
- [ ] **Phase 8: CLI Commands** - create, list, status, reindex, validate commands
- [ ] **Phase 9: Project Views & Dashboard** - Sidebar tab, project list, dashboard widgets, WebSocket live updates, sub-project nav
- [ ] **Phase 10: Kanban Board & Agent Indicators** - Read-only kanban with live agent badges and session peek

## Phase Details

### Phase 1: Types & Schemas

**Goal**: All project data has typed, validated representations that downstream code can rely on
**Depends on**: Nothing (foundation)
**Requirements**: PARSE-01, PARSE-02, PARSE-03, PARSE-04, DATA-03, DATA-04, DATA-05, DATA-07, DATA-08
**Success Criteria** (what must be TRUE):

1. A PROJECT.md with valid YAML frontmatter (name, status, description, owner, tags, columns, dashboard widgets) can be parsed into a typed object and validated without error
2. A task file with valid YAML frontmatter (title, status, priority, assignee, capabilities, depends_on, created, updated) can be parsed into a typed object and validated without error
3. A queue.md with Available/Claimed/Blocked sections can be parsed into a typed object and validated without error
4. Malformed frontmatter produces a structured warning with file path and line number instead of crashing
5. The existing `parseFrontmatterBlock()` in `src/markdown/frontmatter.ts` remains unmodified
   **Plans:** 3/3 plans complete
   Plans:

- [x] 01-01-PLAN.md — Zod schemas, TypeScript types, and error types
- [x] 01-02-PLAN.md — Typed frontmatter parser (YAML extraction + Zod validation)
- [x] 01-03-PLAN.md — Queue.md section parser and public API barrel
      **Estimated complexity**: M

### Phase 2: File Structure & Scaffolding

**Goal**: Projects can be created on disk with the correct folder structure and auto-generated task IDs
**Depends on**: Phase 1
**Requirements**: DATA-01, DATA-02, DATA-06
**Success Criteria** (what must be TRUE):

1. A new project at `~/.openclaw/projects/<name>/` contains PROJECT.md, queue.md, and a tasks/ directory
2. Sub-project folders can be created one level deep under a parent project with the same internal structure
3. Creating a new task file auto-assigns a sequential ID (TASK-001, TASK-002, etc.) unique within its project
   **Plans:** 1/2 plans executed
   Plans:

- [x] 02-01-PLAN.md — Template generation and ProjectManager with create() method
- [x] 02-02-PLAN.md — Sub-project creation and sequential task ID generation
      **Estimated complexity**: S

### Phase 3: Sync Pipeline

**Goal**: Changes to project markdown files are automatically detected and reflected in .index/ JSON
**Depends on**: Phase 1
**Requirements**: SYNC-01, SYNC-02, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07
**Success Criteria** (what must be TRUE):

1. Saving a change to any markdown file under `~/.openclaw/projects/` triggers .index/ JSON regeneration within ~500ms
2. Rapidly saving multiple files in sequence produces a single batched .index/ update (debounce works)
3. Partial file writes (slow save, large file) do not produce corrupt .index/ JSON
4. Deleting the entire .index/ directory and restarting the gateway regenerates all JSON from markdown with no data loss
5. .index/ JSON files are never in a half-written state (atomic write-then-rename)
   **Plans:** 2 plans
   Plans:

- [x] 03-01-PLAN.md — Sync event types, index shape types, and pure index generation functions
- [x] 03-02-PLAN.md — ProjectSyncService with chokidar watcher, debounce, lifecycle, and barrel exports
      **Estimated complexity**: M

### Phase 4: Concurrency

**Goal**: Multiple agents can safely attempt queue.md writes without corrupting data
**Depends on**: Phase 1
**Requirements**: CONC-01, CONC-02, CONC-03, CONC-04, CONC-05
**Success Criteria** (what must be TRUE):

1. Two agents attempting to claim tasks simultaneously do not corrupt queue.md (one succeeds, one retries)
2. Lock is held for less than 100ms during the read-modify-write cycle
3. A lock file left behind by a crashed process is automatically cleared after 60 seconds
4. Lock files contain PID and timestamp readable for diagnostics
5. After a queue write, re-reading queue.md confirms the expected state persisted
   **Plans:** 2 plans
   Plans:

- [x] 04-01-PLAN.md — QueueManager class with lock-protected read-modify-write and serialization (TDD)
- [ ] 04-02-PLAN.md — Concurrent access tests and barrel exports
      **Estimated complexity**: M

### Phase 5: Context Injection

**Goal**: Agents automatically receive project context and can be matched to tasks by capability
**Depends on**: Phase 1
**Requirements**: AGNT-01, AGNT-02, AGNT-03, AGNT-04
**Success Criteria** (what must be TRUE):

1. An agent working in a directory containing PROJECT.md receives project context in its post-compaction context
2. An agent on a project-scoped channel receives PROJECT.md context via the bootstrap hook
3. Existing AGENTS.md loading continues to work exactly as before (additive change only)
4. An agent with `capabilities: [code, testing]` in its IDENTITY.md can be matched against task capability requirements
   **Plans:** 1/2 plans executed
   Plans:

- [x] 05-01-PLAN.md — Capability matcher and IDENTITY.md capabilities parsing (TDD)
- [ ] 05-02-PLAN.md — CWD-based PROJECT.md walk-up and bootstrap hook injection
      **Estimated complexity**: M

### Phase 6: Queue & Heartbeat

**Goal**: Agents autonomously discover, claim, and work on tasks with interruption resilience
**Depends on**: Phase 4, Phase 5
**Requirements**: AGNT-05, AGNT-06, AGNT-07, AGNT-08, AGNT-09
**Success Criteria** (what must be TRUE):

1. On heartbeat, an idle agent scans queue.md and claims an Available task matching its capabilities
2. An agent with an active claimed task skips queue scanning on subsequent heartbeats
3. A task with `depends_on: [TASK-003]` is not claimable until TASK-003 reaches Done status
4. After context compaction, an agent can resume work on a claimed task using checkpoint and log sections in the task file
5. Task claiming updates queue.md (moves task from Available to Claimed) with lock protection
   **Plans:** 3/3 plans complete
   Plans:

- [x] 06-01-PLAN.md — Checkpoint JSON sidecar module with CheckpointData type and CRUD functions (TDD)
- [x] 06-02-PLAN.md — HeartbeatScanner with scanAndClaimTask: queue scan, claim, resume, deps, priority (TDD)
- [x] 06-03-PLAN.md — Wire scanner into heartbeat runner, barrel exports, integration test
      **Estimated complexity**: L

### Phase 7: Gateway Service

**Goal**: Project data is accessible over WebSocket so the UI and external tools can read project state in real time
**Depends on**: Phase 2, Phase 3
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04
**Success Criteria** (what must be TRUE):

1. ProjectService starts when the gateway starts and stops when it stops
2. A WebSocket client can call `projects.list`, `projects.get`, `projects.board.get`, `projects.queue.get` and receive typed responses
3. When a project file changes on disk, connected WebSocket clients receive `projects.changed` (or `.board.changed` / `.queue.changed`) events
4. All project methods and events are registered in `server-methods-list.ts` following existing gateway patterns
   **Plans**: TBD
   **Estimated complexity**: M

### Phase 8: CLI Commands

**Goal**: Users can create, inspect, and maintain projects from the terminal without touching the web UI
**Depends on**: Phase 2, Phase 3, Phase 4
**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04, CLI-05
**Success Criteria** (what must be TRUE):

1. `openclaw projects create myproject` creates a valid project folder on disk with PROJECT.md, queue.md, and tasks/
2. `openclaw projects list` displays all projects with status summaries
3. `openclaw projects status myproject` shows task counts by status and active agent activity
4. `openclaw projects reindex` regenerates all .index/ JSON and clears stale locks
5. `openclaw projects validate` reports frontmatter parse errors across all project files
   **Plans**: TBD
   **Estimated complexity**: M

### Phase 9: Project Views & Dashboard

**Goal**: Users can browse projects, see task summaries, and monitor agent activity from the web UI sidebar
**Depends on**: Phase 7
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-08, UI-09
**Success Criteria** (what must be TRUE):

1. A "Projects" tab appears in the web UI sidebar navigation alongside existing tabs
2. The project list view shows all projects with name, status, and task count summaries
3. Each project has a dashboard view showing task summary, recent activity, and agent status widgets
4. Dashboard widget configuration in PROJECT.md frontmatter is respected, with sensible defaults when unconfigured
5. UI updates reflect file changes within seconds via WebSocket subscriptions -- no manual refresh needed
6. Sub-projects are navigable from the parent project view
   **Plans**: TBD
   **UI hint**: yes
   **Estimated complexity**: L

### Phase 10: Kanban Board & Agent Indicators

**Goal**: Users can see task status as a kanban board with live agent presence, making the system feel like a real-time mission control
**Depends on**: Phase 7, Phase 9
**Requirements**: UI-05, UI-06, UI-07
**Success Criteria** (what must be TRUE):

1. A read-only kanban board displays tasks in configurable columns populated from task frontmatter status
2. Kanban columns match the project's configured column names (or defaults: Backlog, In Progress, Review, Done)
3. Tasks claimed by an agent show a pulsing badge with the agent name
4. Hovering or clicking an agent indicator shows the current task checkpoint and recent log entries
   **Plans**: TBD
   **UI hint**: yes
   **Estimated complexity**: M

## Dependency Graph

```
Phase 1 (Types & Schemas)
  |
  +---> Phase 2 (File Structure) --+---> Phase 7 (Gateway Service) --+--> Phase 9 (Project Views) --> Phase 10 (Kanban)
  |                                |                                 |
  +---> Phase 3 (Sync Pipeline) ---+---> Phase 8 (CLI Commands)      |
  |                                |                                 |
  +---> Phase 4 (Concurrency) -----+---> Phase 6 (Queue & Heartbeat) |
  |                                |                                 |
  +---> Phase 5 (Context Injection) +                                |
```

**Parallelizable sets after Phase 1:**

- Phases 2, 3, 4, 5 can all proceed in parallel (independent concerns)
- Phase 6 needs Phases 4 + 5
- Phase 7 needs Phases 2 + 3
- Phase 8 needs Phases 2 + 3 + 4
- Phases 7 and 8 can proceed in parallel with Phase 6
- Phase 10 needs Phase 9

**Critical path to UI:** Phase 1 -> Phase 3 -> Phase 7 -> Phase 9 -> Phase 10

## Coverage

| Requirement | Phase    | Category            |
| ----------- | -------- | ------------------- |
| DATA-01     | Phase 2  | Data Model          |
| DATA-02     | Phase 2  | Data Model          |
| DATA-03     | Phase 1  | Data Model          |
| DATA-04     | Phase 1  | Data Model          |
| DATA-05     | Phase 1  | Data Model          |
| DATA-06     | Phase 2  | Data Model          |
| DATA-07     | Phase 1  | Data Model          |
| DATA-08     | Phase 1  | Data Model          |
| PARSE-01    | Phase 1  | Frontmatter Parsing |
| PARSE-02    | Phase 1  | Frontmatter Parsing |
| PARSE-03    | Phase 1  | Frontmatter Parsing |
| PARSE-04    | Phase 1  | Frontmatter Parsing |
| SYNC-01     | Phase 3  | Sync Process        |
| SYNC-02     | Phase 3  | Sync Process        |
| SYNC-03     | Phase 3  | Sync Process        |
| SYNC-04     | Phase 3  | Sync Process        |
| SYNC-05     | Phase 3  | Sync Process        |
| SYNC-06     | Phase 3  | Sync Process        |
| SYNC-07     | Phase 3  | Sync Process        |
| CONC-01     | Phase 4  | Concurrency         |
| CONC-02     | Phase 4  | Concurrency         |
| CONC-03     | Phase 4  | Concurrency         |
| CONC-04     | Phase 4  | Concurrency         |
| CONC-05     | Phase 4  | Concurrency         |
| AGNT-01     | Phase 5  | Agent Integration   |
| AGNT-02     | Phase 5  | Agent Integration   |
| AGNT-03     | Phase 5  | Agent Integration   |
| AGNT-04     | Phase 5  | Agent Integration   |
| AGNT-05     | Phase 6  | Agent Integration   |
| AGNT-06     | Phase 6  | Agent Integration   |
| AGNT-07     | Phase 6  | Agent Integration   |
| AGNT-08     | Phase 6  | Agent Integration   |
| AGNT-09     | Phase 6  | Agent Integration   |
| GATE-01     | Phase 7  | Gateway             |
| GATE-02     | Phase 7  | Gateway             |
| GATE-03     | Phase 7  | Gateway             |
| GATE-04     | Phase 7  | Gateway             |
| CLI-01      | Phase 8  | CLI                 |
| CLI-02      | Phase 8  | CLI                 |
| CLI-03      | Phase 8  | CLI                 |
| CLI-04      | Phase 8  | CLI                 |
| CLI-05      | Phase 8  | CLI                 |
| UI-01       | Phase 9  | UI                  |
| UI-02       | Phase 9  | UI                  |
| UI-03       | Phase 9  | UI                  |
| UI-04       | Phase 9  | UI                  |
| UI-05       | Phase 10 | UI                  |
| UI-06       | Phase 10 | UI                  |
| UI-07       | Phase 10 | UI                  |
| UI-08       | Phase 9  | UI                  |
| UI-09       | Phase 9  | UI                  |

**Coverage: 51/51 requirements mapped. No orphans.**

## Progress

| Phase                               | Plans Complete | Status      | Completed  |
| ----------------------------------- | -------------- | ----------- | ---------- |
| 1. Types & Schemas                  | 3/3            | Complete    | 2026-03-26 |
| 2. File Structure & Scaffolding     | 2/2            | Complete    |            |
| 3. Sync Pipeline                    | 2/2            | Complete    | -          |
| 4. Concurrency                      | 0/2            | Planned     | -          |
| 5. Context Injection                | 1/2            | In Progress |            |
| 6. Queue & Heartbeat                | 3/3 | Complete   | 2026-03-27 |
| 7. Gateway Service                  | 0/?            | Not started | -          |
| 8. CLI Commands                     | 0/?            | Not started | -          |
| 9. Project Views & Dashboard        | 0/?            | Not started | -          |
| 10. Kanban Board & Agent Indicators | 0/?            | Not started | -          |

---

_Created: 2026-03-26_
_Last updated: 2026-03-27_
