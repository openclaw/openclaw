# OpenClaw Octopus Orchestrator PRD

## Status

Draft v0.2

## Revision Notes

- v0.2: reconciled phase numbering with recommendation/implementation plan (claims now precede distributed), closed open questions into DECISIONS.md, retired "Memory Ink" in favor of ArtifactRecord, added OpenClaw Integration Foundation section, clarified ACP position, added explicit note that the orchestrator composes on existing OpenClaw primitives (Gateway WS, background tasks, ACP runtime, native subagents, pairing) rather than replacing them.

## Product Name

OpenClaw Octopus Orchestrator

## Vision

OpenClaw Octopus Orchestrator is a terminal-first distributed orchestration layer for managing many concurrent agent "arms" across local and remote environments. One head plans and supervises, many arms execute semi-independently.

The system is designed to be:

- native to terminals, not dependent on ACP or any single vendor protocol
- resumable, inspectable, and recoverable
- structured when possible, with PTY/tmux fallback when necessary
- safe, operator-visible, and auditable

## Problem Statement

Current multi-agent orchestration patterns are fragmented.

Existing systems tend to fall into one of several incomplete categories:

- structured API orchestration that assumes friendly machine-readable runtimes
- shell/tmux glue that works but is operationally brittle
- distributed runners that optimize dispatch but not supervision or recovery
- PTY-heavy systems with weak shared state and poor auditability
- chat-centric coordination layers that do not map cleanly to OS-level execution

OpenClaw needs a unified orchestration model that:

- works with terminal-native agents first
- survives disconnects, process crashes, daemon restarts, and node restarts
- supports both structured and unstructured runtimes
- provides shared state and safe coordination across many active sessions
- allows human intervention at any time

## Why This Matters

This project addresses downstream development issues across the stack:

- parallel coding and research execution
- supervision of many concurrent sessions without chaos
- recoverability when long-running agents stall or die
- provider flexibility instead of protocol lock-in
- better planning, state management, and auditability for serious work

If OpenClaw gets this right, it becomes a real operating substrate for coordinated agent work, not just a chat layer plus tools.

## Target Users

### Primary

- power users orchestrating multiple coding, research, and ops agents
- operators supervising work across laptops, desktops, and remote nodes
- developers building higher-level automations on OpenClaw

### Secondary

- teams that need auditable, recoverable multi-session execution
- advanced technical users who want distributed orchestration without ACP dependence

## Primary Use Cases

- spawn 5 to 50 concurrent agent arms for coding, research, testing, refactoring, or operations
- mix runtimes including structured CLI agents, plain shell tools, and PTY-only interactive tools
- resume orchestration after client disconnect, daemon restart, or node restart
- rebalance work across nodes
- attach and detach from active interactive sessions without losing state
- enforce policies around filesystem, network, secrets, and destructive commands
- aggregate logs, costs, status, artifacts, and outcomes into one control plane
- allow a human operator to take over any arm at any time

## Non-Goals

- not a Kubernetes replacement
- not a generic distributed batch DAG scheduler
- not ACP-dependent by design
- not a fully autonomous system that removes human oversight
- not tmux-only, although tmux is a critical fallback substrate
- not a pure chatroom model where agent conversation substitutes for execution control

## Product Principles

### 1. Terminal-first

Every arm is ultimately controllable through terminal semantics.

### 2. Resumable by default

Sessions are durable objects, not disposable subprocesses.

### 3. Structured when possible

If a runtime offers machine-readable events, resumable session ids, or explicit control APIs, use them.

### 4. Fallback always available

PTY/tmux must remain a first-class fallback path when structured control is unavailable.

### 5. Operator-visible

All important decisions, state changes, and failures must be inspectable.

### 6. Policy before power

The system must not bypass approvals or safety boundaries in the name of orchestration.

### 7. Explicit shared state

Coordination state must be stored intentionally, not reconstructed from transient transcripts.

### 8. User-equivalent operation of external tools

External agentic coding tools (Claude Code, Codex, Gemini, Cursor, Copilot, and future equivalents) are driven the way a human user would drive them — through their published CLI interfaces, either in their native structured output modes or through PTY/tmux-driven interactive TUIs. Octopus does not reach into these tools via programmatic protocols that bypass their user-facing surfaces.

This principle is load-bearing for three reasons:

1. **Policy / ToS clarity.** Every major coding tool is shipped as a developer CLI. Human-equivalent invocation is squarely within the intended use model of each tool.
2. **Tool agnosticism.** Any CLI-shaped tool plugs in without vendor-specific adapter work or dependence on any particular structured protocol.
3. **Durability.** CLIs are stable surfaces. Structured protocols evolve and can break under the caller's feet.

The adapter layer enforces this principle: `cli_exec` and `pty_tmux` are the primary runtimes for external tools; `structured_acp` is available but opt-in only. See DECISIONS.md OCTO-DEC-036 and INTEGRATION.md §Principle of user-equivalent operation.

### 9. Research-driven execution for high-leverage tasks

Agents do worse when they code before they understand. For tasks where success depends materially on prior art, external knowledge, or domain understanding (architecture, optimization, protocol work, unfamiliar codebases, build-vs-buy decisions), Octopus explicitly supports research and synthesis as first-class stages of execution — not optional chat fluff.

Missions carry an `execution_mode` field selecting one of five modes: `direct_execute` (the default; narrow local tasks), `research_then_plan`, `research_then_design_then_execute`, `compare_implementations`, or `validate_prior_art_then_execute`. An agent-side classifier chooses the mode before mission creation and pre-populates the mission graph with research, synthesis, and design grips before any implementation grips.

Grip types gain a documented conventional vocabulary — `research`, `synthesis`, `design`, `implementation`, `validation`, `comparison` — that describe the kind of work each grip represents. These are guidance, not an enforced enum; `GripSpec.type` remains free-form NonEmptyString.

Research outputs are first-class artifacts (via the existing ArtifactRecord model), not transient context. Downstream grips consume them via `GripSpec.input_ref`. The scheduler routes grips by capability match (`desired_capabilities[]`), not primarily by type.

This is policy-driven behavior, not optional best-effort habit. When a classifier picks a research-first mode, the mission spec literally requires research grips to complete before implementation grips can start — enforced by the existing `depends_on` graph mechanism.

See DECISIONS.md OCTO-DEC-039, LLD §Research-Driven Execution Pipeline, and `docs/octopus-orchestrator/research-driven-execution.md` for the full rationale.

## Core Concepts

### Head

The orchestration authority for a mission, work graph, or active supervision scope.

### Arm

A supervised worker session with its own runtime, session state, context, and lease.

### Grip

The current assigned unit of work held by an arm.

### Nervous System

The event bus, registry, telemetry, leases, and state plane that connect the head to the arms.

### Artifact Index

Shared artifacts, summaries, checkpoints, claims, and state traces that persist beyond a single session. Stored in the control plane as ArtifactRecords; see LLD §Core Domain Objects. (Earlier drafts referred to this as "Memory Ink" — the term is retired to avoid drift with the implementation surface.)

### Habitat

An execution environment, local or remote, where arms can run.

### Mode Adapter

A structured CLI adapter or PTY/tmux adapter that normalizes control over a runtime.

## User Requirements

Operators must be able to:

- start, pause, resume, stop, and inspect any arm
- reattach to live interactive sessions
- see the current task, health, lease owner, node, runtime mode, and last progress of every arm
- persist summaries, outputs, checkpoints, and claimed files/resources
- route work to nodes with matching capabilities
- recover from node loss or agent crash with minimal duplicate work
- enforce operator approval for risky actions
- take over any arm manually when necessary

## Functional Requirements

### Session and Arm Management

- persistent session registry
- stable arm identity over time
- arm lifecycle management including spawn, attach, detach, resume, restart, terminate
- support for both structured and PTY/tmux-backed runtimes

### Scheduling and Routing

- multi-node arm scheduling
- capability-aware routing
- sticky assignment for resumability
- explicit reassignment on failure, timeout, or operator action

### Shared State and Coordination

- shared state and artifact store
- explicit task/grip ownership
- file/resource claims to avoid collisions
- event-sourced state transitions

### Health and Recovery

- health checks and heartbeats
- retry, restart, reassign, and quarantine flows
- replay and reconciliation after restart

### Operator Control

- CLI and optional UI for status, attach, replay, intervention
- human override and live takeover

### Observability

- logs, structured events, cost, timing, and failures
- node health and capacity
- provenance for decisions and transitions

### Safety

- policy engine for approvals and capability restrictions
- quarantine unsafe or ambiguous arms
- no silent bypass of approvals

## Success Metrics

- time to spawn and supervise 10 arms under 30 seconds
- 95 percent of arm failures recoverable without manual reconstruction
- reattach success rate above 99 percent for active sessions
- duplicate work after failover under 5 percent of task volume
- mean operator time to diagnose a failed arm under 2 minutes
- full provenance for all arm state transitions and artifacts

## Risks

- PTY automation brittleness across tools and terminal UIs
- state divergence between structured and PTY modes
- excessive coordination overhead if shared state becomes too chatty
- unsafe duplicate execution after recovery
- operator overload if telemetry and alerts are too noisy

## Competitive / Landscape Context

The current ecosystem appears to have partial winners in separate layers:

- distributed mission orchestration across machines
- worktree and tmux fleet plumbing
- PTY embodiment and terminal control
- agent conversation and observability surfaces
- protocol-centered orchestration systems

The gap is a clean synthesis of:

- terminal-native execution
- resumable distributed supervision
- explicit shared state
- safety and auditability
- provider flexibility

This product is intended to fill that gap.

## OpenClaw Integration Context

The Octopus Orchestrator is **not** a greenfield system. It is built on top of OpenClaw's existing architecture and reuses these primitives rather than reinventing them:

| Octopus concept                        | OpenClaw primitive it builds on                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport between Head and Node Agents | Gateway WebSocket protocol (`127.0.0.1:18789`), extended with an `octo.*` method namespace                                                                                                    |
| Node Agent identity and trust          | Existing `role: node` clients, device pairing, device tokens, `connect.challenge` signing                                                                                                     |
| Structured runtime arms                | Existing native subagent runtime (`sessions_spawn`) and ACP runtime (`acpx`, `sessions_spawn({runtime: "acp"})`)                                                                              |
| Arm state ledger                       | Existing background task ledger (`openclaw tasks`), extended from coarse `queued→running→terminal` into the richer event-sourced arm/grip state machines                                      |
| Session storage                        | Existing `~/.openclaw/agents/<agentId>/sessions/sessions.json` and `<sessionId>.jsonl` transcripts                                                                                            |
| Per-arm policy                         | Existing per-agent `tools.allow/deny` and `sandbox.mode/scope` (policy ceiling); `tools.elevated` remains owned by OpenClaw for sandbox breakout and is not overloaded for control-plane auth |
| Skills on arms                         | Existing skill loader (`~/.openclaw/skills` + per-agent roots + allowlists)                                                                                                                   |
| Automation surfaces                    | Existing cron jobs, hooks, standing orders, and Task Flow (formerly ClawFlow) — Octopus composes on these, does not replace them                                                              |
| Operator CLI                           | Existing `openclaw <command>` conventions — Octopus commands live under `openclaw octo ...`                                                                                                   |

**Truly new work** introduced by Octopus:

- PTY/tmux runtime adapter (OpenClaw does not currently treat a PTY session as a first-class arm)
- Event-sourced mission and arm state (richer than the existing task ledger)
- Lease, claim, and grip ownership primitives
- Mission graph and multi-arm supervision
- Capability-aware scheduling across habitats

Anything not listed under "truly new work" should be implemented by extending, configuring, or wrapping an existing OpenClaw primitive. Parallel implementations are an anti-pattern for this project.

## Scope by Phase

This ordering is authoritative. It supersedes any earlier draft numbering and aligns with `recommendation.md` (Phases A–E) and `implementation-plan.md` (Milestones 1–6).

### Phase 1, Local Octopus MVP

- single head
- single habitat (local)
- tmux-backed durable arms
- basic session registry
- append-only event log
- CLI status view
- manual spawn, attach, resume, restart

### Phase 2, Runtime Adapters

- runtime adapter interface
- first structured integration built by **promoting an existing OpenClaw runtime** (native subagents or ACP/`acpx`) into a first-class arm
- one generic PTY/tmux adapter (new substrate)
- normalized arm state model

### Phase 3, Shared State and Claims

- grip/task ownership
- file/resource claims
- artifact index
- duplicate-work prevention and conflict handling

Rationale for ordering: coordination primitives must exist before distributing execution, or multi-node rollout will discover ownership gaps under load.

### Phase 4, Distributed Habitats

- remote node agents registered as Gateway `role: node` clients
- lease and heartbeat model layered on existing pairing/device-token trust
- capability-aware scheduling
- replicated registry and leases

### Phase 5, Safety and Recovery

- policy engine composed over existing per-agent `tools.allow/deny` and sandbox config
- approvals
- quarantine flows
- replay and checkpoint-based reassignment

### Phase 6, Advanced Supervision

- load balancing
- arm pooling
- speculative execution
- adaptive orchestration based on failure/performance signals

## Answered Design Questions

These were open in v0.1 and are resolved here. Full rationale lives in `DECISIONS.md`.

1. **Default durable substrate for local sessions** — tmux for session durability **plus** a lightweight sidecar checkpoint file per arm (cwd, grip id, last offset, session refs). Pure tmux loses grip context on restart; pure process checkpoints lose reattach capability. Both are needed.
2. **Reassignment aggressiveness vs duplicate execution** — lease grace window of 30s after TTL expiry before any reassignment, extended to 60s for grips marked `side_effecting: true`. Ambiguous duplicates are always quarantined rather than auto-merged.
3. **MVP consistency model** — strongly consistent (CAS) for arm state transitions, grips, leases, and claims; eventually consistent for logs, summaries, telemetry, and artifact annotations. Matches HLD §Shared State Model.
4. **First structured integration** — **OpenClaw's native subagent runtime first**, then the ACP runtime (`acpx`). Both already exist as first-class OpenClaw runtimes; promoting them into arms is a thinner change than integrating an external CLI. Claude Code via ACP falls out naturally from the ACP adapter.
5. **MVP operator surface** — CLI only. `openclaw octo ...` commands with a `--json` output mode for every subcommand. Live dashboard deferred to post-Phase 4 so the event model can stabilize first.

## Remaining Open Questions

- Multi-head coordination: does Phase 4 require HA heads, or is single-head + state-plane failover sufficient through Phase 6?
- Cross-habitat artifact sync: filesystem-shadowed vs object-store vs pull-on-demand. Deferred to Phase 4 design.
- Interaction with existing OpenClaw cron, standing-orders, hooks, and Task Flow automation — do those remain separate or does Octopus absorb/wrap them? **Answered:** Octopus composes on top via explicit trigger shapes (cron job type `octo.mission`, Task Flow step type `octo.mission`, mirrored Task Flow records for every mission, hook handler `octo.mission.create`). See INTEGRATION.md §Automation trigger surfaces.

## Exit Criteria for PRD Approval

The PRD is considered ready for review when:

- product scope and non-goals are accepted
- core concepts are stable enough to guide architecture
- phased implementation path is accepted
- success metrics and key risks are judged sufficient to begin HLD review
