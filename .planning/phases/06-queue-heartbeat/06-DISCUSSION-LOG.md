# Phase 6: Queue & Heartbeat - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-27
**Phase:** 06-queue-heartbeat
**Areas discussed:** Heartbeat integration point, Task claiming flow, Checkpoint and resume format, Active task short-circuit

---

## Heartbeat Integration Point

| Option | Description | Selected |
|--------|-------------|----------|
| Pre-heartbeat scan | New function runs BEFORE heartbeat prompt. Scans queue.md, matches capabilities, claims task if found. | ✓ |
| Separate heartbeat hook | Register internal hook on heartbeat event. Decoupled but adds hook complexity. | |
| Agent-driven via prompt | Tell agent to read queue.md itself. Simpler code but less deterministic. | |

**User's choice:** Pre-heartbeat scan (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Claim immediately | Scanner claims task before heartbeat prompt fires. Deterministic, no race window. | ✓ |
| Agent confirms claim | Scanner injects candidate, agent decides. More flexible but race window. | |

**User's choice:** Claim immediately (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| src/projects/heartbeat-scanner.ts | New file in projects module. Imports QueueManager and matchCapabilities. | ✓ |
| src/infra/heartbeat-queue.ts | In infra alongside heartbeat-runner.ts. Mixes project concerns into infra. | |
| Extend heartbeat-runner.ts | Inline in existing runner. Simpler but file already complex. | |

**User's choice:** src/projects/heartbeat-scanner.ts (Recommended)
**Notes:** None

---

## Task Claiming Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Update frontmatter + init sections | Set claimed_by, claimed_at, status. Add checkpoint/log sections. | ✓ |
| Update frontmatter only | Just set claimed_by, claimed_at, status. Agent creates sections. | |
| Don't touch task file | Only update queue.md. Minimal but split state. | |

**User's choice:** Update frontmatter + initialize sections (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Inject full task file content | Read task markdown and append to heartbeat prompt. | ✓ |
| Inject summary only | Just frontmatter fields. Agent reads full file itself. | |
| Inject file path only | Just tell agent the path. Lightest but wastes tokens. | |

**User's choice:** Inject full task file content (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| In the scanner | Scanner reads task files to check depends_on before considering claimable. | ✓ |
| In the QueueManager | QueueManager rejects claims on dep-blocked tasks. | |
| Both layers | Defense in depth but duplicated logic. | |

**User's choice:** In the scanner (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| ALL must be done | Task claimable only when every dependency is Done. | ✓ |
| ANY one done | Claimable when any single dependency finishes. | |

**User's choice:** ALL must be done (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Highest priority first | Sort by priority (critical>high>medium>low), then queue position. | ✓ |
| First in queue wins | FIFO from Available section. Priority field ignored. | |
| Random selection | Random among matches. Distributes but unpredictable. | |

**User's choice:** Highest priority first (Recommended)
**Notes:** None

---

## Checkpoint and Resume Format

| Option | Description | Selected |
|--------|-------------|----------|
| Structured YAML block | YAML code block in task file with machine-readable fields. | |
| Free-form markdown | Agent writes whatever. Flexible but hard to parse. | |
| Key-value bullets | Markdown bullets. Readable by both. Middle ground. | |

**User's initial response:** Asked whether timestamps and YAML are written programmatically or by agents.
**Clarification provided:** Mix of both — code writes claim/release/done entries programmatically, agents append progress notes.

| Option | Description | Selected |
|--------|-------------|----------|
| JSON sidecar file | tasks/TASK-005.checkpoint.json alongside task .md. Machine-readable, atomic. | ✓ |
| JSON section in markdown | JSON code block inside ## Checkpoint in task file. | |
| Separate checkpoint.json + log in markdown | JSON sidecar for machine, log in markdown for humans. | |

**User's choice:** JSON sidecar file (Recommended)
**Notes:** User referenced Anthropic's "Effective harnesses for long-running agents" article, noting JSON is more appropriate for machine state than markdown.

| Option | Description | Selected |
|--------|-------------|----------|
| Full state | status, claimed_by, claimed_at, last_step, next_action, progress_pct, files_modified, failed_approaches, log, notes | ✓ |
| Minimal state | status, claimed_by, claimed_at, last_step, next_action | |
| Let Claude decide | Minimal required schema, planner decides the rest. | |

**User's choice:** Full state (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Both — commit + JSON | Agent commits at milestones AND updates checkpoint JSON. | ✓ |
| JSON only | Only checkpoint JSON. Commits happen naturally. | |
| Git only | Commits at milestones. State inferred from git log. | |

**User's choice:** Both — commit + JSON (Recommended)
**Notes:** User also referenced Anthropic's "Harness design for long-running application development" article.

| Option | Description | Selected |
|--------|-------------|----------|
| Inject checkpoint JSON in heartbeat prompt | Scanner reads checkpoint and injects alongside task content. | ✓ |
| Agent reads checkpoint itself | Prompt tells agent about active task, agent reads JSON. | |
| Post-compaction context path | Use existing post-compaction system. | |

**User's choice:** Inject checkpoint JSON in heartbeat prompt (Recommended)
**Notes:** None

---

## Active Task Short-Circuit

| Option | Description | Selected |
|--------|-------------|----------|
| Scan checkpoint JSON files | Check .checkpoint.json where claimed_by matches and status is in-progress. | ✓ |
| Check queue.md Claimed section | Parse queue.md for agent's entries. Simpler but still parses queue. | |
| Agent session state | Store in session store. Fastest but state could drift. | |

**User's choice:** Scan checkpoint JSON files (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Task file + checkpoint JSON | Inject both task markdown and checkpoint JSON. Full resume context. | ✓ |
| Checkpoint JSON only | Just checkpoint data. Agent reads task file itself. | |
| Resume instruction only | Just "Resume TASK-005 from step X". Agent reads everything. | |

**User's choice:** Task file + checkpoint JSON (Recommended)
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, configurable timeout | Auto-release after threshold (default 2h). Prevents stuck tasks. | |
| Yes, fixed timeout | Fixed 1-hour auto-release. | |
| No stale detection (Phase 2) | Manual release only. Add stale detection later. | |

**User's choice:** Custom design — orchestrator agent handles stale detection
**Notes:** User described a detailed orchestrator pattern: orchestrator agent has its own 30-minute heartbeat, checks all active tasks, messages working agent's channel to verify status (wake up sleeping agents), resets to last checkpoint and releases task if agent is truly lost/corrupted. No automatic timeout in scanner code — Phase 6 provides the primitives (read checkpoint, release, reset) that the orchestrator will use.

---

## Claude's Discretion

- Exact heartbeat prompt format for claimed/resumed tasks
- Internal helper function organization within heartbeat-scanner.ts
- Error handling for corrupted/missing checkpoint JSON

## Deferred Ideas

- Orchestrator agent with stale task detection and recovery — future phase
- Multi-project scanning — evaluate after single-project works
- Task priority escalation — Phase 2 feature
