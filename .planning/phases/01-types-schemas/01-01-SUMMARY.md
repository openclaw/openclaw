---
phase: 01-types-schemas
plan: 01
subsystem: projects/data-model
tags: [zod, schemas, types, validation, foundation]
dependency_graph:
  requires: []
  provides:
    [
      ProjectFrontmatterSchema,
      TaskFrontmatterSchema,
      QueueFrontmatterSchema,
      ParseResult,
      ParseError,
      FrontmatterParseWarning,
    ]
  affects: [frontmatter-parser, queue-parser, sync-pipeline, gateway, cli]
tech_stack:
  added: []
  patterns: [zod-safeParse, z-infer-typeof, regex-validation]
key_files:
  created:
    - src/projects/schemas.ts
    - src/projects/types.ts
    - src/projects/errors.ts
    - src/projects/schemas.test.ts
  modified: []
decisions:
  - Zod 4 .default({}) does not run inner schema defaults on undefined; provided full default object for dashboard field
metrics:
  duration: 183s
  completed: 2026-03-26T23:42:29Z
  tasks_completed: 1
  tasks_total: 1
  test_count: 17
  test_pass: 17
---

# Phase 01 Plan 01: Zod Schemas, Types, and Error Types Summary

Zod schemas for project, task, and queue frontmatter with TASK-NNN regex validation, configurable kanban columns, and dashboard widget defaults; TypeScript types inferred via z.infer plus ParseResult/ParseError discriminated union

## What Was Built

Three source files and one test file establishing the data model foundation for the project management system:

- **schemas.ts**: Three Zod schemas (ProjectFrontmatterSchema, TaskFrontmatterSchema, QueueFrontmatterSchema) with validation rules including TASK-NNN regex pattern for task IDs and depends_on arrays, enum validation for status/priority fields, and sensible defaults for columns and dashboard widgets.
- **types.ts**: TypeScript types inferred from Zod schemas via `z.infer<typeof>`, plus ParseResult<T> discriminated union and ParseError type for downstream parser use.
- **errors.ts**: FrontmatterParseWarning interface and formatWarning() helper for human-readable validation error output.
- **schemas.test.ts**: 17 unit tests covering happy paths, default application, enum validation, regex rejection, and edge cases.

## Requirements Satisfied

- **PARSE-02**: All three schemas use Zod `.safeParse()` for validation
- **DATA-03**: ProjectFrontmatterSchema validates name, status, description, owner, tags, columns, dashboard
- **DATA-04**: TaskFrontmatterSchema validates id, title, status, priority, capabilities, claimed_by, depends_on, created, updated
- **DATA-07**: depends_on field validates array of TASK-NNN IDs via regex
- **DATA-08**: columns field defaults to ["Backlog", "In Progress", "Review", "Done"]

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Zod 4 dashboard default behavior**

- **Found during:** Task 1 GREEN phase
- **Issue:** Zod 4's `.default({})` returns the literal `{}` when the parent field is undefined, without running inner schema defaults for `widgets`
- **Fix:** Provided full default object with widgets array to `.default()` instead of empty `{}`
- **Files modified:** src/projects/schemas.ts
- **Commit:** 931c37d

## Commits

| Hash    | Message                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| 931c37d | feat(01-01): add Zod schemas, TypeScript types, and error types for project management |

## Known Stubs

None - all schemas are fully implemented with real validation logic and defaults.

## Verification

- `pnpm test -- src/projects/schemas.test.ts` passes (17/17 tests)
- `pnpm tsgo` shows no type errors in src/projects/
- schemas.ts does NOT import from src/markdown/frontmatter.ts

## Self-Check: PASSED
