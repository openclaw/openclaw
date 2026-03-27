# Phase 6: Queue & Heartbeat - Research

## Heartbeat System Architecture

### Entry Point
- `src/infra/heartbeat-runner.ts` — `runHeartbeatOnce(opts)` is the main entry point
- Called from the cron/timer system on a configurable interval (default 30m)
- Returns `HeartbeatRunResult` with `status: "skipped" | "ok" | "error"` and `reason`

### Heartbeat Flow (runHeartbeatOnce)
1. Load config, resolve agent ID from session key
2. Check enabled/disabled gates (areHeartbeatsEnabled, isHeartbeatEnabledForAgent, interval check)
3. Check active hours and queue size (skip if requests in-flight)
4. `resolveHeartbeatPreflight()` — trigger classification, event inspection, HEARTBEAT.md gating
5. Optionally create isolated session (heartbeat.isolatedSession)
6. Resolve delivery target (channel, account)
7. **Build prompt** (lines 516-521): selects base prompt based on exec completion events, cron events, or default heartbeat prompt
8. Run agent with prompt via `getReplyFromConfig()`
9. Process reply, deliver outbound payloads

### Pre-Heartbeat Scan Integration Point
The scan should happen between step 4 (preflight) and step 7 (prompt building). At this point:
- Agent ID is resolved (`agentId` variable)
- Config is loaded (`cfg` variable)
- We know the heartbeat is going to fire (preflight passed)
- Workspace dir is resolved via `resolveAgentWorkspaceDir(cfg, agentId)`

The scan result should influence the prompt built in step 7. If a task is claimed/resumed, the heartbeat prompt should include task context instead of the default "Read HEARTBEAT.md" prompt.

### Prompt Building
```typescript
// Lines 516-521 of heartbeat-runner.ts
const basePrompt = hasExecCompletion
  ? buildExecEventPrompt(...)
  : hasCronEvents
    ? buildCronEventPrompt(...)
    : resolveHeartbeatPrompt(params.cfg, params.heartbeat);
```

The scan prompt should be a new branch: if task claimed/resumed, use a task-specific prompt. Otherwise fall through to existing logic.

## Queue Manager (Phase 4 Deliverable)

### Available Methods
- `claimTask(projectDir, taskId, agentId)` — Lock-protected claim. Moves entry from Available to Claimed in queue.md. Updates task frontmatter (claimed_by, claimed_at, status).
- `releaseTask(projectDir, taskId)` — Move back from Claimed to Available
- `moveTask(projectDir, taskId, fromSection, toSection)` — Move between any sections
- `readQueue(projectDir)` — Read and parse queue.md

### Lock Mechanism
- Uses `withFileLock` from `src/plugin-sdk/file-lock.ts`
- Lock file: `queue.md.lock` sidecar
- 3 retries, exponential backoff (50ms-200ms), 60s stale threshold
- Throws `QueueLockError` when retries exhausted

### QueueEntry Type
```typescript
interface QueueEntry {
  id: string;      // e.g., "TASK-005"
  title: string;   // Task title from queue line
  section: string; // "available" | "claimed" | "done" | "blocked"
}
```

## Capability Matching (Phase 5 Deliverable)

### matchCapabilities(agentCapabilities, taskCapabilities)
- Returns `true` if agent has at least ONE matching capability (ANY-match)
- Returns `true` if task has no capability requirements (empty array)
- Returns `false` if task has requirements but agent has no capabilities

### Agent Capabilities Source
- Parsed from IDENTITY.md by `parseIdentityMarkdown()`
- Format: `- capabilities: code, testing, ui` (bullet with comma-separated values)
- Returns `capabilities?: string[]` on `AgentIdentityFile`

## Task File Structure

### Frontmatter (TaskFrontmatterSchema)
```yaml
id: TASK-005
title: Fix authentication bug
status: backlog | in-progress | review | done | blocked
column: Backlog | In Progress | Review | Done
priority: low | medium | high | critical
capabilities: [code, testing]
depends_on: [TASK-003, TASK-004]
claimed_by: null | agent-alpha
claimed_at: null | 2026-03-27T10:30:00Z
created: 2026-03-27
updated: 2026-03-27
parent: null | parent-project
```

### Checkpoint JSON Sidecar (New in Phase 6)
File: `tasks/TASK-005.checkpoint.json`
```json
{
  "status": "in-progress",
  "claimed_by": "agent-alpha",
  "claimed_at": "2026-03-27T10:30:00Z",
  "last_step": "Created auth module with JWT verification",
  "next_action": "Add unit tests for token validation",
  "progress_pct": 40,
  "files_modified": ["src/auth/jwt.ts", "src/auth/middleware.ts"],
  "failed_approaches": [
    { "approach": "Used passport.js", "reason": "Too heavy for simple JWT validation" }
  ],
  "log": [
    { "timestamp": "2026-03-27T10:30:00Z", "agent": "agent-alpha", "action": "Claimed task" },
    { "timestamp": "2026-03-27T10:45:00Z", "agent": "agent-alpha", "action": "Created auth module" }
  ],
  "notes": "Using jose library for JWT operations per existing codebase pattern"
}
```

## HeartbeatScanner Design

### New File: `src/projects/heartbeat-scanner.ts`

### Core Function: `scanAndClaimTask(opts)`
```typescript
interface ScanAndClaimResult {
  type: "claimed" | "resumed" | "idle";
  task?: { id: string; path: string; content: string };
  checkpoint?: CheckpointData;
}

async function scanAndClaimTask(opts: {
  agentId: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
}): Promise<ScanAndClaimResult>
```

### Algorithm
1. Resolve project directory from agent config (`agents.project` field) or cwd walk-up
2. Check for active task: scan `tasks/*.checkpoint.json` for `claimed_by === agentId && status === "in-progress"`
3. If active task found → return `{ type: "resumed", task, checkpoint }` (AGNT-08 short-circuit)
4. If no active task → scan queue.md Available section:
   a. Parse queue entries
   b. For each entry, read task file frontmatter
   c. Filter: capability match (matchCapabilities), all dependencies Done, not blocked
   d. Sort: priority (critical > high > medium > low), then queue position
   e. Claim first matching task via QueueManager.claimTask()
   f. Create checkpoint.json sidecar with initial state
   g. Return `{ type: "claimed", task, checkpoint }`
5. If no claimable task → return `{ type: "idle" }`

### Dependency Resolution
- For each task in Available, read `depends_on` from frontmatter
- For each dependency ID, find the task file and check its `status` field
- ALL must be `"done"` for the task to be claimable
- Missing dependency files → treat as not done (safe default)

### Priority Sorting
```typescript
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
tasks.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.queuePosition - b.queuePosition);
```

## Testing Strategy

### Unit Tests for heartbeat-scanner.ts
1. `scanAndClaimTask returns "idle" when no projects configured`
2. `scanAndClaimTask returns "idle" when queue has no Available tasks`
3. `scanAndClaimTask returns "claimed" with highest priority task`
4. `scanAndClaimTask skips tasks with unmet dependencies`
5. `scanAndClaimTask skips tasks with no capability match`
6. `scanAndClaimTask returns "resumed" when active checkpoint exists`
7. `scanAndClaimTask creates checkpoint.json on claim`
8. `scanAndClaimTask priority sort: critical > high > medium > low`
9. `scanAndClaimTask ALL deps must be done (not ANY)`
10. `scanAndClaimTask no capabilities agent cannot claim gated tasks`

### Integration Point Test
11. `heartbeat runner uses scan result to modify prompt` (mock scanAndClaimTask)

### Checkpoint JSON Tests
12. `checkpoint.json created with correct initial schema`
13. `checkpoint.json read correctly on resume`
14. `corrupted checkpoint.json handled gracefully`

## Validation Architecture

### Dimension 1: Correctness
- Queue scanning finds and claims correct tasks
- Dependency resolution blocks correctly
- Priority ordering is deterministic

### Dimension 2: Safety
- Lock-protected claiming prevents double-claims
- Checkpoint file writes are atomic (write to temp, rename)
- Corrupted checkpoints don't crash heartbeat

### Dimension 3: Integration
- Heartbeat runner correctly calls scanner before prompt building
- Scanner uses existing QueueManager and matchCapabilities
- Prompt injection includes full task content + checkpoint data

### Dimension 4: Edge Cases
- Empty queue, no projects, no IDENTITY.md, corrupted checkpoint
- Agent with no capabilities, task with no dependencies
- Multiple projects (future) vs single project (current)
