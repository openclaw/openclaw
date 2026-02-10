---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: sqlite-state-management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SQLite-based state management for OpenProse programs. This approach persists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execution state to a SQLite database, enabling structured queries, atomic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  transactions, and flexible schema evolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires: sqlite3 CLI tool in PATH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../prose.md: VM execution semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - filesystem.md: File-based state (default, more prescriptive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - in-context.md: In-context state (for simple programs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - ../primitives/session.md: Session context and compaction guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# SQLite State Management (Experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document describes how the OpenProse VM tracks execution state using a **SQLite database**. This is an experimental alternative to file-based state (`filesystem.md`) and in-context state (`in-context.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requires:** The `sqlite3` command-line tool must be available in your PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Platform | Installation                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| macOS    | Pre-installed                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Linux    | `apt install sqlite3` / `dnf install sqlite3` / etc.       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Windows  | `winget install SQLite.SQLite` or download from sqlite.org |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `sqlite3` is not available, the VM will fall back to filesystem state and warn the user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SQLite state provides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Atomic transactions**: State changes are ACID-compliant（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Structured queries**: Find specific bindings, filter by status, aggregate results（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Flexible schema**: Add columns and tables as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Single-file portability**: The entire run state is one `.db` file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Concurrent access**: SQLite handles locking automatically（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key principle:** The database is a flexible workspace. The VM and subagents share it as a coordination mechanism, not a rigid contract.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Database Location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The database lives within the standard run directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/{YYYYMMDD}-{HHMMSS}-{random}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── state.db          # SQLite database (this file)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── program.prose     # Copy of running program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── attachments/      # Large outputs that don't fit in DB (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Run ID format:** Same as filesystem state: `{YYYYMMDD}-{HHMMSS}-{random6}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: `.prose/runs/20260116-143052-a7b3c9/state.db`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Project-Scoped and User-Scoped Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution-scoped agents (the default) live in the per-run `state.db`. However, **project-scoped agents** (`persist: project`) and **user-scoped agents** (`persist: user`) must survive across runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For project-scoped agents, use a separate database:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── agents.db                 # Project-scoped agent memory (survives runs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {id}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        └── state.db          # Execution-scoped state (dies with run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For user-scoped agents, use a database in the home directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents.db                 # User-scoped agent memory (survives across projects)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `agents` and `agent_segments` tables for project-scoped agents live in `.prose/agents.db`, and for user-scoped agents live in `~/.prose/agents.db`. The VM initializes these databases on first use and provides the correct path to subagents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Responsibility Separation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This section defines **who does what**. This is the contract between the VM and subagents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### VM Responsibilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM (the orchestrating agent running the .prose program) is responsible for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Responsibility            | Description                                                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | -------------------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Database creation**     | Create `state.db` and initialize core tables at run start                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Program registration**  | Store the program source and metadata                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Execution tracking**    | Update position, status, and timing as statements execute                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Subagent spawning**     | Spawn sessions via Task tool with database path and instructions                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Parallel coordination** | Track branch status, implement join strategies                                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Loop management**       | Track iteration counts, evaluate conditions                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Error aggregation**     | Record failures, manage retry state                                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Context preservation**  | Maintain sufficient narration in the main conversation thread so execution can be understood and resumed |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Completion detection**  | Mark the run as complete when finished                                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** The VM must preserve enough context in its own conversation to understand execution state without re-reading the entire database. The database is for coordination and persistence, not a replacement for working memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Subagent Responsibilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subagents (sessions spawned by the VM) are responsible for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Responsibility          | Description                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ----------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Writing own outputs** | Insert/update their binding in the `bindings` table               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Memory management**   | For persistent agents: read and update their memory record        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Segment recording**   | For persistent agents: append segment history                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Attachment handling** | Write large outputs to `attachments/` directory, store path in DB |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Atomic writes**       | Use transactions when updating multiple related records           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** Subagents write ONLY to `bindings`, `agents`, and `agent_segments` tables. The VM owns the `execution` table entirely. Completion signaling happens through the substrate (Task tool return), not database updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** Subagents must write their outputs directly to the database. The VM does not write subagent outputs—it only reads them after the subagent completes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What subagents return to the VM:** A confirmation message with the binding location—not the full content:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Root scope:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/state.db (bindings table, name='research', execution_id=NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: AI safety research covering alignment, robustness, and interpretability with 15 citations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside block invocation:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260116-143052-a7b3c9/state.db (bindings table, name='result', execution_id=43)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 sub-parts for recursive processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM tracks locations, not values. This keeps the VM's context lean and enables arbitrarily large intermediate values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Shared Concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Concern          | Who Handles                                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------- | ------------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Schema evolution | Either (use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` as needed) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Custom tables    | Either (prefix with `x_` for extensions)                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Indexing         | Either (add indexes for frequently-queried columns)                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Cleanup          | VM (at run end, optionally vacuum)                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core Schema（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM initializes these tables. This is a **minimum viable schema**—extend freely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Run metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS run (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id TEXT PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    program_path TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    program_source TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    started_at TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status TEXT DEFAULT 'running',  -- running, completed, failed, interrupted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    state_mode TEXT DEFAULT 'sqlite'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Execution position and history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS execution (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id INTEGER PRIMARY KEY AUTOINCREMENT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statement_index INTEGER,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    statement_text TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status TEXT,  -- pending, executing, completed, failed, skipped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    started_at TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    completed_at TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    error_message TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    parent_id INTEGER REFERENCES execution(id),  -- for nested blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metadata TEXT  -- JSON for construct-specific data (loop iteration, parallel branch, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- All named values (input, output, let, const)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS bindings (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    execution_id INTEGER,  -- NULL for root scope, non-null for block invocations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    kind TEXT,  -- input, output, let, const（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    value TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    source_statement TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    created_at TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    attachment_path TEXT,  -- if value is too large, store path to file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    PRIMARY KEY (name, IFNULL(execution_id, -1))  -- IFNULL handles NULL for root scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Persistent agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS agents (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name TEXT PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope TEXT,  -- execution, project, user, custom（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memory TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    created_at TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at TEXT DEFAULT (datetime('now'))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Agent invocation history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS agent_segments (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id INTEGER PRIMARY KEY AUTOINCREMENT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agent_name TEXT REFERENCES agents(name),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    segment_number INTEGER,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    timestamp TEXT DEFAULT (datetime('now')),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    summary TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    UNIQUE(agent_name, segment_number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Import registry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE IF NOT EXISTS imports (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    alias TEXT PRIMARY KEY,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    source_url TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    fetched_at TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    inputs_schema TEXT,  -- JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    outputs_schema TEXT  -- JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Schema Conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Timestamps**: Use ISO 8601 format (`datetime('now')`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **JSON fields**: Store structured data as JSON text in `metadata`, `*_schema` columns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Large values**: If a binding value exceeds ~100KB, write to `attachments/{name}.md` and store path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Extension tables**: Prefix with `x_` (e.g., `x_metrics`, `x_audit_log`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Anonymous bindings**: Sessions without explicit capture (`session "..."` without `let x =`) use auto-generated names: `anon_001`, `anon_002`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Import bindings**: Prefix with import alias for scoping: `research.findings`, `research.sources`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Scoped bindings**: Use `execution_id` column—NULL for root scope, non-null for block invocations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scope Resolution Query（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For recursive blocks, bindings are scoped to their execution frame. Resolve variables by walking up the call stack:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Find binding 'result' starting from execution_id 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WITH RECURSIVE scope_chain AS (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -- Start with current execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT id, parent_id FROM execution WHERE id = 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  UNION ALL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -- Walk up to parent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT e.id, e.parent_id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  FROM execution e（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  JOIN scope_chain s ON e.id = s.parent_id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT b.* FROM bindings b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LEFT JOIN scope_chain s ON b.execution_id = s.id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE b.name = 'result'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND (b.execution_id IN (SELECT id FROM scope_chain) OR b.execution_id IS NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  CASE WHEN b.execution_id IS NULL THEN 1 ELSE 0 END,  -- Prefer scoped over root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  s.id DESC NULLS LAST  -- Prefer deeper (more local) scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Simpler version if you know the scope chain:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Direct lookup: check current scope, then parent, then root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT * FROM bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE name = 'result'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND (execution_id = 43 OR execution_id = 42 OR execution_id IS NULL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY execution_id DESC NULLS LAST（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Database Interaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Both VM and subagents interact via the `sqlite3` CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### From the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Initialize database（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "CREATE TABLE IF NOT EXISTS..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update execution position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT INTO execution (statement_index, statement_text, status, started_at)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES (3, 'session \"Research AI safety\"', 'executing', datetime('now'))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Read a binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 -json .prose/runs/20260116-143052-a7b3c9/state.db "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT value FROM bindings WHERE name = 'research'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check parallel branch status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  SELECT statement_text, status FROM execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  WHERE json_extract(metadata, '$.parallel_id') = 'p1'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### From Subagents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM provides the database path and instructions when spawning:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Root scope (outside block invocations):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your output database is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  .prose/runs/20260116-143052-a7b3c9/state.db（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When complete, write your output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT OR REPLACE INTO bindings (name, execution_id, kind, value, source_statement, updated_at)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'research',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    NULL,  -- root scope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'AI safety research covers alignment, robustness...',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let research = session: researcher',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    datetime('now')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside block invocation (include execution_id):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  execution_id: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  block: process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  depth: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your output database is:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  .prose/runs/20260116-143052-a7b3c9/state.db（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When complete, write your output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  INSERT OR REPLACE INTO bindings (name, execution_id, kind, value, source_statement, updated_at)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'result',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    43,  -- scoped to this execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'Processed chunk into 3 sub-parts...',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    'let result = session \"Process chunk\"',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    datetime('now')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  )（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For persistent agents (execution-scoped):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your memory is in the database:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  .prose/runs/20260116-143052-a7b3c9/state.db（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read your current state:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sqlite3 -json .prose/runs/20260116-143052-a7b3c9/state.db "SELECT memory FROM agents WHERE name = 'captain'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Update when done:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "UPDATE agents SET memory = '...', updated_at = datetime('now') WHERE name = 'captain'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Record this segment:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sqlite3 .prose/runs/20260116-143052-a7b3c9/state.db "INSERT INTO agent_segments (agent_name, segment_number, prompt, summary) VALUES ('captain', 3, '...', '...')"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For project-scoped agents, use `.prose/agents.db`. For user-scoped agents, use `~/.prose/agents.db`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context Preservation in Main Thread（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**This is critical.** The database is for persistence and coordination, but the VM must still maintain conversational context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What the VM Must Narrate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Even with SQLite state, the VM should narrate key events in its conversation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Position] Statement 3: let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Spawning session, will write to state.db（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   [Task tool call]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Success] Session complete, binding written to DB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Binding] research = <stored in state.db>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why Both?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Purpose                   | Mechanism                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | -------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Working memory**        | Conversation narration (what the VM "remembers" without re-querying) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Durable state**         | SQLite database (survives context limits, enables resumption)        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Subagent coordination** | SQLite database (shared access point)                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Debugging/inspection**  | SQLite database (queryable history)                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The narration is the VM's "mental model" of execution. The database is the "source of truth" for resumption and inspection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parallel Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For parallel blocks, the VM uses the `metadata` JSON field to track branches. **Only the VM writes to the `execution` table.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM marks parallel start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO execution (statement_index, statement_text, status, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES (5, 'parallel:', 'executing', '{"parallel_id": "p1", "strategy": "all", "branches": ["a", "b", "c"]}');（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM creates execution record for each branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO execution (statement_index, statement_text, status, parent_id, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES (6, 'a = session "Task A"', 'executing', 5, '{"parallel_id": "p1", "branch": "a"}');（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Subagent writes its output to bindings table (see "From Subagents" section)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Task tool signals completion to VM via substrate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM marks branch complete after Task returns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE execution SET status = 'completed', completed_at = datetime('now')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE json_extract(metadata, '$.parallel_id') = 'p1' AND json_extract(metadata, '$.branch') = 'a';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- VM checks if all branches complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT COUNT(*) as pending FROM execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE json_extract(metadata, '$.parallel_id') = 'p1' AND status != 'completed';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Loop Tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Loop metadata tracks iteration state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO execution (statement_index, statement_text, status, metadata)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES (10, 'loop until **analysis complete** (max: 5):', 'executing',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  '{"loop_id": "l1", "max_iterations": 5, "current_iteration": 0, "condition": "**analysis complete**"}');（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Update iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET metadata = json_set(metadata, '$.current_iteration', 2),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    updated_at = datetime('now')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE json_extract(metadata, '$.loop_id') = 'l1';（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Record failure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET status = 'failed',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    error_message = 'Connection timeout after 30s',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    completed_at = datetime('now')（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE id = 15;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Track retry attempts in metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UPDATE execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SET metadata = json_set(metadata, '$.retry_attempt', 2, '$.max_retries', 3)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE id = 15;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Large Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a binding value is too large for comfortable database storage (>100KB):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Write content to `attachments/{binding_name}.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Store the path in the `attachment_path` column（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Leave `value` as a summary or null（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
INSERT INTO bindings (name, kind, value, attachment_path, source_statement)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
VALUES (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'full_report',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'let',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'Full analysis report (847KB) - see attachment',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'attachments/full_report.md',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  'let full_report = session "Generate comprehensive report"'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Resuming Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To resume an interrupted run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Find current position（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT statement_index, statement_text, status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE status = 'executing'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ORDER BY id DESC LIMIT 1;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Get all completed bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT name, kind, value, attachment_path FROM bindings;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Get agent memory states（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT name, memory FROM agents;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Check parallel block status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SELECT json_extract(metadata, '$.branch') as branch, status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
FROM execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WHERE json_extract(metadata, '$.parallel_id') IS NOT NULL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  AND parent_id = (SELECT id FROM execution WHERE status = 'executing' AND statement_text LIKE 'parallel:%');（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Flexibility Encouragement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unlike filesystem state, SQLite state is intentionally **less prescriptive**. The core schema is a starting point. You are encouraged to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Add columns** to existing tables as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Create extension tables** (prefix with `x_`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Store custom metrics** (timing, token counts, model info)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Build indexes** for your query patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use JSON functions** for semi-structured data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example extensions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sql（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Custom metrics table（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE TABLE x_metrics (（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    execution_id INTEGER REFERENCES execution(id),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metric_name TEXT,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    metric_value REAL,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    recorded_at TEXT DEFAULT (datetime('now'))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Add custom column（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ALTER TABLE bindings ADD COLUMN token_count INTEGER;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
-- Create index for common query（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CREATE INDEX idx_execution_status ON execution(status);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The database is your workspace. Use it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Comparison with Other Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Aspect                 | filesystem.md             | in-context.md        | sqlite.md                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ------------------------- | -------------------- | ----------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **State location**     | `.prose/runs/{id}/` files | Conversation history | `.prose/runs/{id}/state.db`   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Queryable**          | Via file reads            | No                   | Yes (SQL)                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Atomic updates**     | No                        | N/A                  | Yes (transactions)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Schema flexibility** | Rigid file structure      | N/A                  | Flexible (add tables/columns) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Resumption**         | Read state.md             | Re-read conversation | Query database                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Complexity ceiling** | High                      | Low (<30 statements) | High                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Dependency**         | None                      | None                 | sqlite3 CLI                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Status**             | Stable                    | Stable               | **Experimental**              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SQLite state management:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Uses a **single database file** per run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Provides **clear responsibility separation** between VM and subagents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Enables **structured queries** for state inspection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Supports **atomic transactions** for reliable updates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Allows **flexible schema evolution** as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Requires the **sqlite3 CLI** tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Is **experimental**—expect changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The core contract: the VM manages execution flow and spawns subagents; subagents write their own outputs directly to the database. Both maintain the principle that what happens is recorded, and what is recorded can be queried.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
