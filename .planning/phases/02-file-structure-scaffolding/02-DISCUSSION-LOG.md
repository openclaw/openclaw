# Phase 2: File Structure & Scaffolding - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 02-file-structure-scaffolding
**Areas discussed:** Default PROJECT.md content, Task ID format, Sub-project structure, Scaffolding API

---

## Default PROJECT.md Content

| Option              | Description                                                                  | Selected |
| ------------------- | ---------------------------------------------------------------------------- | -------- |
| Rich template       | Pre-populated with default columns, example widgets, placeholder description |          |
| Minimal skeleton    | Required frontmatter fields with empty/default values                        |          |
| Interactive prompts | CLI asks project name, description, columns during scaffolding               | ✓        |

**User's choice:** Interactive prompts
**Notes:** User wants a tailored starting point via CLI questions

### Follow-up: Prompt Depth

| Option               | Description                                                         | Selected |
| -------------------- | ------------------------------------------------------------------- | -------- |
| Essential only       | Name, description, owner. Smart defaults for rest. 3 questions max. | ✓        |
| Full customization   | Columns, widgets, tags, sub-project setup. 6-8 questions.           |          |
| Name only + defaults | Just project name, everything else gets defaults.                   |          |

**User's choice:** Essential only (3 questions max)

### Follow-up: Queue.md Initial State

| Option                | Description                                         | Selected |
| --------------------- | --------------------------------------------------- | -------- |
| Empty sections        | Four section headings with frontmatter but no tasks | ✓        |
| Example task included | Sample TASK-001.md and matching queue entry         |          |
| No queue.md initially | Only created when first task is added               |          |

**User's choice:** Empty sections

### Follow-up: Tasks Directory

| Option                        | Description                            | Selected |
| ----------------------------- | -------------------------------------- | -------- |
| Empty directory with .gitkeep | Git tracks empty directory             | ✓        |
| Example TASK-001.md           | Sample task showing frontmatter format |          |
| Just the directory            | Empty, no .gitkeep                     |          |

**User's choice:** Empty directory with .gitkeep

---

## Task ID Format and Collision Handling

| Option                        | Description                                        | Selected |
| ----------------------------- | -------------------------------------------------- | -------- |
| Scoped per project            | Each project/sub-project has own TASK-001 sequence | ✓        |
| Globally unique across parent | Shared sequence across parent and sub-projects     |          |
| Prefixed by project           | IDs include project name (MYPROJ-001)              |          |

**User's choice:** Scoped per project

### Follow-up: Gap Handling

| Option                   | Description                                | Selected |
| ------------------------ | ------------------------------------------ | -------- |
| Always use next highest  | Scan max ID, increment. Gaps are fine.     | ✓        |
| Fill gaps first          | Reuse lowest available ID                  |          |
| Timestamp-based fallback | Fall back to timestamp IDs on scan failure |          |

**User's choice:** Always use next highest

---

## Sub-project Structure

| Option                         | Description                                       | Selected |
| ------------------------------ | ------------------------------------------------- | -------- |
| Independent with same defaults | Own PROJECT.md, no inheritance from parent        | ✓        |
| Inherit parent config          | Default to parent's columns/widgets, can override |          |
| Minimal sub-projects           | Only tasks/ and queue.md, no own PROJECT.md       |          |

**User's choice:** Independent with same defaults

### Follow-up: Sub-project Queue

| Option             | Description                            | Selected |
| ------------------ | -------------------------------------- | -------- |
| Yes, own queue     | Self-contained with own queue.md       | ✓        |
| Share parent queue | Tasks in parent queue with path prefix |          |
| Optional           | Can have own or use parent's           |          |

**User's choice:** Own queue

### Follow-up: Discovery

| Option             | Description                                            | Selected |
| ------------------ | ------------------------------------------------------ | -------- |
| Filesystem scan    | Scan for subdirectories with PROJECT.md                |          |
| Declared in parent | Parent frontmatter lists sub-projects                  |          |
| Both               | Filesystem scan is truth, parent can list for ordering | ✓        |

**User's choice:** Both

### Follow-up: Creation Flow

| Option                          | Description                                              | Selected |
| ------------------------------- | -------------------------------------------------------- | -------- |
| Same command with --parent flag | `openclaw projects create sub-name --parent parent-name` | ✓        |
| Separate sub-project command    | Dedicated `create-sub` command                           |          |
| Just mkdir + scaffold           | Manual directory creation, auto-detected                 |          |

**User's choice:** Same command with --parent flag

---

## Scaffolding API Design

| Option                       | Description                                                    | Selected |
| ---------------------------- | -------------------------------------------------------------- | -------- |
| Standalone utility functions | Pure functions in scaffold.ts                                  |          |
| ProjectManager class         | Stateful class with create(), createSubProject(), nextTaskId() | ✓        |
| CLI-integrated only          | Logic in CLI command handler, no separate API                  |          |

**User's choice:** ProjectManager class

### Follow-up: Existing Project Handling

| Option                   | Description                | Selected |
| ------------------------ | -------------------------- | -------- |
| Error with clear message | Throw error with path info | ✓        |
| Skip silently            | Idempotent, do nothing     |          |
| Offer to reinitialize    | Ask to overwrite           |          |

**User's choice:** Error with clear message

---

## Claude's Discretion

- Internal file writing implementation
- Exact prompt library usage (clack/prompts)
- Template string formatting
- Test fixture strategy

## Deferred Ideas

None
