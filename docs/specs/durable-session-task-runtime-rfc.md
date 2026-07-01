---
title: Durable Session and Task Runtime RFC
summary: "Proposal for an opt-in durable runtime layer for OpenClaw agent sessions, tasks, steps, subagent fan-in, and restart recovery."
read_when:
  - Evaluating durable coordination for long-running agent work
  - Designing restart-safe agent sessions, task runs, or subagent fan-in
  - Reviewing the boundary between core runtime state, sessions, tasks, Task Flow, and plugins
---

# Durable Session and Task Runtime RFC

Status: proposed

This RFC proposes a small, opt-in durable runtime layer for OpenClaw agent work.
The goal is not to build a general-purpose workflow engine or replace Task Flow,
background tasks, sessions, Workboard, or external systems such as Temporal,
Restate, Hatchet, or LangGraph. The goal is to give OpenClaw a shared runtime
substrate that can answer where a long-running agent run is, what step it is
waiting on, which children belong to it, and how the system should recover after
a gateway restart.

The proposed boundary is intentionally core and generic:

- durable runtime runs and steps, not product-specific cards or dashboards;
- bounded metadata, refs, and event ordering, not raw prompts or large payloads;
- restart-safe session/task/subagent lifecycle, not automatic business-process
  policy;
- read-only inspection first, with write controls added only when routed through
  real session/task runtime contracts.

## Problem

OpenClaw already has session transcripts, background task records, Task Flow,
Workboard, plugin state, tool calls, and channel delivery state. Those surfaces
are valuable, but none of them is the shared low-level runtime ledger for agent
coordination.

The missing core question is:

> For this inbound message, agent turn, task, subagent child, tool step, timer,
> or human signal, what durable runtime run and step does it belong to, and what
> should happen after the process restarts?

Without that boundary, complex agent work can fail in ways that look like the
agent is silent or stuck:

- a parent session yields to child work but gets marked terminal too early;
- a parent does not fan in after subagents complete;
- one failed or overflowing child blocks unrelated sibling branches;
- a gateway restart loses in-memory child/parent relationships;
- progress from parallel branches can be routed to the wrong session/channel;
- operators have no concise timeline for why a run is waiting, failed, or lost.

## Proposed Core Model

The durable runtime should model OpenClaw work with runtime-oriented primitives:

- `runtime_run_id`: one durable unit of execution, such as an agent turn, task
  run, or subagent child run.
- `operation_kind`: stable logical operation name, for example
  `agent.turn`, `task.run`, `subagent.child`, or `tool.step`.
- `parent_runtime_run_id`: optional parent used for subagent and branch fan-in.
- `step_id`: a step inside a runtime run, such as `agent_invocation`,
  `tool_call`, `fan_in`, `timer`, or `human_signal`.
- `message_id` and `turn_id`: inbound message and chat turn correlation.
- `agent_invocation_id`: model/agent invocation identity.
- `event_seq`: append-only event ordering inside a runtime run.
- `idempotency_key`: duplicate intake and safe retry protection.
- `checkpoint_ref`: reference to external state or artifacts without copying
  large payloads into the runtime table.
- `signal_id`: human input, approval, cancellation, or resume signal.
- `recovery_state`: `runnable`, `claimed`, `running`, `waiting_child`,
  `waiting_signal`, `waiting_timer`, `retry_scheduled`,
  `unknown_after_side_effect`, `lost`, `terminal`, and related restart-safe
  markers.

The durable tables should be named around runtime semantics, for example
`durable_runtime_runs`, `durable_runtime_steps`, `durable_runtime_events`,
`durable_runtime_refs`, `durable_runtime_links`, `durable_runtime_timers`, and
`durable_runtime_signals`.

## Boundary With Existing Surfaces

This layer should sit below existing product and operator surfaces:

- Sessions remain the transcript and conversation boundary.
- Background tasks remain the detached work surface.
- Task Flow remains the authored multi-step orchestration surface.
- Workboard remains an optional operator/card UI.
- Plugins keep domain-specific state and behavior.

The durable runtime owns only invocation identity, step ordering, child links,
state refs, retry/signal metadata, recovery markers, and read-safe timelines.
Task Flow, Workboard, CLI, Control UI, and plugins can project from it, but they
should not own the core runtime persistence model.

## First Review Slice

The first implementation should be local-first, opt-in, and conservative:

1. Add the durable runtime schema to the shared OpenClaw state database
   (`state/openclaw.sqlite`) with upgrade-safe tests.
2. Keep the feature disabled by default behind an explicit flag, initially
   `OPENCLAW_DURABLE_RUNTIME`.
3. Record bounded metadata only: ids, hashes, labels, refs, timestamps, states,
   and child links.
4. Add read-only CLI/Gateway timeline and projection APIs.
5. Ensure yielded parent runs remain inspectable as `waiting_child` or
   `waiting_signal` instead of being marked terminal too early.
6. Ensure direct subagent continuation/fan-in can close the parent durable run
   when the parent continuation actually succeeds.
7. Do not advertise cancel/retry/resume/signal controls until matching write
   contracts exist in the real session/task runtime.

## Non-Goals

- Do not implement a general-purpose workflow engine.
- Do not make durable runtime mandatory for simple chat.
- Do not couple core runtime state to Workboard, Task Flow, a dashboard, or a
  channel plugin.
- Do not persist raw prompts, private tool payloads, or large outputs in runtime
  metadata.
- Do not add automatic retry/resume policy as default behavior before operators
  can inspect and configure it.
- Do not expose write controls that cannot route through the real runtime.

## Maintainer Decision Requested

Please decide whether this small durable runtime boundary belongs in core as a
shared substrate for sessions, tasks, and subagents.

The recommended answer is yes, with these constraints:

- keep it opt-in and local-first for the initial slice;
- keep it generic and runtime-oriented rather than designer-oriented;
- use shared `state/openclaw.sqlite` so backup, doctor, and schema migration
  paths stay unified;
- expose read-only inspection before write controls or automatic worker policy;
- keep Task Flow and Workboard as projections/follow-ups, not prerequisites for
  durable session/task execution.

If maintainers prefer a different boundary, the main alternatives are:

- place this state inside Task Flow internals, which makes session/subagent-only
  durability harder to reuse;
- place it in a narrower task/session module, which still needs the same
  runtime run/step/event/link primitives;
- keep it entirely external through Temporal/Restate/Hatchet adapters, which
  preserves core size but does not fix local-first restart/fan-in inspection.

## Follow-Ups After The Core Slice

- Worker lease contention and multi-worker tests.
- Retention and compaction policy for local-first installs.
- Configurable retry/resume/cancel/signal write controls.
- Task Flow projection.
- Workboard projection and chat UI.
- Optional adapters to external engines.
