# Full local continuity spike

This opt-in source-bundled plugin expands the earlier authorization-preview
experiment into runnable, controlled work through isolated OpenClaw Gateways.
It is an experiment, not a settled architecture or a production release.

## Experimental contracts

- Both next-turn and operation-admission consistency are selectable per activity.
  Neither is presented as an agreed product direction.
- Home activity aggregates use the existing OpenClaw keyed SQLite state store.
  Decisions and their dependent admissions share one per-activity transaction.
  No cross-Gateway transaction or universal exactly-once effect is claimed.
- Destination fixtures own their state and create actual synthetic artifacts in
  their own stores. Delivery, admission, execution, and reconciliation differ.
- Real OpenClaw embedded turns and tools run against the maintained local mock
  provider. This is not live model performance or native Codex proof.
- The three-Gateway development harness is a local transport adapter. It does
  not widen Reef friendship into command authority or claim to exercise Reef.
- RPC setup/control is authenticated operator work; the model-facing tool cannot
  choose another activity, author a decision, or grant itself permissions.
- Context policies are source/activity/audience scoped. Shared and private
  retained records use native plugin state. Temporary-context module tests are
  distinct from whole-Gateway retention proof. Personal vault access remains
  unsupported without a real host capability; no boolean simulates authentication.
- Existing grants, generations, bounded record capacity, and lifecycle rules are
  experimental implementation choices documented and tested here, not imposed
  on the broader proposal.

Only task-owned generated QA configuration enables this plugin. No live Gateway,
existing user data, external service, dependency, or schema migration is required.

## Run

From this checkout with its normal dependencies installed:

```sh
node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime
node --import ./scripts/tsx.mjs scripts/continuity-spike/cli.ts --report /tmp/continuity-spike-new-report.json
```

The report path must not exist. Cold builds/source imports can take minutes.
The harness owns and joins shutdown of three Gateway processes, separate
HOME/workspace/state directories, and local deterministic mock providers. It
does not use live configuration, real credentials, or paid inference.

```sh
node scripts/run-vitest.mjs extensions/continuity-spike test/scripts/scoped-decision.test.ts test/scripts/scoped-decision-completion.test.ts
```

## End-to-end path

```text
Authenticated operator enrollment and scoped decision
  → real embedded OpenClaw turn + local mock model
  → exact run/tool-call binding and current context/permission checks
  → continuity_advance: native SQLite operation admission
  → explicit release through the test-owned RPC transport
  → company OR family Gateway checks local policy/revision
  → atomic synthetic artifact and durable receipt
  → home reconciliation and next eligible continuation
```

Artifacts are actual durable data records, not file uploads. Hashes bind exact
content, not remote identity. The zero-authority-argument tool takes its activity,
direction, step, and destination from the admitted turn. The schema rejects extra
arguments; the hook also scrubs parameters defensively, and the mock emits an empty
argument object. It cannot set decisions or permissions. Operator-admin controls
setup, release, and policy; status-read is separate.

`continuity_spike.status` checks the current activity's `statusRead` policy on
both home and destination Gateways. A revoked ID returns nonretryable `FORBIDDEN`;
enumeration omits the whole revoked aggregate, including receipt and artifact
copies, while preserving readable activities. Internal lifecycle reads and
admin-only mutation responses retain their separate action contracts. Regranting
read access reveals the retained data again; revocation is not data deletion.

## Experimental consistency contracts

| Mode        | An active A turn when B is accepted                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `next-turn` | May finish under A; newly admitted turns receive B.                                                               |
| `operation` | New A admissions are rejected; controllable old admissions are cancelled; already released operations may finish. |

One atomic native keyed-store update orders each activity aggregate. Late A
receipts cannot discharge B's steps. There is no distributed transaction or
promise that an earlier-admitted external effect cannot occur after B.

Permission/attachment changes increment experimental generations; regrant or
reconnect requires a fresh turn. This explicit conservative lifecycle choice
goes beyond the earlier preview-only experiment's current-state checks.

The home retains objectives, accepted decisions, unfinished steps, snapshots,
and operation states. The harness requests eligible continuations explicitly
to reproduce interleavings; `schedule` uses OpenClaw's existing native scheduler.
There is no second polling planner or claim of unattended automatic discovery.

## Scenarios

The driver first verifies a read-scoped client can read status but receives a
nonretryable scope denial when changing a decision, with unchanged durable state
and a successful admin control. This uses the owned Gateway credential with a
restricted connection scope; it is not a separate-credential or remote-pairing test.

The driver also asserts unchanged-direction baseline completion; native scheduled B;
A→B during real active turns under both modes; positive B progression despite
late A completion; family progress while company is disconnected; home process
replacement and lost-receipt recovery; not-found uncertainty resolved only by
a terminal cancellation fence; destination revision conflicts and refresh;
separate execute/status access; and source-scoped native prompt projection.

The receipt-read scenario captures actual synthetic RPC responses from clients
granted only `operator.read`: allowed lookup and aggregate reads, revoked lookup
and ID denials, list omission with readable siblings intact, and regrant controls.
It covers destination receipts/artifacts and the reconciled home receipt copy.
The JSON report includes these payloads, not authentication or handshake frames.

The admin-only held-call fixture controls admission timing, not model reasoning.
It is bounded to 30 seconds and responds to abort. Unit coverage additionally
exercises altered hashes, identity conflicts, storage refusal, provenance reuse,
and expiry/revocation during selected saves.

## Context profiles and coverage boundaries

| Capability                        | Boundary                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Shared/private retained records   | Native plugin state with source/activity/audience/export/import/retention checks.                                 |
| Derived context                   | Every source restriction survives; conflicting reused provenance IDs are rejected.                                |
| B without private rationale       | A separately permitted directive; sharing is not decision authority.                                              |
| Ephemeral selected saves          | Bounded in-process references; exact selection and current policy/lifetime revalidated inside the atomic updater. |
| Personal working views            | Module accepts only a live host closure; no model label or RPC authenticates an operator.                         |
| Native ephemeral/personal prompts | **Unavailable**: transcript, compaction, cache, index, and provider erasure are not established.                  |

Only retained shared/private views enter actual native prompts. Selections freeze
on first use, including empty selections. Changing selection needs a fresh
session; policy is rechecked before each run. Filtering a later prompt cannot
sanitize historical native context. This is not an encrypted vault product.

## Recovery and measurement limits

- **Repeated Cron turns in the same session are not supported at this base revision.**
  Native Cron reuses the persistent session ID as its run ID. The second invocation
  is correctly rejected as a finished turn, without new inference or admissions.
  The driver explicitly verifies that denial and then completes the next step with
  a fresh ordinary Gateway turn. This is not a passing repeat-scheduling guarantee.
  A native repair must provide a distinct logical execution ID consistently through
  admission, lifecycle, CLI/embedded execution, and cleanup; reopening finished
  plugin turns or changing only one caller would be unsafe.

- One fixed home owns its aggregate. Recovery assumes exclusive custody and
  established state continuity. The driver replaces a process; it does not test
  power loss, snapshot rollback, split brain, or home transfer.
- Ordinary service stop/start reconstructs context ownership while preserving
  retained records; old temporary views stay closed. Runtime retirement still
  requires a fresh registration. Failed startup is rolled back for retry.
- Queued continuations use owner-unique tags. Live service/activity stop cancels
  by tag and waits for pending schedule creation, including rejection or a result
  without a handle; concurrent cleanup shares one cancellation. Native scheduling
  can return no handle after creating a job and failing to roll it back. Cleanup
  ownership therefore survives until positive removal with zero failures, or an
  exact host job-start correlation. Zero removals are unresolved: the retired
  facade can return 0/0 without inspecting Cron. Stop reports cleanup failure and
  same-registration restart stays blocked; this conservative state can persist
  even when no job exists. Native registry cleanup only covers registered jobs,
  not every no-handle failed rollback, and the public facade cannot prove absence
  after retirement. An unmatched Cron job is denied before durable turn admission,
  including under a replacement controller; unrelated manual turns remain valid.
  A hung scheduler call has no bounded-stop guarantee because its public
  preparation API has no abort handle.
- Missing local dispatch bookkeeping is not proof that no external effect occurred.
  Admin-only uncertainty/receipt reports can reconcile an operation still recorded
  as `admitted`; they do not authorize dispatch. Unknown work stays blocked pending
  authoritative reconciliation. Receipt hashes bind content, not reporter identity.
- Admission, dispatch, unknown outcome, and terminal receipts are distinct.
  Destination artifact/receipt atomicity does not imply exactly-once arbitrary
  external APIs. `not-found` alone is not safe retry permission.
- Bounded ledgers fail closed on saturation instead of evicting replay records.
- Reports count actual mock-provider requests, bytes, and elapsed time. Tokens
  and cost remain unknown, not zero. The baseline is unchanged-direction native
  work, not evidence of savings for a matched real-model coordination workflow.
- Real-model accuracy/cost, utility versus primary performance, same-turn
  extraction, native Codex, live Reef, real UI switching, offline delegated grants,
  and mobility remain unverified—not successful tests.

The implementation uses public OpenClaw plugin, hook, native state, scheduler,
Gateway, and QA interfaces. No Core schema/config/trust-policy modification,
private mesh, external memory engine, or new model framework is required.
