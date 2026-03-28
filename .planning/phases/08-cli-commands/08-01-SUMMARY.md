---
phase: 08-cli-commands
plan: 01
status: complete
duration_seconds: ~180
tasks_completed: 2
files_changed: 4
---

# Plan 08-01 Summary: Create & List Commands + Route Registration

## What was delivered

### Task 1: Create and list command implementations with tests
- `src/commands/projects.create.ts` — Interactive project creation with `@clack/prompts`, `--json`, `--parent` support
- `src/commands/projects.list.ts` — Table display with Name/Status/Tasks/Owner columns, `--json`, empty state message
- `src/commands/projects.create.test.ts` — 5 tests: create, sub-project, JSON, interactive prompts, duplicate error
- `src/commands/projects.list.test.ts` — 3 tests: table display, empty state, JSON output

### Task 2: Register all 5 project routes in routes.ts
- `src/cli/program/routes.ts` — 5 RouteSpec entries added: create, list, status, reindex, validate
- All routes use `loadPlugins: false` and dynamic imports
- Status/create routes parse positional args via `getCommandPositionalsWithRootOptions`

## Verification results

| Check | Result |
|-------|--------|
| `pnpm test -- src/commands/projects.create.test.ts src/commands/projects.list.test.ts` | 9/9 pass |
| `pnpm tsgo` (our files) | Clean |
| `pnpm build` | Pass |
| `pnpm check` (our files) | Clean |

## Deviations from plan

- Commands accept `(opts, context, runtime)` three-parameter pattern with `context: { homeDir?: string }` for testability, rather than deriving homeDir from `resolveStateDir()` directly. This matches the test expectations and is cleaner for DI.
- `writeRuntimeJson` usage: list command uses `runtime.writeJson()` directly (same effect, simpler call path).

## Requirements delivered
- CLI-01: `openclaw projects create` scaffolds project with interactive prompts
- CLI-02: `openclaw projects list` shows table with project summaries
