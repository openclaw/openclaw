---
summary: "Session scheduling ownership, input custody, and retained settlement"
read_when:
  - Changing turn admission, queueing, stopping, or session mutations
  - Writing model-based tests for session lifecycle interleavings
title: "Session controller"
---

A session controller is the owner of **which turn may use a session next**. It
coordinates accepted inputs, the current turn, and admission barriers. It is not
a replacement for runtime execution authority, database write fencing, or
process-wide concurrency limits.

The in-memory implementation extends the reply-operation owner rather than
adding another session scheduler. Gateway, channel, direct-native, maintenance,
and lifecycle adapters share that owner. Gateway protocols and stored data remain
unchanged; a durable mailbox is a separate storage change. Harness attempts must
run under host or controller admission before registering a session-keyed native
run; see [Harness attempt runtime](/plugins/sdk-agent-harness/attempt-runtime)
for the SDK migration.

For operator-facing queue settings, see [Command queue](/concepts/queue).

## Implementation owners

The retained entries in `src/sessions/session-controller.state.ts` own physical
session identity, the active operation, its native attempt, mailbox, lifecycle
effects, waiters, and successor barriers. Exact-instance indexes project these
facts; they do not independently grant a turn.

- `session-controller.mailbox.ts` selects both reply inputs and direct-native
  tasks. Preparing inputs reserve their order before payload preparation. Queue
  adapters retain debounce, overflow, batching, and delivery policy, not another
  runnable list.
- `session-controller.admission.ts` reserves a turn before native execution.
  Nested preparation and compaction borrow the captured operation or unbound
  claim, rather than waiting behind their own turn.
- `session-controller.lifecycle.ts` owns mutation admission and subordinate
  physical effects. A stored incarnation can be bound after guarded row creation;
  a logical key is never used as a fabricated physical store or session ID.
- `session-controller.stop.ts` sequences captured cancellation effects.
  `session-controller.watchdog.ts` owns progress, real waits and deadlines,
  recovery deduplication, and retained cleanup for each exact operation.
- `session-controller.rpc-sources.ts` owns protocol-run-ID correlation for
  Gateway RPC inputs. The source input owns cancellation and custody; the
  operation owns execution and deadlines; Gateway adapters retain only
  protocol presentation and delivery metadata.

`reply-operation-state.ts` remains the pure phase and terminal-outcome reducer
used by real operations. Generated traces compare real controller behavior with
independent reference models; boundary tests cover native attachment, source
injection, Stop, mutations, and raw settlement. Failure output retains seeds and
event prefixes. Automatic trace shrinking is not implemented.

## Identity and ownership

A logical session key, a stored session incarnation, a reply operation, and a
backend attempt are different identities. Reset can replace a stored session;
retry can replace a backend without starting a new user turn. Aliases can refer
to the same stored session. Physical store scope matters for mutations.

A captured operation or attempt is the target of delayed cancellation, steering,
and completion. Never rediscover a successor by session key when an earlier
operation finishes. Generation checks remain necessary even without a Gateway
restart: old callbacks can outlive reset, permission changes, or replacement.

The controller entry is the scheduling owner. Runtime handles provide
capabilities to its current operation; they cannot grant a second session slot.
Physical store scope participates in selection, so identical logical keys in
different stores remain independent. An ambiguous key-only query never chooses
one arbitrarily.

The global lane and capacity groups continue to own concurrency across sessions.
Per-session native command lanes no longer select turns. Database and
worker-placement owners still validate their own authoritative claims immediately
before effects, and global capacity remains held until actual execution settles.

## Statechart

These are conceptual scheduling phases, not new values in the Gateway protocol:

| Phase       | Meaning                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`      | No turn owns the session slot. Outstanding admission barriers can still prevent a successor.                                             |
| `admitting` | A turn owns the slot and waits for deferred maintenance or global capacity.                                                              |
| `preparing` | The turn performs preflight compaction or a memory checkpoint before inference.                                                          |
| `running`   | The backend is active. Streaming, compaction, tool work, and human-input waits are capabilities or activity facts, not alternate owners. |
| `finishing` | The backend has committed its terminal outcome and ordinary user cancellation can no longer replace it.                                  |
| `settling`  | Cancellation, delivery, persistence, or cleanup still has an outstanding owner.                                                          |
| `mutating`  | A lifecycle mutation holds the session against competing work.                                                                           |

A mailbox exists independently of these phases. So do exact identities of
outstanding effects. Requesting cancellation is not cancellation completion;
releasing the scheduling slot is not proof that every old writer has settled.

A failed or cancelled run reports its outcome to its caller. That outcome alone
does not fail source settlement. User Stop acknowledges cancellation after its
persistence, command hooks, required command and MCP cleanup, queued-input cancellation
notification, and child cleanup. It does not wait for raw preparation or the active
producer to return. The controller retains that work's custody and fences the next turn
until it settles; source cleanup and registration removal also wait for that drain.
Lifecycle drains still join retained work and cleanup. Failures from registered persistence
or cleanup reject the retained settlement receipt.

Do not replace all queries with one interchangeable Boolean. Derive distinct
answers from authoritative facts:

- **Slot owned:** another turn cannot acquire this slot.
- **Admissible:** the slot and the relevant mutation and successor barriers permit work.
- **Execution active:** a concrete backend owns execution.
- **Injectable:** that backend accepts this input under its current authority and capabilities.
- **Abortable:** this exact operation still accepts the requested cancellation source.
- **Settled:** the owning delivery, persistence, and cleanup work has finished.

Queued requests must not appear as executing runs or inherit an active run
timeout merely because they have a client-visible run ID.

Successor admission waits for producer completion, its handoff, and source
cleanup. Pure delivery can then await a new visible or direct turn without
forming a settlement cycle. Heartbeats and queued follow-ups still respect the
delivery barrier and its timeout policy. The prior operation's `ownerSettlement`
continues to wait for actual delivery. A Stop that already captured that operation
keeps its settlement wait, and lifecycle mutations retain the outstanding work
even after the turn slot becomes available.

## Inputs and custody

Inputs include channel messages, Gateway user turns, agent RPC turns, scheduled
wakes, heartbeats, subagent completion handoffs, and restart-recovery resends. Adapters retain each input
owner's authentication, visibility, routing, idempotency, and acknowledgment
contract; a common scheduling interface does not make those inputs equivalent.

A subagent completion, a settled `sessions_yield` batch, or a paused child's
notice is one input on the requester session, keyed by a stable reservation ID.
The subagent registry keeps the durable obligation and decides whether it is
owed; only the mailbox decides when it runs. See
[Subagent yield handoff](/concepts/subagent-yield-handoff).

Stop and lifecycle requests are control events. They must not wait behind the
work they are supposed to cancel, or be dropped by ordinary mailbox overflow.

For each accepted input, retain identity and custody through these boundaries:

1. Accepted by the source owner.
2. Waiting, being injected, or claimed by a new turn or collect batch.
3. Confirmed consumed, deliberately dropped, cancelled, interrupted, or
   retained with an explicitly uncertain commitment.

Runtime acceptance and transcript commitment are separate facts. A failed or
lost confirmation after possible commitment does not make an input safe to
replay. Collect batches and overflow summaries retain their contributing input
identities so cancellation, attribution, and recovery still target the sources.

A model effect is an instruction to attempt work, not evidence that it happened.
Its completion or failure returns as an event bound to the same input, operation,
attempt, and generation. Live permission checks run again at the final effect.

## Queue policy

Queue settings retain the existing debounce, cap, drop, and route-isolation
contracts in [Command queue](/concepts/queue#queue-options).

| Policy      | Contract                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steer`     | Attempt injection into the captured active owner. A definite capability rejection leaves the input queued. An uncertain commitment does not permit replay. |
| `followup`  | Keep FIFO order among waiting inputs and start a later turn after admission barriers permit it.                                                            |
| `collect`   | Combine compatible waiting inputs after the quiet window; preserve individual custody and routing.                                                         |
| `interrupt` | Cancel the captured active turn, prioritize the interrupting input next, and preserve older waiting inputs in relative order after it.                     |
| heartbeat   | Drop a heartbeat while competing session work owns admission; do not create a duplicate turn.                                                              |

An interrupt reserves its priority synchronously before cancellation or any
settlement wait can wake an older drain. Priority belongs to that exact input;
retiring an older interrupt cannot remove a newer reservation. Finishing work
may refuse cancellation, but the reserved successor still waits for its actual
settlement rather than letting older backlog take the slot.

Steering does **not** require token streaming and is not universally forbidden
during compaction. Guarded V2 injection can revalidate dispatch during compaction;
legacy handles and runtimes that reject that capability still queue the input.
The runtime owns whether a particular native turn accepts steering. A request
to wait for transcript commitment is refused unless the backend declares
`supportsTranscriptCommitWait`.

In-process steering (`sessions_send`, the embedded TUI, Talk, and the SDK
`queueAgentHarnessMessage`) uses the same path as channel input. The caller
reserves a steer input on the exact turn's own mailbox. That input waits until
each older input is accepted by the native owner, claimed, or settled, then
injects into the turn it captured. It does not wait for an older steer's
transcript commit, which can depend on later input such as a question's answer.
A refusal retires the reservation and leaves the caller's own fallback in charge.
A detached attempt has no turn, so nothing can steer it.

Collecting or steering requires compatible sender authority, tool permissions,
visibility, and delivery contracts. Mismatch must not let an input borrow the
active turn's or newest sender's permissions.

## Stop semantics

At ingress, a stop operation captures the physical session target and active
run instances before asynchronous preparation. After preparation and live
authorization, a session-wide Stop selects that target's current pending inputs
once, immediately before cancellation. This includes inputs queued during
preparation; arrivals during cancellation callbacks or after selection belong to
a later Stop. The entry point renders the result; the operation owns this policy
table:

| Source                                                         | Active run                         | Waiting inputs of the session    | Controlled subagents                         | Abort cutoff                            | `command:stop` hook |
| -------------------------------------------------------------- | ---------------------------------- | -------------------------------- | -------------------------------------------- | --------------------------------------- | ------------------- |
| `channel-user` (fast path, `/stop`, bare stop word)            | Abort                              | Cancel all                       | Stop                                         | Record when the message has an identity | Fire once           |
| `client-session` (`chat.abort`/`sessions.abort`/`/acp cancel`) | Abort                              | Cancel all                       | Stop; preserve `cascadeDescendants` behavior | Skip                                    | Fire once           |
| `client-run` (client abort with one run ID)                    | Abort only when that run is active | Cancel only that input if queued | Stop that turn's subagents                   | Skip                                    | Fire once           |
| `talk` (key-only Talk voice cancel)                            | Abort                              | Keep                             | Stop that turn's subagents                   | Skip                                    | Fire once           |
| `mutation`                                                     | Per mutation                       | Per mutation                     | Per mutation                                 | Skip                                    | No                  |
| `interrupt`                                                    | Abort                              | Keep                             | Keep                                         | Skip                                    | No                  |
| `restart`, `operator-revocation`                               | Abort                              | Cancel selected pending inputs   | Keep                                         | Skip                                    | No                  |
| `watchdog`, `supersede`                                        | Abort                              | Keep                             | Keep                                         | Skip                                    | No                  |

A Stop that targets a subagent session with no running turn, but with a paused
(`sessions_yield`) or queued registry row, kills that exact row. The kill retires
the row's owed inputs; a later follow-up registers its own obligation.

The SDK `abortAgentHarnessRun` and `abortAndDrainAgentHarnessRun` stop a turn
as `interrupt`. A detached attempt has no turn and keeps its native abort.
Session-wide Stop also includes named, visible session effects and checks the
requester's current authority before each cancellation; detached attempts stay
outside session Stop.
`supersede` refuses a backend that already reports itself stopped or aborted, so
that turn keeps its own terminal outcome.

A turn that calls `sessions_yield` refuses steering from that point, but it still
owns its session, run IDs, and children until it settles, and only then records
an internal `yielded` result. The public harness operation keeps its existing
`running` phase until settlement, then reports `completed`. A Stop or reset that
lands first still aborts the backend; it, or a failure, replaces the yield as
the turn's result.

A run whose abort is frozen is already finalizing and refuses active
cancellation. Session-wide user Stop still performs independent queue cleanup,
controlled subagent stopping, and one `command:stop` hook. An exact `client-run`
Stop cancels descendants only when its captured parent accepts cancellation;
a finalizing parent retains its children. Cancellation already committed by the
controller stays accepted if a backend observer throws. The operation captures
child generations before asynchronous work, applies the parent capture before
the hook, and exposes settlement for every captured owner.

Authorization policy belongs at ingress, but its live host-owned assertion travels
with delayed effects. A source label, run ID, or `clearWaiting` flag is not
authorization. Revalidate after waits and immediately before cancellation.

Delayed active cancellation of operation A cannot retarget its successor B.
Exact-source cancellation remains restricted to its captured input; it never
selects later session inputs. Session-wide Stop selects pending work at the
boundary described above. Watchdog expiry needs a distinct finalization/cleanup
transition rather than repeatedly calling a user stop that will refuse.

## Lifecycle mutations

Reset, delete, and manual compaction preempt through Stop with source `mutation`:

| Mutation                                             | Active run              | Waiting inputs | Controlled subagents |
| ---------------------------------------------------- | ----------------------- | -------------- | -------------------- |
| Reset (`/new`, `/reset`, `sessions.reset`, rollover) | Abort                   | Cancel         | Stop                 |
| Delete (`sessions.delete`)                           | Abort                   | Cancel         | Keep during preempt  |
| Manual compact (`/compact`, `sessions.compact`)      | Abort only if abortable | Keep           | Keep                 |

Delete retains its later lifecycle cleanup, which stops controlled subagents after
preemption. Sharing and access mutations can allow live execution, while background
result commits wait.

A mutation closes competing admission, targets exact current owners, waits for
real settlement, and then acquires its mutation boundary. In-band commands must
not wait for their own admitted stack, and a mailbox clear they request does not
select their own claimed input. Restart drain cancels waiting inputs while claimed
inputs and in-flight steering remain with their active producers. Shutdown waits
for those producers or aborts them with the typed restart reason used by recovery,
including the turn that requested the restart. A mutation body that owns no turn
and requests one for its own session, such as
`sessions.compact` or a native `/compact`, receives that turn under its own fence,
ahead of the inputs it keeps waiting. Mutations queued behind it do not block that
turn; admission closures and retained foreign operations still do. Multi-identity
and cross-store ordering belongs to the lifecycle owner.
Physical transaction, writer, and worker-placement fences remain subordinate
effect custody, not competing turn selectors.

Preemption settlement is bounded to 15 seconds by default. The bound covers Stop,
captured effects, and retiring sources, but not the mutation body. Expiry rejects
with `SessionMutationPreemptTimeoutError`; adapters preserve their existing RPC or
command timeout result.

An interrupted lease is not a released writer. Clearing a slot or expiring a
wait cannot authorize reset or deletion while old write-capable work remains
live. Failed cleanup retains its fence and an actionable outcome.

## Liveness and restart

Global-capacity waits, deferred maintenance, pending human questions, tool and
retry deadlines, and backend-owned work are not interchangeable with missing
progress. Watchdogs consume owner-held progress and deadlines, preserve healthy
waits, and target the exact operation observed. Incoming user messages alone must
not perpetually renew a stuck run's progress clock.

A bounded recovery claim assumes the scheduler and clock can run. The watchdog
requests Stop for stalled execution through the captured cancellation kernel.
Frozen finalization instead has a distinct cleanup transition that preserves
the committed outcome. Once a cancelled producer has a terminal outcome, its
cleanup deadline may retire that exact operation's slot only after revoking the
producer's exact persisted transcript-writer claim. The writer guard then rejects
late persistence before a successor can be admitted. A producer with no persisted
fence, a failed revocation, or cleanup work that never returns keeps the slot and
reports the session as blocked; the user can continue in a separate session, and
the operator can restart the Gateway to terminate the process-local writer. No
in-process statechart can guarantee recovery from a blocked process by itself.

The controller mailbox is process-local; it does not introduce a new replay or
storage contract. Existing durable recovery owners retain interrupted work,
input identity, delivery receipts, and retry decisions. Eligible unfinished tasks
resume through the same mailbox after restart with fresh execution authority.
Explicit Stop remains terminal, and an unknown side-effect outcome is reported
for inspection rather than mechanically replayed. Durable channel ingress keeps
its own recovery contract. See [Restart recovery](/gateway/restart-recovery).

If durable recovery already holds a preclaim, active claim, or terminal result
for the same requester-completion input, restoration reuses that custody instead
of reserving a second mailbox input. The completion owner keeps the durable
obligation until it reconciles the final delivery result. Unrelated inputs
retain their FIFO order and current-authority checks.

A later durable mailbox must reconcile these existing custody owners, specify
retention and upgrade/rollback behavior, and distinguish queued from possibly
consumed input. It requires a separate storage review. See
[Input durability](/concepts/queue#input-durability).

## Invariants and verification

The controller and its adapters must preserve:

1. At most one current scheduling owner per canonical session identity.
2. Every accepted input remains accounted for, including merged and uncertain inputs.
3. Captured active cancellation and late effects cannot act on a successor or replaced generation.
4. At most one successor is admitted after the required outcome and settlement barriers.
5. Mutations exclude competing turns and retain write-capable work until actual settlement.
6. All scheduling queries read the same owner; presentation and capabilities remain explicit projections.
7. Recoverable stale state has a bounded recovery path under the stated scheduler assumptions.
8. Queueing, batching, retries, and deferred effects never expand the original authority.

Use a small independent model and run the same event traces through a real
implementation adapter. A model tested against itself is not migration proof.
Control asynchronous effect completion separately from event arrival, use a fake
clock, report a reproducible seed and minimized failing trace, and retain focused
regressions for known failures. Include delayed and rejected cleanup, stale
callbacks, reset during admission, compaction steering, and interrupted backlogs.

Pure model tests do not replace boundary proof for Gateway/channel adapters,
durable writes, or native runtimes. Each cutover states which invariants its
adapter actually exercises, which owners it removes, and which remain. Measure
test time and production changes instead of treating a projected deletion count
as an acceptance target.
