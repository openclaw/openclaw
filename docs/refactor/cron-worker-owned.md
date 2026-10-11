---
summary: "Proposed worker-owned cron scheduling with committed run requests and a small launcher"
read_when:
  - Simplifying cron scheduling and update reliability
title: "Worker-owned cron"
---

# Worker-owned cron

**Proposal, not implemented.** Put scheduling and reservation decisions in one
cron worker. Commit a run request, release the writer, then launch the task.
Target approximately **26,000 production lines**, down from **43,960**: about
**18,000 lines (41%) removed**, without moving the same machinery elsewhere.
Keep ordinary reliability; accept a missed occurrence in a narrow crash window
and an occasional launch racing a disable. Do not build distributed scheduling.

## Current design and contract

Source baseline: `7517981b5e670b88ebf61b4d1be18a194a46a043`. Physical TypeScript
lines, including comments/blanks but excluding tests, mocks, fixtures, harnesses,
and suite helpers: `src/cron` has **262 production files / 43,960 lines** and
**275 test/support files / 79,391 lines**. Its production directories are
top-level **10,485**, `isolated-agent/` **9,196**, `service/` **16,272**, and
`store/` **8,007** lines. Counts below overlap where responsibilities share files;
they are an ownership map, not an additive deletion tally. Citations use this
baseline; all shortened source paths start with `src/cron/` unless labeled
otherwise.

The writer stall is structural: `store/run-admission.worker.ts:68` opens the
transaction before calling host preparation at line 76. The worker posts to the
host and blocks in `Atomics.wait`
(`src/infra/sqlite-worker-operation-admission.ts:670`). Host preparation and the
second commit check run in `service/runtime-mutation.ts:130`. The #168291 fix
sets a one-second deadline on each exchange
(`store/runtime-mutation.worker.ts:15`, `:38`, `:72`); it bounds the dependency
instead of removing it. Scheduling itself has no inherent main-thread need:
Gateway dependencies enter as callbacks at `src/gateway/server-cron.ts:502`.

| Responsibility                                         | Current owner, evidence, and physical LOC                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule math, identity, due decisions, pacing/backoff | `schedule.ts:26` (350), `schedule-identity.ts:1` (137), `service/jobs-scheduling.ts:339` (746), `service/timer-runnable.ts:65` (204).                                                                                                                                           |
| Timer, capacity, reservations, catch-up                | `service/timer-scheduler.ts:119` (629), `service/timer-catchup.ts:177` (385), `service/scheduler-mutations.ts:156` (220), `store/startup-plan.worker.ts:29` (133); admission/reservation modules below.                                                                         |
| Definitions, CRUD, config/state reads                  | `normalize.ts:1` (518), `service/ops-mutations.ts:1` (652), `service/ops-read.ts:1` (333), `service/jobs.ts:1` (722), `service/store.ts:1` (534), `store/row-codec.ts:1` (767).                                                                                                 |
| Run admission/capacity and activation                  | `service/run-admission.ts:1` (664), `service/run-admission-mutation.ts:1` (434), `service/run-admission-capacity.ts:1` (121), `store/run-admission.worker.ts:62` (466), `store/scheduler-reservation.worker.ts:93` (200).                                                       |
| Receipts, authority, settlement                        | `store/receipt-authority-owner.ts:101` and five sibling modules (838); `store/run-receipt-store.ts:51` (586), `store/run-receipt-settlement.ts:36` (225), `service/run-receipts.ts:1` (307); host/worker mutation protocol (489).                                               |
| Results, skipped attempts, restart recovery            | `service/timer-outcomes.ts:215` (745), `service/run-owner.ts:99` (119), `service/run-history.ts:1` (205); recovery family including `service/startup-run-repair.ts:57` and `store/run-recovery.kernel.ts:111` (1,050).                                                          |
| Manual run/abandon and lifecycle                       | `service/ops-run.ts:243` (453), `service/ops-run-preparation.ts:239` (631), `service/ops-lifecycle.ts:268` (393); abandonment is reservation cleanup at `store/scheduler-reservation.worker.ts:167`, not a public cron operation.                                               |
| Task execution and session/model setup                 | `isolated-agent/run.ts:78` and its directory (53 files / 9,196); command/script/trigger/heartbeat adapters including `command-runner.ts:1`, `trigger-script.ts:1`, `heartbeat-monitor.ts:72` (8 files / 1,526).                                                                 |
| Heartbeat, watchdog, timeout/cleanup                   | `service/timer-execution.ts:157`, `service/timer-job-runner.ts:327`, `service/agent-watchdog.ts:51`, timeout/interruption helpers (7 files / 1,648).                                                                                                                            |
| Notifications, routing, delivery                       | Top-level delivery helpers and failure text (10 files / 1,176), `service/failure-alerts.ts:184` and notification family (5 files / 904); actual delivery at `isolated-agent/delivery-dispatch.ts:189`, counted in isolated-agent above.                                         |
| Permissions, scratch, retention                        | `scheduled-tool-policy.ts:1` (258), `store/runtime-authority-store.ts:57` (264); `scratch-store.ts:1` (161), `scratch-write.kernel.ts:1` (165); `session-reaper.ts:1` (273), `session-registry-maintenance.ts:1` (186).                                                         |
| Gateway/config reload and event sources                | Outside cron: `src/gateway/server-cron*.ts` (9 files / 2,636), configuration rebuild at `src/gateway/server-reload-hot.ts:343`; exit/stream watcher family (8 files / 2,418), including `src/gateway/cron-exit-watchers.ts:80`, `src/gateway/cron-stream-watchers.ts:50`.       |
| RPC, CLI, tools                                        | Outside cron: `src/gateway/server-methods/cron*.ts` (14 files / 3,039; operations at `src/gateway/server-methods/cron.ts:212`); `src/cli/cron-cli.ts` and directory (15 / 3,036); `src/agents/tools/cron-tool*.ts` (9 / 2,723; actions at `src/agents/tools/cron-tool.ts:362`). |

### Preserve observable behavior

These are acceptance criteria, with existing test anchors, not a requirement to
keep each test's private mocks or callbacks.

| Contract                                                                                                                                                                                                                                                    | Current implementation and tests that pin it                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Catch up one overdue occurrence per job, oldest first; default five immediate, five-second overflow staggering, two-minute startup deferral for agent/heartbeat work. Preserve deferred/paced deadlines across restart and avoid inventing pre-edit misses. | `service/timer-catchup.ts:210`, `service/timer-execution-timeout.ts:36`, `service/timer-runnable.ts:90`; `service.startup-overflow-clobber.test.ts:110`, `service.restart-catchup-pacing.test.ts:168`, `:237`.                                                                                                                 |
| No duplicate execution for the same occurrence in normal operation; timezone/DST, minimum refire interval, and configured retry/backoff still work. Today this uses markers/receipts, not deterministic slot IDs.                                           | `service/timer-runnable.ts:77`, `:131`, `store/run-receipt-store.ts:332`; `cron-state-contracts.e2e.test.ts:205`, `schedule.test.ts:306`, `service/timer.regression.test.ts:159`, `:197`. Retry deadlines derive from completion at `service/timer-outcomes.ts:317`, `:394`.                                                   |
| Actual rejected/ownerless/queued-but-not-launched attempts record skipped plus reason; one broken job does not block siblings. Do not manufacture history for quiet trigger evaluations or every missed tick.                                               | `service/run-owner.ts:99`, `service/ops-run.ts:309`; `service/run-admission.ownerless.test.ts:107`, `:153`. `skipMissedJobs` only advances recurring schedules and logs (`store/startup-plan.worker.ts:109`; `service.startup-overflow-clobber.test.ts:56`); `fire:false` is quiet (`service/timer-trigger.ts:54`).            |
| Delivery modes, recipient/thread routing, suppression/unknown outcomes, failure threshold/cooldown, skipped alerts, and owner-conversation repair remain. One-shot deletion depends on successful whole-run completion, including delivery.                 | `delivery-plan.ts:40`, `service/failure-alerts.ts:184`, `:374`, `service/timer-outcomes.ts:233`; `cron-delivery-outcomes.e2e.test.ts:213`, `:411`, `:536`, `:750`; outside cron: `src/gateway/server.cron.test.ts:1145`.                                                                                                       |
| Keep timeout defaults/overrides, abort and bounded cleanup, setup-stall detection, and capacity waiting outside the execution budget. Heartbeat quiet hours/coalescing/busy rules and actual outcomes remain with the heartbeat owner.                      | `service/timeout-policy.ts:10`, `service/agent-watchdog.ts:86`, `service/timer-job-runner.ts:327`; `service/timer.timeout-watchdog.test.ts:288`, `:333`, `service/command-timeout.test.ts:95`, `service.heartbeat-payload.test.ts:107`, `:179`.                                                                                |
| Manual force may run a disabled job and preserves its natural/paced slot; due mode honors eligibility. Acknowledged runs have durable accounting. Remove requests cancellation and can report cleanup pending.                                              | `service/ops-run-preparation.ts:239`, `service/ops-run.ts:113`, `:243`; `service/ops.regression.test.ts:329`, `:422`, `service/manual-ack-durability.test.ts:28`; outside cron: `src/agents/tools/cron-tool.output-contract.test.ts:91`.                                                                                       |
| Persist jobs/history, recover completed results without executing again, record interruption, resume future scheduling; preserve public RPC envelopes, exact run lookup, CLI exit status, filters and tool defaults.                                        | `service/startup-run-repair.ts:121`, `service/ops-lifecycle.ts:268`; `service.restart-catchup.test.ts:168`, `:202`; outside cron: `src/gateway/server.cron.test.ts:781`, `:823`, `src/cli/cron-cli.test.ts:267`, `src/agents/tools/cron-tool.output-contract.test.ts:161`, `src/gateway/server-methods/cron.runs.test.ts:574`. |

Receipt custody, revocation generations, nonce settlement, and synchronous
prepare/commit callbacks are machinery, not product contracts. One deliberate
recovery relaxation needs to be visible: today an interrupted one-shot can replay
when delivery is known not to have started
(`store/run-recovery.kernel.ts:152`). That does not prove execution never began.
The new design records an uncertain active run as interrupted instead of replaying
its payload. This is the accepted crash-loss tradeoff, not a claim of unchanged
crash semantics.

## Proposed ownership and flow

**Cron worker:** one long-lived actor owns job/runtime state, schedule computation,
timer, queue, concurrency limit, and terminal accounting. Use the existing
Gateway SQLite writer infrastructure for connection ownership, FIFO, initial
integrity admission, and cache invalidation; cron domain decisions and synchronous
transactions run on the worker side. No second database owner. The existing
transaction helper itself is synchronous (`src/state/openclaw-state-db.ts:485`).

**Host:** authenticate RPC/tool requests, publish normalized config snapshots
`{version, config}` on startup/change, and expose committed job/status views.
Version orders snapshots only; it is not a revocation generation. Job CRUD and
declarative reconciliation go through the cron worker. The worker installs a
snapshot between commands, never pulls host policy during a transaction.

**Launcher/run execution:** consume committed requests, perform one cheap final
live-Gateway/launch-eligibility check, then dispatch to the existing task/session
executor or a run worker. Existing task, tool-permission, heartbeat, and transport
owners still enforce their own contracts. They do not acquire cron receipt
authority. The launcher handles effects; it never decides the schedule.

```mermaid
sequenceDiagram
    participant H as Host
    participant C as Cron worker
    participant L as Launcher
    participant R as Run executor
    H->>C: Config snapshot or job command
    C->>C: Due decision + request insert + next deadline; commit
    C->>C: Capacity available: queued to active; commit
    C->>L: Launch committed run ID and payload
    L->>L: Live Gateway and eligible job?
    L->>R: Start task
    R->>R: Execute and finish primary delivery
    R-->>C: Progress and combined terminal outcome
    C->>C: Record outcome + history + next deadline; commit
    C-->>H: Status and post-run notifications
```

No transaction waits for a host reply, task, notification, module import, or
network call. Capacity waiting leaves the row queued and the writer free. The
worker selects requests in due/arrival order with a stable job-order tie break.

### Rows and idempotency

**No schema change; no DDL requested.** Reuse `cron_jobs` for definitions and
`state_json`; reuse `cron_run_receipts` as the run-request ledger. The existing
primary key is `receipt_id`, with one active receipt per store/job
(`src/state/openclaw-state-schema.sql:1426`, `:1453`, `:1475`). Keep `task_runs`
history (`store/run-history.kernel.ts:58`), `cron_job_scratch`, permission
provenance, and their retention.

“Requested” means the existing receipt `status='running'` plus `queuedAtMs`;
“active” means `runningAtMs` and `runningReceiptId`. Both already exist
(`store/run-admission.worker.ts:145`, `:203`); do not add a `queued` SQL status.
Keep required receipt metadata for decoding/diagnostics, not as authority tokens.

For new scheduled work, the run ID is a tagged, collision-safe encoding of
`[storeKey, jobId, scheduledSlotMs]`, using the persisted due deadline, not the
time the launcher wakes up. Cron can decode this timed key for restart; public
and history readers treat IDs as opaque. Insert it and advance the schedule in one transaction;
a duplicate key is already requested. Backoff intentionally creates a new future
deadline/key; merely delaying an existing request retains its ID. Manual force
uses a distinct request ID and preserves the natural slot. Stream batches and
exit events use distinct event IDs, through the same queue. Their transient
payload/force context stays with the launch request; losing it in a crash means
recording a skip, not reconstructing an event from current config. Today these
details are operation inputs, not receipt columns
(`store/runtime-worker.types.ts:139`). Duplicate terminal messages are ignored
by run ID once the row is terminal.

Keep bounded receipt history: today it retains 64 terminal receipts per job
(`store/run-receipt-store.ts:79`, `:246`). Idempotency also depends on monotonically
consuming scheduled deadlines, not retaining every historical ID forever.

### Common failures, cheaply handled

| Situation                                   | Proposed behavior                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash after request commit, before dispatch | Resume timed queued requests with a recoverable key; skip requests whose transient context was lost. Commit queued-to-active before emitting launch; never resend an active request automatically. A crash between that commit and actual start may miss one occurrence.                                         |
| Crash during/after execution                | Restore an already-recorded terminal task result; otherwise record interrupted and continue future scheduling. Do not replay an uncertain payload or delivery. Outcome recording is best effort; a failed notification cannot undo a committed run.                                                              |
| Stale Gateway                               | Launcher checks the existing live Gateway owner immediately before dispatch; skip with reason if retired. Shutdown stops new dispatch and joins owned work. No new fences, leases, or sibling-process arbitration.                                                                                               |
| Disable/remove/edit                         | Worker cancels queued requests on disable/remove or schedule replacement, recording why. Payload edits use the current definition when dequeued. Active tasks keep their launch snapshot; completion records its result while preserving any newer schedule/enablement edit. Accept one launch racing a disable. |
| Manual force or consumed exit event         | Preserve existing exceptions to “enabled”: explicit force can run a disabled job; an accepted `on-exit` payload survives the watch's automatic disable (`store/run-admission.worker.ts:134`). Operator disable still cancels queued work. No new user option.                                                    |
| Config change mid-flight                    | Install the latest pushed snapshot between commands. Already-started tasks retain their snapshot; later starts use current config. Drop the old cron-wide revoke/re-admit cycle.                                                                                                                                 |
| Clock jumps/sleep                           | Use wall clock for due slots and monotonic run deadlines. On a forward jump, apply bounded catch-up once per job; on a backward jump, retain the persisted next deadline rather than rewinding it. Keep bounded timer rechecks and refire protection, with no clock-repair protocol.                             |

The run executor owns its AbortController, setup/execution deadlines, and bounded
cleanup. Progress/heartbeat/result messages arrive asynchronously; they never
extend a database transaction. Preserve the existing heartbeat wake adapter and
exclude lane waiting from execution time. A host stall may delay dispatch or
notifications, but cannot leave a cron transaction waiting on that host.
Primary delivery stays in the run executor's existing adapter; its outcome is
part of completion before one-shot deletion. Post-run notifications retain their
route/threshold behavior and report asynchronously without commit guards. No new
pending-delivery state machine is needed.

## Delete and consolidate

Delete `store/receipt-authority-*` (838 LOC), the host/worker runtime mutation
handshake and preparation types (489), and the cron deadline opt-in from #168291.
Replace admission/reservation orchestration (1,885), receipt settlement/binding/
observation plumbing (717), receipt persistence helpers (933), and recovery
orchestration (1,050) with the queue and short worker-local transitions above.
These nonoverlapping groups total **5,912 current lines**; useful storage and
result recovery survive, not these layers.

Also collapse the host timer/catch-up/manual-finalization choreography into that
worker and remove cron's direct handshakes in `store/dispatch.worker.ts:140`,
`:175`, `:231`, `:244`, `store/save.worker.ts:26`, and `store/load.worker.ts:20`.
Removing only `runtime-mutation.worker.ts` would leave the same dependency elsewhere.
Remove obsolete registrations, private types, mocks and protocol tests together;
retain behavioral proof at the new owner. Do not delete the general SQLite
admission mechanism used by other subsystems.

Size budget: reduce `service/` + `store/` from **24,279** to roughly **6,300** lines,
including replacement worker/launcher code. Retaining the other **19,681** cron
lines puts the target near **26,000**. This is a redesign budget, not a verified
patch size. Payload/delivery breadth is the largest risk to that estimate; do not
hide growth by moving cron coordination to Gateway files.

**Keep permission provenance:** `store/runtime-authority-store.ts:57` and `:97`
maintain scheduled-tool permissions and recovery, unlike receipt custody. Keep
that owner and `cron_job_runtime_authorities`
(`src/state/openclaw-state-schema.sql:1490`). No permission redesign or table drop
is proposed.

## Existing data and three landable PRs

Never rewrite existing receipt IDs or history joins. Use one canonical row codec;
the new timed-key tag is only an encoding discriminator, never authority. Queued
rows without a recoverable timed key, including old random IDs, become skipped
with their marker cleared atomically. Keep `request_run_id` for acknowledged-run
lookup and leave the natural deadline untouched: ordinary catch-up handles overdue
schedules, while manual force cannot consume a future natural slot. Restore
finalized history first, then recover queued/active rows before admitting new work.
No Doctor format migration is necessary: Doctor already leaves running-marker
recovery to scheduler startup (`src/commands/doctor/cron/index.ts:52`); its existing
legacy-shape migrations remain the only normalization path. Preserve backups and
test rollback with the matching binary; no runtime legacy parser or new sidecar.

Each PR cuts over its complete responsibility and removes its superseded path.
Each must pass affected owner/sibling tests and `check:changed`; changed tests
report test time separately from transform/setup time. The listed crash semantics
are intentional accepted changes; all other observable contracts above stay green.

1. **Remove host waits from cron transactions.** Push config/policy inputs before
   writes; move decisions requiring current rows into the existing worker kernels.
   Cut all cron prepare/commit handshakes, including save/history/init paths, and
   the deadline opt-in. Proof: deliberately stall the host after worker submission;
   an unrelated state writer and the update handoff must still complete. Exercise
   real mutation entry points, not a helper-only mock; trace all cron admission
   calls to prove none remain inside transactions.
2. **Cut scheduling and launch over together.** Start the worker actor, retire host
   timers/reservations, use idempotent request rows, and wire timer/manual/event
   sources to the single launcher. Remove receipt custody/revocation consumers in
   the same cutover. Proof: duplicate slot, capacity queue, disable/edit, manual
   force, consumed exit event, stream batch, catch-up, retry and clock-jump flows;
   crash at request/active boundaries and recover a copied old-format database.
3. **Collapse result/recovery plumbing and finish deletion.** One terminal-result
   handler records execution plus primary-delivery outcome, updates job/history,
   and emits post-run notifications;
   retire nonce settlement, foreign-receipt monitoring and redundant lifecycle
   wrappers. Proof: heartbeat/setup/execution timeouts, cleanup, skipped history,
   real webhook/notification outcomes and RPC/CLI/tool contracts cited above;
   published updater × candidate with isolated state, restart and backup rollback.
   Verify no cron commitGuard/revocation path remains and report net production/
   test LOC separately. Retain other owners' live effect/permission checks.

Design-lane proof is source inspection and documentation validation only. No
production/test changes, runtime experiment, commit, or PR are part of this lane.
