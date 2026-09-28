---
summary: "Experimental opt-in supervised task episodes: durable continuation, bounded attempts, and host-checked acceptance"
read_when:
  - You want a durable, bounded task that continues across model attempts under host acceptance rules
  - You are enabling automatic task admission for an agent or running `openclaw sessions supervise`
  - You need to inspect, control, or recover a supervised task
title: "Supervised tasks"
---

Supervised tasks add an **opt-in native controller** for bounded work across
model attempts, commands, reviews, publication, and CI observation. It does not
change ordinary conversation runs. Explicit episodes use
`openclaw sessions supervise`. Automatic admission is a separate per-agent opt-in.

The controller owns continuation between attempts. A final chat answer is not a
completion receipt. Each attempt returns a structured decision, and accepted
workflow criteria are checked by the host before success is committed. A task
needs a recorded objective and observable success criteria. If an explicit task
omits its goal, a bounded, tool-free first attempt must define it or ask for input.
Accepted criteria cannot be silently lowered. Partial success requires a nonempty,
preaccepted subset; model goal inference cannot grant that permission.

Claude CLI attempts and reviews request native schema-constrained terminal output.
The adapter validates that output independently and does not substitute conversational
prose if it is missing or malformed. Native output submission does not enable file,
shell, or other action tools. Existing attempt deadlines, resource limits, and
supervisor recovery budgets still apply; schema-valid output alone cannot authorize
success or lower the accepted criteria.

## Credential selection

A task definition may set `authProfileId` to an existing OpenClaw credential
profile. The controller retains that identifier across attempts and resumes;
it never copies the credential into task records or workspaces. The normal
runtime resolver checks the profile's availability and provider compatibility.
If omitted, the runtime's existing default authentication behavior is unchanged.

For automatic admission, the operator policy may bind profiles by provider:
`"authProfiles": { "anthropic": "anthropic:work" }`. The same binding is used
for classification and the admitted task. Unlisted providers keep their normal
authentication behavior; an Anthropic binding is not forwarded to Codex.
A selected missing or inactive profile fails rather than silently using a
different account. Existing working chat sessions may carry an explicit profile
while fresh native CLI sessions use a separate local login; use the intended
saved profile instead of assuming these are the same credential source.

## Start a supervised task

Use a dedicated configured agent with an explicit per-model `agentRuntime.id` of
`codex` or `claude-cli`, authenticated through that runtime's normal owner. Use
`openai/<model>` for Codex and `anthropic/<model>` for Claude CLI. Claude CLI is
the runtime, not the canonical model provider. See [CLI backends](/gateway/cli-backends).
Do not put credentials in a task file.

The current bounded execution implementation requires Linux, cgroup v2, a working
systemd user manager, user/mount namespaces, Bubblewrap, and the host utilities
`systemd-run`, `systemctl`, `unshare`, `mount`, and `setpriv` at their expected
system paths. Missing isolation or unverifiable scope identity fails closed;
there is no unrestricted fallback. macOS and Windows execution are not supported
by this scope implementation.

Create `task.json` with these fields:

| Field                     | Requirement                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flowId`                  | Optional unique identifier; generated when omitted.                                                                                                                         |
| `agentId`                 | Existing configured agent.                                                                                                                                                  |
| `model`                   | Explicit `provider/model` reference matching the chosen runtime.                                                                                                            |
| `runtime`                 | `codex` or `claude-cli`.                                                                                                                                                    |
| `prompt`                  | Nonempty request, at most 4,096 characters.                                                                                                                                 |
| `goal`                    | Optional `{ objective, success: [{ id, description }], partial: [id] }`. Maximum 32 criteria; IDs are unique. Omit only without `workflow` to request supervised inference. |
| `policy.deadlineAt`       | Future Unix epoch milliseconds; the episode cannot renew this deadline.                                                                                                     |
| `policy.maxAttempts`      | Integer from 1 to 100, including goal definition.                                                                                                                           |
| `policy.attemptTimeoutMs` | Integer from 1,000 to 3,600,000, capped by the episode deadline.                                                                                                            |
| `workflow`                | Optional immutable host workflow contract, described below.                                                                                                                 |

```bash
# Own this one task in the foreground until it reaches an endpoint.
openclaw sessions supervise run task.json

# Alternatively, keep a supervisor running in a separate terminal/service.
openclaw sessions supervise work

# Admit to an already observed general supervisor.
openclaw sessions supervise start task.json
openclaw sessions supervise show <flowId>
```

`run` supervises only its own flow; it does not promise continuation for unrelated
tasks. `work` supervises opted-in episodes in the selected state database.
Foreground execution opens only after this invocation successfully creates its
episode. A rejected duplicate ID must not claim, dispatch, or terminate the
existing episode. `run` exits 0 only for success/partial, otherwise 1. Supervised
command output is JSON; `list` returns up to 256 retained episodes.

If its worker loses custody unexpectedly, `work` replaces it with a new owner;
it never renews a revoked identity. Failed readmission exits nonzero. An explicit
SIGINT or SIGTERM stops the daemon without rearming it. `run` and `work` initialize
configured plugins and runtime bootstrap before advertising readiness. Passive
`show`, `list`, and admission commands do not start plugin execution.

A normal Gateway starts supervision after readiness when the subsystem has already
been activated or an agent enables automatic admission. It resumes observation
after restart. Minimal/test and update-canary Gateways do not activate this
service. Without activation or enabled agents, normal installations remain
non-creating. Keep a Gateway or `work` service running for unattended continuation;
a progress card, presence indicator, or open tracking issue is not a supervisor.

## Enable automatic admission

Configure the agent entry with `taskSupervision.enabled: true` and an absolute
`taskSupervision.policyFile` path. Omission or `enabled: false` leaves ordinary
requests on their existing path. This is an agent-entry fragment, not a complete
configuration:

```json5 validate=false
{
  taskSupervision: {
    enabled: true,
    policyFile: "/path/to/host-owned/task-policy.json",
  },
}
```

Disabling automatic admission does not disable Stop for existing episodes.
Owner-authorized Stop still targets the current conversation's task. If task
cancellation cannot be confirmed, OpenClaw reports that separately while still
stopping the ordinary conversation run.

The JSON policy has required fields `version: 1`, `scope`, `goal`, `workflow`,
`maxAttempts`, `attemptTimeoutMs`, and `episodeTimeoutMs`. `goal` and `workflow`
use the same contracts as an explicit task. The attempt bounds are the same as
above; `episodeTimeoutMs` is 1,000 through 604,800,000 milliseconds (seven days).
`scope` is a nonempty description of the standing authorized work, at most 4,096
characters. The file is limited to 128 KiB, must be a regular non-aliased file
owned by the current host user or root, and must not be group/other writable.
Its bytes are pinned and rechecked after asynchronous admission work.

Eligible owner requests enter through channel replies, authenticated Gateway
`chat.send`, or the supported local CLI root ingress. Internal runs, delegated
work, heartbeats, empty input, and ordinary slash commands do not become new
supervised episodes. A tool-free classification call distinguishes scoped tasks,
ordinary chat, and controls for existing tasks; it cannot grant operations,
replace acceptance criteria, or approve an artifact. Requests require a supported
explicit runtime and current source-session authority. Admission is acknowledged
only after a native supervisor accepts custody and the input receipt is persisted.
Replaying an input ID cannot create another task; reusing it with changed content
is rejected.

Within that source conversation, status, stop/cancel, corrections, and explicit
resume can target existing tasks. Ambiguous targets require selection rather than
silently choosing the newest task. Stop is host-parsed and does not depend on a
working classifier or policy file. Natural-language resume reuses the accepted
attempt bounds and original episode duration, capped at seven days; it does not
invent unlimited continuation. Artifact approval uses the explicit control
surface below, never classifier inference.

## Define a workflow and its acceptance rules

A workflow fixes the operation capabilities and completion rules before model
execution. An explicit task with `workflow` must also supply `goal`; goal inference
is only available without a workflow. The workflow requires `version: 1`, an absolute input `workspace`, `profiles`,
and `acceptance`. `sourcePaths` defaults to `["."]`; select only the needed
relative paths. `maxRecoveryAttempts` defaults to 3 (0–8), and `retentionDays`
defaults to 30 (1–365). The serialized contract is limited to 64 KiB, with at most
64 profiles and 32 acceptance rules. Every accepted goal criterion must have
exactly one rule. Profile and criterion IDs must be unique.

The input workspace is snapshotted into host-owned versioned artifacts, not edited
in place. Model attempts edit disposable private workspaces derived from the last
accepted version. The host stages a candidate, verifies its manifest, joins the
payload and tool-serving descendants, and verifies physical scope closure before
accepting its source version and decision under the current SQL ownership fence.
A stale attempt cannot promote its late writes. This does not copy results back
into the original checkout; inspect the retained artifact or use an accepted
publication profile.

| Profile kind  | Accepted capability                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | Fixed absolute executable and SHA-256, fixed `argv`, relative `cwd` (default `.`), and `timeoutMs`. Workspace writes require `writable: true` (default false). `network` is always false. Up to 16 `readOnlyPaths` pin external inputs by absolute path and SHA-256. `replay` defaults to `reconcile`; `safe` is an explicit replay-policy choice. |
| `review`      | Fixed `runtime`, `agentId`, `model`, `instructions`, selected `paths`, and `timeoutMs`. `maxBytes` defaults to 64 KiB (1–256 KiB). A fresh tool-free reviewer receives the captured files, not repository-wide access. A valid accepting verdict with no P0/P1/P2 findings and unchanged source is required.                                       |
| `publication` | Fixed GitHub target/push repositories, base branch and commit, branch, publisher identity and signing key, author, title/body, and timeout. Creates only a draft PR. It reconciles the exact prepared commit and owned PR marker, refuses unrelated branch movement, and requires a GitHub-verified signature. It does not merge or deploy.        |
| `ci`          | Names an accepted publication profile and required `{ name, appId }` checks. Observes the exact published head; it does not dispatch CI. `pollIntervalMs` defaults to 30 seconds (1–300 seconds). Missing checks remain pending; skipped/neutral are not success.                                                                                  |

All profile `timeoutMs` values are 1,000–3,600,000 milliseconds. The model may
request an accepted profile by ID; it cannot supply new command arguments,
publisher identities, checks, or arbitrary operation input. Profiles with effects,
including publication, must be authorized in the operator's accepted contract.

Acceptance rules are:

- `receipts`: require the named profiles to succeed on the exact current source.
  Missing or stale checks are scheduled through those profiles. A newer failed
  or unfinished check cannot be hidden behind an older successful receipt.
- `artifact`: require a selected relative file to match an accepted SHA-256.
- `json`: require selected top-level JSON fields to equal accepted scalar values.
  These are declarative checks, not model-supplied executable predicates.
- `operator`: require explicit acceptance of the exact retained source hash.
  This cannot replace an automated check.

Workflow success/partial requires a host acceptance proof, consumed with endpoint
settlement. A workflowless episode retains the earlier model-evidence contract:
`acceptedBy: model` means a model report, not independent verification. A reviewer
receipt verifies the accepted review process and verdict; it does not turn model
judgment into a proof of arbitrary goal semantics.

## Interpret status and endpoints

`openclaw sessions supervise show <flowId>` reports the episode and freshness-qualified
custody:

| Field/value                | Meaning                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `continuation: armed`      | A scope-compatible supervisor has a current durable heartbeat. This is an observation, not uninterrupted future availability. |
| `continuation: unknown`    | No fresh supervisor observation exists. Do not claim automatic continuation is currently available.                           |
| `continuation: stopped`    | This episode has an immutable endpoint.                                                                                       |
| `execution: attempt_owned` | An unexpired attempt and its supervisor own execution; this does not prove a model is consuming tokens.                       |
| `execution: not_observed`  | No current attempt execution is established; a timer may still be armed.                                                      |
| `operatorRequired: true`   | The episode ended `input_required`. `false` alone does not mean healthy supervision.                                          |

Observers normally renew every second and expire after ten seconds. Output includes
observation and expiry timestamps. Readers do not repair or create state. SQL
claims and exact attempt fences prevent stale owners from settling successor work.
The last attempt ID is a transcript lookup aid, never permission to replay it.

The endpoint kinds are `succeeded`, `partial`, `input_required`, `failed`, and
`cancelled`. Success/partial must satisfy the accepted criteria. Decisions must be
exact schema-valid JSON, not prose containing a convenient success object.
`effects: unknown` requires reconciliation; `attempt_completed` is not an
exactly-once side-effect receipt. Separately owned operations can have later
receipts even after the coordinator episode ends. Cancellation revokes further
authorized work; it does not roll back effects already sent or prove instant
physical extinction.

The Gateway offers richer, source-authorized inspection:

| Method                       | Result                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.supervision.list`     | Task summaries for the current source session; `agentId` and `sessionKey` are required. Default page size 50, maximum 100; use `after`/`next` for traversal.                                                   |
| `sessions.supervision.get`      | One summary by `flowId`, including retained artifact version/hash, operator criteria, operation states, and notification states.                                                                               |
| `sessions.supervision.artifact` | Inspect an exact `flowId`, `versionId`, and `sourceHash`. Manifest pages contain up to 256 files. Optional `path`/`offset` reads return base64 chunks of up to 64 KiB. No arbitrary host paths or live drafts. |
| `sessions.supervision.control`  | Exact-episode/revision cancel, steer, resume, or artifact approval.                                                                                                                                            |

Unreadable or quarantined records appear as `phase: quarantined`, stopped
continuation, and operator-required repair in these summaries. Original bytes
are retained. The basic CLI `show` and `list` are not substitutes for this fault
projection. Gateway access is tied to the authenticated caller and source-session
lifecycle; an old session ID is not current write authority.

## Control and resume a task

```bash
openclaw sessions supervise cancel <flowId>
openclaw sessions supervise resume <flowId> response.json
openclaw sessions supervise control control.json
```

`response.json` must contain `{ "episode": <currentEpisode>, "input": "...",
"policy": { ... } }` with fresh finite bounds. Resume requires a current general
supervisor and opens a new episode from `input_required`; the old endpoint stays
immutable. Duplicate responses for the previous episode are refused.

`control.json` has `flowId`, `episode`, `revision`, a unique `inputId`, and `action`:

| Action    | Additional fields                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cancel`  | None.                                                                                                                       |
| `steer`   | `input`; changes the next instruction within an active workflow's accepted scope, without replacing its criteria or budget. |
| `resume`  | `input`, `policy`; requires native supervisor custody.                                                                      |
| `approve` | `sourceHash`, `criterionIds`; accepts only operator rules for that exact retained artifact.                                 |

Refresh the task before preparing a control. Changed revisions are rejected;
repeating an identical `inputId` is idempotent, while changed input under that ID
is rejected. A replay returns the original control acknowledgement, not a newer
task revision. Gateway responses separate that acknowledgement from `currentTask`,
the latest observation. Older request-only receipts cannot reconstruct an
acknowledgement: refresh the task instead of resubmitting the action under a new ID.
Local CLI controls use local operator authority; the request cannot
choose its actor. Approval records evidence but does not rewrite an endpoint or
implicitly resume an input-stopped task. After inspecting and approving the
artifact, explicitly resume if continuation is needed.

## Recovery and resource boundaries

Workflow recovery can start a fresh attempt from the last accepted artifact and
durable operation receipts. It discards no uncertain evidence and never treats
an abandoned draft as accepted work. The current step, including an accepted
operator answer, survives recovery; formatting guidance does not replace it.
`maxRecoveryAttempts: 0` disables this
managed recovery; retries remain bounded by the recovery count, attempt count,
and deadline. Recovery backoff starts at one second and caps at 30 seconds.
Malformed decisions can receive bounded formatting feedback, not a relaxed JSON
parser or an increased attempt budget.

Workflowless dispatched interruptions retain the conservative `input_required`
path. With no remaining recovery policy or unresolved effects, inspect the
endpoint and receipts before explicitly resuming. A durable dispatch reservation
precedes invocation, so a crash in that gap can also require reconciliation.
Undispatched claims can be reclaimed, but still consume an attempt. Independent
operations have their own execution identity and reconciliation; replacing a
model attempt is not permission to repeat a publication.

The implementation reserves physical capacity before launching model, command,
or reviewer work. SQL lease expiry alone does not free that capacity. Closure
uses the recorded host/boot identity, systemd invocation, exact cgroup identity,
and recursive population observation. Unknown launch/bind windows retain their
reservation; the cleanup worker does not kill a process by guessed unit name or
reuse an uncertain launch. Legacy dispatched reviewers without scope evidence
cannot acquire that evidence retroactively.

Supervised Codex reviews require a local native process, including Platform
API-key routes. They do not substitute the host's direct completion transport.
Prepared keys use an isolated agent home; custom endpoints or request headers
that the native route cannot reproduce are rejected before startup.

Cleanup also examines terminal episodes and earlier operation generations. A
bootstrap reservation can be retired only when exact evidence proves it never
dispatched. Once launch transport starts, its extinction must be established
before an absent scope releases capacity. Same-host records from a previous
boot can be retired without signaling current units; missing or foreign-host
identity remains unknown and retains capacity.

| Execution        | Memory / process limits   | Private working storage |
| ---------------- | ------------------------- | ----------------------- |
| Model attempt    | 2 GiB, 256 tasks, no swap | 128 MiB, 32,768 inodes  |
| Reviewer         | 2 GiB, 256 tasks, no swap | 128 MiB, 32,768 inodes  |
| Command defaults | 1 GiB, 128 tasks, no swap | 64 MiB, 32,768 inodes   |

Command `resourceLimits` can set memory (512 MiB–8 GiB), tasks (16–512), working
bytes (8 MiB–1 GiB), and working inodes (128–65,536). Memory must be page-aligned
and cover 384 MiB of frozen inputs, the working-byte budget, and 128 MiB process
headroom. These are kernel memory/process and private tmpfs limits, not CPU quotas
or a whole-host disk budget. Source snapshots separately cap regular files at
8 MiB each and 64 MiB total, excluding `.git` and `node_modules`; symlinks,
hardlinks, unsupported file types, and oversized traversals are rejected.

Model and review runtimes retain their normal authentication owner and protected
inherited environment. Their namespace exposes the host read-only except for the
private working tree and explicit host-owned runtime write roots needed for
state, sessions, transcripts, and caches. **Those runtime-root writes are outside
the working tmpfs budget.** Standard null, zero, and entropy devices are available
for runtime startup; the rest of the host device tree remains disabled and
read-only. Network remains available for model service access.
This is not an arbitrary-native-code or host-confidentiality sandbox. Resource
limits assume trusted runtimes and plugins do not delegate work to host services
or alter their scope; read-only host mounts do not isolate local control sockets.
Native
shell/file tools remain disabled for model attempts; supported file tools are
OpenClaw-owned. Command profiles use a different no-network mount boundary with
only accepted inputs. Neither boundary is an external-effect transaction ledger
or a rollback guarantee.

## Delivery, retention, and compatibility

Automatically admitted tasks persist accepted/endpoint notification obligations
separately from task outcomes. The Gateway notification worker appends source
history and, where a current conversation route exists, uses its durable delivery
path. A stale session or changed route does not authorize delivery elsewhere.
States are `pending`, `queued`, `delivered`, `suppressed`, `failed`, or `unknown`;
a queued notification is not delivered, and a failed notification does not change
a successful task endpoint. `delivered` without a conversation route means source
session history, not an external message. Standalone supervision is not the
Gateway notification service. Discord presence is not a task-custody signal.

Retention applies to host-owned artifact allocations, not the input workspace.
The worker runs bounded cleanup approximately every minute. The default 30-day
retention does not override forensic holds: input-required/quarantined tasks,
unknown effects, unresolved physical scopes, and pending/unknown delivery retain
evidence. Safely released disposable drafts can be reclaimed earlier. An expired
artifact may become unavailable while its receipt remains. Episode records and
supervisor tombstones are not automatically archived or deleted.

Command completion commits its accepted workspace version and immutable operation
receipt in the same SQLite transaction. A failed receipt write cannot publish a
new accepted workspace; staged files alone are not accepted results.

These contracts use OpenClaw state schema version 19, including durable attempt
resources, workspace versions, candidates, operation receipts, and acceptance.
Rows retained from the retired Tasks and TaskFlow runtime (`flow_runs`) are untouched. Follow
[Database schemas](/reference/database-schemas) and the supported doctor migration
path for an older database; do not assume an older binary can continue these
episodes. Earlier PoC records remain evidence, not proof of the new physical
scope guarantees.

New active episode writes reserve serialized UTF-8 headroom: prompt, goal, and
next-step content together may use 40 KiB, control metadata 8 KiB, and an endpoint
16 KiB. The total episode and CLI definition limit is 64 KiB. These are JSON byte
limits, including escaping, not character counts. Admission refuses more than
128 active episodes. Oversized new content is rejected transactionally; evidence
is not silently truncated. An attempt is a full OpenClaw turn, not necessarily
one physical provider request; internal runtime retries stay inside it.

Legacy active records carrying unchanged content remain readable where valid.
An already full record may lack endpoint space; unreadable/unsafe records are
quarantined with their original bytes preserved instead of blocking healthy
work. Reconcile such records before relying on the endpoint guarantee.

With a functioning supervisor, writable database, advancing clock, and eventual
CPU scheduling, finite episode bounds drive a recorded endpoint. During a
whole-host outage or database failure, timely publication cannot be promised;
status becomes unknown and a restarted owner reconciles when dependencies return.
An endpoint alone does not certify cleanup. This remains experimental: the new
model/reviewer containment and recovery paths need complete real-runtime
validation across both adapters before being treated as end-to-end proven.

## Developer proofs

The following source-checkout harnesses cover distinct boundaries. A passing
earlier coding, publication, or CI proof does not certify later containment
changes, the complete workflow, or a deployed Gateway.

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
- [Goal](/tools/goal) - durable per-session objectives and the `/goal` controls

## Related

- [CLI: sessions](/cli/sessions) - command reference for `openclaw sessions supervise`
- [Automation Overview](/automation) - all automation mechanisms at a glance
