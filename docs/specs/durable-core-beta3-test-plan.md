---
title: Durable Core 2026.7.1 Release Test Plan
summary: "Maintainer-grade proof matrix for 2026.7.1 release durable runtime invariants."
read_when:
  - Planning durable runtime proof
  - Auditing durable runtime merge readiness
  - Converting reviewer concerns into tests
---

# Durable Core 2026.7.1 Release Test Plan

This plan turns the durable-core architecture into proof expectations for
official release/2026.7.1-based durable runtime work. It is a review anchor only; it does not require runtime
proof from docs-only changes that do not alter runtime behavior.

## Scope

The plan covers the opt-in, local-first durable runtime substrate: storage,
runtime facts, recovery diagnostics, wake/attention obligations, internal
handoff, inspection, and safe owner controls. It does not require product UI,
Workboard or Task Flow authoring, distributed scheduling, automatic semantic
replay, or external channel delivery.

## Root-Cause Coverage

2026.7.1 release durable-core work must prove the general runtime root causes are handled
as durable facts, not as product-specific conventions. Architecture docs define
the required coverage; implementation changes own executable proof.

| Root cause                      | Required durable-core response                                                                                                                                    | Primary proof area              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Coordinator silence             | Accepted deferred work creates an inspectable wake, report-route, progress, timeout, or owner-decision obligation instead of relying only on transcript intent    | Wake and owner attention        |
| Restart and interruption loss   | Runtime facts distinguish complete, failed, cancelled, interrupted, stale, and decision-needed work after process exit, gateway restart, tool failure, or handoff | Storage and recovery            |
| Stale running work              | Claims and leases have owners, expiry, stale diagnostics, and fail-closed mutation rules so lost owners cannot keep rewriting or hiding abandoned work            | Leases and worker recovery      |
| Parent/child handoff gaps       | Child spawn, terminal outcome, fan-in, result-mailbox, and parent wake facts are durably linked and deduped before any parent/human completion claim              | Subagent and result handoff     |
| Delivery and attention unknowns | Internal handoff and any claimed external delivery record target, attempt, acknowledgement, failure, no-handler, and unresolved states with bounded inspection    | Delivery and inspection         |
| Side-effect uncertainty         | Automatic replay is denied unless operation authority, input material, side-effect class, idempotency, dedupe/CAS or reconciliation, and retention gates all pass | Replay authority and safeguards |

Reviewers should treat these as durable-runtime acceptance criteria. A change may
implement a narrow slice, but it should still name which root-cause rows it
covers and which rows remain deferred.

## Proof Hygiene

- Run proof on the change being reviewed, with the same configuration that
  enables the claimed durable behavior.
- Record the command, relevant configuration, data directory setup, and output or
  log path.
- Re-run affected proof after rebases or changes to touched runtime surfaces.
- Docs map and generated artifacts must be regenerated with repo scripts, not
  copied from another worktree.

## Docs-Only Gate

| Check         | Required proof                                                                      |
| ------------- | ----------------------------------------------------------------------------------- |
| Scope hygiene | `git diff --name-status <base>..<head>` shows docs/spec/test-plan only              |
| Docs map      | `node scripts/generate-docs-map.mjs --check` or equivalent docs-map check           |
| Docs syntax   | docs MDX/lint/format checks available in the 2026.7.1 release tree for touched docs |
| Diff hygiene  | `git diff --check <base>..<head>`                                                   |
| Ancestry      | `git merge-base --is-ancestor <base> <head>`                                        |

Docs-only changes should state when live proof is not applicable because they
claim no runtime delivery behavior.

## Proof Matrix

| Area                          | Required proof                                                                                                                                                          | Proof surface                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Disabled-path no mutation     | CLI and Gateway durable inspection reject before creating SQLite, WAL, SHM, migration, or durable tables                                                                | Durable config and inspection     |
| Runtime opt-in                | Durable recording and inspection are inert by default and enabled only by explicit durable runtime config                                                               | Runtime config                    |
| Worker separate gate          | Runtime-enabled startup records only allowed facts; worker recovery requires separate worker opt-in                                                                     | Worker recovery                   |
| Future schema fail-closed     | Newer durable schema versions fail before DDL, ALTER, backfill, worker mutation, or projection mutation                                                                 | Schema migration                  |
| Terminal immutability         | Terminal runs, steps, and wake states reject claim, heartbeat, checkpoint, output, error, delivery, ack, retry, and facts rewrites except retention/compaction metadata | Storage mutation guards           |
| Identity propagation          | Chat, `agent.run`, user turns, embedded-agent yield, task completion, and status notices carry stable durable refs                                                      | Runtime identity                  |
| ACP/manual-spawn preservation | ACP manual-spawn child turn task suppression remains intact; plugin-subagent precedence and CLI fallback still work                                                     | Agent and subagent compatibility  |
| Pairing QR regression         | Webchat pairing QR display remains visible without persisting sensitive QR content                                                                                      | Adjacent channel compatibility    |
| Wake target resolution        | Owner, parent, peer, scheduled, Task Flow, external route, missing, unauthorized, and ambiguous targets resolve or fail closed with inspectable evidence                | Wake routing                      |
| Wake queue contract           | Wake records include stable ids, target refs, reason, facts refs, dedupe key, attempt fields, ack/failure fields, and lifecycle state                                   | Wake storage                      |
| Replay authority              | Automatic replay is denied unless operation registry, input material, idempotency, side-effect class, dedupe/CAS or reconciliation, and retention gates pass            | Replay safeguards                 |
| CLI/Gateway inspection        | Read APIs expose runs, facts, wake queue, unresolved obligations, and uncertainty without worker mutation                                                               | Read APIs                         |
| Owner controls                | Acknowledge, supersede, owner decision, retry request, abandon request, and resume request are caller-invoked audited facts                                             | Control APIs                      |
| Worker no-handler behavior    | Empty registry and no-handler rows fail closed and do not mark unknown side effects as handled                                                                          | Worker recovery                   |
| Claim/lease recovery          | Expired claimed run/step rows are inspectable and reclaim only when eligible, with SQLite row evidence                                                                  | Lease recovery                    |
| Internal session handoff      | Resolved session targets move through internal delivery handoff with durable evidence and no external transport claim                                                   | Internal delivery                 |
| External delivery             | Only claimed if the implementation includes external transport delivery and direct proof                                                                                | External transport implementation |

## Required Scenarios

### Disabled Paths Never Mutate

- Run CLI durable stats/list/why commands with durable runtime disabled and a
  fresh state directory; assert a non-success guidance result and no state files.
- Call Gateway durable inspection handlers with disabled runtime; assert
  `INVALID_REQUEST`, no result payload, and no SQLite files.
- Repeat with an existing non-durable state DB; disabled inspection must not add
  durable migration or runtime tables.

### Runtime Opt-In Without Worker Mutation

- With durable runtime enabled and no worker flag, verify inspection can open the
  shared SQLite store and project existing records.
- Seed running/open records, start Gateway/runtime, and assert records remain
  running/open when worker recovery is disabled.
- Assert default prompts do not gain durable orchestration guidance unless
  durable runtime or explicit policy is enabled.

### Wake And Owner Attention

- Seed wake reasons including `child_terminal`, `fan_in_incomplete`,
  `restart_interrupted`, `delivery_unknown`, `side_effect_uncertain`,
  `no_handler`, and `operator_requested`.
- Assert legal transitions: `pending -> delivered`,
  `pending|delivered -> acked`, `pending|delivered -> failed`, and
  `pending|delivered|failed -> superseded`.
- Assert duplicate wake creation from repeated child completion, worker scans,
  Gateway reports, and result-mailbox replay dedupes by key.

### Restart And Side-Effect Uncertainty

- Inject failures before and after tool dispatch, provider return, channel send,
  child spawn, and local commit boundaries.
- Assert recovery appends uncertainty facts such as `unknown_after_side_effect`,
  `interrupted_during_tool`, `lost_after_dispatch`, `delivery_unknown`, or
  `requires_owner_decision`.
- Assert automatic replay is denied while uncertainty is unresolved unless replay
  gates prove authority and idempotency.

### Privacy, Retention, And Compaction

- Default persistence stores refs, hashes, bounded previews, and structured
  metadata, not raw prompts/tasks/tool payloads.
- Full input capture requires explicit opt-in and inspection authorization.
- Compaction preserves enough run, step, event, ref, claim, and recovery data to
  explain state while removing or truncating sensitive previews.

## Live Proof Policy

Runtime changes must include local or remote tests for their touched surface.
Live OpenClaw E proof is required only when the change claims runtime, session,
wake, worker, or delivery behavior that local tests cannot prove with
maintainer-grade confidence. Docs-only changes can state that live proof is not
applicable when they claim no runtime behavior.

## Related

- [Durable Core 2026.7.1 Release Architecture](/specs/durable-core-beta3-architecture)
