---
summary: "Proposed transferable authority contracts for SQLite writer admission"
read_when:
  - Moving SQLite writer admission off the Gateway main thread
  - Changing an authority owner used by session or agent database writes
title: "Writer admission authority"
---

# Writer admission authority

This program moves bundled writer admission to one dedicated worker while preserving
current authority, FIFO ordering, final host COMMIT authorization, and receipt
settlement. No schema, persistence, configuration, or update migration is proposed.
Restart reconstructs process-local authority through the existing owners.

The bottleneck is host scheduling, not the cost of a Boolean check. A traced
`chat.send` ACK spent 673 of 765 ms waiting for admission; the preceding change
measured ACK p50/p99 of 1,209/1,693 ms with 20 senders
([prior measurement](https://github.com/openclaw/openclaw/pull/170376)). A feasibility
probe answered from shared state in 0.064 ms but incorrectly granted after policy
revocation. Forwarding the live callback instead waited through a 200 ms host
stall. Those diagnostic observations justify transferring authority ownership
contracts; they do not predict production latency.

The first slice transfers profile revision/status checks through shared cells and
adds a read-only admission service test factory in
`src/infra/sqlite-writer-admission-service.test-support.ts`. Bound and
current-settled operations use the same canonical state as host assertions.
The factory is exercised through real worker tests; production dispatch stays
with the host until remaining dependencies can transfer. A measured intermediate
host-to-service preparation detour added latency and was removed.
Native publishers fence immediately before physical COMMIT; known rollback
preserves the prior revision, while uncertain native outcomes stay fenced.
Retired generations never revive through delayed descriptor delivery. First
creation retires unresolved profile authority even when the database admission
itself remains valid across path-to-file identity promotion. The lifecycle
publishes that promotion through its existing shared integrity revision before
changing identity, including worker-only creation and alias reconciliation. The existing
worker-task owner handles service failure, termination and restart.

This slice transfers no policy payload or native write grant. Descriptors retain
their exact shared buffers directly, so no service registration map can reclaim
or substitute a generation. Mixed physical/request/run authority, final host
COMMIT and settlement remain on their existing path. Descriptors also retain the existing shared admission-revocation cell, so
worker-only close refuses reads before asynchronous drainage. Service reads do
not certify the remaining physical custody still checked by the host. Later owners must supply those
contracts and native-to-service transport before transaction admission can bypass
the host.

The broker slice makes slot and request custody canonical shared state. Dispatch,
queued cancellation, completion, failure and native retirement publish to the same
retained cells before replacing current work or notifying observers. Accepted
cancellation preserves dispatch history and receipt settlement. Native stages check
those exact cells before requesting host admission and after consuming its grant;
a late descriptor cannot reacquire authority through a reused numeric request ID.

The service test helper also exposes a direct native-port custody check with a bounded wait.
Expiry atomically closes the pending decision, so a delayed service reply cannot
grant it. Service shutdown revokes its epoch before awaiting cleanup; replacement
uses a fresh cell. This transport remains a prerequisite exercised by worker tests:
mixed production admission still uses the host and does not add a second service
round trip until the remaining owners can transfer. It grants only broker custody,
never policy authority, native COMMIT or receipt settlement.

The execution slice gives each logical owner, native generation and borrower its
own shared lifetime. Logical close publishes `closing` before cleanup and can
reopen after failed cleanup; revocation and native retirement remain permanent.
Borrower release closes new calls and claims, while accepted operations retain
logical/native custody through settlement. Warm operations carry those exact
cells and their admitted physical identity to native stages and the service.
Cold creation, readiness, deletion and policy still require their host owners;
the service transport remains unbound to mixed production admission.

## Current owners and required transfers

Source locations below refer to commit
`4ca02f6c720e6346a0d57b158cc38484fdf5c8da`; paths start at `src/`.
Admission composes these owners; none alone authorizes a write. Each row names the
current read, mutation boundary, and proposed transferable facts.

| Owner and source anchor                                                                                                                                                                                                                  | Current facts and mutation points                                                                                                                                            | Transfer contract                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Physical admission: `infra/sqlite-database-admission-record.ts:16–84,153–201`; `infra/sqlite-database-admission.ts:565–639`                                                                                                              | File identity, format/schema facts, write revision, exact generation and references; fact invalidation, metadata retirement, explicit retirement before descriptor close.    | Reuse existing identity/generation/shared cells and open-time retention. These establish physical custody, never user authority.                                                                                                           |
| Logical/native execution: `state/openclaw-agent-execution-owner.ts:136–152,327–387,492–503,582–605`; `state/openclaw-agent-execution-native.ts:119–127,640–641`                                                                          | Current owner/scope, deletion and creation guards, native availability, borrower lifetime; release, close and revoke become effective before awaited cleanup.                | Separate logical, native, borrower and creation/deletion references. Publish closed state before each transition; retain accepted work through native settlement.                                                                          |
| Creation/deletion: `state/agent-creation-claim.ts:68–106,158–175`; `state/agent-deletion-cleanup.ts:98–132,176–191,314–343`; `sessions/session-agent-work-admission.ts:41–88,112–138`; `state/agent-deletion-journal.ts:410–454,486–564` | Exact creation/cleanup scope, physical target, lease, journal operation and phase; release, deletion handoff, completion/removal. Ingress closes before journal publication. | Exact claim/lease/journal references and activity revisions. Invalidate before mutation; retain failed cleanup. Only the same live creation claim may bypass its completed tombstone.                                                      |
| Agent readiness: `state/agent-database-admission.ts:276–348,383–395`                                                                                                                                                                     | Per-store/per-agent refusal and temporary preparation scope; refusal replacement, successful preparation and scope close.                                                    | Exact refusal/preparation generation. Only its live preparation scope may bypass that pending refusal; invalidate before replacement.                                                                                                      |
| Broker request: `infra/sqlite-worker-broker-reply.ts:58–70,195–229,545–570`                                                                                                                                                              | Exact slot/job, dispatch state, cancellation, maintenance and access; current-job replacement and slot failure.                                                              | Shared job identity/state and applicable cancellation. Post-dispatch caller abort must not silently abandon accepted writes.                                                                                                               |
| Shared lifetime/maintenance: `state/openclaw-state-db-async-lifecycle.ts:139–159,197–205,412–423,474–483`; process/schema custody: `infra/gateway-state-owner.ts:145–153,343–385,452–455,627–662`                                        | Captured shared generation, integrity seal, parent/caller admission, maintenance phase, process lock and schema lease; invalidation, closing, custody loss/release.          | Generation/phase and exact lease references; typed schema preparation. Existing physical verifier publishes loss before mutation. A pathname, heartbeat or expiry alone grants nothing.                                                    |
| Request/device source: `gateway/device-revocation.ts:135–179,217–241,285–301`                                                                                                                                                            | Request versus accepted source, references and revocation; acceptance, device invalidation and owner close.                                                                  | Distinct request/source cells and acceptance state. Preserve accepted source custody across disconnect or tentative transport changes; committed source revocation still denies.                                                           |
| Run/claim: `infra/agent-run-registry.ts:360–501`                                                                                                                                                                                         | Exact operational instance, claim, lifecycle and composed source; same-ID replacement, release and failure after source assertion.                                           | Exact claim/lifecycle references plus typed source assertion; recheck after policy evaluation. Same run ID cannot revive an old claim.                                                                                                     |
| Operator: `gateway/operator-run-authority.ts:127–158,284–486`                                                                                                                                                                            | Gateway/source identity, scope, profile, assignment, role and model ceiling; source/assignment/policy changes permanently revoke capture.                                    | Captured ceiling plus current profile/config/plugin-metadata revisions and source references. Preserve original/current model-policy intersection and retained continuation lifetime.                                                      |
| Profile: `state/user-profile-events.ts:149–177,213–364`; `state/user-profile-list.ts:236–307`                                                                                                                                            | Profile, identity, channel and account-link revisions, pending/uncertain mutations, committed catalog; pre-COMMIT fencing and native settlement.                             | Per-store/per-key cells plus immutable facts. Preserve exact-bound reads versus current-settled reads; unknown outcome never reopens authority on timeout.                                                                                 |
| Session/sharing: `gateway/session-access-authority.ts:257–331`; `gateway/session-row-projection-generation.ts:92–145`; `gateway/session-row-membership-read.ts:215–235`                                                                  | Projection/store/generation, session ID/lifecycle, readiness, membership and related policy; replacement/removal, sharing and membership changes.                            | Exact session references plus readiness/membership revisions. Pending is retryable without retirement; identity mismatch or non-pending denial permanently retires the capture. Fence writers before their effects, not from later events. |
| Config/tool policy: `config/runtime-snapshot.ts:230–242`; `gateway/server-reload-managed.ts:341–346`; `gateway/session-resource-tool-policy.ts:37–116`                                                                                   | Current config/role, selected model, lineage, plugin metadata and sandbox policy; config activation currently precedes notifications.                                        | Immutable prepared inputs plus publisher-owned revisions. Invalidate before activation; preserve locked-model denial and sandbox equality. Event subscriptions cannot establish this ordering.                                             |
| Caller preparation: `config/sessions/session-actor-sqlite.ts:113–150`; `config/sessions/session-entry-patch.ts:84–129`; `config/sessions/session-turn.ts:218–257`                                                                        | Accepted/current assertions, native observation, authorization, cancellation, mutation guards, source alternatives and pending-input custody.                                | Typed operations over the transaction preimage, preserving order, return values, refusals and bookkeeping effects; never serialize only the last allow/deny answer.                                                                        |
| Native settlement: `infra/sqlite-worker-operation-settlement.ts:104–143`; `infra/sqlite-worker-broker-reply.ts:596–691`                                                                                                                  | Actual post-COMMIT receipts, completion/unknown outcome, native exit and publication before reply.                                                                           | Keep existing host owner and transport. Revocation blocks new work, not observation of an already committed receipt.                                                                                                                       |

## Shared publication and retention

Each owner exports an immutable descriptor containing its kind, process epoch,
exact identity/generation and retained dependency references. Each mutable
subject has owner-written atomic cells: revision, status (`ready`, `pending`,
`uncertain`, `revoked`) and the existing lifetime/reference state. Variable-sized
policy facts travel as immutable revision-tagged messages. The service stores
those payloads as a projection; the shared cells remain canonical. Missing,
partial or mismatched revisions refuse or return the owner's existing retryable
pending result. Use non-reused generations; retire before counter wrap.

Publication order is mandatory:

1. Prepare replacement facts without exposing them. Synchronously invalidate the
   old revision/status **before** changing authoritative state or granting the
   native effect that changes it. Preserve owner-specific rollback semantics:
   permanent retirement stays permanent; aborted tentative config activation
   must not revoke an accepted source that remains current.
2. Perform the mutation under the current owner. Preserve pending/uncertain
   distinctions until native settlement establishes the result.
3. Install new immutable facts in the service, then let their original owner
   publish the matching ready revision after installation acknowledgment.
   Delayed payloads cannot overwrite a later revision. Unrelated
   keys stay valid; no per-write registry rebuild or filesystem polling.

A reader loads all dependency revisions/statuses, evaluates the typed operation,
then rechecks all of them as one attempt before publishing its decision. The
writer's final check of those references immediately before the native stage is
that stage's authority linearization point. A revocation observed at either
boundary denies; later revocation retains today's next-boundary/rollback
semantics. Final host COMMIT
revalidation remains mandatory. This is not a durable capability or permission
to use a prior answer after an await.

The proof obligation for **each** owner is a complete writer inventory: all
paths that change a consumed fact must invalidate first, including worker
COMMIT, config activation, deletion, repair and shutdown. A post-change listener
cannot satisfy it. Publish a pending revision before an effect whose result is
not yet available; stalled publication may delay work but cannot grant stale
work. Test the actual publisher, not a synthetic revocation helper alone.

Retain physical generations using the open-time reconciliation in
[the retention repair](https://github.com/openclaw/openclaw/pull/170423): keep the
original physical identity, acquire/reconcile the reference before exposing the
handle, balance abandoned references, retry metadata closure only, and reject
explicit retirement or replacement. Integrate that repair before service
cutover; do not duplicate its protocol. Authority descriptors likewise remain
retained by operation custody until settlement and native cleanup, not merely
until a grant/reply. Revocation and memory reclamation are different transitions.

## Service and typed operations

The broker owns one admission worker per Gateway process. It retains the
existing per-database FIFO and sends only the current job, exact dependencies,
stage and transaction facts through private ports. The service owns decision
execution, not SQLite connections, policy mutation, scheduling order or receipts.

Initial operations are `assertBoundRevision` and `readCurrentSettledFacts` for
profile authority. Later owner modules provide `assertRunBinding`,
`authorizeOperatorPolicy`, `authorizeSessionTarget`, `validatePreparedSources`,
`acceptConversationAlternatives` and `authorizePendingInputCustody`. Each has a
closed input/result type and a defined effect owner. Preserve the actor sequence:
accepted/current check → native observation → policy operation → current/accepted
check → grant. Preserve ordered preparation, including planners that await while
holding the foreground FIFO; move it earlier only with equivalence proof.
Transaction-dependent decisions consume the native transaction's preimage.
Bookkeeping required before grant moves to its named owner or completes before
dispatch; it cannot become an asynchronous notification.

Final host COMMIT authorization, native COMMIT, receipt publication and settlement
remain unchanged. Thus host stalls can still delay COMMIT, dispatch and ACK
publication. Measure those separately; this program first removes repeated
admission delivery waits and their FIFO occupancy, not all main-thread latency.
Cold creation/schema preparation stays host-required until its owner is migrated.

Opaque released SDK guards are another explicit host-required case:
`config/sessions/session-source-authority.ts:47–67,127–156` permits arbitrary
synchronous SQLite reads. Keep that adapter and public behavior; migrate all
bundled callers of each typed operation together and delete their old callback
path. An unsupported callback must never fall through to a shared allow snapshot.
Universal SDK off-thread admission requires a separately reviewed public contract.

Service failure must refuse ungranted requests and route dispatched work through
existing native retirement/settlement. A terminated worker cannot publish its own
death, and synchronous waits cannot rely on port-close callbacks. Before cutover,
implement bounded service-response waits: the native waiter atomically expires
its pending request without host scheduling; expiry never grants authority.
The broker supervisor closes the failed service epoch before replacement. Size
the internal wait budget from slow-host measurements; add no user configuration.
Preserve completed receipts; report unknown writes
as unknown and reconcile through the existing owner, never replay automatically.
Replacement uses a fresh service epoch and fresh registrations after old native
custody settles. Gateway crash/restart discards shared memory and rehydrates
canonical persisted state; no authority survives by token or pathname alone.

## Incremental delivery and proof

Land one owner per PR. First transfer profile revisions/status and their existing
pre-COMMIT fence, with a service skeleton exercising those two typed reads.
Keep mixed operations explicitly host-required until every dependency is
transferable; do not claim chat latency improvement from this first slice.
Then migrate broker/execution/maintenance custody, request/run/operator owners,
config/tool policy, and session/sharing/source operations, in that dependency
order. Split each group into its individual owners. Each PR lists callers,
mutation coverage, removed callback code, retained public contracts and measured
cost; earlier PRs remain safe without later ones.

Required adversarial proof uses barriers through real owner paths: revoke during
payload delivery and evaluation; mutate config/membership while the host is
blocked; retain then retire in both message orders; replace the physical file;
reuse a run ID; disconnect accepted versus unaccepted sources; pending/unknown
profile COMMIT; callback-induced revocation; duplicate/delayed grants and receipts;
service/native crash before grant, after grant and after COMMIT. Assert refusal,
permanent versus retryable state, unchanged FIFO ordering, preserved committed
facts and balanced retention. Include process restart and stale-epoch rejection.
Run the retained host path and migrated path against identical contract fixtures.

For every executable slice, use a synthetic isolated Team sandbox and four
preselected A-B-B-A blocks, identical instrumentation/builds, fresh state per run
and no discarded failures. Reuse the writer workload from
[the writer-count measurement](https://github.com/openclaw/openclaw/pull/169800):
20 sessions × five turns, one excluded warmup each, 20 history messages/session,
400 history reads, 100 metadata updates/probe rounds, four subscribers, visible
observer, tool events and control plane. Also repeat the 20-sender `chat.send`
protocol from the prior ACK measurement, preserving its fixture and pacing.

Report admission delivery by stage, FIFO hold/occupancy, queue p50/p95, ACK
p50/p99, main-thread CPU/event-loop delay, service CPU and allocation, successful
operations and refusals. Compare four paired block ratios with uncertainty and
retain failed runs. Expect lower non-COMMIT delivery wait and FIFO occupancy;
no numeric speedup is established by this document. Neutral results within noise
still qualify requested/simplifying changes; added complexity needs demonstrated
benefit. Local validation stays changed-file formatting/lint and a handful of
focused tests; PR CI owns full gates. Benchmarks use only the constrained sandbox,
never production data or normal-validation leases.
