---
summary: "Roadmap for replayable execution graphs, memory stratification, critic gates, evaluation harnesses, and safe self-improvement"
read_when:
  - Planning autonomy or multi-agent execution work
  - Deciding what ships in wave-1 versus later wave-2 work
  - Adding memory, critic, evaluation, or self-improvement loops
owner: "openclaw"
status: "draft"
last_updated: "2026-03-11"
title: "Autonomy Upgrade Roadmap"
---

# Autonomy Upgrade Roadmap

## Overview

This plan captures the autonomy-upgrade direction for OpenClaw as a sequence of
safe, reviewable deliveries instead of one large “autonomous agent” feature.

The goal is not to maximize independence first.
The goal is to make autonomous behavior:

- replayable
- inspectable
- interruptible
- attributable
- cost-bounded
- safe to expand over time

Wave-1 ships the minimum substrate required to trust later autonomy work:

- replayable execution graphs
- critic gates
- failure taxonomy
- procedural playbook memory
- deterministic evaluation bundles

Wave-2 builds on that substrate with deeper planning, simulation, self-calibration,
and parallel research lanes.

## Why this needs a roadmap

OpenClaw already has many of the primitives autonomy systems need, but they are
still spread across separate subsystems:

- routing and binding plans such as [ACP Thread Bound Agents](/experiments/plans/acp-thread-bound-agents)
- memory research such as [Workspace Memory Research](/experiments/research/memory)
- loop and repetition protection in [Tool-loop detection](/tools/loop-detection)
- early procedural recovery in `src/cron/procedural-playbook-memory-v0.ts`

Without an explicit roadmap, future autonomy features can drift into:

- non-replayable side effects
- opaque critic verdicts
- memory writes without provenance
- safety gates that exist only in prompts
- self-improvement loops that optimize for activity instead of outcomes

## North-star model

The long-term system should look like a controlled execution loop:

1. A planner turns an objective into a typed execution graph.
2. Each graph node runs inside an explicit lane:
   - research
   - execution
   - critic
   - evaluation
3. Every node emits structured artifacts:
   - inputs
   - outputs
   - tool calls
   - costs
   - timing
   - verdicts
4. Critics can block, downgrade, reroute, or request human approval.
5. Evaluation summarizes what actually happened, not what the agent claimed.
6. Memory layers retain only evidence-backed artifacts:
   - procedural playbooks
   - failure clusters
   - reusable strategy fragments
   - calibrated expectations

The system should behave more like an auditable workflow engine than a free-form
chat loop with extra prompts.

## Non-negotiable invariants

All autonomy work in this roadmap should preserve these invariants:

- Every autonomous run has a stable run id plus a replayable event log.
- Every critic verdict is tied to specific evidence, not only generated prose.
- Every high-impact action has an explicit stop path:
  - kill switch
  - retry policy
  - operator-visible failure reason
- Research lanes and execution lanes are separable and logged independently.
- Costs and latency are measured per node, not inferred after the fact.
- Memory writes are append-only or versioned, with provenance back to the run.
- Self-improvement is gated by evaluation artifacts, not just successful completion.
- No autonomous upgrade should silently widen permissions or tool reach.

## Existing foundation to reuse

The roadmap should extend current OpenClaw foundations instead of replacing them.

### Loop and stall protection

- [Tool-loop detection](/tools/loop-detection)
- `src/agents/tool-loop-detection.ts`

This already provides warning and critical thresholds plus a global circuit breaker.
It is the first runtime-level evidence that autonomous loops need explicit guardrails.

### Procedural playbook memory

- `src/cron/procedural-playbook-memory-v0.ts`
- `src/cron/service.playbook-memory-v0.test.ts`

This is the first concrete memory layer for “safe defaults from prior failures”.
It should become one input to the broader autonomy memory stack, not a dead-end sidecar.

### Offline memory research

- [Workspace Memory Research](/experiments/research/memory)

This provides the right memory posture:

- Markdown or human-readable source of truth
- derived index for retrieval
- retain / recall / reflect
- confidence-bearing opinions

### Thread-bound execution substrate

- [ACP Thread Bound Agents](/experiments/plans/acp-thread-bound-agents)

This already describes the control-plane approach OpenClaw should use for persistent,
thread-bound, replayable agent work. The autonomy graph should reuse those lifecycle
and persistence principles.

## Wave-1: trust substrate first

Wave-1 should be treated as mandatory before shipping deeper autonomous planning.

### 1. Replayable execution graph and checkpoints

Goal:

- replace implicit “agent loop state” with typed graph nodes and explicit checkpoints

Needed behaviors:

- node-level inputs and outputs
- deterministic edge transitions
- resumable checkpoints
- per-node timing and cost accounting
- operator-readable run summaries

Why first:

- every later feature depends on trustworthy replay and attribution

### 2. Failure taxonomy and decision reasons

Goal:

- normalize why autonomous work failed, degraded, retried, or escalated

At minimum the taxonomy should distinguish:

- planner failure
- tool contract failure
- runtime failure
- timeout
- low-confidence output
- loop / stall
- critic rejection
- human-approval required
- cost-budget exceeded
- policy violation

Why first:

- critics, playbooks, and calibration all need consistent failure labels

### 3. Procedural playbook memory

Goal:

- keep the current “safe default from prior failures” work as the canonical first memory layer for autonomy recovery

Required properties:

- evidence-backed entries
- bounded, actionable recovery steps
- clear signatureing for recurring failures
- compatibility with broader memory indexing later

Why first:

- it turns repeated failure into reusable operator-grade guidance

### 4. Critic mode with kill-switch policy

Goal:

- make critique an execution gate, not only a prompt pattern

Required critic artifacts:

- verdict: pass / warn / block / human-review
- reasons with evidence pointers
- severity
- suggested mitigation
- stop/continue recommendation

Kill-switch policy should be able to stop or downgrade runs for:

- repeated loop/stall evidence
- repeated critic blocks on the same objective
- policy boundary violations
- cost overrun
- missing required approvals

### 5. Evaluation bundle

Goal:

- every autonomous run should end with a compact evaluation artifact that can be replayed and compared

Bundle contents:

- objective
- execution graph summary
- node outcomes
- critic interventions
- failures and retries
- cost and latency
- final outcome
- “should this pattern be retained?” recommendation

## Wave-1 exit criteria

Wave-1 should be considered complete only when:

- a run can be replayed from stored graph/checkpoint artifacts
- loop/stall events and critic blocks are observable in one timeline
- failure taxonomy is consistent across planner, tool, runtime, and critic paths
- procedural playbook memory is populated from real failures, not hand-authored only
- evaluation bundles can compare at least two runs of the same objective
- the system can fail closed with a visible reason

## Wave-2: capability expansion on top of the substrate

Wave-2 tasks should be delivered on top of the wave-1 substrate, not in parallel with it.

### Trading-safe simulation lane

Backlog title:

- `OpenClaw wave-2: trading-safe simulation lane (replay/backtest + decision logs)`

Purpose:

- give research-style or strategy-style autonomous work a strict non-live lane with immutable decision logs and explicit assumptions

Depends on:

- replayable execution graph
- evaluation bundle
- failure taxonomy

### MCP/tool interoperability conformance harness

Backlog title:

- `OpenClaw wave-2: MCP/tool interoperability conformance harness`

Purpose:

- validate tool contracts, adapters, timeouts, and error handling against repeatable fixtures

Depends on:

- failure taxonomy
- execution logs
- evaluation harness

### Risk-tiered human approval checkpoints

Backlog title:

- `OpenClaw wave-2: risk-tiered human-approval checkpoints (HITL)`

Purpose:

- route sensitive graph nodes to explicit approval gates based on risk class

Depends on:

- critic verdicts
- failure taxonomy
- operator-visible graph state

### Observability and trace spans

Backlog title:

- `OpenClaw wave-2: observability + trace spans for agent loop stages`

Purpose:

- make planner, executor, critic, evaluator, and memory writes visible as one traceable flow

Depends on:

- execution graph as source of span boundaries

### Split Research Brain versus Execution Brain

Backlog title:

- `OpenClaw wave-2: split Research Brain vs Execution Brain with guardrails`

Purpose:

- separate speculative exploration from permissioned execution

Depends on:

- simulation lane
- HITL checkpoints
- critic gate

### Rolling playbook evolution

Backlog title:

- `OpenClaw wave-2: rolling playbook evolution with weighted selection`

Purpose:

- evolve playbooks from evidence, not ad-hoc prompt edits

Depends on:

- procedural playbook memory
- evaluation bundle
- failure taxonomy

### Self-calibration loop

Backlog title:

- `OpenClaw wave-2: self-calibration loop (predicted vs realized performance)`

Purpose:

- compare planner/critic expectations with actual outcomes and update confidence

Depends on:

- trace spans
- evaluation bundle
- retained outcome artifacts

### Async task-graph orchestrator

Backlog title:

- `OpenClaw wave-2: async task-graph orchestrator for parallel research lanes`

Purpose:

- allow parallel subgraphs without losing replayability or operator control

Depends on:

- execution graph and checkpoints
- critic gate
- observability

### Autonomous hypothesis generator

Backlog title:

- `OpenClaw wave-2: autonomous hypothesis generator from failure clusters`

Purpose:

- turn repeated failures into candidate experiments instead of only retries

Depends on:

- failure clustering
- evaluation bundle
- simulation lane

### Temporal credit assignment logging via ablation

Backlog title:

- `OpenClaw wave-2: temporal credit assignment logging via ablation`

Purpose:

- understand which nodes, prompts, or tools actually improved outcomes

Depends on:

- replayable graphs
- trace spans
- evaluation harness

### Execution sandbox templates and import allowlist validator

Backlog title:

- `OpenClaw wave-2: execution sandbox templates + import allowlist validator`

Purpose:

- bound experimental execution lanes to known-safe tool/runtime envelopes

Depends on:

- simulation lane
- HITL
- failure taxonomy

### Compute-budget-aware planner and ROI objective

Backlog title:

- `OpenClaw wave-2: compute-budget-aware planner + ROI objective`

Purpose:

- optimize for useful work under explicit cost and latency budgets

Depends on:

- per-node cost accounting
- evaluation bundle
- trace spans

### Strategy genome store and mutation primitives

Backlog title:

- `OpenClaw wave-2: strategy genome store + mutation primitives`

Purpose:

- store reusable plan fragments and mutate them under controlled evaluation loops

Depends on:

- simulation lane
- hypothesis generation
- credit assignment

### Tool reliability wrappers, cost routing, and self-improvement loops

Backlog title:

- `OpenClaw wave-2 backlog: tool reliability wrappers + cost routing + self-improvement loops`

Purpose:

- tie the whole system together with robust wrappers and cost-aware runtime selection

Depends on:

- nearly everything above

This should be treated as an integration tranche, not an entry point.

## Recommended delivery order

Recommended order after the current in-flight autonomy work:

1. Replayable execution graph + checkpoints
2. Failure taxonomy
3. Critic gate + kill-switch policy
4. Evaluation bundle
5. Observability + trace spans
6. HITL checkpoints
7. MCP/tool conformance harness
8. Simulation lane
9. Research Brain versus Execution Brain
10. Rolling playbook evolution + self-calibration
11. Async task-graph + hypothesis generation + credit assignment
12. Budget-aware planner + genome store + broader self-improvement loops

## What should not ship early

The following should not ship before the wave-1 substrate exists:

- autonomous retries that mutate plans without replay artifacts
- memory writes that are not attributable to a run
- self-improvement loops that only score “task completed”
- parallel multi-agent research without checkpointed execution graphs
- execution-policy widening without critic and approval gates

## Validation model

Each roadmap stage should add its own validation artifacts.

### For execution graph work

- deterministic replay test
- resume-from-checkpoint test
- duplicate-suppression test

### For critic work

- critic evidence artifact test
- block / warn / pass routing tests
- kill-switch escalation tests

### For memory work

- provenance checks
- repeated-failure compaction tests
- retrieval quality spot checks using known incidents

### For evaluation and calibration work

- two-run comparison fixtures
- predicted versus realized delta reports
- retained-artifact correctness checks

## Open questions

- Should graph state live entirely in gateway persistence first, or should there be a dedicated autonomy store from day one?
- Should critics run as peer nodes in the graph or as graph-level supervisors with override authority?
- How much of procedural playbook memory should stay cron-specific before it is generalized?
- Which autonomy artifacts belong in user-visible docs versus operator-only internals?

## Recommendation

Treat the current critic, loop-detection, and procedural-playbook efforts as the start of a broader autonomy substrate, not isolated features.

The next best use of engineering time is not “more intelligence”.
It is finishing the replay, critic, failure-taxonomy, and evaluation foundations so later autonomy work has something stable to stand on.
