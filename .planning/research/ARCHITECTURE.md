# Architecture Patterns

**Domain:** File-based project management system integrated into an existing agent platform
**Researched:** 2026-03-26

## Recommended Architecture

### System Overview

```
                    Agents (write)              Humans (CLI)
                        |                           |
                        v                           v
              ~/.openclaw/projects/*/
              (Markdown source of truth)
                        |
                        v
              +-----------------------+
              | ProjectFileWatcher    |  (chokidar, runs inside gateway)
              | - debounced FS events |
              | - frontmatter parse   |
              | - .index/ JSON write  |
              +-----------------------+
                        |
              +---------+---------+
              |                   |
              v                   v
        .index/*.json       WebSocket broadcast
        (derived data)      ("projects.*" events)
              |                   |
              v                   v
        CLI reads            Lit UI components
        (projects status)    (sidebar, dashboard, kanban)
```

The architecture follows the existing codebase pattern: a gateway-hosted service that watches files, maintains derived state, and broadcasts events over the existing WebSocket protocol. This is the same pattern used by `config-reload.ts` (chokidar watcher with debounce) and `server-chat.ts` (WebSocket broadcast to connected clients).

### Component Boundaries

| Component                    | Location                                                 | Responsibility                                                                   | Communicates With                               |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | ------ | -------- | ------------------------------------------------- |
| **ProjectFileWatcher**       | `src/projects/watcher.ts`                                | Watch `~/.openclaw/projects/` for markdown changes, debounce, trigger sync       | ProjectIndexer, gateway broadcast               |
| **ProjectIndexer**           | `src/projects/indexer.ts`                                | Parse YAML frontmatter from markdown, write `.index/` JSON files                 | ProjectFileWatcher (input), filesystem (output) |
| **ProjectService**           | `src/projects/service.ts`                                | Orchestrate watcher + indexer lifecycle, expose read API for gateway methods     | Watcher, Indexer, gateway server                |
| **ProjectLock**              | `src/projects/lock.ts`                                   | File-level `.lock` acquire/release with stale timeout (60s)                      | Filesystem only                                 |
| **Gateway methods**          | `src/gateway/server-methods/projects.ts`                 | Handle `projects.*` WebSocket RPC (list, get, board, queue)                      | ProjectService, WebSocket clients               |
| **Gateway events**           | Added to `GATEWAY_EVENTS` array                          | Broadcast `projects.changed`, `projects.board.changed`, `projects.queue.changed` | WebSocket clients (UI)                          |
| **CLI commands**             | `src/cli/projects-cli.ts`                                | `openclaw projects create                                                        | list                                            | status | reindex` | ProjectService (via direct import or gateway RPC) |
| **Post-compaction hook**     | Extend `src/auto-reply/reply/post-compaction-context.ts` | Detect `PROJECT.md` in cwd, inject into agent context                            | Existing post-compaction flow                   |
| **Bootstrap hook**           | Register via `src/hooks/internal-hooks.ts`               | Inject `PROJECT.md` content when agent starts in project channel                 | Existing `agent:bootstrap` hook system          |
| **Heartbeat pickup**         | Extend heartbeat runner or add cron-style job            | Scan queue.md, match capabilities, claim tasks                                   | ProjectLock, queue.md files                     |
| **UI: ProjectsController**   | `ui/src/ui/controllers/projects.ts`                      | Manage project state, subscribe to WebSocket events, expose data to views        | Gateway WebSocket, view layer                   |
| **UI: ProjectListView**      | `ui/src/ui/views/projects-list.ts`                       | Render project list from controller state                                        | ProjectsController                              |
| **UI: ProjectDashboardView** | `ui/src/ui/views/projects-dashboard.ts`                  | Render configurable widget grid for a project                                    | ProjectsController                              |
| **UI: ProjectKanbanView**    | `ui/src/ui/views/projects-kanban.ts`                     | Render read-only kanban board with live agent indicators                         | ProjectsController                              |

### Data Flow

**Write path (Agent/CLI -> Markdown -> JSON -> UI):**

```
1. Agent writes TASK-003.md with YAML frontmatter
2. chokidar detects file change in ~/.openclaw/projects/my-project/tasks/
3. ProjectFileWatcher debounces (300ms, matching config-reload pattern)
4. ProjectIndexer reads TASK-003.md, parses frontmatter only (fast path)
5. ProjectIndexer rebuilds .index/board.json (aggregated task summaries)
6. ProjectService calls gateway broadcast("projects.board.changed", { project: "my-project" })
7. UI ProjectsController receives WebSocket event
8. Controller fetches updated board data via projects.board.get RPC
9. Lit view re-renders kanban cards
```

**Read path (UI -> Gateway -> JSON):**

```
1. User navigates to Projects tab
2. ProjectsController calls projects.list via WebSocket RPC
3. Gateway handler reads .index/project.json from each project dir
4. Returns array of project summaries
5. User clicks project -> calls projects.get + projects.board.get
6. Gateway reads .index/project.json + .index/board.json
7. Dashboard and kanban views render from JSON data
```

**Context injection path (Agent starts -> PROJECT.md injected):**

```
Path 1 (cwd-based):
1. Agent cd's into ~/.openclaw/projects/my-project/
2. Post-compaction context loader finds PROJECT.md (extends existing AGENTS.md detection)
3. PROJECT.md body (not frontmatter) injected into agent context

Path 2 (channel hook):
1. Message arrives on project-associated channel
2. agent:bootstrap hook fires
3. Hook reads PROJECT.md from associated project path
4. Injects body content as bootstrap file
```

**Task claim path (Heartbeat -> Queue -> Lock -> Claim):**

```
1. Heartbeat fires for agent
2. Agent reads own IDENTITY.md capability tags
3. Scans queue.md files for Available tasks matching capabilities
4. Attempts to acquire .lock (atomic file create, fail if exists)
5. On lock acquired: moves task from Available to Claimed in queue.md, updates task frontmatter
6. Deletes .lock
7. Reads task file, resumes from checkpoint, begins work
```

## Patterns to Follow

### Pattern 1: Chokidar Watcher with Debounce (from config-reload.ts)

**What:** Use chokidar (already a dependency at v5.x) to watch project directories. Debounce changes at 300ms (same as config reload default). Handle missing-file retries for atomic writes.

**When:** All file watching in the project system.

**Example:**

```typescript
// src/projects/watcher.ts
import chokidar from "chokidar";

export type ProjectWatcher = {
  stop: () => Promise<void>;
};

export function startProjectWatcher(opts: {
  projectsDir: string;
  onChanged: (projectId: string, changedPath: string) => void;
  debounceMs?: number;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): ProjectWatcher {
  const debounceMs = opts.debounceMs ?? 300;
  // Watch PROJECT.md, queue.md, and tasks/*.md
  const watcher = chokidar.watch(
    [
      `${opts.projectsDir}/*/PROJECT.md`,
      `${opts.projectsDir}/*/queue.md`,
      `${opts.projectsDir}/*/tasks/*.md`,
      `${opts.projectsDir}/*/sub-projects/*/PROJECT.md`,
      `${opts.projectsDir}/*/sub-projects/*/queue.md`,
      `${opts.projectsDir}/*/sub-projects/*/tasks/*.md`,
    ],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200 } },
  );
  // Debounce per project, then call onChanged
  // ...
}
```

**Rationale:** The codebase already uses this exact pattern for config reloading. `awaitWriteFinish` handles agents writing files non-atomically (writing content in chunks rather than rename-into-place).

### Pattern 2: Gateway WebSocket Methods + Events (from cron, sessions)

**What:** Register new gateway methods in `server-methods-list.ts` and add event types to `GATEWAY_EVENTS`. Follow the existing RPC pattern: client sends method name + params, gateway returns result.

**When:** All UI-to-gateway communication for project data.

**Example:**

```typescript
// New methods to add to BASE_METHODS:
"projects.list",
"projects.get",
"projects.board.get",
"projects.queue.get",
"projects.reindex",

// New events to add to GATEWAY_EVENTS:
"projects.changed",
"projects.board.changed",
"projects.queue.changed",
```

**Rationale:** The cron system (`cron.list`, `cron.status`, `cron.add`, etc.) and sessions system (`sessions.list`, `sessions.subscribe`, etc.) follow this pattern. The UI already has infrastructure to call methods and subscribe to events.

### Pattern 3: Controller + View Separation (from cron, agents)

**What:** UI follows a controller/view split. Controller (`ui/src/ui/controllers/projects.ts`) manages state, calls gateway methods, subscribes to events. View (`ui/src/ui/views/projects-*.ts`) is a pure render function receiving props.

**When:** All project UI components.

**Example:**

```typescript
// ui/src/ui/controllers/projects.ts
export class ProjectsController {
  projects: ProjectSummary[] = [];
  selectedProject: ProjectDetail | null = null;
  board: BoardData | null = null;

  constructor(private gateway: GatewayConnection) {
    gateway.on("projects.changed", () => this.refreshList());
    gateway.on("projects.board.changed", (e) => this.refreshBoard(e.project));
  }
}

// ui/src/ui/views/projects-list.ts
export function renderProjectList(props: ProjectListProps) {
  return html`...`;
}
```

**Rationale:** The cron view (`views/cron.ts`) takes a `CronProps` bag with ~40 props including data and callbacks. The cron controller (`controllers/cron.ts`) manages state. This separation keeps views testable (browser tests render with synthetic props) and controllers logic-focused.

### Pattern 4: YAML Frontmatter Parsing with `yaml` Package

**What:** Use the existing `yaml` v2.x dependency to parse YAML frontmatter blocks from markdown files. Only parse the frontmatter (between `---` markers), not the body.

**When:** Building `.index/` JSON from markdown source files.

**Example:**

```typescript
// src/projects/indexer.ts
import { parse as parseYaml } from "yaml";

export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  return { data: parseYaml(match[1]) ?? {}, body: match[2] };
}
```

**Rationale:** No need for `gray-matter` -- the `yaml` package is already in `package.json` and frontmatter extraction is a trivial regex + parse. Keeps dependency count flat.

### Pattern 5: File Lock with Stale Timeout

**What:** Use `fs.open` with `O_CREAT | O_EXCL` flags for atomic lock file creation. Include PID and timestamp in lock content for stale detection.

**When:** Queue writes (claiming tasks, releasing tasks).

**Example:**

```typescript
// src/projects/lock.ts
import fs from "node:fs";

const STALE_LOCK_MS = 60_000;

export async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Check staleness
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(lockPath);
        return acquireLock(lockPath); // Retry once
      }
      return false;
    }
    throw err;
  }
}
```

**Rationale:** `O_CREAT | O_EXCL` is atomic on local filesystems. No need for advisory locks or flock. Stale detection at 60s matches design spec.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Polling JSON from the UI

**What:** Having the UI periodically fetch `.index/` JSON on a timer instead of using WebSocket events.

**Why bad:** Burns network/CPU, introduces latency (poll interval), fights the existing event-driven architecture. The gateway already has broadcast infrastructure.

**Instead:** File watcher detects change, gateway broadcasts event, UI subscribes. Same pattern as `sessions.changed` and `chat` events.

### Anti-Pattern 2: Direct File Reads from the UI Layer

**What:** Having the UI (or gateway HTTP routes) read markdown files directly and parse them on each request.

**Why bad:** Frontmatter parsing on every request is wasteful. Markdown body content is irrelevant to UI. Couples UI to file format.

**Instead:** `.index/` JSON is the UI's data contract. Built once per file change. Fast reads of pre-parsed JSON.

### Anti-Pattern 3: Parsing Full Markdown Body in the Indexer

**What:** Running the markdown body through a markdown parser (remark, marked, etc.) during indexing.

**Why bad:** Slow, unnecessary. The body is only needed for agent context injection (which reads the raw file). The UI only needs frontmatter-derived data.

**Instead:** Parse frontmatter only (regex + YAML parse). Pass raw body through for context injection path.

### Anti-Pattern 4: Storing Project State in SQLite/Database

**What:** Adding a database layer to store project/task state.

**Why bad:** Violates the core design principle. Agents write markdown. Markdown is source of truth. Database introduces sync complexity, migration burden, and makes files non-authoritative.

**Instead:** Markdown files are the database. `.index/` JSON is a materialized view. Delete and regenerate at any time.

### Anti-Pattern 5: Making the Watcher a Separate Process

**What:** Running the project file watcher as a standalone daemon or separate service.

**Why bad:** Adds operational complexity. The gateway already runs chokidar for config reloading. Adding a second watcher in the same process is trivial and shares the event loop.

**Instead:** ProjectService starts alongside the gateway in `server.impl.ts`, just like the config reloader, cron service, and health monitor.

### Anti-Pattern 6: Coupling Task ID Generation to a Counter File

**What:** Storing a `next-id.txt` or similar counter file for task ID sequences.

**Why bad:** Creates a concurrency bottleneck and another file to keep in sync. Counter can desync from actual task files.

**Instead:** Scan `tasks/` directory, parse existing IDs, increment from max. Directory listing is fast for the expected task counts (sub-1000).

## Component Build Order

The build order is driven by data dependencies. Each layer depends on the one below it.

```
Phase 1a: Foundation (no dependencies on each other)
  ├── src/projects/types.ts          — Type definitions for project, task, queue data
  ├── src/projects/lock.ts           — File locking utility
  ├── src/projects/indexer.ts        — Frontmatter parser + JSON builder
  └── src/projects/paths.ts          — Path resolution (~/.openclaw/projects/*)

Phase 1b: Core Services (depends on 1a)
  ├── src/projects/watcher.ts        — chokidar watcher, debounce, event emission
  ├── src/projects/service.ts        — Orchestrates watcher + indexer, read API
  └── src/projects/scaffold.ts       — Create project folder structure (for CLI create)

Phase 1c: Gateway Integration (depends on 1b)
  ├── src/gateway/server-methods/projects.ts  — WebSocket RPC handlers
  ├── src/gateway/protocol/schema/projects.ts — Protocol schema for project events
  └── Integration in server.impl.ts           — Start ProjectService on gateway boot

Phase 1d: Agent Integration (depends on 1a, can parallel with 1c)
  ├── Extend post-compaction-context.ts       — PROJECT.md cwd detection
  ├── Register agent:bootstrap hook            — PROJECT.md channel injection
  └── src/projects/queue-claim.ts             — Task claim logic for heartbeat

Phase 1e: CLI Commands (depends on 1b)
  └── src/cli/projects-cli.ts                 — create, list, status, reindex

Phase 1f: UI Components (depends on 1c)
  ├── ui/src/ui/controllers/projects.ts       — State management, WS subscriptions
  ├── ui/src/ui/views/projects-list.ts        — Project list rendering
  ├── ui/src/ui/views/projects-dashboard.ts   — Dashboard with configurable widgets
  ├── ui/src/ui/views/projects-kanban.ts      — Read-only kanban board
  └── Update navigation.ts                    — Add "Projects" tab group
```

**Dependency rationale:**

- Types and utilities (1a) have zero dependencies and can be built first
- Watcher and service (1b) need types and indexer
- Gateway methods (1c) need the service to call into
- Agent integration (1d) only needs types and path resolution, so it can proceed in parallel with gateway work
- CLI (1e) needs the service for create/reindex, can read JSON for list/status
- UI (1f) depends on gateway methods being available to call

**Critical path:** 1a -> 1b -> 1c -> 1f (this is the shortest path to a visible UI)

**Parallelizable:** 1d (agent integration) and 1e (CLI) can proceed alongside 1c and 1f

## Scalability Considerations

| Concern                     | At 5 projects / 50 tasks                         | At 50 projects / 500 tasks                                           | At 500 projects / 5000 tasks                                              |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **File watching**           | Single chokidar instance, negligible             | Single chokidar instance, fine (chokidar handles thousands of paths) | May need to limit watched depth or use polling fallback                   |
| **Index rebuild**           | Rebuild full project index on any change (<10ms) | Per-project rebuild only (isolate by project directory)              | Per-file incremental update (only rebuild the changed task in board.json) |
| **WebSocket events**        | Broadcast every change                           | Broadcast per-project (UI filters by active project)                 | Add subscription model (UI subscribes to specific projects)               |
| **Gateway startup reindex** | Full reindex in <100ms                           | Full reindex in <1s                                                  | Lazy reindex (index on first access per project)                          |
| **Queue scanning**          | Scan all queue.md files                          | Scan only assigned project queues                                    | Cache parsed queue data in memory, invalidate on file change              |

**Practical ceiling:** The filesystem-based approach is well-suited for the expected usage pattern (1-20 active projects, 10-100 tasks per project). The 500+ project scenario is unlikely but manageable with the incremental strategies noted above.

## Integration Seams (Existing Code Touchpoints)

These are the specific existing files that need modification:

| File                                              | Change                                                  | Risk                                                     |
| ------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `src/gateway/server.impl.ts`                      | Start ProjectService alongside other services           | LOW -- additive, follows existing pattern                |
| `src/gateway/server-methods-list.ts`              | Add `projects.*` to `BASE_METHODS` and `GATEWAY_EVENTS` | LOW -- append-only                                       |
| `src/auto-reply/reply/post-compaction-context.ts` | Add `PROJECT.md` detection alongside `AGENTS.md`        | MEDIUM -- core agent context path, needs careful testing |
| `src/hooks/internal-hooks.ts`                     | Register project bootstrap hook                         | LOW -- additive                                          |
| `ui/src/ui/navigation.ts`                         | Add `"projects"` tab to `TAB_GROUPS`                    | LOW -- additive, existing tests verify all tabs          |
| `ui/src/ui/app-render.ts`                         | Add project view routing                                | LOW -- follows existing view routing pattern             |
| `src/infra/heartbeat-runner.ts`                   | Add task pickup to heartbeat cycle                      | MEDIUM -- heartbeat is complex, needs isolation          |

## Sources

- Existing `src/gateway/config-reload.ts` -- chokidar watcher + debounce pattern (HIGH confidence, direct code reading)
- Existing `src/gateway/server-methods-list.ts` -- gateway RPC method/event registration (HIGH confidence)
- Existing `ui/src/ui/navigation.ts` -- sidebar tab group structure (HIGH confidence)
- Existing `ui/src/ui/views/cron.ts` + `ui/src/ui/controllers/cron.ts` -- controller/view separation pattern (HIGH confidence)
- Existing `src/auto-reply/reply/post-compaction-context.ts` -- cwd-based context injection seam (HIGH confidence)
- Existing `src/agents/bootstrap-hooks.test.ts` -- `agent:bootstrap` hook API (HIGH confidence)
- Design spec at `docs/superpowers/specs/2026-03-26-project-management-design.md` (HIGH confidence, authoritative)
- `yaml` v2.x already in `package.json` dependencies (HIGH confidence)
- `chokidar` v5.x already in `package.json` dependencies (HIGH confidence)

---

_Architecture analysis: 2026-03-26_
