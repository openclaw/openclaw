# OpenClaw Octopus Orchestrator Decision Log

## Status

Milestone 0 — living document. Updated on every architectural decision through Milestone 5.

## Purpose

Authoritative record of accepted and rejected architectural assumptions, resolutions to open PRD questions, and integration commitments with existing OpenClaw infrastructure. When a design question arises during implementation, check here first.

## How to use this file

- Every decision gets a unique id (`OCTO-DEC-NNN`), a date, a status (`accepted`, `rejected`, `superseded`), a one-line summary, the reasoning, and downstream implications.
- Superseded decisions stay in the file with a `Superseded by: OCTO-DEC-NNN` pointer.
- Don't delete. Amend.

---

## OCTO-DEC-001 — Build-native orchestration core, borrow patterns

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Build the orchestration head, scheduler, shared state, lease/claim model, and operator surfaces natively in OpenClaw. Treat external systems (Fleet, ai-fleet, PiloTY, AgentPipe, ccswarm) as pattern sources only, not foundational dependencies.
**Reason:** No single candidate in the landscape review covers the full synthesis (terminal-native execution + structured runtime support + PTY/tmux fallback + durable resumable arms + explicit shared state + distributed habitats + operator intervention + provider flexibility). See `recommendation.md`.
**Implications:** We own the orchestration surface. Adapter layer can integrate any runtime on demand.

---

## OCTO-DEC-002 — Head lives inside the OpenClaw Gateway process

**Date:** 2026-04-09
**Status:** accepted
**Decision:** The Head Controller runs as a Gateway subsystem or as a trusted loopback client of it. It does not open a new listening socket. All Head↔Node-Agent and operator↔Head communication flows over the existing Gateway WebSocket (`127.0.0.1:18789`).
**Reason:** Gateway already owns device pairing, auth modes, `role: node` clients, idempotency caches, Tailscale/SSH tunneling, and operator surfaces (CLI, macOS app, web admin). Introducing a second orchestration socket would fork the trust model, produce two places for operators to learn, and duplicate security-sensitive code.
**Implications:** All new wire methods are added under an `octo.*` namespace in the existing TypeBox protocol definitions. No new auth system.

---

## OCTO-DEC-003 — `octo.*` Gateway WS method namespace for Head↔Node Agent

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Node Agents are Gateway clients with `role: node` and an `octo` capability declared in `connect.params.caps`. The Head calls into them with request methods (`octo.arm.spawn`, `octo.arm.attach`, `octo.arm.send`, `octo.arm.checkpoint`, `octo.arm.terminate`, `octo.arm.health`, `octo.node.capabilities`, `octo.node.reconcile`) and subscribes to push events (`octo.arm.state`, `octo.arm.output`, `octo.arm.checkpoint`, `octo.lease.renew`, `octo.node.telemetry`, `octo.anomaly`).
**Reason:** OCTO-DEC-002 implies we reuse existing transport. A namespaced method/event prefix is the minimum-invasive extension pattern.
**Implications:** All side-effecting methods require idempotency keys (existing Gateway semantics). Push events are not replayed per existing Gateway invariant; durability sits in the control plane event log and per-node sidecar logs at `~/.openclaw/octo/node-<nodeId>/pending.jsonl`.

---

## OCTO-DEC-004 — Reuse existing runtimes for structured adapters

**Date:** 2026-04-09
**Status:** accepted
**Decision:** The first two "structured" adapters wrap existing OpenClaw runtimes instead of integrating external CLIs:

- `SubagentAdapter` wraps native subagents via `sessions_spawn` (default runtime)
- `AcpAdapter` wraps ACP runtime via `sessions_spawn({runtime: "acp"})`, inheriting all `acpx`-supported harnesses (Codex, Claude Code, Cursor, Gemini CLI, OpenClaw ACP, etc.)
  **Reason:** Both runtimes already exist, are production-exercised, have a background task ledger (`openclaw tasks list`), and cover the "structured, resumable, machine-readable" use case. Building a parallel Claude Code integration from scratch would duplicate work. Claude Code, Codex, and peers come along for free through ACP.
  **Implications:** The first genuinely new runtime Octopus builds is the PTY/tmux adapter. The `task_ref` field on ArmRecord cross-references the existing task ledger so operators see one view of a run regardless of which CLI surface they check.
  **Supersedes:** implicit PRD v0.1 assumption that Claude Code structured integration was a distinct work item.

---

## OCTO-DEC-005 — Phase ordering: claims before distributed

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Phase 3 delivers shared state and claims; Phase 4 delivers distributed habitats. PRD v0.1 had these reversed.
**Reason:** Multi-node rollout without ownership primitives discovers gaps under load. Recommendation and implementation plan already assumed this ordering; PRD numbering was the outlier.
**Implications:** PRD, HLD, LLD, recommendation, and implementation plan all numbered consistently in v0.2.

---

## OCTO-DEC-006 — Default durable substrate: tmux + sidecar checkpoint

**Date:** 2026-04-09
**Status:** accepted
**Resolves PRD Open Question:** #1 (default durable substrate for local sessions)
**Decision:** Use tmux for session durability **plus** a lightweight per-arm sidecar checkpoint file under `~/.openclaw/octo/` containing cwd, current grip id, last observed output offset, active claims, and session references. Neither alone is sufficient.
**Reason:** Pure tmux loses grip context across restarts. Pure process checkpoints lose reattach capability and human takeover path. Both are required for the recovery guarantees the PRD promises.
**Implications:** Checkpoint cadence is tunable in `openclaw.json` under `octo.checkpoint.intervalSeconds`.

---

## OCTO-DEC-007 — Lease grace windows

**Date:** 2026-04-09
**Status:** accepted
**Resolves PRD Open Question:** #2 (reassignment aggressiveness)
**Decision:** Lease renew every 10s, TTL 30s. Grace window before reassignment is 30s for non-side-effecting grips and 60s for `side_effecting: true` grips. Ambiguous duplicate-execution is always quarantined, never auto-merged.
**Reason:** Side-effecting duplicates are the costly failure mode; the extra 30s is cheap insurance compared to a duplicated production write.
**Implications:** Tunable in `openclaw.json` under `octo.lease`. Milestone 1 chaos test validates the default against the PRD's <5% duplicate-execution success metric and values are revised if that budget is blown.

---

## OCTO-DEC-008 — MVP consistency model

**Date:** 2026-04-09
**Status:** accepted
**Resolves PRD Open Question:** #3 (consistency model)
**Decision:** Strongly consistent with CAS semantics for arm state transitions, grip state, leases, and claims. Eventually consistent for logs, summaries, telemetry, and artifact annotations.
**Reason:** Coordination correctness must not depend on read order for anything where duplicates or lost ownership cause damage. Everything else can tolerate gaps without risking the recovery model.
**Implications:** SQLite is sufficient for MVP (single-writer control plane in Gateway process). See OCTO-DEC-010 for storage choice.

---

## OCTO-DEC-009 — First structured integration is native subagents + ACP

**Date:** 2026-04-09
**Status:** accepted
**Resolves PRD Open Question:** #4 (first structured runtime after Claude Code)
**Decision:** Promote existing OpenClaw native subagents (`sessions_spawn`) and the ACP runtime (`acpx`) into first-class arms, in that order. Claude Code comes along automatically through ACP.
**Reason:** Both runtimes already exist in OpenClaw. Building a direct Claude Code integration would bypass the ACP work already in place. See OCTO-DEC-004.
**Implications:** SubagentAdapter and AcpAdapter are thin wrappers; no net-new runtime work in Milestone 2 except the PTY/tmux adapter.

---

## OCTO-DEC-010 — SQLite for MVP storage, Postgres on named triggers

**Date:** 2026-04-09
**Status:** accepted
**Decision:** SQLite for registry, claims, leases, and event metadata through Milestones 1–3. Event log stored as append-only JSONL. Artifacts on filesystem.

Postgres migration triggers (any one):

1. Control plane must run across >1 Head process (HA or geographically distributed)
2. Concurrent writer count across Head + Node Agents exceeds ~50 sustained
3. Event log volume exceeds the retention or query latency budget set at Milestone 3 exit
   **Reason:** SQLite is sufficient while the control plane lives inside a single Gateway process. Postgres is only needed once distributed writes are real. Named triggers prevent a vibes-driven migration.
   **Implications:** CAS pattern uses `version` column + `UPDATE ... WHERE version = :expected`. Postgres migration itself is scheduled inside Milestone 4 if any trigger fires during planning.

---

## OCTO-DEC-011 — CLI-only operator surface for MVP, `--json` everywhere

**Date:** 2026-04-09
**Status:** accepted
**Resolves PRD Open Question:** #5 (MVP operator surface)
**Decision:** `openclaw octo ...` CLI only through Phase 3. Every command supports a `--json` flag. Live dashboard deferred until after Milestone 3 so the event model can stabilize first.
**Reason:** Dashboards are load-bearing on the event schema. Shipping a dashboard against a draft schema creates churn. CLI with `--json` lets operators, automations, and any future UI consume the same surface.
**Implications:** Matches existing OpenClaw CLI conventions (`openclaw sessions --json`, `openclaw tasks list`).

---

## OCTO-DEC-012 — `policy_profile` forward-compatible, enforced Milestone 5

**Date:** 2026-04-09
**Status:** accepted
**Decision:** ArmRecord carries a `policy_profile` field from Milestone 1 onward, but active enforcement is deferred until Milestone 5. Until then, arms inherit the effective OpenClaw per-agent ceiling (`tools.allow/deny`, `sandbox.*`) of their bound `agent_id` directly.
**Reason:** The per-agent ceiling is a real, existing control — no arm runs outside it today. Populating `policy_profile` early gives the eventual PolicyService a full historical dataset to replay and audit against.
**Implications:** Writing the field early is cheap. Enforcing it early would require building the PolicyService before the state model has settled.

---

## OCTO-DEC-013 — "Memory Ink" retired in favor of ArtifactRecord

**Date:** 2026-04-09
**Status:** accepted
**Decision:** The PRD's "Memory Ink" concept is retired. All shared artifact, summary, checkpoint, and state-trace storage is exposed through ArtifactRecord and the Artifact Index.
**Reason:** Memory Ink was a term introduced in PRD v0.1 but never threaded through HLD/LLD. Drifting vocabulary between architecture docs becomes expensive once implementation begins.
**Implications:** PRD v0.2 section updated. LLD already used ArtifactRecord.

---

## OCTO-DEC-014 — Octopus composes on existing OpenClaw automation, does not replace it

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Existing OpenClaw cron jobs, hooks, standing orders, and Task Flow (formerly ClawFlow) continue to operate. Octopus missions can be triggered from any of these surfaces via concrete trigger shapes defined in INTEGRATION.md §Automation trigger surfaces. Octopus does not subsume or rewrite them. Mirrored Task Flow mode gives existing flow-aware tools a first-class view of every mission without reimplementing flow tracking.
**Reason:** Cron, flows, and hooks already cover important automation patterns. Replacing them would delay Octopus and break existing user automations.
**Implications:** MissionRecord `metadata.source` carries values like `cron`, `flow`, `cli`, `operator`, `subagent-spawn`. The Head surfaces missions regardless of trigger.

---

## OCTO-DEC-015 — ACP is an adapter, not a forbidden protocol

**Date:** 2026-04-09
**Status:** accepted
**Decision:** The PRD principle "no ACP dependence" means ACP cannot be the **control plane or primary dependency**. It does not mean ACP is forbidden. ACP sessions are a first-class adapter via `AcpAdapter` and are one of the two structured adapters in Milestone 2.
**Reason:** OpenClaw ships with the `acpx` plugin enabled by default and supports many harnesses through it. Rejecting ACP wholesale would remove production-exercised runtimes from Octopus coverage for no architectural gain.
**Implications:** HLD and recommendation language updated to clarify. The constraint is "terminal-first control as the default assumption; ACP is additive, not central."

---

## OCTO-DEC-016 — State paths pinned under `~/.openclaw/octo/`

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Octopus control plane state lives under `~/.openclaw/octo/`:

- `registry.sqlite` — registry tables
- `events.jsonl` — append-only event log
- `artifacts/` — artifact blobs
- `node-<nodeId>/pending.jsonl` — per-node unacked transition log

Session state continues to live at existing `~/.openclaw/agents/<agentId>/sessions/`.
**Reason:** Respects existing `OPENCLAW_STATE_DIR` override, workspace scoping, and backup tooling. Octopus is a subdirectory of the OpenClaw state tree, not a parallel tree.
**Implications:** `openclaw.json` gains an `octo:` config block for scheduler, lease timings, policy profiles, and habitat overrides.

---

---

## OCTO-DEC-017 — ArmSpec and GripSpec are the primary API contracts, TypeBox-validated

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Arm and grip creation flow through explicit `ArmSpec` and `GripSpec` schemas (see LLD §Spawn Specifications) validated against TypeBox at the boundary. Invalid specs are rejected before any state transition.
**Reason:** Without a pinned API surface, adapters, scheduler, and operator CLI will drift into inconsistent understandings of what can be launched. TypeBox is already OpenClaw's protocol definition tool.
**Implications:** Spec versioning via `spec_version` field. Milestone 0 includes drafting the TypeBox schemas alongside the `octo.*` wire schema.

---

## OCTO-DEC-018 — Event schema versioning uses migrate-on-replay, never rewrite

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Event log carries `schema_version`. Schema bumps happen only on breaking payload changes. Old events are migrated to the current in-memory representation on replay via pure, total transforms. The on-disk log is never rewritten.
**Reason:** Rewriting the log on upgrade is the source of the worst event-sourcing bugs: partial rewrites corrupt history, and operators lose the ability to trust audit trails. Migrate-on-replay is the safe default.
**Implications:** Prefer additive field changes. Every bump ships with a replay test against a pinned snapshot of the prior version.

---

## OCTO-DEC-019 — Capability taxonomy is namespaced strings with explicit matching rules

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Habitat capabilities are strings in namespaces: `runtime.*`, `os.*`, `tool.*`, `net.*`, `resource.*`, `auth.*`, `fs.*`, `agent.*`, `label.*`. Matching supports prefix wildcards and negation. Preferences are separate from requirements.
**Reason:** Structured capability enums would force a schema change every time a new runtime or tool matters. Free-form strings would make matching ambiguous. Namespaced strings with explicit matching rules give both extensibility and predictability.
**Implications:** Node Agents must emit a canonical capability list on connect. Operators can use `label.*` freely for their own affinity policies without code changes.

---

## OCTO-DEC-020 — Scheduler is weighted scoring + mission-fair round robin, no preemption in MVP

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Placement uses a weighted sum across stickiness, locality, preferred matches, load balance, failure penalty, and cross-agent penalty. Fairness across missions is enforced by virtual-time round robin. No preemption through Phase 5.
**Reason:** Weighted scoring is well understood and tunable. Mission-fair round robin prevents starvation without needing a priority queue rewrite. Preemption creates new invariants (partial results, forced checkpoints) that cannot be designed until the recovery model is proven.
**Implications:** Weights exposed in `octo.scheduler.weights`. Preemption reopened as a question in Phase 6.

---

## OCTO-DEC-021 — Forward-progress heartbeat is distinct from liveness lease

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Liveness (lease renewal) proves the arm exists. Progress (a `progress_tick` signal on each output event) proves the arm is making forward progress. A wedged arm can be `alive` and `blocked` simultaneously.
**Reason:** Lease-based liveness alone cannot distinguish a healthy arm from an infinite-loop arm from a deadlocked arm. Most practical stuck-arm incidents in existing OpenClaw cron/subagent runs were wedges, not deaths.
**Implications:** ProgressWatchdog as a separate Head service. Stall threshold tunable per `octo.progress.stallThresholdS`. Auto-terminate is opt-in.

---

## OCTO-DEC-022 — CostRecord and per-mission budgets from day one

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Cost and token metadata is extracted from structured adapter events and written as CostRecord. MissionRecord may carry a budget object with `cost_usd_limit`, `token_limit`, and an `on_exceed` action (`pause`, `abort`, `warn_only`).
**Reason:** OpenClaw structured runtimes already emit this data. Capturing it now is cheap. Waiting for a dedicated cost milestone means every early adopter builds their own tracking.
**Implications:** PTY arms without cost metadata can use an optional time-based proxy. Budget enforcement runs on every cost-carrying event.

---

## OCTO-DEC-023 — Backpressure via bounded buffers + local rolling files + rate limit

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Per-arm in-memory output ring buffer (default 2 MiB). On overflow: emit a `truncated` event and write full output to a node-local rolling file (default 64 MiB × 4 segments). Event log ingestion is rate-limited per arm (default 200 events/sec) with drops counted as anomalies.
**Reason:** Unbounded buffers are the most common way distributed systems run out of memory. Bounded buffers with visible drops give operators real signal instead of silent degradation.
**Implications:** Operators attaching to a live arm read from buffer + rolling file tail. All thresholds tunable.

---

## OCTO-DEC-024 — Operator authorization starts with loopback-auto-writer + octo.writer capability flag

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Through Milestone 3, any paired operator can call read-only `octo.*` methods; side-effecting methods require the device token to carry an `octo.writer` capability flag, with loopback auto-granting it. Full per-mission ownership and delegated approvals are Milestone 5 work.
**Reason:** The existing Gateway auth model is binary. Rich RBAC is overkill for the expected operator population, but side-effecting octopus commands are significantly more consequential than sending a chat message, so binary auth alone isn't safe either. The flag + loopback auto-grant preserves existing same-host UX without exposing writer to unaudited remote clients.
**Implications:** Pairing flow gains an `octo.writer` approval step for non-loopback clients. All side-effecting actions are logged to the event log with actor attribution.

---

## OCTO-DEC-025 — Worktree coordination via ClaimService `resource_type: "dir"` + `"branch"`

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Worktree isolation is enforced by exclusive claims on the worktree directory path and (optionally) the branch name. Octopus does not run git commands; it coordinates collision prevention on paths and branches that arms manipulate via their own runtimes.
**Reason:** The landscape review praised ai-fleet's worktree discipline. Making it first-class through the existing ClaimService is cheap and lets coding missions fan out safely without a separate git integration layer.
**Implications:** SessionReconciler prunes worktrees for archived arms. No git binary dependency on the control plane.

---

## OCTO-DEC-026 — Arm lifetime is independent of runtime session lifetime

**Date:** 2026-04-09
**Status:** accepted
**Decision:** An arm is a supervised execution object whose lifetime spans multiple runtime sessions. For one-shot runtimes (subagents, ACP `mode: run`), `session_ref` changes per grip while `arm_id` remains stable. For persistent runtimes (ACP `mode: session`, PTY/tmux), arm and session lifetimes track each other. Idle arms hold resources for stickiness until an idle timeout fires.
**Reason:** Treating every subagent run as its own arm would make supervision and cost accounting painful. Separating arm identity from session identity lets the scheduler reuse warm context and gives operators a coherent handle for long-running work.
**Implications:** Explicit documentation needed in adapter contract. Idle timeout tunable. Restart count is per-arm, not per-session.

---

## OCTO-DEC-027 — Feature flag `octo.enabled` gates the entire subsystem

**Date:** 2026-04-09
**Status:** accepted
**Decision:** A top-level `octo.enabled` boolean in `openclaw.json` gates the entire Octopus subsystem. Default `false` through Milestone 1. Default `true` after Milestone 2 exit criteria are met. With `octo.enabled: false`, no octo files are created and all `octo.*` Gateway methods return `not_enabled`.
**Reason:** Protects existing OpenClaw users from subsystem regressions during early builds. Lets us ship code to trunk before the substrate is ready for general availability.
**Implications:** Every octo code path must short-circuit when disabled. The CLI errors clearly instead of producing confusing partial output.

---

---

## OCTO-DEC-028 — Agent tool surface is first-class, not an afterthought

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Octopus exposes its control surface to agents as tools (`octo_status`, `octo_mission_*`, `octo_arm_*`, `octo_grip_*`, `octo_claims_*`). Read-only tools ship in the default allowlist; writer tools require per-agent `tools.allow` opt-in **and** the operator device token carrying the `octo.writer` capability. Tool parameter schemas are thin wrappers over the already-defined `ArmSpec`/`GripSpec`/`MissionSpec` TypeBox schemas — one source of truth across CLI, WS, and tools.
**Reason:** Without agent tools, natural-language invocations ("spawn 5 arms on this refactor") have no path to Octopus. Every other OpenClaw capability is tool-accessible; making Octopus the exception would make it permanently second-class.
**Implications:** Milestone 2 exit requires tools registered in the default registry. A documented decision guide (Subagent vs ACP vs Octopus) ships alongside so agents can choose correctly. See INTEGRATION.md §Agent tool surface.

---

## OCTO-DEC-029 — `tools.elevated` is NOT the control-plane approval surface

**Date:** 2026-04-09
**Status:** accepted
**Supersedes (partial):** earlier language in HLD v0.2 and DECISIONS v0.2 that routed Octopus approvals through `tools.elevated`.
**Decision:** OpenClaw's `tools.elevated` is specifically about sandbox breakout for `exec` and is owned by OpenClaw. Octopus must not overload it. Control-plane authorization for destructive octopus actions is gated by the `octo.writer` device-token capability (OCTO-DEC-024). Future multi-operator approvals for shared missions will use a new `octo.approval.*` flow built on the same event-log + device-token foundation.
**Reason:** Found during the INTEGRATION.md durability pass. Conflating `tools.elevated` with general control-plane auth creates a coupling to an OpenClaw feature whose semantics are about something else, and would break if OpenClaw refines or reshapes the elevated-exec flow.
**Implications:** HLD v0.3 and implementation-plan v0.3 corrected. No existing OpenClaw code is reused for destructive-action approval; a new thin flow is added in Milestone 5.

---

## OCTO-DEC-030 — Task Flow mirrored mode is the default for every mission

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Every Octopus mission automatically creates a mirrored Task Flow record. Mission state changes propagate to the mirrored flow as events. This gives `openclaw tasks flow list` and any future flow-aware consumer a first-class view of Octopus work without reimplementing flow tracking.
**Reason:** Task Flow already solves durable multi-step progress tracking, revision conflict detection, and cross-restart persistence. Reimplementing these would duplicate code and eventually diverge. Mirrored mode is observer-only, so Task Flow upstream changes only affect visibility, not correctness.
**Implications:** Integration is additive — a small bridge module in `adapters/openclaw/taskflow-bridge.ts`. If Task Flow is renamed or restructured again (as it was from ClawFlow), one bridge file updates.

---

## OCTO-DEC-031 — Octopus ships as core, not a plugin

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Octopus lives in `src/octo/` in the OpenClaw core, gated behind the `octo.enabled` feature flag. It is not a plugin.
**Reason:** Adapter layer has deep cross-cutting dependencies on the subagent and ACP runtimes that already live in core. Plugin APIs are a younger, more actively evolving surface — building on them would _increase_ upstream coupling risk, not decrease it. The feature flag gives us plugin-like isolation without the API risk.
**Implications:** Future decision point: after Milestone 5, reassess whether the plugin API has matured enough to move Octopus there without changing its user surface.

---

## OCTO-DEC-032 — Thread-to-arm attach uses agent handler state, not bindings

**Date:** 2026-04-09
**Status:** accepted
**Decision:** `/octo attach <arm_id>` stores a thread→arm_id mapping in the agent's message handler state, not in the channel bindings system. Subsequent messages in the attached thread are intercepted by the agent handler and dispatched to the arm via `octo.arm.send`.
**Reason:** Channel bindings are a complex, actively evolving OpenClaw surface. Touching it increases upstream coupling and would force us to ride every bindings change. Handler-state threading is local to our agent message handling and does not touch the bindings layer at all.
**Implications:** Thread attach persists only while the agent is running; a handler restart drops active thread-arm maps unless the map is persisted. For MVP, the map is persisted to `~/.openclaw/octo/thread-arms.jsonl` and replayed on agent start. This is a small, self-owned piece of state with no upstream dependency.

---

## OCTO-DEC-033 — Every OpenClaw surface touchpoint goes through a single bridge file

**Date:** 2026-04-09
**Status:** accepted
**Decision:** All Octopus code that reaches into OpenClaw internals (subagent runtime, ACP runtime, task ledger, skills loader, memory backends, persona files, presence layer, Task Flow, hello-ok.features, etc.) is funneled through bridge files in `src/octo/adapters/openclaw/`. The rest of Octopus talks to these bridges via stable internal interfaces. Each bridge carries a header comment documenting what it wraps, which OpenClaw version(s) tested, what is assumed stable, what is reached-around, and the rollback plan if upstream changes.
**Reason:** Upstream drift is inevitable; the `clawflow` → `taskflow` rename is a concrete example found during this pass. Centralizing the exposure surface means one file changes per upstream move instead of cascading through the codebase. Headers preserve the "why" so future maintainers don't have to re-derive it.
**Implications:** PR review rule: any code outside `src/octo/adapters/openclaw/` that imports from OpenClaw internals is rejected. Enforced by lint rule + CI check in Milestone 0.

---

## OCTO-DEC-034 — Octopus declares a minimum OpenClaw version and maintains a compatibility matrix

**Date:** 2026-04-09
**Status:** accepted
**Decision:** Every Octopus release pins a minimum supported OpenClaw version. At runtime, Octopus probes the OpenClaw version (via `hello-ok.protocol` or a version helper) and refuses to enable if below the floor, logging a clear error. A `COMPATIBILITY.md` file tracks tested combinations and maintenance commitments.
**Reason:** Silent degradation against unsupported upstream versions is a recipe for on-call pages. Explicit floors plus integration tests that run against each supported OpenClaw version give operators certainty and give the project a controlled upgrade cadence.
**Implications:** CI lane runs against every supported OpenClaw version on every Octopus PR. Major OpenClaw version bumps are a gating consideration for Octopus releases.

---

## OCTO-DEC-035 — Required upstream changes are additive registrations, never forks

**Date:** 2026-04-09
**Status:** accepted
**Decision:** The set of changes Octopus needs in OpenClaw core (listed in INTEGRATION.md §Required Upstream Changes) are all registration points: method list, feature advertisement, pairing capabilities, slash command dispatch, cron job type, Task Flow step type, hook handler, config key, CLI dispatch, tool registration. None modify existing behavior. Each is individually PR-able upstream. If a required change cannot land upstream, that is a project-level go/no-go signal — never a reason to fork or patch-on-install.
**Reason:** Forking or patch-on-install creates unbounded long-term maintenance cost and makes Octopus a second-class citizen of its own host platform.
**Implications:** Milestone 0 includes preparing the first set of upstream-able PR drafts as part of the architecture review. If any proposed change is rejected upstream, Milestone 1 does not start until a path forward is found.

---

## OCTO-DEC-036 — PTY/tmux and cli_exec are primary for external agentic coding tools; ACP is opt-in, not default

**Date:** 2026-04-09
**Status:** accepted
**Clarifies / partially supersedes:** OCTO-DEC-004, OCTO-DEC-009, OCTO-DEC-015 — the ACP-leaning framing in those decisions was a misread of the original project intent. ACP remains a legitimate runtime that Octopus supports, but it is not the preferred path to Claude Code, Codex, Gemini CLI, Cursor, Copilot, or any other external agentic coding tool.

**Decision:** For every external agentic coding tool, the default invocation path is **user-equivalent** — either (a) spawning the tool as a subprocess with its own structured CLI output mode (`cli_exec`; e.g. `claude -p --output-format stream-json`, `codex exec --json`) or (b) driving the tool's interactive TUI through a PTY inside a tmux session (`pty_tmux`). ACP via the `acpx` plugin remains in the adapter layer but is demoted from "preferred" to "opt-in" — users who explicitly want ACP for a specific mission can select it in the ArmSpec, but it is never chosen automatically by the scheduler or the agent decision guide.

**Reason:**

1. **Policy and ToS clarity.** Every major agentic coding tool is shipped and licensed as a developer CLI. A human-equivalent invocation (running the CLI the way a developer would) is squarely within the intended use model of each tool. A programmatic protocol that bypasses the user-facing surface and wraps the tool via ACP is in a less well-defined policy space and may be subject to tightening over time. PTY/tmux and `cli_exec` are the durable, policy-safe path. ACP is not.
2. **Original project intent.** The genesis of Octopus was explicitly to **not** rely on ACP as the center of gravity. The HLD's terminal-first posture, the PRD's ACP non-goal, and the recommendation's "no ACP dependence" principle all point to this. An earlier draft of the INTEGRATION.md Consolidator section inverted this by framing ACP as the default multi-harness path; this decision corrects the framing.
3. **Tool-agnosticism.** `cli_exec` and `pty_tmux` work for any tool with a CLI, regardless of whether the vendor ships ACP support. Pluggability does not depend on any particular protocol ecosystem.
4. **Durability.** Terminal CLIs are stable, long-lived surfaces with contracts that vendors break only reluctantly. Structured protocols including ACP are younger, more actively evolving, and more prone to breakage under the caller's feet.
5. **Reattachability.** `pty_tmux` arms can be attached to by a human operator via `/octo attach <arm_id>`, dropping directly into the tmux pane. This is the full terminal-first supervision story the PRD committed to.

**Implications:**

- The adapter layer's preference order for external agentic coding tools is: `cli_exec` → `pty_tmux` → `structured_acp` (only on explicit opt-in).
- `structured_subagent` remains primary for work that fits OpenClaw's own native runtime (OpenClaw calling its model provider under its own API terms — this is orthogonal to the external-tool question).
- Cost metadata: `cli_exec` gets clean token counts from structured output streams when the tool provides them; `pty_tmux` falls back to the time-based proxy in CONFIG.md (`ptyHourlyRateProxyUsd`) with cost marked as approximate.
- Output parsing: `cli_exec` uses structured events from the tool's output mode; `pty_tmux` treats output as opaque bytes and relies on exit codes + worktree diff inspection for success/failure.
- LLD §Structured adapter mapping must be updated to add the `CliExecAdapter` section and reframe the `AcpAdapter` as "available, not default."
- INTEGRATION.md Consolidator section is rewritten this turn to reflect the corrected hierarchy.
- TASKS.md M1-10 through M1-13 (PTY/tmux work) remain first priority for Milestone 1. When M2 tasks are appended after M1 exit, the adapter lane additions will include `CliExecAdapter` as a first-class adapter alongside `PtyTmuxAdapter`, with `AcpAdapter` present but explicitly marked as opt-in.

**What this does NOT change:**

- Native subagent runtime is still first-class and primary for OpenClaw-owned model work.
- ACP is not removed; it is demoted. Users can still invoke `structured_acp` arms explicitly when they want to.
- The broader architecture (Head, mission graph, claims, budgets, recovery, operator surfaces) is unaffected — only the adapter layer's preference order changes.

---

## OCTO-DEC-037 — Add `cli_exec` as a fourth adapter type distinct from `pty_tmux` and `structured_subagent`

**Date:** 2026-04-09
**Status:** accepted
**Depends on:** OCTO-DEC-036

**Decision:** The `adapter_type` enum gains a new value `cli_exec` for tools that are invoked as subprocesses with their own structured CLI output mode. Enum becomes: `structured_subagent`, `cli_exec`, `pty_tmux`, `structured_acp`. The `cli_exec` adapter is distinct from `pty_tmux` because it does not require a PTY or tmux session — it is a direct `spawn()` with stdin/stdout capture, consuming the tool's own structured output format.

**Reason:** The two mechanisms for driving an external agentic coding tool "the way a user would" have genuinely different runtime shapes:

- **`cli_exec`** — tool has a structured output CLI mode (`--output-format stream-json`, `exec --json`, etc.). Launch is one-shot or streaming subprocess. Output is parseable events. No terminal emulator needed. Cleaner, simpler, more efficient when available.
- **`pty_tmux`** — tool only has an interactive TUI. Launch requires a PTY (so the tool thinks it's talking to a real terminal) inside a tmux session (for durability and reattachment). Output is raw terminal bytes that require pattern matching or heuristic parsing. Input requires understanding the tool's TUI expectations.

Conflating these into a single adapter would either waste resources (running a PTY/tmux when a subprocess would do) or under-supervise (missing the durability and reattachment benefits of tmux when a tool needs them). Keeping them as separate adapter types lets the mission spec be explicit about what shape of operation is expected.

**Implications:**

- LLD §Core Domain Objects §ArmRecord `adapter_type` enum expands to include `cli_exec`
- LLD §Runtime Adapter Interfaces grows a new `CliExecAdapter` subsection describing the `spawn`, `stream`, `send`, `checkpoint`, `terminate`, `health` surface for subprocess-based tools
- HLD §OpenClaw Integration Foundation `caps.octo.adapters` declaration includes `cli_exec` in the advertised list
- CONFIG.md `octo.arm` section adds parameters relevant to `cli_exec` arms (subprocess timeout, stdout buffer size, structured-output-format hint)
- TASKS.md M2 (when appended) includes a dedicated task for `CliExecAdapter` separate from the PTY/tmux work

---

## OCTO-DEC-038 — `initial_input` duplication between ArmSpec top-level and cli_exec runtime_options: resolved

**Date:** 2026-04-09
**Status:** resolved (M2-08)
**Depends on:** OCTO-DEC-037

**Context:** During M0-01 self-review, the ArmSpec schema was found to carry `initial_input` in two places:

1. Top-level on ArmSpec: `initial_input?: string` — "optional first message/prompt/command"
2. Inside `CliExecRuntimeOptionsSchema`: `initial_input?: string` — same name, same type

The LLD has it in both places as well — LLD was the source of the ambiguity, and M0-01 faithfully propagated it into code. When both fields are set on a cli_exec ArmSpec, there is no documented precedence rule. The CliExecAdapter (M2 work) will have to make a judgment call with no architectural guidance.

**Original decision:** Defer resolution to M2. See git history for the full deferral text.

**Resolution (M2-08):** `ArmSpec.initial_input` (top-level) is the single canonical location for every adapter type. The `initial_input` field was removed from `CliExecRuntimeOptionsSchema`. This satisfies all three deferral constraints:

- Exactly one place: top-level `ArmSpec.initial_input`. No per-adapter override exists.
- Symmetric across adapters: every adapter reads `spec.initial_input`. For cli_exec, the adapter passes it via CLI args (e.g. `claude -p <initial_input>`) or via stdin through the `send()` method (M2-07). No adapter reads initial_input from runtime_options.
- Binding for GripSpec/MissionSpec: neither has an `initial_input` field today; if they gain one, it follows the same top-level-only pattern.

**Rationale:** The M2-05 CliExecAdapter implementation confirmed that `runtime_options` is the right place for adapter-specific mechanical concerns (command, args, stdinMode, structuredOutputFormat) while the initial prompt is a semantic concern that belongs at the ArmSpec level. The adapter does not need its own copy.

**Implications:**

- `CliExecRuntimeOptionsSchema.initial_input` removed from `src/octo/wire/schema.ts`
- TODO comment replaced with a resolved-reference comment
- Test fixture in `schema.test.ts` updated: `initial_input` moved to top-level ArmSpec
- Wire-schema change: specs that previously set `runtime_options.initial_input` on cli_exec arms must move the value to `ArmSpec.initial_input`. This is a breaking change under OCTO-DEC-018 but acceptable because no production consumers of the schema exist yet (pre-M3)

---

## OCTO-DEC-039 — Research-driven execution as a first-class system behavior

**Date:** 2026-04-09
**Status:** accepted
**Source:** `docs/octopus-orchestrator/research-driven-execution.md` (external research input)

**Decision:** Octopus treats research and synthesis as first-class stages of execution, not optional chat fluff. Missions carry an `execution_mode` field selecting one of five modes. Grip types gain a documented conventional vocabulary. The classifier that decides a mission's execution mode lives agent-side in the MVP, with a future option to add a Head-side classifier service. Scheduler routing by grip type is eventually consistent with the existing capability taxonomy.

**The five execution modes** (values of `MissionSpec.execution_mode`):

1. **`direct_execute`** — narrow, local, clearly specified tasks. The default when the field is absent. No research phase.
2. **`research_then_plan`** — outside context matters, but implementation is not yet approved. Research → synthesis → stop for operator review.
3. **`research_then_design_then_execute`** — architecture, systems, major feature work. Research → design → implementation.
4. **`compare_implementations`** — inspect existing solutions / forks / competitors / alternatives before choosing a path. Research → comparison memo → decision.
5. **`validate_prior_art_then_execute`** — a likely solution exists and the goal is to confirm fit before implementation. Research → validation → execute.

**Conventional grip types** (documented values of `GripSpec.type`, not an enforced enum):

- `research` — repo scan, external scan, doc lookup, benchmark collection
- `synthesis` — compress research outputs into a decision memo / brief
- `design` — produce architectural artifacts (PRD, HLD, LLD snippets, etc.)
- `implementation` — actual code edits, config changes, artifact production
- `validation` — test runs, benchmark execution, acceptance checks
- `comparison` — side-by-side evaluation of alternatives

These are **guidance**, not enforcement. Operators and agents can use arbitrary `type` values; the conventional set is the shared vocabulary we prefer for common grip shapes. See LLD §Research-Driven Execution Pipeline for how the six types compose into the five modes.

**Classifier location (MVP decision):** Agent-side. The agent that creates a mission runs the classifier in its own context — it already has the request, loaded project context, and LLM capability to make the judgment call. It populates `MissionSpec.execution_mode` and the mission graph before calling `octo.mission.create`. Octopus Head stores and enforces; it does not classify. This keeps the Head thin and avoids embedding classification logic in the control plane.

**Future classifier extension (post-M5):** Add an optional Head-side classifier service for scenarios where centralized consistency matters (shared missions, automation-triggered missions without an interactive agent). The agent-side path remains the default; the Head-side classifier is an override for specific use cases. This is deferred — no Head-side classifier work is scheduled in M0–M5.

**How the mode affects the mission graph:**
When a classifier chooses a non-`direct_execute` mode, it pre-populates the mission graph with grips of the appropriate types. Example for `research_then_design_then_execute`:

1. `type: research` grip — repo scan
2. `type: research` grip — external landscape scan (depends_on [1])
3. `type: synthesis` grip — synthesis memo (depends_on [1, 2])
4. `type: design` grip — PRD/HLD/LLD (depends_on [3])
5. `type: implementation` grips — actual work (depends_on [4])

The graph is constructed by the agent-side classifier and submitted as part of the MissionSpec. Octopus enforces the ordering via the existing `MissionGraphNode.depends_on` field. No new graph construction logic in Octopus.

**Research outputs as first-class artifacts:** Research grips produce ArtifactRecord entries per LLD §Core Domain Objects. Downstream grips consume them via `GripSpec.input_ref` pointing at the research artifact id. The existing ArtifactRecord shape already supports this — no schema changes needed.

**Scheduler routing by grip type:** The existing `GripSpec.desired_capabilities[]` field is the machine-readable routing mechanism. A research grip can request `runtime.subagent + net.internet + tool.gh`; an implementation grip can request `runtime.cli_exec + tool.git`. The scheduler routes by capability match. `type` is the human-readable label for operator filtering and template matching, NOT the primary routing key.

This means: scheduler routing is already expressible in the current architecture. No scheduler logic change required for MVP. In M4 (distributed scheduler) we may add a `type`-aware preference in the scoring function, but the hard filters remain capability-based.

**Dark Factory scope note:** The research document discusses Dark Factory as a pre-dispatch manufacturing system that classifies, gathers context, and dispatches into Octopus. Dark Factory is **out of scope for Octopus M0–M5**. Octopus accepts classified missions from any source (agent, Dark Factory, operator, cron); it does not care who classified them. Dark Factory's shape and implementation are tracked separately.

**What this does NOT change:**

- ArmSpec is unchanged — arms run grips, not missions; execution mode is a mission-level concern
- GripSpec is structurally unchanged — `type` was already free-form NonEmptyString
- WS method schemas are unchanged — spawn carries ArmSpec, not MissionSpec
- The existing M0-01, M0-02, M0-03, M0-04 code does not need rework
- ArtifactRecord shape is unchanged — research outputs fit cleanly as artifacts
- The existing scheduler capability-taxonomy routing is unchanged

**What this does change (concretely):**

- MissionSpec gains an optional `execution_mode: MissionExecutionModeSchema` field
- LLD gains §Research-Driven Execution Pipeline section documenting the five modes, the six conventional grip types, and the pre-templated graph shapes
- PRD gains Product Principle #9 "Research-driven execution for high-leverage tasks"
- HLD gains a §Execution Modes and Research-Driven Dispatch section
- CONFIG gains an `octo.classifier` block stub (default mode, task class hints)
- INTEGRATION mentions `execution_mode` in the `octo_mission_create` agent tool reference
- TASKS.md gains a new task **M0-04.1** for the MissionSpec field + tests follow-up
- M0-26 milestone exit review acceptance extends to verify the principle is captured

**Implications for Milestone 3+ (mission graph work):** When the mission graph service is implemented (currently planned in M3), it must honor the `depends_on` ordering that a classifier-populated graph expresses. No new graph logic is needed — the existing Kahn's algorithm cycle check and topological execution already handle it.

**Implications for Milestone 4+ (distributed scheduler):** When the scheduler is implemented, it may gain a soft preference for routing research grips to habitats with `net.internet` capability and implementation grips to habitats with `fs.shared_workspace` capability. This is a scoring-function refinement, not a new mechanism.

**Reason:** The research document's thesis — agents do worse when they code before they understand — matches observed failure modes in agentic coding systems. Making research explicitly first-class (rather than optional best-effort habit) changes the incentive structure: agents classify, research, synthesize, then implement, because the mission spec literally requires it when the classifier picks a research-first mode. This is policy-driven behavior, not guidance.

The fit with the existing architecture is unusually clean — no structural rework, all additive refinement. This is a signal that the research concept is a natural extension, not a retrofit.

**Risk:** the classifier is a judgment call. An agent that wrongly classifies a simple task as architecture-level wastes cycles on unnecessary research; one that wrongly classifies an architecture task as `direct_execute` produces shallow implementations. Mitigation: the classifier is agent-side, so it benefits from the LLM's context and can self-correct on re-reads. We also ship explicit task class hints in CONFIG.md (`research-first: ["architecture", "optimization", ...]`) to anchor the classifier's decisions.

---

## OCTO-DEC-040 — OCTO-DEC-033 enforcement uses a bespoke node check script, not ESLint

**Date:** 2026-04-09
**Status:** accepted
**Refines:** OCTO-DEC-033 (bridge-file isolation enforcement clause)

**Decision:** The lint rule required by OCTO-DEC-033 ("PR review rule: any code outside `src/octo/adapters/openclaw/` that imports from OpenClaw internals is rejected. Enforced by lint rule + CI check in Milestone 0") is implemented as a **bespoke node check script** at `scripts/check-octo-upstream-imports.mjs`, NOT as an ESLint `no-restricted-imports` rule.

**Reason:** Upstream OpenClaw uses `oxlint` exclusively, not ESLint. There is no `.eslintrc*` at the repo root; `package.json` wires `"lint": "node scripts/run-oxlint.mjs"`; oxlint is listed in devDependencies. Oxlint is a high-performance subset of ESLint rules and does not support the configurability needed to express "this import path is only allowed from files under this directory." Adding ESLint as a second linter alongside oxlint just to enforce one rule would:

1. Double the lint infrastructure (two configs, two runners, two CI steps, two sets of false positives).
2. Create a lint tooling split that the rest of the repo doesn't pay for.
3. Fight the repo's existing style — the repo already uses bespoke node scripts for specialized checks (`scripts/run-oxlint.mjs`, `scripts/check-pairing-account-scope.mjs`, etc.).

A bespoke node script is cheaper, matches existing patterns, and is strictly more flexible: we can evolve the rule set (e.g., add exceptions, special-case test fixtures) without fighting a linter's rule configuration.

**Implementation:**

- `scripts/check-octo-upstream-imports.mjs` — walks `src/octo/**/*.ts`, parses each file's import statements via a regex pass (sufficient for TypeScript imports, no AST overhead), and flags violations. Exits non-zero with a clear error listing offending files and their forbidden imports.
- **Rule:** for any file NOT under `src/octo/adapters/openclaw/**`, reject:
  - Relative imports (`../` or `./`) that escape the `src/octo/` directory when resolved.
  - Any import naming OpenClaw internal modules the bridges are meant to wrap (a deny-list of prefixes, or the complement of the allow-list of `src/octo/**` paths resolved).
- Files under `src/octo/adapters/openclaw/**` are the whitelist exemption — bridges are explicitly allowed to import from upstream internals.
- Test fixtures live at `src/octo/test-fixtures/bad-import.ts.fixture` (outside adapters/openclaw/ — should be flagged) and `src/octo/adapters/openclaw/test-fixtures/ok-import.ts.fixture` (inside adapters/openclaw/ — should be allowed). `.fixture` extension prevents oxlint and TypeScript from parsing them as real source.
- A vitest unit test at `scripts/check-octo-upstream-imports.test.mjs` invokes the checker against the fixtures and asserts correct exit codes.

**CI integration (M0-13):** Runs the checker on every PR touching `src/octo/**`. Failure blocks the PR.

**Implications:**

1. The ESLint config files originally specified in M0-12's blast radius (`.eslintrc.octo.js`, `src/octo/.eslintrc.js`) are NOT created. The task's blast radius is effectively:
   - `scripts/check-octo-upstream-imports.mjs`
   - `scripts/check-octo-upstream-imports.test.mjs`
   - `src/octo/test-fixtures/bad-import.ts.fixture`
   - `src/octo/adapters/openclaw/test-fixtures/ok-import.ts.fixture`
   - narrow additive update to `.oxlintrc.json` ignorePatterns to exclude `*.fixture`
2. TASKS.md M0-12 verify step (`node docs/octopus-orchestrator/scripts/octo-ralph/verify-m0-12.sh`) is replaced by `node scripts/check-octo-upstream-imports.mjs && npx vitest run scripts/check-octo-upstream-imports.test.mjs`. TASKS.md should be updated with the new verify command when M0-12 lands.
3. Future linters considered: if OpenClaw upstream migrates to ESLint or adds a plugin layer, this script can be re-expressed as a native lint rule without changing its semantics. The rule lives in one place; the enforcement mechanism is swappable.

---

## OCTO-DEC-041 — Ambiguous duplicate-execution resolution policy

**Date:** 2026-04-09
**Status:** accepted
**Finalizes:** LLD §Recovery Flows #5 seed design (line 1088)
**Resolves Open Question:** #3 (Ambiguous-duplicate resolution UX)

**Decision:** When a `grip.ambiguous` event fires (two arms may have executed the same grip), the system applies a three-tier resolution policy based on grip classification:

1. **Read-only grips (`read_only: true`).** Deterministic auto-resolution: select the result from the arm with the lexicographically lowest `arm_id`. No operator intervention required. Both transcripts are preserved as artifacts; the non-selected transcript is marked `resolution: "auto-discarded"`.
2. **Non-read-only, non-side-effecting grips (`read_only: false, side_effecting: false`).** Operator-reviewed resolution: the Head surfaces both results via `openclaw octo grip show --ambiguous <grip_id>`, which renders a unified diff of the two outputs. The operator selects one result or provides a manual merge. Resolution blocks downstream grip dispatch until the operator acts.
3. **Side-effecting grips (`side_effecting: true`).** Operator-only resolution with alert: no automated or semi-automated selection path exists. The Head emits an `octo.alert.ambiguous_side_effect` notification through the existing OpenClaw notification path (Gateway push to operator surfaces). Both arms are suspended pending operator inspection. The operator must explicitly choose a result and acknowledge potential external side effects before the grip can transition out of quarantine.

**Data model — quarantined artifacts:**

Each ambiguous grip produces a `QuarantineRecord` stored in the control-plane event log:

```
QuarantineRecord {
  grip_id:         string
  quarantine_id:   string          // unique id for this quarantine event
  arm_ids:         [string, string] // both contending arm ids, preserved
  grip_class:      "read_only" | "non_side_effecting" | "side_effecting"
  results:         [ArmResult, ArmResult] // full outputs from both arms
  created_at:      ISO 8601
  resolved_at:     ISO 8601 | null
  resolved_by:     "auto" | operator_id
  resolution:      "arm_selected" | "manual_merge" | null
  selected_arm_id: string | null
}
```

Both arm results are retained in the artifact store regardless of resolution outcome. The non-selected result is never deleted; it is tagged `quarantine_disposition: "discarded"` for auditability.

**Operator review surface:**

- `openclaw octo grip show --ambiguous` — lists all unresolved quarantined grips.
- `openclaw octo grip show --ambiguous <grip_id>` — renders side-by-side or unified diff of the two arm results.
- `openclaw octo grip resolve <grip_id> --select <arm_id>` — resolves by selecting one arm's result.
- `openclaw octo grip resolve <grip_id> --merge` — opens an interactive merge editor (tier 2 and 3 only).

**Events emitted on resolution:**

- `grip.ambiguous.resolved` — payload includes `quarantine_id`, `grip_id`, `resolution` method, `selected_arm_id`, and `resolved_by`.
- For tier 1 (auto-resolved): emitted immediately and automatically; no operator event.
- For tiers 2 and 3: emitted only after operator action.

**Implications for M3-12 implementation:**

1. M3-12 must implement the `QuarantineRecord` schema and persistence in the control-plane event log.
2. M3-12 must wire `grip.ambiguous` detection in the reconciliation path (LLD §Recovery Flows #4 partition-heal) to produce `QuarantineRecord` entries.
3. The `--ambiguous` flag on `openclaw octo grip show` and the `openclaw octo grip resolve` subcommand are new CLI surfaces scoped to M3-12.
4. Tier 1 auto-resolution logic must be unit-tested with deterministic `arm_id` ordering to confirm lexicographic selection is stable.
5. The `octo.alert.ambiguous_side_effect` notification integration reuses the existing Gateway notification path; no new notification channel is introduced.

---

## OCTO-DEC-042 — Postgres migration deferred through M5

**Date:** 2026-04-09
**Status:** accepted
**Evaluates:** LLD §Postgres migration trigger (line 1227)

**Decision:** All three named Postgres migration triggers evaluated against M4 actual state; none are met.

1. **Multi-head HA needed** — NOT triggered. Single Gateway process, single Head; no replication requirement.
2. **Concurrent writers > 50** — NOT triggered. M4 peak concurrent nodes is ~10–20.
3. **Event log volume exceeded** — NOT triggered. JSONL append with retention policy is adequate at M4 volumes.

SQLite remains the storage backend through M5. Reevaluate if Phase 6 introduces multi-head HA.

---

## Remaining Open Design Questions

These are not yet decided and are tracked here to prevent silent drift.

1. **Multi-head HA.** Does Phase 4 require HA heads, or is single-head + state-plane failover sufficient through Phase 6? Decision target: Milestone 4 planning.
2. **Cross-habitat artifact sync.** Filesystem-shadowed vs object-store vs pull-on-demand. Decision target: Milestone 4 planning.
3. ~~**Ambiguous-duplicate resolution UX.**~~ Resolved by OCTO-DEC-041.
4. **Warm arm pools.** Pool sizing, reuse semantics, and policy boundaries. Decision target: Milestone 6 planning.
