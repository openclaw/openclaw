# Team-shaped Gateway stress

Run one fixed workload against two **already-built** revisions from this tooling
checkout. All state, logs, profiles, and results go under a new output directory.
The controller creates its own loopback listeners on free ports >=40000. It never
connects to an existing Gateway, discovers credentials, or drives a real browser.
Both builds must support the database schemas written by the tooling checkout's
fixture generator. A schema mismatch is a setup failure; the harness never
downstamps databases or bypasses Gateway schema admission.
The Gateway's instrumentation loader disables tsconfig aliases, so runtime
package imports resolve through each build's own package exports. Keep each
checkout's source, workspace package artifacts, and `dist` build consistent;
rebasing source invalidates previously built artifacts.

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --base /path/to/base --candidate /path/to/candidate \
  --output "$PWD/.local/team-stress-comparison" \
  --minutes 10 --pairs 2
```

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
small channel/cron cohorts. Four agents are configured; retained rows initially
belong to `main`. Transcripts contain 128 MiB of deterministic, incompressible
message content with a skewed size distribution. This reproduces session shape,
not a byte-for-byte copy of a production database. Four projects, disabled cron
entries, user profiles, participants, approvals, and delivered run records use
the existing offline fixture writers.

The campaign captures one clock anchor and reuses it across all fixtures. Pass
`--now <epoch-ms>` from `campaign.json` to replay that anchor with the same seed.
Active dashboard timestamps stay within the normal seven-day archive threshold;
the fixture raises the existing session-count capacity to twice the seeded count.
Normal maintenance remains enabled in both passes.

Before stress rounds, completed mock turns and closed provider streams establish
readiness; unrelated background sidebar publications need not become quiet.
After each workload, subscriber events still drain before fanout counters settle.

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
