# AUTO_CHAIN_RUNTIME_FIX_SPEC

## Objective

Eliminate status-only stalls by enforcing automatic completion→next-step launch globally across channels/projects.

## Problem Statement

Observed failure pattern:

1. Task completion/status post lands.
2. No immediate next task launch.
3. User must prompt ("what's next?", "done?").
4. Next task then completes quickly once launched.

This indicates orchestration failure (launch continuity), not execution throughput.

### Incident references to cover (from prior day feedback)

The runtime fix must explicitly prevent all of these observed regressions:

- Claimed "running" followed by admission that nothing was running.
- ETA stated as long window (e.g., 12–30+ min) while completion landed in seconds.
- Completion posted without immediate next-launch proof (`Tasks initiated` for next run).
- "Pending" used as default state despite executable next step.
- User had to re-prompt after long idle windows (including multi-hour gaps).
- Internal syntax leakage in user-visible messages (tool fragments / wrappers).

---

## Scope

- Global behavior (all channels, all projects, all orchestrated workflows)
- Main agent + subagent orchestration
- Outbound status messaging guards

Out of scope:

- Provider/tool runtime outages
- Project-specific logic unrelated to orchestration continuity

---

## Functional Requirements

### FR-1: Atomic completion chain

On every task completion event, execute atomically:

1. Mark current task `completed`
2. Resolve `next_executable_task`
3. If executable and unblocked: launch immediately
4. Else: mark `blocked` with explicit `reason` + `unblock_condition`
5. Emit user update with launch proof

No status-only branch allowed.

### FR-2: Launch proof contract

Every execution update must include one of:

- `Tasks initiated: <task label> (run id: <id>)`
- `Tasks initiated: none (reason: <reason>; unblock: <condition>)`

### FR-3: Running-claim truth guard

Before sending any message containing `running|in progress|started`:

- verify active run/session id exists
- if none exists: block send + rewrite to truthful state

### FR-4: Pending policy guard

`pending` allowed only for:

1. explicit user pause/defer
2. missing required approval/decision
3. hard external blocker

Must include one-line reason + unblock condition.

### FR-5: Auto-recovery watchdog

Periodic check (30–60s):

- find tasks with `completed_at` where next task executable but `next_launched_at` missing and age > SLA (60s)
- auto-launch next task
- log incident + post autocorrection update

### FR-6: Sequence consistency guard

Disallow contradictory status ordering (e.g., completion artifact posted before launch proof for same step) unless explicitly marked as retrospective correction.

---

## Data Model (minimal)

### table: orchestration_runs

- `id` (uuid, pk)
- `project_key` (text)
- `thread_key` (text)
- `task_label` (text)
- `state` (enum: queued|running|completed|blocked|failed|cancelled)
- `started_at` (timestamp)
- `completed_at` (timestamp nullable)
- `block_reason` (text nullable)
- `unblock_condition` (text nullable)
- `parent_run_id` (uuid nullable)
- `next_task_label` (text nullable)
- `created_at` / `updated_at`

### table: orchestration_events

- `id` (uuid, pk)
- `run_id` (uuid)
- `event_type` (text)
- `payload_json` (json)
- `created_at` (timestamp)

### table: orchestration_metrics_daily

- `day` (date)
- `project_key`
- `completion_to_next_launch_p50_ms`
- `completion_to_next_launch_p95_ms`
- `stall_count`
- `false_running_claim_count`
- `user_nudge_count`

---

## State Machine

- `queued -> running -> completed`
- `completed -> (next queued/running) OR blocked`
- `blocked -> running` when unblock condition is satisfied
- Any state -> `failed/cancelled` terminal

Invariant:
If `completed` and next executable exists, system must create/launch next run within SLA.

---

## Handler Pseudocode

```pseudo
onRunCompleted(runId):
  begin tx
    mark runId completed
    next = resolveNextExecutable(runId)

    if next.exists and not next.blocked:
      nextRunId = createRun(next, parent=runId, state='queued')
      launch(nextRunId)   // must be in same handler flow
      mark nextRunId running
      message = buildLaunchProof(nextRunId)
    else:
      mark runId blocked_details(reason=next.reason, unblock=next.unblock)
      message = buildNoneProof(next.reason, next.unblock)
  commit tx

  sendGuarded(message)
```

```pseudo
sendGuarded(message):
  if containsRunningClaim(message):
    assert hasActiveRunId(message.context)
    if not:
      message = rewriteTruthfulNone(message.context)
  post(message)
```

```pseudo
watchdogTick():
  stale = findCompletedWithExecutableNext(age > 60s and no launch)
  for each item in stale:
    autocorrectLaunch(item)
    emitIncident("STALL_AUTOCORRECT", item)
```

---

## Messaging Contract

Execution updates must include:

1. `Tasks initiated:` line
2. `Status`
3. `Next`
4. ETA split:
   - Generation ETA
   - Workflow ETA
5. If blocked:
   - blocker reason
   - unblock condition

No internal tool syntax allowed in user-facing messages.

---

## SLOs / Alerts

### SLO targets

- P95 completion→next-launch <= 30s
- False running claims = 0
- User nudge prompts ("what's next", "done?") down week-over-week

### Alert conditions

- completion→next-launch > 60s with executable next
- contradictory status pair in same thread within 2 min
- outbound running-claim guard rewrite invoked > N/day

---

## Acceptance Tests

1. **Auto-chain pass**

- Given run completes and next executable exists
- Expect next run launched in same handler cycle
- Expect `Tasks initiated: <run id>` message

2. **Blocked pass**

- Given completion with approval/dependency blocker
- Expect no launch
- Expect `Tasks initiated: none` with reason + unblock

3. **Truth guard pass**

- Given outbound message says "running" but no active run
- Expect send blocked/rewrite

4. **Watchdog recovery pass**

- Simulate handler miss
- Expect watchdog launch within SLA breach window
- Expect incident log + autocorrect post

5. **No user-nudge dependency**

- No user message after completion
- Expect next task launch anyway

6. **ETA realism pass**

- Given small-scope task with low complexity signal
- Expect ETA model to choose short range, not default long template
- If completion beats ETA significantly, expect automatic ETA calibration event logged

7. **No phantom pending pass**

- Given executable next step and no blocker
- Expect system to launch (not label pending)
- If pending emitted, test fails unless blocker/approval metadata exists

8. **Output hygiene pass**

- Given internal wrapper/tool fragment in outbound draft
- Expect lint/sanitizer to strip or block before user-visible send

---

## Rollout Plan

### Phase 1 (Day 1)

- Implement state model + atomic completion chain
- Add launch proof contract

### Phase 2 (Day 2)

- Implement truth guard + pending guard
- Add watchdog auto-recovery

### Phase 3 (Day 3)

- Add metrics + alerts + incident reporting
- Enable hard enforcement globally

Feature flag:

- `execution.autoChain.enforced=true`
- Start in observe mode for 24h, then enforce.

---

## Risks / Mitigations

- **Risk:** duplicate launches from handler + watchdog race
  - Mitigation: idempotency key per (parent_run_id, next_task_label)
- **Risk:** false blocker classification
  - Mitigation: explicit blocker enum + validation
- **Risk:** noisy alerts
  - Mitigation: thresholding + daily digest with top offenders

---

## Definition of Done

- 7 consecutive days with:
  - zero false-running claims
  - p95 completion→next-launch <= 30s
  - no manual "what's next/done" prompts required for active streams
- Incident log shows no unresolved stall regressions.
