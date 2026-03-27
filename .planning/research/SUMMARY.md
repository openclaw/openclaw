# Research Summary: OpenClaw Project Management System

**Project:** Markdown-based project management integrated into an existing TypeScript AI assistant platform
**Synthesized:** 2026-03-26
**Research dimensions:** Stack, Features, Architecture, Pitfalls

---

## Executive Summary

The OpenClaw Project Management System adds markdown-based project management to a mature TypeScript agent platform. The research is unambiguous on the core approach: **use what already exists**. Every required library (yaml, zod, chokidar, lit, marked, ws, commander) is already in the dependency tree. Zero new dependencies are needed. The architecture follows proven patterns already in the codebase -- chokidar file watching with debounce (from config-reload.ts), gateway WebSocket RPC methods and events (from cron/sessions), controller/view separation in the Lit UI (from cron views), and YAML frontmatter parsing (from the existing markdown module). This is a feature addition, not a greenfield build.

The competitive landscape positions OpenClaw in the "developer-local, agent-first" camp alongside Taskmaster AI, GSD, backlog.md, and MDTM -- but with a unique architectural advantage: the two-layer pattern where agents write markdown (source of truth) and the UI reads auto-generated JSON (derived cache). No competitor does this exact split. The genuine differentiators are capability-based multi-agent routing (no competitor does skill matching for task assignment), live agent indicators on a kanban board (no competitor shows real-time working state), and ambient project context injection via PROJECT.md (unique to OpenClaw's architecture). These must be protected and prioritized.

The primary risks are concurrency-related: queue.md concurrent write corruption and file watcher race conditions reading partial writes. Both have well-understood mitigations (atomic mkdir-based locks, chokidar's awaitWriteFinish, debouncing). One significant spec gap was identified: **task dependencies** (`depends_on` frontmatter field) are missing from Phase 1 but are table stakes -- without them, agents cannot determine task ordering beyond priority. The most dangerous anti-features to resist are database storage (breaks the markdown promise), sprint management (human ceremony that does not map to agent workflows), and external integrations (sync complexity that distracts from core value).

---

## Key Findings

### From STACK.md

- **Zero new dependencies.** All required libraries already exist in package.json or ui/package.json: yaml, zod, chokidar, ws, commander, clack/prompts, lit, marked, dompurify.
- **Frontmatter parsing:** Extend the existing `parseFrontmatterBlock()` seam in `src/markdown/frontmatter.ts`. Create a new `src/projects/frontmatter.ts` that calls `yaml.parse()` directly (the existing function flattens to strings; projects need arrays and nested objects) then validates with Zod schemas.
- **File watching:** chokidar v5 (already in repo) with 300ms debounce, matching the config-reload.ts pattern.
- **File locking:** Simple mkdir-based atomic lock with 60s stale timeout. No external dependency needed -- lock is held <100ms during queue writes.
- **UI:** Lit functional render helpers (not class-based components), props-down state management. No third-party kanban library needed for read-only Phase 1.
- **Atomic JSON writes:** Always write-to-temp-then-rename for .index/ files to prevent partial reads.

### From FEATURES.md

- **12 table stakes features** identified; 11 already in the design spec.
- **Critical gap: task dependencies.** Must add `depends_on: [TASK-XXX]` to task frontmatter and ensure heartbeat pickup skips tasks with unfinished dependencies. This is table stakes, not a differentiator.
- **Top 3 differentiators to protect:** (1) Capability-based agent routing, (2) Live agent indicators on kanban, (3) Ambient context injection via PROJECT.md.
- **12 anti-features identified.** Strongest temptations: database/SQLite, sprint management, external integrations, drag-and-drop in Phase 1.
- **Graceful degradation** (delete .index/, regenerate from markdown) is a developer confidence feature worth marketing.

### From ARCHITECTURE.md

- **Data flow:** Agent writes markdown -> chokidar detects -> debounce -> parse frontmatter only -> write .index/ JSON -> broadcast WebSocket event -> UI re-renders.
- **7 existing files need modification** (all LOW or MEDIUM risk, all additive changes):
  - `server.impl.ts` -- start ProjectService
  - `server-methods-list.ts` -- add projects.\* methods/events
  - `post-compaction-context.ts` -- add PROJECT.md detection (MEDIUM risk, needs careful testing)
  - `internal-hooks.ts` -- register bootstrap hook
  - `navigation.ts` -- add Projects tab
  - `app-render.ts` -- add view routing
  - `heartbeat-runner.ts` -- add task pickup (MEDIUM risk, heartbeat is complex)
- **Build order critical path:** Types/utilities -> Watcher/Service -> Gateway methods -> UI views.
- **Parallelizable:** Agent integration (claiming, context injection) and CLI can proceed alongside gateway/UI work.
- **Scalability ceiling:** Filesystem approach is well-suited for 1-20 active projects, 10-100 tasks per project. 500+ project scenario is unlikely but manageable with incremental indexing.

### From PITFALLS.md

- **2 critical pitfalls:** Queue concurrent write corruption (solved by mkdir lock) and file watcher race conditions (solved by awaitWriteFinish + debounce).
- **3 high/medium pitfalls:** Frontmatter parser type mismatch (solved by separate typed parser), agent context injection regression (solved by additive-only changes + isolated tests), and .index/ JSON drift (solved by full reindex on startup + CLI command).
- **All 10 identified pitfalls are Phase 1 concerns.** None are deferred risks.
- **Lock file crash recovery:** Write PID + timestamp into lock content; stale detection at 60s; `reindex` command should also clear stale locks.
- **YAML edge cases:** Use Zod `.safeParse()` everywhere, log failures with file path, show "N files failed to parse" in UI.

---

## Cross-Cutting Themes

1. **Reuse over invention.** All four research dimensions converge on this: the codebase already has the patterns (chokidar watching, WebSocket RPC, Lit views, YAML parsing, Zod validation). The implementation is pattern-matching, not pattern-creating.

2. **Concurrency is the hard problem.** Stack, Architecture, and Pitfalls all flag the queue.md write path as the highest-risk area. The mkdir-based lock is simple but must be implemented correctly from day one -- retrofitting concurrency controls is much harder.

3. **Frontmatter is the data model.** The entire system hinges on YAML frontmatter being correctly parsed, validated, and indexed. The existing parser's string-flattening limitation must be addressed in the foundation phase, not discovered later.

4. **Read-only UI first.** Features, Architecture, and Pitfalls all support deferring write operations (drag-and-drop, inline editing) from the UI. The write path goes through agents and CLI; the UI is a read-only dashboard. This dramatically reduces Phase 1 scope and risk.

5. **Task dependencies are the missing piece.** Features research identifies this as the only significant gap in the design spec. Without `depends_on`, the system cannot answer "what should I do next?" -- which is the core agent question.

---

## Implications for Roadmap

### Suggested Phase Structure

**Phase 1: Foundation (build first, everything depends on it)**

- Zod schemas for project/task/queue frontmatter
- Typed frontmatter parser (`src/projects/frontmatter.ts`)
- File structure scaffolding (PROJECT.md, queue.md, tasks/ directory)
- .index/ JSON sync pipeline (indexer + atomic writes)
- File watcher (chokidar with debounce)
- File-level locking (mkdir-based)
- Task ID generation (scan + increment)
- Path resolution utilities
- **Delivers:** Core data layer that all other phases build on
- **Features from FEATURES.md:** File-on-disk persistence, task CRUD, task status tracking
- **Pitfalls to address:** Watcher race conditions (#1), frontmatter type mismatch (#3), YAML edge cases (#10)
- **Research needed:** No -- standard patterns, well-documented in codebase

**Phase 2: Agent Integration (can parallel with Phase 3)**

- Queue.md read-modify-write with locking
- Capability matching (agent IDENTITY.md tags vs task capabilities field)
- Heartbeat task pickup (periodic scan + claim cycle)
- Task dependencies (`depends_on` field + resolution logic in claim path)
- Context injection via cwd-based PROJECT.md detection
- Checkpoint/resume sections in task files
- **Delivers:** Agents can autonomously discover, claim, and work on tasks
- **Features from FEATURES.md:** Agent task claiming, capability-based routing, task dependencies, interruption/resume, context injection
- **Pitfalls to address:** Queue concurrent write corruption (#2), context injection regression (#6), heartbeat overload (#7), lock file crash recovery (#9)
- **Research needed:** YES -- the file-level lock concurrency model and heartbeat integration need validation under multi-agent load

**Phase 3: Gateway + CLI (can parallel with Phase 2)**

- WebSocket RPC methods (projects.list, projects.get, projects.board.get, projects.queue.get, projects.reindex)
- WebSocket event types (projects.changed, projects.board.changed, projects.queue.changed)
- ProjectService lifecycle (start/stop with gateway)
- CLI commands (create, list, status, reindex, validate)
- Full reindex on gateway startup
- **Delivers:** Data accessible to UI and humans
- **Features from FEATURES.md:** CLI interface, project list/overview
- **Pitfalls to address:** .index/ JSON drift (#4)
- **Research needed:** No -- follows existing gateway method patterns exactly (cron, sessions)

**Phase 4: UI (depends on Phase 3)**

- ProjectsController (state management, WebSocket subscriptions)
- Project list view
- Read-only kanban board view
- Basic project overview/dashboard
- Navigation tab integration
- **Delivers:** Visual proof the system works; "mission control" first impression
- **Features from FEATURES.md:** Kanban board view, project list, activity log
- **Pitfalls to address:** UI performance (#5)
- **Research needed:** No -- standard Lit component patterns from existing views

**Phase 5: Polish and Differentiators (after core is solid)**

- Live agent indicators on kanban (pulsing badges, session peek)
- Configurable dashboard widgets
- Channel hook context injection (project-scoped agent channels)
- Sub-project hierarchy (one level deep)
- Configurable kanban columns
- **Delivers:** The differentiators that make this feel like "mission control" rather than "another kanban"
- **Features from FEATURES.md:** Live agent indicators, configurable widgets, channel hook injection, sub-projects
- **Pitfalls to address:** Task ID collision in sub-projects (#8)
- **Research needed:** YES -- live agent indicators require WebSocket event design and heartbeat-to-UI plumbing that should be validated

**Phase 6: Deferred to v2+**

- Drag-and-drop kanban
- Workflow state machine
- Orchestration agent (PM agent)
- Agent-proposed tasks with approval UI
- Workflow templates
- External integrations (Jira, Linear sync)

### Phase Ordering Rationale

- **Phase 1 must come first** -- every other phase reads from the data layer it creates.
- **Phases 2 and 3 can run in parallel** -- agent integration writes markdown and reads queue files; gateway integration reads .index/ JSON. No overlap.
- **Phase 4 depends on Phase 3** -- UI needs gateway WebSocket methods to fetch data.
- **Phase 5 after Phase 4** -- polish features layer on top of working UI.
- **Critical path:** Phase 1 -> Phase 3 -> Phase 4 (shortest path to visible UI).

### Research Flags

| Phase                      | Needs `/gsd:research-phase`? | Rationale                                                                                              |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Phase 1: Foundation        | No                           | Standard patterns already in codebase                                                                  |
| Phase 2: Agent Integration | **Yes**                      | Lock concurrency under multi-agent load, heartbeat integration complexity, dependency resolution logic |
| Phase 3: Gateway + CLI     | No                           | Follows existing cron/sessions pattern exactly                                                         |
| Phase 4: UI                | No                           | Standard Lit component patterns                                                                        |
| Phase 5: Polish            | **Yes**                      | Live agent indicator WebSocket design, heartbeat-to-UI event plumbing                                  |

---

## Confidence Assessment

| Area         | Confidence      | Notes                                                                                                                                                                                                         |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack        | **HIGH**        | Every recommended library is already in the repo. Zero decisions to make. Sources are direct codebase inspection.                                                                                             |
| Features     | **MEDIUM-HIGH** | Competitive landscape well-researched (9 competitors analyzed). One spec gap identified (dependencies). Differentiators are genuine.                                                                          |
| Architecture | **HIGH**        | All patterns lifted from existing codebase (config-reload, cron, sessions). Build order driven by clear data dependencies. 7 integration seams identified with risk levels.                                   |
| Pitfalls     | **HIGH**        | 10 concrete pitfalls with specific prevention strategies. All are Phase 1 concerns with known mitigations. The two critical pitfalls (queue corruption, watcher races) have proven solutions in the codebase. |

**Overall confidence: HIGH.** This is a well-understood problem space being solved with well-understood patterns in a well-understood codebase. The primary risk is execution scope, not technical uncertainty.

### Gaps to Address During Planning

1. **Task dependency implementation details** -- How does `depends_on` interact with queue.md Available section? Does the claim logic check all transitive dependencies or just direct ones?
2. **Capability tag standardization** -- What tags exist? Who defines them? Is there a registry or are they free-form strings?
3. **Stale lock timeout calibration** -- 60 seconds is the spec default. Is that appropriate for real agent workloads where a task claim might involve reading large files?
4. **Sub-project ID disambiguation** -- UI and logs must always qualify task IDs with project path. Need a consistent format decided before Phase 5.
5. **File watcher performance ceiling** -- At what project/task count does chokidar degrade? Need benchmarks if usage exceeds 50 projects.

---

## Sources

**Stack sources:**

- yaml npm package (v2.8.x, already in repo)
- chokidar npm package (v5.x, already in repo)
- zod v4 (v4.3.6, already in repo)
- Existing codebase: `src/markdown/frontmatter.ts`, `src/gateway/config-reload.ts`, `ui/src/ui/views/overview.ts`

**Features sources:**

- [Taskmaster AI](https://github.com/eyaltoledano/claude-task-master) -- dependency-aware tasks, MCP tools
- [Linear AI Features 2026](https://www.eesel.ai/blog/linear-ai) -- AI triage, agent-as-teammate
- [GitHub Projects](https://github.com/features/issues) -- sub-issues, flexible views
- [GSD Framework](https://github.com/gsd-build/gsd-2) -- spec-driven development, fresh contexts
- [backlog.md](https://dev.to/thedavestack/transform-project-management-with-git-and-ai-backlogmd-28d0) -- git-native markdown PM
- [MDTM](https://github.com/jezweb/roo-commander/wiki/02_Core_Concepts-03_MDTM_Explained) -- TOML frontmatter task files
- [taskmd](https://medium.com/@driangle/taskmd-task-management-for-the-ai-era-92d8b476e24e) -- YAML frontmatter AI tasks

**Architecture sources:**

- Existing `src/gateway/config-reload.ts` -- watcher + debounce pattern
- Existing `src/gateway/server-methods-list.ts` -- RPC method registration
- Existing `ui/src/ui/controllers/cron.ts` + `ui/src/ui/views/cron.ts` -- controller/view pattern
- Existing `src/auto-reply/reply/post-compaction-context.ts` -- context injection seam
- Design spec: `docs/superpowers/specs/2026-03-26-project-management-design.md`

**Pitfalls sources:**

- Existing codebase patterns for all mitigations
- chokidar v5 awaitWriteFinish documentation
- POSIX filesystem atomicity guarantees (mkdir, O_CREAT|O_EXCL, rename)
