# Pitfalls Research

**Project:** OpenClaw Project Management System
**Dimension:** Common mistakes and failure modes
**Date:** 2026-03-26

## 1. File Watcher Race Conditions

**Pitfall:** Agent writes markdown, watcher fires mid-write, indexer reads partial file, generates corrupt JSON.

**Warning signs:** Truncated frontmatter in `.index/` files, intermittent UI rendering errors, "invalid YAML" parse errors in logs.

**Prevention:**

- Use chokidar's `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }` — already proven in `src/gateway/config-reload.ts`
- Debounce watcher callbacks (existing config-reload pattern uses this)
- Wrap frontmatter parsing in try/catch — skip corrupt files, log warning, retry on next change
- Consider atomic writes: agents write to `.tmp` then rename (rename is atomic on most filesystems)

**Phase:** 1 (Foundation — file watcher implementation)

## 2. Queue.md Concurrent Write Corruption

**Pitfall:** Two agents try to claim tasks simultaneously, both read queue.md, both write their claim, second write overwrites first claim silently.

**Warning signs:** Tasks claimed by agent A but queue.md shows agent B, duplicate work, agents working on same task.

**Prevention:**

- File-level `.lock` via `mkdir` (atomic on POSIX) — design spec already specifies this
- Lock held only during queue read-modify-write cycle (<100ms)
- Stale lock detection: if `.lock` older than 60 seconds, force-clear (Phase 1) or PM agent clears (Phase 2)
- Validate after write: re-read queue.md and confirm claim persisted

**Phase:** 1 (Agent integration — queue claiming)

## 3. Frontmatter Parser Type Mismatch

**Pitfall:** Existing `parseFrontmatterBlock()` at `src/markdown/frontmatter.ts` returns `Record<string, string>` — flattens everything to strings. Design spec needs arrays (`tags`, `capabilities`, `columns`) and nested objects (`dashboard.widgets`).

**Warning signs:** `capabilities` parsed as `"[code, ui]"` string instead of `["code", "ui"]` array, widget config not loading.

**Prevention:**

- Create a parallel typed parser (`src/projects/frontmatter.ts`) that calls `yaml.parse()` directly
- Validate parsed output with Zod schemas per file type (ProjectSchema, TaskSchema, QueueSchema)
- Do NOT modify existing `parseFrontmatterBlock()` — other callers depend on current behavior

**Phase:** 1 (Foundation — data model)

## 4. .index/ JSON Drift from Markdown

**Pitfall:** Agent updates markdown but watcher misses the event (disk full, watcher crashed, race condition). UI shows stale data indefinitely.

**Warning signs:** Dashboard counts don't match actual task files, "ghost" tasks that were completed but still show as in-progress.

**Prevention:**

- Full regeneration on gateway startup (catches any drift accumulated while gateway was down)
- `openclaw projects reindex` CLI command for manual recovery
- Periodic consistency check (optional cron: compare `.index/board.json` task count vs `tasks/*.md` file count)
- `.index/` is always deletable and regeneratable — make this a documented recovery step

**Phase:** 1 (Sync process)

## 5. UI Performance with Many Projects/Tasks

**Pitfall:** Reading `.index/project.json` for every project on sidebar render. With 50+ projects and hundreds of tasks, UI becomes sluggish.

**Warning signs:** Sidebar takes >500ms to render, kanban board lags when switching projects, WebSocket event storms.

**Prevention:**

- Start with broadcast-all WebSocket events; add project-scoped subscriptions if performance requires it
- Lazy-load project details — sidebar shows name/status from a lightweight global index, full dashboard loads on click
- Paginate task lists in kanban columns (show first 20, load more on scroll)
- Consider a single `~/.openclaw/projects/.index/global.json` that aggregates all project summaries for the list view

**Phase:** 1 (UI implementation)

## 6. Agent Context Injection Breaking Existing Flow

**Pitfall:** Extending `post-compaction-context.ts` to detect PROJECT.md introduces a regression in the existing AGENTS.md pickup for non-project directories.

**Warning signs:** Agents lose workspace context after compaction, AGENTS.md sections stop loading, agent behavior changes in non-project contexts.

**Prevention:**

- PROJECT.md detection is additive — append to existing flow, don't modify AGENTS.md logic
- Isolated test: verify AGENTS.md still loads correctly when PROJECT.md is absent
- Isolated test: verify PROJECT.md loads when present, AGENTS.md still loads from workspace root
- Feature flag or config toggle for PROJECT.md injection during rollout

**Phase:** 1 (Agent integration)

## 7. Heartbeat Task Pickup Overload

**Pitfall:** Every agent on every heartbeat scans every project's queue.md. With 10 agents and 20 projects, that's 200 file reads per heartbeat cycle.

**Warning signs:** Heartbeat cycles taking longer, file system I/O spikes, agents slow to respond to messages.

**Prevention:**

- Agent scoping: agents only scan projects they're assigned to (design spec already includes this)
- Cache queue state in memory, invalidate on watcher event (watcher already exists for UI sync)
- Stagger heartbeats: don't have all agents wake up at exactly the same time
- Short-circuit: if agent already has a claimed task, skip queue scanning

**Phase:** 1 (Agent integration — heartbeat)

## 8. Task ID Collision in Sub-Projects

**Pitfall:** Parent project has TASK-001, sub-project also has TASK-001. References become ambiguous in logs, dashboard, and agent communication.

**Warning signs:** Wrong task details shown in dashboard, agents working on parent task when sub-project task was intended.

**Prevention:**

- Design spec says IDs are sequential per project with independent sequences — this is correct
- In UI and logs, always qualify with project path: `my-project/TASK-001` vs `my-project/auth-system/TASK-001`
- Queue.md references should include the project context (they're per-project files, so this is implicit)

**Phase:** 1 (Data model — task ID generation)

## 9. Lock File Left Behind on Crash

**Pitfall:** Agent crashes between creating `.lock` and deleting it. Lock persists forever, blocking all future queue operations for that project.

**Warning signs:** "Project queue is locked" error on every claim attempt, no agent can pick up new work.

**Prevention:**

- Phase 1: stale lock older than 60 seconds is force-cleared
- Phase 2: PM agent clears stale locks on heartbeat
- Write PID and timestamp into lock file content for diagnostics
- `openclaw projects reindex` should also clear stale locks

**Phase:** 1 (Concurrency — lock management)

## 10. YAML Frontmatter Edge Cases

**Pitfall:** Agent writes malformed YAML (unclosed quotes, tabs instead of spaces, special characters in task titles). Parser fails, indexer skips the file, task disappears from UI.

**Warning signs:** Tasks visible in filesystem but missing from kanban, parse error warnings in logs.

**Prevention:**

- Zod validation with `.safeParse()` — returns error details instead of throwing
- Log parse failures with file path and line number for easy debugging
- UI shows "N files failed to parse" warning on dashboard if any tasks couldn't be indexed
- Provide a `openclaw projects validate` CLI command that checks all frontmatter

**Phase:** 1 (Foundation — frontmatter parsing)

## Summary

| Priority | Pitfall                            | Risk          | Phase |
| -------- | ---------------------------------- | ------------- | ----- |
| Critical | Queue concurrent write corruption  | HIGH          | 1     |
| Critical | File watcher race conditions       | HIGH          | 1     |
| High     | Frontmatter parser type mismatch   | MEDIUM        | 1     |
| High     | Agent context injection regression | MEDIUM        | 1     |
| Medium   | .index/ JSON drift                 | MEDIUM        | 1     |
| Medium   | Lock file left behind              | MEDIUM        | 1     |
| Medium   | YAML frontmatter edge cases        | MEDIUM        | 1     |
| Low      | UI performance with many projects  | LOW (Phase 1) | 1     |
| Low      | Heartbeat pickup overload          | LOW (Phase 1) | 1     |
| Low      | Task ID collision in sub-projects  | LOW           | 1     |
