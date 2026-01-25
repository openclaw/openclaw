---
summary: "Overseer: supervisory agent that tracks long-horizon plans across sessions, detects stalls, and recovers work"
read_when:
  - Designing long-horizon agentic workflows with durable planning
  - Implementing supervisor/recovery loops over multiple agents/sessions
  - Adding persistence, decomposition prompts, and lossless handoffs
---
# Overseer (Supervisor Agent)

Overseer is a gateway feature that runs "on top" of all other agents/sessions.
It maintains durable, highly-structured plans for major goals and continuously
reconciles "what should be happening" vs "what is happening" using session and
run telemetry. When work stalls, Overseer recovers by nudging, resending,
replanning, reassigning, or escalating to a human.

This document is a lossless implementation spec: data model, scheduler loop,
planner contracts, delivery strategies, safety/policy, and testing.

## Goals
- **Lossless planning**: capture and persist 3-tier decompositions (phases/tasks/subtasks) plus the "why".
- **Durable execution state**: persist what is queued/in progress/done/blocked across restarts.
- **Recovery-first**: detect idle/stalled work and choose the best recovery action (nudge/resend/replan/reassign/escalate).
- **Safe automation**: idempotent dispatches, spam-safe backoffs, explicit escalation rules.
- **Auditability**: append-only event log for "why did Overseer do that?"

## Non-goals
- Perfect semantic "understanding" of progress. Overseer should be robust with simple signals first, and only consult a model when necessary.
- Replacing existing heartbeat/cron workflows. Overseer complements them (and can use them).
- Storing full transcripts in the Overseer store. Session transcripts already live in `~/.clawdbot/agents/<id>/sessions/*.jsonl`; Overseer stores references.

## Terminology
- **Goal**: a major objective that requires long-horizon planning and multiple tasks.
- **Plan**: a 3-tier decomposition: **Phases -> Tasks -> Subtasks**.
- **Work node**: any Phase/Task/Subtask node in the plan graph.
- **Assignment**: a binding between a work node and a concrete execution target (agent/session) plus delivery mode and recovery policy.
- **Dispatch**: a specific instruction sent/spawned by Overseer, tracked with idempotency metadata.
- **Crystallization**: a structured summary/handoff record attached to a goal/work node after progress.
- **Telemetry**: session list timestamps, message sampling, agent lifecycle events, subagent registry entries, queue depth, etc.

## System overview

High-level architecture (code-owned state + model-owned planning):

1) **OverseerStore (durable)**: the authoritative record for goals, plans, assignments, and event log.
2) **OverseerRunner (loop)**: wakes periodically + on relevant events, evaluates what should happen next, and triggers actions.
3) **OverseerMonitor (signals)**: gathers telemetry about sessions/runs needed to compute liveness.
4) **OverseerDispatcher (actions)**: sends nudges, spawns subagents, and escalates to humans using appropriate delivery routing.
5) **OverseerPlanner (LLM)**: produces strictly-validated JSON for plan generation and (optionally) stall diagnosis.

Overseer should be implemented so that:
- the **store** is the source of truth,
- the **runner** is deterministic and safe by default,
- the **planner** is invoked only when beneficial, and its output must validate.

## Proposed code layout (implementation map)

This section proposes a concrete module breakdown that mirrors existing patterns
in `src/infra/heartbeat-runner.ts` and `src/agents/subagent-registry.ts`.

Suggested directories/files:
- `src/infra/overseer/store.ts`: load/save/update store + migrations + bounds enforcement
- `src/infra/overseer/store.types.ts`: TypeScript types and enums (optional; can live in `store.ts`)
- `src/infra/overseer/store.lock.ts`: lock helper (or reuse a shared lock utility)
- `src/infra/overseer/events.ts`: event type constants + helper to append events
- `src/infra/overseer/monitor.ts`: telemetry snapshot builder (sessions.list + optional sampling)
- `src/infra/overseer/dispatcher.ts`: send/spawn/escalate actions + idempotency + backoff
- `src/infra/overseer/planner.ts`: prompt builders + JSON validation + repair loop
- `src/infra/overseer/runner.ts`: tick scheduler + reconciliation engine
- `src/gateway/server-methods/overseer.ts`: gateway RPC handlers (optional but recommended)
- `src/commands/overseer/*.ts`: CLI commands (optional but recommended)

Suggested public interfaces:
```ts
export type OverseerRunner = {
  stop: () => void;
  updateConfig: (cfg: ClawdbotConfig) => void;
  tickNow: (opts?: { reason?: string }) => Promise<{ ok: boolean; didWork: boolean }>;
};

export function startOverseerRunner(opts: {
  cfg?: ClawdbotConfig;
  abortSignal?: AbortSignal;
}): OverseerRunner;
```

Store update API (recommended pattern):
```ts
export async function updateOverseerStore<T>(
  fn: (store: OverseerStore) => Promise<{ store: OverseerStore; result: T }>,
): Promise<T>;
```

Notes:
- Keep the tick deterministic: it should be pure given (store + telemetry snapshot).
- Keep the dispatcher side-effecting but idempotent: actions should be safe to retry.

## Integration points (existing primitives to reuse)

Overseer should build on existing gateway/session facilities:
- Session listing and timestamps: gateway `sessions.list`
- Session message sampling: gateway `chat.history` (used sparingly)
- Agent lifecycle events (start/end/error): `src/infra/agent-events.ts`
- Subagent run persistence + completion announce flow: `src/agents/subagent-registry.ts`
- Scheduler patterns:
  - gateway heartbeat runner (interval + "wake now"): `src/infra/heartbeat-runner.ts`, `src/infra/heartbeat-wake.ts`
  - gateway cron jobs for durable schedules: `/automation/cron-jobs`
- Delivery primitives:
  - agent-to-agent messaging via `sessions_send`
  - background work via `sessions_spawn`
  - human delivery via existing outbound delivery context (session entry `deliveryContext`)

## Telemetry inputs (what Overseer can observe)

Overseer should primarily use lightweight session store metadata, and only sample
message history when it has to.

### sessions.list (preferred)
Gateway `sessions.list` returns rows that include:
- `key` (canonical session key)
- `kind` (derived from key/entry)
- `label`, `displayName`
- `channel`, `subject`, `groupChannel`, `space`
- `updatedAt`
- `sessionId`
- `modelProvider`, `model`, `thinkingLevel`, `verboseLevel`, `sendPolicy`
- `contextTokens`, `totalTokens`, and token usage fields
- `deliveryContext` and "last seen" delivery fields: `lastChannel`, `lastTo`, `lastAccountId`
- `abortedLastRun`, `systemSent`

For idle/stall detection, `key` and `updatedAt` are the MVP signals.

### sessions.preview (optional)
If you want a cheap "what's going on" without full `chat.history`, consider
gateway `sessions.preview` (reads a bounded preview from transcripts).

### chat.history (use sparingly)
Use only for stale assignments and only with tight limits (e.g., last 10-20 messages)
to classify:
- "blocked waiting on human"
- "actively working but slow"
- "failed and needs intervention"

### agent lifecycle events (strong signal for spawned work)
If the dispatcher uses gateway `agent` with a known `runId`, Overseer can observe:
- `start`, `end`, `error` lifecycle events via `src/infra/agent-events.ts`

This is most reliable for `sessions_spawn` work (bounded runs).

## Core loop ("tick")

Overseer operates on a recurring "tick" (e.g., every 1-5 minutes) plus on-demand wakes.
Each tick must be:
- bounded (time, IO, and model usage),
- idempotent (safe to run twice),
- spam-safe (backoff + dedupe),
- persistently convergent (store changes move the system toward completion).

Suggested tick phases:

1) Load store (with lock) and compute the "workset":
   - work nodes that are `queued` or `in_progress`
   - assignments that are `active` or `stalled`
   - due reminders (expectedNextUpdateAt <= now)

2) Gather telemetry snapshot for workset targets:
   - `sessions.list` for involved agentIds/sessions
   - lifecycle events since last tick (or in-memory last-seen map)
   - optional `chat.history` sampling only for stale assignments (to classify stall)

3) Reconcile store state:
   - update assignment `lastObservedActivityAt`
   - detect stalls and transitions (active -> stalled, stalled -> active, etc.)
   - update rollups (goal progress, phase/task completion percent)

4) Decide actions (deterministic rules first):
   - nudge/resend
   - replan (planner) when ambiguous and expensive to spam
   - reassign/spawn for self-contained chunks
   - escalate to human for blockers or repeated failures

5) Persist state updates + append events (pre-dispatch):
   - record "what we intend to do" so we do not lose recovery intent on crash
   - apply backoff/dedupe scheduling decisions

6) Execute actions (dispatcher) with idempotency:
   - send/spawn/escalate
   - record outcomes immediately if possible, otherwise reconcile on next tick

### Tick pseudo-code (recommended structure)
```ts
async function tick(reason: string) {
  return await updateOverseerStore(async (store) => {
    const workset = buildWorkset(store, Date.now());
    const telemetry = await collectTelemetry(workset);

    const { nextStore, decisions } = reconcile(store, telemetry);
    // decisions = list of actions to execute (nudge/resend/spawn/escalate)

    // Persist first so we don't lose decisions if the process crashes mid-dispatch.
    const persisted = appendEvents(nextStore, decisions);

    // Execute side effects after persistence; record outcomes as dispatchHistory events.
    const outcomes = await dispatcherExecute(decisions);

    const final = recordOutcomes(persisted, outcomes);
    return { store: final, result: { didWork: decisions.length > 0 } };
  });
}
```

Why "persist then dispatch"?
- It avoids losing the plan/recovery intent if the gateway crashes.
- It makes retries safe: outcomes are reconciled on the next tick.

### Concurrency and queue pressure (recommended)

Overseer should avoid interfering with user-facing latency:
- Prefer short ticks (bounded IO, bounded message sampling).
- If the main lane is busy (requests in flight), either:
  - skip the tick, or
  - only update internal state and defer dispatch actions.

If adding a dedicated command lane is desirable, consider introducing an `overseer`
lane with max concurrency 1 (similar to cron/subagent lanes). Otherwise, ensure
dispatch actions are throttled and do not enqueue unbounded work into the main lane.

### Liveness and stall detection (MVP algorithm)

Overseer should prefer assignment-scoped liveness, not "agent idle" globally.

Signals (in descending preference):
- **Run in-flight**: a runId is known for the assignment and has not ended (from lifecycle events / `agent.wait` if available).
- **Session updatedAt**: target session `updatedAt` is newer than assignment `lastDispatchAt`.
- **Message fingerprint**: message sampling shows new assistant/user content since last dispatch (only for stale cases).

Suggested thresholds:
- `idleAfterMs`: how long without activity before labeling stalled (e.g., 10-20 minutes).
- `expectedNextUpdateAt`: explicit due time per assignment; if exceeded, treat as stalled even if `idleAfterMs` not reached.
- `maxRetries`: e.g., 2 nudges before escalation/replan.

Backoff:
- exponential backoff per assignment (`backoffUntil`) to avoid spam loops.
- dedupe on `instructionHash` so resends are not repeated inside a minimum resend interval.

### Work state rollups (phases/tasks/goals)
Define a single canonical rule set for rollups so UI/CLI views are consistent:
- A **task** is `done` when all its subtasks are `done` (unless explicitly overridden).
- A **phase** is `done` when all its tasks are `done`.
- A **goal** is `completed` when all phases are `done`.

Allow overrides, but record them:
- manual override must append an event with `reason` and `actor` (human vs overseer).

### Status enums and transition rules (normative)

Keep transitions strict and evented so the system is debuggable.

Work node statuses:
- `todo`: not yet ready to be worked
- `queued`: ready and waiting for assignment/dispatch
- `in_progress`: currently being worked
- `blocked`: cannot proceed until a condition is satisfied
- `done`: completed and accepted
- `cancelled`: intentionally stopped (terminal)

Assignment statuses:
- `queued`: work node exists but not yet dispatched
- `dispatched`: a dispatch attempt was recorded (may or may not be accepted)
- `active`: progress observed since last dispatch
- `stalled`: no progress observed beyond `idleAfterMs` or `expectedNextUpdateAt`
- `blocked`: explicitly waiting on a human or external dependency
- `done`: completed and recorded
- `cancelled`: intentionally stopped (terminal)

Recommended allowed transitions (illustrative, not exhaustive):
- Work nodes:
  - `todo -> queued -> in_progress -> done`
  - `queued|in_progress -> blocked -> queued` (after unblock)
  - `queued|in_progress|blocked -> cancelled`
- Assignments:
  - `queued -> dispatched -> active`
  - `active -> stalled -> active` (once progress resumes)
  - `stalled -> blocked` (if confirmed waiting on human)
  - `active|stalled|blocked -> done`

Rules:
- Any transition to `done` should attach a crystallization or evidence anchors.
- A `blocked` assignment must have `blockedReason` (structured when possible).

## Persistence: what to store so planning is never lost

This section is normative. If you persist all fields below, you can reconstruct state after a crash and resume without losing planning context.

Principles:
- Store **structure + intent + evidence + provenance** (not only todo lists).
- Store **anchors** to transcripts and artifacts (do not duplicate entire logs).
- Store **event history** for auditability and debugging.
- Do not store secrets (tokens, credentials). Store references to where they are configured and what is missing.

### Goal record (must persist)
- Identity:
  - `goalId` (stable, never reused)
  - `title`
  - `createdAt`, `updatedAt`
  - `status`: `active | paused | completed | cancelled | archived`
  - `priority`: `low | normal | high | urgent`
  - `tags[]`
- Definition:
  - `problemStatement` (what we are solving)
  - `successCriteria[]` (measurable/observable)
  - `nonGoals[]`
- Context:
  - `origin`: `sourceSessionKey`, `originDeliveryContext` (channel/to/thread/account when available)
  - `owner`: human owner/contact (identifier only, not secrets)
  - `stakeholders[]` (optional)
  - `repoContextSnapshot` (short, bounded summary of repo state assumptions)
- Constraints and risk:
  - `constraints[]`
  - `assumptions[]`
  - `risks[]` (each: `risk`, `impact`, `mitigation`)
- Planning provenance:
  - `planner`: `modelRef`, `promptTemplateId`, `promptTemplateHash`
  - `plannerInputs` (bounded, sanitized)
  - `rawPlannerOutputJson` (the accepted JSON plan)
  - `validationErrors[]` (if retries occurred)
  - `planRevisionHistory[]` (diff-like records: what changed + why)

### Plan graph (Phases -> Tasks -> Subtasks)

Every node (phase/task/subtask) must persist:
- Stable IDs:
  - `phaseId` / `taskId` / `subtaskId`
  - `parentId` (for linking) and `path` (optional convenience)
- Intent:
  - `name`
  - `objective`
  - `expectedOutcome`
- Acceptance:
  - `acceptanceCriteria[]` (checklist; should be verifiable)
  - `definitionOfDone` (optional, for tasks/phases)
- Dependencies:
  - `dependsOn[]` (IDs)
  - `blocks[]` (IDs)
- Execution hints:
  - `suggestedAgentId` or `suggestedAgentType`
  - `requiredTools[]` (or capabilities)
  - `estimatedEffort` (rough)
  - `riskLevel` (low/med/high)
- State:
  - `status`: `todo | queued | in_progress | blocked | done | cancelled`
  - `blockedReason` (structured when possible)
  - `createdAt`, `updatedAt`, `startedAt`, `endedAt`

### Assignments (execution bindings)

Assignments are separate from the plan nodes so the same work can be reassigned without mutating the plan structure.

Persist:
- Identity:
  - `assignmentId`
  - `goalId`
  - `workNodeId` (task/subtask id)
- Target:
  - `agentId`
  - `sessionKey`
  - `deliveryContext` (if sending to human or cross-context)
- Dispatch state:
  - `status`: `queued | dispatched | active | stalled | blocked | done | cancelled`
  - `lastInstructionText` (bounded) and `instructionHash`
  - `dispatchHistory[]` (see below)
- Run tracking (optional but strongly recommended):
  - `runId` for spawned runs
  - `spawnedByKey` (for spawned session visibility and diagnostics)
- Liveness + recovery:
  - `createdAt`, `updatedAt`
  - `lastDispatchAt`
  - `lastObservedActivityAt`
  - `expectedNextUpdateAt`
  - `idleAfterMs`
  - `retryCount`, `lastRetryAt`, `backoffUntil`
  - `recoveryPolicy`: `resend_last | nudge | replan | reassign | escalate`

### Dispatch history (auditability + dedupe)

Persist an append-only list per assignment, e.g.:
- `dispatchId` (uuid)
- `ts`, `mode` (sessions_send/sessions_spawn/escalate)
- `target` (sessionKey + deliveryContext)
- `instructionHash`
- `result`: `accepted | ok | timeout | error`
- `runId` (if any)
- `notes` (bounded, sanitized)

### Crystallizations (lossless handoffs)

Persist structured handoffs at multiple levels (subtask/task/phase/goal):
- `summary` (what happened)
- `currentState` (what exists now)
- `decisions[]` (decision + rationale)
- `nextActions[]` (ordered)
- `openQuestions[]`
- `knownBlockers[]`
- Evidence anchors:
  - `filesTouched[]`
  - `commandsRun[]` (sanitized)
  - `testsRun[]` + result summaries
  - `commits[]`, `prs[]`, `issues[]`
  - `externalRefs[]` (URLs or identifiers)
- Transcript anchors:
  - `sessionKey`, `sessionId`, and optional message/run identifiers

### Event log (global, append-only)

Persist `events[]` at the store root for reconstructability:
- `ts`
- `type` (e.g., `goal.created`, `plan.generated`, `assignment.dispatched`, `assignment.stalled`, `assignment.escalated`, `work.done`)
- `goalId`, optional `assignmentId` / `workNodeId`
- `data` (small, structured payload)

The event log is the "black box recorder" for: "why did Overseer do that?"

### Store root schema (recommended v1 shape)
Example structure (abbreviated but complete at top-level):
```json
{
  "version": 1,
  "goals": { "goal_...": { "...": "..." } },
  "assignments": { "A_...": { "...": "..." } },
  "crystallizations": { "C_...": { "...": "..." } },
  "dispatchIndex": { "D_...": { "...": "..." } },
  "events": [{ "ts": 0, "type": "goal.created", "goalId": "goal_...", "data": {} }]
}
```

Notes:
- `dispatchIndex` is optional if you store dispatch history only inside assignments, but it can make querying and dedupe faster.
- Keep `events` append-only; if it grows unbounded, implement periodic compaction into summarized "milestone" events.

## Store format and operational safety

### Storage location
Suggested default:
- Store dir: `~/.clawdbot/overseer/`
- Store file: `~/.clawdbot/overseer/store.json`

If desired, allow overrides via environment variables (e.g., `CLAWDBOT_OVERSEER_DIR`) but keep defaults stable.

### Versioning + migrations
The store must include `version: number`.
When schema changes:
- load old versions and migrate in memory,
- write back the new version (best effort),
- never crash the gateway due to store parse failures (fail open with a warning + safe mode).

### Write locking
Multiple concurrent writers (tick loop + manual CLI actions + remote ops) can corrupt state.
Use a lock file approach similar to `src/agents/session-write-lock.ts`:
- acquire `store.json.lock` with `wx` semantics
- include `{pid, createdAt}`
- break stale locks after a TTL if the pid is dead or the lock is too old

### Data bounds
To keep the store safe and portable:
- cap `lastInstructionText` length (e.g., 8-16 KB)
- cap `crystallization.summary` length and keep structured fields preferred
- avoid storing raw transcripts; store references

### Never store secrets
Overseer should not persist:
- tokens, API keys, cookies, credential files, phone numbers
Instead persist:
- missing credential *type* and *where to configure it* (e.g., "requires WhatsApp pairing", "needs OPENAI_API_KEY").

### Failure modes and safe mode
Overseer must never prevent the gateway from operating. Recommended behavior:
- If store JSON is corrupt:
  - rename it to `store.corrupt-<ts>.json` (best effort)
  - start with an empty store in "safe mode"
  - emit a warning event (`overseer.store.corrupt`)
- If planner/model is unavailable:
  - skip plan generation and use deterministic recovery only (nudge + escalate)
- If dispatcher actions fail:
  - record the error outcome in dispatchHistory
  - apply backoff and retry later

## Planner contracts (strict JSON only)

Overseer uses a model for two things:
1) **Plan generation**: decompose goal -> phases/tasks/subtasks
2) **Stall diagnosis (optional)**: choose the best recovery action when deterministic rules are insufficient

The planner must produce strictly-validated JSON. If invalid:
- retry with a repair prompt (bounded attempts),
- fall back to deterministic "safe" actions (nudge + escalate) rather than guessing.

### Prompt templates (recommended)

Plan generation (user message template):
```text
You are OverseerPlanner. Decompose the following goal into a 3-tier plan:
Phases -> Tasks -> Subtasks.

Requirements:
- Output MUST be valid JSON only (no markdown).
- Use at most {maxPhases} phases, {maxTasksPerPhase} tasks per phase, {maxSubtasksPerTask} subtasks per task.
- Every node must have: id, name, objective/outcome, acceptance (array of strings).
- Include deps as arrays of ids when relevant.
- Keep acceptance criteria testable/verifiable.

Goal:
{goalTitle}

Problem statement:
{problemStatement}

Success criteria:
{successCriteriaJson}

Constraints:
{constraintsJson}

Repo context snapshot:
{repoContextSnapshot}
```

Repair prompt (when JSON invalid):
```text
Your previous output was invalid JSON or did not match the required schema.
Return ONLY corrected JSON that matches the schema exactly. Do not add commentary.

Validation errors:
{validationErrors}

Previous output:
{previousOutput}
```

### Structured status update contract (recommended)

To keep Overseer deterministic and "lossless", prefer having agents report back using a
structured update payload that Overseer can parse without model inference.

Recommended format: a single JSON object in a fenced block labeled `json`.
Example nudge request can ask for:
```json
{
  "overseerUpdate": {
    "goalId": "goal_...",
    "workNodeId": "S1.2.3",
    "status": "in_progress",
    "summary": "What changed since last dispatch",
    "next": "Next concrete action",
    "blockers": ["..."],
    "evidence": {
      "filesTouched": ["..."],
      "testsRun": ["..."],
      "commits": ["..."]
    }
  }
}
```

Overseer should accept partial updates (e.g., just `status` + `summary`) and merge them into the store.

Parsing guidance (recommended):
- Prefer parsing the **last** fenced `json` block from the assistant reply.
- Validate the parsed object shape at runtime (strict keys, bounded strings).
- If `goalId`/`workNodeId` are missing, infer them from the assignment that triggered the nudge (do not guess across multiple assignments).
- If no structured update is present:
  - do not attempt lossy extraction by default
  - optionally schedule a follow-up nudge asking for the structured update

### Plan generation output (normative shape)

Constraints:
- max 5 phases
- max 7 tasks per phase
- max 7 subtasks per task
- every node must have a stable id and acceptance criteria

Example (shape only):
```json
{
  "planVersion": 1,
  "goal": {
    "title": "Overseer feature",
    "successCriteria": ["..."],
    "constraints": ["..."]
  },
  "phases": [
    {
      "id": "P1",
      "name": "MVP Supervisor Loop",
      "objective": "...",
      "tasks": [
        {
          "id": "T1.1",
          "name": "OverseerStore v1",
          "outcome": "...",
          "acceptance": ["..."],
          "deps": [],
          "subtasks": [
            {
              "id": "S1.1.1",
              "name": "Define schemas + migrations",
              "acceptance": ["..."]
            }
          ]
        }
      ]
    }
  ]
}
```

### Stall diagnosis output (optional)
When used, output a small action list:
```json
{
  "actions": [
    {
      "type": "nudge",
      "message": "Please report status: what changed, next step, blockers."
    },
    {
      "type": "escalate",
      "question": "Need your decision: A vs B",
      "options": ["A", "B"]
    }
  ]
}
```

## Dispatcher: choosing the best delivery mode

Overseer can deliver "more work" via:
- **sessions_send**: prompt an existing session/agent to continue or report status
- **sessions_spawn**: run a bounded sub-agent task and announce results back
- **human escalation**: send a message to the original thread/owner (deliveryContext)

### Dispatcher implementation notes (how to deliver safely)

Idempotency:
- Always create a `dispatchId` and use it consistently:
  - store it in dispatchHistory
  - when calling gateway `agent`, set `idempotencyKey = dispatchId`
  - compute and store `instructionHash` for store-level dedupe across restarts

Session keys:
- Store canonical session keys (e.g., `agent:<id>:...`), not display aliases like `main`.
- Use the session store entry's `deliveryContext` and "last seen" routing fields for escalation.

Delivery routing:
- For agent-to-agent work (no human delivery): `deliver: false` and record outcomes in the Overseer store.
- For escalation to human: use the originating `deliveryContext` (channel/to/thread/account) and send a message via the outbound message subsystem.

### Decision matrix

Prefer **sessions_spawn** when:
- the chunk is self-contained and can run without back-and-forth
- you want a clear run boundary and completion semantics
- you want parallelism without interrupting the main agent

Prefer **sessions_send** when:
- you need the agent to decide next steps, interpret ambiguous context, or integrate information
- you want a "status ping" that produces a crystallization

Prefer **human escalation** when:
- blocked on approvals/choices/credentials/environment
- `maxRetries` exceeded without progress
- the model indicates it is waiting on a human

### Nudge message contract (recommended)
To make recovery reliable, nudges should request a structured response:
- "Status: what changed since last instruction"
- "Next: the next concrete action"
- "Blockers: what is needed to proceed"
- "If finished: reply DONE + short summary + evidence anchors"

This structure enables Overseer to update the store without heavy transcript parsing.

## Recovery policies (normative)

Each assignment has a `recoveryPolicy` plus guardrails.
Recommended default escalation ladder:

1) **Nudge**: send a status request to the same session (deduped/backoff).
2) **Resend last instruction**: only if the dispatch likely failed (e.g., timeout) and idempotency constraints are met.
3) **Replan**: if the node is too large/ambiguous; ask planner for smaller subtasks.
4) **Reassign**: spawn a subagent or move to another agent (if policy allows).
5) **Escalate**: ask human for decisions or to confirm the right direction.

Never loop forever:
- cap retries,
- record each attempt in dispatchHistory,
- prefer escalation over infinite nudging.

### Redelivery semantics ("resend last message")

Overseer should distinguish between:
- **Resend for delivery uncertainty**: the instruction may not have been delivered/seen.
- **Re-run on purpose**: the instruction was delivered but needs to be executed again.

Recommended approach:
- Each dispatch has a stable `dispatchId`.
- When calling gateway `agent`, set `idempotencyKey = dispatchId`.
  - Reusing the same `dispatchId` is safe for "delivery uncertainty" retries.
  - Generating a new `dispatchId` forces a new run for intentional re-execution.

Also keep store-level dedupe:
- do not resend the same `instructionHash` within `minResendInterval`
- respect `backoffUntil`

## Security and policy

Overseer supervises multiple sessions and may message across agent boundaries.

Policy requirements:
- By default, keep supervision **within a single agentId** unless explicitly enabled.
- If cross-agent supervision is enabled, it should be **allowlisted** and ideally **directed**:
  - "overseer can access all; normal agents cannot access overseer" (recommended)

If reusing the existing symmetric `tools.agentToAgent` allowlist:
- document the risk: enabling it broadly allows agent-to-agent history and sends.
- consider adding a dedicated `tools.overseer` policy surface to scope permissions.

Also apply channel/provider routing guardrails when sending to humans:
- prefer using the stored `deliveryContext` from the session entry that originated the goal,
- avoid cross-context sends unless explicitly configured.

## Configuration surface (proposed)

This is a proposed `clawdbot.json` schema; implement as needed.

```json5
{
  "overseer": {
    "enabled": false,
    "tickEvery": "2m",
    "idleAfter": "15m",
    "maxRetries": 2,
    "minResendInterval": "5m",
    "backoff": { "base": "2m", "max": "30m" },
    "planner": {
      "model": "openai/gpt-5-mini",
      "maxPlanPhases": 5,
      "maxTasksPerPhase": 7,
      "maxSubtasksPerTask": 7,
      "maxRepairAttempts": 2
    },
    "policy": {
      "allowAgents": ["main"], // or ["*"] explicitly
      "allowCrossAgent": false
    },
    "storage": {
      "dir": "~/.clawdbot/overseer"
    }
  }
}
```

Notes:
- Keep defaults conservative (disabled by default).
- Prefer duration strings and reuse existing duration parsing patterns.

## Gateway/CLI surface (proposed)

Overseer should be operable without editing JSON by hand.

### CLI commands (suggested)
- `clawdbot overseer status` (summary: goals, stalled assignments)
- `clawdbot overseer goal create --title "..." [--from-session main]`
- `clawdbot overseer goal pause <goalId>`
- `clawdbot overseer goal resume <goalId>`
- `clawdbot overseer work done <workNodeId> --goal <goalId>`
- `clawdbot overseer work block <workNodeId> --reason "..."`
- `clawdbot overseer tick --now` (manual run)

### Gateway methods (suggested)
- `overseer.status`
- `overseer.goal.create`, `overseer.goal.update`, `overseer.goal.pause`, `overseer.goal.resume`
- `overseer.work.update` (status transitions)
- `overseer.tick` / `overseer.wake`

Even if you do not expose all methods publicly, keep internal function boundaries aligned with these operations for testability.

## Observability

Overseer should emit:
- diagnostic logs for tick start/end, actions chosen, and outcomes
- store event log entries for all state transitions and dispatches
- (optional) gateway events for UI dashboards: `overseer.tick`, `overseer.action`, `overseer.stalled`

For debugging, ensure you can answer:
- "Which assignment is stalled and why?"
- "What was the last dispatch and did it get accepted?"
- "What backoff is currently active?"
- "What evidence indicates progress?"

## Testing strategy

Start with deterministic unit tests before adding planner/model-dependent flows.

Recommended tests:
- Store:
  - load/save with versioning, lock behavior, corruption fallback
  - migrations: v1 -> v2 etc
- Tick logic:
  - assignment transitions based on telemetry (active/stalled)
  - backoff and dedupe correctness
  - escalation ladder and maxRetries caps
- Dispatcher:
  - idempotency and retry behavior (simulate gateway timeouts/errors)
- Planner:
  - JSON validation and repair loop
  - bounded output enforcement (max phases/tasks/subtasks)

E2E tests (optional):
- Create a goal, generate plan, dispatch a task, simulate no progress, assert a nudge is sent, then simulate progress and assert state converges.

## Implementation checklist (phased)

### Phase 1: MVP supervisor loop (no planner dependency)
- Implement OverseerStore v1 + event log + file lock
- Implement OverseerRunner tick loop with deterministic liveness + stall detection
- Implement Dispatcher actions:
  - sessions_send nudge/resend
  - sessions_spawn for explicit "do this chunk" assignments
  - human escalation using stored deliveryContext
- Add minimal CLI/admin surfaces (status dump + manual tick)

### Phase 2: Planner integration + lossless decomposition
- Implement OverseerPlanner plan generation with strict JSON schema
- Add goal.create -> plan.generate -> persist -> initial assignments
- Add crystallization capture utilities (structured summaries attached to work nodes)

### Phase 3: Recovery hardening
- Integrate lifecycle events and subagent registry for better in-flight detection
- Add replan/reassign flows and directed policy configuration
- Add observability events and dashboards
