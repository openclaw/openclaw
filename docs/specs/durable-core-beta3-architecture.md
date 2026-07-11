---
title: Durable Core Beta 3 Architecture
summary: "Review anchor for the opt-in durable runtime architecture, boundaries, stack order, and PR body language on the beta 3 line."
read_when:
  - Reviewing the durable runtime beta 3 stack
  - Checking the durable core boundary before implementation PRs
  - Writing or reviewing cumulative durable-runtime PR bodies
---

# Durable Core Beta 3 Architecture

This page is the PR1 docs/RFC anchor for the beta 3 durable-runtime stack. It
describes the intended architecture and review boundary only. It does not claim
that runtime behavior, external delivery, replay, worker recovery, or CLI/Gateway
control behavior has landed in this PR.

## General Durable Runtime RFC

Durable core is the shared, opt-in runtime substrate beneath OpenClaw agent,
session, subagent, task, channel, and operator surfaces. Its job is to record
runtime facts that must survive process restarts: accepted work identity,
ordered steps and events, parent/child links, bounded refs, leases, recovery
states, wake/attention obligations, delivery evidence, and read-only inspection
state.

The durable runtime layer exists because no single product surface can safely
own those facts. Task Flow, Workboard, channel UI, plugins, and session UX may
project from durable facts, but they must not define the persistence boundary.
The core must remain useful when those products are disabled, absent, or
changing independently.

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
and process restarts. Without a durable substrate, the only common record is the
transcript plus process-local memory. That is not enough to prove whether a
child run was spawned, whether a side effect already happened, whether a parent
is waiting on fan-in, or what a restart may safely reclaim.

Durable core gives OpenClaw a local-first operational record for those runtime
facts. The record is meant to answer what OpenClaw accepted, what ran, what is
waiting, what failed, what became stale after restart, and which bounded recovery
action is safe to present to an owner or operator.

## Why Beta 3 Needs This Foundation

Beta 3 needs the durable core foundation before broader runtime and product
work because the current failure modes are cross-cutting rather than isolated to
one channel, one prompt, or one UI. The repeated pattern is not merely "a
message did not arrive"; it is that OpenClaw can accept work, delegate it, defer
it, or route it through a channel without a durable obligation that later code
can inspect, recover, acknowledge, or fail closed.

The root causes PR2 through PR5 must address are:

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

This foundation lets beta 3 treat those cases as inspectable runtime states
instead of as unrelated prompt, channel, or UI bugs. PR1 only documents that
boundary and proof model; implementation and runtime claims remain deferred to
the later PRs that add and validate code.

## Stack Position

PR1 is the docs/RFC/boundary anchor for a cumulative five-PR stack:

| PR  | Scope                                                             | Boundary                                                                    |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| PR1 | Architecture, boundary, reviewer language, and test plan          | Docs-only review anchor; no runtime behavior claim                          |
| PR2 | Runtime foundation, SQLite store, and terminal immutability guard | Durable primitives and storage invariants                                   |
| PR3 | Wake targets, producers, replay/resume semantics                  | Attention obligation and idempotent recovery paths                          |
| PR4 | Controls, inspection, CLI, and Gateway surface                    | Read/control APIs over durable facts                                        |
| PR5 | Internal session delivery handoff and final hardening             | Cumulative durable core; internal handoff only unless external proof exists |

Every later branch must be based on the previous PR head. PR5 is therefore the
cumulative top of the stack, not a standalone handoff-only patch.

## Durable Core Boundary

The beta 3 durable core is a local-first runtime substrate, not a product UI and
not a general workflow engine. It records enough state to inspect, explain, and
recover agent/session/task work without requiring external orchestration.

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

## Beta 3 User Promise

Beta 3 promises trustworthy inspection and diagnostics first. The core recovery
promise is to persist committed facts and surface attention to the owner of the
work. If a runtime, worker, Gateway request, child run, channel delivery, or
process dies halfway, durable core records the facts, exposes diagnostics, and
surfaces pending owner/main-agent work.

Beta 3 does not promise:

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

Internal session delivery-queue handoff satisfies the durable-core delivery
boundary only for a resolved session target. External channel transport remains a
separate delivery claim and must not be implied by PR1 or by the internal handoff
unless a later PR implements and proves it.

## Non Goals

- No runtime code, schema, worker, CLI, Gateway, or transport changes in PR1.
- No default-on durable runtime behavior in beta 3.
- No product-specific task-card or Workboard policy in durable core.
- No raw prompt, task, or tool-payload persistence by default.
- No replay of side effects without idempotency, retention, and operation
  authority gates.
- No external delivery claim without direct implementation and live or
  maintainer-grade proof.

## PR Body Requirements

Every PR in the durable stack should keep stable reviewer-facing headings so
ClawSweeper and human reviewers can compare scope and proof across exact heads:

- `Context capsule`
- `Stack position`
- `What Problem This Solves`
- `Why This Change Was Made`
- `User Impact`
- `Proof matrix`
- `Live proof`
- `ClawSweeper requirements`
- `Evidence`

Each body must name root cause and stack context, record base/head SHAs, describe
non-scope, state data-model and upgrade/default posture, and say which downstream
PR owns deferred behavior. PR1 should explicitly say live/runtime proof is not
applicable because the branch is docs-only.

## Related

- [Durable Core Beta 3 Test Plan](/specs/durable-core-beta3-test-plan)
