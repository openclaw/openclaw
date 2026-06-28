---
title: Durable Agent Coordination Kernel RFC
summary: "Proposal for an opt-in durable coordination ledger beneath OpenClaw agent tasks, Task Flow, Workboard, and sessions."
read_when:
  - Evaluating durable coordination for long-running agent work
  - Designing fan-in, restart recovery, or multi-agent runtime state
  - Comparing Task Flow, background tasks, Workboard, and core coordination boundaries
---

# Durable Agent Coordination Kernel RFC

Status: proposed

This RFC proposes a small, opt-in durable coordination kernel for agent work. It
is not a proposal to replace Task Flow, background tasks, Workboard, sessions, or
external workflow systems. The intent is to give those existing surfaces a common
runtime ledger for long-running, branching, multi-agent work.

## Problem

OpenClaw already has durable session transcripts, background task records, Task
Flow, plugin state, and channel delivery state. The missing boundary is a small
kernel that can answer the runtime question:

> Given a user request, parent agent run, child agent run, tool step, or human
> signal, what durable work item does it belong to and what state should advance
> next after a gateway restart?

Without that boundary, complex agent coordination can degrade into symptoms that
are hard to debug:

- a parent agent appears silent while child work is still running;
- a parent agent does not fan in after one or more subagents finish;
- one failed or overflowing child can block unrelated siblings or the parent;
- a gateway restart loses in-memory knowledge of which branch was active;
- status messages from parallel branches can be routed to the wrong channel or
  conversation context;
- operators cannot reconstruct a concise timeline for a stuck long-running run.

## Non-Goals

- Do not add a general-purpose Temporal, Restate, Hatchet, or LangGraph clone.
- Do not make durable coordination mandatory for normal chat turns.
- Do not introduce a second product-level workflow system beside Task Flow.
- Do not persist raw prompt or task text into coordination metadata.
- Do not couple core runtime state to a specific plugin, dashboard, channel, or
  external service.
- Do not change Workboard, Task Flow, or background task semantics without
  maintainer direction.

## Relationship To Existing Surfaces

The proposed kernel should sit below existing user-facing surfaces:

- Background tasks remain the durable unit of detached work.
- Task Flow remains the orchestration surface for multi-step flows above tasks.
- Workboard remains an optional operator and agent-owned card surface.
- Sessions remain the model-visible transcript and conversation boundary.
- Plugins keep their own domain state.

The kernel would provide shared coordination primitives that these surfaces can
project from or into: run identity, step identity, event ordering, child links,
fan-in readiness, cancellation, retry intent, and restart recovery markers.

## Minimal Primitive Set

The smallest useful primitive set is:

- `workflow_id`: stable logical workflow identity.
- `workflow_run_id`: one execution attempt of the workflow.
- `parent_run_id`: optional parent for child/subagent work.
- `step_id`: durable step identity inside a run.
- `agent_invocation_id`: identity for a model/agent invocation.
- `message_id` or `turn_id`: inbound message and chat-turn identity.
- `event_id` and `event_seq`: append-only event ordering for debugging and
  replay-safe reads.
- `idempotency_key`: safe retry and duplicate intake handling.
- `checkpoint_ref`: reference to external state without copying large payloads.
- `signal_id`: human input, approval, cancellation, or resume signal.
- `retry_policy` and `deadline`: bounded retry behavior.
- `recovery_state`: marker for pending, running, terminal, lost, or reconciled
  work after restart.

## Proposed Shape

The first implementation should be local-first and opt-in:

- store durable coordination tables in the canonical shared state database
  (`state/openclaw.sqlite`) so backup, doctor, migration, and upgrade flows can
  reason about the state lifecycle;
- keep the feature disabled by default behind one explicit gate;
- expose read-only operator views before automatic scheduling behavior;
- record bounded metadata only: ids, hashes, labels, refs, timestamps, and
  terminal state;
- make child branches independently terminal so one failed branch cannot block
  sibling completion;
- provide a fan-in projection that lets parent-level surfaces decide whether to
  advance, wait, degrade, or ask for human input.

## Suggested Review Plan

To keep review focused, this proposal should move in vertical slices:

1. RFC and maintainer alignment.
2. Opt-in coordination ledger in the shared OpenClaw state database.
3. Read-only Gateway and CLI timeline/projection APIs with disabled-by-default
   regression tests.
4. Subagent child-run recording and fan-in projection without raw task
   persistence.
5. Recovery worker, retention, and migration hardening after the primitive shape
   is accepted.

## Open Questions

- Should the initial coordination ledger be part of Task Flow internals, a
  standalone core runtime module, or a narrower shared task/session submodule?
- Which existing operator surfaces should read the first projection: Task Flow,
  Workboard, CLI, Control UI, or all of them through Gateway?
- What retention policy is acceptable for event timelines in local-first
  installs?
- Which migration and doctor checks should be required before the feature moves
  from experimental to default-on?
