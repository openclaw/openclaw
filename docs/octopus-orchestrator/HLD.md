# OpenClaw Octopus Orchestrator HLD

## Status

Draft v0.2

## Revision Notes

- v0.3 (ultraplan pass): added concrete code layout / module boundaries (Milestone 0 deliverable), operator authorization model, mission graph concept, worktree coordination contract, and explicit pointers to new CONFIG.md / TEST-STRATEGY.md / OBSERVABILITY.md supporting artifacts.
- v0.2: added OpenClaw Integration Foundation section, Head↔Node-Agent wire contract stub (`octo.*` Gateway WS namespace), concrete capability-scoped security mechanism reusing pairing + per-agent sandbox, clarified the ACP position (ACP is one adapter, not forbidden — it just isn't the control plane), and made the "Head lives inside/alongside the Gateway" assumption explicit.

## Purpose

This document describes the high-level architecture for the OpenClaw Octopus Orchestrator, a terminal-first distributed orchestration system for supervising many concurrent agent arms across local and remote habitats.

It is derived from the approved PRD and intentionally assumes:

- terminal-native control as the primary abstraction
- structured CLI control when available
- PTY/tmux fallback when structured control is unavailable
- ACP is an allowed adapter but **never** the control plane or primary dependency

## Architectural Summary

The system is composed of five major layers:

- **Head Controller**
- **Scheduler and Assignment Engine**
- **Runtime Adapter Layer**
- **Node Agent / Habitat Layer**
- **Shared Control Plane**

These are surfaced to operators through CLI-first control, with optional live dashboards later.

## OpenClaw Integration Foundation

The Octopus Orchestrator is built **inside** OpenClaw and reuses existing infrastructure. This section pins the concrete mapping between Octopus components and OpenClaw primitives so we do not accidentally build parallel implementations.

### Runtime location of the Head

The Head Controller runs as a subsystem of the OpenClaw **Gateway** process, or as a trusted loopback client of it. It does not open its own listening socket. Operators and Node Agents reach the Head through the existing Gateway WebSocket on `127.0.0.1:18789` (or the configured bind host).

Rationale:

- The Gateway already owns device pairing, auth (`gateway.auth.*`), idempotency keys, and the `role: node` client surface. Introducing a second orchestration socket would fork the trust model.
- Existing clients (CLI, macOS app, web admin) already know how to speak to the Gateway. Exposing `octo.*` methods over the same wire gets us operator UIs, remote access (Tailscale/SSH tunnel), and auth for free.

### Node Agent wire contract — `octo.*` namespace

Node Agents are Gateway clients that declare `role: node` and advertise an `octo` capability in their `connect` frame alongside their existing `caps/commands/permissions`. No new transport is introduced. The Head calls into them with request/response methods and subscribes to push events, both framed as ordinary Gateway messages.

**Request methods (Head → Node Agent):**

- `octo.arm.spawn` — launch a new arm under a given spec, return a `SessionRef`
- `octo.arm.attach` — open an operator attach stream to a live arm
- `octo.arm.send` — deliver input to a structured or PTY arm
- `octo.arm.checkpoint` — request a checkpoint flush
- `octo.arm.terminate` — terminate an arm with a reason
- `octo.arm.health` — return current health snapshot
- `octo.node.capabilities` — return the habitat's capability manifest
- `octo.node.reconcile` — force a session reconciliation pass

**Push events (Node Agent → Head):**

- `octo.arm.state` — state machine transitions
- `octo.arm.output` — normalized output events (stdout/stderr slices, structured events)
- `octo.arm.checkpoint` — checkpoint metadata
- `octo.lease.renew` — lease heartbeat
- `octo.node.telemetry` — periodic health and load
- `octo.anomaly` — reconciliation anomalies

**Framing and rules:**

- All side-effecting methods (`spawn`, `send`, `terminate`, `checkpoint`) require an **idempotency key**, reusing the existing Gateway idempotency cache behavior.
- Push events are **not durable** at the transport layer — per existing Gateway invariants, events are not replayed to clients on gap. Durability lives in the control plane event log, not the wire. Node Agents must persist unacked state transitions locally until the Head has acknowledged receipt.
- Requests are authenticated by the existing device token issued during pairing. No new credentials.
- Node Agents bound to a specific OpenClaw agent id inherit that agent's `tools.allow/deny` and `sandbox` policy as their **floor**; per-arm policy can only narrow, never widen.

A full protocol specification is out of scope for the HLD and will be produced as a TypeBox schema addition in Phase 1, following the existing OpenClaw pattern (TypeBox → JSON Schema → Swift models).

### Feature advertisement via `hello-ok.features.octo`

Gateway clients discover Octopus support through the existing `hello-ok.features` mechanism. When Octopus is enabled, the Gateway handshake returns a structured `features.octo` block alongside `features.methods` and `features.events`:

```json
{
  "features": {
    "octo": {
      "version": "1",
      "enabled": true,
      "adapters": ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
      "capabilities": {
        "missionBudgets": true,
        "worktreeClaims": true,
        "forwardProgressWatchdog": true
      }
    }
  }
}
```

Clients must feature-detect — checking `features.octo?.enabled === true` before rendering any Octopus UI. Old clients see nothing and render unchanged; new clients talking to old Gateways see the block absent and hide their Octopus UI. This is the durable contract: no hard version pinning, no runtime errors, just capability negotiation. See INTEGRATION.md §Client feature detection for the full schema.

### Adapter layer — four adapter types, preference-ordered per OCTO-DEC-036

The adapter layer normalizes four different ways of invoking work. For **external agentic coding tools** (Claude Code, Codex, Gemini, Cursor, Copilot, etc.), the preference order is `cli_exec` → `pty_tmux`. For OpenClaw's own native runtime work, `structured_subagent` is primary. `structured_acp` is demoted to opt-in only.

| Adapter               | OpenClaw-side implementation                                        | What it wraps                                                                                                                            | Primary use                                                                                                                   | Preference                                                                      |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `structured_subagent` | Existing `sessions_spawn`, `/subagents`                             | OpenClaw's own native agent loop against its configured model provider                                                                   | OpenClaw-owned model work under OpenClaw's own API terms                                                                      | Primary for native work                                                         |
| `cli_exec`            | **Net-new thin adapter**                                            | `spawn()` on a CLI tool invoked with its own structured output mode (`claude -p --output-format stream-json`, `codex exec --json`, etc.) | External agentic coding tools that offer a structured CLI mode — driven the way a user would drive them                       | **Primary for external tools**                                                  |
| `pty_tmux`            | **Net-new runtime**                                                 | tmux session + PTY driving an interactive TUI tool                                                                                       | External agentic coding tools with interactive TUIs only; universal fallback for any terminal-shaped tool                     | **Primary for external tools without structured CLI modes; universal fallback** |
| `structured_acp`      | Existing `acpx` runtime, `sessions_spawn({runtime: "acp"})`, `/acp` | ACP harness sessions                                                                                                                     | Explicit user opt-in when ACP semantics are specifically desired (e.g. conversation-bound ACP sessions on messaging channels) | **Opt-in only — never the default for any external tool**                       |

**Why external coding tools are driven via `cli_exec` / `pty_tmux`, not ACP:** the genesis of this project was explicitly to not depend on ACP as the center of gravity. External agentic coding tools are shipped and licensed as developer CLIs, and driving them through their own CLI (or their interactive TUI via PTY/tmux) is functionally equivalent to a human user at the keyboard — which is the intended use model of each tool. ACP wraps the tool programmatically, bypassing the user-facing surface, and sits in a less well-defined policy space. PTY/tmux and `cli_exec` are the durable, policy-safe, tool-agnostic paths. See OCTO-DEC-036 and INTEGRATION.md §Principle of user-equivalent operation.

The background task ledger (`openclaw tasks list`) remains the activity record for existing runtimes (`structured_subagent`, `structured_acp`, and the pre-existing cron/CLI task types). `cli_exec` and `pty_tmux` arms do not go through `sessions_spawn` and therefore do not create task ledger entries automatically — Octopus maintains its own ArmRecord and event log for them. A future unification may add mirrored task-ledger entries but is not required.

### State and storage layout

Octopus state lives alongside existing OpenClaw state directories:

- `~/.openclaw/octo/registry.sqlite` — ArmRecord, GripRecord, ClaimRecord, MissionRecord, lease index
- `~/.openclaw/octo/events.jsonl` — append-only event log
- `~/.openclaw/octo/artifacts/` — artifact blobs
- Sessions continue to live under the existing path: `~/.openclaw/agents/<agentId>/sessions/`
- `openclaw.json` gains an `octo:` config block for scheduler, lease timings, policy profiles, and habitat overrides

This respects the existing OpenClaw state layout, `OPENCLAW_STATE_DIR` override, and workspace scoping.

### Security model — capability-scoped Node Agents, concretely

The abstract "capability-scoped node agents" principle maps onto these **existing** OpenClaw controls, stacked:

1. **Device pairing + token.** Node Agent must complete the existing pairing handshake; operator must approve non-loopback pairings. Tailnet/LAN binds are not auto-approved.
2. **Agent id scoping.** Each Node Agent is bound to exactly one OpenClaw agent id. That agent's `tools.allow/deny`, `sandbox.mode`, and `sandbox.scope` form the **ceiling** for every arm the node can host.
3. **Per-arm policy profile.** A narrower `policy_profile` on ArmRecord further restricts tools, paths, and network zones below the agent ceiling.
4. **Operator approvals.** Destructive or elevated control-plane operations are gated by the `octo.writer` device-token capability (see INTEGRATION.md §Operator authorization model). Note: OpenClaw's existing `tools.elevated` is specifically about sandbox breakout for `exec`, not general control-plane authorization — earlier drafts of this doc incorrectly routed operator approvals through `tools.elevated` and have been corrected.
5. **Sandbox scope.** Arms inherit `sandbox.scope: "agent"` (one container per agent id) by default; per-arm override to `agent` or `shared` is allowed within the agent ceiling.
6. **Audit.** All policy decisions, approvals, interventions, and overrides are written to the event log with actor attribution.

The design rule from the PRD — "the system must never hide destructive actions inside orchestration abstractions" — is operationalized here: there is no orchestration-only code path that can call `exec` on an arm whose agent id does not allow `exec`.

### Code layout and module boundaries

Octopus lives inside the existing OpenClaw codebase as a set of modules, not a separate repository.

Proposed structure (subject to Milestone 0 Gateway team review):

```
<openclaw repo>/
  src/
    octo/
      head/                # Head Controller: mission graph, supervisor
        scheduler.ts       # SchedulerService + scoring + fairness
        registry.ts        # RegistryService (SQLite CAS)
        event-log.ts       # EventLogService (JSONL + replay)
        leases.ts          # LeaseService
        claims.ts          # ClaimService
        artifacts.ts       # ArtifactService
        policy.ts          # PolicyService (stub through M4, active M5)
        progress.ts        # ProgressWatchdog
      adapters/
        base.ts            # Adapter contract (TypeBox)
        subagent.ts        # SubagentAdapter — wraps sessions_spawn (native)
        cli-exec.ts        # CliExecAdapter — primary for external coding tools with structured CLI modes (OCTO-DEC-037)
        pty-tmux.ts        # PtyTmuxAdapter — primary for interactive TUI tools + universal fallback
        acp.ts             # AcpAdapter — wraps sessions_spawn({runtime:"acp"}); opt-in only per OCTO-DEC-036
      node-agent/          # Node Agent: runs per habitat
        launcher.ts
        tmux-manager.ts
        process-watcher.ts
        lease-heartbeat.ts
        telemetry.ts
        policy-enforcer.ts
        session-reconciler.ts
      wire/
        primitives.ts      # Shared TypeBox primitives (NonEmptyString, etc.)
        schema.ts          # ArmSpec/GripSpec/MissionSpec TypeBox schemas + validateArmSpec
        methods.ts         # TypeBox schemas for octo.* request/response methods
        events.ts          # TypeBox schemas for octo.* push events + event envelope
        features.ts        # FeaturesOctoSchema + buildFeaturesOcto advertiser
        gateway-handlers.ts # Gateway WS request/event handlers (M1-14 onwards)
      cli/
        octo-status.ts
        octo-arm.ts
        octo-mission.ts
        octo-grip.ts
        octo-claims.ts
        octo-events.ts
        octo-node.ts
      config/
        octo-config.ts     # openclaw.json `octo:` block loader + validator
      test/
        unit/
        integration/
        chaos/             # see TEST-STRATEGY.md
```

Head and Node Agent share the `octo/wire/` and `octo/config/` modules; everything else is side-specific. Gateway handlers dispatch `octo.*` requests into Head services when the Octopus feature flag is enabled.

**Feature flag:** a top-level `octo.enabled` switch in `openclaw.json` gates the entire subsystem. Default `false` through Milestone 1; default `true` once Milestone 2 exit criteria are met. This protects existing OpenClaw users from subsystem regressions during early builds.

### Operator authorization

The existing Gateway auth model is effectively binary: once a client is paired and has a device token, it can call any method on the Gateway. Octopus introduces control-plane commands that are more consequential than "send a WhatsApp message," so it needs a richer authorization model.

**Starting model (Milestones 1–3):**

- Any paired operator with a valid device token can call read-only `octo.*` methods (`status`, `arm list`, `mission show`, `events --tail`, `claims`, `node list`).
- Side-effecting methods (`spawn`, `send`, `terminate`, `restart`, `grip reassign`) require the operator device token to carry an `octo.writer` capability flag, set during pairing.
- Loopback-originated calls (the CLI running on the same host as the Gateway) auto-grant `octo.writer` — this preserves the existing same-host UX where the local CLI Just Works.
- All side-effecting operator actions are written to the event log with actor = operator device id + human label.

**Future (Milestone 5+):**

- Per-mission ownership: only the mission owner or explicit delegates can terminate arms or reassign grips within that mission.
- Approval routing: destructive actions on shared missions require a multi-operator approval via a new `octo.approval.*` flow (built on the same event-log + device-token foundation, not on `tools.elevated`).
- Audit view: `openclaw octo audit --since <time>` surfaces the actor history for any entity.

**What we explicitly are not building:**

- Full RBAC with roles/groups/permissions matrices — overkill for the expected operator population.
- Password auth or username/password login — existing device pairing is the identity model.

### Mission graph concept

A mission is a directed acyclic graph (DAG) of grips. The Head Controller owns the graph and is the only thing that decides when a grip becomes schedulable.

Graph edges come from:

- explicit `depends_on` declarations on grip creation
- implicit ordering from the API that created the mission (e.g. a cron-triggered mission emits grips in sequence)
- artifact dependencies (grip B needs artifact produced by grip A)
- **research-first classifier output** — when a mission is classified as research-first, the classifier pre-populates the graph with research, synthesis, and design grips before any implementation grips; the resulting `depends_on` chain enforces the ordering naturally

The MVP supports linear chains, simple fan-out, and simple fan-in. Diamonds and conditional branches are a Phase 6 concern. See LLD §Mission Graph Schema for the concrete shape.

### Execution Modes and Research-Driven Dispatch

Per PRD Principle #9 and OCTO-DEC-039, Octopus treats research and synthesis as first-class stages of execution for high-leverage tasks. Missions carry an `execution_mode` field selecting one of five modes:

| Mode                                | Use when                                                  | Shape of the mission graph                     |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `direct_execute`                    | narrow, local, clearly specified tasks (the default)      | implementation grips only                      |
| `research_then_plan`                | outside context matters, implementation not yet approved  | research → synthesis; stop for operator review |
| `research_then_design_then_execute` | architecture, systems, major feature work                 | research → synthesis → design → implementation |
| `compare_implementations`           | inspect existing solutions before choosing a path         | research → comparison → decision               |
| `validate_prior_art_then_execute`   | a likely solution exists; confirm fit before implementing | research → validation → execute                |

**Classifier location:** agent-side in the MVP. The agent that creates a mission runs the classifier in its own context — it has the request, project context, and LLM judgment to decide the mode. The agent populates `MissionSpec.execution_mode` and the mission graph before calling `octo.mission.create`. Octopus Head stores and enforces; it does not classify.

**How the modes shape the mission graph:** when the classifier picks a non-`direct_execute` mode, it pre-populates the graph with grips of appropriate types. For `research_then_design_then_execute`, a typical graph is:

```
research (repo scan)
    ↓
research (external landscape)
    ↓
synthesis (decision memo)
    ↓
design (architecture artifacts)
    ↓
implementation (actual work)
```

All of this is expressed through the existing `MissionGraphNode.depends_on` field — no new graph construction logic in the Head. The topological sort + cycle detection machinery from M0-03 handles ordering unchanged.

**Grip type vocabulary:** `research`, `synthesis`, `design`, `implementation`, `validation`, `comparison`. These are documented conventional values of `GripSpec.type`, not an enforced enum. Operators and agents can use arbitrary `type` values; the conventional set is the shared vocabulary for common grip shapes and allows operator filtering like `openclaw octo grip list --type research`.

**Scheduler routing:** the existing `desired_capabilities[]` field is the primary routing mechanism. A research grip can request `runtime.subagent + net.internet + tool.gh`; an implementation grip can request `runtime.cli_exec + tool.git`. The scheduler routes by capability match. `type` is the human-readable label, NOT the primary routing key — though M4's scheduler may add a soft type-aware preference as a scoring-function refinement.

**Research outputs as first-class artifacts:** research grips produce ArtifactRecord entries in the existing artifact index. Downstream grips consume them via `GripSpec.input_ref` pointing at the research artifact id. No new artifact shape is needed.

**Why this is policy-driven, not optional:** when an agent classifies a mission as research-first, the mission spec literally requires research grips to complete before implementation grips can start. The existing `depends_on` mechanism enforces the ordering. An implementation grip cannot be scheduled until its research predecessors are `completed`. This is the mechanism that turns "research first" from guidance into enforcement.

**What about Dark Factory?** The research document mentions Dark Factory as a pre-dispatch manufacturing system that classifies, gathers context, and dispatches into Octopus. Dark Factory is out of scope for Octopus M0–M5. Octopus accepts classified missions from any source (agent, Dark Factory, operator, cron); it does not care who classified them.

### Worktree coordination

The landscape review specifically highlighted ai-fleet's branch/worktree isolation as a strong pattern. Octopus adopts it as a first-class concern because coding arms are the most common use case.

**Rules:**

1. Each arm with `worktree_path` set gets an **exclusive claim** on that path via the ClaimService. Only one arm can hold a given worktree at a time.
2. The claim is recorded as `resource_type: "dir"` with the worktree path as the key and `mode: "exclusive"`.
3. Missions that need parallel work on the same repo create sibling worktrees (`git worktree add <path> <branch>`) and each child arm claims its own path.
4. Worktree lifecycle is Octopus's responsibility: the SessionReconciler on the Node Agent prunes worktrees whose arm has been `archived` and whose branch has been merged or abandoned.
5. Branch-level conflicts are handled one level up: claims can also be taken on `resource_type: "branch"` with the branch name as the key, preventing two arms from targeting the same feature branch across different worktrees.

This is **not** a git integration — Octopus does not run git commands itself. It is a coordination layer that prevents collisions on paths and branches that arms do manipulate via their own runtime (structured tool calls, shell commands, etc.).

## System Goals

The architecture must support:

- persistent arm/session identity
- multi-node execution
- structured and PTY runtime normalization
- event-sourced recovery and auditability
- file/resource ownership coordination
- operator intervention at any time
- safety boundaries that are not bypassed by orchestration

## Top-Level Architecture

```text
Operator CLI/UI
    |
    v
Head Controller
    |
    +---- Scheduler / Assignment Engine
    |
    +---- Policy & Safety Engine
    |
    +---- Observability Layer
    |
    v
Shared Control Plane
    |
    +---- Session Registry
    +---- Event Log
    +---- Lease Store
    +---- Claim Store
    +---- Artifact Index
    |
    v
Node Agents (per habitat)
    |
    +---- Structured Runtime Adapters
    +---- PTY/tmux Runtime Adapters
    +---- Process/Session Supervisors
```

## Major Components

### 1. Head Controller

The Head Controller is the orchestration brain.

Responsibilities:

- maintain mission graphs and active orchestration state
- decide which arm should hold which grip
- coordinate retries, escalation, failover, and reassignment
- synthesize summaries from arm outputs
- expose intervention surfaces to the operator

The head should be authoritative for assignment and supervision decisions, but not responsible for low-level terminal management on every node.

### 2. Scheduler and Assignment Engine

The Scheduler is responsible for work placement.

Responsibilities:

- assign grips to arms based on capability, locality, warm state, and load
- enforce concurrency limits and fairness policies
- prefer warm reusable arms when economical
- rebalance work on congestion, degradation, or failure

Scheduling principles:

- default to sticky assignment for resumability
- reassign only on explicit failure, timeout, lease expiry, or operator action
- prefer habitat locality when a worktree, cache, or artifacts already exist there
- avoid speculative duplication unless explicitly enabled or needed for recovery

### 3. Runtime Adapter Layer

The Runtime Adapter Layer normalizes different execution modes without pretending they are identical.

Two first-class adapter families:

#### Structured Mode Adapters

Used when a runtime offers:

- machine-readable events
- resumable session ids
- structured streaming output
- explicit control semantics

Examples:

- Claude Code structured print/stream-json mode
- future CLI runtimes with resumable session models

Benefits:

- reliable parsing
- lower ambiguity
- easier checkpointing and resume
- tighter observability

#### Terminal Mode Adapters

Used when a runtime is interactive, unstructured, or shell-native.

Backed by:

- PTY sessions
- tmux for durability and reattachment
- stdout/stderr capture and event normalization

Benefits:

- works with real terminal-native tools
- preserves human takeover path
- avoids dependence on friendly structured protocols

Tradeoffs:

- more brittle parsing
- terminal UI variability
- more careful safety handling required

### 4. Node Agent / Habitat Layer

Each habitat runs a Node Agent.

A habitat may be:

- the local machine
- a remote macOS/Linux node
- a machine with agent runtimes or local models installed

Responsibilities:

- launch and supervise arms on that habitat
- manage local tmux sessions and processes
- publish heartbeats and telemetry
- persist minimal recovery state locally
- enforce node-local policy constraints
- reconcile registry state with real process/session state after restart

The node agent is the execution manager, not the planner.

### 5. Shared Control Plane

The control plane holds durable orchestration state.

Core stores:

- **Session Registry**: current arm identity and status
- **Event Log**: append-only state transitions and operator interventions
- **Lease Store**: liveness and ownership tracking
- **Claim Store**: ownership for files, dirs, branches, ports, task keys
- **Artifact Index**: outputs, checkpoints, summaries, patches, logs

This layer is what makes the system resumable, inspectable, and recoverable.

## Supporting Components

### Policy and Safety Engine

Responsibilities:

- define allowed tools, paths, network zones, and escalation rules
- require approvals for risky actions
- block or quarantine unsafe arms
- annotate provenance for audits

Principle:

- orchestration must not silently become a privilege escalation channel

### Observability Layer

Responsibilities:

- collect lifecycle transitions, logs, structured events, token/cost data where available
- expose node health, queue depth, arm status, retries, failures, lease expiry events
- support diagnosis of stuck, ambiguous, or noisy arms

Outputs:

- CLI status views
- machine-readable event streams
- later dashboards for arm grids, mission graphs, and node health

## Arm Model

An arm is the durable unit of supervised execution.

Each arm has:

- immutable identity
- assigned habitat
- runtime mode and adapter type
- session handles, structured session id and/or tmux session name
- a current grip or idle status
- a lease
- health status
- artifacts and claims
- restart and intervention history

An arm is not just a process. It is a long-lived supervised execution object.

## Shared State Model

The architecture intentionally separates strongly coordinated state from eventually consistent state.

### Strong-ish consistency requirements

These require conflict-aware updates or compare-and-set semantics:

- arm state transitions
- leases
- file/resource claims
- grip ownership

### Eventual consistency is acceptable for

- summaries
- logs
- telemetry
- artifact annotations
- secondary dashboards

This reduces coordination chatter while keeping ownership and recovery safe.

## Recovery Model

Recovery is a first-class architectural requirement.

### Recoverable conditions

- head crash or restart
- node agent restart
- transient network partition
- arm process exit
- tmux session survives detached client exit
- structured runtime disconnect with resumable session id

### Recovery principles

- replay the event log
- reconcile live leases against observed reality
- rediscover live tmux sessions and structured sessions on nodes
- rebind orphaned sessions to known arms when confidence is high
- reissue grips when no recoverable session exists
- quarantine ambiguous arms when duplicate execution risk is too high

## Security and Safety Model

The architecture assumes agent execution is powerful enough to be dangerous.

Controls (see §OpenClaw Integration Foundation / "Security model — capability-scoped Node Agents, concretely" for the concrete mechanism):

- device pairing + token-scoped Node Agents
- agent-id ceiling policy inherited from OpenClaw per-agent `tools.allow/deny` and sandbox
- per-arm policy profiles that can only narrow the agent ceiling
- explicit approvals for destructive control-plane operations via the `octo.writer` device-token capability (see INTEGRATION.md — this is distinct from OpenClaw's `tools.elevated`, which is about sandbox breakout for exec, not control-plane auth)
- secret redaction in logs and artifacts where possible
- immutable audit trail for approval, intervention, termination, and reassignment events

Design rule:

- the system must never hide destructive actions inside orchestration abstractions

## tmux as a Foundational Substrate

This architecture treats tmux as foundational for terminal durability, not incidental convenience.

Why tmux matters:

- durable detached sessions
- reliable reattach path for humans
- practical fallback when structured control is unavailable
- process/session persistence across operator disconnects
- better introspection and takeover than raw PTY alone

tmux is not the control plane, but it is a critical substrate for terminal-mode durability.

## Multi-Node Design

The architecture supports distributed habitats from the beginning, even if the MVP is local-first.

Node model:

- each node advertises capabilities
- the head uses capability, locality, and load to route work
- leases and heartbeats are used for liveness
- artifacts and claims are synchronized through the control plane

Distributed design principle:

- execution is decentralized, supervision is coordinated

## Key Architectural Decisions

- terminal-first control is the default assumption
- structured runtime integrations are preferred but optional
- tmux-backed PTY fallback remains first-class
- event sourcing is used for recovery and auditability
- leases are preferred over hard locks for liveness and ownership
- shared state is explicit, not inferred from transcript history
- humans must be able to take over any arm at any time

## MVP Architecture

For the initial build:

- one head
- one habitat
- tmux-backed arms
- local registry and event log
- basic arm lifecycle commands
- operator attach/restart/resume flows
- one structured adapter after the local substrate is stable

This lets the system prove:

- durable arms
- reattachability
- normalized state transitions
- recovery after local restart

before adding distributed scheduling.

## Future Extensions

The architecture is intentionally extensible to later support:

- warm arm pools
- speculative execution and shadow dispatch
- adaptive routing based on historical reliability
- richer operator dashboards
- artifact lineage and deeper claim semantics
- mixed structured/PTTY hybrid session steering

## Exit Criteria for HLD Approval

The HLD is ready for review when:

- major components and boundaries are accepted
- the session/arm model is accepted
- recovery and safety principles are accepted
- the tmux-backed terminal substrate decision is accepted
- the local-first then distributed rollout path is accepted
