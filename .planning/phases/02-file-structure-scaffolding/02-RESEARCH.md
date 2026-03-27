# Phase 2: File Structure & Scaffolding - Research

**Researched:** 2026-03-27
**Domain:** Filesystem scaffolding, YAML template generation, sequential ID generation
**Confidence:** HIGH

## Summary

Phase 2 creates the on-disk scaffolding layer: a `ProjectManager` class in `src/projects/scaffold.ts` that creates project directories at `~/.openclaw/projects/<name>/` with PROJECT.md, queue.md, and `tasks/` (with `.gitkeep`), supports one-level-deep sub-projects under `sub-projects/`, and generates sequential task IDs by scanning existing task files. This is a straightforward filesystem phase with zero new dependencies -- `yaml` (v2.8.x for stringify), `zod` (v4.3.x for schema defaults), and `@clack/prompts` (v1.1.x for interactive scaffolding) are all already in the repo.

The primary technical decisions are locked by CONTEXT.md: `ProjectManager` class API, interactive prompts (3 max), empty queue sections, scan-for-max-ID approach, independent sub-projects, `--parent` flag, and error-on-existing. Research focused on verifying existing patterns (home-dir resolution, temp-home testing, wizard prompts), confirming the YAML stringify output format, and identifying edge cases in ID generation and directory structure.

**Primary recommendation:** Use `YAML.stringify()` to generate frontmatter from Zod schema defaults (roundtrip-safe), `resolveRequiredHomeDir()` for path resolution, `createTempHomeEnv()` for test fixtures, and the existing `WizardPrompter` abstraction for interactive prompts.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Scaffolding uses interactive prompts (3 questions max): project name, short description, owner. All other fields get smart defaults.
- **D-02:** Default columns: Backlog, In Progress, Review, Done. Default dashboard widgets: task summary, recent activity.
- **D-03:** Queue.md starts with empty section headings (Available, Claimed, Done, Blocked) and frontmatter but no task entries.
- **D-04:** `tasks/` directory created empty with `.gitkeep` to ensure git tracks it.
- **D-05:** Task IDs are scoped per project/sub-project. Each has its own independent TASK-001 sequence.
- **D-06:** Always use next highest ID (scan existing files, find max, increment). Gaps from deleted tasks are fine -- never reuse lower IDs.
- **D-07:** Sub-project tasks disambiguated by path when referenced cross-project (e.g., `parent/sub/TASK-001`).
- **D-08:** Sub-projects are fully independent with same defaults as any new project. No config inheritance from parent.
- **D-09:** Each sub-project has its own queue.md (self-contained).
- **D-10:** Sub-project discovery: filesystem scan for subdirectories containing PROJECT.md is source of truth. Parent PROJECT.md can optionally list them for ordering/display.
- **D-11:** Sub-projects created via same command with `--parent` flag: `openclaw projects create sub-name --parent parent-name`.
- **D-12:** Code organized as a `ProjectManager` class in `src/projects/scaffold.ts`. Methods: `create(opts)`, `createSubProject(opts)`, `nextTaskId(projectDir)`. CLI layer calls this class. Stateful, can cache directory scans.
- **D-13:** Creating a project that already exists throws a clear error: "Project already exists at ~/.openclaw/projects/name".

### Claude's Discretion

- Internal file writing implementation (fs.writeFile vs streams vs temp+rename)
- Exact prompt library for interactive scaffolding (clack/prompts already in repo)
- Template string formatting approach
- Test fixture strategy for filesystem operations

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                                                                       | Research Support                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DATA-01 | Project folder structure exists at `~/.openclaw/projects/<name>/` with PROJECT.md, queue.md, and tasks/ directory | `ProjectManager.create()` uses `resolveRequiredHomeDir()` + `fs.mkdir({recursive: true})` to scaffold; templates generated from Zod schema defaults via `YAML.stringify()` |
| DATA-02 | Sub-project folders supported one level deep under a parent project                                               | `ProjectManager.createSubProject()` creates under `<parent>/sub-projects/<name>/` per design spec; same internal structure                                                 |
| DATA-06 | Task IDs are auto-generated sequential integers per project (TASK-001, TASK-002, etc.)                            | `ProjectManager.nextTaskId()` scans `tasks/TASK-*.md` with `fs.readdir()`, extracts numeric suffix via regex, returns max+1 padded to 3 digits                             |

</phase_requirements>

## Standard Stack

### Core

| Library          | Version  | Purpose                                     | Why Standard                                            |
| ---------------- | -------- | ------------------------------------------- | ------------------------------------------------------- |
| yaml             | ^2.8.3   | YAML.stringify() for frontmatter generation | Already in repo; roundtrip-safe with parsed frontmatter |
| zod              | ^4.3.6   | Schema defaults for template generation     | Already in repo; Phase 1 schemas define all defaults    |
| node:fs/promises | Node 22+ | Async filesystem operations                 | Standard library; no dependency needed                  |
| node:path        | Node 22+ | Path resolution and joining                 | Standard library                                        |

### Supporting

| Library        | Version | Purpose                         | When to Use                                                    |
| -------------- | ------- | ------------------------------- | -------------------------------------------------------------- |
| @clack/prompts | ^1.1.0  | Interactive scaffolding prompts | Already in repo; used by existing wizard (src/wizard/setup.ts) |

### Alternatives Considered

| Instead of       | Could Use            | Tradeoff                                                                                                                                                            |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML.stringify() | Template literals    | Template literals are simpler but not roundtrip-safe; YAML.stringify() guarantees correct YAML escaping for user-provided strings (names with colons, quotes, etc.) |
| fs.writeFile()   | temp+rename (atomic) | Atomic writes protect against partial reads during sync (Phase 3). Use temp+rename for PROJECT.md and queue.md since the watcher will read them.                    |

**Installation:**
No new dependencies needed.

## Architecture Patterns

### Recommended Project Structure

```
src/projects/
├── schemas.ts           # [Phase 1] Zod schemas with defaults
├── types.ts             # [Phase 1] TypeScript types
├── frontmatter.ts       # [Phase 1] Parser
├── queue-parser.ts      # [Phase 1] Queue parser
├── errors.ts            # [Phase 1] Warning formatter
├── index.ts             # [Phase 1] Barrel export (extend with scaffold exports)
├── scaffold.ts          # [Phase 2] ProjectManager class
├── scaffold.test.ts     # [Phase 2] Tests
└── templates.ts         # [Phase 2] Template generation functions
```

### Pattern 1: ProjectManager Class

**What:** Stateful class that manages project creation, sub-project creation, and task ID generation.
**When to use:** All project scaffolding operations.
**Example:**

```typescript
// src/projects/scaffold.ts
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { ProjectFrontmatterSchema, QueueFrontmatterSchema } from "./schemas.js";

export interface CreateProjectOpts {
  name: string;
  description?: string;
  owner?: string;
}

export class ProjectManager {
  private readonly projectsRoot: string;

  constructor(homeDir?: string) {
    const home = homeDir ?? resolveRequiredHomeDir();
    this.projectsRoot = path.join(home, ".openclaw", "projects");
  }

  async create(opts: CreateProjectOpts): Promise<string> {
    const projectDir = path.join(this.projectsRoot, opts.name);
    // Check existence first (D-13)
    if (await this.exists(projectDir)) {
      throw new Error(`Project already exists at ${projectDir}`);
    }
    // Create structure
    await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });
    // Write files...
    return projectDir;
  }

  async createSubProject(opts: CreateProjectOpts & { parent: string }): Promise<string> {
    const parentDir = path.join(this.projectsRoot, opts.parent);
    // Verify parent exists
    const subDir = path.join(parentDir, "sub-projects", opts.name);
    // Same scaffolding as create()
    return subDir;
  }

  async nextTaskId(projectDir: string): Promise<string> {
    // Scan tasks/ directory, find max ID, return next
  }
}
```

### Pattern 2: Template Generation from Schema Defaults

**What:** Generate frontmatter content by creating a default object from Zod schemas and stringifying with YAML.
**When to use:** Creating PROJECT.md, queue.md, and task files.
**Example:**

```typescript
// src/projects/templates.ts
import YAML from "yaml";
import type { ProjectFrontmatter } from "./types.js";

export function generateProjectMd(opts: {
  name: string;
  description?: string;
  owner?: string;
}): string {
  const frontmatter: ProjectFrontmatter = {
    name: opts.name,
    status: "active",
    description: opts.description,
    owner: opts.owner,
    tags: [],
    columns: ["Backlog", "In Progress", "Review", "Done"],
    dashboard: {
      widgets: [
        "project-status",
        "task-counts",
        "active-agents",
        "sub-project-status",
        "recent-activity",
        "blockers",
      ],
    },
    created: new Date().toISOString().split("T")[0],
    updated: new Date().toISOString().split("T")[0],
  };
  const yaml = YAML.stringify(frontmatter);
  return `---\n${yaml}---\n\n# ${opts.name}\n\n${opts.description ?? ""}\n`;
}

export function generateQueueMd(): string {
  const frontmatter = { updated: new Date().toISOString() };
  const yaml = YAML.stringify(frontmatter);
  return `---\n${yaml}---\n\n## Available\n\n## Claimed\n\n## Done\n\n## Blocked\n`;
}
```

### Pattern 3: Home Directory Resolution

**What:** Use `resolveRequiredHomeDir()` for all project paths.
**When to use:** Always -- never hardcode `~` or `os.homedir()`.
**Example:**

```typescript
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
// Resolves OPENCLAW_HOME env var or falls back to os.homedir()
const home = resolveRequiredHomeDir();
const projectsRoot = path.join(home, ".openclaw", "projects");
```

### Pattern 4: Atomic File Writes

**What:** Write to a temp file then rename to target path.
**When to use:** PROJECT.md and queue.md creation (Phase 3 watcher will read these).
**Example:**

```typescript
import { randomUUID } from "node:crypto";

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}
```

### Anti-Patterns to Avoid

- **Hardcoding `~/.openclaw/`:** Always use `resolveRequiredHomeDir()` -- the `OPENCLAW_HOME` env var can override this.
- **Generating YAML with template literals:** User input (project names with `:`, `"`, `#`) can break YAML syntax. Use `YAML.stringify()`.
- **Reusing deleted task IDs:** Always scan for the highest existing ID and increment. Never fill gaps.
- **Creating `sub-projects/` dir eagerly:** Only create the `sub-projects/` directory when a sub-project is actually created, not during initial project scaffolding.

## Don't Hand-Roll

| Problem                    | Don't Build                      | Use Instead                                              | Why                                                                                               |
| -------------------------- | -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| YAML generation            | Template literal string building | `YAML.stringify()` from `yaml` package                   | Handles escaping of special characters (colons, quotes, hashes) in user-provided values           |
| Schema defaults            | Manually defining default values | `ProjectFrontmatterSchema.parse({name, ...})`            | Zod schemas already define all defaults; parsing a partial object fills in defaults automatically |
| Home directory             | `os.homedir()` or `~` expansion  | `resolveRequiredHomeDir()` from `src/infra/home-dir.ts`  | Handles `OPENCLAW_HOME` override, Windows env vars, edge cases                                    |
| Interactive prompts        | Raw readline/stdin               | `@clack/prompts` via `WizardPrompter` abstraction        | Already in repo; matches existing setup wizard UX                                                 |
| Temp directories for tests | Manual `mkdtemp` + cleanup       | `createTempHomeEnv()` from `src/test-utils/temp-home.ts` | Sets HOME env, creates `.openclaw/` structure, provides cleanup                                   |

**Key insight:** Phase 1 schemas contain all the defaults. Template generation should flow through Zod parse (to get defaults) then YAML stringify (to render), not manually duplicate default values.

## Common Pitfalls

### Pitfall 1: YAML Special Characters in Project Names

**What goes wrong:** Project names containing `:`, `#`, `"`, `'`, or leading/trailing whitespace break YAML frontmatter when generated with template literals.
**Why it happens:** YAML interprets these characters as syntax elements.
**How to avoid:** Use `YAML.stringify()` which automatically quotes strings that contain special characters.
**Warning signs:** Tests only use simple alphanumeric names like "my-project". Add test cases with names like "my: project" and "project #1".

### Pitfall 2: Race Between mkdir and Existence Check

**What goes wrong:** Two concurrent `create()` calls for the same project name both pass the existence check, then both attempt to create the directory.
**Why it happens:** TOCTOU (time-of-check-to-time-of-use) race condition.
**How to avoid:** For Phase 2, this is low risk (single CLI user). Use `fs.mkdir()` without `{recursive: true}` for the project root dir -- it will throw `EEXIST` if the directory already exists. Catch and convert to the user-friendly error message.
**Warning signs:** Tests that mock `fs.access` but not `fs.mkdir`.

### Pitfall 3: Task ID Padding Width

**What goes wrong:** After 999 tasks, TASK-1000 sorts lexicographically after TASK-100 but before TASK-200.
**Why it happens:** Zero-padding width is fixed at 3 digits.
**How to avoid:** Use 3-digit padding (matching TASK_ID_PATTERN which allows any number of digits: `/^TASK-\d+$/`). When generating, pad to at least 3 digits. The regex already accepts wider IDs. Document that sorting is by numeric value, not string.
**Warning signs:** Tests only go up to single-digit IDs.

### Pitfall 4: Sub-project Directory Structure Mismatch

**What goes wrong:** Sub-projects created directly under parent (e.g., `my-project/auth-system/`) instead of under `sub-projects/` subdirectory, conflicting with the design spec.
**Why it happens:** Ambiguity between "one level deep under parent" and "under sub-projects/ directory".
**How to avoid:** The design spec (file structure diagram) explicitly shows `sub-projects/auth-system/` as the path. Use `<parent>/sub-projects/<name>/` as the canonical location. Sub-project discovery scans `<parent>/sub-projects/*/PROJECT.md`.
**Warning signs:** D-10 says "filesystem scan for subdirectories containing PROJECT.md" -- make sure the scan targets `sub-projects/` not the parent root.

### Pitfall 5: Missing Parent Validation for Sub-projects

**What goes wrong:** `createSubProject({parent: "nonexistent"})` silently creates directories instead of erroring.
**Why it happens:** `fs.mkdir({recursive: true})` creates all missing parent directories.
**How to avoid:** Verify the parent project directory exists and contains a PROJECT.md before creating sub-project. Throw a clear error: "Parent project 'nonexistent' does not exist".
**Warning signs:** Tests only test the happy path.

## Code Examples

### Template Generation with Schema Defaults

```typescript
// Source: Phase 1 schemas.ts + yaml package
import YAML from "yaml";
import { ProjectFrontmatterSchema } from "./schemas.js";

function generateProjectFrontmatter(opts: {
  name: string;
  description?: string;
  owner?: string;
}): string {
  // Parse through Zod to fill in all defaults
  const data = ProjectFrontmatterSchema.parse({
    name: opts.name,
    description: opts.description,
    owner: opts.owner,
    created: new Date().toISOString().split("T")[0],
    updated: new Date().toISOString().split("T")[0],
  });
  return YAML.stringify(data);
}
```

### Task ID Scanning

```typescript
// Source: node:fs + TASK_ID_PATTERN from schemas.ts
import fs from "node:fs/promises";
import path from "node:path";

async function nextTaskId(projectDir: string): Promise<string> {
  const tasksDir = path.join(projectDir, "tasks");
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    // tasks/ doesn't exist yet -- start at 1
    return "TASK-001";
  }

  const pattern = /^TASK-(\d+)\.md$/;
  let maxId = 0;
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxId) maxId = num;
    }
  }

  const next = maxId + 1;
  return `TASK-${String(next).padStart(3, "0")}`;
}
```

### Existence Check with mkdir

```typescript
// Atomic existence check -- avoids TOCTOU race
async function ensureNewProjectDir(projectDir: string): Promise<void> {
  try {
    // Non-recursive mkdir throws EEXIST if directory exists
    await fs.mkdir(projectDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Project already exists at ${projectDir}`);
    }
    throw err;
  }
}
```

### Test Fixture Pattern

```typescript
// Source: src/test-utils/temp-home.ts
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { ProjectManager } from "./scaffold.js";

describe("ProjectManager", () => {
  let env: TempHomeEnv;
  let manager: ProjectManager;

  beforeEach(async () => {
    env = await createTempHomeEnv("scaffold-test-");
    manager = new ProjectManager(env.home);
  });

  afterEach(async () => {
    await env.restore();
  });

  it("creates project with correct structure", async () => {
    const dir = await manager.create({ name: "test-project" });
    // Assert PROJECT.md, queue.md, tasks/.gitkeep exist
  });
});
```

## State of the Art

| Old Approach                     | Current Approach                                | When Changed          | Impact                                                                                                                                               |
| -------------------------------- | ----------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML.stringify() with no options | YAML.stringify() with `{schema: "core"}` option | yaml v2.x             | Prevents YAML 1.1 quirks (e.g., "no" parsed as false). The frontmatter parser already uses `{schema: "core"}` for parsing -- stringify should match. |
| Manual template strings for YAML | Zod schema parse + YAML.stringify               | Current best practice | Ensures frontmatter roundtrips correctly through parse/stringify cycle                                                                               |

## Validation Architecture

### Test Framework

| Property           | Value                                        |
| ------------------ | -------------------------------------------- |
| Framework          | vitest                                       |
| Config file        | vitest.config.ts                             |
| Quick run command  | `pnpm test -- src/projects/scaffold.test.ts` |
| Full suite command | `pnpm test`                                  |

### Phase Requirements to Test Map

| Req ID  | Behavior                                                                             | Test Type | Automated Command                                                 | File Exists? |
| ------- | ------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- | ------------ |
| DATA-01 | Project folder at ~/.openclaw/projects/<name>/ contains PROJECT.md, queue.md, tasks/ | unit      | `pnpm test -- src/projects/scaffold.test.ts -t "creates project"` | No -- Wave 0 |
| DATA-02 | Sub-project folders one level deep under parent                                      | unit      | `pnpm test -- src/projects/scaffold.test.ts -t "sub-project"`     | No -- Wave 0 |
| DATA-06 | Task ID auto-generation (sequential, per-project)                                    | unit      | `pnpm test -- src/projects/scaffold.test.ts -t "task id"`         | No -- Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test -- src/projects/scaffold.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/projects/scaffold.test.ts` -- covers DATA-01, DATA-02, DATA-06
- [ ] No framework install needed (vitest already configured)

## Sources

### Primary (HIGH confidence)

- `src/projects/schemas.ts` -- Phase 1 Zod schemas with all defaults
- `src/projects/frontmatter.ts` -- Phase 1 parser showing YAML parse pattern
- `src/infra/home-dir.ts` -- Home directory resolution with OPENCLAW_HOME support
- `src/test-utils/temp-home.ts` -- Test fixture for temporary home directories
- `src/wizard/prompts.ts` -- WizardPrompter abstraction for interactive prompts
- `docs/superpowers/specs/2026-03-26-project-management-design.md` -- Design spec with file structure diagram showing `sub-projects/` directory
- `yaml` npm package v2.8.3 -- Verified YAML.stringify() produces clean block-style output

### Secondary (MEDIUM confidence)

- `src/wizard/setup.ts` -- Existing wizard pattern using clack/prompts (reviewed first 100 lines)

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- all libraries already in repo, verified versions, zero new dependencies
- Architecture: HIGH -- all patterns lifted from existing codebase (home-dir, temp-home, wizard, schemas)
- Pitfalls: HIGH -- YAML escaping verified by testing stringify, TOCTOU race is textbook, sub-project path confirmed from design spec

**Research date:** 2026-03-27
**Valid until:** 2026-04-27 (stable domain, no external dependencies)
