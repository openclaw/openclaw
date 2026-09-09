---
summary: "Task Flow orchestration layer above background tasks"
read_when:
  - You want to understand how Task Flow relates to background tasks
  - You encounter Task Flow or openclaw tasks flow in release notes or docs
  - You want to inspect or manage durable flow state
title: "Task flow"
---

Task Flow (formerly ClawFlow) is the orchestration layer above [background tasks](/automation/tasks). A flow is a durable record of multi-step work with its own status, JSON state, revision counter, and linked task records. Flows survive gateway restarts; individual tasks remain the unit of detached work.

## When to use Task Flow

| Scenario                                  | Use                                         |
| ----------------------------------------- | ------------------------------------------- |
| Single background job                     | Plain task                                  |
| Multi-step pipeline driven by plugin code | Task Flow (managed)                         |
| Detached ACP or subagent spawn            | Task Flow (mirrored, created automatically) |
| One-shot reminder                         | Automation job                              |

## Sync modes

### Managed mode

A managed flow has a controller: plugin code that creates the flow with a goal and controller id, then drives it explicitly. A flow can track inline work without any child task.

- `createManaged` creates state, not an execution. `runTask` links an existing execution; it does not launch one.
- The controller advances between running, waiting and terminal states, retaining bounded IDs, summaries and cursors in `stateJson`.
- State transitions (`setWaiting`, `resume`, `finish`, `fail`, `requestCancel`) require the latest expected revision. Check every result, including `finish`. `runTask` and `cancel` have separate creation/cancellation results to check.
- Cancellation intent refuses new child links. The flow finalizes as cancelled once its active children have settled.

#### Launching and linking child tasks

Launch ACP/subagent work through its supported runtime **before** calling `runTask`. Linking requires the existing authoritative backing task, its canonical `runId` and child session key, the correct task runtime and the same owner session as the managed flow. A copied session key or invented run ID is not authority.

For Gateway-backed plugin subagents, the public path is `api.runtime.subagent.run({ completionDelivery: "current-requester", ... })` inside a real requester-bound `before_dispatch` hook handling an authenticated inbound request. The host creates the canonical subagent task and mirrored flow. Ordinary plugin runs without this setting deliberately have `not_applicable` completion delivery and cannot supply that mirrored backing. Merely binding `managedFlows.fromToolContext(ctx)` does not grant requester launch authority.

Use the returned identities and current owner-visible task facts, not invented status/timing. A child can finish before linkage; `runTask` does not replay past terminal events. Do not create a running projection of completed work. See the [SDK Tasks contract](/plugins/sdk-runtime) for the launch, synchronous pre-link check, result handling and revision rules.

#### Run a managed Lobster workflow

For operator/agent use, the optional [Lobster tool](/tools/lobster) can execute a workflow with `flowControllerId` and `flowGoal`. It creates a managed flow, records a real approval pause as waiting, and finishes or fails from the workflow outcome. The workflow steps are not detached child task records.

The tool returns envelope fields plus `flow` and `mutation` at the top level of its details. Check `mutation.applied` and use `mutation.flow`, the post-mutation record, for the next `flowExpectedRevision`. After the user's decision, resume with the returned token or approval ID and the actual flow id/revision; check cancellation through `mutation.cancelled`. Report errors and rejected updates instead of treating workflow output as proof that flow state persisted.

The bundled TaskFlow skill examples route synthetic inbox/PR batches and suspend for approval without contacting external services. A workflow approval is not an arbitrary Slack-reply listener: a real controller must register that listener, persist thread correlation and resume when the matching event arrives.

### Mirrored mode

OpenClaw creates a mirrored one-task flow automatically when a detached ACP or subagent run starts (session-scoped tasks with deliverable completion). The flow record mirrors its single backing task - status, goal, and timing - so detached spawns get a stable flow handle for status and retry surfaces without a controller. Mirrored flows show sync mode `task_mirrored` in the CLI.

## Flow statuses

| Status      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `queued`    | Created, not yet progressing                                      |
| `running`   | Flow is actively progressing                                      |
| `waiting`   | Managed flow is parked on wait metadata (timer, external event)   |
| `blocked`   | Waiting on a blocking condition, or ended without a usable result |
| `succeeded` | Completed successfully                                            |
| `failed`    | Completed with an error                                           |
| `cancelled` | Cancel requested and all child tasks settled                      |
| `lost`      | Flow lost its authoritative backing state                         |

`blocked` is the only status whose terminal meaning depends on the record. A
managed flow with no `endedAt` remains resumable. A `blocked` flow with
`endedAt` is finished, including mirrored flows whose backing task completed
with a blocked outcome.

## Durable state and revision tracking

Flow records persist in the shared SQLite state database (`~/.openclaw/state/openclaw.sqlite`, `flow_runs` table) alongside task records, so progress survives gateway restarts. Each write bumps the flow's `revision`; concurrent writers that pass a stale expected revision get a conflict and must re-read. WAL growth is bounded by SQLite autocheckpointing plus periodic passive checkpoints, with truncate checkpoints on shutdown. The legacy `flows/registry.sqlite` sidecar from older installs is imported by `openclaw doctor`.

Durability covers records, not a JavaScript call stack or automatic scheduling. After restart, the owning controller reloads the flow, checks cancellation and terminal state, reconciles any child outcome, and explicitly resumes from the latest revision. Waiting metadata alone does not register a timer or event listener. Use an automation or controller-owned event handler for wakeups; never blindly replay side effects after a revision conflict.

Gateway maintenance retains finished flows for 7 days, then prunes them. This
includes `blocked` flows with `endedAt`; resumable managed `blocked` flows are
retained regardless of age.

## Cancel behavior

`openclaw tasks flow cancel` sets a sticky cancel intent on the flow, cancels its active child tasks, and refuses new managed child tasks. Once no child task remains active, the flow finalizes as `cancelled` - immediately, or via the maintenance sweep if children take longer to settle. The intent is persisted, so a cancelled flow stays cancelled even if the gateway restarts before all child tasks have terminated.

## CLI commands

```bash
# List active and recent flows
openclaw tasks flow list [--status <status>] [--json]

# Show details for a specific flow
openclaw tasks flow show <lookup> [--json]

# Cancel a running flow and its active tasks
openclaw tasks flow cancel <lookup>
```

| Command                           | Description                                                             |
| --------------------------------- | ----------------------------------------------------------------------- |
| `openclaw tasks flow list`        | Tracked flows with sync mode, status, revision, controller, task counts |
| `openclaw tasks flow show <id>`   | Inspect one flow by flow id or owner key, including linked tasks        |
| `openclaw tasks flow cancel <id>` | Cancel a running flow and its active tasks                              |

Flows are also covered by `openclaw tasks audit` (stale or broken flow findings) and `openclaw tasks maintenance` (finalizes stuck cancels, prunes terminal flows after 7 days).

## Reliable scheduled workflow pattern

For recurring workflows such as market intelligence briefings, treat the schedule, orchestration, and reliability checks as separate layers:

1. Use [Automations](/automation/cron-jobs) for timing.
2. Use a persistent automation session when the workflow should build on prior context.
3. Use [Lobster](/tools/lobster) for deterministic steps, approval gates, and resume tokens.
4. Use Task Flow to track the multi-step run across child tasks, waits, retries, and gateway restarts.

Example automation job (`openclaw automations`; `openclaw cron` remains an alias):

```bash
openclaw automations add \
  --name "Market intelligence brief" \
  --cron "0 7 * * 1-5" \
  --tz "America/New_York" \
  --session session:market-intel \
  --message "Run the market-intel Lobster workflow. Verify source freshness before summarizing." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

Use `--session session:<id>` instead of `isolated` when the recurring workflow needs deliberate history, previous run summaries, or standing context. Use `isolated` when each run should start fresh and all required state is explicit in the workflow.

Inside the workflow, put reliability checks before the LLM summary step:

```yaml
name: market-intel-brief
steps:
  - id: preflight
    command: market-intel check --json
  - id: collect
    command: market-intel collect --json
    stdin: $preflight.json
  - id: summarize
    command: market-intel summarize --json
    stdin: $collect.json
  - id: approve
    command: market-intel deliver --preview
    stdin: $summarize.json
    approval: required
  - id: deliver
    command: market-intel deliver --execute
    stdin: $summarize.json
    condition: $approve.approved
```

Recommended preflight checks:

- Browser availability and profile choice, for example `openclaw` for managed state or `user` when a signed-in Chrome session is required. See [Browser](/tools/browser).
- API credentials and quota for each source.
- Network reachability for required endpoints.
- Required tools enabled for the agent, such as `lobster`, `browser`, and `llm-task`.
- Failure destination configured for the automation so preflight failures are visible. See [Automations](/automation/cron-jobs#delivery-and-output).

Recommended data provenance fields for every collected item:

```json
{
  "sourceUrl": "https://example.com/report",
  "retrievedAt": "2026-04-24T12:00:00Z",
  "asOf": "2026-04-24",
  "title": "Example report",
  "content": "..."
}
```

Have the workflow reject or mark stale items before summarization. The LLM step should receive only structured JSON and should be asked to preserve `sourceUrl`, `retrievedAt`, and `asOf` in its output. Use [LLM Task](/tools/llm-task) when you need a schema-validated model step inside the workflow.

For reusable team or community workflows, package the CLI, `.lobster` files, and any setup notes as a skill or plugin and publish it through [ClawHub](/clawhub). Keep workflow-specific guardrails in that package unless the plugin API is missing a needed generic capability.

## How flows relate to tasks

Flows coordinate tasks, not replace them. A single flow may drive multiple background tasks over its lifetime. Use `openclaw tasks` to inspect individual task records and `openclaw tasks flow` to inspect the orchestrating flow.

## Related

- [Background Tasks](/automation/tasks) - the detached work ledger that flows coordinate
- [CLI: tasks](/cli/tasks) - CLI command reference for `openclaw tasks flow`
- [Automation Overview](/automation) - all automation mechanisms at a glance

## Experimental supervised episodes

The supervised TaskFlow PoC adds an **opt-in native controller**. It does not
change managed or mirrored flows: creating those records still does not schedule
execution. Supervised episodes use `openclaw tasks supervise`, separate from
`tasks flow`, and currently support Codex and Claude CLI full-turn adapters.

The controller owns continuation between attempts. Returning a final chat answer
does not finish an episode. Each attempt must return a structured decision that
the controller commits before releasing its ownership. A task needs a recorded
objective and observable success criteria. If the operator omits them, a bounded,
tool-free first attempt must define them or ask for input. Accepted criteria cannot
be silently lowered by later attempts. Partial success is allowed only for a
nonempty, preaccepted subset of those criteria.

### Start a supervised task

Configure a dedicated agent with an explicit per-model `agentRuntime.id` of
`codex` or `claude-cli`, and authenticate through that runtime's normal owner.
Use `openai/<model>` for Codex and `anthropic/<model>` for Claude CLI in this PoC.
Claude CLI is the configured runtime, not the canonical model provider.
See [CLI backends](/gateway/cli-backends). Do not put credentials in a task file.

Create `task.json` with these fields:

| Field                     | Requirement                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flowId`                  | Optional unique identifier; generated when omitted.                                                                                                 |
| `agentId`                 | Existing configured agent.                                                                                                                          |
| `model`                   | Explicit `provider/model` reference matching the chosen runtime.                                                                                    |
| `runtime`                 | `codex` or `claude-cli`.                                                                                                                            |
| `prompt`                  | Nonempty request, at most 4,096 characters.                                                                                                         |
| `goal`                    | Optional `{ objective, success: [{ id, description }], partial: [id] }`. Maximum 32 criteria; IDs are unique. Omit to request supervised inference. |
| `policy.deadlineAt`       | Future Unix epoch milliseconds; the episode cannot renew this deadline.                                                                             |
| `policy.maxAttempts`      | Integer from 1 to 100, including goal definition.                                                                                                   |
| `policy.attemptTimeoutMs` | Integer from 1,000 to 3,600,000, capped by the episode deadline.                                                                                    |

The file and each stored episode are limited to 64 KiB. Admission refuses more
than 128 active episodes. An attempt is an OpenClaw full turn, not necessarily
one physical provider request: existing internal runtime retries remain inside it.

New active writes reserve serialized UTF-8 headroom: prompt, goal, and next-step
content together may use 40 KiB, control metadata 8 KiB, and an endpoint 16 KiB.
The total record limit remains 64 KiB. These are JSON byte limits, including
escaping, not character counts. Oversized admission or resume is rejected
transactionally; an oversized model update preserves the owned attempt so it can
receive a compact failure endpoint. Diagnostic omission is explicit, never silent
evidence truncation. Supervisor owner IDs are limited to 128 characters.

Records written by earlier PoC builds remain readable. Control-only claim and
dispatch transitions preserve their unchanged content. A legacy active record
above the new content limit can execute and reach a compact endpoint when the
total still fits. An already maximally full legacy record may lack endpoint space; this repair
does not discard its content or migrate it. Reconcile those records before relying
on the endpoint guarantee below.

```bash
# Own this one task in the foreground until it reaches an endpoint.
openclaw tasks supervise run task.json

# Alternatively, keep a supervisor running in a separate terminal/service.
openclaw tasks supervise work

# Admit to an already observed general supervisor.
openclaw tasks supervise start task.json
openclaw tasks supervise show <flowId>
```

`run` supervises only its own flow; it does not promise continuation for unrelated
tasks. `work` supervises all opted-in episodes in the selected state database.
Foreground execution opens only after this invocation successfully creates its
episode. A rejected duplicate ID must not claim, dispatch, or terminate the
existing ready or waiting episode.
If its worker loses custody unexpectedly, `work` replaces it with a new owner;
it never renews a revoked identity. Failed readmission exits nonzero. An explicit
SIGINT or SIGTERM stops the daemon without rearming it.
Runtime preparation finishes before a supervisor advertises readiness; slow
cold loading is not an armed worker. Explicitly starting supervision creates the
optional tables. A normal Gateway
then observes that activation and supervises episodes through its post-ready
service lifecycle, including after restart. Minimal/test and update-canary
Gateways do not activate this service. Normal installations without the tables
remain non-creating. Keep a Gateway or `work` service running for unattended
continuation; a progress card, presence indicator, or open Beads issue is not a
supervisor.

### Interpret status and endpoints

`show` reports the episode and freshness-qualified custody:

| Field/value                | Meaning                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuation: armed`      | A scope-compatible supervisor has a current durable heartbeat and owns the continuation scan. This is an observation, not proof of uninterrupted future availability. |
| `continuation: unknown`    | No fresh supervisor observation exists. Do not say the task will continue automatically.                                                                              |
| `continuation: stopped`    | This episode has an immutable endpoint.                                                                                                                               |
| `execution: attempt_owned` | An unexpired attempt and its supervisor still own execution. This does not prove a model call is currently consuming tokens.                                          |
| `execution: not_observed`  | No current attempt execution is established. A timer may still be armed.                                                                                              |
| `operatorRequired: true`   | The episode ended `input_required`; an explicit response is necessary. `false` alone does not mean healthy supervision.                                               |

Observers normally renew every second and expire after ten seconds. The output
includes observation and expiry timestamps. Readers do not repair or create
state. SQL claims and exact attempt fences prevent a stale owner from settling a
successor's work. The last completed/interrupted attempt ID is a transcript
lookup aid, never permission to replay that attempt.

The endpoint kinds are `succeeded`, `partial`, `input_required`, `failed`, and
`cancelled`. Success/partial require evidence entries matching accepted criteria.
The decision protocol is supplied through the system-instruction boundary; task
content remains separate. Malformed decisions fail closed without searching prose
for a convenient success object. `acceptedBy: model` explicitly means model-reported evidence, not independent
verification of the real-world outcome. Cancelling revokes further authorized
dispatch; it does not claim to undo or physically stop every effect already sent.

An interrupted attempt with a durable dispatch reservation ends `input_required`
with unknown effects. It is not automatically replayed. The conservative reservation
precedes runtime invocation, so a crash in that gap can also require reconciliation.
A claimed attempt without a reservation can be reclaimed; the attempt budget
still advances. `effects` describes the final/current attempt, not a guarantee
that the entire task was effect-free. `attempt_completed` is not an exactly-once
side-effect receipt.

```bash
openclaw tasks supervise cancel <flowId>
openclaw tasks supervise resume <flowId> response.json
```

`response.json` must contain `{ "episode": <currentEpisode>, "input": "...",
"policy": { ... } }` with fresh finite bounds. Resume requires a current general
supervisor and opens a new episode; the old input endpoint remains immutable.
Duplicate responses for the previous episode are refused. `list` returns up to
256 retained episodes. All supervised command output is JSON. Foreground `run`
returns exit status 0 only for success/partial, otherwise 1.

### Guarantees and PoC limits

With a functioning supervisor, writable database, advancing clock, and eventual
CPU scheduling, each admitted episode reaches a recorded endpoint within its
finite deadline plus reconciliation delay. Deadline processing does not wait
for a hung model promise. During a whole-host outage or database failure, the
system cannot honestly promise timely endpoint publication: status becomes
unknown, and a restarted owner reconciles when those dependencies return.

This PoC restricts attempts to reasoning and the permitted OpenClaw file tools.
Codex's narrow allowlist disables its bundled native shell/file capability and
uses OpenClaw-owned file tools. The same narrow cap selects no native tools for
Claude CLI; it uses MCP-backed OpenClaw file tools. The mutation proof exercises
those actual transports, not native Codex apply_patch or native Claude Edit/Write.
Native CLI permissions and rollback of already dispatched effects are not proven.
Detached processes, child agents, arbitrary external-event listeners, outbound
notifications, and Discord presence projection are not supervised here. It does
not provide a general external-effect transaction ledger or independently judge
goal semantics. Episode and expired-owner records are retained; automatic
retention/archival is not implemented. Keeping owner tombstones prevents stale
processes from resurrecting revoked identities. These additive tables leave
legacy `flow_runs` untouched; older builds ignore supervised episodes and **do
not continue them**. Upstream schema acceptance and broader task-tool integration
remain separate from this experimental branch.

Developer proofs (run from the source checkout):

```bash
node scripts/run-vitest.mjs src/tasks/supervised-task.test.ts src/tasks/supervised-task.gateway.test.ts src/tasks/supervised-task.agent.test.ts
node scripts/run-vitest.mjs src/commands/tasks-supervise.test.ts
pnpm tsx scripts/dev/supervised-task-process-proof.ts
pnpm tsx scripts/dev/supervised-task-runtime-proof.ts codex <provider/model> <report.json>
pnpm tsx scripts/dev/supervised-task-runtime-proof.ts claude-cli <provider/model> <report.json>
pnpm tsx scripts/dev/supervised-task-coding-proof.ts codex openai/<model> <report.json>
pnpm tsx scripts/dev/supervised-task-coding-proof.ts claude-cli anthropic/<model> <report.json>
pnpm tsx scripts/dev/supervised-task-mutation-proof.ts codex openai/<model> <report.json>
pnpm tsx scripts/dev/supervised-task-mutation-proof.ts claude-cli anthropic/<model> <report.json>
```

The process proof uses synthetic decisions, real SQLite connections, concurrent
processes, and SIGKILL. The runtime proof uses the actual adapters and verifies an
independently generated fixture marker. It creates isolated OpenClaw state and
keeps its transcripts for inspection, while native authentication stays with the
host runtime. It never copies authentication files or starts the live Gateway.

The coding proof starts with broken graph-validation and scheduling modules.
It requires two file-editing attempts, closes and reopens SQLite during a durable
wait, replaces the supervisor, and checks the result with 84 host-owned assertions
outside the model workspace. The original broken fixture must fail those checks.
The model does not run a shell or receive the verifier as a tool. The host runs
model-written modules inside a Linux Bubblewrap namespace with read-only fixture
and verifier mounts, no host home or task-state mounts, no network, and Node
permissions denying writes and subprocesses. This proof requires `/usr/bin/bwrap`
and Linux user namespaces; missing isolation fails closed rather than falling
back to unrestricted execution.

Standalone `run` and `work` initialize configured plugins and normal execution
bootstrap before publishing supervision readiness. Passive `show`, `list`, and
admission commands do not start plugin execution.

The mutation proof uses that standalone CLI bootstrap, then pauses a real fixture
mutation in a configured policy hook,
then cancels or expires its SQL attempt before allowing that hook to return
normally. A matching positive control must write successfully. Inspect the
correlated authority rejection as well as unchanged bytes and the immutable
endpoint; an unrelated backend failure is not a permission-fence proof. Expiry
uses the real reconciler with the recorded expiry timestamp, not a wall-clock
timing test. This exercises admission before permission returns, not rollback or
physical cancellation after permission. These live proofs use existing runtime
authentication and incur model usage; they are not part of the ordinary unit suite.

- [Automations](/automation/cron-jobs) - scheduled jobs that may feed into flows
