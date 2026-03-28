# Phase 8: CLI Commands - Research

## Phase Goal

Users can create, inspect, and maintain projects from the terminal without touching the web UI.

## Requirements

- CLI-01: `openclaw projects create <name>` scaffolds project folder
- CLI-02: `openclaw projects list` shows all projects with status summary
- CLI-03: `openclaw projects status <name>` shows detailed project status
- CLI-04: `openclaw projects reindex` regenerates .index/ JSON and clears stale locks
- CLI-05: `openclaw projects validate` checks frontmatter for parse errors

## CLI Architecture

### Route Registration Pattern

Commands use `RouteSpec` in `src/cli/program/routes.ts`:

```typescript
type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  run: (argv: string[]) => Promise<boolean>;
};
```

Routes are registered in the `routes` array and searched by `findRoutedCommand()`. The `match()` function checks the command path (e.g., `["projects", "create"]`). The `run()` function parses flags, dynamically imports the command handler, and returns `true` on success or `false` to fall through to Commander.

Pattern for subcommands: match on `path[0] === "projects" && path[1] === "create"` etc.

### Argument Parsing

Utilities in `src/cli/argv.ts`:
- `hasFlag(argv, "--json")` — boolean flag detection
- `getFlagValue(argv, "--name")` — single value extraction (returns `null` on parse error, `undefined` if absent)
- `getPositiveIntFlagValue(argv, "--timeout")` — integer flag parsing
- `getCommandPositionalsWithRootOptions(argv, { commandPath, booleanFlags })` — extract positional args

### Command Handler Pattern

Commands are async functions in `src/commands/`:
```typescript
export async function projectsListCommand(opts: Options, runtime: RuntimeEnv): Promise<void>
```

They use `requireValidConfig()` for config access, `writeRuntimeJson()` for JSON output, and `console.log()` for text output.

### Table Rendering

`src/terminal/table.ts` provides `renderTable()`:
```typescript
type RenderTableOptions = {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  width?: number;
  padding?: number;
  border?: "unicode" | "ascii" | "none";
};
```

### Interactive Prompts

`@clack/prompts` is already used via `src/cli/progress.ts`. Available prompt types:
- `text()` — free text input
- `select()` — single selection
- `confirm()` — yes/no

## Project Domain Modules

### ProjectManager (scaffold.ts)

```typescript
class ProjectManager {
  constructor(homeDir?: string);
  async create(opts: CreateProjectOpts): Promise<string>;      // returns projectDir path
  async createSubProject(opts: CreateSubProjectOpts): Promise<string>;
  async nextTaskId(projectDir: string): Promise<string>;
}
```

- `CreateProjectOpts`: `{ name, description?, owner? }`
- `CreateSubProjectOpts`: `{ name, parent, description?, owner? }`
- Duplicate project throws: `"Project already exists at <path>"`
- Projects root: `<homeDir>/.openclaw/projects/`

### ProjectSyncService (sync-service.ts)

```typescript
class ProjectSyncService {
  constructor(projectsRoot: string);
  async discoverProjects(): Promise<string[]>;  // returns array of project dir paths
  async start(): Promise<void>;
  async stop(): Promise<void>;
}
```

`discoverProjects()` scans the projects root for directories containing PROJECT.md.

### Index Generation (index-generator.ts)

```typescript
function generateProjectIndex(projectDir: string): Promise<ProjectIndex | null>;
function generateTaskIndex(taskFile: string): Promise<TaskIndex | null>;
function generateBoardIndex(projectDir: string): Promise<BoardIndex | null>;
function generateQueueIndex(projectDir: string): Promise<QueueIndex | null>;
function generateAllIndexes(projectDir: string): Promise<void>;
function writeIndexFile(indexDir: string, filename: string, data: unknown): Promise<void>;
```

`generateAllIndexes()` does a full regeneration of all .index/ files for a project. This is what `reindex` should call.

### Frontmatter Parsing (frontmatter.ts)

```typescript
function parseProjectFrontmatter(content: string): ParseResult<ProjectFrontmatter>;
function parseTaskFrontmatter(content: string): ParseResult<TaskFrontmatter>;
function parseQueueFrontmatter(content: string): ParseResult<QueueFrontmatter>;
```

`ParseResult` is `{ success: true, data } | { success: false, error: ParseError }`.

### Queue Manager (queue-manager.ts)

Lock-related exports:
```typescript
const QUEUE_LOCK_OPTIONS: FileLockOptions;
class QueueLockError extends Error;
```

### File Lock (plugin-sdk/file-lock.ts)

Stale lock cleanup is built into lock acquisition. Lock files older than 60s or from dead PIDs are auto-cleared. For explicit cleanup during reindex, scan for `.lock` files and remove stale ones.

### Path Resolution (config/paths.ts)

```typescript
function resolveStateDir(env?: NodeJS.ProcessEnv): string;  // returns ~/.openclaw
const STATE_DIR: string;
```

Projects root = `path.join(resolveStateDir(), "projects")`.

## Implementation Plan

### File Organization

5 commands → 5 command files + 1 barrel + route registrations:
- `src/commands/projects.create.ts` — create command
- `src/commands/projects.list.ts` — list command
- `src/commands/projects.status.ts` — status command
- `src/commands/projects.reindex.ts` — reindex command
- `src/commands/projects.validate.ts` — validate command
- `src/commands/projects.ts` — barrel re-exporting all commands
- `src/cli/program/routes.ts` — add RouteSpec entries

### Route Registration

5 RouteSpec entries for:
- `["projects", "create"]` — no plugins needed
- `["projects", "list"]` — no plugins needed
- `["projects", "status"]` — no plugins needed
- `["projects", "reindex"]` — no plugins needed
- `["projects", "validate"]` — no plugins needed

None of these commands need gateway plugins loaded.

### Command Signatures

```typescript
// create
type ProjectsCreateOptions = { name?: string; description?: string; owner?: string; parent?: string; json?: boolean };
export async function projectsCreateCommand(opts: ProjectsCreateOptions): Promise<void>;

// list
type ProjectsListOptions = { json?: boolean };
export async function projectsListCommand(opts: ProjectsListOptions): Promise<void>;

// status
type ProjectsStatusOptions = { name: string; json?: boolean };
export async function projectsStatusCommand(opts: ProjectsStatusOptions): Promise<void>;

// reindex
type ProjectsReindexOptions = { json?: boolean };
export async function projectsReindexCommand(opts: ProjectsReindexOptions): Promise<void>;

// validate
type ProjectsValidateOptions = { json?: boolean };
export async function projectsValidateCommand(opts: ProjectsValidateOptions): Promise<void>;
```

### Reindex Lock Clearing

For stale lock clearing during reindex:
1. After regenerating indexes, scan for `*.lock` files under each project dir
2. Read lock file content (PID + timestamp)
3. Check if PID is alive and if lock is younger than 60s
4. Remove stale locks
5. Report count of cleared locks

### Testing Strategy

Each command gets a colocated test file:
- `src/commands/projects.create.test.ts`
- `src/commands/projects.list.test.ts`
- `src/commands/projects.status.test.ts`
- `src/commands/projects.reindex.test.ts`
- `src/commands/projects.validate.test.ts`

Tests use temp directories with mock project structures. They test:
- Correct output format (table/JSON)
- Error cases (missing project, empty directory)
- Flag parsing
- Interactive prompt flow (mock @clack/prompts)

## Validation Architecture

### Nyquist Sampling Rate

Per-requirement verification with direct test coverage:

| Requirement | Verification Method |
|-------------|-------------------|
| CLI-01 | Test: create command produces correct directory structure |
| CLI-02 | Test: list command outputs table with project summaries |
| CLI-03 | Test: status command shows grouped sections with task counts |
| CLI-04 | Test: reindex regenerates .index/ files + clears stale locks |
| CLI-05 | Test: validate reports frontmatter parse errors with file paths |

### Cross-cutting Verification

- `--json` flag produces valid JSON for all commands
- Missing project name shows error + available projects
- Empty projects directory shows helpful message
- Exit codes: 0 on success, 1 on error
