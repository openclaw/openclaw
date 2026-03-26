# Roadmap: OpenClaw Project Management System

**Created:** 2026-03-26
**Granularity:** Fine
**Total phases:** 10
**Coverage:** 49/49 v1 requirements mapped

## Phases

- [ ] **Phase 1: Types & Schemas** - Zod schemas, typed frontmatter parser, and data model definitions
- [ ] **Phase 2: File Structure & Scaffolding** - Project folder creation, task ID generation, sub-project support
- [ ] **Phase 3: Sync Pipeline** - File watcher, .index/ JSON generation, atomic writes
- [ ] **Phase 4: Concurrency** - mkdir-based file locking for queue write safety
- [ ] **Phase 5: Context Injection** - PROJECT.md pickup, bootstrap hook, capability tags
- [ ] **Phase 6: Queue & Heartbeat** - Agent task claiming, checkpoints, dependency resolution
- [ ] **Phase 7: Gateway & CLI** - WebSocket RPC methods, events, ProjectService, CLI commands
- [ ] **Phase 8: Sidebar & Project List** - Projects tab, list view, WebSocket subscriptions, sub-project navigation
- [ ] **Phase 9: Kanban Board** - Read-only kanban with live agent indicators and session peek
- [ ] **Phase 10: Dashboard & Widgets** - Configurable project dashboard with widget system

## Phase Details

### Phase 1: Types & Schemas
**Goal**: All project data has typed, validated representations that downstream code can rely on
**Depends on**: Nothing (foundation)
**Requirements**: PARSE-01, PARSE-02, PARSE-03, PARSE-04, DATA-03, DATA-04, DATA-05, DATA-08
**Success Criteria** (what must be TRUE):
  1. A PROJECT.md with valid YAML frontmatter (name, status, description, owner, tags, columns, dashboard widgets) can be parsed into a typed object and validated without error
  2. A task file with valid YAML frontmatter (title, status, priority, assignee, capabilities, depends_on, created, updated) can be parsed into a typed object and validated without error
  3. A queue.md with Available/Claimed/Blocked sections can be parsed into a typed object and validated without error
  4. Malformed frontmatter produces a structured warning with file path and line number instead of crashing
  5. The existing `parseFrontmatterBlock()` in `src/markdown/frontmatter.ts` remains unmodified
**Plans**: TBD
**Estimated complexity**: M

### Phase 2: File Structure & Scaffolding
**Goal**: Projects can be created on disk with the correct folder structure and auto-generated task IDs
**Depends on**: Phase 1
**Requirements**: DATA-01, DATA-02, DATA-06
**Success Criteria** (what must be TRUE):
  1. A new project at `~/.openclaw/projects/<name>/` contains PROJECT.md, queue.md, and a tasks/ directory
  2. Sub-project folders can be created one level deep under a parent project with the same internal structure
  3. Creating a new task file auto-assigns a sequential ID (TASK-001, TASK-002, etc.) unique within its project
**Plans**: TBD
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
**Plans**: TBD
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
**Plans**: TBD
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
**Plans**: TBD
**Estimated complexity**: M

### Phase 6: Queue & Heartbeat
**Goal**: Agents autonomously discover, claim, and work on tasks with interruption resilience
**Depends on**: Phase 4, Phase 5
**Requirements**: AGNT-05, AGNT-06, AGNT-07, AGNT-08, AGNT-09, DATA-07
**Success Criteria** (what must be TRUE):
  1. On heartbeat, an idle agent scans queue.md and claims an Available task matching its capabilities
  2. An agent with an active claimed task skips queue scanning on subsequent heartbeats
  3. A task with `depends_on: [TASK-003]` is not claimable until TASK-003 reaches Done status
  4. After context compaction, an agent can resume work on a claimed task using checkpoint and log sections in the task file
  5. Task claiming updates queue.md (moves task from Available to Claimed) with lock protection
**Plans**: TBD
**Estimated complexity**: L

### Phase 7: Gateway & CLI
**Goal**: Project data is accessible to the web UI via WebSocket and to humans via CLI commands
**Depends on**: Phase 2, Phase 3
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04, CLI-01, CLI-02, CLI-03, CLI-04, CLI-05
**Success Criteria** (what must be TRUE):
  1. ProjectService starts when the gateway starts and stops when it stops
  2. A WebSocket client can call `projects.list`, `projects.get`, `projects.board.get`, `projects.queue.get` and receive typed responses
  3. When a project file changes on disk, connected WebSocket clients receive `projects.changed` (or `.board.changed` / `.queue.changed`) events
  4. `openclaw projects create myproject` creates a valid project folder on disk
  5. `openclaw projects list` displays all projects with status summaries
  6. `openclaw projects status myproject` shows task counts and agent activity
  7. `openclaw projects reindex` regenerates all .index/ JSON and clears stale locks
  8. `openclaw projects validate` reports frontmatter parse errors across all projects
**Plans**: TBD
**Estimated complexity**: L

### Phase 8: Sidebar & Project List
**Goal**: Users can navigate to a Projects tab and browse all projects with live updates
**Depends on**: Phase 7
**Requirements**: UI-01, UI-02, UI-08, UI-09
**Success Criteria** (what must be TRUE):
  1. A "Projects" tab appears in the web UI sidebar navigation alongside existing tabs
  2. Clicking the Projects tab shows a list of all projects with name, status, and task counts
  3. When a project changes on disk, the list view updates within seconds without manual refresh
  4. Sub-projects are navigable from a parent project view
**Plans**: TBD
**UI hint**: yes
**Estimated complexity**: M

### Phase 9: Kanban Board
**Goal**: Users can see task status on a kanban board with live agent activity indicators
**Depends on**: Phase 8
**Requirements**: UI-05, UI-06, UI-07
**Success Criteria** (what must be TRUE):
  1. Selecting a project shows a read-only kanban board with columns populated from task frontmatter status
  2. Kanban columns match the project's configured column names (or defaults: Backlog, In Progress, Review, Done)
  3. Tasks claimed by an agent show a pulsing badge with the agent name
  4. Hovering or clicking an agent indicator shows the current task checkpoint and recent log entries
**Plans**: TBD
**UI hint**: yes
**Estimated complexity**: M

### Phase 10: Dashboard & Widgets
**Goal**: Each project has a configurable dashboard that surfaces the most important information at a glance
**Depends on**: Phase 8
**Requirements**: UI-03, UI-04
**Success Criteria** (what must be TRUE):
  1. Each project has a dashboard view showing task summary, recent activity, and agent status widgets
  2. Widget configuration in PROJECT.md frontmatter controls which widgets appear and their arrangement
  3. Projects without custom widget config display sensible defaults
**Plans**: TBD
**UI hint**: yes
**Estimated complexity**: M

## Dependencies

```
Phase 1 (Types & Schemas)
  |
  +---> Phase 2 (File Structure) --+
  |                                 +--> Phase 7 (Gateway & CLI) --> Phase 8 (Sidebar & List) --+--> Phase 9 (Kanban)
  +---> Phase 3 (Sync Pipeline) ---+                                                           |
  |                                                                                             +--> Phase 10 (Dashboard)
  +---> Phase 4 (Concurrency) --+
  |                             +--> Phase 6 (Queue & Heartbeat)
  +---> Phase 5 (Context Injection) -+
```

**Parallelizable sets after Phase 1:**
- Phases 2, 3, 4, 5 can all proceed in parallel (independent concerns)
- Phase 6 needs Phases 4 + 5
- Phase 7 needs Phases 2 + 3
- Phases 9 and 10 can proceed in parallel (both need Phase 8)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Types & Schemas | 0/? | Not started | - |
| 2. File Structure & Scaffolding | 0/? | Not started | - |
| 3. Sync Pipeline | 0/? | Not started | - |
| 4. Concurrency | 0/? | Not started | - |
| 5. Context Injection | 0/? | Not started | - |
| 6. Queue & Heartbeat | 0/? | Not started | - |
| 7. Gateway & CLI | 0/? | Not started | - |
| 8. Sidebar & Project List | 0/? | Not started | - |
| 9. Kanban Board | 0/? | Not started | - |
| 10. Dashboard & Widgets | 0/? | Not started | - |

---
*Created: 2026-03-26*
*Last updated: 2026-03-26*
