---
title: Durable Core 2026.7.1 Release Architecture
summary: "Architecture anchor for opt-in durable runtime invariants and boundaries on the 2026.7.1 release line."
read_when:
  - Reviewing durable runtime 2026.7.1 release architecture
  - Checking durable runtime owner boundaries before implementation
  - Auditing recovery, wake, and delivery invariants
---

# Durable Core 2026.7.1 Release Architecture

This page is the 2026.7.1 release durable-runtime architecture anchor. It describes the
intended architecture and review boundary only. It does not claim that runtime
behavior, external delivery, replay, worker recovery, or CLI/Gateway control
behavior has landed from this document.

## General Durable Runtime RFC

Durable core is the shared, opt-in runtime substrate beneath OpenClaw agent,
session, subagent, task, channel, and operator surfaces. Its job is to define
the cross-owner invariants for runtime facts that must survive process restarts:
accepted work identity, ordered steps and events, parent/child links, bounded
refs, leases, recovery states, wake/attention obligations, delivery evidence,
and read-only inspection state.

The durable runtime layer builds on the existing local state owners in
`openclaw.sqlite`. The target base already persists audit events, state leases,
task and subagent runs, durable delivery queues, task delivery state, and flow
runs. This RFC is not a competing ledger for those owners. It names the residual
contracts needed when facts cross owner boundaries: stable refs, append-only
event evidence, lease expiry, terminal immutability, wake/attention routing,
dedupe, inspection, and fail-closed recovery.

The RFC boundary is intentionally conservative:

- record accepted runtime work with stable identities and append-only or
  otherwise auditable lifecycle events;
- keep recovery explicit by separating complete, failed, cancelled, stale,
  interrupted, and owner-decision-needed states;
- expose operator and Gateway read paths that explain state without mutating
  work;
- require opt-in durable runtime and worker behavior until storage, recovery,
  controls, and live delivery claims have direct proof;
- preserve current synchronous behavior when durable runtime is disabled.

## What Problem This Solves

OpenClaw is no longer only a synchronous chat loop. It now spans long-running
agent turns, subagents, tool calls, channel delivery, local operator inspection,
and process restarts. Existing durable owners already record important parts of
that work in `openclaw.sqlite`, including audit events, leases, task/subagent
state, delivery queue entries, task delivery state, and flow runs.

The remaining architecture problem is cross-owner consistency. A task row,
subagent run, delivery queue entry, flow run, and audit event can each be valid
on its own while still leaving unclear whether a parent is waiting on fan-in,
whether a side effect already happened, whether a wake was delivered, or what a
restart may safely reclaim. Durable core gives those owners shared invariants so
OpenClaw can answer what it accepted, what ran, what is waiting, what failed,
what became stale after restart, and which bounded recovery action is safe to
present to an owner or operator.

## Why The 2026.7.1 Release Stack Needs This Foundation

The official release/2026.7.1-based stack needs the durable core foundation before broader runtime and product
work because the current failure modes are cross-cutting rather than isolated to
one channel, one prompt, or one UI. The repeated pattern is not merely "a
message did not arrive"; it is that OpenClaw can accept work, delegate it, defer
it, or route it through a channel without a durable obligation that later code
can inspect, recover, acknowledge, or fail closed.

The remaining root causes implementation work must address are:

- **Coordinator silence:** a coordinator can promise later progress or
  completion, then depend on transcript intent and voluntary follow-up instead
  of a durable wake/report-route obligation.
- **Restart and interruption loss:** process exit, gateway restart, tool
  interruption, or provider return can erase process-local knowledge of accepted
  work and leave no safe recovery classification.
- **Stale running work:** rows, sessions, or in-memory markers can appear
  running after the owner is gone unless durable leases, expiry, and stale-state
  diagnostics exist.
- **Parent/child handoff gaps:** subagent completion, fan-in, and result
  delivery can be visible to a child but not durably addressed to the parent or
  human who needs the result.
- **Delivery and attention uncertainty:** a channel send, internal handoff, or
  operator notification may be accepted, attempted, failed, or unknown without
  durable attempt evidence and acknowledgement state.
- **Side-effect uncertainty:** crashes before or after tool dispatch, provider
  return, child spawn, local commit, or channel send can make automatic replay
  unsafe unless idempotency and authority gates prove it.

This foundation lets the 2026.7.1 release stack treat those cases as inspectable runtime states
instead of as unrelated prompt, channel, or UI bugs. This page documents the
boundary and proof model; implementation and runtime claims belong to the
changes that add and validate code.

## Implementation Position

Durable runtime implementation should extend the existing state owners where
they already own the fact, then add shared contracts only for cross-owner
questions those tables cannot answer alone. New records should be source-backed
by a concrete invariant, migration, recovery path, or inspection need.

Architecture review should check whether each proposed durable fact has a clear
owner, retention posture, privacy posture, disabled-runtime behavior, stale-owner
handling, and read path. If an existing owner can answer the question without a
new shared record, prefer the existing owner.

## Durable Core Boundary

The 2026.7.1 release durable core is a local-first runtime substrate, not a
product UI and not a general workflow engine. It records enough state to
inspect, explain, and recover agent/session/task work without requiring external
orchestration.

| Area             | Durable core owns                                                                    | Out of scope for durable core                                                            |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Channel delivery | Intake correlation, delivery refs, attempt evidence, and diagnostics                 | Message formatting, transport policy, notification UX, and channel-specific retry policy |
| Agent execution  | Run, turn, step, event, ref, link, lease, and terminal outcome facts                 | Prompt design, model choice, plan semantics, tool registration, and what work means      |
| Subagents        | Parent/child refs, spawn evidence, terminal outcomes, progress, and fan-in facts     | Delegation strategy, semantic child-task interpretation, and transcript-only fan-in UX   |
| Recovery         | Stale/lost diagnostics, leases, append-only recovery events, and owner wake evidence | Deciding retry, resume, abandon, replacement work, or semantic replay for a parent       |
| UX/product       | Read models and explanations over durable facts                                      | Workboard grouping, Task Flow authoring, channel UX, and product-specific task states    |

Layer separation is mandatory. Substrate facts are persisted in durable tables;
runtime interpretation derives safe state from those facts; projection policy
maps facts into Workboard, Task Flow, or channel views; agent policy decides what
the model or owner should do next.

## 2026.7.1 Release Stack User Promise

The 2026.7.1 release stack promises trustworthy inspection and diagnostics first. The core recovery
promise is to persist committed facts and surface attention to the owner of the
work. If a runtime, worker, Gateway request, child run, channel delivery, or
process dies halfway, durable core records the facts, exposes diagnostics, and
surfaces pending owner/main-agent work.

The 2026.7.1 release stack does not promise:

- automatic arbitrary replay;
- exactly-once external effects;
- full Task Flow barriers;
- Workboard-native recovery UX;
- distributed scheduling;
- semantic resume of model/tool work without explicit contracts;
- external channel delivery unless the implementation PR proves it directly.

## Core Invariants

- Terminal run and step states are immutable except retention or compaction
  metadata.
- Claimed records include an owner and expiry; stale owner writes are rejected.
- Recovery mutations append events and do not silently rewrite history.
- Disabled durable read paths do not create databases, tables, or migrations.
- Future schema versions fail closed before mutation.
- Unknown metadata is preserved across supported read/modify/write paths.
- Bounded previews are the default. Full input capture is opt-in, hashes are not
  anonymization, and metadata can be sensitive.

## Durable Wake And Attention Obligations

A durable wake is a substrate record that committed runtime facts require
attention from an owner, supervisor, report route, operator, or inspection
surface. Parent wake-up is one subagent/fan-in case; it is not the whole model.

Durable core may record wake-needed events, owner and target refs, result-mailbox
items, delivery evidence, no-handler diagnostics, and acknowledgement state. It
must not decide whether the owner should retry, resume, abandon, wait, ask the
user, or create new work.

A wake record includes a stable wake id, compatibility parent run/session fields
when a parent is the owner, optional resolved target agent/session/channel refs,
a machine-readable reason, facts or source-run refs, a dedupe key, attempt
counts, bounded failure state, acknowledgement time, metadata, and lifecycle
status. Terminal wake states are immutable except retention or compaction
metadata.

Wake target resolution is generalized beyond parent sessions. Resolver logic may
classify targets as resolved, missing, ambiguous, unauthorized, or inspect-only
from stored runtime facts. Creation, delivery attempts, recovery reconciliation,
and result-mailbox replay must use stable dedupe keys so repeated producer scans
or repeated delivery attempts are idempotent.

Internal session delivery-queue handoff satisfies the durable-core delivery
boundary only for a resolved session target. External channel transport remains a
separate delivery claim and must not be implied by this RFC or by the internal
handoff unless implementation work proves it directly.

## Non Goals

- No runtime code, schema, worker, CLI, Gateway, or transport changes from this
  docs-only RFC.
- No default-on durable runtime behavior in the 2026.7.1 release stack.
- No product-specific task-card or Workboard policy in durable core.
- No raw prompt, task, or tool-payload persistence by default.
- No replay of side effects without idempotency, retention, and operation
  authority gates.
- No external delivery claim without direct implementation and live or
  maintainer-grade proof.

## Related

- [Durable Core 2026.7.1 Release Test Plan](/specs/durable-core-beta3-test-plan)
