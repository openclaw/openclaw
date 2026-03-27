# Phase 6: Queue & Heartbeat - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents autonomously discover, claim, and work on tasks with interruption resilience. This phase connects the existing heartbeat system to the queue/task system (built in Phases 2-4) using capability matching (Phase 5). Deliverables: a pre-heartbeat queue scanner, task claiming with checkpoint JSON, dependency checking, active task short-circuit, and resume-after-compaction support.

</domain>

<decisions>
## Implementation Decisions

### Heartbeat Integration

- **D-01:** Pre-heartbeat scan — new function runs BEFORE the heartbeat prompt is built. Scans queue.md, matches capabilities, and if a claimable task is found, claims it immediately (updates queue.md with lock) before the heartbeat prompt fires. Agent receives the claimed task context ready to work.
- **D-02:** Claim immediately — the scanner claims the task (moves to Claimed in queue.md) BEFORE the heartbeat prompt fires. Deterministic, no race window between scan and agent decision.
- **D-03:** Scanner code lives in `src/projects/heartbeat-scanner.ts`. Imports QueueManager and matchCapabilities. Called from the heartbeat runner. Keeps queue logic in the projects domain.

### Task Claiming Flow

- **D-04:** On claim: update task frontmatter (claimed_by, claimed_at, status to in-progress) AND create the checkpoint JSON sidecar file with initial state. Agent has a place to write progress from the start.
- **D-05:** Inject full task file content into the heartbeat prompt: "You have claimed TASK-005. Here is the task:\n\n[full markdown content]". Agent has everything it needs in one shot.
- **D-06:** Dependency check happens in the scanner, not the QueueManager. Scanner reads task files to check `depends_on` status before considering a task claimable. QueueManager stays focused on lock-protected queue.md operations.
- **D-07:** ALL dependencies must be Done for a task to be claimable. Standard dependency semantics.
- **D-08:** When multiple tasks are claimable, highest priority wins (critical > high > medium > low), then position in queue.md breaks ties (first listed wins). Deterministic and respects user-set priority.

### Checkpoint and Resume Format

- **D-09:** Checkpoint data stored as JSON sidecar file: `tasks/TASK-005.checkpoint.json` alongside the task markdown. Machine-readable, atomic writes. Task .md stays clean for humans.
- **D-10:** Full checkpoint schema: `{status, claimed_by, claimed_at, last_step, next_action, progress_pct, files_modified, failed_approaches: [{approach, reason}], log: [{timestamp, agent, action}], notes}`. The `failed_approaches` field is critical — prevents successive sessions from re-attempting dead ends (per Anthropic's long-running agent harness guidance).
- **D-11:** Agent commits code at natural milestones AND updates checkpoint JSON. Git provides recoverable state, JSON provides quick-read resume context. Both mechanisms working together.
- **D-12:** On resume after compaction, the pre-heartbeat scanner reads the checkpoint JSON and injects it alongside the task file content into the heartbeat prompt. Agent sees full state: what was done, what failed, what's next.

### Active Task Short-Circuit

- **D-13:** Scanner detects active tasks by scanning `.checkpoint.json` files in the project's `tasks/` directory where `claimed_by` matches the current agent AND `status` is "in-progress". If found, skip queue scanning and inject the active task instead.
- **D-14:** For active tasks, inject both the task markdown (description, acceptance criteria) and the checkpoint JSON (progress, next_action, failed_approaches). Agent has full context to resume work immediately.
- **D-15:** No automatic stale task timeout/auto-release in the scanner code. Stale detection is handled by the orchestrator agent (future phase) through its own 30-minute heartbeat cycle: check active tasks, message the working agent's channel to wake/verify, reset to last checkpoint if agent is truly lost.

### Claude's Discretion

- Exact heartbeat prompt format for claimed/resumed tasks (as long as it includes full task content + checkpoint JSON)
- Internal helper function organization within heartbeat-scanner.ts
- Error handling when checkpoint JSON is corrupted or missing (graceful degradation)

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Heartbeat System

- `src/infra/heartbeat-runner.ts` — Main heartbeat runner, entry point for pre-heartbeat scan integration
- `src/auto-reply/heartbeat.ts` — Heartbeat prompt resolution, HEARTBEAT_OK pattern
- `src/agents/bootstrap-files.ts` — BootstrapContextRunKind ("heartbeat"), resolveBootstrapFilesForRun

### Queue and Task System

- `src/projects/queue-manager.ts` — QueueManager class with lock-protected claimTask/releaseTask/moveTask
- `src/projects/queue-parser.ts` — parseQueue, QueueEntry, ParsedQueue types
- `src/projects/schemas.ts` — TaskFrontmatterSchema (capabilities, depends_on, claimed_by, claimed_at fields)
- `src/projects/capability-matcher.ts` — matchCapabilities with ANY-match semantics
- `src/projects/templates.ts` — generateQueueMd with Available/Claimed/Done/Blocked sections

### Agent System

- `src/agents/identity-file.ts` — parseIdentityMarkdown with capabilities field
- `src/agents/workspace.ts` — WorkspaceBootstrapFileName union, DEFAULT_HEARTBEAT_FILENAME
- `src/agents/agent-scope.ts` — resolveAgentConfig, resolveAgentWorkspaceDir, resolveDefaultAgentId

### Long-Running Agent Patterns (External)

- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — Checkpoint, progress files, failed approaches tracking
- https://www.anthropic.com/engineering/harness-design-long-running-apps — Context resets, handoff artifacts, end-state evaluation

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `QueueManager` (Phase 4): Lock-protected claimTask/releaseTask/moveTask — use directly for queue.md updates
- `matchCapabilities` (Phase 5): ANY-match capability matcher — use for filtering claimable tasks
- `parseIdentityMarkdown` (Phase 5): Extracts agent capabilities from IDENTITY.md
- `withFileLock` from `src/plugin-sdk/file-lock.ts`: Underlying lock mechanism used by QueueManager
- `TaskFrontmatterSchema`: Already has capabilities, depends_on, claimed_by, claimed_at fields

### Established Patterns

- Heartbeat runner uses `BootstrapContextRunKind = "heartbeat"` to signal lightweight context mode
- Bootstrap files pipeline: `resolveBootstrapFilesForRun()` → `applyBootstrapHookOverrides()` → prompt injection
- Heartbeat prompt defaults to reading HEARTBEAT.md from workspace, replies HEARTBEAT_OK if nothing to do
- Session store at `~/.openclaw/sessions/` tracks per-agent session state

### Integration Points

- `src/infra/heartbeat-runner.ts` — Insert pre-heartbeat scan call before prompt building
- `src/projects/queue-manager.ts` — Extend with task file frontmatter updates on claim
- `tasks/*.checkpoint.json` — New file pattern, co-located with task markdown files

</code_context>

<specifics>
## Specific Ideas

- Checkpoint JSON design inspired by Anthropic's long-running agent harness guidance: track `failed_approaches` to prevent successive sessions from re-attempting dead ends
- Orchestrator agent (future phase) handles stale task detection via its own 30-minute heartbeat: checks active tasks, messages working agent to verify, resets to checkpoint if agent is lost
- Phase 6 provides the primitives (read checkpoint, release task, reset to checkpoint) that the orchestrator will consume later

</specifics>

<deferred>
## Deferred Ideas

- Orchestrator agent with stale task detection and recovery — future phase (needs agent-to-agent messaging)
- Multi-project scanning (agent scans multiple projects' queues) — evaluate after single-project works
- Task priority escalation (auto-bump priority after time in queue) — Phase 2 feature

</deferred>

---

_Phase: 06-queue-heartbeat_
_Context gathered: 2026-03-27_
