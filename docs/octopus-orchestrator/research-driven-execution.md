# Research-Driven Execution for Octopus and Dark Factory

## Status

Draft v0.1

## Purpose

This document defines a new execution principle for the OpenClaw Octopus Orchestrator and related Dark Factory workflows:

**Do not default to immediate implementation when the task depends materially on outside knowledge, prior art, or domain-specific understanding.**

Instead, classify the task first and prepend a research and synthesis phase when that is likely to improve solution quality.

This document is intended as an update that can be handed directly to active implementation work so the system evolves with this concept in mind.

## Core Thesis

Agents do worse when they code before they understand.

For many high-leverage tasks, the highest-ROI change is to make the system explicitly support:

- research before coding
- synthesis before planning
- planning before implementation

This is not required for all tasks.
It is required for the right classes of tasks.

## Why This Matters

Without an explicit research-first mode, agents tend to:

- overfit to local repo context
- reinvent mediocre patterns
- miss existing solutions or adjacent implementations
- produce shallow architecture decisions
- waste execution cycles on weak hypotheses

For architecture, optimization, unfamiliar domains, and build-vs-buy work, code-only context is often insufficient.

## Research-Driven Execution Principle

### Rule

Use **research-first execution** by default for high-leverage tasks where success depends more on prior art and external understanding than on local code edits.

Use **code-first execution** for narrow, local, well-specified tasks.

## Task Classes That Should Prepend Research

- architecture or systems design
- performance optimization
- unfamiliar codebase or domain work
- build vs buy decisions
- protocol or integration work
- tasks where prior art matters more than raw coding speed
- tasks where competing implementations are likely to provide strong guidance

## Task Classes That Usually Should Not Prepend Research

- small local edits
- obvious bug fixes
- routine refactors
- tightly scoped implementation tasks with a clear spec
- low-risk maintenance work where the local codebase already contains the answer

## Execution Modes

Instead of a binary research toggle, the system should support explicit modes.

### 1. `direct_execute`

Use when the task is narrow, local, and clearly specified.

### 2. `research_then_plan`

Use when outside context matters, but implementation is not yet approved.

### 3. `research_then_design_then_execute`

Use for architecture, systems, and major feature work.

### 4. `compare_implementations`

Use when the system should inspect existing solutions, forks, competitors, or alternative approaches before choosing a path.

### 5. `validate_prior_art_then_execute`

Use when a likely solution already exists and the goal is to confirm fit before implementation.

## Preflight Classifier

Before work begins, the orchestrator should ask:

- does success depend mostly on local repo context?
- or does it depend on outside knowledge, prior art, domain understanding, or comparative analysis?

If the answer is mostly local, choose code-first.
If the answer depends materially on external knowledge, choose research-first.

## Research-Driven Pipeline

When research-first is selected, the default work packet should be:

1. repo scan
2. external prior-art scan
3. synthesis memo
4. execution plan
5. implementation or recommendation

Optional additional stages:

- benchmark design
- implementation variant comparison
- validation pass
- retrospective and pattern capture

## Research Outputs

Research should not end as vague context. It should produce explicit artifacts.

Expected outputs include:

- landscape memo
- implementation comparison note
- benchmark hypothesis note
- recommendation memo
- design constraints note
- references to source repos, papers, docs, or benchmark evidence

These outputs should be stored as first-class artifacts, not hidden in transient chat.

## Implications for Octopus

### New grip types

Octopus should treat research and synthesis as first-class grip types, not pre-chat fluff.

Suggested grip types:

- `research_grip`
- `synthesis_grip`
- `design_grip`
- `implementation_grip`
- `validation_grip`
- `comparison_grip`

### Scheduler implication

The scheduler should support routing different grip types to different arms.

Examples:

- one arm does GitHub and doc research
- one arm synthesizes findings into a decision memo
- one arm executes implementation
- one arm validates or benchmarks

### Shared state implication

Research artifacts should be indexed and attached to the mission so downstream arms can consume them as explicit context.

## Implications for Dark Factory

Dark Factory should not be a prompt fan-out engine.
It should become a **pre-dispatch manufacturing system** for intelligent work packets.

### Dark Factory pre-dispatch pipeline

1. classify task
2. gather context
3. compress context into a useful brief
4. choose execution mode
5. dispatch arms
6. supervise and reconcile outputs

### Dark Factory upgrades implied by this model

- research-prep stage
- synthesis/briefing stage
- task mode selection before fan-out
- success rubric injection
- artifact expectations per task class

### Result

This makes Dark Factory materially smarter than raw parallel runners, because it improves task quality before execution starts.

## Recommended Doc Updates

This concept should be folded into the main doc set, but this document exists as an implementation-facing update that can be read independently.

Recommended insertions:

- **PRD**: add Research-Driven Execution as a product principle
- **HLD**: add research and synthesis as explicit workflow stages and grip types
- **LLD**: add classifier outputs and grip-type handling
- **implementation-plan**: add a preflight classifier and research-grip pipeline milestone
- **recommendation**: add this as a strategic differentiator vs simple fleet runners

## Recommended Immediate Engineering Interpretation

If Clawd Code is already developing the orchestration system, use this rule immediately:

- If the task is architecture, optimization, integration, or prior-art sensitive, require a research artifact before implementation begins.
- If the task is small and local, skip the research overhead.

This should be implemented as policy-driven behavior, not as an optional best-effort habit.

## Suggested Minimal Implementation

### MVP additions

- add a `task_classification` step before dispatch
- add `execution_mode` to the mission or grip model
- add `research_grip` and `synthesis_grip`
- store research memos as indexed artifacts
- pass synthesis artifacts into downstream implementation grips

### Example flow

Task: "Design a new orchestration control plane"

Classifier result:

- task class: architecture
- execution mode: `research_then_design_then_execute`

Generated pipeline:

1. repo scan grip
2. external landscape scan grip
3. synthesis memo grip
4. PRD/HLD/LLD grip
5. implementation planning grip

## Bottom Line

Research-driven execution should become a first-class system behavior for Octopus and Dark Factory.

Not because every task needs research, but because the important ones do, and the cost of skipping it is consistently bad decisions, shallow implementations, and wasted cycles.
