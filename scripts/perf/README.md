# Team-shaped synthetic state

## Private-array copies

`node --expose-gc scripts/perf/private-array-copies-measure.mjs <baseline-root> <candidate-root>`
measures six alternating samples per side with collected-object heap sampling.
The roots need only the five source files listed in the script; no build or install
is needed. It measures the task-audience result build/sort site, the complete
subagent topology patch owner, and one scope canonicalization (both reader sites
must match). Synthetic inputs cover 1/100/5,000 task rows, 100/5,000 historical runs
per child with absent/shared/distinct memory rows, and reordered or changed scopes.
These are owner/site allocation bytes per call, not whole-Gateway or GC claims.
Output includes source hashes, call counts, allocation sample counts, every sample,
and absolute/relative mean deltas. Run on an approved benchmark host under its
shared guard; equivalent results and reduced allocation are the acceptance rule.

## Limited-scope Control UI RPCs

`control-ui-forbidden-rpc-measure.ts` opens the real Control UI against a synthetic,
isolated Gateway and records the authenticated hello scopes, per-method calls and
`FORBIDDEN` responses, connection-minutes, page errors, and a viewport screenshot.
Use an existing limited operator fixture with `operator.sessions.write`, an open
chat, and a transcript link to a session outside the loaded roster. Do not use a
production Gateway or a real browser profile.

```sh
node --import ./scripts/tsx.mjs scripts/perf/control-ui-forbidden-rpc-measure.ts \
  --url http://127.0.0.1:41629/chat/main/12345678 \
  --proxy-user limited@example.test --duration-ms 60000 \
  --ready-text "synthetic limited-scope conversation" --show-panels \
  --output-dir /path/to/proof --label baseline
```

The optional proxy user supplies synthetic trusted-proxy headers; configure the
isolated Gateway to trust them. `--browser-path` selects an installed Chromium.
Repeat on baseline and candidate with the same fixture, duration, and role.
Acceptance is zero denied calls for unavailable surfaces, with allowed chat reads
still succeeding. Inspect screenshots for usable chat and absent unavailable
controls. This is a request-count measurement, not a CPU or latency benchmark.

## Main-thread filesystem durability

Use `fsync-gateway-entry.ts` as the `--entry` for
`transcript-broadcast-measure.ts` to log `FSYNC_PROBE` records containing the main
thread's synchronous fsync stacks, elapsed time, and timestamp. It requires a
generated team-shape fixture. Separate startup records from the measured workload;
the probe does not observe worker fsyncs or kernel-internal SQLite synchronization.

For attachment attribution, set `OPENCLAW_PERF_MEDIA_IO=1` to emit `MEDIA_IO_PROBE`
records for inbound media filesystem calls, including async open, write, sync,
metadata reads, and close. Records contain relative paths, call stacks, and
elapsed time, never file contents. Set `OPENCLAW_PERF_FSYNC_DELAY_MS=50` to add the
same synthetic storage delay to inbound file and directory syncs: synchronous
fsync blocks the main thread, while `FileHandle.sync` waits asynchronously.
`FSYNC_PROBE` records mark blocking time; `MEDIA_IO_PROBE` records mark async
elapsed time. Both include the injected delay. Use identical settings on both
sides of a swapped pair; omit both variables for the original synchronous probe.
The injection does not cover worker calls or synchronization inside native code.

`fsync-scratch-measure.ts` exercises the real container environment-file and
playback cache owners, verifying their output bytes. It injects a fixed delay into
each main-thread `fsyncSync` call to model slow storage without a loop device or
large disk writes. This is owner-boundary proof, not whole-Gateway throughput.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/fsync-scratch-measure.ts --state-dir /path/to/new-state \
  --operations 120 --interval-ms 500 --fsync-delay-ms 50 \
  --start-at <epoch-ms> --gc-log /path/to/capture.log > /path/to/capture.log 2>&1
```

For the baseline, supply `--container-owner` and `--media-owner` pointing to saved
baseline modules beside their original sources so relative imports stay intact.
Run concurrent baseline/candidate pairs under one quiet lock and the shared
production guard, swapping interleaved CPU sets for the second pair. Discard any
guard-interrupted pair. Acceptance: exact contents remain valid, synchronous
fsync count and blocked time fall to zero, and CPU, total GC/work, promotion and
eligible event-loop tails do not regress under the campaign's paired-delta rules.
Results include sample counts and maximum pauses; apply the minimum sample and
absolute-delta rules before treating any percentile as a gate.

## Owned directory events

`owned-directory-events-measure.ts` opens real shared directory subscriptions and
replays fixed native callbacks. Setup checks a missing descendant's event filter;
the measured pass delivers 65 direct-root events per batch, with a one-millisecond
yield between batches. It measures observer work, not filesystem or Gateway throughput.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/owned-directory-events-measure.ts \
  --state-dir /path/to/new-state --operations 4000 --start-at <epoch-ms> \
  --gc-log /path/to/capture.log --output /path/to/result.json > /path/to/capture.log 2>&1
```

Use `--owner /absolute/path/to/owned-directory-observation.baseline.ts` to load a
baseline saved beside the current owner. Add `--allocations` for a separate paired
pass including collected objects. Reports include bytes per event, batch latency,
CPU, GC counts/tails/maxima, promotion, and event-loop tails with sample counts.
Compare concurrent pairs under one quiet lock and the production guard, swapping
interleaved CPU sets for the second pair. Apply the campaign's paired-delta,
absolute-delta, GC-pause, and minimum-sample rules. Notifications must remain exact;
lower allocation must not regress eligible CPU, GC/work, or latency metrics.

## Background result lifecycle wait

`background-result-wait-measure.ts` holds a synthetic session turn open while
committing an automation result through the real controller and transcript
writer. Run baseline and candidate concurrently with separate state directories
and the same `--start-at` epoch, then swap CPU sets for the second pair:

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/background-result-wait-measure.ts \
  --state-dir /path/to/new-state --samples 6 --hold-ms 2000 --start-at <epoch-ms> \
  --gc-log /path/to/capture.log > /path/to/capture.log 2>&1
```

`result.json` records persistence latency, the existing `lifecycleQueueWaitMs`
diagnostic, custody after commit, and whether the turn is still running. A
1.1-second completion-publication fixture makes both versions emit their slow
operation diagnostic; it is excluded from persistence latency. This measures
the controller/storage boundary, not model or whole-Gateway latency. Acceptance:
queue wait no longer tracks the held turn, results persist within one second,
and commit completion leaves no mutation custody. CPU, GC pauses, and event-loop
samples are supporting context; apply the campaign's sample-count rules.

## Plugin tool invocation scopes

`plugin-gateway-scope-measure.ts` registers two synthetic plugins through the real
registry API, alternating one tool factory resolution and sixteen prepared tool
executions per synthetic turn. Every callback checks plugin identity, provenance,
and registry, including after an asynchronous suspension. This is a source-owner
measurement; synthetic turns do not represent whole Gateway or model latency.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/plugin-gateway-scope-measure.ts \
  --turns 4000 --calls 16 --start-at <allocation-epoch-ms> \
  --cpu-start-at <later-cpu-epoch-ms> --output /path/to/result.json \
  --gc-log /path/to/capture.log > /path/to/capture.log 2>&1
```

Run on the approved benchmark host with task-owned `HOME`, `OPENCLAW_HOME`, and
`TMPDIR`. Setup and warmup finish before `SCOPE_READY`. Allocation and unprofiled
CPU passes have independent shared start deadlines; late preparation fails.
Use concurrent baseline/candidate pairs under one quiet lock and the production
guard, swapping the interleaved CPU sets in the next pair.

The report includes collected-object allocation per invocation and synthetic
turn, CPU and turn latency, total GC time, per-kind collection counts and pause
tails/maxima, V8 trace promotion, and event-loop delay. Tails include sample counts;
apply the campaign's sample-count and absolute/relative paired-delta rules. The
default one-millisecond yield per turn permits event-loop sampling and is excluded
from turn latency. A separate, unprofiled probe counts async-store frame installs
for a synthetic turn and direct/nested calls to an owned plugin instance. Counts
include the turn's outer Gateway scope. No instrumentation remains during the
allocation or CPU passes. Raw allocation profiles accompany each result.

For complementary transport evidence, `transcript-broadcast-measure.ts --scenario
plugin.scope` loads a synthetic plugin in an isolated Gateway over a team-shape
fixture. Every RPC checks its plugin identity, source, registry, request
client, and scope continuity across an asynchronous suspension using the public
Plugin SDK. The response echoes the request sequence and confirms those checks.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --entry src/entry.ts --scenario plugin.scope \
  --port 41580 --mock-port 41581 --clients 1 --runs 1 --rpc-concurrency 1 \
  --warmup-operations 40 --operations 240 --rpc-interval-ms 300 --rounds 1 --diagnostics \
  --allocations --trace-gc --start-at <future-epoch-ms> --revision <source-sha>
```

Repeat without `--allocations` for unprofiled CPU and natural-GC measurements.
Use one long round for allocation to avoid repeated profiler-stop collections.
The interval paces batches of clients independently of RPC latency; one client at
300 ms targets 200 calls per minute. Omit it for a throughput workload. Report the
observed rate and fixture size. Existing results include validated RPC
counts and latency, allocation and promotion per RPC, main/process CPU, and
Gateway GC/loop diagnostics. Apply the sample-count rules to each round's tails;
increase operations if the loop histogram has fewer than 1,000 observations.
Use the owner workload above for allocation per plugin callback and its separate
unprofiled promotion measurement. Run both workloads in concurrent swapped pairs
under the campaign's guard and CPU-placement rules.

## Subagent idle sweep

`subagent-sweep-measure.ts` exercises the production sweeper with immutable synthetic
registry rows. Run with `--runs 50` and `--runs 500`. The `settled` workload retains
finished history; `mixed` uses 70% history, 10% live claimed runs, 10% pending
deliveries, and 10% future archives. Unexpected effects fail the run, and exact
records and their digest must remain unchanged.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/subagent-sweep-measure.ts \
  --runs 500 --workload mixed --operations 4000 --yield-ms 1 \
  --state-dir /path/to/new-state --start-at <future-epoch-ms> \
  --gc-log /path/to/capture.log --output /path/to/result.json > /path/to/capture.log 2>&1
```

Run on the approved benchmark host with isolated state. Setup and warmup precede
`SWEEP_READY`. Compare concurrent baseline/candidate pairs under one quiet lock
and the shared guard, then swap interleaved CPU assignments. Discard interrupted
pairs. The report includes sampled allocation per sweep, its projection at the
60-second idle cadence, sweep duration, total GC/work, promotion, and event-loop
tails. Total allocation includes timing and pacing overhead; registry allocation
is reported separately. This is owner-level evidence, not whole-Gateway latency.

Apply the campaign's paired-delta and sample-count rules. Report absolute deltas
when signs disagree or baselines differ by more than 5×, and use a third pair for
an inconclusive gating metric. p95 needs 200 samples per side, p99 needs 1,000;
major GC is context below 50 collections. GC pause-percentile shifts below 1 ms
are context, as are higher tails with at least 20% fewer collections and no rise
in total GC. Always report both maximum pauses; the candidate maximum still
gates above `max(50 ms, 2 × baseline maximum)`.

## Subagent maintenance and scoped reads

`subagent-maintenance-capture-measure.ts` measures the production session
maintenance preservation owner with 6,000 synthetic retained subagent runs and
60 protected sessions. Before measurement it checks live overrides in both
directions, a live-only row, and real worker update/deletion publications after
preservation preparation. The returned protected-key digest must match across
baseline and candidate. This measures the maintenance owner, not Gateway RPCs.
`--team-shape` instead generates 5,000 sessions and 6,000 retained runs with zero
transcript payload, then installs those runs in the registry and holds 60 child
execution claims. Existing pending deliveries remain protected alongside the
running children. Fixture preparation supplies the real requester/controller
store provenance and persists the active replacements before warming reads.
Fixture generation and these writes are sequential preparation work.
Add `--mutate-every 10` to commit an active run replacement every ten operations.
Mutation time and CPU are included in the measured operation.

`--flow maintenance` is the default. With `--team-shape`, `--flow prompt` calls
`buildActiveSubagentRuntimeContext` and `--flow control` calls
`buildControlledSubagentRunsReadContext`, rotating across the parents of the 60
active runs. These two flows compact settled resident rows through the normal
registry owner, so selected reads include durable payload hydration; active and
pending-delivery rows retain their normal full shape. The report counts evicted
resident payloads. Only the selected read and optional committed mutation are timed;
maintenance checks and output digesting remain outside measurement. Read time is
fixed to the fixture's timestamp so recent-history classification and digests
match across processes; synchronization and performance clocks remain real.
The report includes each parent's retained/active/selected context counts,
output size, and digest. Compare `outputsSha256` as well as protected-key digests
between baseline and candidate. Prompt output size counts characters; control
size counts selected runs. Control digests omit only the deliberately mutated
delivery attempt counter and normalize the fixture-directory prefix.

Add `--concentrated-root` for a separately labeled topology stress case. It
reparents all retained registry generations to one generated root, preserving
the 4,000 child sessions and 60 active claims in the default team shape. Ordinary
distributed runs cover roughly six retained generations per active parent;
concentrated runs exercise the full 6,000-record scope. This is synthetic
registry topology stress, not the fixture's original session-parent layout.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/subagent-maintenance-capture-measure.ts \
  --state-dir /path/to/new-state --operations 4000 --start-at <future-epoch-ms> \
  --gc-log /path/to/capture.log --output /path/to/result.json > /path/to/capture.log 2>&1
```

Run each side in a fresh process and a new state directory. Setup and warmup
precede `CAPTURE_READY`; use preparation CPUs until that marker, then assign the
pair's interleaved measurement CPUs before the shared start. Use the campaign's
exclusive lock and production guard, then swap placements for the second pair.
Alternatively, `--start-file /path/to/start` waits after preparation until that
file contains a common future epoch in milliseconds for both sides.
The default one-millisecond yield between captures permits event-loop sampling;
it is excluded from per-capture latency but included in elapsed time and CPU.
Use `--allocations` in a separate paired pass for allocation including collected
objects; the default pass measures unprofiled CPU, capture latency, and GC.
For a paced minute use `--team-shape --operations 450 --interval-ms 133`.
`--per-minute 450` projects per-call allocation and CPU at an explicitly assumed
capture rate; it is not a measured production call rate. Main-thread and process
CPU are both recorded. Registry `Map.set` row writes are counted
in a separate unprofiled selected read. GC reports count, total time, maximum pause,
and tails with sample counts; promotion excludes setup and profiler-stop GC.
Apply the campaign's sample-count and paired-delta rules. RSS high water includes
setup. State and profile files remain in the task-owned directory for inspection
and cleanup.

## Session catalog selection

`session-catalog-selection-measure.ts` invokes the real `sessions.catalog.list`
handler with a real row projection over 5,000 persisted synthetic sessions split
between two agents. Two synthetic providers consume the shared planning snapshot
and return 16 rows each. Every measured call follows a committed metadata update
and waits for the row owner to settle before reading its order;
`--unchanged` instead measures repeated calls at one revision. This is in-process
handler evidence, without transport, model calls, or external provider IO.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/session-catalog-selection-measure.ts \
  --state-dir /path/to/new-state --operations 4000 --start-at <future-epoch-ms> \
  --gc-log /path/to/capture.log --output /path/to/result.json > /path/to/capture.log 2>&1
```

Run on the approved benchmark host with a new state directory per process. Setup
and warmup precede `CATALOG_READY`; use preparation CPUs until that marker, then
the pair's interleaved measurement CPUs. Hold one quiet lock and use the shared
production guard; swap placements in the second pair. Add `--allocations` for a
separate paired allocation pass including objects collected by minor and major GC.
Handler latency excludes the metadata write and row settling; allocation, GC, promotion, CPU, and
elapsed time include the write, settling, response hashing, and the one-millisecond pacing
yield. Selection and catalog allocation subtrees are reported separately.

Compare the initial/final full ordered entry hashes and complete response-sequence
hash across baseline and candidate: no response fields are omitted. Assertions
check both providers ran and saw all rows and the expected selection revisions.
Twenty unchanged warmup calls provide context; use `--unchanged --operations 4000`
for a full unchanged comparison. GC reports totals per call, collection counts,
maximum pauses and tails; all tails include sample counts. Apply the campaign's
paired-delta, sample-count and absolute GC pause rules. RSS high water includes
setup; retained state and allocation profiles are task-owned cleanup artifacts.

## Codex adoption candidate preparation

`adoption-candidates-measure.ts` calls the production adoption owner with 5,000
synthetic session entries, including 16 valid adoptions. The main measurement
uses `--team-shape`: the existing generator creates 5,000 persisted sessions,
6,000 retained runs, approvals, cron jobs, and projects, with transcript payloads
disabled. Setup reads the actual stored session entries through the plugin
runtime and uses the first 4,984 alongside the 16 valid adoptions. Generation
runs sequentially on preparation CPUs, before `ADOPTION_READY`. Without this
flag, the smaller setup uses simple in-memory session rows. The real binding store
and decoder read an in-memory fixture adapter; unexpected mutations fail. Each
list gets a new snapshot revision by default; `--unchanged` retains the warmed
revision. This measures candidate preparation and binding decoding, without
Gateway transport, SQLite, or native App Server latency.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/adoption-candidates-measure.ts \
  --team-shape --state-dir /path/to/new-state --operations 4000 --start-at <future-epoch-ms> \
  --gc-log /path/to/capture.log --output /path/to/result.json > /path/to/capture.log 2>&1
```

Run on the approved benchmark host under the shared guard and one quiet lock,
with concurrent baseline/candidate processes and swapped interleaved CPU sets
in the second pair. `ADOPTION_READY` follows fixture preparation and warmup.
`--owner /path/to/baseline-sibling.ts` substitutes an adoption module alongside
its original imports. Add `--allocations` for separate paired allocation passes
that retain samples of objects collected by minor and major GC.

Every result must exactly match the independently constructed ordered adoption
map. Compare result digests across both sides; fixture digests also include the
isolated state-directory paths, which differ between runs. The report includes
bytes per list for the full capture, owner stacks, and key-parser stacks, along
with CPU, latency, GC time per list, promotion, and event-loop delay. All tails
include sample counts and GC includes maximum pauses. Result verification and
pacing are excluded from list latency but included in aggregate measurements.
Apply the campaign's paired-delta, sample-count, and absolute pause rules.

## Gateway startup and restart acceptance

`post-restart-burst-measure.ts --cold-row-reads` measures cold session pages after
a clean restart. Seed two independent, compact team-shaped fixtures sequentially:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-fixture --sessions 5000 --runs 6000 --settled-runs \
  --transcript-mib 0 --projects 0 --port 45637
node --import ./scripts/tsx.mjs scripts/perf/post-restart-burst-measure.ts \
  --state-dir /path/to/new-fixture --entry src/entry.ts --cold-row-reads \
  --clients 70 --seconds 300 --port 45637 --start-at <future-epoch-ms>
```

This mode pairs synthetic devices and seeds three Board widgets before restarting.
After readiness, every client immediately reads a sidebar page, an agent-roster
page, and the Board. It verifies populated responses and reports boot-to-ready,
first-batch and subsequent latency, page-selection count, CPU, GC, and event-loop
delay with sample counts. No model or external service is called. The fixture
keeps session metadata and retained runs but omits transcript bulk and projects.
Use `--row-refresh-owner /path/to/session-row-projection-refresh.ts` to compare
an alternate owner in the same source installation; the report verifies its hash.
Run concurrent pairs under one quiet lock and the production guard, with separate
fixtures and ports, then swap interleaved CPU placements. Start deadlines must
allow both preparation phases to finish. Apply the campaign's sample-count and
paired-delta rules; the 70 first-read samples alone cannot qualify p95 or p99.

Add `--startup-admission --waves 20` to the cold-row command to attribute the
operator request-start backlog. This uses a fixed 20 batches per client instead
of `--seconds`. Each batch sends a scoped `models.list` before an event-only
`sessions.subscribe`, immediately followed on the same socket by the
sidebar, roster, Board, `sessions.resolve`, `sessions.messages.subscribe`, and
keyed `chat.startup` requests. Batches await all replies and retain the
`--poll-ms` pacing. There are no artificial handler delays or held preparations.
Each client uses a distinct shared, unarchived fixture session for catalog,
resolution, message subscription, and startup reads; Board uses the common seeded
session. Results record each client's session key and exact request parameters.
The first batch remains separate from later warm traffic in the latency report.
The explicit catalog RPC reproduces the server's catalog-bootstrap admission
order; this does not exercise capability negotiation or `models.snapshot` delivery.

The `admission` result contains sample counts, total duration, p50/p90/p95/p99,
and maxima for each method's queue wait, admission, handler, and first response.
Queue wait is the operator RPC start scheduler, while admission also includes
work before handler entry. Existing `gateway.chat.startup.*` timeline spans are
sampled in memory through the private source loader; they do not enable timeline
file writes. Additional `startup-boundary.*` samples cover pending-input reads
and optional subagent snapshot preparation across all callers in the measured
window; they are attribution context, not exclusive startup-handler phases.
The difference between handler duration and its observed spans may
include uninstrumented waits; overlapping spans must not be summed as exclusive
time. All responses are checked, including roster pages, event enrollment, session
resolution, message subscription, and startup history page. Diagnostics overflow
or absent startup-handler evidence fails the run. This compact settled fixture
measures reconnect contention, not interrupted agent-turn recovery or large
transcript hydration. Keep identical instrumentation for A/A and A/B runs, use
the campaign's untraced cost gates, and collect promotion separately with
`--trace-gc` and its own controls.
Use `--request-start-owner /path/to/request-start.ts` to compare scheduler
revisions in the same installation. The source loader verifies the selected
file's SHA-256 at load time and records it in the result.

Use `scripts/bench-gateway-startup.ts` and `scripts/bench-gateway-restart.ts`
against an exact-head build and isolated synthetic state. Record the Node version,
source SHA, workload case, host load, and build command. The `default` case is the
primary workload; use `fiftyPlugins` to check plugin scaling when that owner changes.

Keep fresh-process startup and in-process restart separate. Startup must reach
HTTP readiness and successfully serve the benchmark's WebSocket session RPC;
listening alone is insufficient. Restart must complete the supported restart
signal and recover `/readyz`. Record completion, readiness, session RPC, downtime,
process-tree CPU, peak RSS, and startup/restart trace phases where available.

Before changing production code, count operations and capture a separate CPU
profile of startup, including worker threads. Use the frozen SQL workload for
boot, restart, and warmed-turn SQL statements, worker requests, and main-thread SQL.
Do not compare profiled timings with unprofiled timings, or call moving work to a
worker or after readiness a reduction in total work.

For an A/B comparison, interleave at least five baseline and five candidate samples
per workload (ABAB), with identical runtime, build mode, fixtures, and probe settings.
Report median, p95, and min–max; report fresh startup separately from warm restart.
Use the campaign's exclusive timing lock and start each timed sample only below
its one-minute load limit. After a one-hour capacity wait, report operation counts
and profile evidence with latency explicitly unmeasured.

Accept a change only when it removes measured work and improves median readiness
or CPU by at least 5%, without worsening another user-facing median or p95.
Investigate smaller adverse differences instead of claiming equivalence from
spread. A 20% regression in any cell stops the change. Boot/restart SQL and main
SQL must hold or fall; warmed-turn SQL and requests must not increase.
Migrations, credential custody, admission, and required integrity checks remain
before the operations they protect.

## Model prompt statistics

`model-prompt-stats-measure.ts` measures the diagnostic size owner with synthetic
history containing quotes, controls, Unicode, and lone surrogates. It verifies
the exact pre-provider JSON character counts independently of the cache.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/model-prompt-stats-measure.ts --messages 500 --calls 1000
```

Run at least five serial interleaved baseline/candidate samples on the approved
benchmark host. The driver counts new large-text size records outside profiling,
warms 50 calls, then samples allocations including objects collected by both GCs.
A second pass reports sampled surviving allocations after GC, amortized per call;
this is retained churn, not total resident memory or whole-turn retention. GC trace
lines between `PROFILE_START allocation` and `PROFILE_END` belong to the allocation
window; exclude setup and forced profiler-stop collections. Report promotion,
collection counts, and maximum pauses with allocation. Profiled timing is context,
not a Gateway latency measurement. Do not infer tail percentiles from five runs.

## Session tool surface

`session-tool-surface-measure.ts` exercises the production tool pin owner with 50
synthetic tools, each containing 20 nested string fields. It checks unchanged
checkpoint counts, pinned descriptions, and current executable bindings. This is
an owner-only workload, not a Gateway RPC or whole-turn measurement.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs scripts/perf/session-tool-surface-measure.ts \
  --case warm --calls 2000 --start-at <future-epoch-ms> --output /path/to/result.json
```

Repeat with `--case restored` (detached transcript schemas) and `--case guidance`
(restored schemas with changed sibling guidance). `--owner /absolute/path/to/owner.ts`
can select a baseline copy beside the production owner without another checkout.
Use concurrent, swapped, interleaved-core pairs under the host's quiet lock and
shared guard; interrupted pairs do not count. Report paired absolute and relative
deltas. Opposing signs or baseline values differing by more than fivefold are
inconclusive; run a third pair when that metric gates and decide on absolute mean.

Timing excludes fixture construction and warmup. Ten-call synchronous batches
yield for 1 ms; event-loop tails include those yields and carry their own sample
counts. p95 needs 200 samples and p99 needs 1,000 to gate. Major GC is context below
50 collections; report total GC and both sides' maximum pauses. Peak RSS is the
process lifetime high-water mark, including imports and fixtures. Add `--profile`
in a **separate invocation** for CPU and allocation samples including collected
objects; this mode writes `.cpuprofile` and `.heapprofile` beside the JSON report
and ranks serialization/freezing ancestors. Profiled runs supply no timing verdict.
Sum V8 `promoted` bytes only between `MEASURE_START` and `MEASURE_END` in the
unprofiled trace, excluding import, warmup, and forced setup collections.

## Diagnostic heap profile sanitization

`diagnostic-profile-measure.ts` measures the production diagnostics owners on an
approved benchmark host. It does not start a Gateway or exercise RPC admission.
Run the same script against separate baseline and candidate source roots:

```sh
node --import ./scripts/tsx.mjs scripts/perf/diagnostic-profile-measure.ts \
  --source-root /path/to/checkout --mode sanitize --iterations 5 \
  --start-at <future-epoch-ms> --output /path/to/result.json
```

The sanitizer workload has 65,535 distinct frames in a depth-16 binary tree and
131,072 allocation samples representing exactly 4 GiB. This is sampled allocation
volume, not a 4 GiB JSON document or resident heap. It reports output bytes and a
SHA-256 digest so baseline and candidate redaction can be compared exactly. Timing
and CPU measurements exclude source imports and synthetic tree preparation.

The native heap capture requests 600,000 ms with both collected-object flags and
allocates 4 GiB of synthetic array payload over 28 seconds, exercising the owner's
30-second cap. The native CPU capture retains the production stall flight recorder
while requesting its fixed five-second, 10 ms capture; this models the overlapping
native profiler used by a running Gateway. Repeat with `--mode heap` and
`--mode cpu`, each in a fresh process, so sanitizer fixture garbage cannot affect
native capture memory and GC. `--mode all` is convenient for exploratory runs.
`--mode record` writes a small native synthetic heap profile and
its sanitized golden output for an equivalence fixture.

Each result includes operation wall time, process CPU, peak RSS, total GC duration
and count, major GC duration and count, the maximum measured asynchronous callback
and its callback count, and the event-loop delay maximum and sample count. Native
heap capture also records V8 node/sample counts, sampled bytes, and inspector stop
time by observing the owner's inspector result. Response JSON serialization is
included in the measured operation. Callback
timing includes GC and host preemption; it is not a profiler-derived CPU duration.
No latency percentiles are inferred from the five sanitizer iterations. Major GC
remains context-only below 50 collections per side.

Peak RSS is the operating system's process-lifetime high-water mark, including
setup and earlier iterations. Compare the last value from each fresh process.
It does not use a main-thread timer, which would miss the synchronous baseline's
peak while sampling the yielding candidate. The event-loop histogram is primed
before timed work so it also observes the first synchronous task.

For acceptance, hold one exclusive quiet-slot lock around concurrent baseline and
candidate processes and use identical `--start-at` values. Use interleaved physical
cores within that slot, then swap placements for a second pair. Evaluate the mean
of the paired percentage deltas; reject a mean at least 20% adverse or a metric at
least 10% adverse in both pairs. Follow the host's production load, dirty-page, and
event-loop guard before and during every pair. Keep fixture recording and all
preparation outside the measurement CPU allocation.

## Session pull-request subscriptions

`session-pr-subscriptions-measure.ts` runs a real source Gateway in a separate
process, waits for its readiness probe, and uses signed synthetic WebSocket clients and the standard 5,000-session
fixture. Prepare fixtures sequentially outside measurement CPU allocations:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-fixture --sessions 5000 --runs 4000 \
  --approvals 0 --cron 0 --projects 0 --transcript-mib 0 --port 41567
node --import ./scripts/tsx.mjs scripts/perf/session-pr-subscriptions-measure.ts \
  --root /path/to/new-fixture --output /path/to/results --port 41567 \
  --clients 8 --keys 50 --operations 1000 --subscribes 256 --interval-ms 100 \
  --start-at <future-epoch-ms>
```

Each tab watches one active and 49 passive session PR targets. The measured
writer alternates an unrelated session's category through `sessions.patch`;
`--mutation label` alternates its label instead. Both use the general session
patch commit path and emit canonical replacement notifications. These commits
exercise the stored-row notification path even when PR
snapshots remain unchanged. The child counts eligible row notifications, samples
all main-isolate allocations (including collected objects), and captures GC and
promotion. Controller and socket-driver allocation is excluded. Notify RPC
latency reports the mutation round trip; notify settlement latency continues
through the native subscription owner's idle barrier. Settlement is an upper
bound including controller and IPC overhead. Each mutation settles before the
next scheduled mutation, and scheduling delay records any workload overruns.
Setup identifies the subscription owner's native work scope
from its direct caller stack, then restores the original tracking method before
measurement. Exactly one scope must be found; connection and ingress lifetimes
are excluded. Native idle barriers run inside the allocation capture and record
settlement duration; failure to settle within 30 seconds fails the run. Cold setup
snapshots are saved separately. After warmup and timed subscriptions, every client
must receive ready snapshots with task receipt fields for all watched keys before
notification measurement. Initial and final captures both wait for a response on
each WebSocket after settlement. Final observations must match these warm initial
snapshots; canonical hashes sort clients and session keys, while raw frames preserve
delivery order for inspection. Snapshot artifacts are saved even if equality fails.

Use separate identical fixtures and ports for both sides. The common
`--start-at` starts subscribe timing; notification timing starts 30 seconds later.
Add `--list-every 8` to interleave a 200-row sidebar list with every eight stored-row
updates. The allocation window includes these requests and reports their latency
separately. Resource snapshots include selection counts by kind and caller; the
run must observe parent selections during setup; the notification window can
eliminate them entirely when lineage is unchanged. This exercises
the retained sidebar and task-PR descendant paths together, without assuming that
their synthetic ratio is the production ratio.
A missed scheduled phase fails the run. Compare concurrent pairs under one
host measurement lock, use interleaved physical cores, and swap sides for the
second pair. Repeat with `--clients 1` to distinguish fixed from per-tab costs.
The result includes sample counts for every tail: p95 requires at least 200 and
p99 at least 1,000 observations to gate. Major GC is context below 50 collections
per side; total GC remains the gate. Reject a mean paired regression of at least
20%, or a metric at least 10% worse in both pairs. Inspect family allocation
share and snapshot captures alongside total allocation at the matched workload.
To compare a small owner-only change without another source tree, place candidate
copies of `control-ui-session-task-prs.ts`, `control-ui-session-pr-read.ts`,
`control-ui-session-pr-subscriptions.ts`, `session-row-projection.ts`,
`session-row-projection-revisions.ts`, and `session-row-scope.ts`
beside the originals with a `.candidate.ts` suffix and pass `--owner-suffix candidate`.
The child verifies all substitutions loaded; results record the owner hashes
and the optional `--revision` label.

## Async context allocation

`async-store-measure.mjs` compares Node's native runner, the shared single-copy
runner, the consolidated production context fields, and experimental parent-linked
or indexed carriers. Run on an approved benchmark host with Node 26:

```sh
node --import ./scripts/tsx.mjs scripts/perf/async-store-measure.mjs stock 26 200000
node --import ./scripts/tsx.mjs scripts/perf/async-store-measure.mjs single 26 200000
node --import ./scripts/tsx.mjs scripts/perf/async-store-measure.mjs consolidated 26 200000
node --import ./scripts/tsx.mjs scripts/perf/async-store-measure.mjs linked 26 200000
node --import ./scripts/tsx.mjs scripts/perf/async-store-measure.mjs slots 26 200000
```

Repeat for 1, 8, 10, 20, 26, and 40 outer stores. Each invocation starts in a fresh
process, warms 20,000 entries, samples collected allocations at 512-byte intervals,
reports bytes per entry with allocation sample counts, then measures unprofiled
entry and oldest/middle/newest lookup time separately. The consolidated variant
enters the same owner fields through one frozen record, sharing their values.
`nativeFrameBytesPerRun` counts samples rooted at Node's `AsyncContextFrame`
constructor separately from total entry allocation. Pass a final profile path to
retain the raw collected-object profile. V8 may inline that constructor out of
sample stacks; zero native-frame samples yield a `null` frame-byte estimate,
not evidence of zero frame allocation.
The persistent carriers are experiments, not production context owners. These
mechanism measurements do not establish Gateway GC or latency improvements; use
the concurrent, swapped-core Gateway workload for acceptance.

`main-thread-stall-measure.mjs` measures the real stall-attribution owner with the
same sampling and warmup protocol. It reports calls, sampled bytes per call,
sample counts, and separately timed calls per second:

```sh
node --import ./scripts/tsx.mjs scripts/perf/main-thread-stall-measure.mjs entry 21 50000
node --import ./scripts/tsx.mjs scripts/perf/main-thread-stall-measure.mjs same-name 21 50000
node --import ./scripts/tsx.mjs scripts/perf/main-thread-stall-measure.mjs phase 21 50000
```

`entry` establishes an async task; `same-name` reenters its inherited task;
`phase` labels synchronous work without an inherited task, as when entering a
stored owner context. Each callback checks its visible task name. Run identical
commands on baseline and candidate; these owner costs do not measure the
frequency of each case in a Gateway workload.

## Workboard dashboard reads

`workboard-read-measure.ts` exercises the real source Gateway and Workboard SQLite
owner over signed synthetic WebSocket connections. Run it on an approved benchmark
host. Prepare each fixture outside the measurement CPU allocation:

```sh
node --import ./scripts/tsx.mjs scripts/perf/workboard-read-measure.ts \
  --root /path/to/new-fixture --port 41510 --prepare --boards 24 --cards 50
node --import ./scripts/tsx.mjs scripts/perf/workboard-read-measure.ts \
  --root /path/to/new-fixture --port 41510 --clients 12 --waves 80 \
  --interval-ms 250 --start-at <future-epoch-ms> --output /path/to/result.json
```

Preparation creates 1,200 synthetic cards through public RPCs; their example PR
URLs cause no GitHub requests. Measurements warm all board pages, then replay
concurrent `workboard.boards.list` and `workboard.cards.list` calls, first without
writes and then after one card status change per wave. Every response verifies
card counts, board status aggregates, and changed card status. Reuse an untouched
prepared fixture for each sample; measured status writes remain in its state.

Reports include calls, errors, round-trip and handler p50/p99, response JSON bytes,
Gateway process CPU, worker request classes, and observed board aggregate/metadata
read commands on the existing worker transport. Handler seconds per 15 minutes
are extrapolated from this replay's request rate, not a production forecast.
Diagnostic loss, missing handler observations, stale data, and missed scheduled
phase starts fail the run. This measures server RPCs, not browser rendering.

For A/B comparisons use separate identical fixtures, ports, and source checkouts.
Hold the host's exclusive measurement lock around each concurrent pair, use the
same `--start-at` on both sides, and swap CPU halves for the next pair. Both warm
and mutation phases have independent shared start times. Compare paired
differences across at least two pairs; record outside load for context.

## Usage metadata bursts

`chat-metadata-burst-measure.ts` requests `sessions.usage` on a cold 5,000-session
fixture while ten signed synthetic clients observe the real Gateway. Prepare a
fresh fixture for every sample; the read populates the usage cache:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-fixture --sessions 5000 --runs 0 --approvals 0 \
  --cron 0 --projects 0 --transcript-mib 1 --port 41483
node --import ./scripts/tsx.mjs scripts/perf/chat-metadata-burst-measure.ts \
  --root /path/to/new-fixture --port 41483 --clients 10 \
  --duration 60000 --output /path/to/result.json
```

Results classify metadata frames, count usage publications and their event-loop
ticks, and record main-thread CPU plus synchronous WebSocket send CPU. Send CPU
excludes Gateway JSON encoding and asynchronous socket work. Final assertions
require all 5,000 usage entries to be cached and every socket to have received the
latest committed usage receipt. The fixture uses synthetic model configuration
and makes no model calls.

For concurrent A/B pairs, use identical separate fixtures and `--start-at` with
the same future epoch milliseconds to synchronize Gateway launch. The measurement
starts once each Gateway's sockets connect; waiting for idle would let startup
warm the usage cache and erase the cold workload. The script rejects fixtures with
existing usage rollups and rejects any run where startup publishes usage before
all clients connect, including partially warmed samples.
`--metadata-owner /path/to/server-chat-metadata-lifecycle.baseline.ts` replaces
only that module; place the baseline beside the original so relative imports
remain valid. Swap the CPU halves for the next pair and compare paired differences.

## Codex process inspection

`codex-process-inspection-measure.ts` starts a real isolated Gateway, touches and
retains `--ballast-mib 8192` of fixed memory, then measures `CodexAppServerClient.start`, durable child
registration, and `initialize` against a synthetic stdio peer. It verifies the
initialized notification, registration fingerprint, polite shutdown, and deletion
of the registration after each sample. It does not run model turns or full attempt
policy preparation. Run only on the approved Linux benchmark host, using fresh
state and loopback ports for each side:

```sh
node --import ./scripts/tsx.mjs scripts/perf/codex-process-inspection-measure.ts \
  --state-dir /srv/perf-sandbox/<lane>/state-a --port 41570 \
  --samples 200 --ballast-mib 8192 --start-at <future-epoch-ms> \
  --output /srv/perf-sandbox/<lane>/result-a.json
```

Use `--snapshot-owner <baseline-sibling.ts>` to replace only the process snapshot
owner through a module resolution hook. Reports separate actual main-thread peer
and inspection spawns and their synchronous durations, startup and cleanup time,
CPU, observed RSS, event-loop sample counts, and total/major GC. Actual RSS includes
the 8 GiB ballast plus Gateway/worker heaps; those heaps can shrink after setup, so
the fixture never sizes ballast against transient startup RSS. Setup and one warmup
are excluded; whole-run CPU/GC also include the registration verification reads.
Hold one shared quiet lock around each concurrent pair, give its sides interleaved
CPUs, then swap sides for the second pair. Use the production guard before and
during each pair. Decide on the mean of paired deltas: reject a mean at least 20%
adverse or a metric at least 10% adverse in both pairs. p95 requires 200 samples per
side and p99 requires 1,000; reported eligibility is per side, so both sides must
qualify. Major GC is context-only below 50 collections per side.

## Startup with a populated multi-agent fixture

For a bounded multi-agent boot workload, use the opt-in `teamBoot` case:

```sh
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case teamBoot --fixture-root /path/to/new-fixture --seed-only
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case teamBoot --fixture-root /path/to/new-fixture \
  --runs 1 --warmup 0 --timeout-ms 90000 --start-at <future-epoch-ms> \
  --output /path/to/result.json
```

This fixture has 44 synthetic startup-active plugins, eight local agents, 5,000
shared session entries, and 128 MiB of inert synthetic shared-state payload. It
uses the normal database and session writers and keeps clean-close seals. It
does not provision remote workers or make model/channel calls. Actual database
sizes and inventory are recorded in `team-boot-fixture.json` and copied into the
result. Seed each side sequentially outside the measurement window. Payload
writes checkpoint every 8 MiB and pause between batches; Linux generation stops
if system dirty pages reach 2 GiB. A failed seed has no completion marker and
must be regenerated in a new directory.

To measure a mix of bundled and external plugins, pass
`--bundled-plugin-fixture /path/to/plugins.json` to both the seed and run commands.
The file is an OpenClaw config fragment with `plugins.allow` selecting 1–44
bundled IDs and `plugins.entries.<id>.config` supplying any required synthetic
configuration. For example, `{ "plugins": { "allow": ["memory-core", "openai", "google"] } }`
uses plugin defaults. Optional `models`, `tools`, and `channels` sections select
the corresponding startup capabilities; enabling a plugin alone does not
override its lazy activation policy. Other root sections and `plugins.load`
are rejected, preserving the benchmark's state, workspaces, auth, and disabled
background jobs. Each bundled ID replaces one synthetic external plugin,
keeping the total at 44. The fixture disables implicit `memory-core` activation;
include it in the requested inventory to enable it. Include only synthetic
configuration and credentials, disable scheduled external work, and deny external
network access for the run.
Channels remain suppressed even when configured for plugin activation.
The fixture metadata and result contain the full config fragment and external
count; a run rejects configuration that differs from its seed or a loaded
inventory that is not 44 plugins including every requested bundled ID. Use the
bundled IDs from the target deployment's startup log and build their artifacts
before measuring. Omit the flag to retain the all-synthetic fixture.

To reproduce startup waiting for pending GitHub publication recovery, add
`--publication-git-delay-ms 10000` to both the seed and run commands. This keeps
the same plugin and session inventory and binds one existing session to a tiny
local managed worktree with a retained publication request. Its historical
requester authority is absent, so recovery must inspect the local workspace and
then refuse publication without credentials or network access. A fixture-only
`git` executable delays one exact read-only config command in that worktree,
then delegates to the real Git executable. Other Git commands run normally.
The fixture preserves its explicit PATH so startup does not replace that Git selection.

The sample's `publicationRecovery` records the delay and start/release epoch
timestamps. Missing or incomplete boundary markers fail the measurement. The
controller waits for that read, initial post-ready database maintenance, and the
last handler-prewarm phase before teardown. CPU and RSS therefore cover the same
startup work on both builds; `completionMs` includes that work while `readyz.ms`
and `firstSessionRpc.ms` measure availability independently.
Use a newly seeded root for each sample: completed requests and boundary markers
make these publication fixtures intentionally single-use. Delays are bounded to
30 seconds and must match the seed. This tests subprocess waiting at the real
publication owner; it does not simulate GitHub response semantics.

Startup results include spawn-to-`/readyz` and spawn-to-first-successful
`sessions.list` timings. The `teamBoot` protocol handshake uses the isolated
Gateway's synthetic shared token so access-policy plugins receive a real owner
identity; other cases retain loopback `auth: none`. Session RPC probing starts when `/healthz`
first responds, concurrently with `/readyz`, and retries startup refusals until
the shared deadline. A healthy HTTP endpoint without a successful session RPC
fails the measurement. The `teamBoot` case also requires the expected seeded
session; an empty or unrelated roster does not count. `startupTraceLines` preserves every observed startup
trace line, including repeated spans; `startupTrace` retains the existing numeric
summary. All benchmark Gateway ports are at least 40000. If the host's ephemeral
port range cannot provide one, the benchmark reports a setup error after bounded
attempts instead of waiting indefinitely.

Samples record teardown duration in `shutdownMs` and forced process-tree cleanup
in `shutdownForced`; the summary includes shutdown timing statistics. The
`teamBoot` case allows 30 seconds for graceful teardown and fails if the child
exits nonzero, dies from a signal, or requires forced cleanup. Other cases keep
their existing teardown policy.

For paired comparisons, prepare separate roots from the same seed inputs and
pass the same future `--start-at` to both controllers. Use the host's exclusive
measurement lock, pin each side to its assigned 16-core half, swap the halves on
the next pair, and compare each pair's candidate-minus-baseline difference.
Build and seed outside the measurement CPU allocation. Keep every root and
temporary directory inside the task-owned sandbox and remove them after use.

## Startup with interrupted subagent runs

The `interruptedRegistry` case starts a real Gateway against 86 retained runs:
78 completed rows and eight unfinished rows across eight synthetic child agents.
Four unfinished rows remain `running`, and four are already `interrupted` with
aborted session state. All rows retain completion expectations and requester-turn
claims, including the delivered, cleanup-complete rows: all 86 are activation
obligations, not cold history. They share eight requester cohorts; the unfinished
rows share two of those cohorts, four per requester. The seed command
commits the fixture in a child writer, then sends that writer `SIGKILL` while its
SQLite handles remain open. This preserves actual unclean-close/WAL residue;
the run/session records are synthetic, not captured from a predecessor Gateway
or model execution. No models, credentials, or external channels are used.

```sh
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case interruptedRegistry --fixture-root /path/to/new-fixture --seed-only
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case interruptedRegistry --fixture-root /path/to/new-fixture \
  --runs 1 --warmup 0 --timeout-ms 90000 --output /path/to/result.json
```

The output includes spawn-to-`/readyz`, spawn-to-Gateway-ready, all activation
trace spans, per-run recovery times, and database bytes. The driver waits for all
eight recovery events and verifies exactly one event per unfinished run, eight
durable terminal error outcomes, all 86 retained rows, and unchanged execution
outcomes for the 78 completed rows after shutdown. Requester claim metadata may
change during settlement. The synthetic rows have no saved operator source, so
this proves orphan and missing-source settlement; it does not exercise successful
operator authority restoration, resuming a model, or external delivery.
Activation subspans can overlap or sum concurrent groups, so compare the outer
activation elapsed time separately from the component totals.

Prepare fresh roots sequentially for each side of every pair; recovery mutates
the fixture. Use the same `--start-at <epoch-ms>` for concurrent A/B starts under
the benchmark host's exclusive measurement lock, and swap the assigned CPU
halves for the next pair. Build and seed outside the measurement allocation.

## Startup with one checking agent

The startup benchmark has an opt-in `slowAgentDatabase` case. Prepare each side
sequentially before the measurement window, then run one cold startup per fixture:

```sh
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case slowAgentDatabase --fixture-root /path/to/new-fixture --seed-only \
  --agent-database-mib 512 --agent-gate-delay-ms 10000
node --import ./scripts/tsx.mjs scripts/bench-gateway-startup.ts \
  --case slowAgentDatabase --fixture-root /path/to/new-fixture \
  --runs 1 --warmup 0 --timeout-ms 90000 --output /path/to/result.json
```

The fixture contains five agents with one interrupted subagent each. All runs
belong to independent requester sessions owned by the first healthy agent, so
one parent's unrelated conversations must recover independently. Four agent
databases are small; the fifth contains the requested MiB of synthetic cache
payload. Its clean-close seal is removed under offline fixture custody, forcing
the real integrity scan. A benchmark-only preload delays that scan by the
requested duration, then executes the original SQLite statement. Use zero delay
to measure the native scan separately. This simulates a long check without
writing the incident's tens of gigabytes onto a shared host.

Results retain `/readyz`, the integrity gate's start and completion times, and
each agent's recovered session status event. The driver waits for all five
recovery events before teardown and rejects missing observations. No models or
external channels run. Generate a fresh fixture for every sample; recovery
mutates the synthetic records. Use separate roots and identical inputs for
concurrent A/B pairs, with the host's measurement lock and alternating CPU halves.
The case also requires every healthy agent to recover before the slow integrity
gate passes, the slow agent to recover afterward, and zero admission errors.
An unfixed baseline exits nonzero for the ordering failure while still writing
its measurements; distinguish this expected result from setup or missing data.

Use one fixture for local and sandbox performance repros:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /tmp/openclaw-team-shape --launch
```

The destination **must not exist**. The generator refuses existing directories and
symlinks instead of overwriting state. Everything it creates lives below that
path: SQLite stores, config, HOME, temporary files, logs, Git repositories and
worktrees. No operator data or credentials are copied. The launcher runs the
repository's `pnpm openclaw gateway run` with an isolated environment, binds only
loopback (default port 40967), and forwards shutdown signals through the existing
managed-process helper. It does not install or restart a service. Ctrl-C stops
the launcher and Gateway; the fixture remains available for inspection.
The profile `team-shape-<port>` and its explicit native service names keep dev
build ownership checks separate from the host's default Gateway.

Use a checkout with dependencies installed. The normal dev launcher may build
missing/stale runtime artifacts; on hosts that prohibit builds, prepare the
checkout on the authorized benchmark host. Generation itself does not need a
Gateway build. Never point another running Gateway at a directory being seeded.
Package-manager caches are isolated too: Corepack or pnpm version shims may
download the pinned package manager into the fresh HOME. For offline launch,
put a directly installed copy of the repository's pinned pnpm version on PATH.
The launcher intentionally does not reuse an operator's package-manager cache.

## Shape and repeatability

Defaults are 5,000 sessions in the `main` agent, 6,000 retained subagent runs,
200 pending approval recovery records, 100 disabled cron jobs, and 12 registered
projects with committed synthetic Git repositories and real worktrees.

Sessions have 24 synthetic human identities, assigned owners, 1–5 participants,
a 70/10/10/10 split of shared/read-only/suggest/draft visibility, pinned rows and
20% archived rows. Activity timestamps span 30 days. Transcript weights use an
80/17/3 percent short/medium/long distribution, with weights 1/16/128. The seed
controls both size assignment and synthetic payload content. Retained runs mix
successful terminal, failed terminal, pending announcement, and interrupted
with completed cleanup. The 60/15/15/10 slot mix applies before older pending
generations are settled; only latest generations keep pending announcements.
Actual state counts are included in the summary. Twenty percent of sessions are
roots, with children distributed across them and repeated runs in time order. Supporting state uses the existing
storage owners and schema; the generator changes no product schema.

Use `--settled-runs` for steady-state measurements that need the retained run
inventory without a subagent restart-recovery backlog. All requested runs remain
present with terminal execution, delivered completion, and completed cleanup;
failed-terminal outcomes, timestamps, and parent/child generations remain intact.
The default mixed lifecycle shape is unchanged. The summary records `settledRuns`
and the resulting state counts. This flag does not change pending approvals;
use `--approvals 0` when that recovery work is also outside the workload.

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /tmp/openclaw-team-shape-large \
  --sessions 5000 --runs 6000 --approvals 200 --cron 100 --projects 12 \
  --seed 967 --now 1791892800000 --transcript-mib 7000
```

`--transcript-mib` is total **logical message text**, not physical database size.
The default is 64 MiB. Deterministic high-entropy text prevents compression from
turning gigabytes of repeated padding into a tiny database. The persisted size
also includes transcript projections and SQLite overhead: use the reported
`agentDatabaseBytes`, not the requested MiB, when comparing fixtures. Memory is
bounded by transcript batches rather than total payload size. For tens of GB,
raise this option and verify free disk space first.

For deep histories, add `--long-transcript-entries 2000 --long-transcript-sessions 4`.
This appends the requested number of alternating user/assistant messages to the
first selected retained sessions, in addition to the weighted transcript text.
Each message contains 1 KiB of synthetic text; each assistant message also carries
a distinct deterministic 16 KiB thinking signature. The selected session count
defaults to four and is capped by `--sessions`. The combined logical payload,
including conservative signature/envelope allowance, must fit within 1 GiB when
this stress shape is enabled.

`--worktree-files 270000 --nested-repository` adds an unchanged tracked inventory
of empty files and an untracked committed nested Git repository to the first
registered linked worktree. Other project worktrees retain their small fixture
shape. These flags require `--projects` greater than zero; the tracked inventory
is capped at 500,000 files. Writes are sequential. On Linux, generation checks
dirty memory every 1,000 files and every 2 MiB transcript batch, pauses at 1 GiB,
and fails at 2 GiB. Generate on the authorized benchmark host and record actual
database size and dirty-memory observations.

The default seed is 967 and the default reference time is 2026-10-13 12:00 UTC.
Pass the same `--seed` and `--now` to reproduce logical data. Set `--now` near the
measurement date when testing retention; a frozen old epoch intentionally makes
rows old. Filesystem paths, database admission metadata and project registration
timestamps are host-dependent, so SQLite files are not byte-identical exports.
`team-shape-summary.json` records inputs, counts, actual bytes, Node version and
elapsed generation time. Generation failure leaves the partial directory for
diagnosis; remove only that task-owned fixture before retrying.

Pending approvals represent a **startup recovery backlog**, not live authority.
The real Gateway cancels prior-epoch requests on boot. Pending announcements also
participate in normal recovery; their next attempt is delayed one day from the
reference time. Generate a fresh fixture for each startup comparison. Cron jobs,
heartbeats, channels, plugins, browser automation and network discovery are
disabled so this workload does not call models or external integrations.

## Census native async-context frame copies

`async-context-probe.cjs` attributes native `AsyncLocalStorage` frame copies to
store construction sites. Use it only in an isolated synthetic Gateway on the
authorized benchmark host, under that host's resource limits and production
guard. It validates the runtime's private `AsyncContextFrame` Map representation
at startup and fails clearly if unavailable; Node 26.12 is the campaign runtime.
Load it before Gateway modules so CommonJS and ESM imports receive the tracked
constructor. Existing stores appear as `untracked`.

For a synthetic channel-and-tool workload, first prepare the private QA runtime
as described in [the channel-turn benchmark](../bench-channel-turn.md). From the
checkout root, create a task-owned entry wrapper and pass it to the harness:

```sh
mkdir -p .local/async-context-probe
cat > .local/async-context-probe/entry.mjs <<'EOF'
import { fileURLToPath } from "node:url";
process.env.OPENCLAW_ASYNC_CONTEXT_PROBE_OUT = fileURLToPath(
  new URL("./census.json", import.meta.url),
);
await import("../../scripts/perf/async-context-probe.cjs");
const entry = new URL("../../src/entry.ts", import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
EOF
node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts \
  --entry .local/async-context-probe/entry.mjs --tool-args-chars 4096
```

Set probe options inside the wrapper because harnesses sanitize child environments.
`OPENCLAW_ASYNC_CONTEXT_PROBE_OUT` is required and its parent directory must exist.
`OPENCLAW_ASYNC_CONTEXT_PROBE_SAMPLE_EVERY` defaults to 8 (approximately one in
eight copies; 1 samples all), and `OPENCLAW_ASYNC_CONTEXT_PROBE_INTERVAL_MS`
defaults to 30000. The JSON file is replaced atomically at startup, each interval,
and normal process exit. Forced termination can lose the final partial interval.
Use separate wrappers/output paths for baseline and candidate; do not add this
preload to `NODE_OPTIONS`, which would also instrument children and workers.

`copies` counts native `enterWith` calls, including restorations: native `run`
copies twice when changing a value, while `runWithAsyncStore` copies once. Sampling
uses a fixed pseudorandom sequence to avoid always selecting the restoration half.
`samples`, `frameSizeHistogram`, and `meanFrameEntries` describe the **source**
frame being copied, including entries whose value is undefined. `meanActiveEntries`
counts non-undefined values; it makes no claim about their authority or liveness.
`owners` ranks construction sites by sampled entry presence, with separate active
and undefined counts. Several stores created at one site can appear in one frame,
so `entriesPerSample` is a mean count, not a presence probability. `enteringOwners`
records exact copy counts and sampled source-frame weights for the store issuing
each copy. Sort `owners` by `active` or `undefined` to inspect those contributions.
Only code locations and numeric counts are retained; store values are never logged.

This example includes startup plus one cold and ten warm synthetic turns. Record
the harness's completed turns alongside the census; a failed or shortened workload
does not give comparable counts. The same wrapper works with a longer `--entry`
harness for tools/subagents or with `idle-gateway-measure.ts` for an offline
team-shape fixture. These are instrumented work counts, not measured frame bytes,
allocation, promotion, GC, or latency. Run allocation profiling and uninstrumented
acceptance pairs separately with matched workloads and runtime versions.

## Calibrating paired GC measurements

Before rejecting an allocation change on GC/work, run identical-source A/A
controls with the same runtime, fixture, pacing, warmup, capture length, and CPU
placement as the candidate comparison. Use at least four independent concurrent
pairs, swapping placements each pair. Keep every valid observation and report
both sides, absolute and relative paired deltas, and the two-pair gate result for
pairs 1–2 and 3–4. Four pairs can expose a false rejection; they cannot precisely
estimate the false-positive rate. A guard-interrupted pair is discarded whole.

Use `transcript-broadcast-measure.ts --diagnostics` **without** GC tracing,
allocation or CPU profiling for natural-GC timing gates. Each RPC round without
background polling records `naturalGc`: completed operation count, timing-gate
eligibility, and GC milliseconds per operation split by kind. `diagnostics.gateway.gc` supplies
collection counts, pause tails, and maxima; `eventLoopDelay` includes its sample
count. The diagnostic capture also records Node/V8 versions, process age, and
heap-space sizes before and after. Compare young-generation capacity: equal
source does not imply equal nursery size after startup or an idle wait.

Measure promotion separately with `--diagnostics --trace-gc` and matched A/A
controls. This adds main-isolate `gcTrace` and `promotedBytesPerOperation` but marks
timing as ineligible for gates. Node's GC event clock spans its prologue/epilogue
callbacks; V8 prints the trace after stopping its collection-pause clock and
before the epilogue callback. Trace serialization/output can therefore inflate
GC-event and loop timings. Retain those raw observations for attribution; do not
subtract trace overhead or replace total GC cost with the narrower trace-pause
sum. Tracing also forces an initial identification GC before capture, so compare
baseline and candidate within the same mode. See the
[Node callback timer](https://github.com/nodejs/node/blob/v26.12.1/src/node_perf.cc#L166)
and [V8 trace boundary](https://github.com/nodejs/node/blob/v26.12.1/deps/v8/src/heap/heap.cc#L1716).

The allocation profiler is a separate experiment. Its stop operation forces GC;
the outer `diagnostics.gateway` window includes that operation. Use allocation
results for bytes/work, never that outer window as evidence of natural GC cost.

For synchronized warm starts, give both drivers the same new `--start-file` path.
After both print `PHASE warmed`, atomically publish a future epoch in milliseconds
to that file. It replaces `--start-at`; missed deadlines fail the run. Keep the
wait short and record the resulting process ages. This aligns workload start,
not maintenance phase: repeating maintenance can be scheduled from the preceding
pass's completion. Keep maintenance enabled and preserve its logs.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/fresh-team-shape --entry src/entry.ts \
  --scenario plugin.scope --clients 1 --runs 1 --operations 1000 \
  --warmup-operations 40 --rpc-interval-ms 132 --rounds 1 \
  --port 41580 --mock-port 41582 --diagnostics \
  --start-file /path/to/pair-start --revision <source-sha>
```

`--scenario cron.list` validates 40 disabled announce/last jobs targeting one
synthetic session, including their full list and delivery previews. Generate
fresh fixtures with `--cron 40 --cron-announce-last`; use `--rpc-interval-ms 1100` to
exercise uncached reads. `--scenario board.get` prepares and validates three HTML
widgets. `sessions.list` and `plugin.scope` retain their existing response checks.
Generate both fixtures sequentially with matching inventory and zero transcript
bulk when testing these metadata reads. Do not reuse the cron fixture across runs.

If A/A crosses the proposed GC or promotion threshold, classify that short-window
comparison as inconclusive. Select a longer **fixed work count** from the pilot,
then freeze it before the candidate run and repeat the A/A control. Include
several natural major collections per side when major-cycle phase drives the
variance, and report counts even when insufficient. Do not stop each side after
its own target collection count, force collections inside measurement, discard
maintenance-overlapping outliers, trim major pauses, or divide cost by major
cycles: each can remove a real frequency-dependent cost. Keep untrimmed GC/work
as the primary cost and report pooled absolute cost/work alongside paired deltas.
Retain the campaign's tail sample requirements and maximum-pause safeguard.
A noisy control does not establish that a candidate is regression-free.

## Measure idle Gateway allocation and timer work

`idle-gateway-measure.ts` connects one real Control UI client to an owned Gateway,
then sends no application requests during the measured window. Use a freshly
generated, offline team-shape fixture for each side; omitting `--state-dir`
retains the small empty-state workload. `--output` must name a new artifact
directory. The fixture config is preserved and an isolated measurement config
is written under the output directory.

```sh
node --import ./scripts/tsx.mjs scripts/perf/idle-gateway-measure.ts \
  --state-dir /srv/perf-sandbox/<lane>/fixture-a \
  --output /srv/perf-sandbox/<lane>/idle-a \
  --entry src/entry.ts --port 41563 --minutes 3 --settle-seconds 60 \
  --start-at <future-epoch-ms> --allocations
```

Run on the authorized benchmark host under its measurement lock, resource limits
and production guard. Concurrent baseline/candidate runs need separate fixtures,
output directories and loopback ports (40000 or higher), the same `--start-at`,
and the host's interleaved CPU sets, swapped for the second pair. The start barrier
follows readiness and settling; a missed barrier fails the run. Actual capture
timestamps are recorded so placement and start skew remain visible.

`result.json` records main-isolate CPU, GC durations and counts, event-loop p99 and
sample count, and V8 promoted bytes for the capture only. `--allocations` uses the
shared private IPC profiler to include objects collected by minor and major GC;
the saved heap profile and summary include the top allocation sites and estimated
bytes per minute and second. Worker allocations are excluded. `--profile` captures
a main-isolate CPU profile and its diagnostics over the measured window; promotion
accounting requires a run without `--profile`. Run CPU and allocation profiling
separately. Neither profiling mode exposes an inspector listener or copies operator
credentials.

Use `--timers` in a separate attribution run to collect per-timer callback counts,
CPU and worker snapshots. It instruments timer creation and adds periodic IPC
samples, so leave it off for allocation/GC acceptance comparisons. Compare paired
per-minute allocation, promotion and total GC time; retain counts and maximum
pause alongside any tail percentile, applying the campaign's sample-count and
absolute-delta rules rather than treating sparse tails as gates.

## Measure clean-close seals across app versions

`seal-version-restart.ts` measures the real cold-process agent database open,
including its integrity gate, without launching a Gateway. Run it only on the
authorized Linux benchmark host with separate baseline/candidate checkouts and
state directories. Seed the two fixtures **sequentially**, under the host's
non-measurement CPU allocation:

```sh
node --import ./scripts/tsx.mjs scripts/perf/seal-version-restart.ts seed \
  --state-dir /srv/perf-sandbox/seal-version/base-state --mib 2048
node --import ./scripts/tsx.mjs scripts/perf/seal-version-restart.ts open \
  --state-dir /srv/perf-sandbox/seal-version/base-state \
  --refresh-proof --expect-version 2026.10.4 --expect-full-scans 1
```

The seed refuses existing directories, writes deterministic high-entropy JSON
into the existing `cache_entries` table in paced 2 MiB transactions, and uses the
database owner's checkpoint and close paths. It pauses above 1 GiB of Linux
`Dirty` memory and stops at 2 GiB. It never copies a database or runs `VACUUM`.
The fresh `open --refresh-proof` process establishes full verification of the
populated database. Subsequent `open` commands require the completed fixture
marker and a physical agent database of at least 2 GiB.

Before each pair, set only `package.json`'s version to the old value in **each
isolated sandbox checkout**, then run `open --refresh-proof` separately to
reseal both fixtures. Change only that package version to the new value and run
the two measured opens concurrently with the same future `--start-at <epoch-ms>`.
Use `--expect-version` on every open: `OPENCLAW_VERSION` does not override the
package version in the seal policy, and a nearby `build-info.json` can take
precedence. Baseline expects `--expect-full-scans 1`; candidate expects `0`.

Hold `/srv/perf-sandbox/.quiet.lock` around the concurrent pair. Use A on CPUs
96–111 and B on 112–127, then swap those halves for the next pair; take at least
two pairs and record `mpstat -P 96-127` alongside them. Prepare fixtures and
reseal on CPUs 64–95. Compare B minus A within each pair. JSON reports include
effective version, database bytes, seal-match state, full-scan count, integrity
gate milliseconds, and total cold-open milliseconds including seal lookup.
This is cold process admission, not cold OS page cache; it does not measure
Gateway readiness or model/channel startup. Record those limits with results.

## Shared writer contention from audit retention

`scripts/bench-channel-ingress-writer.ts` measures the real audit FIFO, ingress
queue, and interactive machine-state writer against synthetic retained audit rows:

```sh
node --import ./scripts/tsx.mjs scripts/bench-channel-ingress-writer.ts \
  --state-dir /tmp/writer-bench --seed-only
node --import ./scripts/tsx.mjs scripts/bench-channel-ingress-writer.ts \
  --state-dir /tmp/writer-bench --seconds 60 --output /tmp/writer-bench.json
```

Seed requires a new database. Defaults populate 100,000 execution contexts and
250,000 decision facts, then offer three audit items, one inbound message, one
idle-drain poll, and one interactive write per second. Audit work alternates
identity and decision inserts; this models enabled identity collection at its
retention caps, not the ordinary run/tool-only audit mix. Reports include worker
queue/service timing, ingress and interactive latency, and persisted-work checks.
This exercises storage owners, not Gateway transport, external channels, or a model.
Use `--help` for smaller fixtures and synchronized concurrent A/B start times.
Prepare fixtures separately from measurement and compare paired differences on
the authorized benchmark host, swapping CPU allocations between pairs.

## Measure the real list endpoint

For browser-originated model and cron list traffic, point the headless probe at an
already running isolated Gateway with synthetic state and authentication:

```sh
node --import ./scripts/tsx.mjs scripts/perf/catalog-polling-measure.ts \
  --url http://127.0.0.1:40967/ --duration 60 --output /path/to/catalog-traffic.json
```

The probe creates a fresh browser context and observes real WebSocket frames
before navigation. It separates cold startup, visible idle, an offline-triggered
reconnect, Cron navigation and idle, and a retained return to Cron. `--duration`
is seconds per idle phase. Startup and navigation settle for five seconds after
UI readiness. If Chromium's offline mode does not close the socket, the report
marks reconnect unobserved instead of claiming a reconnect measurement. Counts,
JSON frame bytes and rates per authenticated socket-minute exclude payloads,
URLs and authentication. Supply any synthetic token through the normal URL
fragment. The probe builds nothing and neither starts nor stops the Gateway.

Add a real cron workload with `--cron-runs 12 --cron-jobs 20 --interval-ms 2000`
and optionally `--screenshot /path/to/runtime-complete.png`. Use a fresh isolated
Gateway with cron enabled and `agents.defaults.heartbeat.every` set to `"0m"`.
The probe creates disabled synthetic jobs, then forces runs through `cron.run`;
system-event payloads and disabled heartbeats keep model providers out of the
workload. Every forced run must finish and its event must reach the browser.
A separate configuration-edit phase verifies that a changed job name becomes
visible. Only browser list requests are counted; the controller socket is
excluded, and the created jobs are removed on exit.

For board/chat document loads, use `--load-runs 5 --load-path /dashboard --duration 12`.
This mode retains synthetic `cron.list`, `models.list`, `users.self`, and `sessions.describe` parameters,
response bytes, `models.snapshot` event counts, paint entries, and native Long Task
blocking (the sum of each task's duration above 50 ms). It records the first cold
browser context separately from later documents that retain browser cache and
storage. `--phase-seed` selects deterministic randomized reload delays; paired
sides must use matching seeds, routes, and `--start-at` times. Reloads use fixed
slots from that shared start time; a missed slot fails the run. Use
`--expect-session <key>` to assert the committed session and `--open-details` for
chat Details. Optional `--request-stacks` adds caller stacks for diagnosis;
leave it off for paired timing. Use only synthetic requests:
parameters, stacks, and model rows are retained; authentication and other response
payloads are omitted.

Add `--reload-census` to count every RPC during that load window. This mode keeps
parameter keys and opaque query IDs instead of parameter values; matching query
IDs identify exact duplicates within one document. It also records native Long
Animation Frame blocking and timestamps of changed sidebar row inventories.
With `--request-stacks`, `--asset-dir /path/to/control-ui/assets` maps callers
through the matching build's source maps.
The first nonempty inventory and the last inventory change are DOM milestones,
not paint times. Keep caller-stack diagnostics separate from untraced paired
timing, and use matching fixture state, seeds, and observation windows.
`--storage-state` accepts a synthetic Playwright storage-state file; use
`--min-sidebar-rows` to reject captures with an empty or collapsed fixture roster.

`control-ui-reload-fixture.ts` prepares a real Gateway fixture with 5,000 sessions,
6,000 retained runs, 120 sessions assigned to the synthetic viewer, eight personal
pins, seven browser plugins, and a synthetic model catalog. It seeds a dashboard
widget through RPC and writes a Playwright preference file with Coding expanded.
Run preparation sequentially on the benchmark host, with built runtime and UI assets:

```sh
node --import ./scripts/tsx.mjs scripts/perf/control-ui-reload-fixture.ts \
  --state-dir /path/to/fixture --ui-root /path/to/control-ui --prepare
node --import ./scripts/tsx.mjs scripts/perf/control-ui-reload-fixture.ts \
  --state-dir /path/to/fixture --ui-root /path/to/control-ui
```

The default ports are 41514 (Gateway), 41515 (widget sandbox), and 41516 (proxy).
Use distinct ports and state directories for concurrent sides. Once each fixture
has been seeded, `--skip-seed` preserves its state on subsequent launches;
`--runtime-entry` selects a separately built baseline or candidate runtime.
Use the printed route with `--storage-state /path/to/fixture/browser-storage.json`,
`--reload-census --min-sidebar-rows 10 --duration 15`. No provider credentials or
model inference are needed. The fixture uses 8 MiB of transcript content rather
than a multi-gigabyte database; this workload measures reload acquisition and rows.

To isolate session activity from model selection, use
`--activity-patch-sessions <key-a>,<key-b>` with `--load-runs 1` against existing
synthetic sessions. This alternates navigation between those conversations and
changes their labels at `--interval-ms`, without inference or model changes.
It excludes `--activity-session` and `--activity-cron`. Catalog observations
retain model rows for before/after option comparisons; use only synthetic
catalogs. Compare warm session-scoped request counts and activity blocking time,
keeping the initial catalogs separate from the activity window.
Add `--activity-catalog-refresh` to request unchanged catalog renewal from a
separate controller every third activity step. The fixture's live provider returns
the same rows as its static catalog. Controller requests are recorded in `activity`
and excluded from browser request counts. This isolates browser invalidation after
explicit renewal; it does not prove which production action triggered a renewal.
With `--open-details`, the final check reopens Details for the selected conversation
after the activity window, then compares its session identity, label, model, status
note, and thinking level with a fresh controller-side descriptor. It records this
as an input-state comparison, then separately checks the visible conversation
header's label. The controller read is excluded
from browser request counts; compare activity requests only between
`activityStartedAtMs` and `activityEndedAtMs`. Request traces retain the preceding
event's session key, reason, timestamp, and revision to distinguish event-driven
reads from navigation or idle reads. Use `--request-stacks` for caller diagnosis,
then omit it for paired timing.
Failed attempts retain the available browser probe under `failure`, including
failures in the final Details assertions; they are diagnostics, not accepted samples.

Add `--activity-row-mix` to the two-session patch workload to cycle selected-session
label changes, other-session status changes, selected-session status changes,
sidebar hover, sidebar scrolling, session opening through the sidebar, and opening
the session menu with an owner-submenu hover. The two keys must be visible in the
synthetic sidebar; the reload fixture's session 1 and pinned session 2 work. Use
`--reload-census` to count every browser RPC. Each action records its following
observation window, `sessions.changed` events, `sessions.describe` requests and
session-scoped `models.list` requests; the report also normalizes the warm window
to requests per tab-minute. An interval contains deferred work from preceding
actions too, so use the retained event timestamps for causal attribution. Closed
menu panel, owner-submenu and avatar inventories are captured at readiness and
before the activity window. The menu step waits for its root panel and the owner
search input, recording their separate automation-to-visible times. With
`--screenshot`, the first open owner menu is also captured beside the final image;
omit screenshots during paired timing. This mode does not need model inference.

On Linux, pass `--gateway-pid <pid>` using `gatewayPid` from the reload fixture's
ready record to capture that Gateway's main-thread CPU during the warm window.
CPU per action and (with `--reload-census`) CPU per browser RPC include controller
patches and background work; they are workload-normalized costs, not handler
self-time. Keep both sides' fixture, interval, seed and duration identical, and
keep caller-stack recording off for timing runs. The report retains each RPC's
timestamps for latency analysis; report sample counts with any derived tails.

Use `--activity-delete-sessions <key-a>,<key-b>,...` with `--load-runs 1` and
`--expect-session <different-visible-key>` to isolate unrelated session removals.
Supply one distinct existing synthetic key per interval: 12 keys with
`--duration 24 --interval-ms 2000` performs 12 deletions. This mode excludes other activity
modes, preserves the visible conversation, requires each deletion to succeed,
and waits for its keyed `sessions.changed` event. The retained event trace also
shows any unscoped deletion notification and its following browser requests.
Deleted keys are consumed; use fresh keys or a fresh synthetic fixture per run.

For account service-tier observations, launch the reload fixture with
`--service-tier-port <unused-loopback-port>` and run the browser probe with
`--activity-service-tiers --load-runs 1 --expect-session <existing-key>`.
The fixture serves a synthetic OpenAI Responses endpoint returning `fast`; its
log records only the requested/returned tier and timestamp, never prompt content.
The probe creates two uniquely named sessions using the real `openclaw` runtime
and `openai/gpt-5` model: one requests priority, the other ultrafast. It completes
one warmup turn per session before browser navigation, then alternates real
`chat.send` turns and waits for successful `agent.wait` settlement. No inference
credentials or external provider calls are needed. The visible conversation
remains unchanged so catalog/descriptor requests expose cross-session effects.

Use `--duration 42 --interval-ms 2000` for 21 measured initiating turns and
`--reload-census --gateway-pid <fixture-pid>` for browser request counts and
Gateway main-thread CPU. Verify the fixture log contains the expected alternating
priority/ultrafast requests in addition to both warmups; a successful controller
response alone does not prove model execution. Compare total CPU and CPU per
fixed initiating turn, not CPU per remaining browser RPC. This mode excludes
patch, delete, mixed-interaction, catalog-refresh and cron workloads.

For steady model selection with multiple active conversations, use
`--activity-run-mix --activity-session agent:main:main --activity-models openai/gpt-5`.
Start the reload fixture with
`--subagent-seed --service-tier-port <unused-loopback-port>` to expose its native
spawn tool and synthetic provider.
The probe asks its synthetic provider to invoke `sessions_spawn` once,
finds that exact native child by parent and unique label, then warms three
conversations and completes concurrent real turns in each. `--activity-cron` replaces every fourth cohort
with a forced cron run. `--activity-interactions` adds separately timed sidebar
hover, model-picker opening, and conversation navigation after each cohort.
Initial catalog/descriptor responses settle before the warm window; the report
retains actual elapsed time and a post-window model/speed-control observation.

Launch the reload fixture with `--stream-delay-ms 75` to stream three chunks per
response, and `--service-tier-responses fast,default` to alternate provider tier
observations while model selections and requested tiers remain fixed. The default
is still a single immediate response returning `fast`. Compare steady responses
and changing observations separately; these synthetic transitions establish the
invalidation path, not the production frequency of provider tier changes.

For active-session loads, add `--activity-session <synthetic-key>` and configure
that isolated Gateway with two loopback mock-provider models:

```sh
node --import ./scripts/tsx.mjs scripts/perf/catalog-polling-measure.ts \
  --url 'http://127.0.0.1:40967/#token=synthetic-token' \
  --load-runs 1 --load-path /chat/main --expect-session agent:main:main \
  --activity-session agent:main:main --duration 60 --interval-ms 2000 \
  --request-stacks --output /path/to/active-chat.json
```

The driver cycles a model selection, the same selection with a changed label, a
status/pinning/thinking patch, and a real chat turn. Models default to
`openai/gpt-5.6-sol,openai/gpt-5.6-luna`; override with `--activity-models` to match
synthetic configuration. Each turn must finish successfully through `agent.wait`.
Add `--activity-cron --open-details` to include forced runs of a temporary disabled
cron job while Details is visible; this requires an `agent:<agent-id>:main` session.
Each cron run must finish within a bounded wait and reach the browser as a matching
finished event before the driver records success.
The driver binds the job to that agent and session and removes it afterward;
cleanup failures remain in the report.
Use `/dashboard/main` to exercise the same session's board surface.

The activity window begins after readiness and five seconds of settling. Its
fixed action count is `floor(duration * 1000 / interval-ms)`; startup time never
reduces the workload. Reports retain activity start/end, action latency, warm
Long Task blocking, and the event preceding each catalog request. Session event
metadata includes catalog-change flags, model-selection revisions, and lifecycle
phases; message and response bodies are excluded. Caller stacks are diagnostic
only. With `--start-at`, the active window begins thirty seconds after the
scheduled navigation and fails if readiness misses that deadline. Use one load
per invocation for paired activity measurements.

For paired activity measurements, use `--start-at <epoch-ms>` with the same future
time on both sides; it gates the runtime window after browser readiness and
rejects a missed deadline. Hold the host's shared measurement lock, use separate
Gateway states and ports on the two 16-core CPU halves, then swap the halves for
the next pair. Compare per-pair request-count differences. This small catalog
fixture covers the browser event trigger, not production database size, model
inference, native clients, or a model-catalog mutation.

Build runtime artifacts on the authorized benchmark host, generate an offline
fixture, then let the measurement driver own its loopback Gateway:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-measure.ts \
  --state-dir /path/to/team-shape --port 40967 --clients 35 \
  --samples 5 --limit 100 --poll-ms 5000 --revision <commit-sha>
```

This replaces the former external one-socket timing mode. `--state-dir` must
contain a generated fixture; the driver stops its own child on completion or
interruption. Startup recovery settles for ten seconds before clients connect.
Clients close and reconnect in cohorts of at most 30, below the per-IP pending
handshake budget. After this one reconnect wave, each variant gets its first
full-response cohort in turn, followed by separate blocks of the requested
steady cohorts. The variants are sidebar,
general, compact, explicit profile involvement, the sidebar ownership summary, and
children. Setup creates one shared dashboard parent and four children through
the real RPC, adding five rows to the seeded inventory. Persistent dashboard
lineage keeps this query independent of terminal-run link expiry. Every variant must return nonempty rows;
the owner query must also return nonempty owner counts. Seed `--now` near the
measurement time so retained child lineage has not expired.
The ownership summary matches `sidebar-owner-session-counts.ts`: one row,
unarchived state, all human owners, and the sidebar's automation/system exclusions.

The driver measures one variant at a time, with all clients issuing the same
query concurrently and one request in flight per socket. Cohorts begin no faster
than `--poll-ms`; 35 clients at five seconds produces about 420 list calls per
minute during steady blocks. Requests use the normal conditional/delta revision
handshake. `--mutation-ms 1000` adds one synthetic label edit per second through
`sessions.patch` during steady blocks, including that work in CPU totals. Each
block schedules only the ticks strictly before its nominal final cohort (19
edits for five cohorts at five seconds and one-second mutations), waits up to
five extra seconds for delayed ticks, and rejects an incomplete mutation count.
This keeps the recorded workload independent of response speed. This is a
controlled shared-query workload, not a complete browser scheduler replay.

Results in `list-measure-*/result.json` include per-variant reconnect/steady
latency p50/p95/p99, response sizes and full/unchanged/delta counts, row work
counts, raw RPC admission/queue observations, and main-thread/process CPU.
The existing private IPC profiler writes CPU profiles and numeric handler-phase
diagnostics alongside the report. Selection/preparation, row projection,
decoration and response phases are separate. Decoration includes delta/fact
sharing and defaults; response CPU includes serialization and transport enqueue.
The existing probes do not split delta encoding from other decoration work.
Handler wall time includes yielded/awaited time and must not be read as CPU.
The profiler affects both sides equally; no inspector listener is exposed.

Use identical fresh fixtures and options for A/B. `--start-at <epoch-ms>` waits
after readiness and fails if the deadline has already passed, allowing both
sides of a concurrent pair to begin together. Apply the current host policy:
hold the shared measurement lock, place A and B on their separate 16-core halves,
then swap halves for the next pair. Record the exact revision, fixture counts
and physical database bytes; a 64 MiB text fixture preserves roster/run shape
but does not reproduce multi-GB transcript page-cache pressure.

## Measure branch reads across idle worker retirement

`branch-rotation-measure.ts` drives compressed Control UI WebSockets against an
owned loopback Gateway and an offline team-shape fixture:

```sh
node --import ./scripts/tsx.mjs scripts/perf/branch-rotation-measure.ts \
  --state-dir /path/to/team-shape --output /path/to/new-result-directory \
  --entry /path/to/prepared/dist/entry.js --port 41451 \
  --clients 40 --cohorts 12 --poll-ms 10000 --revision <commit-sha>
```

Each viewer reads a distinct shared transcript through `sessions.branches.list`
and `chat.history`, alongside `sessions.list`. Before each cohort, an alternating
`verboseLevel` patch invalidates the database write-token shortcut without
opening the maintenance reader. A label patch is unsuitable for that purpose:
label-owner discovery itself retains a maintenance connection.

The warm phase uses startup-prewarmed readers. The private benchmark IPC preload
then publishes the existing memory-pressure event and waits until all transcript
workers have exited before the cold phase. This exercises the real retirement
owner without changing production timers or custody rules. After cold traffic,
one label patch deliberately recreates the scoped maintenance reader; two more
cohorts measure recovery under continued invalidating writes. The report separates
the deliberate retirement from request-driven rotations and records lifecycle
counters, CPU, memory, request counts, and raw latency samples. First-use warm
cohorts are reported separately from steady cohorts.

For paired comparisons, pass the same future `--start-at <epoch-ms>` to both
drivers. Warm, cold, and recovery phases have shared absolute deadlines; a missed
deadline fails the run. Generate matching fixtures sequentially, hold the shared
measurement lock around each concurrent pair, and swap the two 16-core allocations
between pairs. Metadata-only writes permit matched fixture reuse after a completed
pair. Compare paired differences; keep outside load samples with the results.
This isolates the worker-rotation mechanism; it does not replay model streaming
or establish which historical operation started or ended a production episode.

## Measure managed workspace reuse at turn startup

The workspace computation driver's `startup` scenario calls the managed sandbox
workspace owner again for each sample, including both directions of checkpoint
synchronization. It uses 32 tracked files per directory, changes the requested
number of guest files before each sample, and verifies their canonical contents
and settled recovery state afterward.

```sh
node --import ./scripts/tsx.mjs scripts/bench-workspace-computation.ts \
  --scenarios startup --sizes 10000 --concurrency 1 --file-bytes 128 \
  --changed-files 1 --runs 10 --warmup 1 --output /path/to/report.json
```

Prepare matching fixtures sequentially with `--prepare-root`, then measure them
with `--reuse-root`. Use the shared quiet-slot lock and guard for concurrent
baseline/candidate pairs, swap CPU assignments, and pass the same `--start-at`
timestamp. The driver reports latency, CPU, RSS, event-loop delay and GC samples.
Initial projection creation happens before measurement: this measures reuse,
not cold container provisioning or chat time to first model request. Use the
Gateway chat workload separately for those end-to-end timings.

## Measure history reader construction

`session-history-reader-setup-measure.mjs` isolates the history reader factory
and, optionally, its exact owner-construction expression from a pinned runtime
source. It exercises two synthetic runners before measuring setup. It does not
measure database admission, workers, history queries, or Gateway latency.

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-history-reader-setup-measure.mjs \
  --owner src/config/sessions/session-transcript-worker-readers.ts \
  --runtime-owner src/config/sessions/session-transcript-worker-runtime.ts \
  --operations 200000
```

Use `--allocations` in a separate pass for sampled allocation, including collected
objects. Unprofiled setup timing, CPU, shared method counts, and retained bytes
are reported separately. For an isolated source capsule, copy the reader and its
`session-transcript-worker.types.ts` sibling and use `--capsule` without the source
loader. The capsule replaces three unrelated imports with throwing sentinels;
calling any of them fails the run. The report includes source hashes. Do not use
capsule results as end-to-end history or GC evidence.

Paired runners can share an initially absent `--start-file` with distinct
`--side baseline` and `--side candidate`. Each writes a `.ready` marker after
warmup; the coordinator then publishes a future epoch in milliseconds to the
start file. Use matched instrumentation, exclusive host admission, and swapped
CPU placement for comparisons. Keep allocation-profile timing separate from
unprofiled timing.

## Measure history pages and checkout diffs

Prepare a team-shape fixture offline, then add this workload's small synthetic
transcript and Git worktree. Run generation and measurements on the authorized
benchmark host:

```sh
node --import ./scripts/tsx.mjs scripts/perf/history-diff-measure.ts \
  --state-dir /path/to/team-shape --seed
node --import ./scripts/tsx.mjs scripts/perf/history-diff-measure.ts \
  --state-dir /path/to/team-shape --port 41072 --clients 4 \
  --operations 25 --rounds 5 --revision <commit-sha>
```

`--seed` requires exclusive offline custody and refuses a second seed. It adds
one session with 64 completed tool turns (8 KiB, 64 KiB, and 256 KiB tool results),
captures a clean checkout baseline, then changes `--tracked-files` (default 32)
tracked files and creates `--untracked-files` (default 32) untracked files.
Add `--dirty-baseline` when seeding to capture a pre-session edit in each tracked
file before replacing it with the measured edit. The populated baseline overlaps
every tracked response path, exercising baseline fingerprint comparison without
hiding the later edits. This requires at least one tracked file and records the
captured count in `baselineFiles`.
`--unchanged-files` (default 0) adds small committed files to increase checkout
size without increasing the diff. Counts are nonnegative; setting both changed
counts to zero measures a clean checkout. For example, seed with
`--tracked-files 32 --untracked-files 100 --unchanged-files 6000` to exercise a
larger index and untracked set. Measurement reads the saved counts, so these
options only configure `--seed`. All repositories, worktrees and data remain inside the fixture.
Add `--managed-worktree` when seeding to register the checkout as owned by the
measured session and create its accepted local workspace projection with the
actual committed base. This exercises managed-workspace review and registry
resolution before the Git read. The default remains an unregistered Git
worktree. The seed summary records this choice; measurement needs no matching flag.
Measurement never writes the database directly. The driver owns and stops its
loopback Gateway; `--entry` defaults to `dist/entry.js` and also accepts a prepared
source entry. It issues small, default, and large `chat.history` requests, plus
full `sessions.diff` requests for both `all` and `uncommitted` scopes. Summary
requests are excluded. Repeated full requests exercise the existing diff cache
and its checkout-revision validation.
Add `--mutate` during measurement to rewrite identical bytes to `tracked-0.txt`
before each diff cohort, including concurrent warmup. This advances filesystem
freshness while preserving the exact response hash and exercises full diff
collection after cache invalidation. It requires a changed tracked file.
Each operation is one concurrent cohort with one request per client. Empty
history, counts that differ from the seed, missing full patches for a nonempty
diff, or RPC failures reject the run. Keep changed-file counts within the
product's diff limits; the driver does not treat truncated inventories as complete.

The default client retains the existing local administrator recipe.
`--scoped-reader` instead uses a synthetic profile with exactly
`operator.sessions.read`, exercising per-person session visibility and retained
read authority. The driver writes a separate configuration under the output
directory with loopback-only trusted-proxy authentication, one allowlisted
`example.invalid` identity, and a read-only role. It supplies those synthetic
proxy headers through a WebSocket client using the Control UI protocol identity;
no browser, real account, external proxy, or credential is involved. The
connection must return the exact narrow scope, and `users.self` must identify an
individual profile before measurement begins. Profile creation occurs through
the Gateway's normal authentication path.

The first request for each variant is recorded separately as warmup. Then
`--warmup-cohorts` (default 5) warms every concurrent reader before measurement.
With `--start-at <epoch-ms>`, those cohorts run within the final 10 seconds before
the shared start, keeping burst readers warm. A missed readiness deadline rejects
the run. Alternatively, `--start-file <path>` requires an initially absent file
and emits `warmed: true` after the concurrent warmup. The pair coordinator waits
for both warmed messages, then atomically publishes a future epoch in milliseconds
to the shared file. Each driver reads that deadline and rejects invalid or passed
values. The two start options are mutually exclusive. The report records the
requested start, actual per-round start and first dispatch skew. CPU profiling
and CPU snapshots begin after the barrier, excluding its idle wait.
Measured rounds include raw latency samples, p50/p95/p99, payload bytes, returned row
counts, main-thread/process CPU, CPU profiles and existing worker queue, run,
and transfer diagnostics. Each sample includes `payloadSha256`, computed after
omitting the top-level absolute `root` and `sessionKey`; each round lists its
distinct hashes. Compare matching diff hashes across A/B reports to establish
identical response content despite different fixture roots. Within one run,
every diff response must match its warmup hash because the workload preserves
checkout content, including with `--mutate`. Payload bytes measure re-encoded JSON in the driver,
not WebSocket frame overhead. Profiles sample the main isolate; worker task
diagnostics provide worker timings. `gitSpawns` counts actual Git trace2 `start`
events during each workload round; `gitSpawnsPerRpc` divides by completed RPCs.
These are Gateway-wide workload-window counts, including any concurrent Git
activity. Trace writes are enabled identically on both comparison sides and
their overhead is included; trace parsing runs in the driver after capture.
Diagnostic captures also include RPC admission/handler/response durations,
session diff stages (scoped retention, resolution, repository access, managed
review base, Git, and synchronous response encoding/socket enqueue), and separate
`checkout.revision` and `checkout.diff` worker round trips. These are nested
measurements: do not add a parent duration to its child stages. The stage channel
observes sub-second requests without enabling slow-request logs or recording
session keys, paths, or diff contents.
`--output` names a new artifact directory (by default below the fixture).
`--scenario` defaults to `all`; individual choices are `history-small`,
`history-default`, `history-large`, `diff-all-full`, and
`diff-uncommitted-full`. For a concurrent A/B
comparison, select one matching scenario on both sides so faster completion does
not move one side into a different workload. Generate independent, identical
fixtures for each side, with matching client/operation/round counts and the same
`--start-at <epoch-ms>`. The barrier waits after readiness and warmup, and fails
if the deadline has passed. Hold the shared measurement lock around the pair,
and swap the two CPU halves for the next pair.

Add `--allocations` to replace CPU sampling with main-isolate allocation sampling
for the same history/diff requests and response checks. Each scenario/round records
`clients × operations` completed RPCs. Its `profile` includes sampled bytes per
operation, allocation sites, and separate major/minor/incremental/weak-callback GC
summaries; `promotion` includes V8 promoted bytes and bytes per operation. The
stdout-only GC log is parsed after the owned Gateway exits and the log is flushed,
excluding workers and GC outside the capture. CPU totals remain available.
Both profiling modes wait for the start barrier before starting capture, excluding
barrier idle time; first-dispatch skew includes profiler setup.
Compare matching modes and shapes. Workers, external
buffers, and controller allocations are outside the main-isolate estimate.

For a history-owner comparison using one source tree and dependency installation,
pass `--entry src/entry.ts --history-source /path/to/owner-copies`. That directory
must contain `chat-history-session-read.ts` and `chat-history-handler.ts`; the
benchmark preload substitutes only those modules and the report records their
SHA-256 hashes. Keep the rest of the source fixed for both sides.
History payload hashes normalize only `sessionInfo.snapshotAt` to zero and the
fixture root to `<fixture>`; response content and field order remain intact.
The first normalized response is saved as `<scenario>.json` for byte comparison.

For a diff-owner comparison, pass `--entry src/entry.ts --diff-source
/path/to/session-diff.runtime.ts`. A child-only preload substitutes that source
at its canonical module URL, including inside Git workers, so relative imports
retain their normal ownership. The report records the source SHA-256 and worker
load receipts; a source that never loads fails the run. Both sides otherwise use
the same source tree and dependency installation. Combine `--dirty-baseline`
at seed time with `--mutate --scenario diff-uncommitted-full` during measurement
to exercise repeated baseline filtering. Keep fixture generation sequential and
run simultaneous pairs under the host guard with swapped interleaved CPU sets.

## Measure transcript broadcast fanout

With runtime artifacts built on the authorized benchmark host, seed a fixture
without `--launch`, then run:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --clients 60 --runs 20 --rounds 5 --chunks 500
```

The driver starts its own loopback Gateway and a credential-free SSE model
fixture on ports 41033 and 41034. It creates one shared parent and 20 shared child
sessions through `sessions.create`, then resets their histories through
`sessions.reset` before each comparison. The full seeded inventory remains;
these small sessions avoid large-history compaction and retained-run announcement
work obscuring broadcast costs. Standard memory search is disabled and both main
and child run concurrency match `--runs`. Every client subscribes to session-list
events and messages for the same 20 children. Actual `agent` and `agent.wait` RPCs
exercise the full turn and transcript publication paths;
each synthetic model answer streams deltas paced 10 ms apart (100 by default;
the example uses 500 to sustain overlap). Each warmup/measured cohort holds its
primary model responses until all requested, uniquely marked turns arrive, with
a 45-second admission timeout, then streams their answers together. Parent
announcements and utility requests receive one short acknowledgement and are
counted separately. A fixed 10-second post-readiness delay allows retained-run
startup recovery to settle before setup. One concurrent round
warms the Gateway before five measured rounds. `--port`, `--mock-port`,
`--chunks`, `--chunk-interval-ms` (default 10), `--clients`, `--runs`, and
`--rounds` adjust the workload.
Warmup and each measured round drain until no model streams remain and all
subscriber events have been quiet for one second, with a 15-second timeout.

Results under the fixture's `broadcast-measure-*` directory include Gateway
logs, event counts, peak concurrent model streams, and CPU snapshots from the
Gateway's private benchmark IPC preload. Main-thread CPU excludes the driver
and model fixture. Port conflicts reject before RPCs; readiness requires the
owned Gateway's bind-success log and live IPC. Lost clients, event-sequence gaps,
incomplete per-client transcript/list fanout, or an incorrect primary request or
overlap count fail the measurement. `mainThreadMsPerSessionEvent` divides by
the validated `session.message` plus `sessions.changed` copies per client;
other event counts remain in the report. It includes all Gateway work during the
round, including the drain interval, so it does not isolate broadcast CPU and
CPU per second includes that quiet interval. Compare the same event counts and
concurrency on both revisions, and report the actual database size. For a roughly 5 GiB fixture, seed with
`--transcript-mib 1500` rather than the 64 MiB logical-text default. The driver
stops its Gateway and model fixture on completion or interruption and retains
synthetic state for inspection. Never target a running Gateway's state.

For session-event frame comparisons, add `--session-row-deltas` to negotiate
row patches and `--session-envelope-refs` to also negotiate
`session-event-field-refs` (the latter requires row patches). Both are opt-in;
the default client capabilities are unchanged. A suitable starting swarm for
each 16-core half is `--clients 38 --runs 8 --rounds 5 --chunks 500`.
Add `--exact-clients 1 --activity-summaries` to model one transcript subscriber
and 37 roster viewers receiving Activity recap changes. `--exact-clients`
defaults to all clients; a mixed audience negotiates optional roster message
bodies. Recap mode creates ordinary shared sessions, since recaps exclude
subagents, and requests `sessions.activitySummary.ensure` after each completed
turn cohort. Measured rounds must observe both recap model requests and recap
change events; the model fixture serves the recaps without external inference.
Add `--recap-burst-repeats 20 --recap-burst-interval-ms 50` to replay repeated
Activity ensure requests after that cohort's recap reaches every socket. These
are real `sessions.activitySummary.ensure` RPCs against unchanged transcripts;
the driver does not invoke publishers or invent state transitions. Each repeat
sweeps the same sessions in batches of 20, sequentially, with a minimum 50 ms
start-to-start interval between sweeps. Repeats default to zero and are capped
at 100; the interval defaults to 50 ms and is capped at 1000 ms. Use identical
parameters for both revisions. No extra agent turns occur inside this phase.

`recapPhase` separates the turn and initial recap fanout from repeated ensures,
including frame/byte counts by audience, recap model request counts, RPC response
states, timestamps, and repeated-ensure main-thread/process CPU. A zero model
request count during repeated ensures establishes unchanged-source churn rather
than additional inference. Current ensure responses enqueue no recap source work.
If the last ensure reports `updating`, every socket must receive a current recap
after that sweep started; a receipt retained from the initial phase cannot satisfy
this wait. CPU includes RPC admission, source checks, and the subsequent one-second
event drain. With `--cpu-profile`, the repeated-ensure phase also saves
a main-isolate profile and reports `broadcastSampledMs`: inclusive sampled time
under `broadcastInternal`, including recipient projection, encoding, and sends.
This is a sampling estimate, not a precise socket-only timer. The driver uses
the Control UI's row decoder with negotiated patches/field references, requires
the latest cohort's distinct recap text and `current` state on every socket, and
compares its timestamp with a final `sessions.describe` read. `recapReceipts`
records observed recap transitions. `latestValueDelivery.committedToReceivedMs`
measures the first current receipt minus the summary's `updatedAt` clock, including
commit/publication/transport delay; compare its maximum with the desired one-second
budget. `finalReceiptAfterLastEnsureMs` reports trailing delivery after the last
repeat response, or zero when the already-correct recap remains unchanged. These
prove delivery into the same decoder as the UI, not browser rendering latency.
`--list-interval-ms 1000` adds concurrent compact `sessions.list` polling, one
request at a time per client, and reports successful latency samples and
p50/p95/p99. Invalid or failed list responses reject the run.
Add `--poll-seed <seed>` to randomize each client's initial poll phase across the
list interval and jitter subsequent intervals uniformly from 0.5 to 1.5 times
that interval. The deterministic sequence is independent per client and round;
use the same seed on both sides of a pair. Polls remain sequential per client,
so a slow response delays its next poll. The report retains initial phases and
all request timestamps for seeded runs. Without this flag, polling retains its
original synchronized start and fixed interval.
Add `--diagnostics` identically on both sides to capture per-round Gateway and
replay-controller event-loop delay (20 ms sampling), GC pause totals, and bounded
internal operation aggregates without starting CPU or heap profiling. List
samples also retain the response ID, client index, round, start/end timestamps,
and duration; `p99Request` identifies the nearest-rank round p99. For a multi-round
pair, sort all `sessionsList.requests` by duration to identify its pooled p99.
These timing records contain no RPC payloads; `--capture-responses` separately
opts into representative response payloads, as described below. Gateway
metrics cover its main isolate, not worker isolates. Capture adds overhead, so
compare equally instrumented pairs and keep earlier uncaptured runs distinct.

To isolate a stream-start burst, use `--stream-start-diagnostics`. It captures
main-isolate diagnostics from immediately before turn admission until every
primary mock request has arrived, then separately for the first 500 ms after
the mock releases those responses together. Stopping admission capture and
starting release capture adds two private IPC round trips before release on
both revisions. Each new capture waits 25 ms and then samples the owned child's
CPU counter as a checkpoint, priming the 20 ms loop-delay timer before admission
or release. Capture timestamps include this priming interval. A delayed stop can extend the window; use the reported capture
timestamps and duration. These captures can run alongside whole-round
`--diagnostics` without CPU sampling. `streamStart.phases` records controller
epoch timestamps for admission, first/last classified primary request, cohort
release, first primary SSE write, and completion of all turns. Request/write
timestamps are observed by the mock, not by the Gateway's SSE consumer.

Add `--cpu-profile` for attribution runs. The private IPC profiler samples only
the Gateway main isolate from before admission through release plus 500 ms,
writing `stream-start-<round>.cpuprofile` and its diagnostics sidecars. The result
includes the 40 hottest functions by sampled self time; raw samples remain for
windowed or caller analysis. Sampling and profile serialization add overhead,
so omit this flag for acceptance timing. `--active-work-diagnostics` enables the
real diagnostics Prometheus plugin and scrapes its endpoint while all primary
responses remain held. Each round must report exactly `--runs` running sessions
and zero queued sessions before release; this scrape is included in admission
timing. For example, run on each authorized 16-core measurement half:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --clients 8 --exact-clients 1 \
  --runs 80 --rounds 5 --chunks 500 --chunk-interval-ms 10 \
  --list-interval-ms 2000 --poll-seed stream-start-1 \
  --diagnostics --stream-start-diagnostics --active-work-diagnostics
```

Compare release-window event-loop max/p99 and pooled list p95 across concurrent
pairs, swapping CPU halves and changing the shared poll seed between pairs.
Use list request timestamps to identify polls overlapping release; whole-round
latency alone can hide a burst. Existing completion, concurrency, event-order,
and fanout checks still apply. This fixture uses synthetic model streams;
provider latency and external tool execution are outside this comparison.

Use `--stream-start-allocations` to sample main-isolate allocations, including
collected objects, from before admission through release plus 500 ms. This writes
`stream-start-<round>.heapprofile` and diagnostics sidecars. It cannot be combined
with whole-round `--allocations`. Divide sampled bytes by `runCount` for bytes per
started stream; `observedSessionPublications` counts `session.message` and
`sessions.changed` received by the first viewer during capture. This is a received
publication denominator, so events still in flight at the boundary are excluded.
Sampling and stopping/serializing the profile add overhead; keep these attribution
runs separate from unprofiled acceptance timing. `--trace-gc` adds V8 GC logging to
the owned Gateway's log only. With `--active-work-diagnostics`, each successful
held-stream scrape is retained as `held-streams-<cohort>.prom` for GC counter context.

`eventBytes` measures the exact received, uncompressed JSON frame bytes,
including the event envelope, before parsing. `sessionEventSizes` splits session
frame counts and bytes by the existing bounded reason labels and the fixture's
exact-message subscription membership (`subscribed` or `roster`). Exact clients
subscribe to the same measured sessions; parent events are roster deliveries.
Per-round `representativeFrames` retains the largest first-client
`sessions.changed` frame per bucket as field names and sizes only. Member sizes
include the JSON key, colon, and value, excluding object braces and separating
commas; nested session fields describe the full row or patch's `set` object.
`initialFullFrame` includes setup/warmup and estimates a numeric field-reference
encoding using matching envelope/full-row fields. This estimate is a diagnostic,
not a measured candidate result. No message content or row values are retained
in these size reports. Wire compression and transport headers are not measured.

Pass the same future `--start-at <epoch-ms>` to both sides of a concurrent pair.
The barrier runs after readiness, warmup, and event drain, and fails if its
deadline has passed. Hold the shared measurement lock around each pair, use
independent identical fixtures and ports, then swap the two CPU halves for the
next pair. Keep fixture generation sequential; `--transcript-mib 1` retains the
5,000-session roster shape without multi-GB transcript writes when measuring
event envelopes. Record the actual fixture database size.

For completed-attempt retention, use `--scenario attempt-retention --clients 1
--runs 10 --rounds 10 --chunks 1 --prompt-kib 128 --heap-snapshot`. Each round
resets the ten child session generations, submits deterministic synthetic prompt
text and a 256×128 synthetic noise PNG, executes three real `read` tools with
16 KiB text results, receives one synthetic output-limit stop,
and completes the resulting transcript continuation. The driver requires one
completed tool batch, output-limit response, and recovered response per child,
and verifies inline images reach all three provider requests. Each provider
response includes a distinct deterministic 16 KiB synthetic reasoning signature;
the driver verifies that tool and recovery continuations replay the exact completed
signature and omit the reasoning-only output-limit signature, as required by the
replay owner. These are
direct child-session `agent` calls, not model-driven `sessions_spawn` calls.
Post-GC Gateway heap samples follow every completed cohort, and the optional
final `settled.heapsnapshot` permits retainer inspection. Session resets exclude
intentionally retained live histories from the trend.

For loaded-session retention after real turns settle, use:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario session-idle-retention \
  --sessions 100 --runs 10 --chunks 1 --chunk-interval-ms 0 --prompt-kib 128 \
  --duration-ms 360000 --memory-interval-ms 30000 --diagnostics --trace-gc
```

This warms the runtime with one parent turn, captures a post-GC baseline, and
touches 100 distinct sessions in cohorts of at most ten concurrent turns. Each
turn includes a synthetic prompt, one real `read` tool, and the reasoning-signature
replay check. The driver keeps one roster-only client and no exact-message
subscriptions. It then idles for `--duration-ms` without model work or polling,
captures post-idle resources, and reopens every measured session once. `--rounds`
is ignored. The final partial cohort has its own barrier size.

The report includes post-GC resources after initial work and after reopening,
periodic natural-GC idle samples, idle GC diagnostics/promotion, and each cohort's
first-turn or reopened-turn latency. Reopened timings include the real agent
turn and tool round trip, so they are end-to-end reload cost rather than a
storage-only timer. After reopening, the pre-idle history digest must match the
retained prefix, with a second exact synthetic answer appended. No history reads
warm the workers between the idle wait and the measured reopen.
Each cohort also reports request-to-provider arrival, time held at the synthetic
provider's cohort barrier, and request-to-first assistant text in the Gateway.
The last timestamp comes from the benchmark-only IPC preload, without a message
subscription or retained message payload. It includes the read-tool round trip
and excludes subsequent client delivery. Missing samples remain visible as a
lower count, rather than being counted as zero latency.
The provider barrier waits for the entire cohort: one slow preparation can delay
all of its full-turn timings. These synthetic SSE results do not measure external
provider latency, WebSocket reconnection, or prompt-cache hits. Add `--prep-trace`
in a separate diagnostic run to capture the existing per-stage preparation logs;
`--diagnostics` also separates hydration and model-context database reservations.

For long-history reopen measurements, first seed the measured sessions offline:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/fresh-team-shape --scenario session-idle-retention \
  --sessions 100 --runs 10 --history-turns 163 --seed-history
```

Run the measurement command above against that fixture with `--history-turns 163`.
Seeding appends 163 user/tool-call/tool-result/answer cycles through SessionManager,
plus a header and two settings entries: 655 entries per session. It runs separately
from measurement, refuses an existing seed, and writes sessions sequentially.
The measurement preserves these histories and paginates the final integrity checks.
Without `--history-turns`, measured sessions start empty; the background roster's
history size does not determine the measured sessions' history depth.

Add `--entry src/entry.ts --session-census` to count live `SessionManager`,
`AgentSession`, and runtime `Agent` instances at the four forced-GC checkpoints
without writing snapshots. The source-only census imports the same constructors
as the Gateway and uses V8's count-only object query; it retains no instance
references. Bundled entries are rejected because their constructor identity
differs. Counts cover the main isolate only, and the queries force additional
collections, so omit the census from latency/GC acceptance runs.
Add `--entry src/entry.ts --fingerprint-retention` to attribute retained prompt-cache
diagnostics after the measured reopen. It waits one more idle interval, collects
garbage, verifies that no session runtime objects remain reachable, then reports heap, external,
and array-buffer deltas after clearing the diagnostic owner. This preserves the
diagnostic baseline throughout the measured reopen and keeps attribution's extra
collections outside latency and GC windows. External memory includes array buffers;
do not add those two deltas together.
Add `--heap-snapshot` in a separate diagnostic pass for `initial.heapsnapshot`,
`post-work.heapsnapshot`, `post-idle.heapsnapshot`, and `post-reopen.heapsnapshot`
to count retained managers, sessions, agents, and their transcript retainers.
Snapshot capture and forced GC can affect eviction timing; use the recorded
timestamps and unprofiled paired runs for acceptance comparisons. Set the idle
duration beyond the lifecycle's eviction window. Fixtures and all output stay
inside the supplied synthetic state directory.

For a steady memory soak with real tool execution and attached viewers, use:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario memory-soak \
  --clients 8 --runs 4 --chunks 100 --chunk-interval-ms 10 \
  --warmup-ms 300000 --duration-ms 3600000 --round-interval-ms 15000 \
  --memory-interval-ms 60000 --retained-profile-ms 600000 \
  --reset-every-rounds 20 --list-interval-ms 2000 --heap-snapshot
```

To retain long active histories during a memory soak, seed with
`--scenario memory-soak --runs 8 --history-turns 512 --history-last-turns 2500
--history-payload-kib 16 --reset-every-rounds 0 --seed-history`, then run with
the same options without `--seed-history`. The last session contains the larger
turn count. Each seeded turn has a separate deterministic synthetic reasoning
signature and tool result of the requested KiB each; the default zero preserves
the smaller reopen fixture. In this mode, `--mixed-rpc` history polls select the
active seeded sessions, including the larger last session. Keep fixture writes sequential and record actual
database bytes before choosing the shape on a shared filesystem.

Add `--worker-memory` in a separate diagnostic pass to record bounded task-kind
memory under `transcript-worker-<thread>.jsonl`. The private preload observes
the real transcript worker's task transport and samples after JSON parses of at
least 1 KiB, capturing the raw-row plus decoded-object high water. It records
task-start/end heap, peak observed heap, parsed bytes, heap limit, and the count
and final old-generation bytes of major collections during each task. Tasks with
no major collection keep that value absent. Periodic samples separately label
the last observed post-GC baseline. It does not force GC, retain payloads,
or change production worker limits. These are sampled lower bounds, not an exact
allocation total; per-parse sampling adds overhead, so compare equally instrumented
pairs and keep uninstrumented RPC acceptance timing separate.

The same observer records constructor-to-first-task startup milliseconds for each
transcript isolate, including host dispatch delay, with the first task kind. Direct
parent-port pools do not emit a separate ready reply. Add `--worker-snapshots` only in a separate diagnostic pass
lasting at least 120 seconds. After 90 seconds it captures one idle isolate per
observed history, context, usage, and other task category, serializing snapshots
across workers. Each `snapshot-<category>.json` records the thread, last task,
before/after memory, and heap-snapshot path. Snapshots force GC and block the
isolate; exclude this pass from latency and GC acceptance. Both sides include
the same TypeScript observer overhead, including its parser source.

For SQLite and model-catalog isolate retention, add `--worker-retained-heap`.
`result.json.workerHeapEvidence` records each warmed worker's post-collection heap,
thread CPU, GC totals and per-kind pause tails/maxima, event-loop tails, and final
post-collection heap. Every tail includes its sample count. Missing, retired, or
late-created target workers make the evidence incomplete. Both worker classes
must be present. Promotion still comes from isolate-matched `--trace-gc` output;
GCProfiler does not expose promoted bytes.

`--worker-heap-snapshot` additionally captures the largest final isolate of each
class, serially, after all measured windows and profiles have ended. Snapshots
therefore do not affect the completed timing window. Keep these artifacts within
the synthetic sandbox and check disk/dirty-memory budgets before capture.
For paired unprofiled memory soaks without mixed RPCs or fingerprint retention, pass fresh, distinct
`--worker-heap-done-file` and `--worker-heap-peer-done-file` paths to each side,
reversing the paths on its peer. Each side publishes completion after its worker
and whole-workload timing windows, then waits for its peer before collecting or
snapshotting. Never reuse marker files from an earlier pair.
For source-runtime comparisons in one checkout, `--worker-baseline-dir` selects
mirrored TypeScript files while retaining their original module URLs; the worker
replies record which replacements were loaded. Pass this flag on both sides with
the same relative-file manifest and each side's source revision, so both register
the same loading hook. Comparing a hooked baseline against an unhooked candidate
confounds source changes with loader behavior. Use `--entry
src/entry.ts`, identical fixtures, fixed `--soak-rounds` and `--duration-ms`, and
the campaign's concurrent swapped CPU pairs and production guard. Source-runtime
results include its loaders and are not packaged-worker absolute heap estimates.

For a focused cold-process bounded-hydration diagnostic on that same fixture:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-hydration-headroom.ts \
  --state-dir /path/to/seeded-fixture --output /path/to/hydration-result \
  --revision <measured-commit-sha> --max-mib 64 --rounds 4
```

This uses the normal hydration owner and actual transcript task worker, checks
that repeated reads return identical results, and leaves a three-second idle
observation after the task burst. It does not establish Gateway throughput.
Use separate matching fixtures, a shared `--start-at`, the measurement lock,
and swapped CPU halves for baseline/candidate pairs. Follow it with the actual
Gateway swarm and history/list latency comparison.

For a comparison in one source checkout, `--baseline-owners` substitutes sibling
`.baseline.ts` copies of `session-transcript.worker`,
`session-accessor.sqlite-history-query`, `session-memory-entry.worker`, and
`session-accessor.sqlite-active-context`, `session-actor-replica`, and
`session-actor-receipt` under `src/config/sessions`. Create those six copies from
the recorded baseline commit before applying the candidate;
they are temporary sandbox artifacts. Both sides otherwise use the same import
graph, dependencies, and driver. Omit `--worker-memory` for the uninstrumented
Gateway latency pairs; the baseline loader still selects the pinned owners.

This runs paced cohorts after five minutes of warmup, with one real `read` tool
and a streamed completion per turn, including the same synthetic reasoning
signature and replay check as `attempt-retention`. Diagnostics and the Prometheus plugin are
enabled. Warmup runs a fixed number of paced cohorts, rounded up from the warmup
duration, so paired runs do equal work. Session generations reset every twenty
cohorts, restarting that cadence at the first measured cohort, to bound intentional
live transcript growth; `--reset-every-rounds 0` keeps history instead. The report
records resets and completed cohorts. It does not exercise
the image/output-limit recovery of `attempt-retention`. `--rounds` is ignored;
an admitted cohort drains before the duration ends, so a slow cohort may overrun.

To replay deep foreground histories throughout the soak and across a restart,
seed the existing offline fixture once, then run with the same `--runs`,
`--history-turns`, `--verify-history-replay`, and `--mock-port`:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario memory-soak \
  --runs 16 --history-turns 500 --verify-history-replay --stress-tools \
  --reset-every-rounds 0 --seed-history \
  --port 45107 --mock-port 45109
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario memory-soak \
  --clients 40 --exact-clients 4 --runs 16 --history-turns 500 --verify-history-replay \
  --chunks 100 --chunk-interval-ms 50 --warmup-ms 0 --duration-ms 1500000 \
  --round-interval-ms 120000 --memory-interval-ms 15000 --retained-profile-ms 0 \
  --reset-every-rounds 0 --stress-tools --stress-subagents --mixed-rpc --dashboard-rpc \
  --list-interval-ms 5000 --poll-seed deep-history --diagnostics --trace-gc \
  --port 45107 --mock-port 45109
```

Repeat the run command, without seeding again, to restart the owned Gateway with
the same foreground history. Deep soaks use a separate `memory-soak-history`
session namespace and marker, so earlier short-session measurements can coexist.
Each seed turn appends user, assistant/tool-call, tool-result, and assistant/answer
messages through `SessionManager`: 500 turns produce 2,003 entries per session,
including its header and settings. Both assistant messages carry distinct
deterministic 4 KiB encrypted reasoning items in valid JSON thinking signatures,
with owner-generated replay metadata bound to the model, mock endpoint, and session.
Every foreground provider request must replay all seeded reasoning items intact,
verified by their deterministic ciphertext hashes rather than optional provider IDs;
each measured cohort reports `historicalReplayRequests`, and the result records
`historyTurns` and `verifyHistoryReplay`. Missing or compacted history fails the run.
This mode rejects `--history-last-turns` and `--history-payload-kib`; those options
remain available for the separate bounded-history stress shape above.

This opt-in shape gives the synthetic model a 2,097,152-token context window and
a 2,000,000-token input budget. The existing model-context reader allows eight
serialized bytes per context token, giving the fixture a 16 MB hydration budget.
This leaves room for continued turns across the two 25-minute commands above;
it does not change production limits or exercise a real provider's context capacity.
Repeated campaigns eventually exhaust this finite budget. Keep the replay assertion
and generate a fresh synthetic fixture when that happens; do not count a failed run
as a completed soak. The previous 8 MB fixture budget was exhausted by accumulated
output during an interrupted campaign and its replacement, despite all seeded rows
remaining in durable storage.
Retained background histories and live response signatures keep their independent
sizes. Its mock request-size limit covers the estimated
seeded history plus 64 MiB for continued turns. Seeding rejects an estimate above
1 GiB and checks the existing Linux dirty-memory budget at least every 50 history
turns (2 MiB estimated writes), using sequential appends. Run with
`--reset-every-rounds 0`; other reset intervals are rejected for deep-history
soaks. Use matching tool options while seeding and running to retain the fixture
worktree as the foreground workspace. The existing idle-retention seed format and
behavior are unchanged.

`memory-samples.jsonl` records Gateway heap, external, ArrayBuffer and RSS memory
after completed cohorts at the requested interval, including exact timestamps.
It also records main-isolate heap spaces and explicitly requests the existing worker
registry's per-thread memory samples, sample ages, and missing workers. Other benchmark
resource reads omit worker data unless they request it; native preload startup does not
load the Gateway worker registry. Worker samples do not force GC.
Periodic samples use natural GC; initial and final settled samples explicitly
collect garbage. Allocation-churn soaks keep the warmed heap at the initial
sample (`initialMemoryCollected: false`) instead of forcing a collection before
measurement. Sampling cadence is bounded by cohort duration. The final
window writes `retained.heapprofile` with both include-collected flags false and
a forced collection before stopping. Its `sampledRetainedBytes` and
`topRetainedSites` describe allocations surviving that window, not allocation
churn or all objects retained since startup. `--retained-profile-ms 0` disables
this capture. Retained and allocation-churn capture cannot run together. The optional
`settled.heapsnapshot` supports retainer inspection. A smoke run can use
`--warmup-ms 0 --duration-ms 30000 --retained-profile-ms 15000`.

For steady-state allocation and promotion attribution, disable the retained
profile and add `--allocations --trace-gc --diagnostics`. For example, the
following workload has twenty concurrent foreground turns and thirty viewers:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario memory-soak \
  --clients 30 --runs 20 --chunks 100 --chunk-interval-ms 10 \
  --warmup-ms 300000 --duration-ms 1200000 --round-interval-ms 15000 \
  --retained-profile-ms 0 --allocations --trace-gc --diagnostics \
  --stress-tools --stress-subagents --mixed-rpc --list-interval-ms 2000 --poll-seed steady \
  --revision <measured-commit-sha> --start-at <shared-future-epoch-ms>
```

`--stress-tools` enables Code Mode in the synthetic configuration. Each outer
`exec` calls the real `read` and shell `exec` tools; the shell runs `pwd` in the
fixture's first registered linked worktree and its exit code and output must
match. The outer call uses `awaitResults: true` so required tool waits stay owned
until completion, including when host load exceeds the inline wait budget.
The provider continuation must contain the fixture text, the successful
code result, and the original reasoning signature. The default remains a direct
`read` call. In memory-soak mode, stress tools also enables one normal isolated
cron agent job every thirty seconds, with delivery disabled. Setup forces and
verifies one run; measured successful run-history entries are reported separately
as `cronRuns`. Cleanup removes the job on success, failure, or interruption; if
removal fails, discard the fixture before reuse as directed by the warning.
These background turns contribute resource cost but are excluded
from the foreground-turn denominator. The twenty foreground child sessions are
direct `agent` calls.

Add `--stress-session-store` to make each Code Mode cell load the preceding
turn's value and commit a new value. The cell fails on a replay mismatch, including
when a value disappears behind the bounded hydration window. Combine this with
seeded long histories and `--reset-every-rounds 0` to measure repeated store
replay on the same sessions. `--transcript-hydration-counts` observes the source
worker reader and writes `HYDRATION_COUNT` records in the Gateway log with the
session, full/bounded mode, decoded bytes/events, and caller stack; it never logs
transcript content. Bounded reads return worker-decoded objects and therefore
report zero main-thread decoded bytes. The observer requires `--entry src/entry.ts`
and fails if the instrumented source shape changes.

For the isolated store owner, alternate source roots with
`node --expose-gc --import ./scripts/tsx.mjs --import ./scripts/perf/transcript-hydration-counts-preload.ts scripts/perf/code-mode-store-measure.ts /path/to/source`.
This seeds a store value before 256 large messages, then binds six fresh runs
with bounded SessionManagers. It verifies the value twice per run and reports
first-load and same-run cached latency plus sampled main-thread allocation
(including collected objects). Keep the first cold sample separate from the five
warm samples, and use at least five alternating invocations per revision.

`--stress-subagents` requires `memory-soak --stress-tools`. Each cohort adds one
dedicated parent that uses Code Mode to call the real `sessions_spawn` tool with
an isolated native child and `completionTarget: "parent"`, then calls the direct
`sessions_yield` tool. The mock holds the child until public `chat.history` shows
a successful persisted yield and all foreground streams have reached their
barrier. The child returns a unique result; the resumed parent must receive it
and persist a unique acknowledgment. Both the child and that parent continuation
must finish successfully through `agent.wait`. Per-cohort evidence is recorded in
`streamStart.subagent`. This additional parent/child work contributes resource
cost but does not change the foreground-turn denominator. The hidden child uses
`cleanup: "delete"`; the dedicated parent resets before each cohort.

`--mixed-rpc` cycles each viewer through `sessions.list`, retained-fixture
`chat.history`, worktree `sessions.diff`, and a newly opened WebSocket `connect`.
It requires at least four viewers and a nonzero polling interval. Every method
must return real nonempty data or a successful handshake in every measured
cohort. Diff polls require a known tracked README edit in the actual worktree;
after capture, a second edit must become visible within twelve seconds, and
cleanup restores the fixture file. Connect latency includes WebSocket opening
and the protocol handshake. The report keeps per-method p50/p95/p99/max and raw
latencies in `rpcLatencyMs`, plus each cohort's foreground end-to-end
`streamStart.turnLatencyMs` from admission through successful `agent.wait`.

Add `--dashboard-rpc` to a memory soak with `--mixed-rpc` to include `board.get`,
`workboard.boards.list`, `workboard.cards.list`, `sessions.github.options`,
`github.preview`, `models.list`, `models.authStatus`, `sessions.describe`, and
`controlUi.sessionPullRequests.subscribe` in the same viewer polling rotation.
Setup enables the bundled GitHub and Workboard plugins, writes one synthetic HTML
board widget, and creates a synthetic workboard with one card per viewer. Reusing
the fixture paginates its cards, removes surplus cards, and creates missing cards
to preserve that count when the viewer count changes. The GitHub preview uses the real plugin with a
benchmark-only in-process HTTP transport serving one synthetic public issue;
other non-loopback fetches fail. By default no GitHub account is connected, so options and
PR subscriptions exercise disconnected-account reads and subscription admission,
not remote PR discovery or credential refresh. The model catalog uses the local
synthetic provider configuration. Board widgets are read through RPC, without a
browser or renderer.
Dashboard widgets reserve Gateway port + 1 for their sandbox listener, so this
mode defaults the synthetic model to Gateway port + 2. An explicit `--mock-port`
must avoid both Gateway listeners.
Dashboard polling and its measurements continue between foreground cohorts until
`--round-interval-ms`, so turn bursts can be paced independently of viewer RPCs.
Memory samples continue during those intervals without forcing collection.

Dashboard mode also creates a dedicated diff session for every additional
registered fixture worktree and rotates `sessions.diff` polls across them and the
existing parent worktree. Setup runs one real synthetic turn per target to capture
its baseline, then appends a known README line; every poll must return that edit
from the expected root. `dashboardRpc.diffWorktrees` maps sessions to fixture
paths, and raw polling requests include `diffSessionKey` for per-checkout latency
attribution in each sample's `rpcRequests`. `coldSetupRpc` retains initial connection,
dashboard preflight, and diff-baseline RPC durations separately under the
`setup/preflight` phase; these precede the main measurement window.
All paths must be linked worktrees inside the fixture. Cleanup restores
every README; the existing final edit-visibility control still uses the first
worktree. Combine this with the fixture's `--worktree-files` and
`--nested-repository` options to compare the large/nested checkout with small ones.

Every method must return a successful validated response in each measured cohort;
boards, cards, models, and the described session must be populated. The existing
`rpcLatencyMs`, RPC response-byte totals, and event frame/byte counters include
these methods and their emitted events. `dashboardRpc.dashboardFixtureRequests`
proves that GitHub preview reached the synthetic transport. With forty viewers,
`--chunks 500 --chunk-interval-ms 10 --list-interval-ms 5000` leaves enough streaming
time for every method's initial staggered poll. Shorter cohorts may require a
shorter polling interval. This option does not add automatic mid-soak restarts;
separate invocations against the same retained fixture start separate Gateways,
and normal setup still resets the foreground sessions.

To measure connected GitHub options, generate the fixture and run the dashboard
soak with `--github-options-connected`. Generation registers the synthetic
`openclaw-fixture/soak` origin before recording each repository fingerprint;
existing disconnected fixtures cannot be reused for this mode. The harness gives
the isolated Gateway a synthetic native GitHub token, serves `/user`, repository
metadata, an empty PR list, and the preview issue entirely in process. Account
verification (`/user`) cycles through deterministic 300, 600, and 900 ms delays;
other routes retain the existing preview fixture's immediate responses. Delaying
every preview request would exceed its shared two-second budget across serial
visibility checks and item reads. No request reaches GitHub.
This measures shared-account verification and discovery, not personal OAuth refresh.
Setup creates session-owned managed worktrees through `sessions.create` and uses
their returned roots for the foreground and diff sessions. This mode requires
fresh foreground sessions (`--history-turns` is unsupported); the fixture's
retained session histories remain part of the dashboard load.

For either account mode, add `--entry src/entry.ts --github-options-observe` to
record handler, admission, shared identity, native token lookup, credential
verification, target discovery, receipt-read, and response-serialization durations in
`dashboardRpc.githubObservation.stages`. A benchmark-only loader wraps the source
owners and refuses missing source shapes; production imports remain unchanged.
The nested `session-preparation` stage covers options admission's session reader,
while `publication-session` records durable session preparation inside the
publication owner. Use these stages to distinguish admission work from repeated
session reads during target qualification. `state-read-source` includes source preparation
and the worker query; its nested `state-read-query` excludes snapshot preparation and
cleanup. Source workers also log `GITHUB_RECEIPT_IMPORT` for fallback-handler imports
taking at least 10 ms, with thread, command, source module, and epoch timing. These
records distinguish cold command loading from database work without logging request
contents. All compared sides must enable the same observer.
Failed observed runs save their collected stages, upstream timings, and options
observations in `github-options-failure.json`; this partial snapshot is diagnostic
evidence, not a completed measurement.
These durations overlap, and stale refresh work may finish after its originating
handler. Use request IDs and timestamps to distinguish the critical path from
background work; never add stage totals together. Gateway diagnostics separately
record response bytes and dispatch work.
For simultaneous comparisons using one checkout, place the baseline receipt
owner beside `src/gateway/github-publication-shared-read.ts` and the baseline
availability owner beside `src/gateway/github-publication-availability.ts`.
Pass `--github-observation-owner <baseline-receipt-file>` and
`--github-availability-owner <baseline-availability-file>` only on A. The result
records their loaded paths and override flags in `githubObservation.owner` and
`githubObservation.availabilityOwner`, and rejects a run unless both owners loaded
and the handler was observed. Both sides must
enable identical observation and use separate fixtures, ports, and CPU sets.
When comparing shared-state command routing, also preserve the baseline
`src/state/openclaw-state-read-handlers.ts` and `src/state/github-publication.read.worker.ts`
beside their owners and pass their paths with `--github-state-handlers` and
`--github-publication-reader` on A. Pair them with the baseline receipt owner so its
original command reaches its original handler; the import records identify the
selected handler module. This keeps both sides on one dependency installation.

Connected options use one additional socket per viewer granted only
`operator.sessions.read`: broad dashboard grants skip repository qualification.
The connected soak authenticates its synthetic operator through loopback
trusted-proxy handshakes so the normal profile owner supplies a verified identity.
An initial concurrent batch is retained in `coldSetupRpc`, before preview preflight;
warm polls rotate over every session in `dashboardRpc.diffWorktrees`. Each polling
record includes `githubOptionsSessionKey`. Every options response must expose the
synthetic shared account without an unsupported-workspace reason.
`dashboardRpc.githubOptionsConnected` records the additional socket count,
every upstream route/sequence/delay/elapsed time/status, totals per route, and
options observations by phase, session, latency, stale flag, and account login.
The synthetic account changes login after sixty seconds from its first `/user`
request; `accountRenameObserved` reports whether normal refresh made that change
visible. Use a long enough soak to observe it; a short smoke is not freshness proof.
The upstream elapsed times include the injected wait and fetch header resolution;
they are not additive handler self-time. Use Gateway diagnostics for handler time
and the existing RPC byte counts for serialization volume.

`--list-profile-reference <reference>` applies the person-reference filter to
concurrent list polling. Use a missing hexadecimal prefix such as `ffffffff` to
exercise resolution across the full visible retained roster; that workload
accepts an empty page and measures reference resolution rather than row rendering.
The ordinary list-polling workload still requires nonempty pages. Add
`--capture-responses` to a memory soak to capture the seeded roster after the
measured window; person-filtered polling also adds four person-reference
requests to that capture.

Each allocation profile includes collected objects and reports decimal
`allocatedMbPerTurn`. Allocation soaks keep one continuous sampling window and
report it as `wholeSoakAllocation` with `allocation-soak.heapprofile`. These long
captures sample every 512 KiB on average to bound native sample records and the
final JSON export; short allocation experiments retain their 32 KiB interval. V8 forces
a major collection when a sampling profile is read or stopped, so the soak
never reads the profile between cohorts and stops it only after recording the
whole-window GC and event-loop metrics. With `--trace-gc` or allocation profiling,
the owned Node process runs `--trace-gc-nvp`. The shared trace reader identifies
the main isolate before Gateway startup and reads promotion between diagnostic
window markers after process exit and log drainage. It supports legacy NVP and
JSON traces. `wholeSoakGc` reports promoted bytes, decimal `promotedMbPerTurn`,
and minor/major GC seconds per minute from the diagnostic observer. Missing
capture markers or malformed promotion traces fail the capture. `wholeSoakGc` and
`wholeSoakDiagnostics` span all measured cohorts **and the idle gaps**, stopping
before final forced collection and the edit control. The latter includes
event-loop p99/max and GC duration by kind. The continuous allocation window
also covers the idle gaps, so both measurements include deferred work. Short
non-soak allocation experiments still stop a profile per cohort; their GC
results do not establish natural steady-state GC behavior. Sampling retains
native sample metadata and adds stack-capture overhead; confirm marginal
GC/latency results with a matching soak without allocation profiling.

For allocation work that executes in a worker, add `--worker-allocations` to
`memory-soak --allocations`. It uses the existing private inspector channel and
the same collected-object sampling interval in every isolate. The
`wholeSoakAllocation.workerManifestPath` artifact lists each worker's native
thread ID, registry script identity, inspector title, acknowledged sampling boundaries, completion/error,
and profile path. Live workers absent from the initialized Gateway registry are
marked separately; Gateway-owned worker pools register synchronously. Join native IDs to the existing memory samples' `workerHeaps`
and `workerMemoryMissing` script identities before attributing bytes to an owner.
Read successful worker profiles with `readGatewayHeapProfile` and report main,
owner-worker, all-worker, and combined bytes per completed foreground turn
separately. During profiling, intentional worker termination first exports its
active profiles, waiting at most five seconds for an unresponsive worker.
Unexpected exits, failed exports, or unidentified workers are missing evidence,
never zero allocation. Worker profiling also samples worker resource usage every 100 ms;
enable it identically on both sides of a comparison.

`--soak-rounds <n>` runs exactly that many measured cohorts instead of admitting
cohorts until the duration deadline. The continuous diagnostics/allocation window
still lasts at least `--duration-ms`, including any final idle gap. Use equal
cohort counts and session-reset counts when comparing promotion and GC, and size
the workload for at least 200 observations per side for p95 (1,000 for p99).

Run at least twenty measured minutes per side and compare at least two concurrent
pairs with swapped CPU halves. Compare B minus A within each pair for allocation,
promotion, minor/major GC, loop p99/max, every RPC tail, and turn latency. A lower
sampled allocation total alone does not justify a change that raises promotion
or GC time. Keep the same profile settings, fixture shape, reset phase, polling
seed, and workload options on both revisions.

Use identical fixtures, driver revisions and options for concurrent A/B pairs,
separate state/ports, the existing `--start-at` barrier after warmup, the shared
measurement lock and swapped sixteen-core halves. Check paired settled-memory
changes alongside raw sample trends; compare the same session-reset phase.
The soak preserves explicitly configured fixture plugin entries; prepare any
synthetic diagnostic listener fixture separately and record its version. It
does not install production-only listeners or copy their operator state.

To start an existing fixture without regenerating it, set `HOME` and
`OPENCLAW_HOME` to `<state-dir>/home`, `OPENCLAW_STATE_DIR` to `<state-dir>`,
`OPENCLAW_CONFIG_PATH` to `<state-dir>/openclaw.json`, and `TMPDIR` to
`<state-dir>/tmp`, then use `pnpm openclaw gateway run --bind loopback --port 40967`
in a credential-free environment. Also set `OPENCLAW_PROFILE=team-shape-40967`
and the native selector: `OPENCLAW_SYSTEMD_UNIT=openclaw-gateway-team-shape-40967`
on Linux, `OPENCLAW_LAUNCHD_LABEL=ai.openclaw.team-shape-40967` on macOS, or
`OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway (team-shape-40967)` on Windows.
Use the corresponding suffix when changing ports. The generated config uses no authentication
and is only suitable for isolated loopback repros.

## Measure the post-restart reconnect burst

Build runtime artifacts on the authorized benchmark host and generate a fresh
offline team-shape fixture for each revision. Then run:

```sh
node --import ./scripts/tsx.mjs scripts/perf/post-restart-burst-measure.ts \
  --state-dir /path/to/team-shape --clients 50 --runs 30 --seconds 300
```

The driver owns a loopback Gateway on port 41058 and a synthetic SSE model on
41059; port collisions fail. It creates 30 shared sessions and starts real
`agent` turns. Every uniquely marked primary model request remains held until
all 30 arrive (a three-minute deadline). A primary response closing before the
crash fails the run, and all 30 must still be actively held immediately before
SIGKILL. The driver kills only its owned Gateway process group, drains all held
response close callbacks, and restarts against the same synthetic state. After
restart, model requests receive immediate short acknowledgements. Unique
recovery arrivals are reported separately: startup may settle interrupted runs
without a model replay. Utility calls never count as primary arrivals.

The Gateway uses a fake fixture token. Clients use a non-ephemeral UI connection
mode and sign the normal Gateway device challenge with generated Ed25519 keys.
All clients pair through the normal loopback/shared-token admission before the
crash in batches of 32, avoiding the per-IP preauth limit during setup. They
reconnect concurrently with the same device keys after restart; admission refusals
and retries remain part of the measurement. Connect verifies
token authentication, retained read/admin scopes, and a durable owner profile through
`users.self`, so `projects.list` exercises the signed-in session/recents phase.
A generated catalog plugin consumes the real Gateway session metadata snapshot
and returns up to 100 synthetic catalog rows; absent/empty catalog results fail.
This measures catalog snapshot preparation, not real provider filesystem scans
or remote discovery latency. All connections share one synthetic owner profile.

As soon as the restarted Gateway becomes ready, 50 clients connect concurrently
and request sidebar `sessions.list` rows (limit 100), `sessions.catalog.list`
(limit 100 for the synthetic local host), and `projects.list` in parallel every five seconds. Each
client waits for its batch before issuing another, bounding outstanding work.
The measurement window starts at restart spawn; requests begun in its first
five minutes are drained even if they finish later. Latency percentiles include
successful replies only; errors, connection retries, and raw timings are retained
so failed requests cannot disappear into the p99. `--seconds 900` extends ELU
observation beyond five minutes without changing the first-five-minute summary.
`--entry`, `--port`, `--mock-port`, and `--poll-ms` adjust execution and load.

Results in `post-restart-burst-*/result.json` include readiness time, per-RPC p99,
private Gateway main-thread ELU/CPU and loop-delay samples every five seconds,
and time to three consecutive ELU samples below 0.8 after reconnect load begins
(null if unobserved). Raw ELU includes startup; no inspector or profiling RPC is
exposed. Unexpected child
exit, incomplete initial arrivals, missing successful endpoint samples, or
missing client/sample coverage fails the run. Owned children and the model
server stop on completion or interruption. Teardown confirms each child has
exited and its managed process group is dead; unresolved cleanup fails and is
reported even when stopping a child throws. The model server always closes.
Synthetic state and logs remain for
inspection. This reproduces recovery and reconnect/list pressure, rather than
production provider latency or arbitrary plugin load. Never point it at live
state, and apply the sandbox rules below to every Team command.

For warm reconnect pressure without agent turns or a Gateway crash, use:

```sh
node --import ./scripts/tsx.mjs scripts/perf/post-restart-burst-measure.ts \
  --state-dir /path/to/team-shape --reconnect-waves --clients 40 --waves 10
```

This mode pairs devices locally, warms all 40 connections with trusted loopback
proxy attribution (`203.0.113.50`, a documentation address), and verifies negotiated
permessage-deflate. Each of ten waves reconnects 30 clients while the remaining
10 issue bounded `sessions.list`, `sessions.catalog.list`, and `projects.list`
batches, producing 300 measured connection attempts. The reconnect selection
rotates by 30 clients each wave so all 40 participate. `--reconnect-count` defaults
to the smaller of 30 or one fewer than `--clients`; it must leave at least one
client polling. Each wave lasts at least `--poll-ms` (default 5,000 ms); a client
waits for its batch before polling again. The default client count is 40 in this
mode and the default wave count is 10. Setup pairs and warms devices in batches
of at most 32. Restart workload flags cannot be combined with this mode.
For simultaneous baseline/candidate measurements, pass the same future Unix
millisecond timestamp as `--start-at`; missing that setup deadline fails the run.
Keep each side's state and ports separate, including during device pairing.

`result.json` retains every measured connection attempt, wall-clock start,
socket-open/challenge timing, connect RPC timing, connection ID, negotiated
extensions, presence row count, errors, list timings, and main-thread samples.
Warm reconnect samples exclude intervals that begin before measurement starts.
Connect RPC latency ends at hello and excludes the subsequent `users.self` read.
Verbose compact Gateway logs in `gateway-reconnect.log` retain existing auth,
device, profile, registration, hello, and send phase timings; correlate them with
each attempt's connection ID. Hello is intentionally uncompressed because it
contains device tokens. This workload measures the connect response and concurrent
list traffic; it does not request the detached Control UI model catalog snapshot.
Use the same fixture seed and shape for both revisions; `--transcript-mib 1` keeps
5,000-session fixtures small when transcript volume is irrelevant to the flow.

Add `--writer-reads --clients 150` to measure read traffic competing with startup
writes. This enables the Prometheus plugin, makes each synthetic catalog request
read its persisted plugin metadata, and adds `sessions.github.options` for an
owned synthetic session plus `agents.list` to each client's polling batch. Agent
listing exercises persisted provenance presentation reads. GitHub accounts remain
disconnected; no external publication occurs. At five minutes from restart spawn
(or the requested shorter duration), the driver saves `writer-metrics.prom` and
includes writer queue wait sums/counts by request class in `result.json`. These
are cumulative exporter observations since its startup, so work before exporter
subscription is not covered. The `execute` class groups multiple unclassified
commands; it does not identify an individual caller. Use the same driver options
and fresh fixtures for both revisions.

Add `--sqlite-queues --clients 50 --seconds 180` to capture every instrumented
worker queue for the full first three minutes from restart spawn. Combine it
with `--writer-reads` or `--cheap-handlers` to include those workloads. A private
preload subscribes to the source diagnostic dispatcher before the built Gateway
entrypoint starts; both use the same process-global dispatcher. It enables
diagnostics before config loading, so capture does not depend on the Prometheus
exporter's later subscription. Only the restarted main isolate is observed.

`sqlite-queues.json` and `result.json.sqliteQueues` contain all worker kinds,
per-kind and per-request-class counts, queue depth peaks, summed queued-time and
service-occupancy integrals, completed service duration, observed queue-wait
sums/maxima, and ten-second bins (at most 180 bins for longer runs). Classes are
ranked by their queued-time contribution. `queueDepth` and `active` in the final
rows count work still pending or running at the cutoff; their elapsed occupancy
is included, even when they finish after the window. Cancellation before start
is counted separately. Aggregates are bounded to 512 kind/class rows and retain
only the first 2,000 metadata-only events as samples. No payloads, paths,
session IDs or request values are retained. The existing native-task counter
still covers only its original first-120-second window.

The totals sum overlapping worker-kind queues, including SQLite reads and
writes; they are **not one FIFO** and nested operations can occupy multiple
kinds at once. A kind may itself combine several workers or database owners.
`sharedSqlite` separately sums the `sqlite_writer`, `sqlite_read`, and `stateRead`
transports named in `sharedSqliteKinds`; other database-using workers remain
visible in the complete per-kind results rather than being guessed into this subset.
Queued time identifies classes suffering waits, not which class blocked them.
Compare service occupancy and request counts when investigating the blocker;
service occupancy also includes transport and scheduling, not just SQLite CPU.
`worktreeCommandDispatchCounts` splits the grouped `worktrees` class by a fixed
allowlist of exact commands. This private probe decodes serialized dispatch
inputs, including nested state-read commands, to count only command names; use
it identically on both revisions.

Events carry wall-clock emission timestamps, while `observedMs` records
monotonic receipt time from restart spawn. Integrals and the cutoff use emission
timestamps at millisecond resolution, avoiding asynchronous diagnostic-delivery
lag; `maxDeliveryDelayMs` and `maxClockSkewMs` expose that limitation. The preload
drains events already queued at the deadline before snapshotting, while excluding
events emitted after it. `captureStartedMs` records the small process/loader gap
before the listener is installed. Diagnostic drops, inconsistent depth accounting,
row overflow, or clock skew of 100 ms or more mark the capture incomplete and
fail the run after preserving its report. There are no request IDs or causal
links, so this cannot prove individual request ordering across worker owners.
Add `--writer-reads --worktree-churn --clients 40 --seconds 180` to compare
worktree traffic after reconnect. The driver saves writer queue count/wait
snapshots at 120 seconds, then creates 12 sessions with real worktrees in a
seeded project concurrently, archives them, and deletes them through the normal
RPCs. After archiving, it waits for the background cleanup receipt (including a
coalesced follow-up pass) before sampling counters and deleting sessions. Each
stage completes before the next and saves another metrics snapshot.
`worktreeChurn` in `result.json` retains the snapshots and elapsed times; subtract
adjacent counts/wait sums for each stage. Reconnect polling continues during the
burst. Worktree creation or preserved cleanup failures reject the run. These
histograms start when the exporter subscribes, so they exclude earlier boot
work and describe all concurrent traffic, not just the 12 operations.

Add `--cheap-handlers --clients 30 --seconds 120` to measure the first two minutes
of reconnect traffic for `push.web.vapidPublicKey`, `push.web.subscribe`,
`workboard.cards.list`, `sessions.github.options`, and `github.preview`, alongside
the existing list requests. This enables the real bundled Workboard and GitHub
plugins. Before the crash it persists the VAPID key, registers one synthetic
subscription per paired device, disables delivery to each subscription, and
creates one Workboard card per client through the real RPCs. Each reconnect sends
`sessions.subscribe` first without awaiting its response, matching
`ui/src/lib/sessions/index.ts` and its subscription owner, then issues the measured
batch on that same socket. This preserves subscription head-of-line waits without
a preceding `users.self` warm read. It is a bounded RPC workload, not a browser
rendering benchmark or an exact replay of every UI scheduler dependency.
`firstTwoMinutes` reports p50/p99 and errors for requests begun
within 120 seconds of restart spawn; slow requests drain after the window.

GitHub uses its real plugin, host authorization, anonymous reader and cache, with
an Undici mock transport serving one fixed synthetic issue. The preload binds
that transport explicitly to GitHub fetches and allows only loopback fetches
outside the fixture. The run requires an observed
post-restart fixture fetch plus the expected preview payload. This excludes
external GitHub latency, managed-account refresh, avatars and pull-request
decoration. `rpcPhaseMetrics` and `writer-metrics.prom` retain the existing
admission, handler, first-response and queue-wait histograms; these are cumulative
since exporter startup and do not cover requests before its subscription. Each
revision needs a fresh fixture and the same driver options.

Add `--transcript-reads --clients 50 --seconds 120` to exercise a cold session
memory index during the reconnect wave. Setup leaves memory search disabled;
immediately before restart the driver enables sessions-only FTS memory with
`provider: "none"`. The first reconnecting client invokes the real `memory_search`
tool once to open its default manager while all clients poll `chat.history` for
the same interrupted session and `workboard.cards.list` for their seeded cards.
No embedding service is used. The history target is a small interrupted turn;
the seeded corpus supplies the large session inventory and transcript volume.
This is a cold-index restart, not a fully indexed steady-state comparison.

The private preload counts main-isolate native task submissions across all
workers, grouped by the bounded input kind and history request kind. It
retains no transcript content, paths, session identifiers, or call stacks. The
first 120-second deadline is checked at submission, so a delayed IPC snapshot
does not count later work. `nativeTaskInputs`, `transcriptQueueMetrics`,
`firstTwoMinutesMainElu`, and per-RPC p95 fields provide the comparison. Native
submission counts include work before the diagnostics exporter starts; queue
metrics do not. Record the kind breakdown and verify memory catch-up actually
ran before attributing an improvement to it. Use a fresh fixture for each revision.

## Checkout diff command fan-out

`checkout-diff-measure.ts` exercises the production Git worker or its read-cache
owner against a small synthetic checkout, without a Gateway or model:

```sh
node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts \
  --state-dir /path/to/new-diff-fixture --seed
node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts \
  --state-dir /path/to/new-diff-fixture --boundary worker --summary --mutate \
  --samples 40 --output /path/to/summary-result.json
```

The seed refuses an existing directory. It creates 100 untracked files,
including binary, large, empty, and symlink cases, three tracked changes, and an
ignored file. `--untracked` adjusts the count. Omit `--summary` to measure full
patches. `--mutate` changes one tracked file before each request; omit it for
unchanged polls. `--boundary read` uses `loadCheckoutDiff`, including revision
validation and caching. Use `--poll-ms 10050` to cross the former summary cache's
ten-second TTL; immediate repeated reads alone cannot demonstrate that change.

Run identical separate fixtures concurrently with `--start-at <epoch-ms>` under
the host's exclusive measurement lock, then swap CPU halves for the next pair.
The report includes per-request latency, actual Git process counts from trace2,
command families, payload size, and a SHA-256 of each response with the fixture's
absolute root removed. Compare matching sample hashes across revisions before
attributing speedups. Setup and worker warmup are separate from measured samples;
trace2's small write overhead is included identically on both sides. These are
Git owner timings, not end-to-end `sessions.diff` RPC or browser latency.

Acceptance for untracked batching is a Git command bound independent of the
untracked-file count, byte-identical returned file statistics and patches, and
paired p50/p99 that improve or remain within noise for a simplification. An
unchanged checkout eligible for revision caching should issue zero Git commands,
including after the prior TTL. Compare B minus A within each concurrent pair;
use at least two pairs with swapped CPU halves and record outside load for context.

### Interactive diff contention

Use the same script's `--boundary rpc` mode to measure real `sessions.diff`
WebSocket requests while full-diff requests, host-budgeted read-only Git work,
and external agent-like Git commands compete. Seed each side separately; the
load checkout contains 16 tracked files with 4,096 changed lines each, written
sequentially. This default exceeds the full-patch size guard, so those requests
exercise diff statistics rather than patch generation. All repository data is
synthetic. The maintenance-shaped load
runs `diff --numstat` through the production child budget; it does not run
maintenance, repack, garbage collection, or change repository configuration.

```sh
node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts \
  --state-dir /path/to/new-rpc-fixture --boundary rpc --seed
node --import ./scripts/tsx.mjs scripts/perf/checkout-diff-measure.ts \
  --state-dir /path/to/new-rpc-fixture --boundary rpc --summary --port 41473 \
  --tabs 3 --background 8 --maintenance 2 --agents 2 --mutate --observe-git-queues --duration-ms 30000 --poll-ms 250 \
  --start-at <epoch-ms> --output /path/to/rpc-result.json
```

RPC mode returns full diffs by default; add `--summary` to exercise summary polls.
Each tab polls the same session, so queued duplicate polls exercise the existing
read owner. `--mutate` writes a tracked file before every polling round; every
response must include the exact current added-line count, which varies by round.
Compare response hashes for matching A/B round numbers. Without mutation, polls exercise unchanged-revision
reuse. Background readers bypass the read cache to represent distinct heavy
read requests. Each external agent iteration executes status, diff statistics,
and the latest commit read; their end-to-end timings are reported separately.
All load loops stay active for the same fixed duration on both revisions;
completed counts and throughput accompany the latency distributions. Work
already admitted at the deadline must settle before the report is written. Use `--heavy-files` and `--heavy-lines` at seed time to
change the load without changing the polling checkout.

The report contains RPC p50/p95/p99, independent round counts and each round’s
maximum tab latency, heavy-reader and agent Git distributions,
response hashes, and the existing `openclaw.git.operation` diagnostics. Queue
fields are included with `--observe-git-queues`, which uses a benchmark-only
loader hook to extend the existing diagnostics publication identically on both
revisions. It changes observation only, and fails if that publication cannot be
identified. Without the flag, absent measurements remain absent. Exclude startup
and warmup. Compare at least two concurrent pairs under the measurement lock,
swapping CPU halves, separate state directories and loopback ports. The
contention acceptance rule is at least a 60% paired RPC p99 reduction with no
agent Git regression. Inspect command counts and queue waits to distinguish
scheduling changes from reduced Git work.

Add `--cold --tabs 40 --poll-ms 5000` to measure reconnect polls against a fresh Gateway process
without warming diff targets or Git workers. Connections are prepared concurrently;
the first 40 diff requests start at `--start-at` alongside the existing load loops.
Use repeated `--poll-state-dir <seeded-fixture>` arguments for distinct checkout
roots; each tab stays on `tab % checkoutCount`, with one outstanding request.
Cold mode requires a positive `--poll-ms` and at least one tab per checkout.
Each client independently retries `computing` after 500 ms and waits `--poll-ms`
after receiving content. Omit `--summary` for full diffs. For large nested fixtures, seed each
with `--boundary rpc --tracked 267000 --untracked 5 --nested-repository` sequentially
under the host's preparation CPU allocation. This measures cold process caches,
not cold disk or the WebSocket handshake.

For the reconnect workload, distribute 40 clients across 14 roots: two large
nested fixtures and twelve small fixtures. A five-second interval approaches
480 full-diff requests per minute, plus temporary computing retries; request
latency lowers the steady rate. The observed production rate of about 500 requests
per minute includes all RPCs, so this is a conservative diff stress workload,
not a replay of the production request mix. The UI's full-diff reader retries
computing results; recurring five-second polling belongs to active-run summaries.
Use the report's actual `rpcPerMinute` and completed counts when comparing sides.

Use `--scope uncommitted` for working-tree-only polls (the default is `all`). Add
`--poll` in cold mode to opt into the nonblocking RPC contract on supporting revisions. When
comparing that contract against an older blocking baseline, pass `--poll` only
to the candidate and record the mode difference alongside the results.

For a cache-owner-only comparison with one source checkout and dependency install,
place the baseline beside `src/infra/git-read-cache.ts` and pass its path through
`--read-cache-owner` on the baseline process only. A benchmark resolver redirects
the production owner's import before Gateway loading; the adjacent location
preserves its relative imports. The report records the override and load count,
and fails if the selected owner was never loaded. Keep state directories and ports
separate even when both processes share source.

Cold mode prohibits `--mutate` and `--missing-cwd`. It verifies fixture contents
and all materialized response hashes after measurement instead of prewarming
them. `firstRequestLatencyMs` includes the initial response for each assigned tab;
`firstContentLatencyMs` also includes polling until any `computing: true` response
becomes materialized. The `phases.cold` and `phases.steady` fields separately report
RPC latency, computing-response counts, and summed `sessions.diff` handler seconds.
Their `refreshLatencyMs` includes all computing retries and actual timer delays from
each refresh's first request to usable content, excluding the recurring poll cadence.
`measurementStartedAtUnixMs`, `contentReadyAtMs`, and each refresh's `startedAtMs`
allow paired runs to use a common steady window: refreshes starting after both sides
received their final initial content, before either nominal deadline. Include the
full completion latency for those refreshes, even when they finish after that window.
Refreshes are tagged by their start phase; individual RPCs are tagged on completion.
Completions are tagged cold until every client has received content and their
diagnostics have drained, then tagged steady. Clients that finish early keep their
own cadence. Cold samples use a per-client `sequence`; `rpcPollSequenceMaxLatencyMs`
groups matching ordinals, not synchronized rounds. Warm mode retains its cross-product
polling and synchronized round metrics. A run fails
if any client never receives content or no steady refresh completes; increase
`--duration-ms` when needed. Compare both first-response and first-content tails,
then the steady distribution, in concurrent pairs with swapped CPU halves.

### Large-worktree revision validation

Seed separate fixtures with `--boundary rpc --tracked 267000 --untracked 4` to
exercise production-sized indexes and directory trees. Nonzero `--tracked`
creates a real linked worktree with that many additional unchanged tracked empty
files, arranged in directories of 1,000. The three changed tracked files and four
untracked edge cases remain. Writes are sequential; on Linux, generation checks
Dirty memory every 1,000 files, pauses at 1 GiB, and stops at 2 GiB. Seed one side
at a time under the host's preparation CPU allocation. This bounds content bytes,
but inode metadata still consumes disk space: record actual fixture size and do
not expand the workload on a production-shared volume without checking capacity.

Measure unchanged summary polls with `--summary --tabs 3 --background 0 --maintenance 0
--agents 0 --poll-ms 250 --duration-ms 30000`. The report separates warmed samples
from startup and records `sessions.diff` and `checkout.diff` phase diagnostics by
cache outcome when those are available. Stage milliseconds are overlapping owner
observations, not additive: cache validation includes its worker queue and Git
work. Compare cache-hit and periodic fallback-cache misses separately. Git
operation counts and queue observations remain available on older revisions.

For a revision-validator change, acceptance is at least a 50% paired cache-hit
p50 reduction, with no material p95/p99 regression. The explicitly requested
histogram may land with neutral timing. Run at least two simultaneous A/B pairs
under the host's exclusive lock, swapping 16-core halves between pairs, separate
fixtures and loopback ports, matching options and start times. Retain per-pair
differences and outside CPU load; do not compare unrelated absolute runs. Two
large synthetic worktrees model file/index size and concurrent polling, not the
production fleet's full filesystem working set or cold disk behavior.

Add `--churn-ms 1000` to simulate an agent saving identical tracked `unchanged.txt`
content and running `git status` on the polled checkout, while build output is
created and removed below the ignored directory. This refreshes index stat data
without changing the visible diff. Every unchanged RPC response must match its
warmup hash. After measurement, the script makes a real tracked edit and checks
that every tab receives the new line count, then restores that file. Summary
fallbacks may intentionally retain a result for 10 seconds when no revision is
available. The report separates first-poll visibility (`editFirstPollVisible`)
from eventual visibility (`editVisibilityMs`), polling for up to 12 seconds.
It saves the report before asserting eventual visibility. The report
includes churn counts/timings, cache outcomes, and `editControlVerified`; phase
samples retain diagnostic miss reasons when the revision supports them.

For cache-reuse changes, compare both the 267,000-file fixture and a small
fixture with `--summary --tabs 3 --background 0 --maintenance 0 --agents 0 --poll-ms 250
--churn-ms 1000 --duration-ms 30000`. Run full-diff comparisons separately by
omitting `--summary`: oversized summaries retain their existing 10-second
fallback, while full diffs require fresh validation. Require unchanged response
hashes, a passing edit control, and fewer diff collections with a higher cache
hit rate on the repaired path, without a material paired latency regression.
Native Git status used to validate a revision still counts as Git work; cache
hits do not imply zero subprocesses.

Use `--missing-cwd` with RPC mode and a small fixture to measure a disappeared
session directory. The driver renames the synthetic `new/` directory after
session creation, requires `not_git` on every measured response, restores the
directory, and requires recovery within two seconds. Do not combine it with
mutation, churn, or extra polling fixtures. The report includes
`missingRecoveryMs`; both revisions must return identical absent-checkout
responses. Compare at least two simultaneous pairs with swapped CPU halves.
RPC reports also include `processCpuMsPerRpc`, the Gateway process's CPU during
the measured window divided by completed requests. This includes its worker
threads but excludes child Git processes; compare it with command counts and
latency, not as total system CPU.

Add `--nested-cwd` to launch each session from the fixture's `new/` subdirectory.
This exercises checkout discovery through a session's working directory instead
of supplying the repository root. Compare full diffs under `--churn-ms 1000`
with and without this option; require identical response hashes, immediate edit
visibility, and the same cache eligibility as the root-directory case. The
267,000-file fixture remains a detached linked worktree with a separate Git dir.

At seed time, add `--nested-repository` to replace one untracked text file with a
small committed `agent-clone/` checkout (`--untracked` must be at least five).
RPC warmup requires that checkout to remain one opaque untracked entry, with no
nested file contents. Add `--excludes-file` to configure `core.excludesFile`
pointing outside the checkout and ignore a synthetic file through it. The
config contains 1,000 synthetic branch sections (more than 64 KiB),
matching a repository shared by many agent worktrees. After the
measured RPC window, the driver clears that ignore file, verifies the newly
visible file reaches every tab immediately, and restores the ignore rule.
Measure these scenarios separately with full diffs, for example `--tracked 5000
--untracked 10` at seed time and `--tabs 3 --background 0 --maintenance 0 --agents 0
--poll-ms 250 --duration-ms 30000` at run time. All unchanged RPC responses must
match warmup; compare their hashes between revisions, require the external-ignore
control to pass, and compare cache hit rate plus paired p50/p99. Use at least two
concurrent pairs per scenario with swapped CPU halves. These small fixtures
reproduce cache eligibility rather than the full fleet's filesystem working set.

For a second scenario with independent revision checks, add
`--poll-state-dir <other seeded fixture>` on each side. Both isolated Gateways
then poll both existing synthetic worktrees concurrently, using a separate
session per checkout and `--tabs` peers per session. This option is repeatable,
requires RPC mode, and rejects `--mutate`: shared checkout contents stay read-only
with optional Git index refresh disabled through `GIT_OPTIONAL_LOCKS=0`,
while Gateway state and temporary diff indexes remain owned by each side's
`--state-dir`. The report includes the extra fixture inventories, checkout count,
and each sample's checkout index. This adds multiple-root contention without
generating another large filesystem tree; it still does not model a whole fleet.

## Worker module graphs and retained admission facts

`worker-module-graphs-measure.mjs` exercises the Git, plugin-preparation,
Code Mode, and skill-discovery worker entrypoints through their task protocol.
It records cold and warm script inventories, retained heap after collection,
request latency, worker GC, and worker event-loop delay with sample counts.
Each run owns one isolate. The synthetic fixture has four workspaces with eight
skills each and plugin admission facts for 100 roots and 5,000 files.

```sh
node --import ./scripts/tsx.mjs scripts/perf/worker-module-graphs-measure.mjs \
  --state-dir /path/to/owned-fixture --output /path/to/result.json \
  --worker git-operation --samples 1200 --start-at <epoch-ms> --trace-gc
```

Other worker names are `plugin-generation-preparation`, `code-mode-node`, and
`discovery`. Use one worker per concurrent baseline/candidate pair so `--start-at`
synchronizes the measured windows after warmup and diagnostic collection. Missed
start deadlines fail the run; `startedAt` records the actual request-window start.
Allow enough preparation time for snapshots. Swap CPU placement in the second pair. `--baseline-dir` loads the original versions of the five import/admission
owners listed in the worker helper, retaining candidate URLs for dependency
resolution. Store those files at their repository-relative paths beneath that
directory. `--snapshots` writes warm heap snapshots outside the timed window.

Git replies come from real host-side Git commands, and a newly created branch must
appear in the worker's inventory. Plugin resolve calls must return the captured
source bytes, and close must release the artifact. Discovery verifies every
skill; Code Mode checks the computed result across fresh completed contexts.
This is a worker-boundary workload, not a full Gateway benchmark. Main-isolate
heap and total allocated bytes are not measured. GC trace markers delimit each
workload; identify the worker isolate from the forced collection between the
identification markers. Report worker and whole-process GC time and promoted
bytes separately so deferred host work remains visible.

## Sandbox measurements

Follow the current host policy. On Team, use only a task-owned
`/srv/perf-sandbox/<lane>/` checkout and fixture, with HOME, OPENCLAW_HOME and TMPDIR
inside that directory. Wrap every remote command with:

```sh
systemd-run --scope --quiet -p AllowedCPUs=64-127 -p MemoryMax=64G \
  nice -n 10 ionice -c3 <command>
```

Use loopback ports at least 40000. Never read/copy production databases or touch
production services. Stop your own Gateway, then remove your sandbox after
recording results. Local validation is limited to changed-file format/lint and
focused tests; PR CI owns broad gates.

## Operator authority allocations

`operator-authority-measure.ts` isolates six real synchronous authority owners:
`auth-policy`, `retained-grant`, `recovery-source`, `model-execution`,
`admitted-run`, and `transcript-guard`. Its synthetic non-owner operator has an explicitly required
access-policy plugin, registered
through `createApi(...).registerGatewayAccessPolicy(...)` with the normal plugin
instance invocation wrappers. Setup authorizes and resumes the grant once;
rechecks use the retained authority, as the recovery owner does. The fixture
exposes no other plugin runtime capabilities and starts no Gateway or services.
`recovery-source` creates one synthetic profile in a private temporary SQLite
store, decodes the persisted source shape, and calls `restoreGatewayOperatorSource`.
Its measured check is the restored authority's `assertCurrent`, including the real
profile, source-auth policy, and retained plugin-grant owners. Setup creates and
warms the profile; teardown releases it and removes only the generated state directory.
Set `TMPDIR` to the approved sandbox before running this scenario or `all`.

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/operator-authority-measure.ts \
  --scenario model-execution --iterations 20000 --warmup 5000 \
  --revision <commit-sha> --output /path/to/authority.json
```

The JSON records estimated allocated bytes per check, elapsed and main-thread CPU
nanoseconds per check, and auth-policy, resume-owner, plugin-authorize,
plugin-resume, and plugin-assert counts. Setup and warmup are excluded. Allocation
uses V8 sampling at 32 KiB with both collected-object flags enabled; the report
is allocation churn, not retained-heap delta. Raw profiles accompany `--output`,
and the report includes the fifteen largest allocation sites with eight-frame
stacks. `estimatedAuthPolicyStringifyBytesPerCheck` separately totals sampled
allocations beneath `captureGatewayAuthPolicy` → the stable-stringify serializer,
including recursive serializer frames when V8 inlines the public wrapper and
collected objects; zero samples are an estimate, not an exact invocation count. A post-capture positive control requires grant revocation to fail the
very next retained-authority check. The recovery scenario also removes its
allowed browser origin on a fresh config and requires the next source check to
reject, outside the measured window.

Use at least five simultaneous baseline/candidate pairs on the approved
benchmark host, with one `--scenario` and the same future `--start-at <epoch-ms>`
per pair. Alternate the assigned interleaved even/odd CPU sets under the exclusive
measurement lock. Compare the mean paired differences with spread; warm both sides identically.
Builds belong outside the measurement window. The source can also be bundled
with esbuild for the host, preserving Node built-ins and installed dependencies;
use the same bundler options and dependency tree for both revisions.

These are owner-check denominators. `model-execution` calls the real bound model
assertion; `admitted-run` uses `prepareSystemAgentRunAdmission`, admission, and the
real admitted-run active assertion. `transcript-guard` captures the real owned
transcript assertion with that admitted run as its commit guard, without writing
storage. None is a model turn, tool step, transcript append, or measured production
frequency. Derive those counts from an instrumented
Gateway turn separately. The recovery scenario prepares profile-database access
outside capture and measures only the warm resident owner. This probe does not
include other access policies, contextual-ingress callbacks, or transport allocation.

For real turn counts, add `--operator-access-policy` to the existing streaming
driver's `chat.send --stress-tools` scenario. A small isolated fixture is enough
to exercise this path before the larger deployment-shaped comparison:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-authority-state --sessions 1 --runs 0 --approvals 0 \
  --cron 0 --projects 1 --transcript-mib 1 --port 41481
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/new-authority-state --entry src/entry.ts \
  --port 41481 --mock-port 41482 --scenario chat.send --stress-tools \
  --operator-access-policy --rounds 1 --chunks 10 --chunk-interval-ms 1
```

This option enables a synthetic required access-policy plugin and authenticates
a non-owner operator through a loopback trusted proxy. The plugin rejects owner
identity, checks the synthetic email, and records live authorize, resume, and
assert callbacks. The normal code-mode tool runs `read` and `exec` against the
fixture. Each measured round reports plugin assertions per completed turn, per
`after_tool_call` completion, and per unique committed message sequence observed
through `onSessionTranscriptUpdate`. Raw transcript-update counts are separate:
they are not all transcript writes or synchronous precommit checks. These ratios
normalize the full turn window; they do not attribute each check to one tool or
append. Standalone host auth-policy invocations are not counted by the plugin.

The mode permits only `chat.send --stress-tools`, with its one client and one
active turn, and rejects background RPC polling. Counter start/stop uses private
child IPC outside allocation capture. Add `--allocations` for whole-workload
sampled bytes divided by policy assertions; this includes normal turn work and
counter hooks, and is not isolated bytes allocated by one assertion. Use matched
instrumentation and the same paired host procedure for comparisons. The tiny
fixture proves the path, not deployment capacity or production recheck rates.

Add `--session-event-wake` to route the same synthetic tool turn through the
public `system-event` RPC with `wake: true`. The driver waits for the subscribed
session's lifecycle start and passes its actual run ID to `agent.wait`. This
exercises the session-event handoff and delivery-generation owners; ordinary
`chat.send` does not. Report these workloads separately: the internal event uses
session authority while ordinary chat carries the operator run authority.

Add `--authority-counts --entry src/entry.ts` in a separate count pass to observe
main-isolate named authority assertion closures, source-composition guards,
identity-owner `statSync` and `realpathSync.native` calls, all main-isolate `statSync` calls, tool-override
intersections, and stable-stringify call sites in the auth-policy and tool-override
owners. A generated benchmark-only source loader inserts counters; it does not
alter the checkout or add production hooks. Each round records `host.counts` and
`host.installed` under `operatorAccessPolicy`: the latter names every instrumented
site, including zero-call sites. Divide counts by the completed turn count. These
are nested invocations, not distinct permission decisions, and the named closures
do not include every anonymous callback. The mode rejects allocation, CPU, GC,
and diagnostics profiling; its timing is not acceptance evidence.

The same pass counts profile-owner `assertSettled` checks and transferable
`readProfileAuthority` reads, with their three-frame caller stacks in `host.callers`.
Report both: a local settlement check can read the owner's cells directly without
constructing a cross-thread descriptor, so fewer descriptor reads do not imply
fewer live checks. Caller-stack collection belongs only to this count pass.

Matched `--allocations` runs without `--authority-counts` additionally report
`allocation.authority`: sampled bytes and sample records attributed to the
outermost authority owner in each eight-frame allocation stack, matching the
production profile attribution. The four disjoint families are
`session-source-authority`, `admitted-run-context`, `operator-run-authority`, and
`session-event-handoff`. `estimatedBytesPerTurn` is authority-family allocation;
`estimatedAllocatedBytesPerOperation` remains the whole-turn denominator. Both
include objects collected by major and minor GC. Use at least five interleaved
baseline/candidate runs, identical fixtures and reset boundaries, and report
promotion separately. Sampling records are not invocation counts.

For matched source snapshots without a second checkout, `--authority-source-preload
/path/to/overlay.mjs` imports a benchmark-owned loader in the Gateway child before
the count and profiler loaders. Use the same module list and loader on both sides,
changing only the snapshot contents. The loader can publish its revision, Gateway
PID, file hashes, and applied module counts at
`globalThis[Symbol.for("openclaw.benchmark.sourceOverlay")]`; the policy IPC report
preserves that attestation per round, and the final report hashes the preload.
Verify every expected module was applied in the reported Gateway PID. Overlays
return `module-typescript` with a string or byte source; counts use those exact
TypeScript contents. A controller-only preload is insufficient: the
isolated Gateway environment deliberately excludes inherited `NODE_OPTIONS`.

## State and agent database path resolution

Measure the real path owners without opening a database:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-path-resolution-measure.ts \
  --iterations 100000 --rounds 5
```

The JSON-lines output separates warm roots, alternating roots, explicit agent
paths, and cold unique roots. Timing and allocation are separate passes; V8
sampling includes objects collected by major and minor GC. A third, untimed pass
counts exported `path.resolve` and `path.join` calls. These are owner-level
operation counts, not Gateway calls per turn. Run both revisions with identical
arguments, interleave samples, and compare with the `chat.send` allocation
workload below before drawing an end-to-end conclusion.

## Tool schema preparation

`tool-schema-preparation-measure.ts` measures the source owners used by provider
requests and generic schema validation. The default fixture has 100 nested tools.
It covers SDK OpenAI compatibility normalization, Responses, completions, the
Moonshot typed-union dialect, Anthropic, Google, and the actual Mistral SDK with an
in-process synthetic fetch. It makes no network requests.

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-schema-preparation-measure.ts \
  --tools 100 --iterations 20 --samples 5 \
  --output /path/to/report.json --golden-output /path/to/provider-json.json
```

Reports include sampled allocated bytes per catalog, named schema-function self
and inclusive allocations, elapsed time, and median/p95/min/max. Sampling includes
objects collected by minor and major GC. Warm published schemas, fresh mutable
schemas, and cold publication are separate modes. Fresh fixture construction is
outside sampling; cold publication includes publication and the first preparation
of each new identity, but does not reset process-wide content caches. Separate
work counts observe enumeration, serialization, and cloning of source schema
objects after warmup, outside allocation measurement.

For synchronized A/B pairs, select the same `--workload` and `--mode`, use
`--samples 1`, and pass a shared future epoch millisecond `--start-at`. For example,
`--workload sdk-responses-loose --mode warm-published`. Start both processes under
the host's exclusive measurement lock on separate CPU halves, swap halves for
the next pair, and compare at least five paired differences. A missed start fails
the run. Use `--golden-only` for a setup check without allocation sampling.

`--schemas /path/to/catalog.json` accepts an array of `{name, description,
parameters, value?}` or OpenAI function descriptors. `value` supplies validation
input and otherwise defaults to `{}`. Only use synthetic or approved catalogs.
The report records the input hash and each provider's exact serialized byte count
and hash; compare the two `--golden-output` files byte for byte across revisions.
A catalog captured from an outgoing request already contains that provider's
projection, so label that evidence separately from raw tool definitions.

This probe measures preparation and validation, including Mistral serialization;
it does not measure a whole chat turn. Pair it with
`transcript-broadcast-measure.ts --scenario chat.send --allocations` when assessing
the effect on Gateway turn allocations.

## Allocated bytes per RPC or turn

For a bounded chat-owner replay, run:

```sh
node --import ./scripts/tsx.mjs scripts/perf/gateway-agent-event-measure.ts \
  --output /path/to/owned-benchmark/replay.json --samples 5 --turns 1000
```

This replays a lifecycle, read tool, 100 assistant deltas, and completion through
the real chat handler with a deterministic clock. It records serialized frames,
lifecycle-generation lookup demand, elapsed time, and sampled allocated bytes
including collected objects after 100 warmup turns. Compare the frame artifacts
byte-for-byte across revisions. Persistence and network delivery are disabled;
the lookup callback only counts demand, so registry allocation and whole-Gateway
cost still require the workload below. Run baseline/candidate pairs under the
benchmark host's measurement policy; keep import/startup outside these samples.

For provider request preparation alone, run the source owner directly:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-request-prepare-measure.ts \
  --messages 500 --iterations 300 --mode prepare --output /path/to/result
```

Use `--mode transport` to isolate standalone request-body serialization. The
driver compares wire bytes with native JSON, including a custom `toJSON` and
ordered getters, then counts JSON serialization/parsing, UTF-8 encoding, and
hash calls and bytes for one request. `wholeRequestCalls` counts operations
whose byte size equals the full request; field and prefix hashes remain in the
totals. Counting runs separately from allocation/timing capture. The profile
includes objects collected by both minor and major GC. These measurements cover
the owner in the driver's isolate, excluding worker transport and the Gateway;
use the Gateway `chat.send --allocations` workload for main-isolate turn cost.
Compare baseline and candidate serially in interleaved ABAB order, with at least
five samples per revision.

Use the same owned Gateway driver with `--allocations` and a named `--scenario`:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --allocations --scenario sessions.list \
  --clients 1 --runs 1 --operations 100 --limit 100 --rounds 5 \
  --revision <measured-commit-sha>
```

Use `--row-mode sidebar --limit 200` for the sidebar's fact-packed wire response,
or `--row-mode dashboard` for gallery rows. The default `compact` shape does not
exercise sidebar fact packing; compare matching shapes when attributing allocation.
The report records `rowMode` alongside the page limit.

Supported scenarios:

| Scenario               | One measured operation                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sessions.list`        | One compact sidebar page RPC, `archived=all`, `--limit` rows                                                                   |
| `sessions.describe`    | One detailed parent-row RPC, including the harness's synthetic children                                                        |
| `sessions.patch`       | One title, expiring status-note, or model-selection mutation on a retained fixture session                                     |
| `sessions.cleanup`     | One cleanup RPC in warning mode, including current subagent preservation and commit compatibility checks                       |
| `connect`              | One owned socket replacement and validated hello handshake; no sidebar restoration                                             |
| `reconnect`            | One owned socket replacement, subscriptions, and verified current sidebar                                                      |
| `subscribe`            | One `sessions.subscribe` snapshot registration/refresh RPC on the sender, with the same page shape as list                     |
| `chat.send`            | One completed turn: synthetic read-tool call, then paced streaming answer; one client, `--runs` concurrent turns (default one) |
| `transcript-broadcast` | One completed `agent` turn, streamed to `--clients` subscribers; `--runs` concurrent turns per round                           |
| `plugins.reload`       | One live reload of a synthetic no-op plugin through the lifecycle RPC                                                          |
| `plugin.scope`         | One synthetic plugin RPC checking invocation scope before and after an asynchronous suspension                                 |

RPC scenarios use `--operations` per round. `--rpc-concurrency` defaults to one
and bounds concurrent requests across the connected sockets. For a reconnect
storm, use `--clients 40 --operations 40 --rpc-concurrency 40
--reconnect-stagger-ms 125`; starts must fit within five seconds. Reconnects
restore session/message subscriptions and compare the ordered sidebar identities
and update timestamps with the pre-storm page. The report separates handshake
latency from time until all sidebars are current. Intentional disconnection does
not imply event replay. These scenarios isolate RPC costs; they do not generate
background session activity at production rates.

For acknowledgement latency, `chat.send` also accepts `--diagnostics` without
allocation or CPU profiling. `--runs 8 --rounds 125` records 1,000 measured ACKs
after one unmeasured warmup cohort:

Generate these fixtures with `--settled-runs` to retain the requested run inventory
without replaying synthetic interrupted runs or pending deliveries at startup.
The default recovery workload can exhaust worker capacity before the Gateway is
ready; that is a failed setup, not an attachment-latency sample.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --entry src/entry.ts --scenario chat.send \
  --port 41617 --mock-port 41618 --runs 8 --rounds 125 \
  --chunks 10 --chunk-interval-ms 10 --diagnostics --trace-gc \
  --start-at <shared-future-epoch-ms> --revision <measured-commit-sha>
```

For workspace/sandbox setup attribution, add `--attempt-setup-image <local-image-id>`
and generate the fixture with at least one project, `--worktree-files 5000 --worktree-file-bytes 4096`, and
`--worktree-install-failure --worktree-cold-commits 32`. The install-failure option commits a minimal pnpm package with a
failing preinstall script, exercising source-only template recovery after an
installer failure (the Python probe image fails earlier because pnpm is absent).
The 5,000 distinct deterministic 4 KiB files add about 20 MiB of tracked source
content; this exercises object copying beyond an empty-file index inventory.
This uses the real Podman backend with a network-disabled session container,
creates managed session worktrees, and prepares one synthetic plugin tool plus
a synthetic Streamable HTTP MCP server on the loopback model-fixture listener. Every first provider request must contain
both tool definitions; the completed turn must read the committed project README
through the sandbox. The image must already be available in an isolated Podman
store selected by `CONTAINERS_STORAGE_CONF`; prepare it outside measurement.
The image needs the normal sandbox shell, core utilities, and Python filesystem
bridge dependencies. Keep the store, HOME, temporary files, and fixture under the
approved sandbox directory. For a task-owned Podman wrapper that supplies the
side scope as `--cgroup-parent`, set `OPENCLAW_PATH_BOOTSTRAPPED=1` with a curated
PATH; this fixture forwards it so CLI path bootstrapping does not select the
system Podman ahead of the wrapper. Verify the real container and Gateway
cgroup effective CPUs before accepting a pair.

`--cold-session-rounds 8 --rounds 58 --runs 4` measures 32 new sessions,
worktrees, and containers, followed by 200 turns on the final four sessions.
Both sides use cohorts of four concurrent turns; cold cohorts contend for the
same dependency-template owner with four distinct content revisions. Each cold
session selects a distinct pre-generated commit with identical tree contents;
this invalidates the dependency template even after Gateway warmup. Confirm the
managed-worktree log reports cold fallback for these turns before claiming a
cold-template comparison. These are
**cold templates/sessions in a resident Gateway**, not cold process starts: Gateway and
plugin/MCP startup are warmed before measurement. Session/worktree creation RPCs
finish before each measured send. `firstModelRequest` pools the actual wire-send
to first model HTTP request samples by `cold-session` and `warm-session`, including
counts, raw samples, p50/p95/p99, and max; no provider response delay is included.
Per-round `streamStart.providerRequestMs` retains the same underlying samples.
`wholeAttemptSetupDiagnostics` retains one continuous main-isolate GC and event-loop
histogram across the measured workload, including cold session creation between
send cohorts. Use its actual event-loop p99 and sample count; do not average the
per-round p99 values into a purported pooled percentile.
Use separate matching fixtures, concurrent guarded pairs, and swapped interleaved
CPU sets. p99 with 32 or 200 observations is context under the campaign's
1,000-sample rule; it cannot gate. Remove only the task-owned containers and store
after inspecting the results. This workload raises the provider-arrival deadline
to 170 seconds so a slow setup is measured rather than rejected at 45 seconds.

Each fresh send must return `started` with its requested run ID, then complete
successfully through `agent.wait`. The existing model-arrival barrier verifies
eight overlapping turns, and tool-completion and subscriber checks remain active.
`samples[].rpc["chat.send"]` records ACK count, p50/p95/p99/max and individual
latencies in milliseconds. `chatSendAck` pools those observations across measured
rounds; it measures the first wire response, separately from turn completion and
post-ACK startup diagnostics. Per-round tails with eight samples are context only;
use the pooled observations for p99. Run separate matching fixtures concurrently
under the shared guard and one quiet-slot lock, then swap interleaved CPU sets.
Apply the campaign's sample-count and paired absolute/relative-delta rules.
For `--diagnostics` passes without heap or CPU profiling, `wholeChatDiagnostics`
records one event-loop histogram across the measured cohorts; use its count and
p99 rather than averaging per-cohort percentiles. Its `gc` field records pause
durations. With `--trace-gc`, `wholeChatGc` also records the whole measured window's
collection counts and promotion, including the intervals between cohorts.
Profiled passes omit these acceptance metrics because stopping heap sampling
forces GC and profile serialization adds main-thread stalls.
Add `--chat-attachment-kib 4` or `--chat-attachment-kib 256` for separate small
and larger text-attachment runs. Each turn sends a deterministic
`synthetic-attachment.txt` with MIME type `text/plain` and origin `paste` through
the real attachment path. The report records `chatAttachmentBytes`; zero means
no attachment. Keep the attachment size identical within each comparison pair.

Add `--chat-active-hold-ms 1500 --runs 8 --rounds 63` to measure 1,008 ACKs for
input arriving during active turns. At the model-arrival barrier, each session
receives an explicit `/followup` input. After its queued notice arrives, the
driver sends two steering inputs on the same session and WebSocket connection.
The provider releases its held responses after the configured interval,
independently of ACK arrival, so a blocked baseline records the delay.
`activeChatSendAck` pools only the two steering ACKs per session and reports
count, p50/p95/p99/max, individual latencies, and `acknowledgedBeforeRelease`.
The existing `chatSendAck` includes initial, predecessor, and steering sends.
All extra inputs must settle successfully, leave pending custody, and appear
exactly once in user history with the matching input identity and text;
`consumedExactlyOnce` counts those three inputs per session. Keep the hold
interval identical across paired runs.

For entry-patch transfer measurements, prepare separate matching small fixtures
sequentially, then run the existing driver against the source Gateway:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-fixture --sessions 5000 --runs 6000 \
  --approvals 0 --cron 0 --projects 0 --transcript-mib 16 --port 41580
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/new-fixture --entry src/entry.ts --scenario sessions.patch \
  --port 41580 --mock-port 41581 --clients 8 --runs 1 --rpc-concurrency 4 \
  --warmup-operations 240 --operations 2400 --rounds 1 \
  --allocations --diagnostics --trace-gc --capture-responses \
  --start-at <shared-future-epoch-ms> --revision <measured-commit-sha>
```

No Gateway bundle is required for this source entry. The fixture retains 5,000
session entries and 6,000 run records with only 16 MiB of synthetic transcript
content; inspect the generated database sizes before choosing larger fixtures.
Each connected client has a distinct unarchived fixture target. Successive
mutations set a unique user title (`label`), set an expiring status note, select
a second configured synthetic model, then clear each of those fields. Every
response verifies the changed value. Warmup and measured operations continue
the same mutation sequence, avoiding repeated no-op writes. Connected clients
subscribe to session rows, so row publication is included. This scenario does
not drive viewer-declaration churn or real running/settled agent lifecycles;
use the separate `transcript-broadcast` or `memory-soak` turn scenario for that
additional coverage.

For subagent maintenance capture, use `--scenario sessions.cleanup --clients 1
--runs 1 --operations 1000 --warmup-operations 2 --rounds 1 --allocations
--trace-gc --capture-responses --entry src/entry.ts` with a separate 5,000-session,
6,000-run fixture on each side. `--transcript-mib 0 --approvals 0 --cron 0
--projects 0` keeps fixture writes small. The scenario sets and records
`session.maintenance.mode=warn`: real cleanup admission and preservation checks
run, while every response must report an unchanged nonempty session inventory.
This is a maintenance RPC workload, not the production frequency of cleanup or
session-list traffic. `sessions.patch` skips maintenance and cannot reproduce
this allocation owner. First inspect a short baseline allocation profile for
the subagent maintenance capture stack; do not use unrelated RPC allocation as
proof. Run concurrent, swapped-core pairs with the campaign guard and shared
`--start-at`, then apply its sample-count, GC-pause, and paired-baseline rules.

For this maintenance workload, generate each fixture with the same recent fixed
`--now` value. Before starting its Gateway, normalize the synthetic retained runs
with the following owner-API transform (`FIXTURE` is that new fixture directory).
It retains 6,000 terminal runs: 60 pending deliveries scheduled one day after the
fixture timestamp, and 5,940 delivered runs. This avoids measuring startup
recovery of the generator's interrupted runs or a due-delivery backlog. The
transform asserts the persisted counts and records them in the fixture summary.
Do not use it against live state.

```sh
node --import ./scripts/tsx.mjs --input-type=module - "$FIXTURE" <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const summaryPath = path.join(root, "team-shape-summary.json");
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
assert.equal(summary.retainedRuns, 6000);
const { createGatewayBenchEnv } = await import("./scripts/lib/gateway-bench-runtime.ts");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {}),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const state = await import("./src/state/openclaw-state-db.ts");
const { loadSubagentRunsByIdsInDatabase } = await import("./src/agents/subagents/registry/subagent-registry.store.sqlite.ts");
const { bindSubagentRunRecord } = await import("./src/agents/subagents/registry/subagent-registry.store.codec.ts");
const { writeSubagentRunValuesInDatabase } = await import("./src/agents/subagents/registry/subagent-registry.store.kernel.ts");
try {
  const database = state.openOpenClawStateDatabase();
  const ids = Array.from({ length: 6000 }, (_, index) => `team-shape-run-${index}`);
  const runs = [...loadSubagentRunsByIdsInDatabase(database, ids).values()];
  assert.equal(runs.length, 6000);
  const pendingIds = new Set(runs.filter((run) => run.delivery.status === "pending").slice(0, 60).map((run) => run.runId));
  assert.equal(pendingIds.size, 60);
  const nextAttemptAt = summary.now + 86_400_000;
  assert.ok(nextAttemptAt > Date.now(), "Generate the fixture with a current fixed --now");
  for (const run of runs) {
    const { startedAt, endedAt } = run.execution;
    assert.equal(typeof endedAt, "number");
    run.execution = { status: "terminal", startedAt, endedAt, outcome: run.execution.outcome ?? { status: "error", error: "Synthetic interruption retained" } };
    run.expectsCompletionMessage = true;
    run.completion = { ...run.completion, required: true };
    if (pendingIds.has(run.runId)) {
      run.delivery = { ...run.delivery, nextAttemptAt };
      delete run.cleanupHandled;
      delete run.cleanupCompletedAt;
    } else {
      run.delivery = { status: "delivered", deliveredAt: endedAt + 500 };
      run.cleanupHandled = true;
      run.cleanupCompletedAt = endedAt + 1000;
    }
  }
  state.runOpenClawStateWriteTransaction((db) => writeSubagentRunValuesInDatabase(db, runs.map(bindSubagentRunRecord), []));
  const verified = [...loadSubagentRunsByIdsInDatabase(database, ids).values()];
  const counts = { terminal: verified.filter((run) => run.execution.status === "terminal").length, pending: verified.filter((run) => run.delivery.status === "pending").length, delivered: verified.filter((run) => run.delivery.status === "delivered").length };
  assert.deepEqual(counts, { terminal: 6000, pending: 60, delivered: 5940 });
  summary.maintenanceFixture = { ...counts, nextAttemptAt };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary.maintenanceFixture));
} finally {
  await state.closeOpenClawStateDatabaseAsync();
}
JS
```

The report includes allocation and promotion per completed patch, worker message
counts and known payload bytes, and RPC p50/p95/p99 with sample counts. Worker
payload bytes include transferred buffers; they are not an exact count of bytes
deserialized by `node:v8`. Each profile's `.deserialize.json` sidecar separately
records exact main-isolate `v8.deserialize` input bytes and call counts, grouped
by a fixed allowlist of decoded root `kind` labels (`other` for unknown labels,
or `untyped` when absent). The observer runs only inside profile
captures and is restored afterward. Divide a group's bytes by the completed
operation count to compare deserialize bytes per patch or turn. The generic
entry-patch transfer also carries lifecycle and transcript work, so inspect these
groups in a matched real-turn scenario before attributing its cost to the
`sessions.patch` RPC. Inspect `unmeasuredMessages` and allocation caller stacks
alongside them. `--capture-responses` also saves six complete mutation
responses in `patch-responses.json` after measurement. Compare those goldens
between revisions, normalizing only recorded timestamps and sandbox paths;
fixture session identities and requested values are deterministic.

Use the host's shared guard and exclusive measurement slot, run both sides
concurrently with the same start time and interleaved CPUs, and swap sides for
the second pair. Report absolute and relative paired deltas. Baselines differing
by more than 5× or opposite-signed pair deltas are inconclusive; if such a metric
gates, run a third pair and decide on the absolute mean. A p95 requires 200
samples per side and a p99 requires 1,000. Major GC tails are context below 50
collections per side. Report each side's maximum GC pause; per-pause tails are
context when collection counts fall at least 20% without increased total GC time,
unless the candidate maximum exceeds the greater of 50 ms or twice the baseline
maximum. Gate on total GC time per patch, promotion, and eligible event-loop
p99. Reject a mean paired regression of at least 20%, or at least 10% in both
pairs, subject to those sample-count and inconclusive-result rules.

Every measured scenario records per-method request-to-response p50/p99, call rate,
and uncompressed wire response bytes. Transcript samples also report
`chatDeltaDeliveryMs`: the Gateway-assigned chat-delta message timestamp to each
subscriber receipt, including server delivery queues and client parsing. Both
processes run on the same host; this is not internet latency. Handler and worker queue timings remain in
Gateway diagnostics. Whole-window CPU/allocation divided by source-event or
socket-delivery counts is a workload-normalized cost, not isolated encode/send
cost. Use CPU profiles when attributing broadcast work.

Allocation profiles also report `broadcastAllocation`: every sampled allocation
under `broadcastInternal`, classified into disjoint event-projection, recipient
setup, row-presentation, encoding, and remaining-broadcast subtrees. Attribution
uses the complete stack; each family's ten largest sites retain their full stacks.
`projectionSelfSampledBytes` separately counts allocations directly attributed to
the session-event projection module, including its envelope objects and closures.
It overlaps the family totals and must not be added to them. The report normalizes
the broadcast subtree by source session events and completed turns as
`broadcastAllocatedBytesPerSessionEvent` and `broadcastAllocatedBytesPerTurn`.
These include other broadcast event types in the same measured window; they are
workload-normalized costs, not session-event-only allocation counters.
Use `--entry src/entry.ts` from each measured checkout for source-file attribution;
bundled anonymous functions cannot reliably identify these owners. A false
`sourceProjectionObserved` means that owner attribution is unavailable, not zero
projection allocation. Allocation sampling cannot determine exact projection,
clone, or serialization invocation counts; use the owner work-count tests for
those facts. Repeated identical audiences and distinct viewers should be separate,
equally configured comparisons.

For session-projection comparisons from one installed checkout, add
`--entry src/entry.ts --session-projection-source <directory>` to both arms.
The directory must contain all nine coherent owner files:
`session-event-projection.ts`, `session-row-presentation.ts`,
`session-sharing-read.ts`, `session-utils-list.ts`, `session-row-placement-projection.ts`,
`session-ancestor-references.ts`,
`server-connection-state.ts`, `server-methods/sessions-read.ts`, and
`server-methods/sessions-read-by-key.ts`. Put their original
revision's files in a baseline directory and use `--session-projection-source
src/gateway` for the candidate. The preload reads all nine before Gateway startup
and fails on a missing file; it substitutes raw TypeScript while retaining canonical
module URLs, relative imports, and source line numbers. The report records the
resolved `sessionProjectionSource`. It also loads the canonical broadcaster as
native TypeScript so its function name remains visible in allocation profiles
without installing the timer. Use separate fixtures and ports with matching
workload flags. Collect allocation and broadcast-timing comparisons in separate
passes so the timing observer's allocations do not enter the broadcast profile.

Use a separate `--session-projection-counts --entry src/entry.ts` pass to count
audience cache misses, payload cache misses, successful recipient projections,
and distinct final wire payload objects per session publication. The report's
`sessionProjectionCounts` includes both raw counts and per-publication means.
These count projector results before socket submission, not acknowledged delivery.
The observer rejects allocation, CPU, GC-trace, transport-count and timing modes
to keep its instrumentation out of those measurements. Compare identical runs
with and without `--list-interval-ms 30000 --poll-seed roster-polling` to isolate
staggered roster reads; negotiate `--session-row-deltas --session-envelope-refs`
for current Control UI clients. A growing wire-payload count with stable audience
count identifies fragmented delivery histories rather than different permissions.
The workload creates the main-session root before its synthetic parent and children;
an incomplete ancestor chain omits ancestor envelopes and cannot prove this effect.

The existing allocation diagnostics include per-kind GC pause `count`, `total`,
`max`, `p95`, and `p99` under `allocation.diagnostics.gc`, plus event-loop sample
count and p99 under `allocation.diagnostics.eventLoopDelay`. Promotion is read
from the matching main-isolate V8 trace after the Gateway exits. Report baseline
and candidate maximum pauses and collection counts alongside totals and tails.
`chatDeltaDeliveryMs` includes count, p95, p99, maximum, and individual samples;
it measures publication-to-receipt delivery. Add `--broadcast-timing --diagnostics
--entry src/entry.ts` to time the synchronous `broadcastInternal` owner, including
targeted sends and retained replays. `broadcastLatencyMs` reports each event's
actual call count, total, maximum, p95, and p99. A benchmark-only source loader
inserts a timer and private numeric diagnostics publication, refusing changed
source anchors or an unloaded owner. This includes recipient projection, encoding,
and synchronous socket submission; it excludes completion of asynchronous socket
writes. It also counts calls that return without delivering a frame. Enable it
identically in both arms and report that timing instrumentation was present.
The timer rejects allocation sampling, including stream-start and memory-soak
retained profiles; use `--retained-profile-ms 0` for a timing-only memory soak.
Use a sufficiently long single allocation round when gating natural GC and loop
tails; for example, 4,000 chunks at 10 ms with eight concurrent runs and 48 clients.
Check actual sample counts rather than inferring them from requested duration.
`--start-at <epoch-ms>` synchronizes measured windows after each side's warmup.

The default transcript-broadcast clients use direct loopback ingress, which does
not negotiate compression. Add `--compressed` to use one synthetic trusted-proxy
identity over loopback and exercise negotiated permessage-deflate. Add
`--distinct-viewers` instead to use a separate admitted synthetic identity per
client; this also enables compressed ingress. Both modes verify trusted-proxy
authentication, negotiated compression, and the expected user-profile count.
They configure only the generated Gateway fixture and use documentation-only
forwarded addresses; no real proxy, account, or external connection is involved.
Use the same mode on both sides of a comparison. These modes support
`transcript-broadcast` and `memory-soak` without `--mixed-rpc` or
`--operator-access-policy`.

Use `--transport-counts` in a separate transcript-broadcast pass to attribute
`Buffer.concat` calls and copied bytes by source call site, and count outbound
`Socket._write`/`Socket._writev` submissions on the isolated Gateway port. Each
sample records the counters beside its event counts; divide bytes and submissions
by the validated source-event or delivery count as appropriate. Batched writes
also record their segment count. These are native socket submissions, not kernel
syscall counts, and exclude worker isolates and other socket ports. Stack capture
adds substantial allocation and CPU overhead, so this mode rejects allocation,
CPU, GC, and diagnostics profiling flags. Its timing and heap figures must not be
used as acceptance results. Compare separate uninstrumented or equally profiled
A/B runs for those metrics. The private diagnostics IPC acknowledgment bounds the
counted workload; setup, warmup, and report serialization remain outside it.

Add `--workload-cpu-profile` to capture the full measured workload in the Gateway
main isolate. Each sample's `workloadCpuProfile` includes the full
`workload-<round>.cpuprofile` path, sampling duration/count, diagnostics, the 40
hottest functions, and sampled time under `broadcastInternal`. This differs from
`--cpu-profile`, which captures stream admission/release and optional recap
phases; the two flags cannot be combined.

Add `--presence-deltas` when measuring presence delivery preparation; without this
capability, clients receive legacy presence snapshots and bypass delta preparation.
The option uses the synthetic trusted-proxy Control UI clients so their connections
participate in presence; default backend probes are excluded from the roster.

Run full CPU attribution in a separate matched pass, replacing `--allocations`
with `--workload-cpu-profile`. The new mode rejects `--allocations`, `--trace-gc`,
`--stream-start-allocations`, and retained heap capture; for `memory-soak`, set
`--retained-profile-ms 0`. Serializing and writing CPU profiles allocates enough
memory to contaminate simultaneous allocation, promotion, and GC measurements.
Keep the allocation/GC pairs and full CPU pairs separate with matching workloads.

Event/RPC counting starts after the CPU-start acknowledgment and ends when the
workload, event drain, and outstanding polls finish. The CPU profile then stops.
CPU samples include the small start-acknowledgment and stop-request edges,
including stop bookkeeping before V8 stops sampling; event counts exclude those
edges. Existing whole-window CPU counters include profiler setup, stopping, and
profile serialization. No new 25 ms priming wait is added; if
`--stream-start-diagnostics` is also enabled, its existing 25 ms waits occur inside
the full-workload capture. Keep these attribution runs separate from unprofiled
acceptance timing, and compare equally instrumented pairs.

Add `--capture-responses` to retain the first successful measured response payload
per method per round at `samples[].rpc[method].representativeResponse.payload`.
Capture is opt-in and happens in the controller; payloads are saved only in the
result artifact, not the stdout sample summaries. Serialization into the report
happens after measurement. The sample preserves parsed payload content, not the
original wire encoding or response envelope. Use it for offline content and
serialized-payload comparison, accounting explicitly for expected dynamic fields
such as timestamps and IDs. Exact uncompressed response-frame byte totals remain
in the RPC metrics. For `--scenario sessions.list`, capture also writes
`list-responses.json`: twenty filter, sort, pin, archive, and paging requests issued
after measurement and removal of the harness-created parent/child sessions (unless
using a preseeded history). Compare these payloads across revisions with identical fixtures,
normalizing only recorded envelope timestamps, process-local `rowsRevision` tokens,
and sandbox paths. Capture remains
opt-in; the additional requests do not warm the measured workload.
For `sessions.list` response comparisons, `--capture-responses` can run without
allocation or CPU profiling.

For `--scenario sessions.list`, add `--list-filter-churn` to cycle ordinary, open,
archived, `team-shape` search, main-agent, and kind-exclusion requests. Every tenth
logical list operation first changes the harness-owned parent's label; seeded
sessions remain untouched, and capture removes the parent before writing goldens.
`samples[].rpc["sessions.list"]` reports list latency separately from patch RPCs;
CPU and allocation per logical list operation include churn work. The report records
`listFilterChurn`. Use the generated Team-shaped fixture so every filter has a
nonempty page.

For profile-reference filtering over 5,000 prepared sessions, run:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-profile-reference-measure.ts \
  --iterations 108 --output sample.json --golden responses.json
```

Each process reports one warm main-thread CPU and sampled-allocation observation
per `filterSessionEntries` operation, including objects collected by minor and
major GC. The 27 requests cover three viewer scopes, canonical and merged aliases,
retained profiles, prefix and missing references, archives, and empty time windows.
Every session has three participants; the 50 profile identities include ten aliases
and ten retained identities without durable rows. Preparation uses an isolated
empty catalog and asserts that no SQLite file is created. Compare `responses.json`
byte-for-byte between revisions; it contains complete 25-row filter results and
full-roster facets. Run at least five alternating baseline/candidate processes on
the benchmark host. This is an owner probe, not Gateway or transport evidence.

Add `--ordinary --iterations 2200` to cycle through eleven ordinary, archive,
label, agent, kind-exclusion, and static-search requests over 5,000 rows, replacing
one row revision every ten operations. The static-search case matches session IDs;
it does not measure dynamic model or run-state search. The golden includes results
before and after churn. `--heap-profile profile.json` saves allocation attribution.
Both modes report per-operation timing sample counts and observed GC totals and
maximum pause, excluding GC triggered by stopping the allocation sampler. These
owner measurements do not include Gateway transport or event-loop delay.
For concurrent comparisons, pass the same future Unix millisecond timestamp with
`--start-at` to both processes. They wait after warmup and explicit GC; a missed
start deadline fails the run. The report records the actual measured start time.

For long RPC allocation windows, use `--warmup-operations` to warm fewer requests
than the measured `--operations` count. For example, `--scenario sessions.list
--warmup-operations 25000 --operations 100000 --rounds 1 --allocations --trace-gc
--diagnostics --heap-sampling-interval 524288` keeps one uninterrupted measured
window and bounds profile size. Record actual elapsed durations; operation counts
are not time guarantees. Warmup defaults to the measured operation count. Heap
sampling defaults remain 32 KiB for RPC/turn rounds and 512 KiB for memory soaks.
Stopping a heap sample forces GC, so use one long round for natural-GC acceptance
rather than aggregating short rounds separated by sample stops.

Turn scenarios use `--runs` (defaulting
to one for `chat.send`); `--chunks` controls streamed answer size. `plugins.reload`
defaults to one operation per round; other RPC scenarios default to 100. Count
the warmup when choosing reload batches: the admin RPC allows 30 calls per minute.
Reload rounds honor `--round-interval-ms`; use single-operation rounds spaced
by at least 2,400 ms for longer captures below that limit.
The reload scenario retains the synthetic fixture's `plugins.allow` and
`plugins.entries` configuration, then adds its no-op plugin. Configure bundled
plugins there to include their metadata and runtime participation in the workload;
the default team-shape fixture disables plugins. `plugin-inventory.json` records
the actual runtime states before capture, including enabled plugins that remain
unloaded under their lazy activation policy. The harness replaces `plugins.load`
with its own synthetic plugin directory.
With diagnostics enabled, `wholeReloadDiagnostics` retains one full-run event-loop
histogram and GC totals; use its observation counts to qualify tail percentiles.
Setup, startup
recovery, subscription establishment, and one warmup round are outside capture.
Each measured window includes completion and event drain, including the one-second
quiet interval. The fixture inventory and request/client/run counts are recorded
in `result.json`; the driver prints each sample as JSON and a short table.
Raw `.heapprofile` files and numeric diagnostics remain alongside the report.
Each profile also records `.worker-messages.json`: main-to-worker and
worker-to-main message counts, known payload bytes, and unmeasured-message counts
by bounded message kind for that capture window. Divide those totals by the
validated operation count when comparing bytes or messages per RPC/turn. Buffer
lengths are exact and string lengths approximate UTF-16 storage; envelope and
object-graph sizes are not included. Compare the unmeasured counts too: a kind
with no known bytes is not necessarily cheap. These are logical payload bytes,
including transferred buffers, rather than bytes copied by structured clone.

For a separate worker-message attribution pass, set
`OPENCLAW_BENCH_WORKER_ATTRIBUTION=1` and use `--entry src/entry.ts`. The private
preload instruments the existing metrics owner, SQLite admission receipt, worker
receiver, and task-pool reply boundaries in memory. Each CPU/heap capture adds `.worker-attribution.json` with
message counts, known payload bytes, and V8 re-serialized envelope bytes grouped
by bounded message kind, protocol operation, receipt/publication kind, and known
lifecycle script. Received dependency messages use `other` for unregistered
scripts; boundaries without script identity use `unknown`. The observer does not
infer identity from payload contents. It caps groups at 512 and reports overflow.
Direct metrics calls that do not expose their message value report
`unavailableMessageValues`. Outgoing dependency messages remain unsized so the
observer never runs their getters or proxy traps. Shared buffers contribute reference
encoding bytes and separate `sharedBackingBytes`, never copied backing bytes.
MessagePorts and unsupported native objects report `failedSerializationMessages`,
not empty messages. The size estimate includes transferred ArrayBuffer contents
and is neither native transport bytes nor deserialized heap bytes.
Actor receipts also report the bounded phase and separate serialized sizes of
authority snapshot entries, receipt postimage entries, and their skills snapshot,
system-prompt report, and pending-delivery fields when present. These overlapping
sections are diagnostic breakdowns; do not add them to total message bytes.
The separate `taskReplies` table breaks validated task replies down by the task
owner's worker URL and a fixed operation vocabulary. It refines the owner's
existing diagnostic label during input preparation and reads it at reply receipt;
there is no request/reply correlation map or retained payload. This table overlaps
the transport groups and must not be added to their totals. Replies rejected before
task/status validation are absent from this table. `sourceHooks` lists the source
modules actually instrumented, including the package task-pool core reached by
normal `@openclaw/worker-runtime` imports.

Re-serialization adds allocation and CPU work: use that pass to locate traffic,
then unset the flag for allocation, retained-heap, promotion, GC, and latency
acceptance runs. Profiles with collected objects estimate allocation; live-only
profiles estimate survivors. Native structured-clone allocations without a JS
stack cannot be assigned exactly to a message or its retaining cache by this
observer. Correlate those samples with receipt counts and inspect a separate heap
snapshot for retainers. The observer retains numeric aggregates only and never
takes per-message sampling profiles or forces a collection.

Use a freshly generated fixture on each revision and compare multiple rounds.
The driver adds a small parent/child session set; those sessions are included in
list measurements. For production-shaped database size use `--transcript-mib 1500`
when generating the fixture and record its actual database bytes.

The existing private benchmark IPC preload samples the **Gateway main isolate**,
with both `includeObjectsCollectedByMajorGC` and
`includeObjectsCollectedByMinorGC` enabled and a 32 KiB average interval. V8's
node `selfSize` totals estimate allocated bytes, including objects collected
during capture. `estimatedAllocatedBytesPerOperation` divides that total by the
validated completed operation count. Top sites include up to eight caller frames
in entry-to-leaf order. These are statistical estimates: small batches can have
substantial sampling noise. Run an idle comparison if background allocation is
material; the driver does not subtract it or silently present heap deltas as churn.

`gcMs`, `gcCount`, and `gcMsPerOperation` come from the main isolate's GC performance
entries. Diagnostics also separate major, minor, incremental, and weak-callback
collections. Allocation capture enables V8's GC trace and records promoted bytes
in `gcTrace`; compare promotion and GC alongside sampled bytes. A forced collection
before Gateway startup identifies the main isolate, outside every measured window.
Synchronous markers bound capture; parsing rejects missing markers or ambiguous
isolate identity. Profiler setup/teardown and worker collections are excluded from
promotion. The parser supports classic name/value traces and current V8 JSON traces. Heap-used and RSS deltas are separate context fields. Worker allocations,
worker GC, external buffers, and driver/model-fixture allocation are **not** in
these per-operation estimates. Process CPU and RSS include workers; main-thread
CPU is reported separately. Profiling adds CPU and memory overhead, so compare
with the same sampling settings. No profiling runs when `--allocations` is absent.
For live operator attribution, `diagnostics.heapProfile` accepts
`{ "durationMs": 10000, "includeCollected": true }` with the existing admin
scope and 30-second churn cap; it remains a timed sample, not an RPC denominator.

## Presence during chat pane replacement

`presence-churn-measure.ts` starts an isolated loopback Gateway with synthetic
sessions and 42 WebSocket operators (40 delta readers and two legacy readers).
It drives the same viewer-declaration owner as chat pages, replacing its owner
without changing the watched session once per second. A real session change and
final departure are positive controls after the measured churn.

```sh
node --import ./scripts/tsx.mjs scripts/perf/presence-churn-measure.ts \
  --state-dir /path/to/new-synthetic-presence-state --port 41466 \
  --clients 42 --rounds 20 --interval-ms 1000 --output /path/to/presence.json
```

The state directory must not exist. Run with an isolated `HOME`, `OPENCLAW_HOME`,
and `TMPDIR`. `--viewer-owner` accepts the baseline or candidate TypeScript owner
module; both sides otherwise use the same Gateway. This isolates client-side
publication changes without counting Gateway startup as a performance result.
Use `--start-at <epoch-ms>` for concurrent pairs with separate directories and
ports, swapping CPU halves between pairs under the quiet-measurement lock.

Compare viewer requests, presence frames and UTF-8 payload bytes per minute.
A successful no-op fix removes unchanged-viewer requests and their fan-out while
both legacy and delta readers still receive real changes. CPU and RSS cover the
workload in the shared Gateway/client process; they are context, not full-browser
or production capacity measurements. This script models a reproducible lifecycle
pattern, not a claim that all observed viewer traffic is redundant.

For payload attribution, use `--scenario payloads --clients 40 --agents 24`.
This prewarms the real public health collector, then measures one cold attach
wave and `--rounds` reconnect waves with reused signed devices. It records
per-field UTF-8 JSON byte totals for hello responses, health events, and presence
events; connect p50/p99; and socket-to-hello-plus-initial-presence readiness.
After the first maintenance tick, each wave records a synthetic context-engine
quarantine through its owner and explicitly probes public health to prove changed
health still broadcasts. Health RPC sizes
are separate from the per-wave hello + health + presence traffic total. Fields
contain sizes only; nested field totals overlap their parent. The default web
profile uses `presence-deltas` and `hello-health-on-demand`; `--compact-payloads`
adds `health-summary` and `hello-presence-self`. With `--client-profile native`,
only `health-summary` is added, preserving the profile's legacy CLI controls.
Plugins, channels, cron, and heartbeat execution are disabled; this is a small
synthetic agent roster, not a production-state or browser-rendering benchmark.
Run concurrent baseline/candidate pairs with the same `--start-at` and swap CPU
halves for the next pair, as above.

## Measure session roster refreshes during row churn

`session-roster-churn-measure.ts` starts an isolated loopback Gateway, creates 270
synthetic conversations through the real RPC, and drives the Control UI session
capability through a WebSocket transport adapter. It observes the general,
owner, involving-me, and compact child queries plus the primary roster. The
sidebar uses its 200-row window; the ten warmed hot rows receive one patch per
second. Each run lasts 135 seconds by default, crossing both minute fallback
windows:

```sh
node --import ./scripts/tsx.mjs scripts/perf/session-roster-churn-measure.ts \
  --state-dir /path/to/new-synthetic-state --port 41471 \
  --sessions 270 --duration 135 --output /path/to/roster-report.json
```

The state directory must be new. `--session-owner` selects an alternate module
exporting `createSessionCapability` and `GatewaySessionRowEvents` for controlled
owner and decoder comparisons; otherwise the current source is used. `--start-at` gates activity after setup and rejects
an already missed shared deadline. `--membership-churn` also creates and archives
sessions every thirty patches, keeping necessary membership reads separate from
the steady held-row workload. Run the same scenario on both sides, with the host's
exclusive measurement lock and alternating CPU halves. Fixture preparation and
builds must use the host's preparation CPU allocation.

The report records list caller/query parameters, response JSON bytes, conditional
row bases, preceding session event, event counts, CPU, and Node event-loop delay.
It rejects missing row-event deliveries, decoder gaps, empty observed queries,
RPC failures, or final membership, label, status, active-run, model, or agent-status
note differences from authoritative list reads. Counts exclude setup and final
verification. Bytes are response payload
JSON, excluding WebSocket framing and compression. The process contains both the
Gateway and session owner, so CPU and event-loop delay do not isolate either.
This exercises the real session owner and transport, not browser DOM rendering,
Long Task blocking, or reconnection.

Add `--model-turns 2 --mock-port 41474` for a separate correctness phase after the
measured row workload. It enables the bundled OpenAI plugin with synthetic-only
credentials and a loopback SSE fixture, changes between two configured models,
starts real agent turns, and waits for success. The report must observe each
turn's start and settlement events and each loopback inference request. Model
and catalog traffic is reported separately and is excluded from the healthy-row
rate comparison. The default run starts no model provider.

## Prompt history fingerprints

`worker-task-metrics-measure.ts` measures the real shared compute pool and source
provider-prompt worker with one short user message, then 64 synthetic messages
containing 256 KiB of text. Run on the approved benchmark host:

```sh
node --import ./scripts/tsx.mjs scripts/perf/worker-task-metrics-measure.ts \
  --start-at <future-epoch-ms> --output /path/to/result.json
```

Each phase has four concurrent clients and four bursts of 5,000 timed tasks,
providing 20,000 samples for p50/p95/p99; every percentile includes its sample count.
Each burst first warms 500 tasks, and then retires its workers with `pool.rotate()`.
Task latency and phase CPU/elapsed exclude warmup and rotation; rotation times are
reported separately. The first warmup completes before the shared start deadline;
subsequent bursts and the second phase run sequentially. Missed startup deadlines,
task errors, or fingerprint mismatches fail the run. Every reply verifies count,
role, content digest, and stable packed fingerprints without rehashing the input.

GC observations include warmup and retirement and are context only; baseline
workers can lose their final GC batch at retirement. Retained pool totals are
cumulative across phases and remain in `retainedAfterClose`; they are absent when
running this unchanged script on a baseline without the new counters. No provider
or Gateway is contacted. Run at least two concurrent pairs under one host quiet
lock, use the current interleaved 16-CPU sides, and swap sides for the second pair.
Apply the paired-mean and sample-count decision rules; major GC needs at least
50 collections per side to gate. Set each process's HOME, OPENCLAW_HOME, and
TMPDIR to its own sandbox, and use the host's production guard and resource limits.

`prompt-cache-history-measure.ts` runs the production `convertToLlm` and history
fingerprint owner over 400 synthetic assistant messages with text and nested tool
arguments. It separates one cold call from 100 warm calls for append-normalized,
sealed/reloaded, and mutable SDK history. It counts SHA-256 calls and UTF-8 input
bytes per observation and per message, plus elapsed and process CPU time. These
are fingerprint work counts, not whole-Gateway allocation or provider latency.

```sh
node --import ./scripts/tsx.mjs scripts/perf/prompt-cache-history-measure.ts \
  --start-at <future-epoch-ms>
```

To compare a baseline, save its `prompt-cache-history.ts` beside the current
module and pass its absolute path with `--owner`. Use the same runtime and fixture
on both sides of each concurrent, locked pair, swapping CPU halves between pairs.
Run at least five pairs. The retained append-normalized case should eliminate
repeated nested-argument hashing; sealed history should remain at zero warm hash
bytes, and mutable SDK content must still be inspected. Diagnostic output and
in-place mutation coverage live in `prompt-cache-observability.history.test.ts`.

## WebSocket event diagnostic accounting

`ws-event-diagnostics-measure.ts` exercises the real recording and diagnostic
dispatch owners with 250 batches of 1,000 synthetic accepted frames, plus wire-byte
observations. It includes plain, presence, subscribed/roster session, and unknown
event labels. `--batches` and `--frames` control the workload. Run on the approved
benchmark host:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/ws-event-diagnostics-measure.ts
# For paired runs, schedule both passes independently:
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/ws-event-diagnostics-measure.ts \
  --start-at <future-allocation-epoch-ms> --cpu-start-at <later-cpu-epoch-ms>
```

Add `--transport --port 41587 --frames 72` to open 72 real loopback WebSockets
and send a shared 1,024-byte synthetic JSON event to every socket in each batch
through `createGatewayWebSocketTransport`. This mode rotates one event kind per
broadcast; the default recorder mode mixes all five kinds within every batch.
Transport mode verifies received payloads and per-socket delivery counts as well
as diagnostic bytes and every cumulative histogram bucket. Compression is disabled;
received wire payload bytes are reported separately from codec diagnostics.
Only loopback ports from 40000 through 65535 are accepted. Setup and warmup finish
before `--start-at <future-epoch-ms>` synchronizes the warmed measurement start.
`--cpu-start-at <later-epoch-ms>` independently synchronizes the unprofiled CPU
pass after allocation sampling. Each phase completes forced GC and instrument
preparation before waiting for its deadline; missed preparation deadlines fail
the run. Sampling is armed before the allocation wait, so allocation totals also
include the small idle-timer setup. `cold.startedAtEpochMs`, `warm.startedAtEpochMs`,
and `cpuStartedAtEpochMs` report actual workload starts for pair alignment checks.

The JSON result separates cold and warmed sampled allocation totals, bytes per
frame, and bytes per broadcast (one batch), including collected objects, for the
entire process and the recording/flush owner. Transport mode also reports bytes
per socket-second using the profiled pass's elapsed time. CPU is measured in a
separate unprofiled pass with batch latency, GC collection counts and total time,
per-kind GC p95/p99/max pauses, and event-loop p99/max delay. Every tail includes
its sample count; insufficient samples remain context. The inactive-interest
pass verifies recording is skipped. `WS_DIAGNOSTICS_CPU_START` and
`WS_DIAGNOSTICS_CPU_END` delimit the unprofiled pass for an external
`--trace-gc-nvp` promotion parser.

Compare concurrent locked baseline/candidate pairs with swapped interleaved CPU
placements under the campaign's guard and decision rules. Report absolute and
relative deltas, GC maxima, and tail sample counts. This isolates WebSocket
transport and diagnostics, rather than a complete agent run; use
`transcript-broadcast-measure.ts --scenario transcript-broadcast --clients 30
--allocations --diagnostics --active-work-diagnostics --trace-gc` and the memory-soak
scenario when whole-Gateway behavior is the question. Allocation reduction alone
is insufficient.

## Mention Inbox target reads

`mention-inbox-measure.ts` starts a real isolated Gateway on synthetic team-shaped
state (5,000 sessions and 6,000 settled runs, without transcript bulk or projects).
It connects one sender and 24 authenticated recipient viewers through loopback
WebSockets, then seeds mentions with real `chat.send` turns against a synthetic
loopback model. The measured paths are `mentions.list` and mentioned-session
label changes that produce `mentions.changed` for every viewer. Inbox item counts,
model completion, and broadcast delivery are checked before and after measurement.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/mention-inbox-measure.ts \
  --state-dir /path/to/new-synthetic-state --output /path/to/result.json \
  --port 41605 --mock-port 41606 --mentions 100 --clients 24 \
  --operations 2000 --broadcasts 100
```

Use one task-owned source checkout and `--owner-dir /path/to/baseline-owners` to
select baseline copies of `mention-inbox-targets.ts`, `mention-inbox.ts`,
`mention-inbox-projection.ts`, and `mention-inbox-recording.ts`. The module URLs
and relative imports remain unchanged. Source hooks count `readTarget`,
`currentTarget`, and `readView`; no production instrumentation is required.
`--count-only` runs setup plus one list and one broadcast without profiling.
`--start-at` schedules the warmed allocation pass, `--cpu-start-at` the unprofiled
list pass, and `--broadcast-start-at` the unprofiled broadcast pass. Each rejects
a missed preparation deadline. For sequential preparation followed by concurrent
measurement, `--barrier-dir <shared-pair-directory> --side baseline|candidate`
writes `<phase>.<side>.ready` and waits for `<phase>.start` containing a future
epoch in milliseconds. The runner prepares each side on the preparation CPUs,
sets each owned process scope to its measurement CPU set, then releases both
sides of each phase together. Sampling starts after the allocation barrier. HOME,
OPENCLAW_HOME, and TMPDIR must remain within the isolated sandbox.

Acceptance rule: run concurrent baseline/candidate pairs with identical fixtures
under one exclusive host measurement lock, using interleaved 16-CPU sides and
swapping placement for the second pair. Decide on the paired mean. Stop for a
20% adverse mean, or 10% adverse in both pairs, for CPU, allocation, total GC time
per operation, promotion per operation, and qualified event-loop/latency tails.
A p99 requires 1,000 samples per side and a p95 requires 200. Major-GC tails are
context below 50 collections per side. Opposite-signed deltas or baselines more
than 5x apart are inconclusive: show absolute deltas beside percentages and run
a third pair if that metric gates, deciding on the absolute mean. GC pause
percentiles with paired absolute mean shifts below 1 ms are context. They are
also context when collection count drops at least 20% without increased total GC
time. Always report both sides' maximum pause; the candidate maximum exceeding
max(50 ms, twice baseline maximum) retains its gate. Guard-interrupted pairs are
discarded and rerun; use the shared production guard without a stricter threshold.

Sampled allocation includes collected objects and reports whole-process and
target-read attribution per Inbox read, plus a rate normalized to the measured
minute. CPU/GC/loop observations are separate from sampling; process CPU includes
workers and in-process WebSocket clients, with main-thread CPU reported separately.
Pass `--trace-log /path/to/captured-stdout.log` with `--trace-gc-nvp` to include
promotion from the existing Gateway trace parser. Synchronous identification
markers before worker startup select only the main isolate; separate capture
markers delimit list and broadcast phases. Worker collections are excluded. Every tail carries
its sample count. The Gateway and WebSocket driver share the measured main isolate, so these
allocation and CPU totals include both. Observed throughput and bytes per minute
are context; decisions use per-operation work. `bytesPer450Reads` provides a fixed
synthetic rate comparison without claiming production Inbox traffic. These
measurements do not cover browser rendering.

## Database page-cache maintenance

`database-page-cache-measure.ts` invokes the Gateway's Linux maintenance owner
through its real spawn broker and read-only process pool on an existing synthetic
team-shape fixture. It reports progress-request and main-thread stat counts,
main/process/child CPU, GC duration and promotion, and event-loop p99/max with
sample counts. `--profile` additionally writes collected-object allocation and
CPU profiles; keep profiled runs separate from timing gates.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/database-page-cache-measure.ts \
  --state-dir "$BENCH_ROOT/state" --cold --passes 3 \
  --output "$BENCH_ROOT/measurement.json" \
  --trace-log "$BENCH_ROOT/measurement.log" > "$BENCH_ROOT/measurement.log" 2>&1
```

`--cold` evicts only the named synthetic database files with Linux `posix_fadvise`;
there is no host-wide cache drop. Without it, residency is observed as found.
`--prepare-only` checks fixture admission and broker readiness without running
maintenance. `--owner-dir` selects baseline copies of `sqlite-page-cache.worker.ts`
and `sqlite-readonly-worker-session.ts` in the parent and its reader children, so
paired runs can share one source installation. The benchmark does not boot a full
Gateway or establish a deployed production effect.

For synchronized pairs, pass `--barrier-dir` and `--side baseline|candidate`.
Each side writes `<pass>.<side>.ready` after preparation; the controller releases
both by atomically writing a future epoch in milliseconds to `<pass>.start`.
Keep the exclusive measurement slot and production guard around the pair, and
swap CPU placement in the second pair. Loop measurements cover the operation,
without idle padding; tails below the campaign's sample minimum are context.

## TTS preference flushes on the Gateway main thread

`fsync-tts-gateway-measure.ts` starts a real isolated Gateway and sends paced
`tts.enable`/`tts.disable` WebSocket requests. Each reply is checked against the
persisted preference bytes. The default workload is 120 requests in one minute.
A synthetic 50 ms delay applies to every `fsyncSync` in both the main isolate and
worker isolates during the measured interval. The companion
`fsync-tts-worker-preload.mjs` is benchmark instrumentation only. This preserves
comparable storage waits when persistence moves to a worker; total flush work is
reported separately from main-thread blocked time. An unmeasured calibration RPC
requires both durable flushes to be visible to the probe, including workers
created by a retained-task supervisor. The first, unmeasured request
reports cold-write latency separately. While waiting for the common start, both
sides repeat an unmeasured write every ten seconds so an idle writer does not
retire before the steady-state interval.

Prepare baseline siblings in the same sandbox source checkout before running:

```sh
git show <base>:src/gateway/server-methods/tts.ts > src/gateway/server-methods/tts.baseline.ts
git show <base>:src/tts/tts-settings-writes.ts > src/tts/tts-settings-writes.baseline.ts
```

The `--baseline` source hook selects both siblings and asserts both were loaded.
Relative imports retain their normal owners. Do not modify source files while
any side of a pair is running. Both sides use the same installed dependency
versions; this workload does not substitute an unpublished fs-safe dependency.

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/fsync-tts-gateway-measure.ts \
  --state-dir /path/to/new-synthetic-state --port 41624 \
  --operations 120 --interval-ms 500 --fsync-delay-ms 50 \
  --start-at <shared-future-epoch-ms> --gc-log /path/to/captured.log \
  --baseline > /path/to/captured.log 2>&1
```

Omit `--baseline` for the candidate and use a different state directory, log, and
port. `--start-at` must leave time for both Gateways and their first writes to
finish; a missed deadline rejects the run. `FSYNC_READY` records readiness.
Preparation/builds use CPUs 0–63, nice 19, CPUWeight=10, IOWeight=10, and an
explicit MemoryMax. For landing measurements hold exactly one exclusive quiet
lock around each concurrent pair, run the shared `slot-b-guard.sh wait` before
launch and `slot-b-guard.sh watch <pair-pid>` during it, and discard interrupted
pairs. Do not change the guard or apply a stricter threshold. Keep HOME,
OPENCLAW_HOME, TMPDIR, and state within the task sandbox.

Use interleaved sets: slot A (`.quiet.lock`) is 96,98,…,126 against
97,99,…,127; slot B (`.quiet-b.lock`) is 64,66,…,94 against 65,67,…,95.
Prepare the processes in their own named systemd scopes on CPUs 0–63; after both
are ready, change only those task-owned scopes' AllowedCPUs to their measurement
sets before the common start time. Swap placement in pair two. Record outside
CPU load for context and decide on paired deltas, not sequential absolute times.

Acceptance: eliminate main-thread synchronous flush calls and blocked time while
preserving total flush count and persisted bytes. Process CPU includes the
Gateway's workers and its in-process WebSocket driver. Main-thread and
whole-process-isolate GC are both reported, including promotion and maximum
pauses; native subprocess GC is outside these counters. Apply the shared v5.3
rules described above: qualify tails by sample count, treat
opposite-signed deltas or greater-than-5× baseline spread as inconclusive, and
run a third pair when an inconclusive metric would gate. Every latency and loop
tail includes its sample count. This simulation establishes persistence-path
blocking behavior; it does not claim production throughput or macOS browser
cookie-import latency.

## Managed attachment cleanup

`managed-attachment-cleanup-measure.mjs` exercises the actual managed-media
cleanup owner with 5,000 unrelated 8 KiB transcript messages and two referenced
managed originals. Prepare each side sequentially in a fresh synthetic directory;
preparation uses the real media creator and transcript writer and is outside the
capture. Each measured process warms cleanup once, then performs 30 cleanups
paced over 30 seconds and verifies both originals remain registered.

```sh
node --import ./scripts/tsx.mjs scripts/perf/managed-attachment-cleanup-measure.mjs \
  --state-dir /path/to/new-cleanup-state --output /path/to/prepare.json --prepare
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  scripts/perf/managed-attachment-cleanup-measure.mjs \
  --state-dir /path/to/new-cleanup-state --output /path/to/cleanup.json \
  --allocations --start-at <shared-future-epoch-ms> --trace-log /path/to/cleanup.log \
  > /path/to/cleanup.log 2>&1
```

`--messages`, `--message-bytes`, `--operations`, and `--seconds` select the workload.
Use identical values, separate state/log/output paths, and the shared quiet-slot
rules above. A missed `--start-at` rejects the run. Two concurrent pairs swap the
interleaved CPU sets. The driver never starts or accesses a production Gateway.

For one installed source tree, `--owner-dir /path/to/candidate-owners` replaces
only these source files, preserved beneath that directory at their repository
relative paths: `src/gateway/managed-image-attachments.ts`,
`src/gateway/session-transcript-read.types.ts`,
`src/gateway/session-transcript-archive-reader.ts`,
`src/config/sessions/session-accessor.sqlite-history-source.ts`, and
`src/config/sessions/session-actor-memory-history-projection.ts`.
`--source-root` selects the installed source tree and defaults to the working
directory. The generated preload also reaches workers through `NODE_OPTIONS`;
`overriddenOwners` records the module paths and thread IDs actually replaced.
An ordinary run uses the tree's unchanged sources. Do not change those sources
or dependencies during a pair. For paired comparisons, also pass the unchanged
source root as the baseline's `--owner-dir`, so both sides use the same esbuild
preload and helper infrastructure.

The report contains main-isolate sampled allocation and raw V8 frame names,
process/thread CPU, before/after heap and RSS, worker-message counts and known
payload bytes, per-collection GC percentiles and maximum pauses, total GC per
cleanup, promotion from bounded main-isolate GC traces, and event-loop delay.
GC and loop capture end before stopping allocation sampling, excluding its forced
collection. Every tail carries a sample count; apply the shared v5.3 qualification
and paired-delta rules. Worker byte counts are partial and retain their
`unmeasuredMessages` counts; the observer never reserializes replies. Allocation
sampling excludes worker heaps and external Buffer backing stores. RSS includes
workers. This isolates the cleanup boundary; it is not a full Gateway throughput
or retained-memory soak result.

## Private diagnostic dispatch

`diagnostic-private-data-measure.ts` exercises the real asynchronous diagnostic
emitter and drain with synthetic private model content. It registers 1, 2, or 4
private consumers (the first marked as OTel), a metadata-only consumer, and a
filtered skill consumer. The default payload contains 64 messages and 128 KiB of
text. One-event clone counting is separate from the warm, untraced CPU pass and
inspector allocation pass, which includes collected objects.

```sh
node --import ./scripts/tsx.mjs scripts/perf/diagnostic-private-data-measure.ts \
  --listeners 2 --events 12000 --payload-kib 128 \
  --start-at <cpu-epoch-ms> --allocation-start-at <allocation-epoch-ms>
```

Use identical prepared sources and fixtures, at least six paired samples per
listener count, synchronized starts, and swapped interleaved CPU sets under the
shared quiet-slot lock and guard. Compare clones, sampled bytes, and CPU per event;
this workload does not establish whole-Gateway, GC, or promotion results. A normal
OTel + Prometheus setup has one private model-content consumer: Prometheus opts
out. The 2/4-consumer cells measure fanout scaling. Accept reduced duplicate clones
and multi-consumer allocation only with intact isolation and no material
single-consumer CPU/allocation regression. Report sample counts and absolute as
well as relative deltas; short-sample percentiles are context only.
