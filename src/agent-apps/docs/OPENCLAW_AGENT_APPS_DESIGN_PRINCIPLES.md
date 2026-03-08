# OpenClaw x AOTUI Design Principles

## Status

This document captures the hard design principles agreed during the OpenClaw x AOTUI migration discussions.

It is not an implementation plan.
It is not an RFC.
It is not a wishlist.

It is a constraint document.

Any future design or implementation for AOTUI inside OpenClaw should be evaluated against these principles first.

## Problem Framing

OpenClaw is the orchestrator.
AOTUI is the stateful runtime surface for agent-facing apps.

The migration goal is not to embed a second framework brain into OpenClaw.
The goal is to let OpenClaw keep authority over agent execution, transcript, and model calls, while AOTUI provides:

- a live app runtime
- a live tool surface
- a live state projection surface

The central architectural question is:

How do we let the agent use a rich, stateful UI world without letting that world become an unbounded token sink, an authority split, or a long-term state trap?

The answer agreed here is:

- semantic continuity must survive
- UI state does not need to survive
- authority must stay singular
- runtime state must be cheap to rebuild

## Core Position

### 1. OpenClaw remains the single authority

OpenClaw owns:

- agent orchestration
- model calls
- transcript and session history
- compaction flow
- durable memory decisions
- config authority

AOTUI does not become a second orchestrator.
AOTUI is a runtime and projection subsystem.

### 2. AOTUI is a volatile operational scratchpad, not a durable state store

This is the most important design choice.

AOTUI is allowed to hold rich working state during active execution, but that state is not sacred.
When context pressure rises, apps on the desktop may be reinitialized back to their initial state.

What must survive long-running sessions is not the full UI state tree.
What must survive is:

- current task semantics
- current active object/resource pointers
- current constraints and decisions
- current re-entry path

These survive through:

- compaction summary in language space
- fresh runtime reinjection in the next turn

Not through permanent retention of full runtime app state.

### 3. Semantic continuity is durable; UI continuity is opportunistic

This system should optimize for preserving:

- what the agent was doing
- what mattered
- what resource was active
- what the next step is

This system should not optimize for preserving:

- full view trees
- exact local UI layout state
- stale derived panels
- arbitrary hidden subtree state

If a choice must be made, semantic continuity wins over UI continuity.

## Non-Negotiable Invariants

### 4. One canonical session identity maps to one desktop identity

A desktop must be bound to a canonical `sessionKey`, not to an ephemeral run, transient retry, or transient model call.

Reason:

- session identity is the stable unit of continuity
- run identity is only an event
- state bound to events will fragment

### 5. Identity packets must survive lifecycle boundaries

Anything that determines policy, ownership, routing, or attribution must not be silently dropped during reset/recreate flows.

At minimum this includes:

- `sessionKey`
- `sessionId`
- `agentId`

`workspaceDir` is no longer a first-class requirement in the OpenClaw-integrated model.
The system should assume machine-wide scope, not a mandatory project-root scope.

### 6. One model turn must observe one snapshot epoch

Messages and tools exposed to the model for a given turn must come from the same snapshot epoch.

The agent must never decide in a world where:

- the visible state came from snapshot A
- the callable actions came from snapshot B

That world does not exist.
It is an invalid observation.

### 7. No hidden second control plane

AOTUI app installation and exposure policy must be controlled by OpenClaw config.

No external implicit registry, user-global config, or side-channel app source may silently alter the capability surface seen by OpenClaw.

Reason:

- two control planes create drift
- drift destroys operability
- drift destroys trust

## Control and Capability Boundaries

### 8. Capability scoping is agent-first

The default and primary control boundary for agent apps is `agent`.

This means:

- which apps an agent can load
- which tools an agent can see
- which AOTUI runtime capabilities an agent can use

should be decided at agent scope first.

Finer scopes like `session` or `channel` are optional extensions, not baseline requirements.

They should only be introduced when one agent must operate across materially different trust, cost, or behavior domains.

### 9. Install only what the agent is allowed to use

A desktop should not mount every configured app by default.

The allowed app set must be explicit.

Reason:

- every installed app expands the token surface
- every installed app expands the tool surface
- every installed app expands accidental misuse surface

### 10. AOTUI must not own transcript truth

AOTUI-injected context is runtime context, not transcript truth.

It may influence model behavior heavily, but it must not become the authoritative durable session history layer by accident.

## Token and Context Economics

### 11. Agent apps always affect prompt cost

There is no free runtime context.

If AOTUI state or tools are injected into the model-facing request, they affect:

- prompt token usage
- latency
- context pressure
- compaction timing
- overflow probability

This is not optional.
This is the direct cost of bringing external state into model cognition.

### 12. The correct question is not "does AOTUI affect tokens"

That question is already settled.

The correct questions are:

- how much runtime state is exposed per turn
- how frequently that state changes
- how much semantic value is obtained per injected token
- whether compaction frequency remains acceptable

### 13. Projection budget is more important than transcript budget alone

Context pressure in OpenClaw with AOTUI is the sum of at least three budgets:

- transcript/history budget
- runtime projection budget
- dynamic tool/schema budget

Any design that tries to solve pressure by only compacting transcript while leaving runtime projection unconstrained is incomplete.

## Compaction Model

### 14. Compaction is allowed to reinitialize desktop apps

This is an explicit design principle.

When context pressure justifies compaction, the system may reinitialize every app on the desktop back to its initial state.

This is not considered corruption.
This is considered working-state reclamation through reinitialization.

### 15. Compaction does not need to preserve full AOTUI internal state

The system does not promise that full AOTUI state survives compaction.

What survives compaction is:

- the LLM's language-level summary of current active work
- the next turn's fresh reinjection of desktop/app identity and live surface

Therefore, a full structured snapshot-preservation layer is not required as a baseline.

### 16. The compaction summary must preserve active work semantics

Because apps may be reinitialized, compaction quality becomes important.

The compaction summary must preserve at least:

- the current active app
- the current active view
- the resource or object currently being manipulated
- the current task state
- critical decisions and constraints
- the next intended step

If these are not preserved, app reinitialization will break continuity.

### 17. Only surfaced state is guaranteed to survive

This is a hard rule for future app design.

If important state is not exposed through the active view or active task surface, the system should not assume it will survive compaction.

In other words:

- visible/active state is survivable
- hidden/internal-only state is disposable by default

### 18. Re-injection restores topology, not previous internal state

On the next turn after compaction, runtime reinjection is expected to restore:

- desktop identity
- app identity
- app existence
- app entry points
- live currently projected state

It is not expected to restore every previous internal app detail.

### 19. Compaction success is measured by net task continuity, not by trigger timing

Whether compaction happens earlier or later is secondary.

The primary metric is:

After compaction, can the agent resume useful work with lower total cost than keeping the old state?

This includes:

- prompt size after compaction
- number of extra recovery tool calls
- number of extra recovery turns
- semantic continuity retained

## Runtime Lifecycle Rules

### 20. Dead lifecycle code must not exist

If idle suspend/destroy is not actually part of the running system, it should be deleted.

A false lifecycle promise is worse than no lifecycle feature.

Reason:

- developers trust names
- stale lifecycle code creates false beliefs
- false beliefs create misdiagnosis

### 21. If lifecycle states exist, state transitions must be truthful

No record should claim one power/activity state while the kernel is in another.

If suspend exists, resume must be correct.
If idle exists, its semantics must be distinct and real.

### 22. Unused runtime config surface should not exist

If a config option is not wired into product behavior, remove it.

Future configurability is not an excuse for current ambiguity.

## Prompt and Message Semantics

### 23. Runtime instructions are not user intent

Anything like `systemInstruction` must not masquerade as normal user intent.

Runtime guidance, world description, and user requests are semantically different layers.
They should be represented as such.

### 24. AOTUI injection should be concise and current

The runtime should inject the latest relevant surface, not arbitrary historical surfaces.

The goal is to expose the current world, not to replay every previous UI mutation.

## App Design Rules

### 25. Apps must be designed for state loss

Any AOTUI app integrated into OpenClaw must assume:

- the app may be reinitialized after compaction
- the next turn may start from the app's initial state
- continuity will depend on what was surfaced and summarized

Apps that require hidden durable internal state are a poor fit unless they explicitly externalize that state.

### 26. Critical state must be projectable

If a piece of state matters across turns, it must be expressible through:

- active visible state
- active resource identifiers
- durable external storage
- or explicit OpenClaw-managed memory

If it exists only as opaque in-memory app internals, it is not durable.

### 27. Derived state should be cheap to rebuild

Apps should treat the following as rebuildable by default:

- search result panels
- hover details
- reference lists
- expanded navigation trees
- temporary detail views

If rebuilding such state is expensive, that expense must be justified explicitly.

### 28. Re-entry must be intentional

After compaction-triggered app reinitialization, the app/runtime combination should still offer an obvious path back into useful work.

This does not require restoring old internal state.
It requires restoring actionable orientation.

## Anti-Goals

The OpenClaw x AOTUI architecture should not optimize for:

- preserving the full internal UI tree forever
- minimizing every single compaction event at all costs
- letting hidden state silently become durable
- letting AOTUI become a second source of orchestration truth
- allowing app capability drift via external implicit config

## Decision Tests

A proposed design is aligned with this document if the answer to the following is "yes":

1. Does OpenClaw remain the only orchestration authority?
2. Is the desktop bound to canonical session identity rather than transient execution identity?
3. Will one turn observe one snapshot epoch for both tools and messages?
4. Is the app capability surface controlled by OpenClaw config?
5. Can the system reinitialize desktop apps to their initial state without destroying task continuity?
6. Does the compaction summary retain the active work semantics needed for re-entry?
7. Does the next turn reinject enough live topology to let the agent re-orient?
8. Is critical cross-turn state surfaced or externalized rather than hidden?
9. Does the design control projection budget instead of only transcript budget?
10. Would the design still behave predictably after many compaction cycles?

If any answer is "no", the design is not ready.

## One-Sentence Summary

OpenClaw x AOTUI should be designed as a single-authority agent system where AOTUI provides a rich but disposable working surface, semantic continuity survives compaction, and full UI state does not.
