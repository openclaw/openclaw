---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: file-system-state-management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  File-system state management for OpenProse programs. This approach persists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execution state to the `.prose/` directory, enabling inspection, resumption,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and long-running workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../prose.md: VM execution semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - in-context.md: In-context state management (alternative approach)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - sqlite.md: SQLite state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - postgres.md: PostgreSQL state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../primitives/session.md: Session context and compaction guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# File-System State Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how the OpenProse VM tracks execution state using **files in the `.prose/` directory**. This is one of two state management approaches (the other being in-context state in `in-context.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
File-based state persists all execution artifacts to disk. This enables:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Inspection**: See exactly what happened at each step（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Resumption**: Pick up interrupted programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Long-running workflows**: Handle programs that exceed context limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Debugging**: Trace through execution history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key principle:** Files are inspectable artifacts. The directory structure IS the execution state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Directory Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Project-level state (in working directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── .env                              # Config (simple key=value format)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── {YYYYMMDD}-{HHMMSS}-{random}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── program.prose             # Copy of running program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── state.md                  # Execution state with code snippets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       │   ├── {name}.md             # Root scope bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       │   └── {name}__{execution_id}.md  # Scoped bindings (block invocations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── imports/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       │   └── {handle}--{slug}/     # Nested program executions (same structure recursively)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       └── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│           └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── memory.md         # Agent's current state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── {name}-001.md     # Historical segments (flattened)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── {name}-002.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/                           # Project-scoped agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── {name}-001.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# User-level state (in home directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/                           # User-scoped agent memory (cross-project)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── {name}-001.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Run ID Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format: `{YYYYMMDD}-{HHMMSS}-{random6}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: `20260115-143052-a7b3c9`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No "run-" prefix needed—the directory name makes context obvious.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Segment Numbering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Segments use 3-digit zero-padded numbers: `captain-001.md`, `captain-002.md`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a program exceeds 999 segments, extend to 4 digits: `captain-1000.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File Formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `.prose/.env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Simple key=value configuration file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```env（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENPROSE_TELEMETRY=enabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
USER_ID=user-a7b3c9d4e5f6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SESSION_ID=sess-1704326400000-x9y8z7（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why this format:** Self-evident, no JSON parsing needed, familiar to developers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `state.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The execution state file shows the program's current position using **annotated code snippets**. This makes it self-evident where execution is and what has happened.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Only the VM writes this file.** Subagents never modify `state.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The format shows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Full history** of executed code with inline annotations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Current position** clearly marked with status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **~5-10 lines ahead** of current position (what's coming next)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Index** of all bindings and agents with file paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Execution State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
run: 20260115-143052-a7b3c9（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
program: feature-implementation.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
started: 2026-01-15T14:30:52Z（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
updated: 2026-01-15T14:35:22Z（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Execution Trace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You research topics thoroughly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate and review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher           # --> bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a = session "Analyze risk A"               # --> bindings/a.md (complete)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b = session "Analyze risk B"               # <-- EXECUTING（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **analysis complete** (max: 3):   # [not yet entered]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Synthesize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { a, b, research }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: captain                              # [...next...]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review the synthesis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: synthesis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Active Constructs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel (lines 14-16)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a: complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- b: executing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Loop (lines 18-21)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- status: not yet entered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iteration: 0/3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- condition: **analysis complete**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Name     | Kind | Path                     | Execution ID |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ---- | ------------------------ | ------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| research | let  | bindings/research.md     | (root)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| a        | let  | bindings/a.md            | (root)       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| result   | let  | bindings/result\_\_43.md | 43           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Name    | Scope     | Path            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------- | --------- | --------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| captain | execution | agents/captain/ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Call Stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| execution_id | block   | depth | status    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------- | ----- | --------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 43           | process | 3     | executing |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 42           | process | 2     | waiting   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 41           | process | 1     | waiting   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Status annotations:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Annotation | Meaning |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|------------|---------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# --> bindings/name.md` | Output written to this file |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# <-- EXECUTING` | Currently executing this statement |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# (complete)` | Statement finished successfully |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# [not yet entered]` | Block not yet reached |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# [...next...]` | Coming up next |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `# <-- RETRYING (attempt 2/3)` | Retry in progress |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `bindings/{name}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All named values (input, output, let, const) are stored as binding files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AI safety research covers several key areas including alignment,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
robustness, and interpretability. The field has grown significantly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
since 2020 with major contributions from...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Structure:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Header with binding name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kind:` field indicating type (input, output, let, const)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `source:` code snippet showing origin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `---` separator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Actual value below（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**The `kind` field distinguishes:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Kind | Meaning |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|------|---------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `input` | Value received from caller |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `output` | Value to return to caller |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `let` | Mutable variable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `const` | Immutable variable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anonymous Session Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sessions without explicit output capture still produce results:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Analyze the codebase"   # No `let x = ...` capture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These get auto-generated names with an `anon_` prefix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings/anon_001.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings/anon_002.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This ensures all session outputs are persisted and inspectable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scoped Bindings (Block Invocations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a binding is created inside a block invocation, it's scoped to that execution frame to prevent collisions across recursive calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Naming convention:** `{name}__{execution_id}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings/result__43.md` — binding `result` in execution_id 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings/parts__44.md` — binding `parts` in execution_id 44（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**File format with execution scope:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
execution_id: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = session "Process chunk"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Processed chunk into 3 sub-parts...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Scope resolution:** The VM resolves variable references by checking:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `{name}__{current_execution_id}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `{name}__{parent_execution_id}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Continue up the call stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `{name}.md` (root scope)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The first match wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example directory for recursive calls:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── data.md # Root scope input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── result**1.md # First process() invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── parts**1.md # Parts from first invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── result**2.md # Recursive call (depth 2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── parts**2.md # Parts from depth 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── result\_\_3.md # Recursive call (depth 3)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agent Memory Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents/{name}/memory.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent's current accumulated state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Memory: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current Understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The project is implementing a REST API for user management.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Architecture uses Express + PostgreSQL. Test coverage target is 80%.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decisions Made（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 2026-01-15: Approved JWT over session tokens (simpler stateless auth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 2026-01-15: Set 80% coverage threshold (balances quality vs velocity)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open Concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rate limiting not yet implemented on login endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Need to verify OAuth flow works with new token format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents/{name}/{name}-NNN.md` (Segments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Historical records of each invocation, flattened in the same directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Segment 001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
timestamp: 2026-01-15T14:32:15Z（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompt: "Review the research findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reviewed: docs from parallel research session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Found: good coverage of core concepts, missing edge cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Decided: proceed with implementation, note gaps for later（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Next: review implementation against identified gaps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Who Writes What（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File                          | Written By       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------- | ---------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state.md`                    | VM only          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `bindings/{name}.md`          | Subagent         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agents/{name}/memory.md`     | Persistent agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agents/{name}/{name}-NNN.md` | Persistent agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM orchestrates; subagents write their own outputs directly to the filesystem. **The VM never holds full binding values—it tracks file paths.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Subagent Output Writing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the VM spawns a session, it tells the subagent where to write output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For Regular Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you complete this task, write your output to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  .prose/runs/20260115-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Your output here]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For Persistent Agents (resume:)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your memory is at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/20260115-143052-a7b3c9/agents/captain/memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read it first to understand your prior context. When done, update it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with your compacted state following the guidelines in primitives/session.md.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Also write your segment record to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/20260115-143052-a7b3c9/agents/captain/captain-003.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What Subagents Return to the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After writing output, the subagent returns a **confirmation message**—not the full content:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Root scope (outside block invocations):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260115-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: AI safety research covering alignment, robustness, and interpretability with 15 citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside block invocation (include execution_id):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 sub-parts for recursive processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM records the location and continues. It does NOT read the file—it passes the reference to subsequent sessions that need the context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Imports Recursive Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Imported programs use the **same unified structure recursively**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/{id}/imports/{handle}--{slug}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── program.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── state.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│ └── {name}.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── imports/ # Nested imports go here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│ └── {handle2}--{slug2}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│ └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This allows unlimited nesting depth while maintaining consistent structure at every level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory Scoping for Persistent Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scope | Declaration | Path | Lifetime |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
|-------|-------------|------|----------|（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution (default) | `persist: true` | `.prose/runs/{id}/agents/{name}/` | Dies with run |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Project | `persist: project` | `.prose/agents/{name}/` | Survives runs in project |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User | `persist: user` | `~/.prose/agents/{name}/` | Survives across projects |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Custom | `persist: "path"` | Specified path | User-controlled |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## VM Update Protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After each statement completes, the VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Confirms** subagent wrote its output file(s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Updates** `state.md` with new position and annotations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Continues** to next statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM never does compaction—that's the subagent's responsibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resuming Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If execution is interrupted, resume by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Reading `.prose/runs/{id}/state.md` to find current position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Loading all bindings from `bindings/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Continuing from the marked position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `state.md` file contains everything needed to understand where execution stopped and what has been accomplished.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
