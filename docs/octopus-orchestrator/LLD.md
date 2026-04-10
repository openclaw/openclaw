# OpenClaw Octopus Orchestrator LLD

## Status

Draft v0.2

## Revision Notes

- v0.3 (ultraplan pass): added ArmSpec and GripSpec schemas, event schema versioning and migration rules, scheduler algorithm with fairness, habitat capability taxonomy, RetryPolicy shape, CostRecord and mission budget model, backpressure handling, forward-progress heartbeat distinct from liveness lease, mission graph schema, retention alignment with the existing task ledger, subagent/ACP longevity model, and explicit cross-references to new CONFIG.md, TEST-STRATEGY.md, and OBSERVABILITY.md artifacts.
- v0.2: added MissionRecord; fixed arm state enum and added missing event types; picked SQLite for MVP storage with a named Postgres migration trigger; added `--json` operator CLI output mode; noted that `policy_profile` field is forward-compatible but not enforced until Milestone 5; specified the `octo.*` Gateway WS method namespace as the Head↔Node-Agent wire; pinned all state paths to the existing `~/.openclaw/` layout; noted that the structured-adapter first delivery reuses the existing OpenClaw subagent and ACP runtimes rather than building a new runtime; marked duplicate-execution resolution and lease timings as tunable with explicit validation milestones.

## Purpose

This document defines the low-level design for the OpenClaw Octopus Orchestrator. It translates the HLD into concrete internal models, interfaces, state machines, recovery flows, storage primitives, and implementation order.

The system is designed around durable arm sessions, explicit shared state, and runtime adapters that normalize both structured CLIs and PTY/tmux-backed interactive tools. It composes on existing OpenClaw primitives (Gateway WS, native subagents, ACP runtime, background task ledger, device pairing, per-agent sandbox/tool policy) rather than replacing them — see HLD §OpenClaw Integration Foundation.

## Core Domain Objects

### MissionRecord

Represents a top-level unit of orchestrated work composed of one or more grips and arms.

Fields:

- `mission_id`
- `title`
- `owner` (operator identity, OpenClaw agent id, or automation source)
- `status` (`active`, `paused`, `completed`, `aborted`, `archived`)
- `grip_ids[]`
- `arm_ids[]`
- `policy_profile_ref` (inherited by child arms unless overridden)
- `created_ts`
- `updated_ts`
- `metadata` (free-form, includes source such as `cron`, `cli`, `operator`, `flow`)

Notes:

- missions are the unit of mission graph planning by the Head
- a mission may group grips across habitats
- missions with `source: cron|flow|hook|standing_order` in metadata are created from existing OpenClaw automation surfaces (cron jobs, Task Flow, hooks, standing orders) rather than operator CLI; see INTEGRATION.md §Automation trigger surfaces

### ArmRecord

Represents a durable supervised execution arm.

Fields:

- `arm_id`
- `mission_id`
- `node_id`
- `adapter_type` (`structured_subagent`, `cli_exec`, `pty_tmux`, `structured_acp`) — see §Structured adapter mapping for preference order; per OCTO-DEC-036 / OCTO-DEC-037, `cli_exec` and `pty_tmux` are the primary paths for external agentic coding tools and `structured_acp` is opt-in only
- `runtime_name` (e.g. `openclaw-subagent`, `acpx:codex`, `acpx:claude`, `tmux:bash`)
- `agent_id` (OpenClaw agent id this arm runs under — determines the policy ceiling)
- `task_ref` (id of the corresponding record in OpenClaw's existing background task ledger, when applicable)
- `state`
- `current_grip_id`
- `lease_owner`
- `lease_expiry_ts`
- `session_ref`
- `checkpoint_ref`
- `health_status`
- `restart_count`
- `policy_profile` (forward-compatible; enforcement begins in Milestone 5 — see §Policy Enforcement Timeline)
- `created_ts`
- `updated_ts`

Notes:

- `arm_id` is immutable
- `session_ref` may change across recovery but remains attached to the same arm when possible
- `restart_count` is used for quarantine thresholds and noisy-arm detection
- `adapter_type` values `structured_subagent` and `structured_acp` map directly onto existing OpenClaw runtimes; see HLD §OpenClaw Integration Foundation
- `task_ref` keeps the octo registry in lock-step with `openclaw tasks list` so operators never see diverging views of the same background run

### GripRecord

Represents a unit of assigned work.

Fields:

- `grip_id`
- `mission_id`
- `type`
- `input_ref`
- `desired_capabilities`
- `priority`
- `assigned_arm_id`
- `status`
- `retry_policy`
- `timeout_s`
- `claim_set`
- `result_ref`
- `side_effecting` (bool — when true, reassignment uses the extended 60s grace window per PRD §Answered Design Questions #2)
- `idempotency_key` (required for any grip that triggers a side-effecting `octo.*` call, reuses existing Gateway idempotency semantics)

Notes:

- grips are assignable, retryable, and requeueable
- the scheduler operates over grips, not raw prompts

### SessionRef

Represents a concrete runtime session binding.

Fields:

- `structured_session_id` optional
- `tmux_session_name` optional
- `pty_pid` optional
- `cwd`
- `worktree_path`
- `attach_command`
- `recovery_metadata`

Notes:

- structured and terminal references may coexist in hybrid runtimes
- `recovery_metadata` stores adapter-specific resume hints

### ClaimRecord

Represents ownership of a shared resource.

Fields:

- `claim_id`
- `resource_type` (`file`, `dir`, `branch`, `port`, `task-key`)
- `resource_key`
- `owner_arm_id`
- `mode` (`exclusive`, `shared-read`)
- `lease_expiry_ts`

Notes:

- claims are tied to lease expiry
- claim reassignment requires explicit release or expiry

### ArtifactRecord

Represents produced outputs or persisted state.

Fields:

- `artifact_id`
- `artifact_type` (`summary`, `log`, `patch`, `checkpoint`, `report`, `stdout-slice`, `stderr-slice`)
- `mission_id`
- `arm_id`
- `storage_ref`
- `metadata`
- `created_ts`

## Spawn Specifications

### ArmSpec

The input to `octo.arm.spawn`. This is the primary API contract for creating an arm.

Fields:

- `spec_version` (int, currently `1`)
- `mission_id`
- `adapter_type` (`structured_subagent` | `cli_exec` | `pty_tmux` | `structured_acp`)
- `runtime_name` (adapter-specific, e.g. `openclaw-subagent`, `claude-code`, `codex`, `gemini`, `tmux:bash`, `acpx:claude`)
- `agent_id` (OpenClaw agent id — sets the policy ceiling)
- `desired_habitat` (optional; for sticky placement or explicit node pin)
- `desired_capabilities[]` (see §Habitat Capability Taxonomy)
- `cwd` (absolute path within the agent workspace)
- `worktree_path` (optional; branch-scoped workspace if applicable)
- `env` (map of environment variables; merged over the node agent's base env)
- `initial_input` (optional first message/prompt/command)
- `policy_profile_ref` (optional narrower profile; must fit inside the agent ceiling)
- `resource_hints` (optional: `cpu_weight`, `memory_mb_hint`, `expected_runtime_s`)
- `idempotency_key` (required)
- `labels` (free-form map used for scheduler affinity and operator filtering)

Adapter-specific `runtime_options`:

- `structured_subagent`: `{ model, thinking, runTimeoutSeconds, cleanup }` (mirrors existing `sessions_spawn` params)
- `cli_exec`: `{ command, args[], structuredOutputFormat, initial_input, stdinMode, runTimeoutSeconds, maxStdoutBytes }` — `structuredOutputFormat` declares what the tool's output mode is (e.g. `stream-json`, `json`, `ndjson`) so the adapter knows how to parse events; `stdinMode` declares whether the tool takes its prompt on stdin or as a CLI arg
- `pty_tmux`: `{ command, args[], tmuxSessionName, captureCols, captureRows, idleTimeoutS }`
- `structured_acp`: `{ acpxHarness, model, permissions, thread, mode, bindConversation }` (mirrors existing `/acp spawn`; opt-in only per OCTO-DEC-036)

ArmSpec is validated against a TypeBox schema before it reaches the adapter. Invalid specs are rejected with a structured error and never produce a state transition.

### GripSpec

The input to grip creation (`octo.grip.create`, internal scheduler interface).

Fields:

- `spec_version` (int, currently `1`)
- `mission_id`
- `type` (free-form domain tag: `code-review`, `refactor`, `test-run`, `research`, etc.)
- `input_ref` (reference to input payload — file path, artifact id, inline blob id)
- `desired_capabilities[]`
- `priority` (int, higher is more urgent; default 0)
- `retry_policy` (see §Retry and Backoff)
- `timeout_s` (hard wall clock)
- `side_effecting` (bool)
- `required_claims[]` (pre-declared resource claims the grip will need)
- `idempotency_key` (required if `side_effecting: true`)
- `labels`

GripSpec is the unit the scheduler reasons over. A mission can emit many grips before any arms are selected to run them.

## Event Schema

Every state transition is written as an append-only event.

Fields:

- `event_id` (ULID — monotonic, unique, sortable)
- `schema_version` (int; event schema version at write time)
- `entity_type` (`mission`, `arm`, `grip`, `claim`, `lease`, `artifact`, `operator`, `policy`)
- `entity_id`
- `event_type`
- `ts` (ISO 8601 with millisecond precision, UTC)
- `actor` (operator identity, agent id, node id, or `system`)
- `causation_id` (event_id that caused this one; null for root events)
- `correlation_id` (groups related events across entities — usually mission_id)
- `payload` (event-type-specific; schema versioned by `schema_version`)

### Event Schema Versioning and Migration

The event log is append-only and replayed for recovery, so schema evolution must be forward- and backward-safe.

**Rules:**

1. `schema_version` starts at `1`. Increment only on **breaking** payload changes (field removal, type change, semantic change). Additive field changes do not bump the version.
2. The Head maintains a migration table: `schema_version -> canonical_payload_transform` that promotes older events to the current in-memory representation on replay.
3. Transforms must be **pure** and **total** — they cannot lose information and cannot fail on any historical input. If a breaking change cannot be losslessly migrated, the old events are preserved verbatim and a new event type is introduced instead.
4. The event log is never rewritten in place. Migration happens on replay into the in-memory registry, not on disk.
5. Every schema bump ships with a replay test on a snapshot of the prior-version log.

**Practical implication:** adding new event types, new entity types, or additive fields is cheap; removing or retyping is expensive. The first several milestones should prefer additive evolution.

### Event Log Retention

- Event log retention is **indefinite by default** through Milestone 3. Operators can configure a rolling window in `openclaw.json` at `octo.events.retentionDays` (default: `null` = keep).
- Retention truncation is done by **archival**, not in-place deletion: the head of the log is moved to `~/.openclaw/octo/events-archive/<date>.jsonl.gz` and the active log continues. Replay paths know how to pull from archive on demand.
- This is deliberately more conservative than the existing `openclaw tasks list` ledger, which prunes terminal task records after 7 days. `task_ref` on ArmRecord is a weak pointer — Octopus does not assume the referenced task record still exists when replaying older events. If a task_ref dereference fails, the arm's event log is still authoritative.

### Core event types

Arm:

- `arm.created`
- `arm.starting`
- `arm.active`
- `arm.idle`
- `arm.blocked`
- `arm.failed`
- `arm.quarantined`
- `arm.completed`
- `arm.terminated`
- `arm.archived`
- `arm.reattached`
- `arm.recovered`

Grip:

- `grip.created`
- `grip.assigned`
- `grip.running`
- `grip.blocked`
- `grip.failed`
- `grip.completed`
- `grip.abandoned`
- `grip.ambiguous` (duplicate-execution suspicion)

Mission:

- `mission.created`
- `mission.paused`
- `mission.resumed`
- `mission.completed`
- `mission.aborted`
- `mission.archived`

Claim / lease / artifact:

- `claim.acquired`
- `claim.released`
- `claim.expired`
- `lease.renewed`
- `lease.expired`
- `artifact.recorded`

Operator / policy:

- `operator.intervened`
- `operator.approved`
- `operator.rejected`
- `operator.terminated`
- `policy.decision` (allow/deny/escalate with actor and rule id)

## State Machines

### Arm state machine

States: `pending`, `starting`, `active`, `idle`, `blocked`, `failed`, `quarantined`, `completed`, `terminated`, `archived`.

```text
pending -> starting
starting -> active | failed
active -> idle | blocked | failed | quarantined | completed | terminated
idle -> active | completed | failed | terminated
blocked -> active | failed | quarantined | terminated
failed -> starting | quarantined | terminated
quarantined -> starting | terminated
completed -> archived
terminated -> archived
```

`terminated` is reached via operator `octo arm terminate` or policy-forced shutdown; `archived` is the final absorbing state after retention policy is applied.

### Grip state machine

```text
queued -> assigned
assigned -> running
running -> blocked | failed | completed
blocked -> running | failed
failed -> queued | abandoned
completed -> archived
```

Rules:

- every transition must be written through an event
- arm and grip state transitions should use CAS-style update semantics to avoid conflicting writers
- invalid transitions are rejected and recorded as anomalies

## Runtime Adapter Interfaces

### Base adapter contract

All adapters must implement:

- `spawn(spec) -> SessionRef`
- `resume(session_ref) -> SessionRef`
- `send(session_ref, message)`
- `stream(session_ref) -> Event[]`
- `checkpoint(session_ref) -> CheckpointMeta`
- `terminate(session_ref)`
- `health(session_ref) -> HealthStatus`

### StructuredAdapter

Used for machine-readable CLI runtimes.

Expected capabilities:

- explicit session id or resumable reference
- streamable output events
- machine-readable final state or result

Example candidates:

- Claude Code structured modes
- future CLI agents with JSON or event streams

Structured adapter output should normalize to:

- partial output events
- final result events
- cost/token metadata where available
- interruption, retry, and health signals

### PtyTmuxAdapter

Used for unstructured or interactive tools.

Methods:

- `spawn(spec) -> SessionRef`
- `attach(session_ref)`
- `send_input(session_ref, text)`
- `send_keys(session_ref, keys)`
- `capture(session_ref) -> Event[]`
- `checkpoint(session_ref) -> CheckpointMeta`
- `terminate(session_ref)`
- `discover_existing() -> SessionRef[]`
- `health(session_ref) -> HealthStatus`

Implementation notes:

- tmux is required for durable session naming and reattach
- PTY output is chunked and normalized into event records
- periodic checkpoints include cwd, process liveness, pane/session references, and last captured offsets

### Adapter mapping and preference order

Per OCTO-DEC-036, the preference order for external agentic coding tools is `cli_exec` → `pty_tmux`. The `structured_subagent` adapter is primary for OpenClaw's own native runtime work, and `structured_acp` is available as an opt-in fourth path but is never selected automatically.

**SubagentAdapter (`adapter_type: structured_subagent`)** — reuses OpenClaw's native subagent runtime

- `spawn(spec)` → calls existing `sessions_spawn` (default runtime, `deliver: false`, lane `subagent`) and captures the returned run id and session key
- `resume(ref)` → rebinds to the existing session key; if the subagent is complete, the arm transitions to `completed` and no new run is started
- `stream(ref)` → consumes the existing subagent output stream; announce messages are suppressed at the adapter level (the Head handles result delivery)
- `checkpoint(ref)` → snapshots run metadata and the latest `sessions_history` cursor
- `terminate(ref)` → `sessions_spawn` cancel / kill via the existing `/subagents kill` path
- `task_ref` points at the `subagent`-runtime entry in `openclaw tasks list`
- **Primary use:** work that fits OpenClaw's own native runtime (OpenClaw talking to its model provider directly under its own API terms). Not used to wrap external coding tools.

**CliExecAdapter (`adapter_type: cli_exec`)** — NEW in OCTO-DEC-037; primary path for external agentic coding tools with a structured CLI output mode

- `spawn(spec)` → spawns `runtime_options.command` with `runtime_options.args` as a subprocess (using Node.js `child_process.spawn` or equivalent). Working directory is `spec.worktree_path` or `spec.cwd`. Environment is the node-agent base env merged with `spec.env`. No PTY, no tmux.
- `stream(ref)` → reads the subprocess stdout line-by-line and parses each line according to `runtime_options.structuredOutputFormat` (e.g. `stream-json` → one JSON object per line → emit as structured `arm.output` event with cost metadata when the tool provides it)
- `send(ref, message)` → writes to the subprocess stdin if `runtime_options.stdinMode` is `open`; otherwise this is not supported and returns a structured error (many CLI tools take their prompt once at launch and do not accept follow-up input)
- `checkpoint(ref)` → snapshots the subprocess pid, elapsed time, stdout byte count, any known tool-reported progress marker
- `terminate(ref)` → sends SIGTERM, escalates to SIGKILL after `runTimeoutSeconds`
- `health(ref)` → checks subprocess liveness and elapsed time
- **Primary use:** driving tools that ship a non-interactive structured CLI mode, the way a developer would drive them from a terminal. Canonical examples: `claude -p --output-format stream-json`, `codex exec --json`, `gemini -p --json`. Zero ACP involvement; zero programmatic-protocol coupling.
- **No `task_ref`** — cli_exec arms do not create records in OpenClaw's existing background task ledger because they are not going through `sessions_spawn`. Octopus maintains its own ArmRecord and event log for these runs. A future integration may add mirrored task-ledger entries if useful for unified views, but this is not required.

**PtyTmuxAdapter (`adapter_type: pty_tmux`)** — primary path for external agentic coding tools without a structured CLI mode, and the universal fallback for any terminal-driven tool

- `spawn(spec)` → creates a new tmux session (named per `runtime_options.tmuxSessionName` or derived from `arm_id`), launches `runtime_options.command` with args inside it. PTY dimensions from `captureCols` / `captureRows`.
- `attach(ref)` → returns an attach command an operator can use to drop into the tmux session directly (`tmux attach -t <session>`)
- `send_input(ref, text)` → sends keystrokes to the tmux pane via `tmux send-keys`
- `send_keys(ref, keys)` → sends control sequences (for key combinations, arrow keys, etc.) to the pane
- `stream(ref)` / `capture(ref)` → reads tmux pane output via `tmux capture-pane -p` on a polling interval (or via PTY-side capture if driving directly); emits normalized byte-level `arm.output` events. No structured event parsing.
- `checkpoint(ref)` → snapshots cwd, process liveness, tmux session name, current pane byte offset, most recent pattern-matched progress signal
- `terminate(ref)` → `tmux kill-session -t <session>` (and SIGKILL the root process if tmux cleanup fails)
- `discover_existing()` → `tmux list-sessions` on startup so the SessionReconciler can match live tmux sessions to known arm ids
- `health(ref)` → `tmux has-session` plus pane activity check
- **Primary use:** external tools with interactive TUIs (Claude Code when run without `-p`, anything with a full-screen curses/ink-style interface), and any terminal tool that needs human-grade supervision. **Advantage over `cli_exec`:** operators can `/octo attach <arm_id>` and literally watch the tool work in real time, taking over the keyboard if needed.

**AcpAdapter (`adapter_type: structured_acp`)** — available but opt-in only

- **Demoted from default path per OCTO-DEC-036.** ACP remains in the adapter layer so users who explicitly select it in an ArmSpec can get an ACP-backed arm, but the scheduler and the agent decision guide never choose it automatically.
- `spawn(spec)` → calls existing `sessions_spawn({runtime: "acp", agentId: <harness>})` targeting `acpx`
- `resume(ref)` → reopens the ACP session by its `agent:<agentId>:acp:<uuid>` key
- `stream(ref)` → consumes ACP session events
- `send(ref, message)` → maps to existing `/acp steer` or direct message send depending on mode
- `checkpoint(ref)` → captures ACP session id, conversation bindings, and current runtime options
- `terminate(ref)` → routes to existing `/acp close` or `/acp cancel`
- `task_ref` points at the `acp`-runtime entry in `openclaw tasks list`
- **Use case:** scenarios where the user explicitly wants ACP semantics (e.g. conversation-bound ACP sessions on messaging channels, which ACP handles natively) or where a specific harness is only reachable through ACP. For everything else, prefer `cli_exec` or `pty_tmux`.

**Net new build in Milestone 2 is the `CliExecAdapter` and `PtyTmuxAdapter`.** `SubagentAdapter` and `AcpAdapter` are thin wrappers over existing OpenClaw code paths.

## Head ↔ Node Agent Wire Contract

The Head does not open a new listening socket. All Head↔Node-Agent communication reuses the OpenClaw Gateway WebSocket protocol with a new `octo.*` method namespace, as specified in HLD §OpenClaw Integration Foundation.

### Connect frame

Node Agents connect to the Gateway with `role: node` and advertise an `octo` capability:

```json
{
  "type": "connect",
  "params": {
    "role": "node",
    "deviceId": "...",
    "platform": "darwin",
    "deviceFamily": "mac",
    "auth": { "token": "<device token>" },
    "caps": {
      "octo": {
        "version": "1",
        "adapters": ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"]
      }
    },
    "commands": [
      "octo.arm.spawn",
      "octo.arm.attach",
      "octo.arm.send",
      "octo.arm.checkpoint",
      "octo.arm.terminate",
      "octo.arm.health",
      "octo.node.capabilities",
      "octo.node.reconcile"
    ]
  }
}
```

Pairing, `connect.challenge` signing, platform/deviceFamily binding, and auth mode all follow existing Gateway behavior unchanged.

### Request methods (Head → Node Agent)

| Method                   | Purpose                                                    | Requires idempotency key |
| ------------------------ | ---------------------------------------------------------- | ------------------------ |
| `octo.arm.spawn`         | launch an arm under a given `ArmSpec`, return `SessionRef` | yes                      |
| `octo.arm.attach`        | open an operator attach stream for a live arm              | no                       |
| `octo.arm.send`          | deliver input to a structured or PTY arm                   | yes                      |
| `octo.arm.checkpoint`    | force a checkpoint flush                                   | yes                      |
| `octo.arm.terminate`     | terminate an arm with reason                               | yes                      |
| `octo.arm.health`        | current health snapshot                                    | no                       |
| `octo.node.capabilities` | capability manifest                                        | no                       |
| `octo.node.reconcile`    | force session reconciliation pass                          | yes                      |

### Push events (Node Agent → Head)

- `octo.arm.state` — state transitions
- `octo.arm.output` — normalized output (stdout/stderr slices, structured events, cost/token metadata when available)
- `octo.arm.checkpoint` — checkpoint metadata
- `octo.lease.renew` — heartbeat carrying lease expiry extension
- `octo.node.telemetry` — periodic health and load
- `octo.anomaly` — reconciliation anomalies

### Durability note

Per existing Gateway invariant, push events are not replayed on client gap. Durability lives in the control plane event log, not the wire. Node Agents persist unacked state transitions in a local sidecar log (`~/.openclaw/octo/node-<nodeId>/pending.jsonl`) and replay them on reconnect until the Head acknowledges.

The concrete wire schema will be added to the existing OpenClaw TypeBox protocol definitions in Milestone 1 / Phase 1 work.

## Node Agent Internals

Modules:

- `Launcher`
- `TmuxManager`
- `ProcessWatcher`
- `LeaseHeartbeat`
- `TelemetryPublisher`
- `PolicyEnforcer`
- `SessionReconciler`

Responsibilities:

- launch new arms on the node
- keep leases renewed
- capture output and publish telemetry
- reconcile registry state against live tmux/process state
- restore known sessions after restart
- enforce local execution constraints

### SessionReconciler behavior

On startup or periodic audit:

- enumerate known tmux sessions
- enumerate tracked processes
- compare against local persisted mapping
- emit `arm.recovered` or anomaly events
- mark missing sessions as suspected failures

## Control Plane Services

### RegistryService

Responsibilities:

- store current arm and grip records
- expose CAS update operations
- maintain indexed views by mission, node, state

### EventLogService

Responsibilities:

- append event records
- support replay and correlation queries
- expose time-ordered streams for operator surfaces

### LeaseService

Responsibilities:

- issue leases
- renew leases
- expire leases
- move entities to suspect or recoverable states on missed renewals

### ClaimService

Responsibilities:

- acquire claims
- release claims
- expire stale claims
- detect conflicting ownership

### ArtifactService

Responsibilities:

- persist artifact metadata
- manage references to logs, checkpoints, summaries, patches
- support artifact lookup by mission or arm

### SchedulerService

Responsibilities:

- pick candidate arms/habitats for queued grips
- enforce policies and resource constraints
- prioritize sticky assignment and locality

See §Scheduler Algorithm for the concrete placement and fairness model.

### PolicyService

Responsibilities:

- resolve policy profiles by arm/runtime/node
- answer allow/deny/escalate decisions
- log policy-driven intervention outcomes

## Habitat Capability Taxonomy

Scheduling requires a typed capability language. Capabilities are declared by Node Agents in `octo.node.capabilities` and matched against `desired_capabilities[]` on GripSpec and ArmSpec.

### Capability namespaces

- `runtime.*` — adapter/runtime availability: `runtime.subagent`, `runtime.acp.acpx`, `runtime.acp.codex`, `runtime.acp.claude`, `runtime.acp.gemini`, `runtime.pty_tmux`
- `os.*` — operating system facts: `os.darwin`, `os.linux`, `os.arch.arm64`, `os.arch.x86_64`
- `tool.*` — installed binaries: `tool.git`, `tool.node`, `tool.python3`, `tool.docker`, `tool.tmux`
- `net.*` — network zones: `net.internet`, `net.tailnet`, `net.lan_only`, `net.airgapped`
- `resource.*` — hardware characteristics: `resource.gpu.nvidia`, `resource.gpu.apple`, `resource.memory.ge_16gb`, `resource.memory.ge_64gb`
- `auth.*` — credential availability: `auth.anthropic`, `auth.openai`, `auth.github`, `auth.aws` — presence only, no material
- `fs.*` — filesystem access: `fs.shared_workspace`, `fs.local_only`, `fs.nfs`
- `agent.<id>` — OpenClaw agent binding: a node scoped to `agent.home` can only host arms bound to the `home` agent id
- `label.<key>.<value>` — operator-defined free-form labels for affinity

### Matching semantics

- Capabilities are **required** by default. `desired_capabilities: ["runtime.pty_tmux", "tool.git"]` means the node must have both.
- Prefix wildcards allowed: `runtime.acp.*` matches any ACP harness.
- Negative capabilities via `!`: `!net.internet` forbids placement on nodes with internet access.
- Preferences (as opposed to requirements) use `preferred_capabilities[]` on GripSpec; these are soft and feed into the scoring function, not the filter.

### Declaration format

Nodes return their capabilities on `octo.node.capabilities` as:

```json
{
  "node_id": "...",
  "agent_id": "home",
  "capabilities": [
    "runtime.subagent",
    "runtime.acp.acpx",
    "runtime.acp.codex",
    "runtime.pty_tmux",
    "os.darwin",
    "os.arch.arm64",
    "tool.git",
    "tool.tmux",
    "net.internet",
    "resource.memory.ge_16gb"
  ],
  "capacity": { "max_arms": 8, "current_arms": 2, "cpu_weight_budget": 16 }
}
```

## Scheduler Algorithm

### Inputs

- Queue of unassigned grips (from `grip.created` events)
- Current arm registry (with state, current grip, node, lease expiry)
- Current node capacity snapshots
- Mission priorities and fairness state

### Hard filters (must pass)

1. Node's declared capabilities superset of grip's `desired_capabilities`
2. Node's `agent_id` binding is compatible with grip's mission's `agent_id`
3. Node's `current_arms < max_arms`
4. No required claim conflict (see §ClaimService)
5. Policy profile of the grip does not exceed the node's agent ceiling

### Scoring function (higher is better)

```
score(grip, node) =
      3.0 * stickiness(grip, node)          # prior arm still warm on this node
    + 2.0 * locality(grip, node)            # worktree/cache/artifacts present
    + 1.5 * preferred_match(grip, node)     # soft capability matches
    + 1.0 * (1 - utilization(node))         # load balance
    - 2.0 * recent_failure_rate(node)       # degraded node penalty
    - 1.0 * cross_agent_id_penalty          # prefer staying within one agent id
```

Weights are exposed in `openclaw.json` under `octo.scheduler.weights` for operator tuning.

### Fairness across missions

Grip selection from the queue is **weighted round-robin by mission**, not FIFO:

- Each mission has a virtual time counter.
- When the scheduler picks the next grip to place, it selects the eligible grip from the mission with the lowest virtual time.
- On placement, the mission's virtual time advances by `1 / mission_priority`.
- Higher priority missions advance slower → get more grips placed → fairness biased toward priority without starvation.

This prevents one mission with 10,000 grips from monopolizing the entire arm pool.

### Preemption

No preemption in MVP. Once a grip is assigned, it runs to completion, failure, timeout, or operator terminate. Preemption is a Phase 6 consideration and requires the policy engine to gate it.

### Sticky vs spread

Default is sticky: the scheduler prefers to reuse a warm arm for the next grip in the same mission on the same node. Operators can override per-mission with `mission.scheduling.spread: true` for cases where parallel fan-out is the goal.

## Retry and Backoff

### RetryPolicy schema

```
{
  "max_attempts": 3,
  "backoff": "exponential" | "linear" | "fixed",
  "initial_delay_s": 5,
  "max_delay_s": 300,
  "multiplier": 2.0,
  "retry_on": ["transient", "timeout", "adapter_error"],
  "abandon_on": ["policy_denied", "invalid_spec", "unrecoverable"]
}
```

### Failure classification

Every adapter `stream()` or `send()` failure is classified into one of:

- `transient` — network blip, node agent disconnected, adapter retryable error → retry
- `timeout` — wall-clock timeout exceeded → retry if budget remains
- `adapter_error` — internal adapter bug → retry, but quarantine the arm if it recurs
- `policy_denied` — blocked by policy → abandon, do not retry
- `invalid_spec` — ArmSpec/GripSpec validation failed → abandon
- `unrecoverable` — runtime explicitly reports a non-retryable error → abandon

### Quarantine thresholds

- Arm `restart_count` exceeding `octo.quarantine.maxRestarts` (default: 3) transitions the arm to `quarantined` regardless of classification.
- A node accumulating `octo.quarantine.nodeFailureWindow` failures in a window (default: 10 failures / 10 minutes) is marked `degraded` and the scheduler penalty kicks in until the window clears.

## Cost Accounting

OpenClaw structured runtimes (subagent, ACP) already emit token and cost metadata via adapter events. The octo cost model captures this per-arm and per-mission.

### CostRecord

Written into the event log as part of `arm.output` events carrying cost metadata, and aggregated into per-arm and per-mission materialized views.

Fields:

- `arm_id`
- `mission_id`
- `provider` (anthropic, openai, etc.)
- `model`
- `input_tokens`, `output_tokens`, `cache_hit_tokens`
- `cost_usd` (if adapter provides it; else derived from model rate table)
- `ts`

### Mission budget

MissionRecord may carry a budget object:

```
{
  "budget": {
    "cost_usd_limit": 5.00,
    "token_limit": 2000000,
    "on_exceed": "pause" | "abort" | "warn_only"
  }
}
```

Behavior:

- Budget is checked on every `arm.output` event carrying cost metadata.
- `pause` transitions the mission to `paused` and stops assigning new grips; existing arms complete their current grip.
- `abort` transitions to `aborted` and terminates live arms.
- `warn_only` emits a `mission.budget_warning` event (defined in an addendum) without changing state.

PTY/tmux arms do not emit cost metadata; budget enforcement for PTY arms uses `expected_runtime_s * hourly_rate_proxy` if configured, otherwise they are not budget-gated.

## Backpressure and Output Volume

High-volume arms (chatty PTY runtimes, verbose compile output) can outpace event log ingestion. The system uses bounded buffers at every boundary and explicit backpressure rather than unbounded memory growth.

### Per-arm output buffer

Each arm has an in-memory ring buffer at the Node Agent, sized by `octo.arm.outputBufferBytes` (default: 2 MiB).

When the buffer fills:

1. The Node Agent emits an `octo.arm.output` event flagged `truncated: true` summarizing what was dropped.
2. Full output is written to a local rolling file `~/.openclaw/octo/node-<nodeId>/arms/<arm_id>/stdout.log` that rotates at 64 MiB per file, keeping the last 4 segments.
3. Operators attaching via `octo arm attach` read from the live tail of the rolling file plus the in-memory buffer.

### Event log ingestion limits

The Head drops `arm.output` events that arrive faster than `octo.events.ingestRateLimit` events/sec per arm (default: 200). Dropped events are counted in a rate-limited `anomaly` event (one per minute per arm), not silently discarded.

### Structured runtime flow control

Subagent and ACP adapters respect the existing OpenClaw event flow. There is no new backpressure needed for these paths — the existing runtimes already bound their own output emission.

## Forward-Progress Heartbeat

Lease renewal proves a node and arm are **alive**. It does not prove the arm is **making progress**. Wedged arms (infinite loops, deadlocks, blocked on a read) are a common failure mode and need a distinct signal.

### Progress signal

Each adapter emits a `progress_tick` on its output stream:

- `structured_subagent` — any assistant output or tool result
- `structured_acp` — any ACP `agent_message` or `tool_use`
- `pty_tmux` — any non-empty stdout/stderr chunk after normalization

### ProgressWatchdog

The Head runs a per-arm watchdog:

- Last progress tick timestamp per arm
- If `now - last_progress_tick > octo.progress.stallThresholdS` (default: 300s) the arm transitions to `blocked` with reason `stall_suspected`
- Operator can confirm or clear: `openclaw octo arm unblock <arm_id> --reason resumed` or `openclaw octo arm terminate <arm_id>`
- Policy can auto-terminate stalled arms after `octo.progress.autoTerminateAfterS` (default: null = never)

Lease renewal continues independently. An arm can be `alive` and `blocked` simultaneously — this is the expected state for a wedged arm waiting for operator attention.

## Mission Graph Schema

A mission is a DAG of grips.

### MissionGraphNode

```
{
  "grip_id": "...",
  "depends_on": ["grip_id_1", "grip_id_2"],
  "fan_out_group": "batch-a",      // optional; siblings in the same group can run in parallel
  "blocks_mission_on_failure": true // if false, failure is recorded but mission continues
}
```

### Graph rules

1. Grips with unresolved dependencies remain `queued` but are invisible to the scheduler until dependencies complete.
2. A `grip.completed` or `grip.failed` event triggers a re-evaluation of dependent grips.
3. If `blocks_mission_on_failure: true` and the grip fails after exhausting retries, the mission transitions to `aborted`.
4. Cycles are rejected at mission creation time with `invalid_spec`.
5. Fan-out groups exist only for operator visualization and do not affect scheduling.

### Minimal MVP graph

Milestone 3 (where graphs first land) supports only:

- linear chains (A → B → C)
- simple fan-out (A → [B, C, D])
- simple fan-in ([A, B] → C)

Diamond dependencies and conditional branches are Phase 6 considerations.

## Research-Driven Execution Pipeline

Per OCTO-DEC-039 and HLD §Execution Modes and Research-Driven Dispatch, missions carry an explicit `execution_mode` that determines the shape of the mission graph. This section defines the concrete schema addition, the canonical grip type vocabulary, and the pre-templated graph shapes each mode produces.

### MissionExecutionModeSchema

```
export const MissionExecutionModeSchema = Type.Union([
  Type.Literal("direct_execute"),
  Type.Literal("research_then_plan"),
  Type.Literal("research_then_design_then_execute"),
  Type.Literal("compare_implementations"),
  Type.Literal("validate_prior_art_then_execute"),
]);
export type MissionExecutionMode = Static<typeof MissionExecutionModeSchema>;
```

`MissionSpec.execution_mode` is optional. When absent, the implicit default is `direct_execute`. This preserves backward compatibility with existing mission creation flows that do not classify.

### Conventional grip type vocabulary

`GripSpec.type` remains a free-form NonEmptyString. The following values are **conventional** — operators and agents can use arbitrary values, but these six have documented semantics and scheduler hints:

| Type             | Purpose                                                    | Typical `desired_capabilities`                                         |
| ---------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `research`       | repo scan, external scan, doc lookup, benchmark collection | `runtime.subagent`, `net.internet`, `tool.gh`, `tool.web-fetch`        |
| `synthesis`      | compress research outputs into a decision memo / brief     | `runtime.subagent`                                                     |
| `design`         | produce architectural artifacts (PRD, HLD, LLD snippets)   | `runtime.subagent`                                                     |
| `implementation` | actual code edits, config changes, artifact production     | `runtime.cli_exec`, `tool.git`, `fs.shared_workspace`                  |
| `validation`     | test runs, benchmark execution, acceptance checks          | `runtime.cli_exec` or `runtime.pty_tmux`, `tool.node` / `tool.python3` |
| `comparison`     | side-by-side evaluation of alternatives                    | `runtime.subagent`, `net.internet`                                     |

These are guidance, not enforcement. The scheduler does not validate that a grip's `type` matches its `desired_capabilities` — operators can mix and match as needed. The vocabulary exists so that:

1. Operators can filter: `openclaw octo grip list --type research`
2. Classifiers have canonical values to populate when building research-first graphs
3. Future scheduler refinements can add soft type-aware routing without rewriting capability matching

### Pre-templated graph shapes per execution mode

When an agent-side classifier picks a non-`direct_execute` mode, it pre-populates `MissionSpec.graph` with a canonical set of grips. These are the **reference shapes** — classifiers may extend them with additional grips but should preserve the ordering:

**`direct_execute`** (default):

```
[implementation-1, implementation-2, ...]
```

No research stage. The classifier chose this because local context is sufficient.

**`research_then_plan`**:

```
research-repo → research-external → synthesis
```

Ends at synthesis. The mission pauses for operator review of the synthesis memo; implementation grips are added after approval in a follow-up mission or by marking the original mission as `active` again after the operator reviews.

**`research_then_design_then_execute`**:

```
research-repo → research-external → synthesis → design → [implementation-1, implementation-2, ...]
```

The full pipeline. Research → synthesis → design → implementation fan-out. This is the shape for architecture and major feature work.

**`compare_implementations`**:

```
research-repo → research-external → comparison → synthesis → (optional) implementation
```

Explicitly includes a `comparison` grip that produces a decision memo ranking alternatives. If the operator approves one alternative, implementation grips follow.

**`validate_prior_art_then_execute`**:

```
research-repo → validation → (if validated) implementation → (if not) research-external
```

Starts with a quick check that the likely solution exists and fits. If validation passes, jumps straight to implementation. If not, falls back to external research. This branching is expressed via `blocks_mission_on_failure: false` on the validation grip and careful `depends_on` wiring.

### Graph construction is classifier-side, not Head-side

The mission graph is constructed by the classifier (agent-side in the MVP) and submitted as part of the MissionSpec. The Head stores and validates the graph via the existing `validateMissionSpec` cross-check (cycle detection, duplicate id detection, unknown dep detection). The Head does NOT generate grips from the `execution_mode` — it enforces what the classifier has already produced.

This keeps the Head thin and avoids embedding classification or templating logic in the control plane. Classifiers are free to use the reference shapes above, extend them, or ignore them entirely as long as the resulting graph passes validation.

### Research outputs as artifacts

Research and synthesis grips produce ArtifactRecord entries via the existing artifact index (see §Core Domain Objects §ArtifactRecord). The artifact type vocabulary is extended with:

- `research-memo` — output of a research grip
- `synthesis-memo` — output of a synthesis grip
- `comparison-memo` — output of a comparison grip
- `validation-report` — output of a validation grip

These join the existing artifact types (`summary`, `log`, `patch`, `checkpoint`, `report`, `stdout-slice`, `stderr-slice`) without structural change.

Downstream grips consume research artifacts via `GripSpec.input_ref` pointing at the artifact id. The existing `input_ref` field is already a NonEmptyString "reference to input payload — file path, artifact id, inline blob id"; no schema change needed. The Head resolves the artifact at grip dispatch time and passes its content (or a path to it) into the adapter's `initial_input`.

### Scheduler routing by grip type

The scheduler routes by `desired_capabilities[]` match, NOT by `type`. This is a deliberate decision (OCTO-DEC-039): capability-based routing is type-agnostic and future-proof, while type-based routing would hard-code assumptions about which grip types need which runtimes.

A research grip that wants external web access declares `desired_capabilities: ["runtime.subagent", "net.internet"]`. A research grip that only needs to read the local repo declares `desired_capabilities: ["runtime.subagent", "fs.shared_workspace"]`. Both are valid research grips with different routing.

M4's distributed scheduler may add a soft type-aware preference to the scoring function — e.g., prefer placing research grips on habitats with `net.internet` even if multiple habitats could host them. This is a scoring-function refinement, not a new mechanism.

### Classifier location and hints

Per OCTO-DEC-039, the classifier lives agent-side in the MVP. `CONFIG.md octo.classifier` provides hints the agent can use:

```json5
{
  octo: {
    classifier: {
      defaultMode: "direct_execute",
      researchFirstTaskClasses: [
        "architecture",
        "optimization",
        "protocol_integration",
        "unfamiliar_domain",
        "build_vs_buy",
        "prior_art_sensitive",
      ],
      hints: {
        // Heuristic prompts the classifier can consider
        // — these are operator-tunable without code changes
      },
    },
  },
}
```

The hints are read by the classifier (which runs inside the agent's context), not by the Head. The Head only stores and validates the chosen `execution_mode`.

## Adapter Longevity and Arm Lifetimes

Subagent runs are one-shot by default (`mode: "run"`) and terminate after one task. ACP sessions can be persistent (`mode: "session"`). PTY arms persist as long as tmux keeps the session alive. This creates a subtle question: **what does "arm" mean for a one-shot subagent?**

### Rule

An arm's lifetime is **independent** of any single runtime session. An arm is a supervised execution object; runtime sessions are the backing resources it uses to do work.

Concretely:

- For `structured_subagent` arms: each grip creates a new subagent run. The arm persists across grips as a long-lived supervised object, holding context like `mission_id`, `policy_profile`, and cumulative `restart_count`. The `session_ref` changes per grip.
- For `structured_acp` arms in `mode: session`: the arm and the ACP session have parallel lifetimes. `session_ref` is stable across grips until operator `/acp close`.
- For `structured_acp` arms in `mode: run`: behaves like subagents above. One ACP session per grip.
- For `pty_tmux` arms: the tmux session is the runtime session. Arm and session lifetimes are coupled; terminating the arm terminates the tmux session.

### Idle arms

An arm with no `current_grip_id` is `idle`, not `completed`. Idle arms hold resources (tmux session, open fds, workspace lock) and remain eligible for new grips. The scheduler's stickiness preference operates on idle arms.

Idle arms past `octo.arm.idleTimeoutS` (default: 900s) transition to `completed` and release resources.

## Lease Algorithm

Lease model:

- head or scheduler grants an arm lease with TTL
- node agent renews lease periodically via `octo.lease.renew` push events
- if renewals are missed, the arm enters a suspect state
- after a grace window, recovery or reassignment starts

Recommended starting timings (tunable — validated in Milestone 1 chaos tests):

- renew every 10 seconds
- lease TTL 30 seconds
- grace window additional 30 seconds for `side_effecting: false` grips
- grace window additional 60 seconds for `side_effecting: true` grips (per PRD §Answered Design Questions #2)

These values are exposed in `openclaw.json` under `octo.lease` so operators can tune without a rebuild. Milestone 1 exit includes a chaos test that kills a node mid-arm and measures duplicate-execution rate under each grace window setting; values are revised if duplicate rate exceeds 5% of task volume (PRD success metric).

Claim ties:

- resource claims inherit or reference lease expiry
- stale claims can be auto-reaped once ambiguity is cleared

## Policy Enforcement Timeline

`policy_profile` on ArmRecord is a **forward-compatible field** that is populated from Milestone 1 onward but not actively enforced by a policy engine until **Milestone 5**. Until Milestone 5:

- arms inherit the effective OpenClaw per-agent ceiling (`tools.allow/deny`, `sandbox.*`) of their bound `agent_id` directly — this is the actual runtime enforcement
- `policy_profile` records the intended narrower profile for audit and forward planning
- the field is written through events so that when the PolicyService lands in Milestone 5 it can replay against historical arms and produce a compliance report

This avoids a chicken/egg problem where arms carry policy metadata the system cannot enforce. The OpenClaw ceiling is a real, existing control — no arm runs outside it.

## Recovery Flows

### 1. Head restart

Steps:

1. replay event log
2. rebuild registry cache
3. query nodes for live sessions
4. reconcile leases and arm/session bindings
5. restore scheduler state
6. reissue or recover grips

### 2. Node restart

Steps:

1. local agent boots
2. discover tmux sessions and tracked processes
3. restore local arm mapping from disk
4. resume heartbeats
5. emit reconciliation events
6. accept rebind instructions from head if needed

### 3. Arm crash

Steps:

1. process watcher detects exit
2. capture final logs and exit reason
3. inspect checkpoint and session durability
4. if resumable, restart in place
5. if not resumable, fail grip or requeue per policy
6. increment restart count
7. quarantine if restart threshold exceeded

### 4. Network partition

Rules:

- rely on lease grace period
- do not immediately duplicate work on first missed renewal
- if multiple live candidates appear after partition heal, quarantine ambiguous arms and require resolution logic

### 5. Ambiguous duplicate execution

If two arms may have executed the same grip:

- emit `grip.ambiguous` and quarantine both results until reconciliation
- do not auto-merge outputs

Resolution policy by grip type (to be finalized in Milestone 3 design, seed values below):

- **read-only grips** — deterministic selection by lowest `arm_id` lexicographic order; both transcripts are preserved as artifacts
- **`side_effecting: false` non-read-only** — operator-reviewed selection; Head surfaces both results in a diff view via `openclaw octo grip show --ambiguous`
- **`side_effecting: true`** — operator-only resolution; no automated selection path exists; an on-call alert is raised via the existing OpenClaw notification path

This section is a **seed**, not a final design. Milestone 3 includes a dedicated design task for the ambiguous resolution flow and must close this section before Milestone 4 begins.

## Checkpoint Model

Each arm should periodically emit checkpoint metadata.

Checkpoint metadata should include:

- current grip id
- cwd
- worktree path
- adapter type
- session references
- last observed output offset
- recent summary or progress digest
- active claims
- last health snapshot

Checkpoint storage:

- metadata in registry/artifact index
- full checkpoint blobs in filesystem or object store

## Observability

### Per-arm metrics

- runtime mode
- task latency
- restart count
- attach count
- lease renewal failures
- stdout/stderr volume
- last checkpoint age
- token and cost metadata if available

### System metrics

- active arms
- queued grips
- blocked grips
- quarantine count
- recovery attempts
- node capacity and saturation
- scheduler decisions per interval

### Logging strategy

- JSONL event stream for easy replay and debugging
- separate stdout/stderr capture for PTY runtimes
- structured event ingestion for structured runtimes
- log redaction hooks for secrets and policy-sensitive content

## Operator Surfaces

### CLI commands

All commands support a `--json` flag for machine-readable output (default is human-readable tabular). This matches existing `openclaw sessions --json` / `openclaw tasks list --runtime acp` conventions.

- `openclaw octo status [--json]`
- `openclaw octo mission list [--json]`
- `openclaw octo mission show <mission_id> [--json]`
- `openclaw octo arm list [--mission <id>] [--node <id>] [--state <state>] [--json]`
- `openclaw octo arm show <arm_id> [--json]`
- `openclaw octo arm attach <arm_id>`
- `openclaw octo arm restart <arm_id>`
- `openclaw octo arm terminate <arm_id> [--reason <text>]`
- `openclaw octo grip list [--json]`
- `openclaw octo grip reassign <grip_id> [--to <arm_id|node_id>]`
- `openclaw octo claims [--json]`
- `openclaw octo events --tail [--entity <id>] [--json]`
- `openclaw octo node list [--json]`
- `openclaw octo node reconcile <node_id>`

### Relationship to existing OpenClaw CLI

- `openclaw tasks list` continues to work and shows the underlying background task ledger; `openclaw octo arm list` shows the richer arm view with cross-references to the same records via `task_ref`.
- `openclaw sessions` continues to work for raw session inspection.
- `/subagents` and `/acp` slash commands continue to work for in-chat operator control; `/octo` slash commands are the Octopus equivalent for in-chat supervision.

### Agent tool surface

Arms and the orchestration state are exposed to OpenClaw agents as tools. This is what makes Octopus reachable from natural language instead of only from the out-of-band CLI. Tool schemas are thin wrappers over the existing `ArmSpec`, `GripSpec`, and `MissionSpec` TypeBox definitions — one source of truth.

Read-only tools (default allowlist):

- `octo_status`, `octo_mission_list`, `octo_mission_show`
- `octo_arm_list`, `octo_arm_show`
- `octo_grip_list`, `octo_events_tail`, `octo_claims_list`

Writer tools (opt-in; require per-agent `tools.allow` opt-in **and** the operator device token carrying the `octo.writer` capability):

- `octo_mission_create`, `octo_mission_pause`, `octo_mission_resume`, `octo_mission_abort`
- `octo_arm_spawn`, `octo_arm_send`, `octo_arm_terminate`
- `octo_grip_reassign`

All writer tools require an `idempotency_key` argument. All writer tool calls are logged to the octo event log with the calling agent id and sender identity. See INTEGRATION.md §Agent tool surface for schemas and the natural-language routing guide (Subagent vs ACP vs Octopus).

### In-chat slash commands (`/octo`)

Follows the existing `/subagents` and `/acp` patterns; see INTEGRATION.md §In-chat operator surface for the full command list. Writer commands require the operator's device identity to carry `octo.writer`. The `/octo attach <arm_id>` command reuses the existing thread-binding pattern from subagents, so follow-up messages in a thread route to the attached arm via `octo.arm.send`.

### Later UI surface

- live arm grid
- mission graph view
- node capacity/health map
- artifact and checkpoint browser
- intervention console

## Storage Choices

### MVP — SQLite

**Decision: SQLite** for the registry, claims, leases, and event metadata through Milestones 1–3.

Paths:

- `~/.openclaw/octo/registry.sqlite` — ArmRecord, GripRecord, MissionRecord, ClaimRecord, lease index, CAS version columns
- `~/.openclaw/octo/events.jsonl` — append-only event log (authoritative for replay)
- `~/.openclaw/octo/artifacts/` — artifact blobs (filesystem-backed)
- `~/.openclaw/octo/node-<nodeId>/pending.jsonl` — per-node unacked transition log
- Sessions continue to use the existing `~/.openclaw/agents/<agentId>/sessions/` layout

CAS semantics in SQLite are implemented via a monotonic `version` column + `UPDATE ... WHERE version = :expected` pattern, which is safe under SQLite's single-writer model because the control plane runs inside a single Gateway process in the MVP.

### Postgres migration trigger

Switch to Postgres when any of the following become true — this is the **named migration trigger**, not a vibes-based upgrade:

1. The control plane must run across more than one Head process (HA or geographically distributed heads), OR
2. Concurrent writer count across Head + Node Agents exceeds ~50 sustained, OR
3. Event log volume exceeds the retention or query latency budget set in Milestone 4 exit criteria

Milestone 5 is the earliest milestone where any of the above is plausible; the migration itself is scheduled as part of Milestone 5 planning if triggered.

### Artifact persistence at distributed stage

- filesystem-backed stays the default when habitats can reach a shared filesystem (NFS, SMB, cloud-mounted)
- fall back to object storage (S3-compatible) when no shared filesystem exists; retrieval is pull-on-demand via the Head rather than shadowed to every habitat

## Implementation Order

This ordering aligns with `implementation-plan.md` milestones and the PRD phase sequence (claims before distributed). OCTO-DEC-036/037 shifted the adapter priorities: `cli_exec` and `pty_tmux` are the primary adapters for external agentic coding tools, so they move ahead of ACP in the build order.

1. tmux-backed local arm supervisor (new work)
2. SQLite registry + JSONL event log at `~/.openclaw/octo/`
3. Operator CLI for status, attach, restart, resume, with `--json` everywhere
4. **PtyTmuxAdapter** — primary path for interactive TUI tools and universal fallback (new work, formerly split across Milestones 1 and 2)
5. **CliExecAdapter** — primary path for external coding tools with structured CLI output modes (new work — the simplest adapter shape)
6. **SubagentAdapter** — promote existing `sessions_spawn` runs into first-class arms (thin wrapper over existing code)
7. **AcpAdapter** — available-but-opt-in adapter wrapping existing `sessions_spawn({runtime: "acp"})` (thin wrapper; not the default path for external tools per OCTO-DEC-036)
8. Grip ownership, claim service, artifact index (new work; §5 of Recovery Flows closes here)
9. Node Agent as a Gateway `role: node` client speaking `octo.*` (new work, but reuses existing pairing/trust)
10. Lease, heartbeat, capability-aware scheduler (new work)
11. Policy engine layered on existing per-agent `tools.allow/deny` and sandbox
12. Advanced recovery and optional speculative execution

## Known Hard Parts

- robust parsing of PTY output across diverse CLI tools
- reconciling structured and terminal-mode state into one normalized model
- avoiding duplicate work during partition or recovery ambiguity
- keeping safety boundaries intact while allowing powerful supervision
- making telemetry useful without overwhelming the operator

## Exit Criteria for LLD Approval

The LLD is ready for review when:

- domain objects are accepted
- adapter interfaces are accepted
- lease, claim, and recovery models are accepted
- storage and event strategy are accepted
- implementation order is accepted as a valid path to MVP
