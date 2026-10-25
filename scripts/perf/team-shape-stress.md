# Team-shaped Gateway stress

Run one fixed workload against two **already-built** revisions from this tooling
checkout. All state, logs, profiles, and results go under a new output directory.
The controller creates its own loopback listeners on free ports >=40000. It never
connects to an existing Gateway, discovers credentials, or drives a real browser.

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
  --base /path/to/base --candidate /path/to/candidate \
  --output "$PWD/.local/team-stress-comparison" \
  --minutes 10 --pairs 2
```

Defaults are 10,800 deterministic sessions, 65 permanent operator WebSocket
clients (plus brief reconnect probes), four concurrent mock-provider turns per
round, and 40 enabled plugins: 37 synthetic startup plugins plus bundled `acpx`,
`codex`, and `diagnostics-prometheus`. The provider streams text and executes real
local tool calls and native subagent turns; no external model service is used.
Synthetic plugin registrations exercise catalog size, not the runtime behavior of
37 real integrations. The bundled Codex/ACP plugins are present; their external
backends are not invoked.

The seeded mix is 4,300 finished unarchived subagents, 4,400 archived dashboards,
400 active dashboards, 200 explicit sessions, and 1,500 other sessions including
small channel/cron cohorts. Four agents are configured; retained rows initially
belong to `main`. Transcripts contain 128 MiB of deterministic, incompressible
message content with a skewed size distribution. This reproduces session shape,
not a byte-for-byte copy of a production database. Four projects, disabled cron
entries, user profiles, participants, approvals, and delivered run records use
the existing offline fixture writers.

Clients subscribe to sidebar and transcript events while polling list/search,
history, startup, diff, and reconnect paths. An independent writer commits
`chat.inject` timestamp updates and a scraper reads the isolated Gateway's
Prometheus endpoint. The same mock turns and RPC schedule run in each pass.
`--poll-ms 7000`, `--round-ms 15000`, `--churn-ms 1000`, `--runs 4`, and
`--clients 65` tune offered load; compare **achieved** RPC/turn rates too.

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
