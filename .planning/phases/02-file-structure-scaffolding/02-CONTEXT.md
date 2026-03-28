# Phase 2: File Structure & Scaffolding - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Create project folders on disk at `~/.openclaw/projects/<name>/` with correct structure (PROJECT.md, queue.md, tasks/), support one-level sub-projects, and auto-generate sequential task IDs. This phase delivers the scaffolding utilities and task ID generation — not the file watcher, sync, or CLI commands (those are later phases).

</domain>

<decisions>
## Implementation Decisions

### Default Template Content

- **D-01:** Scaffolding uses interactive prompts (3 questions max): project name, short description, owner. All other fields get smart defaults.
- **D-02:** Default columns: Backlog, In Progress, Review, Done. Default dashboard widgets: task summary, recent activity.
- **D-03:** Queue.md starts with empty section headings (Available, Claimed, Done, Blocked) and frontmatter but no task entries.
- **D-04:** `tasks/` directory created empty with `.gitkeep` to ensure git tracks it.

### Task ID Format

- **D-05:** Task IDs are scoped per project/sub-project. Each has its own independent TASK-001 sequence.
- **D-06:** Always use next highest ID (scan existing files, find max, increment). Gaps from deleted tasks are fine — never reuse lower IDs.
- **D-07:** Sub-project tasks disambiguated by path when referenced cross-project (e.g., `parent/sub/TASK-001`).

### Sub-project Structure

- **D-08:** Sub-projects are fully independent with same defaults as any new project. No config inheritance from parent.
- **D-09:** Each sub-project has its own queue.md (self-contained).
- **D-10:** Sub-project discovery: filesystem scan for subdirectories containing PROJECT.md is source of truth. Parent PROJECT.md can optionally list them for ordering/display.
- **D-11:** Sub-projects created via same command with `--parent` flag: `openclaw projects create sub-name --parent parent-name`.

### Scaffolding API

- **D-12:** Code organized as a `ProjectManager` class in `src/projects/scaffold.ts`. Methods: `create(opts)`, `createSubProject(opts)`, `nextTaskId(projectDir)`. CLI layer calls this class. Stateful, can cache directory scans.
- **D-13:** Creating a project that already exists throws a clear error: "Project already exists at ~/.openclaw/projects/name".

### Claude's Discretion

- Internal file writing implementation (fs.writeFile vs streams vs temp+rename)
- Exact prompt library for interactive scaffolding (clack/prompts already in repo)
- Template string formatting approach
- Test fixture strategy for filesystem operations

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Home directory resolution

- `src/infra/home-dir.ts` — `resolveEffectiveHomeDir()` resolves `~/.openclaw/` with `OPENCLAW_HOME` env var override. All project paths must use this, not hardcoded `~`.

### Phase 1 deliverables (import from these)

- `src/projects/schemas.ts` — Zod schemas for ProjectFrontmatter, TaskFrontmatter, QueueFrontmatter
- `src/projects/types.ts` — TypeScript types, ParseResult, ParseError
- `src/projects/index.ts` — Public barrel export

### Existing patterns

- `src/wizard/setup.ts` — Existing interactive setup wizard using clack/prompts. Pattern for interactive CLI scaffolding.
- `src/cli/progress.ts` — CLI progress/spinner patterns (osc-progress + @clack/prompts)
- `src/test-utils/temp-home.ts` — Test utility for temporary home directories. Use for scaffold tests.

### Design spec

- `docs/superpowers/specs/2026-03-26-project-management-design.md` — Original design spec with file structure details

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `resolveEffectiveHomeDir()` from `src/infra/home-dir.ts` — resolves the `.openclaw/` base path
- `@clack/prompts` — already in repo, used by setup wizard for interactive prompts
- `src/test-utils/temp-home.ts` — temporary home directory for testing filesystem operations
- Phase 1 Zod schemas — validate generated frontmatter before writing

### Established Patterns

- Wizard/setup flows use `@clack/prompts` for interactive CLI (see `src/wizard/setup.ts`)
- Test utilities use temporary directories with cleanup (see `src/test-utils/tracked-temp-dirs.ts`)
- ESM imports with `.js` extensions throughout

### Integration Points

- `src/projects/index.ts` barrel — new scaffolding exports added here
- `~/.openclaw/projects/` — new directory tree created by this phase
- CLI command layer (Phase 8) will call `ProjectManager` methods

</code_context>

<specifics>
## Specific Ideas

- Interactive prompts should feel like the existing `openclaw setup` wizard — same clack/prompts style
- Sub-projects are structurally identical to top-level projects (same files, same defaults)
- `.gitkeep` in tasks/ only — not in other empty directories

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 02-file-structure-scaffolding_
_Context gathered: 2026-03-27_
