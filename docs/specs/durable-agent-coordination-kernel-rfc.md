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

The review request for this RFC is intentionally narrow: maintainers should use
it to decide whether the boundary belongs in a small core durable kernel, inside
Task Flow internals, or in a narrower shared task/session module. Until that
boundary is accepted, this document should be read as proposed direction rather
than shipped OpenClaw behavior.

The companion implementation proof is tracked in
[openclaw/openclaw#97508](https://github.com/openclaw/openclaw/pull/97508). That
PR demonstrates the proposed first slice as an opt-in, local-first ledger with
read-only inspection and restart/upgrade proof; this RFC remains the architecture
decision point.

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

1. RFC and maintainer alignment on the owner boundary.
2. Opt-in coordination ledger in the shared OpenClaw state database, with schema
   lifecycle and upgrade-safety proof.
3. Read-only Gateway and CLI timeline/projection APIs with disabled-by-default
   regression tests.
4. Subagent child-run recording and fan-in projection without raw task
   persistence.
5. Recovery worker, retention, and migration hardening after the primitive shape
   is accepted.

## Maintainer Decision Requested

Recommended decision:

- Treat the durable ledger as a small standalone core runtime module, with Task
  Flow, Workboard, CLI, and Control UI reading it through Gateway-facing
  projections instead of owning the persistence model directly. This keeps the
  primitive reusable across agent turns, subagent fan-in, and future operator
  surfaces without coupling the schema to one product view.
- Use shared `state/openclaw.sqlite` as the local-first lifecycle home for the
  first coordination tables. This avoids introducing a new service, keeps the
  feature backupable with the existing OpenClaw state directory, and lets schema
  lifecycle, doctor checks, and upgrade safety be reviewed in one place.
- Keep the MVP boundary at opt-in read-only inspection plus restart/upgrade
  safety. Task Flow integration, Workboard presentation, retention,
  compaction, and worker policy should remain follow-ups after maintainers
  accept the primitive shape.

Before publishing this RFC as accepted direction, please confirm whether this
boundary is acceptable or whether upstream would prefer to place the ledger
inside Task Flow internals or a broader shared task/session module.

## Non-Blocking Follow-Ups

- Choose the first operator surface for projection reads after the core boundary
  is accepted: Task Flow, Workboard, CLI, Control UI, or all of them through
  Gateway.
- Define timeline retention and compaction policy for local-first installs.
- Define the migration and doctor checks required before the feature moves from
  experimental to default-on.
