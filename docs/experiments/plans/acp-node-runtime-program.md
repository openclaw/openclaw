---
summary: "Single source-of-truth program plan for delivering the ACP node-backed runtime: end goal, architecture references, phased implementation, verification gates, cleanup, and end-to-end test path across jorgebot + vm1"
read_when:
  - Orchestrating ACP node-backed runtime work across jorgebot and vm1
  - Spawning agent-harness agents to implement the feature
  - Reviewing what remains before the project is done
  - Preparing PR description/checklist and verification evidence
  - Coordinating end-to-end testing across gateway-on-jorgebot and node-worker-on-vm1
title: "ACP Node-Backed Runtime Program Plan"
---

# ACP Node-Backed Runtime Program Plan

## Purpose

This file is the **single top-level program tracker** for the ACP node-backed runtime effort.

It exists to answer, in one place:

- what we are building
- why we are building it this way
- which documents are authoritative
- what must be implemented
- what must be tested and verified
- what still needs cleanup or follow-up
- what “done” means before we consider the effort complete
- how development is split across **jorgebot** and **vm1**
- how the final end-to-end test environment should be assembled

This file is intended to be the primary handoff/orchestration document for agent-harness work on vm1 and the future PR description/checklist backbone.

## Project outcome we want

We want OpenClaw to support a first-class **node-backed ACP runtime backend** where:

- the **OpenClaw gateway** remains the durable authority for ACP session/run/event state
- a **node** hosts the ACP-capable runtime process and streams events back over the existing Gateway WebSocket
- nodes are **leased execution workers**, not mini-gateways
- the architecture preserves future ACP-level session mobility across nodes
- recovery, replay, terminal-result resolution, and stale-worker fencing are explicit and deterministic

In one sentence:

> **Gateway-owned ACP control plane, node-leased runtime execution, ACP-native worker transport over the existing node WebSocket.**

## Why this project exists

The prior `acp-remote` / external ACP gateway work established several important truths:

- durable replay/recovery matters
- a proper control-plane split is worth it
- transport/runtime execution should not be tightly coupled to user-facing ACP semantics

However, the long-term OpenClaw-native shape should align with the existing node system rather than living beside it as a separate remote trust/transport island.

That means:

- reuse node pairing/registry/policy/capability model
- keep gateway-owned ACP truth
- use nodes as execution substrate
- keep direct remote HTTP relays as inspiration/reference, not the final OpenClaw-native architecture for this effort

## Authoritative documents for this effort

## Primary docs

1. `docs/experiments/plans/acp-node-backed-runtime.md`
   - high-level architecture
   - ownership model
   - goals/non-goals
   - phased implementation

2. `docs/experiments/plans/acp-node-backed-runtime-protocol.md`
   - ACP-over-node worker protocol
   - leases, fencing, sequencing, terminal semantics

3. `docs/experiments/plans/acp-node-backed-runtime-verification.md`
   - verification contract
   - test matrix
   - failure scenarios that must be proven

## Existing related docs to learn from

4. `docs/experiments/plans/acp-thread-bound-agents.md`
   - prior ACP control-plane/store direction

5. Earlier remote ACP work and related notes
   - use as inspiration for durability, recovery, replay, and terminal resolution behavior
   - do **not** treat external remote gateway transport as the target architecture for this effort

## What is in scope

### In scope

- gateway-owned ACP durable store
- `acp-node` backend direction
- node capability/command additions for ACP worker support
- lease model and stale-worker fencing
- gateway-side canonical terminal-result resolution
- replay/checkpoint/recovery design
- headless node-host ACP worker implementation
- diagnostics / tests / end-to-end validation path

### Explicitly not required for first milestone

- solving workspace portability across nodes
- general multi-node balancing or speculative execution
- mobile app ACP worker support if headless node-host path lands first
- deprecating existing backends immediately

## Two-machine development model

This effort spans **two machines** and must be orchestrated with that in mind.

## jorgebot (this machine)

Role:

- orchestration brain
- writes/owns planning docs
- runs the dev OpenClaw gateway later during end-to-end validation
- remains the place where final gateway-side dev server orchestration happens
- dispatches coding agents through the agent-harness API

## vm1

Role:

- primary implementation environment for coding agents
- source checkout/worktree where changes are made
- headless node-host candidate for end-to-end testing
- execution environment for harness agents

## Operational rule

All implementation work for this project should happen in a **dedicated vm1 worktree** of the OpenClaw repo and through a **dedicated agent-harness project** pointing at that worktree.

## End-state testing topology

The intended end-to-end setup later is:

### On jorgebot

- run a dev OpenClaw gateway with the gateway-side ACP-node changes
- use the dev/test Discord channel for validation
- exercise the real gateway control plane locally here

### On vm1

- run the node-side/headless node-host ACP worker path
- connect vm1 to the jorgebot dev gateway as a node
- have vm1 act as the leased ACP execution worker

### Why this topology matters

It mirrors the intended real architecture:

- durable gateway truth on one machine
- runtime execution on another machine over node WS transport

This must influence implementation and test planning from the start.

## Delivery definition: what must be true before we are done

The project is not done until all of the following are true.

## Architecture and design

- [ ] The gateway-owned ACP control-plane direction is implemented, not just documented
- [ ] `acp-node` architecture is realized without turning nodes into mini-gateways
- [ ] Durable ACP store exists and is the source of truth for runs/events/checkpoints/leases
- [ ] `SessionEntry.acp` is compatibility/projection state only, not authoritative durable run state

## Runtime/backend integration

- [ ] A node-backed ACP backend exists and can be selected
- [ ] Gateway can acquire a node lease, ensure a session, start a turn, cancel, close, and get status
- [ ] A headless node-host can advertise ACP capability and execute the worker role
- [ ] Gateway projects worker events through normal ACP-facing paths

## Correctness and failure semantics

- [ ] Stale-worker fencing is enforced via lease epochs
- [ ] Duplicate worker events do not corrupt state or duplicate delivery
- [ ] Duplicate terminal events do not duplicate final delivery
- [ ] Cancel-vs-complete race resolves deterministically
- [ ] Gateway restart recovers durable ACP state correctly
- [ ] Node reconnect behaves correctly and does not allow stale worker wins

## Diagnostics and operability

- [ ] There is enough visibility to know which node is executing which ACP session/run
- [ ] Failure modes surface clearly to operators
- [ ] There is doctor/diagnostic coverage for the node-backed runtime path

## Verification

- [ ] The verification plan items are implemented and passing
- [ ] At least one real headless node-host end-to-end scenario passes
- [ ] Final evidence is assembled for PR/review

## Cleanup and polish

- [ ] Docs are updated and internally consistent
- [ ] Temporary scaffolding/fake paths not meant for final design are removed or clearly isolated
- [ ] Follow-up issues / deferred work are documented explicitly

## Architecture decisions already locked in

These are considered the current intended direction unless a later design review overturns them explicitly.

1. **TypeScript is the correct implementation language for this effort**
   - because this is core OpenClaw / gateway / node integration work
   - it should live naturally with the rest of OpenClaw instead of creating a sidecar in another language

2. **Use the earlier remote ACP gateway work as inspiration, not as the final transport architecture**
   - especially for durability, replay, checkpoints, terminal semantics, recovery, and failure modeling

3. **Gateway-owned truth is non-negotiable**
   - the node is not the durable authority for ACP

4. **Nodes are leased workers**
   - not mini-gateways and not permanent session owners

5. **Dedicated ACP store is required**
   - the current generic session JSON projection is insufficient as final durable source of truth for this effort

6. **ACP-native transport over node WS is required**
   - generic `system.run` may help prototypes, but is not the desired final architecture

7. **Workspace portability is deferred**
   - but the ACP/control-plane design must not make future mobility impossible

## Recommended implementation program

This is the recommended order of attack.

## Phase 0 — Repo/worktree/project setup

Deliverables:

- [ ] vm1 OpenClaw worktree created from latest `origin/main`
- [ ] planning docs copied/synced into vm1 worktree
- [ ] dedicated agent-harness project created for that vm1 worktree
- [ ] top-level program doc available inside the worktree

Acceptance:

- harness agents can work entirely from the vm1 worktree with full local access to the docs

## Phase 1 — Design consolidation and gap review

Deliverables:

- [ ] one agent reviews the architecture/program/protocol/verification docs for internal consistency
- [ ] one agent compares the plan against current OpenClaw ACP + node implementation seams and identifies exact code touchpoints
- [ ] one agent produces a concrete implementation map (files/modules/types to add/change)

Acceptance:

- no major ambiguity remains about where the work belongs
- exact initial implementation slice is identified

## Phase 2 — ACP durable store foundation

Deliverables:

- [ ] ACP store schema + migrations
- [ ] store interface and persistence layer
- [ ] recovery loaders
- [ ] compatibility projection wiring

Acceptance:

- ACP sessions/runs/events/checkpoints/leases survive restart and can be reloaded

## Phase 3 — Lease model and terminal resolution core

Deliverables:

- [ ] lease acquisition/replacement/release semantics
- [ ] lease epoch fencing
- [ ] canonical terminal resolution logic
- [ ] deterministic state transitions

Acceptance:

- stale workers cannot win
- duplicate terminals cannot duplicate delivery

## Phase 4 — Node ACP transport

Deliverables:

- [ ] ACP node capability/command additions
- [ ] gateway-side ACP node invoke/event handling
- [ ] protocol types and validation
- [ ] structured logging/diagnostics for ACP worker transport

Acceptance:

- gateway can speak the ACP worker protocol to a capable node safely

## Phase 5 — Headless node-host ACP worker

Deliverables:

- [ ] node-host ACP worker implementation
- [ ] local runtime adapter (likely around `acpx` initially)
- [ ] worker cancel/close/status/heartbeat

Acceptance:

- a real headless node host can act as the execution worker

## Phase 6 — `acp-node` backend integration

Deliverables:

- [ ] backend registration
- [ ] session/run flow integration with lease acquisition and event append
- [ ] projector/checkpoint integration

Acceptance:

- OpenClaw can actually run ACP through the node-backed backend end-to-end

## Phase 7 — Recovery/replay hardening

Deliverables:

- [ ] restart/reconnect recovery flows
- [ ] replay from checkpoints
- [ ] lost-node handling

Acceptance:

- failure scenarios behave deterministically under automated tests

## Phase 8 — End-to-end validation on jorgebot + vm1

Deliverables:

- [ ] dev OpenClaw gateway running on jorgebot with feature branch changes
- [ ] vm1 node-host connected as a node to the jorgebot dev gateway
- [ ] real ACP turn executed over node transport
- [ ] cancel/close/reconnect path exercised
- [ ] validation evidence recorded

Acceptance:

- the final target topology works, not just isolated local tests

## Required documentation artifacts before implementation completes

Before the coding wave is complete, we should have or update:

- [ ] architecture doc
- [ ] protocol doc
- [ ] verification plan
- [ ] this program plan
- [ ] PR description draft / checklist
- [ ] troubleshooting notes for node-backed ACP
- [ ] operator-facing config / diagnostics notes if new config is introduced

## Required verification artifacts before merge

Before merge/PR completion, we should have evidence for:

- [ ] ACP store unit tests
- [ ] lease/fencing unit tests
- [ ] fake-worker protocol integration tests
- [ ] terminal race tests
- [ ] restart/recovery tests
- [ ] headless node-host end-to-end test
- [ ] final summarized proof bundle in PR or doc form

## Cleanup checklist

These are easy to forget and should be tracked explicitly.

- [ ] remove or isolate any temporary compatibility shims that are only for bring-up
- [ ] ensure no final architecture depends on ad-hoc `system.run` ACP transport
- [ ] remove dead code from failed intermediate approaches
- [ ] reconcile docs with shipped names/paths/options
- [ ] ensure diagnostics and doctor output reference final architecture accurately
- [ ] capture deferred follow-ups separately instead of leaving TODO fog in implementation files

## Coding-agent orchestration strategy

This project should use the **agent-harness** on vm1 and follow the orchestrated wave model.

## Why use agent-harness here

Because this is a large, multi-phase TypeScript architecture/integration effort touching core OpenClaw semantics, and it needs:

- clean separation of research/planning/implementation/review/testing waves
- visible agent history in Discord callbacks
- work happening on vm1 close to the real coding environment
- repeatable iteration without burning this session’s context on source-level work

## Orchestration model to use

### Wave 1 — Design consistency + code touchpoint mapping

Use 2–3 agents in parallel:

1. **consistency reviewer**
   - review all program/architecture/protocol/verification docs together
   - flag contradictions, missing invariants, or confusing terminology

2. **code touchpoint mapper**
   - inspect OpenClaw ACP + node code on vm1
   - identify exact modules/files/types affected
   - produce a concrete implementation map

3. **test harness planner**
   - design the fake-worker + restart harness approach in concrete terms

### Wave 2 — Architecture integration plan

One agent synthesizes Wave 1 into:

- exact module boundaries
- recommended order of file-by-file implementation
- specific initial slice to implement first

### Wave 2.5 — Verification hardening

At least two agents:

1. verification-plan hardener
2. adversary trying to bypass the proposed checks

### Wave 3 — Implementation

Prefer one main implementing agent at a time for convergence-heavy code.

Potential exception:

- isolated store layer and isolated test harness work may run in parallel if boundaries are very clear

### Wave 4 — Review

Use adversarial review:

- builder defense
- adversary critique with file/line evidence
- judge

### Wave 5 — Tests

Separate test planning from test implementation/fixing.

### Wave 6 — End-to-end bring-up

Use a dedicated agent for the final vm1 node-host / jorgebot dev gateway validation plan and evidence gathering.

## Immediate next agent tasks recommended

These are the next harness tasks we should dispatch once the vm1 setup is ready.

1. **program-doc-audit**
   - read the four docs
   - produce an internal consistency audit and gaps list

2. **acp-node-touchpoint-map**
   - inspect current ACP + node code on vm1
   - produce exact files/modules/types to change

3. **acp-node-test-harness-plan**
   - design fake ACP worker + restart harness in concrete terms

Then:

4. **acp-node-implementation-plan**
   - synthesize the above into exact phased coding steps and recommended first implementation slice

## Definition of the first implementation slice

The first coding slice should be the smallest slice that proves the architecture is real rather than aspirational.

Recommended first slice:

- durable ACP store foundation
- lease epoch model
- fake ACP-capable node worker harness
- minimal gateway-side event append + stale-epoch rejection path

That slice gives us real proof that the hardest control-plane pieces are viable before we sink effort into a full runtime worker.

## PR-readiness expectations

By the time we open or finish a PR for this effort, it should contain:

- clear architecture summary
- explicit explanation of why gateway-owned ACP truth is the right design
- summary of node transport choices and why generic node events were insufficient by themselves
- explanation of lease/fencing model
- verification evidence with focus on replay/restart/race correctness
- explicit deferred items (workspace portability etc.)

## Deferred work to track separately

These are future items that should be tracked, but should not block the first serious delivery if the architecture remains compatible with them.

- cross-node workspace portability / shared workspace model
- richer node-selection policies and affinity
- non-headless node-client ACP worker support
- warm session migration optimizations
- advanced operator tooling for lease/node management

## Final program principle

> **This project is done only when the hard failure semantics are proven, not when the happy path streams once.**

That principle should guide all implementation, review, and merge decisions for this effort.
