# Phase 8: CLI Commands - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Five CLI subcommands under `openclaw projects` for creating, listing, inspecting, reindexing, and validating projects from the terminal. Users can manage projects without the web UI. Agents can call these commands programmatically.

</domain>

<decisions>
## Implementation Decisions

### Command Output Format

- **D-01:** `projects list` uses table format via `src/terminal/table.ts`. Columns: Name, Status, Tasks, Owner.
- **D-02:** `projects status <name>` uses grouped sections: header with project name/status, then Task Counts by Status (table), Active Agents (table if any), Recent Activity.
- **D-03:** All commands support `--json` flag for machine-readable output (JSON to stdout). Table by default, JSON when flagged.

### Create Command UX

- **D-04:** `projects create` uses interactive prompts when fields not provided as flags. Prompts for: name, description, owner (3 fields per Phase 2 D-01).
- **D-05:** Interactive prompts use `@clack/prompts` (existing CLI pattern from `src/cli/progress.ts`).
- **D-06:** Sub-projects created via `--parent` flag: `openclaw projects create subname --parent parentname` (per Phase 2 D-11).
- **D-07:** After successful creation, print path + summary: "Created project at ~/.openclaw/projects/myproject" with brief scaffolding summary.

### Reindex & Validate Behavior

- **D-08:** `projects reindex` prints per-project detail as it works (project name + task count per project).
- **D-09:** `projects reindex` also clears stale locks as part of its operation (per CLI-04 requirement).
- **D-10:** `projects validate` checks frontmatter parsing only. Reports file path + error for each failure. No structural checks (orphans, broken deps) in v1.

### Error Handling

- **D-11:** Missing/nonexistent project name: print error message + list available project names as suggestions.
- **D-12:** Exit codes: 0 for success, 1 for any error. `validate` returns 1 if any parse errors found.
- **D-13:** Empty projects directory: print helpful message "No projects found. Create one with: openclaw projects create <name>".

### Claude's Discretion

- Route registration pattern (RouteSpec vs Commander)
- Command file organization (single file vs per-command files)
- Argument parsing details (positional vs flag for project name in status/validate)

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### CLI Architecture

- `src/cli/program/routes.ts` — RouteSpec registration pattern, match/run structure
- `src/cli/argv.ts` — Argument parsing utilities (hasFlag, getFlagValue, getPositiveIntFlagValue)
- `src/cli/progress.ts` — @clack/prompts spinner and progress patterns

### Project Domain

- `src/projects/scaffold.ts` — ProjectManager class with create(), createSubProject(), nextTaskId()
- `src/projects/sync-service.ts` — ProjectSyncService with discoverProjects(), index generation
- `src/projects/queue-manager.ts` — QueueManager with lock-protected queue operations
- `src/projects/frontmatter.ts` — parseProjectFrontmatter(), parseQueueFrontmatter()
- `src/projects/index.ts` — Public API barrel exports

### Output & Terminal

- `src/terminal/table.ts` — Table rendering with ANSI-safe wrapping
- `src/config/paths.ts` — resolveStateDir() for projects root path resolution

### Existing Command Examples

- `src/commands/agents.commands.list.ts` — Example of list command pattern
- `src/commands/` — General command implementation patterns

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `ProjectManager` (scaffold.ts): create(), createSubProject() — direct reuse for `projects create`
- `ProjectSyncService` (sync-service.ts): discoverProjects(), generateProjectIndex(), generateTaskIndex() — reuse for `projects list`, `status`, `reindex`
- `QueueManager` (queue-manager.ts): lock cleanup via existing withFileLock stale detection
- `src/terminal/table.ts`: Table rendering — reuse for list/status output
- `@clack/prompts`: Already used in CLI — reuse for create interactive prompts
- `src/cli/argv.ts`: hasFlag(), getFlagValue() — reuse for argument parsing

### Established Patterns

- RouteSpec pattern: `match()` predicate + `run()` handler in routes.ts
- Commands export async functions accepting typed options
- `requireValidConfig()` for config access in commands
- `writeRuntimeJson()` for JSON output mode

### Integration Points

- routes.ts: Add RouteSpec entries for `openclaw projects *` commands
- src/commands/: New command implementation files
- src/projects/index.ts: Import project domain modules

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches following existing CLI patterns.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

_Phase: 08-cli-commands_
_Context gathered: 2026-03-28_
