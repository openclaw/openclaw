---
title: Durable Core Beta 3 Test Plan
summary: "Maintainer-grade proof matrix for the cumulative beta 3 durable runtime stack."
read_when:
  - Planning exact-head durable runtime proof
  - Auditing durable runtime merge readiness
  - Converting reviewer concerns into tests
---

# Durable Core Beta 3 Test Plan

This plan turns the durable-core architecture into exact-head proof expectations
for the cumulative beta 3 stack. PR1 adds this plan as a review anchor only; it
does not require runtime proof because it does not change runtime behavior.

## Scope

The plan covers the opt-in, local-first durable runtime substrate: storage,
runtime facts, recovery diagnostics, wake/attention obligations, internal
handoff, inspection, and safe owner controls. It does not require product UI,
Workboard or Task Flow authoring, distributed scheduling, automatic semantic
replay, or external channel delivery.

## Exact Head Rules

- Run proof on the PR head being reviewed, not only on a downstream cumulative
  branch.
- Record branch, base SHA, parent PR head when applicable, current head SHA,
  diff range, and command output or log path.
- Re-run affected proof after every rebase or descendant fix.
- PR5 proof cannot substitute for PR2, PR3, or PR4 proof.
- Docs map and generated artifacts must be regenerated in the beta 3 tree with
  repo scripts, not copied from another worktree.

## PR1 Gate

| Check         | Required proof                                                            |
| ------------- | ------------------------------------------------------------------------- |
| Scope hygiene | `git diff --name-status <base>..<head>` shows docs/spec/test-plan only    |
| Docs map      | `node scripts/generate-docs-map.mjs --check` or equivalent docs-map check |
| Docs syntax   | docs MDX/lint/format checks available in the beta 3 tree for touched docs |
| Diff hygiene  | `git diff --check <base>..<head>`                                         |
| Ancestry      | `git merge-base --is-ancestor <base> <head>`                              |

PR1 body language must state that live proof is not applicable because the PR is
docs-only and claims no runtime delivery behavior.

## Cumulative Proof Matrix

| Area                          | Required proof                                                                                                                                                          | Owner PR                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Disabled-path no mutation     | CLI and Gateway durable inspection reject before creating SQLite, WAL, SHM, migration, or durable tables                                                                | PR2                                     |
| Runtime opt-in                | Durable recording and inspection are inert by default and enabled only by explicit durable runtime config                                                               | PR2                                     |
| Worker separate gate          | Runtime-enabled startup records only allowed facts; worker recovery requires separate worker opt-in                                                                     | PR2                                     |
| Future schema fail-closed     | Newer durable schema versions fail before DDL, ALTER, backfill, worker mutation, or projection mutation                                                                 | PR2                                     |
| Terminal immutability         | Terminal runs, steps, and wake states reject claim, heartbeat, checkpoint, output, error, delivery, ack, retry, and facts rewrites except retention/compaction metadata | PR2 and descendants                     |
| Identity propagation          | Chat, `agent.run`, user turns, embedded-agent yield, task completion, and status notices carry stable durable refs                                                      | PR2/PR3                                 |
| ACP/manual-spawn preservation | ACP manual-spawn child turn task suppression remains intact; plugin-subagent precedence and CLI fallback still work                                                     | PR2/PR3                                 |
| Pairing QR regression         | Webchat pairing QR display remains visible without persisting sensitive QR content                                                                                      | PR2/PR3 when adjacent paths are touched |
| Wake target resolution        | Owner, parent, peer, scheduled, Task Flow, external route, missing, unauthorized, and ambiguous targets resolve or fail closed with inspectable evidence                | PR3                                     |
| Wake queue contract           | Wake records include stable ids, target refs, reason, facts refs, dedupe key, attempt fields, ack/failure fields, and lifecycle state                                   | PR3                                     |
| Replay authority              | Automatic replay is denied unless operation registry, input material, idempotency, side-effect class, dedupe/CAS or reconciliation, and retention gates pass            | PR3                                     |
| CLI/Gateway inspection        | Read APIs expose runs, facts, wake queue, unresolved obligations, and uncertainty without worker mutation                                                               | PR4                                     |
| Owner controls                | Acknowledge, supersede, owner decision, retry request, abandon request, and resume request are caller-invoked audited facts                                             | PR4                                     |
| Worker no-handler behavior    | Empty registry and no-handler rows fail closed and do not mark unknown side effects as handled                                                                          | PR5                                     |
| Claim/lease recovery          | Expired claimed run/step rows are inspectable and reclaim only when eligible, with SQLite row evidence                                                                  | PR5                                     |
| Internal session handoff      | Resolved session targets move through internal delivery handoff with durable evidence and no external transport claim                                                   | PR5                                     |
| External delivery             | Only claimed if the implementation includes external transport delivery and direct proof                                                                                | PR5 or follow-up                        |

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

Runtime PRs must include exact-head local or remote tests for their touched
surface. Live OpenClaw E proof is required only when the PR claims runtime,
session, wake, worker, or delivery behavior that local tests cannot prove with
maintainer-grade confidence. PR1 intentionally has no live proof section beyond
stating that live proof is not applicable for docs-only scope.

## Related

- [Durable Core Beta 3 Architecture](/specs/durable-core-beta3-architecture)
