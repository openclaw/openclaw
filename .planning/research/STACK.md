# Technology Stack

**Project:** OpenClaw Project Management System
**Researched:** 2026-03-26

## Guiding Principle: Use What Already Exists

This project is a feature addition to an existing, mature TypeScript platform. The primary stack decision is "reuse the codebase's existing libraries" rather than introducing new dependencies. Every library below is either already in `package.json` or fills a gap that no existing dependency covers.

---

## Recommended Stack

### Core: YAML Frontmatter Parsing

| Technology | Version                  | Purpose                                                  | Why                                                                                                                                                                                                                                                             | Confidence |
| ---------- | ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `yaml`     | ^2.8.3 (already in repo) | Parse YAML frontmatter from PROJECT.md and task files    | Already used by `src/markdown/frontmatter.ts`. Supports YAML 1.2, typed output, zero deps. Do NOT add `gray-matter` -- the repo already has a custom `parseFrontmatterBlock()` that extracts and parses frontmatter using `yaml`. Extend that function instead. | HIGH       |
| `zod`      | ^4.3.6 (already in repo) | Validate parsed frontmatter against project/task schemas | Already used across the codebase for schema validation. Zod 4 is faster and slimmer. Define `ProjectFrontmatter` and `TaskFrontmatter` Zod schemas that validate the parsed YAML output.                                                                        | HIGH       |

**Existing seam:** `src/markdown/frontmatter.ts` exports `parseFrontmatterBlock()` which returns `Record<string, string>`. For the project management system, create a new `src/projects/frontmatter.ts` that:

1. Calls the existing `parseFrontmatterBlock()` for raw extraction
2. Applies Zod schemas for typed validation (arrays, nested objects like `dashboard.widgets`)
3. Returns typed `ProjectMetadata` / `TaskMetadata` interfaces

**What NOT to use:**

- `gray-matter` -- adds a dependency for something the repo already handles. Its API returns `{ data, content }` which is convenient but not worth a new dep when `parseFrontmatterBlock` + a 20-line wrapper does the same.
- `js-yaml` -- the repo uses `yaml` (eemeli/yaml), not `js-yaml`. Do not mix two YAML parsers.
- `remark` / `unified` ecosystem -- overkill for frontmatter-only parsing. The spec explicitly states "only frontmatter is parsed (fast -- no markdown body parsing)" for the sync process. The markdown body is injected verbatim into agent context, not transformed.

### Core: File Watching

| Technology | Version                  | Purpose                                            | Why                                                                                                                                                                                               | Confidence |
| ---------- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `chokidar` | ^5.0.0 (already in repo) | Watch `~/.openclaw/projects/` for markdown changes | Already used in `src/gateway/config-reload.ts`, `src/memory/manager.ts`, and other gateway code. v5 is ESM-only, requires Node 20+ (repo requires 22+, so fine). Proven pattern in this codebase. | HIGH       |

**Implementation pattern (from existing codebase):**

```typescript
import chokidar from "chokidar";

const watcher = chokidar.watch(projectsDir, {
  ignoreInitial: true,
  depth: 4, // projects/<name>/tasks/*.md and sub-projects
  ignored: [
    "**/.index/**", // ignore generated JSON
    "**/.lock", // ignore lock files
    "**/node_modules/**",
  ],
});

watcher.on("change", handleFileChange);
watcher.on("add", handleFileChange);
watcher.on("unlink", handleFileRemove);
```

**Debouncing:** Use the same debounce pattern as `src/gateway/config-reload.ts` (300ms default). Multiple rapid writes from an agent editing a task file should coalesce into a single index rebuild.

**What NOT to use:**

- `node:fs.watch` directly -- chokidar normalizes cross-platform quirks. The repo already depends on it.
- `@parcel/watcher` -- faster but adds a native dependency. chokidar is already in the dependency tree and adequate for watching ~100s of markdown files.
- Polling-based watchers -- unnecessary CPU overhead when chokidar uses native fs events.

### Core: File-Based Locking

| Technology           | Version | Purpose                                                 | Why                                                                                                                                                                                                                                                                           | Confidence |
| -------------------- | ------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `node:fs` (built-in) | N/A     | Atomic `.lock` file creation for queue write protection | Use `fs.mkdirSync(lockPath, { recursive: false })` which is atomic on all filesystems. The design spec calls for brief locks (held only during queue writes, not task execution). A simple mkdir-based lock with a 60s stale timeout is sufficient. No new dependency needed. | HIGH       |

**Implementation approach:**

```typescript
// Acquire: mkdir is atomic -- if it already exists, throws EEXIST
fs.mkdirSync(lockPath); // throws if locked

// Release: rmdir after write
fs.rmdirSync(lockPath);

// Stale detection: check mtime > 60s
const stat = fs.statSync(lockPath);
if (Date.now() - stat.mtimeMs > 60_000) {
  fs.rmdirSync(lockPath); // force-clear stale lock
}
```

**What NOT to use:**

- `proper-lockfile` -- adds 3 transitive dependencies (`graceful-fs`, `retry`, `signal-exit`) for features we do not need (network filesystem support, automatic mtime updates, compromise detection). The lock is held for <100ms during a queue write. A simple mkdir/rmdir is appropriate.
- `lockfile` (npm's package) -- deprecated patterns, relies on `open` with `O_EXCL`.
- `flock`/`fcntl` -- POSIX-only, not cross-platform.

### Core: Markdown-to-JSON Sync

| Technology         | Version     | Purpose                               | Why                                                                                                                 | Confidence |
| ------------------ | ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| `node:fs/promises` | Built-in    | Read markdown, write JSON index files | Standard Node.js filesystem API. Use async operations for the sync process since it runs in the gateway event loop. | HIGH       |
| `yaml` + `zod`     | (see above) | Parse + validate frontmatter          | Combined pipeline: read file -> extract frontmatter -> parse YAML -> validate with Zod -> write typed JSON          | HIGH       |

**Sync pipeline architecture:**

```
File change detected (chokidar)
  -> Debounce (300ms)
    -> Read changed file
      -> parseFrontmatterBlock() (existing)
        -> Zod schema validation
          -> Write .index/*.json (atomic via write-to-temp + rename)
            -> Emit WebSocket event
```

**Atomic writes:** Always write to a temp file then `rename()`. This prevents the UI from reading a half-written JSON file. Pattern: `writeFileSync(path + '.tmp', data)` then `renameSync(path + '.tmp', path)`.

### UI: Web Components

| Technology  | Version                 | Purpose                                              | Why                                                                                                                                                                                                                        | Confidence |
| ----------- | ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `lit`       | ^3.3.2 (already in UI)  | All project management UI components                 | Already the UI framework. Follow existing patterns: functional render helpers (like `renderOverview()`) rather than class-based components. The existing codebase uses `html` tagged templates with props-based rendering. | HIGH       |
| `marked`    | ^17.0.5 (already in UI) | Render markdown content in project/task detail views | Already in UI package for markdown rendering. Use for displaying PROJECT.md body content and task descriptions in the dashboard.                                                                                           | HIGH       |
| `dompurify` | ^3.3.3 (already in UI)  | Sanitize rendered markdown HTML                      | Already in UI package. Always sanitize marked output before injecting into templates.                                                                                                                                      | HIGH       |

**UI component structure (follow existing patterns):**

```
ui/src/ui/views/
  projects.ts           # Project list view (renderProjectList)
  project-dashboard.ts  # Dashboard with widget grid (renderProjectDashboard)
  project-board.ts      # Kanban board view (renderProjectBoard)
  project-widgets.ts    # Individual widget renderers
```

**State management pattern:** The existing UI uses a props-down approach -- the main `app.ts` holds state, passes it to render functions. Follow this for projects:

- Gateway sends project data via WebSocket events
- `app.ts` stores project state
- Passes to `renderProjectList()`, `renderProjectDashboard()`, `renderProjectBoard()`

**What NOT to use:**

- Third-party kanban libraries (DHTMLX, Webix, etc.) -- Phase 1 is read-only. A CSS grid/flexbox layout with Lit templates is sufficient. Adding a kanban library for a read-only board is over-engineering.
- `@lit-labs/signals` or `@lit/context` -- not used in the existing UI despite being listed as dependencies. The codebase uses plain props passing. Do not introduce a new state management pattern.
- `@create-markdown/preview` -- already in UI deps but purpose differs. Use `marked` + `dompurify` for controlled markdown rendering, matching existing chat markdown patterns.

### Core: WebSocket Events

| Technology | Version                   | Purpose                          | Why                                                                                                        | Confidence |
| ---------- | ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| `ws`       | ^8.20.0 (already in repo) | Emit project update events to UI | Already the WebSocket library. Add new event types to the existing typed event system for project updates. | HIGH       |

**New event types to add:**

```typescript
type ProjectEvent =
  | { type: "project:updated"; projectId: string; data: ProjectIndex }
  | { type: "project:board-updated"; projectId: string; data: BoardIndex }
  | { type: "project:queue-updated"; projectId: string; data: QueueIndex }
  | { type: "project:created"; projectId: string }
  | { type: "project:deleted"; projectId: string };
```

### CLI

| Technology       | Version                   | Purpose                                               | Why                                                                                                       | Confidence |
| ---------------- | ------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| `commander`      | ^14.0.3 (already in repo) | CLI argument parsing for `openclaw projects` commands | Already the CLI framework. Add a `projects` command group following existing patterns in `src/commands/`. | HIGH       |
| `@clack/prompts` | ^1.1.0 (already in repo)  | Interactive project creation prompts                  | Already used for CLI interactions. Use for `openclaw projects create` flow.                               | HIGH       |

---

## Schema Definitions

Use Zod schemas as the single source of truth for frontmatter structure:

```typescript
// src/projects/schemas.ts
import { z } from "zod";

export const ProjectFrontmatterSchema = z.object({
  name: z.string(),
  status: z.enum(["active", "paused", "complete"]),
  created: z.string(),
  updated: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  dashboard: z
    .object({
      widgets: z
        .array(z.string())
        .default([
          "project-status",
          "task-counts",
          "active-agents",
          "sub-project-status",
          "recent-activity",
          "blockers",
        ]),
    })
    .default({ widgets: [] }),
  columns: z.array(z.string()).default(["Backlog", "In Progress", "Review", "Done"]),
});

export const TaskFrontmatterSchema = z.object({
  id: z.string().regex(/^TASK-\d+$/),
  title: z.string(),
  status: z.enum(["backlog", "in-progress", "review", "done", "blocked"]),
  column: z.string(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  capabilities: z.array(z.string()).default([]),
  claimed_by: z.string().nullable().default(null),
  claimed_at: z.string().nullable().default(null),
  created: z.string(),
  updated: z.string(),
  parent: z.string().nullable().default(null),
});
```

---

## File Organization

New source files within existing structure:

```
src/projects/
  index.ts              # Public API barrel
  schemas.ts            # Zod schemas for frontmatter
  frontmatter.ts        # Typed frontmatter parsing (extends existing parser)
  sync.ts               # Markdown-to-JSON sync pipeline
  watcher.ts            # Chokidar file watcher setup
  lock.ts               # File-level locking for queue writes
  types.ts              # TypeScript interfaces for project/task/queue data
  cli.ts                # CLI command implementations

src/projects/index/
  project-indexer.ts    # PROJECT.md -> project.json
  board-indexer.ts      # tasks/*.md -> board.json
  queue-indexer.ts      # queue.md -> queue.json

src/gateway/
  project-events.ts     # WebSocket event emission for project changes

ui/src/ui/views/
  projects.ts           # Project list
  project-dashboard.ts  # Dashboard view
  project-board.ts      # Kanban board
  project-widgets.ts    # Widget renderers
```

---

## Alternatives Considered

| Category                | Recommended                      | Alternative                                              | Why Not                                                                                                                                         |
| ----------------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML parsing            | `yaml` (already in repo)         | `gray-matter`, `js-yaml`                                 | Adding a dep for functionality that already exists. `gray-matter` wraps `js-yaml` anyway.                                                       |
| Schema validation       | `zod` (already in repo)          | `@sinclair/typebox` (also in repo), `ajv` (also in repo) | Zod is the dominant pattern in extensions and newer code. TypeBox is used for JSON schema generation, not runtime validation of parsed data.    |
| File watching           | `chokidar` (already in repo)     | `@parcel/watcher`, `node:fs.watch`                       | chokidar already in deps, proven in this codebase, cross-platform.                                                                              |
| File locking            | `node:fs` mkdir                  | `proper-lockfile`                                        | Lock held for <100ms; no need for network FS support or stale detection daemon. Simple is better.                                               |
| UI framework            | `lit` (already in repo)          | React, Svelte                                            | Not a choice -- Lit is the existing framework.                                                                                                  |
| Kanban UI               | Custom Lit templates             | DHTMLX Kanban, Webix                                     | Phase 1 is read-only. CSS grid + Lit templates sufficient. Evaluate third-party libs only if Phase 2 drag-and-drop proves too complex to build. |
| Markdown rendering (UI) | `marked` (already in UI)         | `markdown-it` (in core)                                  | `marked` is already in the UI package. `markdown-it` is used server-side in core. Keep the boundary clean.                                      |
| State management (UI)   | Props passing (existing pattern) | Lit signals, Lit context, Redux                          | Existing UI uses props-down. Do not introduce new patterns for a feature addition.                                                              |
| Sync trigger            | chokidar file events             | Polling, SQLite triggers                                 | File events are near-real-time with low CPU. The design spec explicitly calls for watcher-based sync.                                           |

---

## Installation

**No new dependencies required.** All recommended libraries are already in the repo's `package.json` or `ui/package.json`:

- `yaml` ^2.8.3 -- in root `package.json`
- `zod` ^4.3.6 -- in root `package.json`
- `chokidar` ^5.0.0 -- in root `package.json`
- `ws` ^8.20.0 -- in root `package.json`
- `commander` ^14.0.3 -- in root `package.json`
- `@clack/prompts` ^1.1.0 -- in root `package.json`
- `lit` ^3.3.2 -- in `ui/package.json`
- `marked` ^17.0.5 -- in `ui/package.json`
- `dompurify` ^3.3.3 -- in `ui/package.json`

This is deliberate. The design avoids external dependencies to keep the feature addition lightweight and maintainable.

---

## Key Technical Notes

1. **Frontmatter parser limitation:** The existing `parseFrontmatterBlock()` returns `Record<string, string>` -- it flattens everything to strings. For project management, we need arrays (`tags`, `columns`, `capabilities`) and nested objects (`dashboard.widgets`). The new `src/projects/frontmatter.ts` should use `yaml.parse()` directly on the extracted block (reusing the extraction logic) to get properly typed output, then validate with Zod.

2. **Atomic JSON writes:** The `.index/` JSON files are read by the UI via the gateway's HTTP/WS layer. Use temp-file-then-rename to prevent partial reads. This is especially important because the UI may request data at any time.

3. **Watcher lifecycle:** The project file watcher should start when the gateway starts and stop when it stops. Integrate into the existing gateway lifecycle in `src/gateway/`. Do not create a separate process.

4. **UI rendering pattern:** The existing codebase uses functional render helpers (`renderOverview()`, `renderSessions()`) that return `lit.html` templates. These are called from `app-render.ts`. Follow this pattern -- do not create class-based `LitElement` components unless the existing codebase does so for similar views.

5. **No database:** The design spec explicitly excludes SQLite/database for project state. Markdown is the source of truth, `.index/` JSON is the read cache. This is intentional for agent accessibility -- agents can read/write markdown with standard file operations.

---

## Sources

- [yaml npm package](https://www.npmjs.com/package/yaml) -- v2.8.2 latest, repo uses ^2.8.3
- [chokidar npm package](https://www.npmjs.com/package/chokidar) -- v5.0.0, ESM-only, Node 20+
- [zod release notes](https://zod.dev/v4) -- Zod 4 stable, v4.3.6
- [proper-lockfile npm](https://www.npmjs.com/package/proper-lockfile) -- considered and rejected
- [chokidar GitHub](https://github.com/paulmillr/chokidar) -- v5 release notes
- Existing codebase: `src/markdown/frontmatter.ts`, `src/gateway/config-reload.ts`, `ui/src/ui/views/overview.ts`, `ui/package.json`, `package.json`
