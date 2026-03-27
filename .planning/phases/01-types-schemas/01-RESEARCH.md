# Phase 1: Types & Schemas - Research

**Researched:** 2026-03-26
**Domain:** Zod schemas, typed YAML frontmatter parsing, data model definitions
**Confidence:** HIGH

## Summary

Phase 1 is the foundation layer for the OpenClaw project management system. It defines Zod schemas for three document types (PROJECT.md, task files, queue.md), creates a typed frontmatter parser at `src/projects/frontmatter.ts` that preserves arrays and nested objects (unlike the existing `parseFrontmatterBlock()` which flattens to strings), and establishes error handling that produces structured warnings instead of crashes.

The technical risk is low. Every library needed (yaml, zod) is already in the repo. The existing `parseFrontmatterBlock()` in `src/markdown/frontmatter.ts` must NOT be modified (PARSE-04). The new parser will call `yaml.parse()` directly on extracted frontmatter blocks, then validate with Zod `.safeParse()`. The `extractFrontmatterBlock()` helper in the existing file is a private function, so the new parser must implement its own frontmatter extraction (or duplicate the trivial regex logic).

**Primary recommendation:** Create `src/projects/schemas.ts` (Zod schemas), `src/projects/frontmatter.ts` (typed parser), and `src/projects/types.ts` (TypeScript interfaces) as the three core deliverables. Use `.safeParse()` everywhere with structured error reporting including file path and line number.

<phase_requirements>

## Phase Requirements

| ID       | Description                                                                                                                   | Research Support                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PARSE-01 | Typed frontmatter parser at `src/projects/frontmatter.ts` returns arrays, nested objects, and typed values (not flat strings) | New parser uses `yaml.parse()` directly (not existing `parseFrontmatterBlock()` which flattens to strings). Zod schema validation produces typed output.         |
| PARSE-02 | Zod schemas validate PROJECT.md, task file, and queue.md frontmatter                                                          | Three Zod schemas defined in `src/projects/schemas.ts`. Design spec provides exact field names, types, and defaults.                                             |
| PARSE-03 | Parse failures use `.safeParse()` -- skip corrupt files, log warning with file path and line number                           | Zod's `.safeParse()` returns `{ success: false, error }` with issue paths. Wrap with file path context for structured warnings.                                  |
| PARSE-04 | Existing `parseFrontmatterBlock()` in `src/markdown/frontmatter.ts` is not modified                                           | New parser is completely independent. Does not import from or modify the existing file.                                                                          |
| DATA-03  | PROJECT.md contains YAML frontmatter with name, status, description, owner, tags, columns, dashboard widgets                  | `ProjectFrontmatterSchema` covers all fields. Note: `owner` is in requirements but not in design spec -- add as optional string field.                           |
| DATA-04  | Task files contain YAML frontmatter with title, status, priority, assignee, capabilities, depends_on, created, updated        | `TaskFrontmatterSchema` covers all fields. `depends_on` added per DATA-07. `assignee` maps to `claimed_by` in design spec.                                       |
| DATA-05  | Queue.md contains sections (Available, Claimed, Blocked) with task references and metadata                                    | Queue parser extracts sections by heading. Design spec uses "Done" not "Blocked" -- schema supports both. Needs markdown section parsing (not just frontmatter). |
| DATA-07  | Task frontmatter supports `depends_on` field referencing other task IDs                                                       | Added as `z.array(z.string().regex(/^TASK-\d+$/)).default([])`. Not in design spec but required by requirements.                                                 |
| DATA-08  | Kanban column names configurable per project via PROJECT.md frontmatter with defaults                                         | `columns` field with `z.array(z.string()).default(["Backlog", "In Progress", "Review", "Done"])`. Already in design spec.                                        |

</phase_requirements>

## Standard Stack

### Core

| Library | Version          | Purpose                             | Why Standard                                                            |
| ------- | ---------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `zod`   | ^4.3.6 (in repo) | Schema validation for frontmatter   | Already used across codebase for config schemas. Zod 4 is current.      |
| `yaml`  | ^2.8.3 (in repo) | YAML parsing for frontmatter blocks | Already used by existing `parseFrontmatterBlock()`. YAML 1.2 compliant. |

### Supporting

| Library            | Version  | Purpose                            | When to Use                         |
| ------------------ | -------- | ---------------------------------- | ----------------------------------- |
| `node:fs/promises` | Built-in | Read markdown files during parsing | File I/O for frontmatter extraction |

### Alternatives Considered

| Instead of | Could Use           | Tradeoff                                                                                                                       |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `yaml`     | `gray-matter`       | gray-matter adds a dependency; repo already has yaml + custom extraction                                                       |
| `yaml`     | `js-yaml`           | Repo uses `yaml` (eemeli/yaml), not js-yaml. Do not mix two YAML parsers.                                                      |
| `zod`      | `@sinclair/typebox` | TypeBox is in repo but used for JSON schema generation, not runtime validation. Zod is the pattern for parsed data validation. |

**Installation:**

```bash
# No installation needed -- all dependencies already in package.json
```

**Version verification:** Confirmed from `package.json`:

- `zod`: ^4.3.6
- `yaml`: ^2.8.3

## Architecture Patterns

### Recommended Project Structure

```
src/projects/
  schemas.ts            # Zod schemas (ProjectFrontmatter, TaskFrontmatter, QueueFrontmatter)
  frontmatter.ts        # Typed frontmatter parser (extract + yaml.parse + zod validate)
  types.ts              # TypeScript interfaces (inferred from Zod schemas via z.infer)
  queue-parser.ts       # Queue.md section parser (Available/Claimed/Done/Blocked headings)
  errors.ts             # Structured parse error types with file path and line number
  index.ts              # Public API barrel
```

### Pattern 1: Zod Schema with Defaults and Safe Parse

**What:** Define schemas with sensible defaults so partially-specified frontmatter still produces valid typed objects. Always use `.safeParse()` for error handling.
**When to use:** Every frontmatter validation call.
**Example:**

```typescript
// src/projects/schemas.ts
import { z } from "zod";

export const ProjectFrontmatterSchema = z.object({
  name: z.string(),
  status: z.enum(["active", "paused", "complete"]).default("active"),
  description: z.string().optional(),
  owner: z.string().optional(),
  tags: z.array(z.string()).default([]),
  columns: z.array(z.string()).default(["Backlog", "In Progress", "Review", "Done"]),
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
    .default({}),
  created: z.string().optional(),
  updated: z.string().optional(),
});

export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatterSchema>;
```

### Pattern 2: Independent Frontmatter Extraction (No Modification of Existing Parser)

**What:** The new parser extracts YAML frontmatter independently. The existing `extractFrontmatterBlock()` in `src/markdown/frontmatter.ts` is private (not exported). Duplicate the trivial extraction logic rather than modifying the existing file.
**When to use:** All project frontmatter parsing.
**Example:**

```typescript
// src/projects/frontmatter.ts
import YAML from "yaml";
import type { ProjectFrontmatter } from "./schemas.js";
import { ProjectFrontmatterSchema } from "./schemas.js";

function extractYamlBlock(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return undefined;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return undefined;
  return normalized.slice(4, endIndex);
}

export type ParseResult<T> = { success: true; data: T } | { success: false; error: ParseError };

export type ParseError = {
  filePath: string;
  message: string;
  issues: Array<{ path: string; message: string; line?: number }>;
};

export function parseProjectFrontmatter(
  content: string,
  filePath: string,
): ParseResult<ProjectFrontmatter> {
  const block = extractYamlBlock(content);
  if (!block) {
    return {
      success: false,
      error: { filePath, message: "No frontmatter block found", issues: [] },
    };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(block, { schema: "core" });
  } catch (err) {
    return {
      success: false,
      error: {
        filePath,
        message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        issues: [],
      },
    };
  }
  const result = ProjectFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: {
        filePath,
        message: "Schema validation failed",
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    };
  }
  return { success: true, data: result.data };
}
```

### Pattern 3: Queue.md Section Parsing (Markdown Headings as Structure)

**What:** Queue.md is not pure frontmatter -- it has YAML frontmatter (updated timestamp) plus markdown sections (Available, Claimed, Done/Blocked) with list items. Parse both layers.
**When to use:** Queue parsing only.
**Example:**

```typescript
// src/projects/queue-parser.ts
// Parse queue.md sections:
// ## Available
// - TASK-003 [capabilities: code, testing] priority: high
// ## Claimed
// - TASK-001 [claimed_by: coding-agent-01, since: 2026-03-26T14:00]
// ## Done
// - TASK-002 [completed: 2026-03-26T12:00, by: coding-agent-01]
// ## Blocked (optional section per DATA-05)

export interface QueueEntry {
  taskId: string;
  metadata: Record<string, string>; // key-value pairs from brackets
}

export interface ParsedQueue {
  updated: string | null;
  available: QueueEntry[];
  claimed: QueueEntry[];
  done: QueueEntry[];
  blocked: QueueEntry[];
}
```

### Anti-Patterns to Avoid

- **Modifying `parseFrontmatterBlock()`:** PARSE-04 explicitly forbids this. The existing function flattens to `Record<string, string>` which other callers depend on.
- **Importing from `src/markdown/frontmatter.ts`:** The new parser must be fully independent. `extractFrontmatterBlock` is private and the return type (`Record<string, string>`) is wrong for our needs.
- **Using `.parse()` instead of `.safeParse()`:** PARSE-03 requires structured warnings, not thrown exceptions. Always use `.safeParse()`.
- **Overcomplicating queue parsing:** Do not use a full markdown AST parser (remark/unified). Queue.md has a simple, predictable structure: frontmatter + heading-delimited sections with list items. Regex/string splitting is sufficient.
- **Date parsing in schemas:** Keep `created`/`updated` as strings in the schema, not `z.date()` or `z.coerce.date()`. The design spec shows ISO date strings. Coercion to Date objects can happen in downstream consumers if needed.

## Don't Hand-Roll

| Problem            | Don't Build                           | Use Instead                          | Why                                                                                    |
| ------------------ | ------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| YAML parsing       | Custom key-value parser               | `yaml.parse()` with `schema: "core"` | YAML edge cases (multiline strings, block scalars, anchors, special chars) are endless |
| Schema validation  | Manual type checking / if-else chains | Zod `.safeParse()`                   | Zod provides typed output, default values, error messages with paths for free          |
| CRLF normalization | Custom line ending handling           | Normalize to `\n` at extraction time | Match existing `extractFrontmatterBlock` approach                                      |

**Key insight:** The YAML parsing and schema validation are solved problems. The only custom code needed is: (1) frontmatter block extraction (trivial regex), (2) queue section parsing (heading-based splitting), and (3) structured error wrapping.

## Common Pitfalls

### Pitfall 1: Frontmatter Parser Type Mismatch

**What goes wrong:** Using the existing `parseFrontmatterBlock()` output for project data. It flattens arrays to JSON strings and nested objects to serialized strings.
**Why it happens:** Developer sees an existing frontmatter parser and tries to reuse it.
**How to avoid:** The new `src/projects/frontmatter.ts` calls `yaml.parse()` directly. Never import from `src/markdown/frontmatter.ts`.
**Warning signs:** `capabilities` is `"[\"code\",\"ui\"]"` (a string) instead of `["code", "ui"]` (an array).

### Pitfall 2: YAML Edge Cases in Agent-Written Frontmatter

**What goes wrong:** Agents write YAML that is technically invalid -- unclosed quotes, tabs instead of spaces, special chars in titles, colons in descriptions.
**Why it happens:** Agents generate markdown content, and YAML is whitespace-sensitive.
**How to avoid:** `.safeParse()` catches all validation failures. Wrap YAML parse in try/catch for syntax errors. Return structured `ParseError` with file path.
**Warning signs:** Tasks disappearing from the UI (skipped during indexing due to parse failure with no log).

### Pitfall 3: Queue.md Parsing Assumes Strict Format

**What goes wrong:** Parser breaks when queue sections are empty, missing, or have unexpected whitespace/formatting.
**Why it happens:** Queue is written by agents and humans, formatting varies.
**How to avoid:** Make section parsing tolerant: missing sections return empty arrays. Trim whitespace. Handle both `## Available` and `## available`. Handle empty list items gracefully.
**Warning signs:** Queue parse returns no available tasks even when the file clearly has them.

### Pitfall 4: `depends_on` Field Missing from Design Spec

**What goes wrong:** Developer follows design spec literally and omits `depends_on` from task schema, breaking Phase 6 (queue heartbeat dependency resolution).
**Why it happens:** Design spec task template does not include `depends_on`. The requirement (DATA-07) was added after the spec.
**How to avoid:** Include `depends_on: z.array(z.string().regex(/^TASK-\d+$/)).default([])` in TaskFrontmatterSchema. Document that this field is required by DATA-07 even though the design spec does not show it.
**Warning signs:** Phase 6 implementation discovers there is no schema support for task dependencies.

### Pitfall 5: `owner` Field Missing from Design Spec

**What goes wrong:** `owner` is listed in DATA-03 requirements but not in the design spec PROJECT.md template.
**Why it happens:** Requirements and design spec were written at different times.
**How to avoid:** Include `owner: z.string().optional()` in ProjectFrontmatterSchema. It is optional because the design spec does not mandate it, but the requirement lists it.
**Warning signs:** Phase 8 CLI `projects status` tries to display owner but the field was never parsed.

### Pitfall 6: Confusing `assignee` (DATA-04) with `claimed_by` (Design Spec)

**What goes wrong:** DATA-04 says "assignee" but the design spec uses "claimed_by". Developer creates both fields or uses the wrong one.
**Why it happens:** Requirements use business terminology ("assignee"), design spec uses implementation terminology ("claimed_by").
**How to avoid:** Use `claimed_by` as the schema field name (matches the design spec, which is the authoritative format). Document that DATA-04's "assignee" maps to `claimed_by`.
**Warning signs:** Two different fields for the same concept, or agents writing `assignee` but schema expecting `claimed_by`.

## Code Examples

### Complete TaskFrontmatterSchema

```typescript
// src/projects/schemas.ts
import { z } from "zod";

const TASK_ID_PATTERN = /^TASK-\d+$/;

export const TaskFrontmatterSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  title: z.string(),
  status: z.enum(["backlog", "in-progress", "review", "done", "blocked"]).default("backlog"),
  column: z.string().default("Backlog"),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  capabilities: z.array(z.string()).default([]),
  depends_on: z.array(z.string().regex(TASK_ID_PATTERN)).default([]),
  claimed_by: z.string().nullable().default(null),
  claimed_at: z.string().nullable().default(null),
  created: z.string().optional(),
  updated: z.string().optional(),
  parent: z.string().nullable().default(null),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
```

### Complete QueueFrontmatterSchema (Frontmatter Only)

```typescript
// src/projects/schemas.ts (continued)
export const QueueFrontmatterSchema = z.object({
  updated: z.string().optional(),
});

export type QueueFrontmatter = z.infer<typeof QueueFrontmatterSchema>;
```

### Structured Error Type

```typescript
// src/projects/errors.ts
export interface FrontmatterParseWarning {
  filePath: string;
  message: string;
  issues: Array<{
    path: string;
    message: string;
    line?: number;
  }>;
}

export function formatWarning(warning: FrontmatterParseWarning): string {
  const issues = warning.issues.map((i) => {
    const loc = i.line ? `:${i.line}` : "";
    const path = i.path ? ` (${i.path})` : "";
    return `  - ${i.message}${path} at ${warning.filePath}${loc}`;
  });
  return `${warning.message}\n${issues.join("\n")}`;
}
```

## State of the Art

| Old Approach                                                 | Current Approach                                 | When Changed | Impact                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------ |
| Zod 3 (`z.ZodType`)                                          | Zod 4 (`z.ZodType` compatible, faster internals) | 2025         | Import stays `{ z } from "zod"`. API is the same. Zod 4 is faster and slimmer. |
| `parseFrontmatterBlock()` returning `Record<string, string>` | Direct `yaml.parse()` for typed output           | This phase   | New parser preserves arrays, nested objects, booleans, numbers                 |

**Deprecated/outdated:**

- `gray-matter` -- unnecessary when `yaml` is already in the repo
- Zod 3 `z.ZodMini` -- not relevant; repo uses standard Zod 4

## Open Questions

1. **Queue.md "Blocked" vs "Done" sections**
   - What we know: DATA-05 says "Available/Claimed/Blocked" sections. Design spec shows "Available/Claimed/Done" sections.
   - What's unclear: Should the schema support both "Blocked" and "Done"? Or is DATA-05 wrong about "Blocked"?
   - Recommendation: Support all four sections (Available, Claimed, Done, Blocked). The design spec is probably the more recent/accurate source, but supporting "Blocked" costs nothing and Phase 6 may need it.

2. **Line number in parse errors**
   - What we know: PARSE-03 requires "file path and line number" in warnings.
   - What's unclear: Zod errors provide field paths (e.g., `dashboard.widgets`), not line numbers. YAML parse errors can include line numbers for syntax errors.
   - Recommendation: For YAML syntax errors, include the line number from the yaml parser error. For Zod validation errors, include the field path (which is more useful than a line number for schema mismatches). The "line number" requirement is satisfied by YAML-level errors; Zod-level errors provide equivalent localization via field paths.

3. **`owner` field semantics**
   - What we know: DATA-03 lists `owner` as a PROJECT.md frontmatter field. Design spec does not include it.
   - What's unclear: What does "owner" mean -- human name, agent id, GitHub username?
   - Recommendation: Add as `z.string().optional()` with no validation constraints. Let downstream phases define semantics.

## Validation Architecture

### Test Framework

| Property           | Value                                |
| ------------------ | ------------------------------------ |
| Framework          | Vitest (colocated `*.test.ts` files) |
| Config file        | `vitest.config.ts` (root)            |
| Quick run command  | `pnpm test -- src/projects/`         |
| Full suite command | `pnpm test`                          |

### Phase Requirements to Test Map

| Req ID   | Behavior                                                     | Test Type | Automated Command                                                           | File Exists? |
| -------- | ------------------------------------------------------------ | --------- | --------------------------------------------------------------------------- | ------------ |
| PARSE-01 | Typed parser returns arrays, nested objects, typed values    | unit      | `pnpm test -- src/projects/frontmatter.test.ts`                             | Wave 0       |
| PARSE-02 | Zod schemas validate PROJECT.md, task, queue frontmatter     | unit      | `pnpm test -- src/projects/schemas.test.ts`                                 | Wave 0       |
| PARSE-03 | `.safeParse()` produces structured warning with file path    | unit      | `pnpm test -- src/projects/frontmatter.test.ts -t "malformed"`              | Wave 0       |
| PARSE-04 | Existing `parseFrontmatterBlock()` unchanged                 | unit      | `pnpm test -- src/markdown/frontmatter.test.ts` (existing, must stay green) | Existing     |
| DATA-03  | PROJECT.md schema covers all required fields                 | unit      | `pnpm test -- src/projects/schemas.test.ts -t "project"`                    | Wave 0       |
| DATA-04  | Task schema covers all required fields                       | unit      | `pnpm test -- src/projects/schemas.test.ts -t "task"`                       | Wave 0       |
| DATA-05  | Queue parser handles Available/Claimed/Blocked/Done sections | unit      | `pnpm test -- src/projects/queue-parser.test.ts`                            | Wave 0       |
| DATA-07  | Task schema supports `depends_on` array of task IDs          | unit      | `pnpm test -- src/projects/schemas.test.ts -t "depends_on"`                 | Wave 0       |
| DATA-08  | Project schema has configurable columns with defaults        | unit      | `pnpm test -- src/projects/schemas.test.ts -t "columns"`                    | Wave 0       |

### Sampling Rate

- **Per task commit:** `pnpm test -- src/projects/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/projects/schemas.test.ts` -- covers PARSE-02, DATA-03, DATA-04, DATA-07, DATA-08
- [ ] `src/projects/frontmatter.test.ts` -- covers PARSE-01, PARSE-03
- [ ] `src/projects/queue-parser.test.ts` -- covers DATA-05

## Sources

### Primary (HIGH confidence)

- `src/markdown/frontmatter.ts` -- existing parser code, confirms `Record<string, string>` return type and private `extractFrontmatterBlock()`
- `src/markdown/frontmatter.test.ts` -- existing tests showing string flattening behavior
- `src/config/zod-schema.core.ts` -- Zod 4 usage patterns in the codebase
- `docs/superpowers/specs/2026-03-26-project-management-design.md` -- authoritative data model (PROJECT.md, task files, queue.md formats)
- `package.json` -- confirmed yaml ^2.8.3, zod ^4.3.6

### Secondary (MEDIUM confidence)

- `.planning/research/STACK.md` -- stack recommendations (already verified against codebase)
- `.planning/research/PITFALLS.md` -- pitfall catalog (already verified against codebase)
- `.planning/REQUIREMENTS.md` -- requirement definitions (authoritative)

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH -- zero new dependencies, all libraries verified in package.json
- Architecture: HIGH -- patterns are trivial (Zod schema + yaml parse + error wrapping)
- Pitfalls: HIGH -- all pitfalls are well-understood with known mitigations

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (stable domain, no fast-moving dependencies)
