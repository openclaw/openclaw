---
summary: "Proposed worker-owned transcript acquisition and bounded SessionManager working sets"
read_when:
  - Changing which transcript payloads an active session retains
  - Migrating synchronous session history consumers to worker reads
  - Reviewing transcript revision fences, rewrites, or branch navigation
title: "Session transcript working sets"
---

**Status: proposed design.** This page defines a remaining runtime migration;
it does not claim that append eviction or the consumer cutover is implemented.
It adds no configuration option and changes no schema, persisted bytes,
retention, session identity, or permissions.

The stored transcript belongs to SQLite and its existing storage owners.
An active `SessionManager` should retain current context and bounded navigation
facts. Acquiring older history for an operation must not install complete
history into the live manager. See [session state on disk](/reference/session-management-compaction/store)
and [database access in workers](/reference/database-schemas/worker-access).

## Current boundary

Bounded opening already selects raw entries by byte/event budget. The manager's
entry array and ID index share one payload graph, while initial model-context
acquisition hydrates overlapping messages separately. Appends and complete
history hydration can enlarge the resident view beyond its opening budget.
The owners are `session-manager-core.ts`, `session-manager.ts`, and
`session-accessor.sqlite-active-context.ts` under `src/agents/sessions/` and
`src/config/sessions/` respectively.

The manager is legitimately retained by `AgentSession` and active-run callbacks.
Reducing its working set complements correct run teardown; it does not replace
run settlement or allow clearing data that accepted writes still need.

## Resident snapshot

Publish one immutable snapshot containing the target binding, database
incarnation, transcript version, selected leaf/append cursor, admission fence,
and local manager revision. Retain the header, model/thinking settings,
boundary counts, current-context entries, and navigation links only for those
entries and their required omitted-boundary anchors.

The selection preserves custom messages, branch summaries, compaction/reset
retention, tool pairs, replay checkpoints, and prompt-series metadata. Raw and
model views share a frozen payload only when their representations agree;
entry-ID equality alone does not establish equivalence after projection,
redaction, or rewrite. Worker transfer creates receiver-side objects, so a
combined acquisition must avoid sending overlapping raw/model payloads twice.

The snapshot records its byte/event counts and completeness. Arbitrary-history
results remain operation-owned; they never become a second manager cache.
Committed append, suffix replacement, navigation, and rewrite operations must
publish a bounded replacement before notifying observers. Failed writes retain
the old snapshot. A committed write whose publication fails invalidates the
manager through the existing committed-write error path; it is never replayed.

## Proposed asynchronous operations

Extend `prepareSessionTranscriptHydration` and its existing worker owner.
The following names describe proposed internal contracts, not current exports.
`prepareHistoryRead` synchronously captures the bound target, owner incarnation,
`SessionTranscriptContextVersion` (`generation`, `rawSeq`, `updatedAt`), admitted
turn receipt/anchor, selected branch, append cursor, and local manager revision.
Its returned read capability is bound to that live owner:

```ts
type HistorySelection =
  | { kind: "context"; maxBytes: number; maxEvents: number }
  | { kind: "entry"; entryId: string }
  | { kind: "branch-page"; leafId: string; cursor?: string; maxBytes: number; maxEvents: number }
  | { kind: "navigation"; fromId: string | null; targetId: string }
  | {
      kind: "custom-page";
      customType?: string;
      cursor?: string;
      maxBytes: number;
      maxEvents: number;
    };
```

`read(selection, signal)` returns the matching result and captured version.
Context returns shared raw/model payloads and resident facts. Entry returns an
entry or explicit absence. Branch/custom pages return ordered events, counts,
and an opaque continuation; only `complete: true` establishes the end of the
selection. Custom selection preserves historical order and duplicates unless
that custom type already defines a different semantic reducer. Navigation
returns target facts, common ancestor, and bounded labels/child summaries.

Each page validates its version inside the same SQLite snapshot used to read
it. A continuation binds the target, branch, version, and next position; it
never follows the latest active branch. Release each page before acquiring the
next rather than accumulating the entire transcript. Do not hold a SQLite
transaction across provider, plugin, or other asynchronous work. A later page
rejects a changed version; append-tolerant continuation requires separate proof
from the existing read-fence contract, not invented historical snapshot storage.

`prepareRewrite({ replacements, expectedVersion }, signal)` uses stored
source rows and anchors in the existing worker, returning a preparation handle,
source-to-destination mapping, and byte/count deltas. It does not clone a live
manager. `commitRewrite(handle, signal)` rechecks writer authority and source
preconditions through the current writer, then returns committed IDs/version
and bounded replacement context. Cancellation closes unused preparations;
accepted writes retain custody until native settlement, even if their caller
stops waiting. Release handles in `finally` and on owner close or worker exit.

Before returning any result, recheck cancellation and current read authority.
Before publication, also recheck target binding, navigation revision, and
transcript version. A captured token is not current authority. Writes recheck
live authority at transaction admission and immediately before commit. Existing
SQLite admission and foreign-commit freshness rules remain the only owners of
schema and connection validation.

Results distinguish completed selection, exact-entry absence, version conflict,
owner loss, cancellation, and oversized-event refusal. Missing context or a
revoked owner is never an empty successful read. A stale read with no effect
may be reacquired by its operation owner; an uncertain or completed write must
be reconciled through its receipt, never retried as a fresh mutation.

## Oversized entries and cleanup

A strict byte budget cannot simultaneously retain an arbitrary complete row.
`session-manager-retained-data.test.ts` exposes the concrete conflict: a manager
opened with a 4,096-byte budget later appends a 5 MiB custom payload. Synchronous
`removeTrailingEntries` must remove an aborted assistant, preserve that custom
payload exactly, repair its parent, and keep `getEntry` consistent with storage.
Those assertions do not prove that every method is a shipped SDK contract, but
they do establish behavior that unconditional eviction would change.

Do not evict the custom row and report successful zero-removal cleanup from an
incomplete resident suffix. Zero removals requires proof that the selected
suffix has no match. Awaited cleanup must acquire enough version-fenced suffix
facts to resolve the predicate boundary, preserving custom bytes in the storage
owner when the predicate needs no payload. Arbitrary caller predicates that
inspect custom data need an explicit operation-sized acquisition or a versioned
API change; they cannot be serialized into a worker query by assumption.

Oversized raw acquisition must have an explicit result rather than silently
truncating bytes or skipping an event. Preserve existing strict-reader refusal
and model-only overflow projection rules. Any temporary complete-event exception
must be measured separately from the resident budget. Do not impose a new
stored-content cap to make a memory assertion pass.

## Consumer cutover

| Consumer                                        | Required contract                                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compaction                                      | Acquire admitted current context and boundary anchors; preserve the pending user entry and tool pairs. Run hooks/providers without holding SQLite open, commit the marker, then publish committed context/accounting. |
| Replay repair                                   | Locate rejected checkpoints or affected thinking entries at the captured branch/version. Rewrite through the existing owner and remove stale prefix-bound checkpoints from re-appended suffix messages.               |
| Tool-result truncation                          | Build the existing plan from versioned current context, preserving trailing-result policy. Reconcile prompt projections against the committed replacement context.                                                    |
| Suffix cleanup                                  | Resolve the complete predicate boundary through bounded reverse acquisition. Preserve custom/opaque bytes and parent remapping; an incomplete window cannot establish a no-op.                                        |
| Tree navigation and summaries                   | Acquire omitted target/common-ancestor facts without installing complete history. Summarize only the required abandoned path, commit leaf/summary/labels, and publish bounded context.                                |
| Forking                                         | Use the storage owner to copy the selected path; return committed destination identity and bounded context.                                                                                                           |
| Rewrite preparation                             | Replace resident `byId` source assumptions and cloned detached managers with worker-owned source anchors and preparation handles. Preserve pending-input relocation, compaction identity, and side-append topology.   |
| Setup, settlement, guards, and accounting       | Consume admitted current-context snapshots or named latest-marker/boundary facts; do not scan history or maintain independent caches.                                                                                 |
| `ReadonlySessionManager` extension readers      | Introduce an awaited, versioned history capability. Keep identity/current-context facts synchronous; migrate bundled readers and hook preparation together.                                                           |
| `ProviderReplaySessionStateV2.getCustomEntries` | Replace its synchronous generic history requirement through an approved versioned capability; preserve ordering/duplicates and propagate read failures rather than returning empty state.                             |

The pure algorithms in `packages/agent-core` keep explicit prepared inputs.
They do not gain database access or a competing interpretation of boundaries.

## SDK and incognito migration boundaries

Current `ReadonlySessionManager` exposes synchronous entry/branch/tree readers.
`ProviderReplaySessionStateV2` still inherits synchronous `getCustomEntries`;
the [provider migration](/plugins/sdk-migration/how-to-migrate#await-provider-replay-metadata)
adds awaited writes, not awaited history reads. The synchronous readers already
exist in the published stable `v2026.9.5` source. A complete audit of the exported
reader surface and its completeness guarantees remains necessary.
Verify that evidence and obtain SDK-owner acceptance before changing a shipped
signature, completeness guarantee, or compatibility window. A legacy complete
synchronous-array contract cannot also promise universally bounded residency.
Do not silently redefine it as a partial window or keep an internal twin without
a verified public contract and removal boundary.

Production incognito continues to use its exact process-owned database until
the existing shared-worker migration activates. Never open another
`:memory:` database to satisfy a read. Capture the current owner and reject its
closure/replacement. This design does not activate that migration or change
incognito expiry, restart loss, or retention.

## First slice and completion evidence

Start with worker-owned rewrite acquisition and committed-context publication,
migrating replay repair and tool-result truncation together. Remove their
cloned-manager preparation path; retain compatibility only where the shipped
SDK audit requires it. This private slice does not complete arbitrary tree or
extension history access and must not claim a universal memory bound.

Freeze published stored payloads and use replacement objects for sanitation,
redaction, and explicit rewrites. Eviction only drops references: it does not
edit a published prompt prefix, remove stored events, or change existing stable
prompt refresh rules. Compaction keeps its explicit context-replacement role.

Proof must cover 2k/10k/50k histories, 1,000 committed appends, oversized custom
cleanup, omitted-branch navigation, and rewritten history. Measure manager,
main-isolate, worker, and transient-operation retention separately; test actual
Gateway latency with concurrent sessions and release through real run settlement.
Exercise revision changes, target/authority loss after awaits, incognito owner
closure, cancellation, and commit-before-publication failure. Preserve compaction,
replay, redaction, and prompt-byte behavior. No schema or update migration follows
from these process-local projections; earlier code reads the same stored bytes.
