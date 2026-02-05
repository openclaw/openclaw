# OpenClaw + AgentDash Unified Design

**Date:** 2026-02-05
**Status:** Draft
**Author:** Claude + James

---

## Vision

A "Codex Desktop-like" AI command center where a lead agent acts as dispatcher/context curator, delegating all execution to worker agents. The UI merges into OpenClaw as its official web interface.

## Goals

1. Lead agent never pollutes context with implementation details
2. Workers execute in isolated git worktrees
3. Shared context via markdown files (protocol-based, not direct messaging)
4. Significant changes go to review queue
5. Chat-centric UI with drill-down to workers

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         OpenClaw                                │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Gateway   │  │ Task Queue  │  │  Worktree Manager       │ │
│  │   (exists)  │  │   (new)     │  │  (new)                  │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Lead      │  │   Worker    │  │  Context Store          │ │
│  │   Agent     │  │   Agents    │  │  (.openclaw/ files)     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Web UI (from AgentDash)                    │   │
│  │         Chat-centric + task sidebar + review queue      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Lead Agent

### Role

The lead agent is a **context curator and dispatcher**, not a worker:

- Talks to user, understands intent
- Curates context (key decisions, constraints)
- Creates/manages tasks and tracks
- Delegates ALL execution to workers
- Summarizes results back to user
- NEVER does implementation work itself

### System Prompt (Core)

```markdown
You are a project lead. Your job is to:

1. UNDERSTAND what the user wants
2. CURATE context - identify relevant files, decisions, constraints
3. DELEGATE all implementation to worker agents
4. SUMMARIZE results back to the user

You NEVER:
- Write code yourself
- Execute commands directly
- Pollute your context with implementation details

When a user asks for something:
1. Clarify requirements if unclear
2. Break into tasks if complex
3. Update the shared context store with key decisions
4. Spawn workers for each task
5. Monitor progress, handle blockers
6. Present results (summarized or queued for review)
```

### Tools

| Tool | Purpose |
|------|---------|
| `tasks.create` | Create task for worker |
| `tasks.list` | Check task status |
| `context.update` | Add to shared context store |
| `context.read` | Read current context |
| `file.read` | Verify summaries (limited use) |
| `file.list` | See project structure |
| `workers.spawn` | Spawn worker for task |
| `workers.status` | Check worker progress |
| `reviews.list` | Check pending reviews |

**Not available:** `file.write`, `bash.exec` - lead delegates these.

---

## Worker Agents

### Role

Workers do actual implementation. Spawned by lead, execute in isolation, return structured results.

### Characteristics

| Aspect | Design |
|--------|--------|
| Isolation | Each worker gets its own git worktree |
| Context | Reads shared context store + task-specific instructions |
| Tools | Full toolset (file read/write, bash, etc.) |
| Lifetime | Spawned for task, terminated on completion |
| Results | Structured output (artifacts, context updates, summary) |

### Configuration

```yaml
agents:
  list:
    - id: "lead"
      model: "claude:opus-4"
      workspace: "~/project"
      tools: ["tasks.*", "context.*", "workers.*", "reviews.*", "file.read", "file.list"]

    - id: "worker-code"
      model: "claude:sonnet-4"
      sandbox: { mode: "worktree" }
      tools: ["file.*", "bash.*", "git.*"]

    - id: "worker-research"
      model: "claude:sonnet-4"
      tools: ["file.read", "grep", "web.search"]

    - id: "worker-test"
      model: "claude:sonnet-4"
      tools: ["file.*", "bash.exec", "test.*"]
```

### Result Structure

```typescript
type WorkerResult = {
  taskId: string;
  status: "complete" | "blocked" | "failed";

  // What was produced
  summary: string;           // Always present, for lead's context
  artifacts: Artifact[];     // Files created/modified

  // For dependent tasks
  contextUpdates: {
    key: string;
    value: any;
  }[];

  // If needs review (significant changes)
  requiresReview: boolean;
  diffStats?: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };

  // If blocked/failed
  blockedReason?: string;
};
```

### Auto-present vs Review Queue

| Task Type | Result Handling |
|-----------|-----------------|
| Research, questions | Auto-summarize to lead → user |
| Small fixes (<20 lines) | Auto-present with diff |
| New features, refactors | Queue for review |
| Test results | Auto-present pass/fail |
| Failures/blockers | Escalate to lead immediately |

---

## Shared Context Store

### Structure (Conductor-inspired)

```
project/
├── .openclaw/
│   ├── index.md              # Project context index
│   ├── product.md            # Vision, goals, users
│   ├── tech-stack.md         # Technologies
│   ├── workflow.md           # THE LAW - how work gets done
│   ├── guidelines.md         # Code style, conventions
│   ├── tracks.md             # Registry of all tracks/epics
│   │
│   ├── state.json            # Current state (resumable)
│   │
│   ├── skills/               # Project-specific skills
│   │   └── deploy/
│   │       ├── SKILL.md
│   │       └── scripts/
│   │
│   └── tracks/
│       └── <track_id>/
│           ├── spec.md       # Requirements
│           ├── plan.md       # Task breakdown with checkboxes
│           ├── context.md    # Decisions, learnings
│           └── metadata.json # Status, timestamps
```

### Who Updates What

| File | Lead | Worker |
|------|------|--------|
| `product.md` | Creates, updates | Reads only |
| `workflow.md` | Creates, updates | Reads only (THE LAW) |
| `tracks.md` | Updates status | Reads only |
| `spec.md` | Creates | Reads only |
| `plan.md` | Creates structure | Updates checkboxes, adds commit SHAs |
| `context.md` | Adds decisions | Adds learnings, blockers |

### Worker Context Loading

When a worker spawns, it automatically receives:

1. `workflow.md` - How to do work
2. `tracks/<track_id>/spec.md` - What to build
3. `tracks/<track_id>/plan.md` - Current task
4. `tracks/<track_id>/context.md` - Accumulated decisions
5. Task-specific instructions from lead

### Plan.md Format

```markdown
## Phase 1: Authentication

- [x] Design auth schema (SHA: a1b2c3d)
- [~] Implement JWT validation        ← currently running
- [ ] Add refresh token logic
- [ ] Write auth middleware tests
```

---

## Task Queue & Execution

### Task States

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ pending  │ ──▶ │  queued  │ ──▶ │ running  │ ──▶ │ complete │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                │                │                │
     │                │                │                ▼
     │                │                │          ┌──────────┐
     │                │                └────────▶ │  review  │
     │                │                           └──────────┘
     ▼                ▼                                │
┌──────────┐    ┌──────────┐                          ▼
│ blocked  │    │ cancelled│                    ┌──────────┐
└──────────┘    └──────────┘                    │ approved │
                                                └──────────┘
```

### Failure Handling

```
         ┌──────────┐
         │  failed  │◀────┐
         └────┬─────┘     │
              │ retry?    │
              ▼           │
         ┌──────────┐     │
         │ retrying │─────┘ (max 2 retries)
         └──────────┘
              │ exhausted
              ▼
         ┌──────────┐
         │ escalate │ → Lead asks user for help
         └──────────┘
```

### Task Definition

```typescript
type TaskDefinition = {
  id: string;
  trackId: string;
  title: string;
  description?: string;

  // Dependencies
  dependsOn?: string[];

  // Execution config
  workerType: "worker-code" | "worker-research" | "worker-test";
  requiresReview: boolean;
  maxRetries: number;
  timeoutMinutes: number;

  // Status
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
};
```

---

## Configuration

### Concurrency

```yaml
orchestration:
  concurrency:
    default: 3
    byTaskType:
      research: 5      # Lightweight, can run more
      code: 2          # Heavy, limit parallelism
      test: 3
    byHardware: auto   # Detect CPU cores, scale accordingly
```

### Conflict Resolution

```yaml
worktree:
  conflictStrategy: "sequential-merge"
  # Options:
  # - sequential-merge: Workers merge in completion order
  # - lead-resolves: Lead reviews conflicts, decides
  # - user-resolves: Conflicts queued for user review
```

### Context Management

```yaml
context:
  maxContextFileSize: 50KB
  archiveAfterDays: 30
  summarizeOnOverflow: true  # Lead summarizes old entries
```

### Security/Sandboxing

```yaml
workers:
  sandbox:
    mode: "docker"           # or "worktree-only"
    networkAccess: false     # No internet by default
    allowedPaths:
      - "${workspaceDir}"
      - "${worktreeDir}"
    blockedCommands:
      - "rm -rf /"
      - "sudo *"
```

### Cost/Token Limits

```yaml
workers:
  limits:
    maxTokensPerTask: 100000
    maxDurationMinutes: 30
    maxCostPerTask: 0.50     # USD
    onLimitReached: "pause-and-ask"
```

---

## New Gateway APIs

### Task Management

```
tasks.create(taskDef) → { taskId, queuePosition }
tasks.list(filter?) → TaskListResult
tasks.get(taskId) → TaskDetail
tasks.update(taskId, patch) → TaskDetail
tasks.cancel(taskId) → { ok, reason }
tasks.requeue(taskId, priority?) → { ok, newPosition }
```

### Job Execution & Tracking

```
jobs.list(filter?) → JobListResult
jobs.get(jobId) → JobDetail with result + artifacts
jobs.logs(jobId, startLine?, limit?) → { lines: LogEntry[] }
jobs.artifacts(jobId) → { files: ArtifactInfo[] }
```

### Git Worktree Integration

```
worktrees.create(taskId, baseRepo, branch) → { worktreeId, path }
worktrees.list(taskId?) → WorktreeInfo[]
worktrees.diff(worktreeId, baseBranch?) → DiffResult
worktrees.cleanup(worktreeId) → { ok }
worktrees.merge(sourceId, targetBranch, strategy?) → MergeResult
```

### Review Queue

```
reviews.list(filter?) → ReviewQueueItem[]
reviews.get(reviewId) → ReviewDetail with diff + metadata
reviews.approve(reviewId, metadata?) → { ok, mergeJobId }
reviews.reject(reviewId, reason) → { ok }
reviews.batch(action, reviewIds[]) → BatchResult
```

### Event Types (WebSocket)

```typescript
type TaskEvent =
  | { type: "task.created"; task: TaskDefinition }
  | { type: "task.queued"; taskId: string; position: number }
  | { type: "task.started"; taskId: string; jobId: string }
  | { type: "task.progress"; taskId: string; progress: number }
  | { type: "task.completed"; taskId: string; result: JobRecord }
  | { type: "task.failed"; taskId: string; error: string }
  | { type: "task.review.ready"; reviewId: string; taskId: string }
  | { type: "task.review.approved"; reviewId: string }
  | { type: "task.review.rejected"; reviewId: string; reason: string };
```

---

## What Gets Removed from AgentDash

**Duplicates OpenClaw (remove):**

- `sessions` table → use `sessions.list`
- `messages` table → use `chat.history`
- `agent_nodes` table → use `agents.list`
- `openclaw_session_mappings` table → unnecessary sync
- `session-sync.ts` → all 328 lines
- `sessions.ts` → reimplements OpenClaw
- Agent wrapper/ACP bridge → OpenClaw handles

**Unique (keep, merge into OpenClaw):**

- Web client React UI
- Projects as metadata layer
- Task board UI components
- Activity feed
- Review queue UI

---

## Implementation Phases

### Phase 1: Foundation (2-3 weeks)

- [ ] Create task schema and storage layer in OpenClaw
- [ ] Implement tasks.* API methods
- [ ] Add basic task status transitions
- [ ] Wire up WebSocket event broadcasting

### Phase 2: Worker Execution (2-3 weeks)

- [ ] Build task queue engine with concurrency limits
- [ ] Implement git worktree manager
- [ ] Integrate with existing subagent spawning
- [ ] Add job history persistence

### Phase 3: Lead Agent (1-2 weeks)

- [ ] Create lead agent configuration template
- [ ] Implement lead-specific tools
- [ ] Add context store management
- [ ] Test lead → worker flow

### Phase 4: Review Queue (1-2 weeks)

- [ ] Implement review queue storage
- [ ] Add approval/rejection flow
- [ ] Wire up merge on approval
- [ ] Add inline comment support

### Phase 5: Web UI (3-4 weeks)

- [ ] Port AgentDash React client to OpenClaw repo
- [ ] Implement chat-centric layout
- [ ] Add worker drill-down views
- [ ] Build review queue UI with diff viewer
- [ ] Add track/task management UI

### Phase 6: Polish (1-2 weeks)

- [ ] Add failure handling and retries
- [ ] Implement cost/token limits
- [ ] Security hardening
- [ ] Documentation

**Total: 10-16 weeks**

---

## References

- [Codex Desktop Features](https://developers.openai.com/codex/app/features)
- [Conductor Framework](https://github.com/gemini-cli-extensions/conductor)
- [Vercel Skills](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)
- [AGENTS.md vs Skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)

---

## Open Questions

1. Should the lead agent be a separate process or same process with different config?
2. How to handle very long-running workers (>30 min)?
3. Should review queue support collaborative review (multiple reviewers)?
4. Mobile/tablet UI considerations?
