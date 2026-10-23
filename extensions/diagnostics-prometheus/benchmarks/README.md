# Metric store allocation measurement

Run on an approved benchmark host using the deployment's Node version. For
render comparisons, use the same benchmark script and fixture on both source
revisions:

```sh
node --expose-gc --trace-gc-nvp --import ./scripts/tsx.mjs \
  extensions/diagnostics-prometheus/src/metric-store.benchmark.test-support.ts \
  --render-only \
  --shape extensions/diagnostics-prometheus/benchmarks/render-shape.json \
  --render-samples 200 --allocation-renders 100 \
  --phase-ms 60000 --start-at <future-epoch-ms> \
  --output /path/to/result.json > /path/to/result.gc.log 2>&1
```

The committed shape has 2,243 histogram label sets and 2,385 scalar label sets,
rendering 60,154 rows across 122 families. It preserves observed family counts
and histogram bucket bounds, with synthetic labels, help, and values. It omits
three exporter-generated drop-counter rows: recreating historical drops would
require additional live or reserved series and would change the measured shape.
It is an owner workload, not a traffic replay or a claim about actual scrape byte
lengths. Omitting `--shape` instead fills the current 16,384-entry exporter budget
with the existing mixed scalar/histogram saturation fixture.

The first phase measures 200 warm renders without allocation sampling. It reports
CPU per scrape, wall time, and scrape latency samples, median, p95, p99, and max.
The second phase measures 100 renders with V8 heap allocation sampling at a 4 KiB
interval, including objects collected by minor and major GC. Its CPU and GC
numbers are reported separately because the profiler adds overhead. Increase
`--render-samples` and `--allocation-renders` independently when more precision
is needed. Both phases have exactly one store render per operation, without
per-scrape equality assertions, UTF-8 conversion, or digest work in the timed
loop.

Add `--http --http-port <port>` to measure rendering through a real loopback Node
HTTP server after the owner phases, or use `--http-only --http-port <port>` to
run only the HTTP phases. Each paired side needs a distinct port in 40000–65535.
The server mirrors the authorized metrics GET response: render, set its content
type and byte length, and `res.end(body)`. The client runs in a child process so
its CPU and heap allocation do not enter the server measurements. It makes ten
warmup requests, then sequential requests with a keep-alive agent, consuming all
response bytes without concatenation. Each phase verifies one render per request
and the full received byte count. `prometheus.http` reports unprofiled server
CPU/GC for `--render-samples` requests; `prometheus.http-allocation` reports
profiled server CPU/GC and heap allocation for `--allocation-renders` requests.
Their `.client` results contain end-to-end request latency and sample counts.
The full `.prom` files remain the exact-byte output comparison. This exercises
the actual Node transport and store owner, not Gateway routing or authorization;
the service tests cover those handler contracts.

The benchmark-only `--flush-headers` flag calls `res.flushHeaders()` immediately
before `res.end(body)`, for comparing a service change that sends headers
separately. Enable it only on the side whose service implementation includes
that call, and record the selected flags in the comparison. It is not a
production configuration option. The JSON records `flushHeaders` so the
transport choice remains explicit alongside each result.

`sampledHeapBytesPerOperation` measures estimated V8 heap allocation, not Buffer
backing storage. `scrape.bytes` records the output size, while
`scrape.bufferByteLength` records a returned Buffer's backing allocation (zero
for string output). Post-GC heap, external-memory, and array-buffer deltas are
reported after population, warmup, measured rendering, and reset of the same
strongly reachable store. External and array-buffer accounting overlap; do not
sum them. These deltas describe retained memory, not cumulative external
allocation. Report output size and backing storage alongside heap allocation so
a move from strings to Buffers cannot masquerade as eliminating all allocation.

Every measured phase includes GC collection counts, total time, max pause, and
per-kind pause tails with their sample counts. On Node 26.12, `--trace-gc-nvp`
emits a JSON object after each `ms: GC:` prefix. Parse that JSON and sum its
`promoted` field only between matching `benchmarkPhase` start/end markers in the
combined log, then divide by operations. Forced collections, fixture generation,
and profiler startup/teardown are outside these markers. Keep unprofiled and
profiled promotion separate. The synchronous owner phases omit HTTP transport
copying; use the HTTP phases to include it. Neither mode measures Gateway
event-loop delay.

The JSON includes full scrape and small escaped/Unicode fixture digests.
`<output>.prom` holds the full fixture and `<output>.fixed.prom` holds the small
fixture. Compare exact bytes outside the measured phases:

```sh
cmp /path/to/baseline.json.prom /path/to/candidate.json.prom
cmp /path/to/baseline.json.fixed.prom /path/to/candidate.json.fixed.prom
```

Without `--render-only`, the existing warm observation and worker-request
allocation phases run first, followed by small-fixture rendering and the two
large-fixture render phases. `--iterations` controls observations (default
100,000). All phases start 60 seconds apart by default. Both sides of a pair must
use the same future `--start-at`, phase spacing, fixture, Node version, and
operation counts. A missed start fails the run; enlarge the spacing for larger
workloads.

## Comparison and acceptance

Record the acceptance rule before running. For a render optimization: require
byte-identical output and lower sampled heap allocation per scrape, aiming for
an 80% reduction, while reporting backing-buffer bytes and retained memory.
Compare CPU per scrape, total GC time per scrape, and promotion per scrape on the
same work. A 20% adverse mean of swapped pairs, or 10% adverse in both pairs, is
a stop. Never compare profiler-on CPU with profiler-off CPU.

Use at least five interleaved baseline/candidate runs; six gives equal counts
for both placements. On a shared host, use its exclusive measurement slot and
production guard, run both sides concurrently on distinct interleaved physical
cores, and swap placement in the next pair. Decide on the mean of the paired
deltas. Follow the host's current guard thresholds without adding stricter
thresholds. Discard and rerun interrupted pairs.

A p95 may gate only with at least 200 samples per side, and p99 with at least
1,000; smaller samples are context. Major GC is context below 50 collections per
side; total GC time remains relevant. When collection counts fall by at least
20% and total GC time does not rise, per-collection GC p95/p99 are context, unless
the candidate's maximum single pause exceeds the larger of 50 ms and twice the
baseline maximum. Always report both maximum pauses. Flat or rising collection
counts leave an adequately sampled per-pause p95 eligible to gate.

When paired baselines differ by more than 5x, or paired deltas have opposite
signs, report absolute and relative deltas and label that metric inconclusive.
If it gates the decision, run a third pair and decide on the absolute mean; do
not reject on a relative mean dominated by a tiny baseline. Whole-Gateway
confirmation must additionally compare matching work/reset counts and properly
sampled event-loop delay under the same host rules.
