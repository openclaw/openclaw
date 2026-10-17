# Team-shaped synthetic state

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

## Measure the real list endpoint

With the fixture Gateway running, use a second terminal:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-measure.ts \
  --port 40967 --samples 100 --limit 100
```

This uses the real `sessions.list` WebSocket RPC, compact rows and all archived
states. It reports the first call separately, then mean/p50/p95/p99 after five
warmups, plus response size. It uses one operator connection: production's
multiple viewers, mutations, background work and page-cache pressure can be more
expensive. Matching database size alone does not prove production equivalence.
Compare a small fixture and the default fixture on the same checkout and host;
record counts, database bytes, exact revision and request shape with the timings.

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
`--chunks`, `--clients`, `--runs`, and `--rounds` adjust the workload.
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

## Allocated bytes per RPC or turn

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

| Scenario               | One measured operation                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sessions.list`        | One compact sidebar page RPC, `archived=all`, `--limit` rows                                               |
| `subscribe`            | One `sessions.subscribe` snapshot registration/refresh RPC on the sender, with the same page shape as list |
| `chat.send`            | One completed turn: synthetic read-tool call, then paced streaming answer; one client and one run          |
| `transcript-broadcast` | One completed `agent` turn, streamed to `--clients` subscribers; `--runs` concurrent turns per round       |
| `plugins.reload`       | One live reload of a synthetic no-op plugin through the lifecycle RPC                                      |

RPC scenarios use `--operations` per round. Turn scenarios use `--runs` (forced
to one for `chat.send`); `--chunks` controls streamed answer size. `plugins.reload`
defaults to one operation per round; other RPC scenarios default to 100. Count
the warmup when choosing reload batches: the admin RPC allows 30 calls per minute.
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
entries. Heap-used and RSS deltas are separate context fields. Worker allocations,
worker GC, external buffers, and driver/model-fixture allocation are **not** in
these per-operation estimates. Process CPU and RSS include workers; main-thread
CPU is reported separately. Profiling adds CPU and memory overhead, so compare
with the same sampling settings. No profiling runs when `--allocations` is absent.
For live operator attribution, `diagnostics.heapProfile` accepts
`{ "durationMs": 10000, "includeCollected": true }` with the existing admin
scope and 30-second churn cap; it remains a timed sample, not an RPC denominator.
