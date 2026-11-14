# Team-shaped Gateway stress

Run one fixed workload against two **already-built** revisions from this tooling
checkout. All state, logs, profiles, and results go under a new output directory.
The controller creates its own loopback listeners on free ports >=40000. It never
connects to an existing Gateway, discovers credentials, or drives a real browser.
Each arm runs its built `doctor --fix --non-interactive` against its isolated
fixture before Gateway readiness, warmup, and measurement. Service repair is
disabled through the external-supervisor policy. Use a tooling checkout whose
fixture schema both builds can read or migrate forward; newer fixture schemas
cannot be downgraded. Doctor failures or subsequent schema admission failures
are setup failures; the harness never downstamps databases or bypasses admission.
The Gateway's instrumentation loader uses native Node type stripping and resolves
source-only `.js` imports to TypeScript without applying tsconfig aliases.
Already-built JavaScript stays byte-for-byte native: a transforming loader can
append inline source maps and inflate retained Script source bytes and import cost.
Runtime package imports resolve through each build's own package exports. Keep each
checkout's source, workspace package artifacts, and `dist` build consistent;
rebasing source invalidates previously built artifacts.

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --base /path/to/base --candidate /path/to/candidate \
  --output "$PWD/.local/team-stress-comparison" \
  --minutes 10 --pairs 2
```

On an isolated Linux box, add `--exec-io-storm` to exercise agent-exec IO isolation.
The mock model starts one persistent background writer per foreground runner through
the real Code Mode exec tool. Each writer repeatedly writes buffered random data and
calls `fdatasync`, retaining at most 128 MiB under the fresh arm's state directory.
Writers record cgroup membership, `io.max`, `io.stat`, and bytes written every ten
seconds in `agent-exec-io-<runner>.jsonl`; the harness requires progress during the
measurement. Teardown requests graceful termination; writers then remove their data.
An expiry bounds orphaned runs if teardown fails. Do not use this against Team or
other production state.

This mode also imports identical instrumentation into both Gateway revisions.
`agent-exec-io-commits.json` records counts, failures, p50/p95/p99/max duration of
main-thread `DatabaseSync.exec` explicit `COMMIT` attempts during the canonical
measurement window, plus Gateway/agent-exec cgroup IO snapshots. It excludes worker
transactions, implicit commits, and commits embedded in multi-statement SQL. No SQL
or message content is retained. A separate `autocommitMutations` histogram measures
successful native `exec`/`run`/`get`/`all` single-statement
`INSERT`/`UPDATE`/`DELETE`/`REPLACE` calls outside explicit transactions. SQL comments
are ignored; `WITH`/CTEs and statement batches are excluded.
Those durations include statement execution and automatic commit; they are not
isolated COMMIT timings and may include temporary-table mutations. Streaming
iteration is excluded and counted. Coverage counters and prototype-wrapper checks
distinguish absent main-thread writes from missing instrumentation. `result.json` includes these results and writer
artifact paths. Use the existing telemetry's event-loop tails and `hostLoadAverage`
for stalls and host context; zero commit samples cannot establish commit latency.
Writer byte receipts have ten-second granularity, whereas commit timing follows the
measurement start/stop messages. Allocation passes retain their usual traced scope.

`workerCommits` pools actual native explicit COMMIT samples from the Gateway's Node
workers, separately from the main-thread metrics. Shared histograms retain samples
after workers retire and compute percentiles from pooled samples. A shared gate
excludes setup and teardown; COMMIT calls entering within the window retain their
full duration even if they finish after its end. Stop waits up to 45 seconds for
these calls and rejects an incomplete capture. Coverage records instrumented worker
counts plus thread and dynamically loaded backend basenames (including the session
writer). Identities mark workers observed entering a measured COMMIT. Construction
and preload counts are cumulative, including retired workers. CommonJS eval workers
(which skip Node import preloads) are counted as excluded; subprocess-backed database
owners are also outside this metric.

Defaults are 10,800 deterministic sessions, 65 permanent operator WebSocket
clients (plus brief reconnect probes), four concurrent mock-provider turns per
round, and 40 enabled bundled plugins, including `acpx`, `codex`,
`diagnostics-prometheus`, and model providers. The provider streams text and executes real
local tool calls and native subagent turns; no external model service is used.
Provider catalog entries keep their normal lazy activation; this is not 40 eager
integrations. The harness verifies every selected plugin is enabled without a
runtime error and requires ACP, Codex, Prometheus, and the mock's OpenAI provider
to be active. `plugin-inventory.json` records the actual activation states,
including automatically enabled core plugins. External provider and Codex/ACP
backends are not invoked. Bundled modules avoid the preparation-worker overhead
that dozens of synthetic external plugins would introduce.

The seeded mix is 4,300 finished unarchived subagents, 4,400 archived dashboards,
400 active dashboards, 200 explicit sessions, and 1,500 other sessions including
small channel/cron cohorts. Four agents are configured by default (`--agents 8` selects eight); retained rows initially
belong to `main`. Transcripts contain 128 MiB of deterministic, incompressible
message content with a skewed size distribution. This reproduces session shape,
not a byte-for-byte copy of a production database. Retained runs are settled collectors
spread over the first 64 parent sessions, matching the timestamp-churn targets. Their
completions span the last 30 minutes. The existing collector retention setting is 24 hours
in this synthetic fixture so timing/allocation AB/BA passes keep the same cohort.
Their bounded child summaries exercise exact-row event preparation and recipient visibility;
plain subagents do not enter that path. Four projects, disabled cron
entries, user profiles, participants, approvals, and delivered run records use
the existing offline fixture writers.

The campaign captures one clock anchor and reuses it across all fixtures. Pass
`--now <epoch-ms>` from `campaign.json` to replay that anchor with the same seed.
Active dashboard timestamps stay within the normal seven-day archive threshold;
the fixture raises the existing session-count capacity to twice the seeded count.
Normal maintenance remains enabled in both passes.

Before stress rounds, completed mock turns and closed provider streams establish
readiness; unrelated background sidebar publications need not become quiet.
After each workload, tracked foreground and committed-injection events settle
before continuous receipts check delivery across all clients. Unrelated background
metadata and cron events do not reset that workload's one-second quiet window.
Primary turns require both message and session-change
events; native subagent parents and children retain per-event delivery parity,
including child events published before the spawn response. Committed injections
must arrive exactly once on every client. The existing bounded drain also waits
for these receipts: an acknowledged write can still have publication queued.
Timed counts of unrelated background
events are diagnostic: a broadcast can cross the timing boundary between socket
callbacks. Connection and sequence-gap checks remain active throughout.

Clients subscribe to sidebar and transcript events while polling list/search,
history, startup, diff, and reconnect paths. An independent writer commits
`chat.inject` timestamp updates and a scraper reads the isolated Gateway's
Prometheus endpoint. The same mock turns and RPC schedule run in each pass.
`--poll-ms 25000`, `--list-weight 16`, `--round-ms 60000`, `--churn-ms 6000`,
`--runs 4`, and `--clients 65` tune offered load; compare **achieved** RPC/turn
rates too. The list weight is its share of a deterministic cycle with one slot
each for history, startup, diff, and reconnect: 16 means 16/20 list polls.
Four turns run concurrently once per minute by default. Faster turn cadence also
increases the workload's history verification traffic, so calibrate the method
mix as well as total RPC rate. `--list-weight 2 --round-ms 15000 --churn-ms 2000`
selects a heavier turn/history workload with the same client and fixture counts.

## Measurement protocol

The default campaign runs timing AB, timing BA, allocation AB, allocation BA.
Each side gets a fresh fixture and one-minute warmup before its ten-minute
measurement. Allow about 90 minutes plus fixture/startup time. Runs are serial
and counterbalanced; macOS does not offer Linux-style CPU affinity. Keep build,
workload, host, and instrumentation fixed between sides. The script records
entry hashes and build metadata, never rebuilds, and never copies live state.

Timing passes do not sample allocations or force GC during the measured window.
Allocation passes separately enable V8 heap sampling and read the profile once
per minute. Those reads may force GC: their GC/latency figures are diagnostic,
not acceptance gates. `--mode timing` or `--mode allocation` selects one mode.
Without `--base`, each selected mode runs the candidate once.

Use `--aa-pairs 2 --pairs 3` to insert baseline/baseline controls after the first
two comparison pairs. Both control arms load the baseline artifact; their
`control: true` records and comparison rows stay separate from candidate results.
Controls reuse the same fixture seed, clock, workload, and instrumentation mode.

For retention attribution, run a separate `--mode retention` campaign with the
same workload and controls. Its V8 sampler uses
`includeObjectsCollectedByMinorGC=false` and
`includeObjectsCollectedByMajorGC=true`. It reads the profile only after the
measured window, then requests GC and streams a main-isolate heap snapshot.
Profile materialization, explicit GC, and snapshot work are outside the recorded
timing window; sampler-enabled GC/latency still remain diagnostic, never timing
acceptance evidence. The default `both` mode remains timing plus inclusive allocation.

These samples are **survivor/major-collected bytes, not exact promoted bytes**:
live young objects are included and the sampling protocol has no per-object
generation field. Entries allocated during warmup may be absent from the sampled
allocation sites while remaining reachable in the endpoint heap snapshot. Use
the snapshot's retainer paths and dominator sizes alongside sampled sites and
natural old-generation-after-GC telemetry; a missing restoration-site sample
does not prove the absence of retention. See the [retained-heap runbook](heap-retention-runbook.md)
for bounded aggregate analysis. Keep raw snapshots local; even synthetic runs
can contain runtime environment strings.

For a setup check only:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --candidate "$PWD" --output "$PWD/.local/team-stress-smoke" \
  --smoke-seconds 30 --warmup-ms 0 --sessions 108 --transcript-mib 1 --mode timing
```

Short runs are explicitly labeled smoke, never performance evidence. Ordinary
runs reject durations below ten minutes. Existing output directories are refused.
On failure inspect the named controller/Gateway log; do not interpret partial
output as a performance verdict. Interrupting the controller forwards termination
to its owned workload; the workload tears down its Gateway and mock provider.

## Results

`campaign.json` records the protocol, build identities, fixture/result paths, and
completed runs; `comparison.json` and the terminal table show matched base versus
candidate absolute and relative differences. Raw per-run artifacts remain in
each state's `broadcast-measure-*` directory:

- `stress-minutes.jsonl`: main-thread CPU, process RSS, main heap/heap spaces,
  GC duration/count/percentiles/max by kind, event-loop p95/p99/max/count,
  timer stalls above 100 ms, and sampled JS allocation rate in diagnostic mode.
- `stress-rpc-minutes.jsonl`: per-method completion counts, errors, p50/p95/p99,
  and maxima. The raw round RPC latencies and pooled summaries are in `result.json`.
- `memory-samples.jsonl`: main and tracked worker heaps, missing worker samples,
  and separately labeled post-window forced-GC samples.
- `stress-prometheus-*.prom`: real scrapes of the isolated Gateway.
- `stress-telemetry.json` and `stress-allocation.heapprofile`: whole-run telemetry
  and sampled allocation evidence (profile only in allocation mode).
- `stress-retention.heapprofile`, `stress-retention.json`, and
  `stress-retained.heapsnapshot`: retention-only sampled survivor evidence,
  endpoint heap-space checkpoints, and the retained main-isolate graph.

Telemetry summaries also include initial heap-space sizes, so `old_space` and
`large_object_space` growth can use the actual measurement boundary rather than
the first minute sample. Native post-major-GC old generation is recorded from
Prometheus scrapes; the explicit post-window collection is reported separately.

CPU is main OS-thread CPU divided by wall time; 100% means one core. RSS is
process-wide; heap is main-isolate only. Sampled allocations exclude external and
native allocations and are estimates, not heap growth. Event-loop histograms use
20 ms resolution. Stall counts measure timer excess delay, not attributed task
durations. Every percentile includes its sample count: p99 below 1,000 samples,
p95 below 200, and major-GC tails below 50 collections are context. No automatic
performance rejection is inferred from tiny or noisy baselines.

Worker heap comparisons require a complete heap census. Missing workers make
that comparison metric unavailable; partial totals and reasons remain in raw evidence.
Missing array-buffer details alone do not invalidate a complete heap census.

For a separate worker-retention diagnostic pass, add `--worker-heap-snapshot`.
This forwards the workload's existing retained-worker instrumentation and captures
the largest SQLite-store, model-catalog, Git-operation, shared-state read, and
session-archive worker after the measured window.
The worker profiler and explicit collections make this diagnostic evidence;
use an ordinary timing pass for latency and GC acceptance.

Add `--knowledge-worker-heap --worker-heap-snapshot` to include the Knowledge
storage worker. This selects Knowledge as the memory plugin, provisions one
synthetic private store with 256 linked person pages of about 14 KiB each, and
edits 25 pages before each round's status RPC. The post-window snapshot includes
the storage worker; `knowledge-latencies.json` records status round trips.
These documents are a controlled retention workload, not a production corpus.
The existing 40-plugin catalog remains enabled, with Knowledge added to it.
RSS remains process-wide; a worker's heap snapshot does not establish its share
of native RSS. Use `knowledge-worker-heap-measure.mjs --scan-pages 256` for a
larger operation-latency sample and worker CPU/allocation counters.

Add `--worktree-tool-churn` to create managed worktrees for foreground sessions
and exercise provisioning workers before measuring the same concurrent turn workload.

For production-shape calibration, use an authorized read-only Prometheus query.
Compare achieved
RPC rates, operator connections, main-thread GC seconds/minute, retained heap,
and `sessions.list` handler latency at the same rate. Production handler latency
and the harness's client round-trip latency are different boundaries; use the
captured development Prometheus histograms for a like-for-like comparison.
Production's exported event-loop maximum histogram is not an event-loop sample
p99. Do not relabel it as one. This script deliberately has no production-load
target option. Live deployment stress requires a separate, explicitly authorized
campaign.

Pass `--operator-model-policy` to exercise role-scoped model presentation. All
clients authenticate as an identified synthetic operator through the loopback
trusted proxy and share a role allowing `openai/*` except `openai/blocked-*`.
The setup requires the public `models.list` response to expose the restricted
selection policy and the mock default, and saves it in `operator-model-policy.json`.
This avoids the shared-secret owner's role bypass. Use the same option for both
arms and controls; it also enables the existing trusted-proxy compression path.
Each `stress-minutes.jsonl` sample includes the host's 1/5/15-minute load averages.
With this option, allocation passes also write `operator-model-policy-counts.json`:
main-isolate preparation, restore, and reference-preparation calls during the
measured window, with the instrumented function names. The private loader adds
counters to the built policy module only in these diagnostic passes. Check the
installed names before interpreting zero counts; `prepareRefs` runs twice per
policy construction for the explicit allow/deny fixture. Timing passes remain
uninstrumented. Attribute sampled bytes to the policy stacks in
`stress-allocation.heapprofile`; sampled bytes are estimates, not exact allocation.

## Restart chaos with model traffic

This opt-in scenario extends the same controller with real Gateway processes,
throwaway Git workspaces, input receipts, metadata churn, and three restart legs
(managed intent plus SIGTERM, raw SIGTERM, and deliberately injected SIGKILL).
It is never run automatically by CI.

Every workload session is created through `sessions.create`; the controller waits
for the returned key before sending turns or starting metadata churn, matching the
Control UI. Read-marker and label patches still run concurrently with `chat.send`
admission on those published sessions. Racing patches against an absent key tests
implicit creation instead and can fail before any restart is injected.

Start with the mock setup check:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --restart-chaos --dry --concurrency 8 --minutes 10 \
  --output /absolute/new-report-directory
```

For an approved live campaign replace `--dry` with
`--live-model openai/<approved-model> --key-file /secure/staged-key`.
There is deliberately no live-model default. The private regular key file must
have no group/other permissions. Only the Gateway launcher reads it into its
environment; the controller never reads, copies, or writes its contents. A local
Responses proxy accepts only `POST /v1/responses`, forwards to that fixed OpenAI
endpoint, and records request metadata only. It forwards authorization in memory.
It injects a bounded, OpenAI-shaped TPM 429 window for the synthetic
primary model; the configured fallback uses the approved live model. Both routes
forward to that model. Three real upstream 429s within one minute stop the campaign.
The proxy does not persist headers or request/response bodies.

The injected response advertises the remaining window in both `Retry-After` and
its error text. After observing the first injected 429, the controller creates a
fresh newcomer session through `sessions.create`. Invariant 9 records its first
streamed request: it must use fallback or have a recorded rate-limit wait before
using primary after reset. Preparation or queueing delays alone prove nothing.
Title/utility calls are excluded. A newcomer created after reset, or one with no
observed request or wait evidence, leaves shared knowledge unknown. Both mock and
live modes use a 30-second window so preparation can finish before reset.

Concurrency is bounded to 8–24 sessions and the campaign deadline to 1–18 minutes.
Each wave asks for coding tools, subagents, a background process, steering, and
queued follow-ups. A completed idle session is the negative control. The recovery
cohort receives no follow-up after restart; separate sessions exercise sends during
drain and immediately after return. Dry mode uses synthetic provider responses
and real local exec tools; it checks harness plumbing, not real-model compliance
with the complete scenario mix. Check recorded tool events before claiming that
any requested behavior was actually exercised.

After the final injection, the controller polls every input's public history until
accepted inputs settle (apart from deliberate crash loss) and their sessions are
inactive, or ten minutes pass.
The overall campaign deadline remains a hard bound and may shorten this wait;
`settlement` records the effective deadline and observed finish. Still-unresolved
accepted inputs become `timed-out`, never implicitly successful or silently active
at cutoff. Safety aborts retain the reason and available evidence.

Completion sentinels count only when `DONE_<input>` is alone on the final line of
a final assistant message. Quoted markers, commentary, and promises do not count.
Subagent prompts ask for independent, self-contained checks without specifying
tool arguments or requesting checkouts; successful child launches still require
recorded evidence.

Graceful restarts resume running root sessions through ordinary inputs. Deliberate
SIGKILL writes no resume markers: unanswered inputs sent before that crash in its
active sessions are recorded as accepted crash loss. New post-restart inputs must
still settle. The dry provider inspects its exact effect marker before appending
again, following the resume instruction without adding runtime effect replay.

Use `--candidate /path/to/reviewed-checkout` to replay this tooling against another
revision. Prepare that checkout's build first; `dist/entry.js` is required, matching
the existing controller's built-candidate contract. Use isolated state, a unique
CLI profile, and a free configured port when preparing a development build on a
host with an operator Gateway. Keep runtime publication guards intact. The report
records the candidate's exact Git SHA. Keep source and built artifacts consistent,
and do not edit a candidate during a campaign. No existing Gateway URL, remote
host, or live state directory can be supplied.

Runtime state and workspaces use the test helper's private temporary directory.
After verified process shutdown, the controller copies that synthetic evidence
into the output directory and removes its temporary state. This keeps an external
report volume's metadata latency out of the workload. The fixture exposes the
listed coding and session tools directly, with Code Mode and tool search disabled,
so mock and live campaigns use the same tool surface.

`report.json` retains accepted/uncertain sends, events, restart exit outcomes,
input receipts, projected transcripts, provider metadata, effect markers, and
individual invariant verdicts. `summary.md` summarizes all nine invariants;
`gateway.log`, `isolated-state/`, and `workspaces/` retain synthetic failure evidence.
Reports remain local: inspect and sanitize before sharing. Failed setup is a
harness failure, never a product verdict. Missing evidence is reported as unknown;
consumed input alone never proves a delivered answer. Effect checks cover the
explicit append markers, not arbitrary tool effects. Events missed while the
socket is disconnected limit exact recovery/delivery attribution; durable answer
markers and receipts still identify stuck inputs and duplicate answers.
Idle-session transcript activity during reconnect also fails the recovery check;
silence across that disconnected interval remains unknown.
