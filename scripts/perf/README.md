# Team-shaped synthetic state

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
This mode retains synthetic `cron.list`, `models.list`, and `users.self` parameters,
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

To isolate session activity from model selection, use
`--activity-patch-sessions <key-a>,<key-b>` with `--load-runs 1` against existing
synthetic sessions. This alternates navigation between those conversations and
changes their labels at `--interval-ms`, without inference or model changes.
It excludes `--activity-session` and `--activity-cron`. Catalog observations
retain model rows for before/after option comparisons; use only synthetic
catalogs. Compare warm session-scoped request counts and activity blocking time,
keeping the initial catalogs separate from the activity window.

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
the run. The report records the requested start, actual per-round start and first
dispatch skew. CPU profiling starts before the barrier, so the first profile and
CPU totals include its short idle wait; RPC latency samples exclude that wait.
Measured rounds include raw latency samples, p50/p95/p99, payload bytes, returned row
counts, main-thread/process CPU, CPU profiles and existing worker queue, run,
and transfer diagnostics. Each sample includes `payloadSha256`, computed after
omitting the top-level absolute `root` and `sessionKey`; each round lists its
distinct hashes. Compare matching diff hashes across A/B reports to establish
identical response content despite different fixture roots. Within one run,
every diff response must match its warmup hash because the workload does not
modify the checkout. Payload bytes measure re-encoded JSON in the driver,
not WebSocket frame overhead. Profiles sample the main isolate; worker task
diagnostics provide worker timings. They do not count Git subprocesses.
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
These records contain timing and identity only, never RPC payloads. Gateway
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
and verifies inline images reach all three provider requests. These are
direct child-session `agent` calls, not model-driven `sessions_spawn` calls.
Post-GC Gateway heap samples follow every completed cohort, and the optional
final `settled.heapsnapshot` permits retainer inspection. Session resets exclude
intentionally retained live histories from the trend.

For a steady memory soak with real tool execution and attached viewers, use:

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir /path/to/team-shape --scenario memory-soak \
  --clients 8 --runs 4 --chunks 100 --chunk-interval-ms 10 \
  --warmup-ms 300000 --duration-ms 3600000 --round-interval-ms 15000 \
  --memory-interval-ms 60000 --retained-profile-ms 600000 \
  --reset-every-rounds 20 --list-interval-ms 2000 --heap-snapshot
```

This runs paced cohorts after five minutes of warmup, with one real `read` tool
and a streamed completion per turn. Diagnostics and the Prometheus plugin are
enabled. Session generations reset every twenty cohorts (including warmup) to
bound intentional live transcript growth; `--reset-every-rounds 0` keeps history
instead. The report records resets and completed cohorts. It does not exercise
the image/output-limit recovery of `attempt-retention`. `--rounds` is ignored;
an admitted cohort drains before the duration ends, so a slow cohort may overrun.

`memory-samples.jsonl` records Gateway heap, external, ArrayBuffer and RSS memory
after completed cohorts at the requested interval, including exact timestamps.
Periodic samples use natural GC; initial and final settled samples explicitly
collect garbage. Sampling cadence is bounded by cohort duration. The final
window writes `retained.heapprofile` with both include-collected flags false and
a forced collection before stopping. Its `sampledRetainedBytes` and
`topRetainedSites` describe allocations surviving that window, not allocation
churn or all objects retained since startup. `--retained-profile-ms 0` disables
this capture; it cannot run with allocation-churn capture. The optional
`settled.heapsnapshot` supports retainer inspection. A smoke run can use
`--warmup-ms 0 --duration-ms 30000 --retained-profile-ms 15000`.

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
  --state-dir /path/to/new-rpc-fixture --boundary rpc --port 41473 \
  --tabs 3 --background 8 --maintenance 2 --agents 2 --mutate --observe-git-queues --duration-ms 30000 --poll-ms 250 \
  --start-at <epoch-ms> --output /path/to/rpc-result.json
```

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

Measure unchanged summary polls with `--tabs 3 --background 0 --maintenance 0
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
