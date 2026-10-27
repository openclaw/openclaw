# Pairing live traffic reproduction

This workload uses an isolated Gateway, the bundled iMessage plugin with the existing synthetic bridge, and a real foreground node host with its own synthetic state directory. It never opens a user profile. Output belongs in a task-owned directory on the internal disk; archive only aggregate counts and profiles.

## Acceptance rule (before measurements)

Attribute cold startup separately from a warm 130-second window after the first persisted host-stat sample with one paired node advertising its normal command surface (no command invocation) and eight rejected iMessage direct messages at 15-second intervals. The channel uses `allowlist` policy with a configured synthetic sender distinct from those messages. Count SQL statements, worker requests and runtime main-thread statements with the frozen observer. Count successive persisted node surfaces and pairing revisions as changed or unchanged; never report their contents.

A valid deletion removes one `pairing.allowFrom` request and its SELECT per direct message under open/allowlist policy, while pairing-policy DMs retain their current authorization read. The node heartbeat triplet is retained if its observation timestamp and pairing revision change each minute. Preserve immediate pairing revocation and external-writer visibility; no cache, schema or transaction changes.

The initial attribution is counts only, with per-thread CPU profiles; no latency claim. For a candidate, run three alternating baseline/candidate pairs when the campaign's load/disk gate allows, otherwise one pair with explicit attribution. Compare cold and warm separately: zero new runtime MAIN statements, zero added touched-owner work, identical denied-message outcomes and monotonic heartbeat freshness. Any user-facing latency comparison requires the campaign timing lock, load below 24 and at least five interleaved samples per arm; a 20% regression stops the change.

Run after building the current head with the repository's `qaRuntime` build:

```sh
node --import ./scripts/tsx.mjs scripts/perf/pairing-live-measure.mts \
  --out <internal-task-output> \
  --observer <frozen-harness>/observer.cjs
```

## Host telemetry checkpoint acceptance (preregistered)

The heartbeat checkpoint change uses this real Gateway and paired-node flow with
the frozen v3.1.5 observer, causality observer, and background roots. Reproduce the
current-main heartbeat writes before changing production code. Count cold startup,
the first accepted sample, a 15-minute steady phase, disconnect, and shutdown
separately. Keep all fixture state synthetic. The earlier requirement for at least
two persisted samples in 130 seconds describes the old cadence; the checkpoint
workload replaces it with the following contract.

Run five alternating baseline/candidate pairs on the same platform. For one node
reporting every minute, steady heartbeat work must fall from approximately 75 SQL
statements and 15 execute requests to at most 20 statements and four requests per
15 minutes. Runtime main-thread SQL must remain zero. Report per-operation counts
and rates, median, p95, and min–max separately for each phase. Count whole-process
and main-thread work, including final persistence, to expose relocated cost.

Each rate sample retains a nominal 900-second steady window and must observe 15
real minute reports after the first persisted sample and its broadcast. A fixed
maximum of 5,000 ms after the nominal deadline settles the final report and
required durable observation; exceeding it fails the fixture. All boundary work
stays in the steady phase, with SQL, requests, MAIN, CPU, memory, and diagnostics
collected through settlement. Report the nominal duration, boundary settlement
duration, added delay, and full measured phase duration separately; rates use the
full measured duration. Baseline minimum 75 SQL/15 heartbeat requests and candidate
maximum 20 SQL/four requests remain unchanged. The shorter recovery cells use the
same five-second bound and retain their nominal 130-second window and two reports.

Record per-thread CPU profiles, CPU totals, RSS/heap, event-response and catalog
latency, and broadcast counts. Every accepted report must remain immediately
visible in the live catalog and broadcast stream. User-facing metrics must hold
or improve; an adverse 20% cell stops the change, and smaller adverse movement
needs explicit disposition. Wall-clock/CPU A/B runs require the campaign timing
lock and load below 24. After 60 minutes without timing admission, report only
counts/profile evidence and the unmeasured timing limitation.

Behavioral acceptance also requires durable-immediate revocation and identity
changes, a report arriving during an outstanding checkpoint, final-sample
disconnect persistence, shutdown drain before worker retirement, crash/reload
staleness bounded by the checkpoint interval, offline catalog parity, and passing
revision-consumer suites. Keep security and all other paired-state writes
immediate; only `lastHostStats` is coalesced in the existing NodeRegistry.

The approved tradeoffs are explicit: a crash can lose roughly five minutes of
host telemetry, and the offline catalog can briefly display the previous durable
sample while disconnect persistence settles. The five-minute deadline is anchored
to the last persisted sample's receipt time and assumes continuing reports and
successful scheduling/storage; completion delay and sensor silence remain visible
in the original `updatedAtMs`. First-sample persistence is immediate. No schema,
second pairing store, or memory-only authorization revision is introduced.

## Revision attribution

The pairing revision is shared by all paired-state writes, including remote skill
bin discovery. A synthetic baseline recorded two steady heartbeat writes and one
`node.updateBins` write, so equating all revision changes with heartbeat writes
incorrectly rejected that baseline. The workload now reads the durable surface
and revision in one SQLite snapshot and requires every observed changed host-stat
sample to advance the revision. `heartbeatRevisionChanges` counts those sample
transitions; `pairingRevisionAdvances` retains the full revision delta, and
`nonHeartbeatRevisionAdvances` records the remainder. The frozen observer owns
SQL/request attribution; polling counters describe observed durable transitions.
Normal report and persistence cadence requirements remain unchanged; the final
durable-state poll now participates in the explicit bounded settlement. Failed cells
retain their phase and error in `evidence.json` as well as the console summary.

## Dirty shutdown and crash recovery cells

Use `--finish shutdown` or `--finish crash` with `--heartbeat-mode checkpoint
--steady-seconds 130` for the separate recovery cells. The default `--finish
disconnect` retains normal disconnect followed by Gateway shutdown. These short
cells prove recovery behavior; they do not replace the 900-second rate comparison.

Recovery cells require an accepted sample newer than the durable sample. Shutdown
keeps the node connected until the Gateway acknowledges a clean exit, then checks
that the final observed sample is durable. Crash sends SIGKILL to the owned Gateway
process group and requires a SIGKILL exit; the saved sample must remain exactly the
checkpoint captured before termination. The crash cell reports sample age at the
crash, the discarded accepted-sample span, and capture-to-exit delay. Both age and
discarded span must be at most five minutes for this healthy fixture. Restart
downtime is recorded separately and never subtracted from the original receipt time.

After either finish, the workload stops the node before restarting the same
synthetic Gateway state on a different port. It connects only an operator client,
so a reconnecting node cannot hide recovery with an immediate first-sample write.
The reloaded database and offline catalog must preserve the expected sample,
including its original `updatedAtMs`. The baseline mode also supports both finish
arms without requiring dirty telemetry. SIGKILL cannot finalize CPU profiles;
use the orderly cells for complete per-thread profiles and the pre-crash resource
snapshot for crash-cell CPU totals.
