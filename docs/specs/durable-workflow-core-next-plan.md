# Native Durable Workflow Core Next Plan

Status: planning document for the next implementation stack.

This document defines the core pieces OpenClaw needs to grow the current durable
workflow prototype into a real native durable workflow core. The scope is limited
to durable workflow primitives and runtime behavior. It intentionally avoids
OpenClaw profile semantics, AICOS domain concepts, dashboards, visual workflow
designer UI, and external engine adapters.

For upstream contribution planning, see
[`durable-workflow-core-upstream-pr-stack.md`](./durable-workflow-core-upstream-pr-stack.md).
That document splits the current branch into small reviewable PRs and marks the
line between the implemented durable coordination slice and a complete durable
workflow runtime.

For the full-engine expansion plan, see
[`durable-workflow-core-full-engine-plan.md`](./durable-workflow-core-full-engine-plan.md).

## Durable Core Definition

For this plan, "durable core" means a native OpenClaw coordination kernel that
lets agents run long, multi-step, branching, multi-subagent work without losing
state, mixing branches, or going silent when something finishes, fails, times
out, overflows, or restarts.

It is not only a DB-backed event log. It must eventually answer and control:

- which accepted request created this work;
- which workflow run owns it;
- which step is currently active;
- which subagents were spawned;
- which child branches have completed;
- which child branches failed, timed out, overflowed, were cancelled, or were
  lost;
- why the parent is waiting;
- whether the parent should continue, retry, wait for human input, or fail;
- what can be safely resumed;
- what is unsafe to replay because a side effect may already have happened;
- why the system is quiet right now.

The practical OpenClaw value is:

- long-running agent work remains visible instead of looking hung;
- parent agents do not depend on prompt memory to fan-in child results;
- subagent completion can unblock the parent durably;
- one failed child does not lock the parent when policy allows continuation;
- gateway restart does not erase the control-plane truth;
- operators can inspect status and timeline without reading internal logs or
  SQLite manually;
- future workflow designer/runtime features have stable contracts for steps,
  links, signals, timers, and fan-in.

The durable core should stay small and upstream-friendly: it owns identity,
ordering, step state, waits, signals, child results, retries, recovery, and
audit. It does not own persona, prompt style, skills, memory content, workspace
files, or channel-specific UX.

## Current Maturity Level

Current maturity: native durable coordination slice with an initial executor
kernel.

This branch is already more than documentation: it adds a native OpenClaw
control plane for agent turn state, subagent child links, fan-in policy,
recovery state, TaskFlow projection, Workboard projection metadata, and gateway
read APIs. It now also includes step-level claims, an in-process workflow
registry, and a one-shot durable executor for safe built-in step handlers.

It should not yet be described as a complete durable workflow engine because it
does not yet include a long-running worker loop, durable dispatch from all
frontdoors, pluggable storage interface, schema migration policy, workflow SDK,
or mature multi-worker lease behavior.

The next architecture milestone is wiring the executor behind a feature flag as
a controlled worker loop. That is the point where the module starts moving from
durable inspection plus one-shot execution into a true durable runtime.

## Current Baseline

The prototype already provides:

- `openclaw.gateway.startup` durable startup records.
- `openclaw.agent.turn` run records.
- agent turn lifecycle events:
  - `agent.turn.received`
  - `agent.turn.running`
  - `agent.turn.succeeded`
  - `agent.turn.failed`
  - `agent.turn.cancelled`
  - `agent.turn.lost`
- SQLite local-first store.
- idempotency key uniqueness per workflow.
- prompt hash and metadata without raw prompt persistence.
- startup reconciliation of in-flight agent turns from a previous gateway
  lifecycle.
- gateway-local stale-run recovery worker.
- durable core primitive tables and APIs for:
  - steps;
  - refs;
  - parent/child links;
  - timers;
  - signals;
  - run claims;
  - fan-in reconciliation.
- agent turn lifecycle now creates a durable input ref and agent step.

This is enough to make lost work visible, but it is not enough to resume,
retry, or fully coordinate multi-agent workflows safely. The new fan-in helper
provides the core parent/child policy primitive, but it is not yet wired into
all session/subagent runtime paths.

The current prototype partially addresses OpenClaw's "silent/stuck" failure
mode:

- gateway-restart loss is no longer invisible for gateway agent turns;
- timeout/abort/lost terminal states are written durably;
- each new gateway agent turn now has an `agent_invocation` step and input/output
  refs;
- stale agent turns can be marked `lost`;
- core fan-in policy can unblock a parent in tests.

It does not yet fully solve silence for long-running or branched work because
runtime subagent spawning, parent fan-in, heartbeat/progress events, query UI/CLI,
and actual claim/resume execution are still pending.

## Immediate Execution Checklist

The next implementation pass should close the following eight missing runtime
authority gaps in order. Each item must remain feature-flagged and must be safe
when durable workflows are disabled.

1. Runtime subagent wiring:
   - real subagent/session spawn creates durable child links;
   - child terminal state updates the durable child link;
   - child overflow, timeout, cancelled, lost, and announce-failed outcomes are
     represented as terminal child link states or error refs.

2. Parent resume/unblock:
   - parent creates or reuses a `fan_in` step before spawning children;
   - child terminal events call fan-in reconciliation;
   - satisfied fan-in moves parent from `waiting_child` to `queued/runnable`;
   - continue policies allow parent to resume with partial results.

3. Heartbeat/progress:
   - long-running agent, tool, and child steps emit heartbeat/progress events;
   - active run/step `heartbeat_at` is updated;
   - stale heartbeat detection reports stuck work separately from quiet work.

4. Durable query/status API:
   - CLI/internal APIs list runs, inspect a run, show timeline, steps, children,
     timers, and signals;
   - status output includes current step, waiting reason, last heartbeat, child
     counts, and terminal/lost reason.

5. Claim/resume execution loop:
   - worker claims runnable runs/steps;
   - loads input/checkpoint refs;
   - executes or resumes safe steps;
   - releases claim on terminal or waiting states.

6. Retry and cancellation:
   - retry policy/backoff uses timers;
   - failed retryable steps schedule retry timers;
   - cancellation requests are durable and observed by active/waiting steps.

7. Human signal resume:
   - waiting signal state is represented durably;
   - human/external signal is persisted and consumed idempotently;
   - consumed signal moves run/step back to queued/runnable or terminal.

8. Side-effect uncertainty:
   - tool/model/message delivery operations that may have completed before
     crash are marked `unknown_after_side_effect`;
   - recovery reports these as requiring inspection or idempotent reconciliation
     before automatic replay.

## Design Goal

The durable core should provide a small native control plane for:

- request identity;
- step ordering;
- idempotency;
- retries;
- timers;
- recovery;
- cancellation;
- parent/child workflow linkage;
- fan-out/fan-in;
- human input signals;
- audit and timeline query.

It should remain:

- local-first;
- SQLite by default;
- optional Postgres-compatible later;
- feature-flagged while maturing;
- upstream-friendly;
- independent from AICOS-specific domain objects.

## Non-goals

- Do not implement a general-purpose Temporal clone.
- Do not require Postgres for local OpenClaw.
- Do not store raw prompts in event payloads by default.
- Do not make profiles, skills, or memory part of workflow state.
- Do not hard-code AICOS, AICOS-X, AICOS-R, Discord, Slack, or dashboard terms.
- Do not require a visual workflow designer before runtime primitives are stable.

## Required Core Pieces

### 1. Durable Identity Model

OpenClaw needs stable identity across user messages, gateway requests, agent
turns, child workflows, steps, retries, and emitted events.

Required identifiers:

- `workflow_id`
- `workflow_run_id`
- `message_id`
- `turn_id`
- `agent_invocation_id`
- `step_id`
- `event_id`
- `event_seq`
- `idempotency_key`
- `parent_workflow_run_id`
- `parent_step_id`
- `child_workflow_run_id`
- `checkpoint_ref`
- `input_ref`
- `output_ref`
- `error_ref`

Current coverage:

- `workflow_run_id`
- `workflow_id`
- `event_id`
- `event_seq`
- `idempotency_key`
- `agent_invocation_id`
- `input_ref`

Missing coverage:

- explicit message and turn identifiers;
- formal parent/child links;
- step-level input, output, and error references;
- checkpoint references tied to step transitions.

### 2. Durable Input/Output Store

The event journal should stay compact. Raw or large data should be stored behind
references.

Add store concepts:

- `durable_workflow_inputs`
- `durable_workflow_outputs`
- `durable_workflow_errors`
- `durable_artifact_refs`

Required behavior:

- store input bodies by ref only when durable retry/resume requires it;
- store payload hash for integrity;
- support redaction/encryption policy later;
- avoid raw prompt text in event payloads;
- allow outputs to reference files, artifacts, tool results, or summarized text;
- keep event log readable without embedding huge blobs.

Minimal input record:

```text
input_ref
workflow_run_id
step_id
media_type
hash
storage_kind
storage_uri
created_at
metadata_json
```

Minimal output record:

```text
output_ref
workflow_run_id
step_id
media_type
hash
storage_kind
storage_uri
created_at
metadata_json
```

### 3. Formal Run State Machine

Status strings need transition rules. Without a state machine, multi-step and
multi-agent runs can mix states or leave parent runs blocked forever.

Recommended run statuses:

```text
received
queued
running
waiting_signal
waiting_timer
waiting_child
retry_scheduled
succeeded
failed
cancelled
lost
```

Recommended recovery states:

```text
runnable
claimed
running
waiting_signal
waiting_timer
waiting_child
retry_scheduled
reconciling
unknown_after_side_effect
lost
terminal
```

Valid transition examples:

```text
received -> queued
queued -> running
running -> waiting_child
waiting_child -> queued
running -> waiting_signal
waiting_signal -> queued
running -> waiting_timer
waiting_timer -> queued
running -> retry_scheduled
retry_scheduled -> queued
running -> succeeded
running -> failed
running -> cancelled
running -> lost
```

Transition guard requirements:

- terminal states cannot become non-terminal without an explicit retry run;
- stale recovery cannot mark `waiting_signal` or `waiting_child` lost without a
  timeout policy;
- only the claiming worker can move a claimed run into running or terminal;
- idempotent duplicate requests must return the existing run, not create a
  second run.

### 4. Durable Step Model

An agent turn is not enough. A real workflow needs durable steps.

Add table:

```text
durable_workflow_steps
```

Minimal fields:

```text
workflow_run_id
step_id
parent_step_id
step_type
status
recovery_state
attempt
max_attempts
idempotency_key
input_ref
output_ref
error_ref
checkpoint_ref
created_at
started_at
updated_at
completed_at
metadata_json
```

Step types:

```text
agent
tool
timer
signal
child_workflow
checkpoint
fan_in
```

Step statuses:

```text
pending
queued
running
waiting
retry_scheduled
succeeded
failed
cancelled
lost
skipped
```

Why this matters:

- retries should happen per step;
- child agent failure should not automatically block the parent;
- a parent can wait on a durable `fan_in` step instead of remembering children
  in prompt context;
- recovery can reason about the last incomplete step.

### 5. Parent/Child Workflow and Fan-in Contract

This is the most important missing piece for reliable multi-agent coordination.

Add durable relation:

```text
durable_workflow_links
```

Minimal fields:

```text
parent_workflow_run_id
parent_step_id
child_workflow_run_id
link_type
status
created_at
updated_at
metadata_json
```

Link types:

```text
child_workflow
handoff
subagent
evidence
artifact
```

Fan-in primitive:

```text
fan_in_id
parent_workflow_run_id
parent_step_id
expected_child_count
completed_child_count
failed_child_count
policy
status
```

Fan-in policies:

```text
all_succeeded
all_terminal
quorum
first_success
manual_review
continue_on_child_failure
fail_parent_on_child_failure
```

Required events:

```text
child.workflow.spawned
child.workflow.running
child.workflow.succeeded
child.workflow.failed
child.workflow.cancelled
child.workflow.lost
fan_in.waiting
fan_in.partial
fan_in.ready
fan_in.failed
```

Core rule:

A parent run must not depend on prompt memory to notice child completion. Child
terminal events should update the parent fan-in step durably. If one child
overflows, times out, or fails, the configured fan-in policy decides whether the
parent continues, retries, waits for human input, or fails.

### 6. Recovery Worker With Claiming

The current worker can mark stale runs lost. The real worker must claim and
advance work.

Add claim fields to runs and steps:

```text
claimed_by
claim_expires_at
heartbeat_at
worker_id
```

Worker loop:

```text
scan runnable runs
claim one run or step
load input_ref/checkpoint_ref
execute or resume the next step
append events
update step state
update run state
release claim or renew heartbeat
```

SQLite local-first claim strategy:

- use transaction;
- select due runnable item;
- update `claimed_by`, `claim_expires_at`, `heartbeat_at`;
- only proceed if update succeeds;
- release claim on terminal or waiting state.

Future Postgres strategy:

- same interface;
- use `FOR UPDATE SKIP LOCKED`;
- keep state machine identical.

Recovery cases:

- gateway restart while run is accepted but not started;
- gateway restart while model call is in progress;
- tool call completed but result not recorded;
- child workflow completed but parent fan-in not updated;
- worker claim expired;
- retry timer due;
- human signal arrived.

### 7. Retry, Timer, Deadline, and Cancellation Core

Retry and timer primitives should be part of durable core, not agent profile
logic.

Add retry fields:

```text
retry_policy_json
attempt
max_attempts
next_attempt_at
last_error_ref
```

Retry policy:

```text
max_attempts
initial_delay_ms
max_delay_ms
backoff_multiplier
jitter
retry_on
do_not_retry_on
```

Add timers:

```text
durable_workflow_timers
```

Timer fields:

```text
timer_id
workflow_run_id
step_id
timer_type
due_at
status
created_at
fired_at
cancelled_at
metadata_json
```

Timer types:

```text
retry
deadline
sleep
human_timeout
child_timeout
scheduled_start
```

Cancellation fields:

```text
cancel_requested_at
cancel_reason
cancelled_by
```

Cancellation behavior:

- cancellation request is durable;
- active worker observes cancellation;
- waiting timers/signals/children can be cancelled;
- terminal event records who/what cancelled the run.

### 8. Signal and Human-in-the-loop Core

Human input should be a durable signal, not just another chat message.

Add table:

```text
durable_workflow_signals
```

Minimal fields:

```text
signal_id
workflow_run_id
step_id
signal_type
idempotency_key
payload_ref
correlation_id
received_at
consumed_at
metadata_json
```

Signal types:

```text
human_input
approval
rejection
external_callback
child_completed
child_failed
cancel
resume
```

Behavior:

- waiting workflow records `waiting_signal`;
- incoming signal is persisted first;
- worker consumes signal idempotently;
- run moves back to `queued` or terminal depending on signal.

This enables approvals from Discord, Slack, dashboard, CLI, API, or future
workflow designer without changing the core runtime.

### 9. Query and Control API

The core needs a small API so UI, CLI, and external frontdoors can inspect and
operate on durable runs.

Required read APIs:

```text
listWorkflowRuns(filter)
getWorkflowRun(workflow_run_id)
getWorkflowTimeline(workflow_run_id)
getWorkflowSteps(workflow_run_id)
getWorkflowChildren(workflow_run_id)
getWorkflowSignals(workflow_run_id)
```

Required control APIs:

```text
startWorkflow(input_ref)
sendSignal(workflow_run_id, signal)
cancelWorkflow(workflow_run_id, reason)
retryWorkflow(workflow_run_id)
retryStep(workflow_run_id, step_id)
```

For upstream acceptance, start with CLI/internal API only. UI can come later.

### 10. Observability and Debug Timeline

Minimum observability:

- run status;
- current step;
- active claim owner;
- last event;
- last error;
- retry schedule;
- parent/child graph;
- waiting reason;
- signal/timer due status.

Timeline should be enough to answer:

- what request created this run?
- which agent was invoked?
- which step is currently blocking?
- did any child finish?
- why is parent waiting?
- did gateway restart mark this lost?
- is this retryable?

### 11. Silence and Stuck Work Closure

The main user-visible failure to close is: OpenClaw appears silent or stuck while
coordinating long work, multi-step work, multiple agents, or branched subagent
work.

There are five distinct causes, and each needs a different core capability.

#### A. Gateway Restart or Process Loss

Current status:

- agent turns are recorded before execution;
- startup recovery marks old in-flight gateway agent turns as `lost`;
- stale recovery worker can mark long-stale turns as `lost`.

Remaining work:

- retry or resume from durable `input_ref`/`checkpoint_ref`;
- record side-effect uncertainty as `unknown_after_side_effect` when a tool/model
  call may have completed but terminal state was not recorded;
- expose the `lost` state through CLI/API instead of requiring SQLite inspection.

#### B. Long-running Step With No Progress

Current status:

- a run can show `running`;
- an agent step can show `running`.

Remaining work:

- emit periodic heartbeat/progress events for long-running steps;
- store `heartbeat_at` updates for active run/step claims;
- add stuck-step detection that distinguishes "alive but quiet" from "dead";
- surface last heartbeat, current step, and elapsed time in status/timeline.

Required events:

```text
step.heartbeat
step.progress
agent.turn.heartbeat
tool.invocation.heartbeat
```

#### C. Parent Waiting for Subagents

Current status:

- link table and fan-in helper exist;
- policies can continue parent despite child failure in tests.

Remaining work:

- wire real subagent/session spawn paths to create `child_workflow` links;
- create a parent `fan_in` step when parent spawns children;
- update child link status when child reaches terminal state;
- call fan-in reconciliation on child terminal event;
- move parent from `waiting_child` back to `queued/runnable` when policy is
  satisfied;
- add parent waiting reason and child counts to timeline/status.

Required events:

```text
child.workflow.spawned
child.workflow.terminal
fan_in.waiting
fan_in.partial
fan_in.ready
fan_in.failed
parent.workflow.unblocked
```

#### D. One Child Fails or Overflows

Current status:

- fan-in helper supports `continue_on_child_failure` and
  `fail_parent_on_child_failure`.

Remaining work:

- define default fan-in policy for OpenClaw subagents;
- record child failure reason as `error_ref`;
- prevent child failure from holding parent claim forever;
- support child retry policy independent of parent retry policy;
- support parent continuation with partial child outputs.

#### E. No Human-readable Status Surface

Current status:

- durable data exists in SQLite.

Remaining work:

- add CLI/internal API:
  - `durable runs list`
  - `durable run get <workflow_run_id>`
  - `durable timeline <workflow_run_id>`
  - `durable steps <workflow_run_id>`
  - `durable children <workflow_run_id>`
- include session key, agent id, current step, waiting reason, last heartbeat,
  child counts, and terminal/lost reason;
- keep this API usable without dashboard changes.

## Storage Plan

Keep SQLite as default.

Recommended table stack:

```text
durable_workflow_runs
durable_workflow_events
durable_workflow_steps
durable_workflow_links
durable_workflow_inputs
durable_workflow_outputs
durable_workflow_errors
durable_workflow_timers
durable_workflow_signals
```

Storage interfaces should stay independent from SQLite details so Postgres can
be added later.

Do not make Postgres mandatory.

## Execution Model

Recommended model:

```text
event journal + resumable state machine + checkpoint/input refs
```

Avoid requiring deterministic workflow replay in the first native core. Agent
workflows are usually side-effect-heavy, tool-heavy, and human-interactive. A
resumable state machine with explicit step boundaries is a better fit for
OpenClaw's local-first agent runtime.

Use deterministic replay only later for narrowly scoped pure workflow logic, if
needed.

## PR Stack

### PR 1: Durable Step Store

- add `durable_workflow_steps`;
- add step CRUD/list APIs;
- add transition helpers;
- add tests for step status transitions.

Current status: implemented as core store API. Transition helpers remain
minimal and should be hardened before upstream submission.

### PR 2: Durable Input/Output Refs

- add input/output/error ref tables;
- write agent turn input refs;
- keep event payloads compact;
- add hash validation tests.

Current status: implemented as a compact `durable_workflow_refs` table with
`ref_kind` for input, output, error, and artifact refs. Agent turns write input
refs and terminal output/error refs. Raw prompt text is still not stored in the
journal.

### PR 3: Parent/Child Links and Fan-in

- add workflow link table;
- add child spawn event contract;
- add fan-in step type;
- update parent state on child terminal events;
- test child success/failure isolation.

Current status: implemented store links and a reusable fan-in reconciliation
helper. The helper supports `continue_on_child_failure` and
`fail_parent_on_child_failure` behavior in tests. Runtime session/subagent spawn
paths still need to call it.

### PR 4: Recovery Claim Loop

- add claim fields;
- add worker claim/release/heartbeat;
- scan runnable and retry-due steps;
- keep SQLite local-first;
- test claim expiry and stuck-run recovery.

Current status: run claim/release primitives are implemented. The existing
recovery worker now reconciles stale agent turns, due retry timers, and pending
cancel/resume/human signals. It still performs visibility/state reconciliation
rather than executing a full claim/resume loop.

### PR 5: Retry and Timer Core

- add timer table;
- add retry policy;
- add due timer scan;
- add cancellation request fields;
- test backoff, retry exhaustion, and cancellation.

Current status: timer table, due timer listing, retry scheduling via the
`durable retry` CLI, and recovery-worker retry due reconciliation are
implemented. Retry policy inheritance/exhaustion and cancellation propagation
into live agent processes are still pending.

### PR 6: Signal and Human Input

- add signal table;
- add send/consume signal APIs;
- support waiting_signal -> queued transition;
- test human approval/rejection and idempotency.

Current status: signal table, idempotent signal creation, consume, list APIs,
`durable signal`, and recovery-worker waiting_signal/resume/cancel transitions
are implemented. Runtime tool/UI surfaces for human approval are still pending.

### PR 7: Query and Control API

- add timeline query;
- add run/step/child listing;
- add retry/cancel commands;
- expose enough for CLI and future UI.

Current status: implemented as the first operator-facing CLI slice:
`openclaw durable stats|runs|show|timeline|steps|children|parents|signals|refs|timers`
plus conservative `cancel|retry|resume|signal|mark-unknown` control commands.
This replaces direct SQLite inspection for the current prototype state.

### PR 8: Runtime Subagent/Fan-in Wiring

- identify every real subagent/session spawn path;
- create parent fan-in step before spawning children;
- create child workflow runs and durable links;
- write child terminal events;
- reconcile parent fan-in on child terminal state;
- test one child success + one child failure under continue policy;
- test child overflow/lost does not lock the parent.

Current status: partially implemented. Core tables and fan-in helper exist, and
the subagent registry run manager now mirrors subagent registration and terminal
outcomes into durable child runs/links. Child terminal outcomes reconcile the
parent fan-in step with `continue_on_child_failure`. More spawn paths and
focused overflow/announce-failure tests are still required before this should
be considered authoritative.

### PR 9: Heartbeat and Progress Events

- add heartbeat/progress helper for long-running run and step execution;
- update `heartbeat_at` for active run/step claims;
- emit `step.heartbeat` and `step.progress` events;
- add stale heartbeat detection;
- expose last heartbeat in status/timeline.

Current status: implemented for gateway agent turns. Active agent turns update
run/step `heartbeat_at` and emit `agent.turn.heartbeat` events. Generic
step/tool/subagent progress events and stale-heartbeat findings are still
pending.

### PR 10: Claim/Resume Execution Loop

- turn recovery worker from visibility reconciler into executor/reconciler;
- claim runnable runs/steps;
- load `input_ref` and last checkpoint;
- resume or retry safe steps;
- preserve `unknown_after_side_effect` for unsafe replay;
- release claim on waiting/terminal state.

Current status: pending. Claim primitives exist, and recovery can move timer or
signal waits back to runnable state, but the worker does not yet execute or
resume steps.

### Implementation Checkpoint 2026-06-27

The current implementation now covers the first runtime-authority slice:

- durable query/status CLI and timeline output;
- agent-turn heartbeat and visible `heartbeat_at`;
- retry timer scheduling and due reconciliation;
- durable signal/cancel/resume control-plane transitions;
- side-effect uncertainty marker via `durable mark-unknown`;
- subagent registry mirroring into child workflow runs and parent durable links;
- fan-in reconciliation on subagent terminal outcomes with a continue-on-child-failure policy;
- build and OpenClaw A smoke validation after gateway restart.

### Implementation Checkpoint 2026-06-28

The durable coordination bridge plan is now captured in
[`durable-coordination-bridge-plan.md`](./durable-coordination-bridge-plan.md).
That plan defines how Durable Core connects to Background Tasks, Task Flow, and
Workboard without making the optional Workboard plugin a hard dependency.

Implemented in the first bridge slice:

- durable coordination projection helper for task, TaskFlow, and Workboard
  consumers;
- `openclaw durable coordination <workflowRunId>` CLI projection output;
- `durable.coordination.get` Gateway read method for UI/plugin/operator clients;
- subagent durable child metadata now preserves Background Task `taskId` and
  one-task TaskFlow `parentFlowId` when available;
- terminal subagent durable updates preserve existing task/flow bindings instead
  of replacing the metadata;
- TaskFlow projection writer can update `stateJson.durable`, `waitJson.durable`,
  `currentStep`, and lifecycle status from durable state when an adapter calls it;
- Workboard now has typed `metadata.durable` persistence and a plugin-side
  projection-to-card-patch adapter plus `workboard.cards.applyDurableProjection`;
- tests for projection shape, subagent task/flow binding preservation, TaskFlow
  sync, Gateway projection reads, and Workboard durable metadata persistence.

Still not complete:

- no long-running claim/resume worker loop yet;
- no Postgres backend yet;
- no full human approval UI/tool flow yet;
- no message delivery side-effect dedupe beyond marking uncertainty;
- no TaskFlow maintenance sweep for all durable-bound flows yet;
- no Workboard UI rendering or diagnostics integration yet;
- no Workboard durable dispatch path yet;
- subagent overflow/announce-failure and branch route isolation need focused
  runtime tests;
- parent agent resume still depends on existing OpenClaw runtime behavior until
  durable control mode is explicitly introduced.

## Acceptance Criteria

The native durable core is minimally real when OpenClaw can:

- persist every accepted agent request before execution;
- recover or explicitly mark incomplete runs after gateway restart;
- retry a failed step without duplicating completed steps;
- spawn child agent workflows with durable parent links;
- fan-in child completion without relying on prompt memory;
- keep parent workflows unblocked when a child fails under a continue policy;
- report long-running step heartbeat/progress so quiet work is distinguishable
  from stuck work;
- show current durable state through CLI/API without direct SQLite queries;
- wait for human input as a durable signal;
- resume from input/checkpoint refs;
- explain run state through a timeline API.

## Most Important Next Step

Wire real runtime subagent/session spawn paths into durable parent/child links
and fan-in reconciliation, then add heartbeat/progress and query APIs.

Reason:

The largest current operational failure mode is not just losing a single chat
turn. It is losing coordination across long, branched agent work: parent agents
cannot reliably fan-in when subagents finish, and one child failure can make the
parent appear stuck. Step state and parent/child fan-in are the core primitives
that directly address that failure mode. The primitives now exist; the next
critical work is wiring them into the real runtime paths and making their state
visible to users/operators.
