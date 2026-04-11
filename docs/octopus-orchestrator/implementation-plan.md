# OpenClaw Octopus Orchestrator Implementation Plan

## Status

Draft v0.2

## Revision Notes

- v0.3 (ultraplan pass): Milestone 0 deliverables expanded with CONFIG.md, TEST-STRATEGY.md, OBSERVABILITY.md, ArmSpec/GripSpec TypeBox schemas, and code layout approval. Exit criteria for every milestone now reference TEST-STRATEGY.md chaos scenarios as concrete gates. Feature flag rollout plan added.
- v0.2: reconciled milestone order with PRD v0.2 (claims before distributed); updated Milestone 2 to reflect that the structured-adapter work reuses existing OpenClaw subagent and ACP runtimes rather than building a new runtime; added Milestone 0 deliverables to cover Gateway WS `octo.*` schema and state-path layout; parallelized Epic 4 (structured adapters) and Epic 5 (PTY) since they share Epic 2/3 dependencies but do not block each other; added cross-refs to existing OpenClaw CLI/state surfaces.

## Purpose

This document converts the PRD, HLD, LLD, and recommendation into a practical implementation plan with epics, milestones, and an initial sprint sequence.

## Delivery Strategy

The implementation strategy is phased to reduce architectural risk.

Order matters.
We should not jump into distributed scheduling before we have:

- durable local sessions
- normalized arm state
- recovery semantics
- explicit claims and operator control

## Milestones

### Milestone 0, Architecture Review and Decision Lock

Goal:

- approve PRD, HLD, LLD, landscape review, recommendation, DECISIONS, CONFIG, TEST-STRATEGY, OBSERVABILITY
- lock integration boundary with existing OpenClaw infrastructure
- land the Octopus feature flag in its off state

Deliverables:

- reviewed markdown doc set (v0.3+ across PRD/HLD/LLD/implementation-plan; v0.1 for new supporting docs)
- `DECISIONS.md` — 35 accepted decisions covering PRD question resolutions, architectural commitments, and integration/durability posture
- `CONFIG.md` — pinned `openclaw.json` `octo:` block schema
- `TEST-STRATEGY.md` — concrete chaos scenarios mapped to milestone exit criteria
- `OBSERVABILITY.md` — metric catalog with `openclaw_octo_*` prefix and alert targets
- `INTEGRATION.md` — user-facing integration surfaces, upstream dependency classification, and upstream-change playbook
- `COMPATIBILITY.md` — minimum supported OpenClaw version and tested-against matrix (stub at M0, filled as tests land)
- initial implementation scope freeze for MVP
- pinned state-path layout under `~/.openclaw/octo/` agreed with Gateway maintainer
- draft TypeBox schemas (no implementation) for:
  - `ArmSpec`, `GripSpec`, and `MissionSpec`
  - `octo.*` Gateway WS methods and events
  - `octo:` config block validator
  - `features.octo` structured feature descriptor
  - Agent tool parameter schemas (thin wrappers over ArmSpec/GripSpec/MissionSpec)
- code layout approved (see HLD §Code layout and module boundaries)
- feature flag `octo.enabled` landed in `openclaw.json` as `false` by default
- empty `src/octo/` module scaffold merged to trunk
- empty `src/octo/adapters/openclaw/` bridge directory with placeholder files and header templates per OCTO-DEC-033
- lint/CI rule that rejects OpenClaw internal imports from outside `src/octo/adapters/openclaw/`
- **draft upstream PRs** (not merged) for the Required Upstream Changes listed in INTEGRATION.md, authored to demonstrate the additive nature of each change

Exit criteria:

- architecture docs approved for build planning
- no unresolved blocking ambiguity around terminal-first approach
- Gateway team signs off on `octo.*` namespace addition, state-path allocation, and `src/octo/` module placement
- Gateway team signs off on the upstream-PR drafts and a scheduled merge window for them during Milestone 1
- `openclaw` builds cleanly with the empty `src/octo/` scaffold and `octo.enabled: false`
- existing OpenClaw integration and subagent/ACP tests still pass with the scaffold merged
- **Go/no-go check:** if any required upstream change is rejected or indefinitely blocked, Milestone 1 is paused until a path forward exists (per OCTO-DEC-035)

### Milestone 1, Local Octopus MVP

Goal:

- prove durable local arm orchestration on one machine

Deliverables:

- tmux-backed arm supervisor
- session registry
- append-only event log
- arm lifecycle CLI commands
- attach/resume/restart flows
- local reconciliation on restart

Exit criteria:

- can spawn, list, attach, restart, and recover multiple local arms
- state survives operator disconnect and process restart
- TEST-STRATEGY.md M1 chaos scenarios pass: kill local arm process, kill Gateway process, disk fill on events.jsonl partition
- PRD success metric validation: spawn-10-arms-under-30s integration test passes

### Milestone 2, Runtime Adapters (Structured + PTY)

Goal:

- land the adapter interface and all three first-class adapter implementations

Deliverables:

- adapter interface (as specified in LLD §Runtime Adapter Interfaces)
- **SubagentAdapter** — thin wrapper over existing `sessions_spawn` + `/subagents` primitives, arms tracked with `task_ref` into existing background task ledger
- **AcpAdapter** — thin wrapper over existing `sessions_spawn({runtime: "acp"})` + `/acp` primitives; all harnesses supported by `acpx` (Codex, Claude Code, Cursor, Gemini CLI, OpenClaw ACP, etc.) become available as arm runtimes automatically
- **PtyTmuxAdapter** — new build: capture normalization, send input/keys, checkpoint metadata, process exit classification
- normalized event ingestion across all three adapters

Exit criteria:

- subagent, ACP, and PTY/tmux sessions all appear as first-class arms under `openclaw octo arm list`
- operator can inspect, attach, and resume them through the same orchestration model
- `openclaw tasks list` and `openclaw octo arm list` never disagree on the status of a shared run
- TEST-STRATEGY.md M2 chaos scenarios pass: malformed adapter events, mid-grip subagent session expiry
- **INTEGRATION.md §First-Class Citizenship Checklist passes every item** — this is the definition of "first-class OpenClaw citizen" and is the milestone-exit gate
- `octo.enabled` default flipped to `true` as part of this milestone's release
- Required upstream PRs from Milestone 0 have all landed in OpenClaw core by this point
- Compatibility integration tests pass against the current OpenClaw release

### Milestone 3, Shared State and Claims

Goal:

- introduce explicit coordination primitives beyond session presence
- close the ambiguous-duplicate-execution design (LLD §Recovery Flows #5)

Deliverables:

- grip/task ownership
- claim system for files/resources/branches/ports
- artifact index
- conflict and duplicate-work prevention basics
- finalized resolution policy for `grip.ambiguous`

Exit criteria:

- concurrent arms can coordinate safely without trampling each other
- duplicate-execution resolution flow documented, implemented, and tested
- TEST-STRATEGY.md M3 chaos scenarios pass: concurrent file claim, ambiguous duplicate grip completion
- Worktree coordination validated: parallel coding arms on sibling worktrees complete without collision

### Milestone 4, Distributed Habitats

Goal:

- extend orchestration across multiple nodes via existing Gateway `role: node` wire

Deliverables:

- Node Agent implementation as a `role: node` Gateway client speaking the `octo.*` method namespace
- reuse of existing device pairing + device token auth — no new credential system
- lease and heartbeat model via `octo.lease.renew` push events
- capability-aware scheduling
- remote reconciliation and recovery flows
- per-node sidecar unacked-transition log at `~/.openclaw/octo/node-<nodeId>/pending.jsonl`
- Postgres migration evaluation gate (per LLD §Storage Choices)

Exit criteria:

- arms can run across multiple habitats with stable supervision and recovery
- TEST-STRATEGY.md M4 chaos scenarios pass: kill Node Agent mid-arm (duplicate-execution <5%), wrong idempotency key rejection, ±30s clock skew tolerance
- Postgres migration decision logged (migration executed if any trigger fired, deferred otherwise)

### Milestone 5, Safety and Advanced Supervision

Goal:

- make the system operationally trustworthy at scale
- activate `policy_profile` enforcement (deferred from Milestone 1 per LLD §Policy Enforcement Timeline)

Deliverables:

- policy engine layered over existing per-agent `tools.allow/deny` and sandbox config
- approval hooks via the `octo.writer` device-token capability and a new `octo.approval.*` multi-operator flow (see INTEGRATION.md §Operator authorization model — intentionally not overloading OpenClaw's `tools.elevated`, which is about sandbox breakout for exec)
- quarantine flows
- advanced recovery and optional speculative execution
- replay of historical arms against new policy profiles for compliance reporting

Exit criteria:

- risky actions are governed correctly
- ambiguous failures can be contained without chaos
- no orchestration code path can execute tools outside an arm's bound OpenClaw agent ceiling
- TEST-STRATEGY.md M5 chaos scenarios pass: policy-denied spawn blocked, operator without `octo.writer` rejected and audited
- Historical replay compliance report generated from event log against new policy profiles

## Epics

## Epic 1, Durable Local Session Substrate

Objective:

- establish tmux-backed durability for local arms

Stories:

- create named tmux session per arm
- persist arm metadata to registry
- attach and detach safely
- restart arm supervisor without losing session bindings
- enumerate live tmux sessions and reconcile them to arms

Dependencies:

- none

## Epic 2, Registry and Event Log

Objective:

- make arm state durable and replayable

Stories:

- define ArmRecord and GripRecord storage
- implement Event schema and append-only event writing
- implement state transition service with validation
- build replay path for restart recovery

Dependencies:

- Epic 1 partial

## Epic 3, Operator CLI Surface

Objective:

- provide real orchestration control to the user

Stories:

- `octo status`
- `octo arm list`
- `octo arm show`
- `octo arm attach`
- `octo arm restart`
- `octo events --tail`

Dependencies:

- Epics 1 and 2

## Epic 4, Structured Adapter Interface (Subagent + ACP)

Objective:

- promote existing OpenClaw subagent and ACP runtimes into first-class arms via a single adapter contract

Stories:

- define adapter contract
- **SubagentAdapter**: wrap `sessions_spawn` default runtime; wire `task_ref`; map `/subagents` control actions to adapter methods
- **AcpAdapter**: wrap `sessions_spawn({runtime: "acp"})`; wire `task_ref`; map `/acp spawn|steer|cancel|close` to adapter methods
- store structured session ids (subagent session key, ACP `agent:<id>:acp:<uuid>`)
- normalize events into the octo event log
- support resume semantics via existing session keys

Dependencies:

- Epics 2 and 3
- **No dependency on Epic 5** — structured and PTY adapters can be built in parallel once Epic 2/3 are in place

## Epic 5, PTY Adapter Normalization (new runtime)

Objective:

- unify PTY-backed runtime behavior under the same control model — the only net-new runtime Octopus introduces

Stories:

- PTY capture normalization
- send input and send keys APIs
- checkpoint metadata generation
- process exit classification
- health status derivation for tmux-backed sessions
- tmux session discovery and orphan rebind

Dependencies:

- Epics 1, 2, and 3
- **No dependency on Epic 4** — can be built in parallel

## Epic 6, Claims and Coordination Primitives

Objective:

- prevent collisions and duplicate work

Stories:

- claim service for files, dirs, branches, ports, task keys
- lease-bound claim expiry
- grip ownership semantics
- conflict detection and reporting
- finalized `grip.ambiguous` resolution flow per LLD §Recovery Flows #5

Dependencies:

- Epics 2, 3, and **at least one** of {Epic 4, Epic 5} — claims need a working adapter to exercise them, but do not need both

## Epic 7, Node Agent and Distributed Scheduling

Objective:

- support multiple habitats via the existing Gateway WS as `role: node` clients

Stories:

- `octo.*` TypeBox schema addition to the existing OpenClaw protocol definitions
- Node Agent as Gateway `role: node` client; device pairing flow reuses existing operator approval
- capability advertisement under `connect.params.caps.octo`
- lease renewal model over `octo.lease.renew` push events
- remote spawn/attach/reconcile flows
- scheduler placement logic
- node health and degradation handling
- per-node unacked transition sidecar log

Dependencies:

- Epics 2 through 6

## Epic 8, Safety and Policy Engine

Objective:

- preserve operator trust and prevent orchestration abuse
- activate `policy_profile` enforcement (forward-compatible field from Epic 2)

Stories:

- policy engine layered over existing per-agent `tools.allow/deny` and `sandbox` config
- risky action escalation via `octo.writer` capability gating plus `octo.approval.*` flow (see INTEGRATION.md §Operator authorization model)
- quarantine behavior
- audit trail for interventions and approvals
- replay of historical arms against new policy profiles

Dependencies:

- Epics 2 through 7

## Suggested Sprint Sequence

### Sprint 1

Focus:

- local tmux-backed arm lifecycle
- minimal registry
- minimal CLI

Deliverables:

- spawn arm
- list arms
- attach arm
- restart arm
- simple JSONL event log

### Sprint 2

Focus:

- state validation and replay
- session reconciliation
- improved status model

Deliverables:

- state machine enforcement
- replay on restart
- tmux discovery and orphan rebind logic

### Sprint 3 (Milestone 2 kickoff — parallel lanes)

Focus:

- adapter contract + both structured adapters in parallel with the PTY lane

Lane A (one engineer):

- adapter contract
- SubagentAdapter wrapping existing `sessions_spawn`
- AcpAdapter wrapping existing `sessions_spawn({runtime: "acp"})`
- `task_ref` wiring into `openclaw tasks list`

Lane B (one engineer, parallel):

- PTY/tmux adapter capture normalization
- send input / send keys
- checkpoint metadata generation

### Sprint 4 (Milestone 2 close)

Focus:

- complete adapter normalization and reconciliation across all three runtimes

Deliverables:

- PTY adapter checkpoint model finalized
- process exit classification
- health status derivation
- cross-adapter event-log consistency tests

### Sprint 5 (Milestone 3)

Focus:

- claims and shared coordination state
- close `grip.ambiguous` resolution design

Deliverables:

- claim service
- grip ownership
- basic duplicate-work prevention
- finalized ambiguous-duplicate resolution flow and tests

### Sprint 6 (Milestone 4)

Focus:

- node agent over existing Gateway WS

Deliverables:

- TypeBox `octo.*` schema landed in OpenClaw protocol definitions
- Node Agent registered as Gateway `role: node` client
- remote heartbeats via `octo.lease.renew`
- remote arm spawn and recovery
- Postgres migration gate evaluated

### Sprint 7 (Milestone 5)

Focus:

- activate policy enforcement
- advanced supervision and recovery

Deliverables:

- `policy_profile` enforcement turned on
- escalation hooks routed through the new `octo.approval.*` flow built on device-token capabilities
- quarantine state and operator intervention flows
- historical-replay compliance report

## Technical Debt to Avoid Early

- building a fancy dashboard before the event model is stable
- speculative execution before claims and recovery exist
- **building a new runtime** when an existing OpenClaw runtime (subagent, ACP, cron) can be wrapped
- adding too many PTY-shaped runtimes before one structured and one PTY adapter are solid
- conflating chat transcript history with shared state
- burying safety logic inside adapter implementations instead of a policy layer
- forking transport, pairing, or sandbox from the existing Gateway implementation

## Review Points

Schedule review at the end of:

- Milestone 1, to validate the local substrate
- Milestone 2, to validate runtime adapter coverage (subagent + ACP + PTY)
- Milestone 3, to validate coordination semantics and ambiguous-duplicate resolution
- Milestone 4, to validate distributed behavior before scaling further
- Milestone 5, to validate safety activation

## Recommended Immediate Work Items

Start with these concrete build tickets (ordered by dependency, first to last):

**Milestone 0 (docs + scaffold, no runtime behavior):**

1. Draft TypeBox schemas for `ArmSpec`, `GripSpec`, `octo.*` Gateway WS methods + events, and the `octo:` config block — land them as schema files only, no handlers
2. Land the `octo.enabled` feature flag (default `false`) in `openclaw.json` config loader
3. Merge the empty `src/octo/` module scaffold per HLD §Code layout and module boundaries
4. Wire `CONFIG.md`, `TEST-STRATEGY.md`, `OBSERVABILITY.md`, and `DECISIONS.md` into the repo docs

**Milestone 1 (first executable code):** 5. Create octo registry schema and JSONL event log at `~/.openclaw/octo/` — SQLite with `version` columns for CAS 6. Implement EventLogService with replay and schema-version migration hooks 7. Build tmux-backed local arm launcher (PtyTmuxAdapter skeleton — wait, see below) 8. Add `openclaw octo status`, `openclaw octo arm list`, `openclaw octo arm show` (with `--json`) 9. Add `openclaw octo arm attach`, `restart`, `terminate` 10. Add reconciliation on restart for local tmux sessions 11. Instrument the metric set from OBSERVABILITY.md for arm and event-log categories

**Milestone 2 (adapters — parallel lanes, same sprint):** 12. Lane A: adapter interface + SubagentAdapter wrapping `sessions_spawn` 13. Lane A: AcpAdapter wrapping `sessions_spawn({runtime: "acp"})` 14. Lane B: PtyTmuxAdapter — finish what was stubbed in Milestone 1 15. Cross-lane: `task_ref` wiring into `openclaw tasks list` so both surfaces stay consistent

## Exit Criteria for Implementation Plan Approval

This plan is ready for review when:

- milestones are accepted
- epics map cleanly to the architecture docs
- sprint sequence is accepted as realistic
- immediate work items are judged implementable without further architecture churn
