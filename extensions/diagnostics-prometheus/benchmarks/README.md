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

`render-shape-2026-10-23.json` is a second observed shape with 1,462 histogram
and 1,520 scalar label sets, producing 38,779 rows across 112 families. As with
the original shape, all label values and metric values are synthetic.

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
type and byte length, and `res.end(body)`. Buffer responses alone use a completion
callback to release their private backing store after a successful write. The
baseline string path has no callback retaining its body. Failed writes leave
reclamation to GC. Static metric prefixes never share response backing storage. The client runs in a child process so
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
profiled promotion separate. The synchronous owner phases omit HTTP transport; use the HTTP phases to
include it. Neither mode measures Gateway
event-loop delay.

The store encodes fixed prefixes into private 4 KiB chunks. Oversized prefixes
own separate allocations, so clearing them cannot leave a large chunk held by
the prefix allocator cursor.
Each series lazily retains its rendered bytes; removing gauges or resetting the
store releases their blocks. Changed series use a growing scratch buffer and refill
their block when its length is unchanged, otherwise replacing it with an exact-size
block. Every scrape copies the blocks into a fresh response buffer.
Family HELP/TYPE bytes share the exporter-owned prefix chunks. One header per
metric name is reused while its winning series' help and type stay unchanged;
clearing gauges evicts that family's header, and reset clears all headers.
Report the additional retained blocks alongside allocation savings.
`scrape.bufferByteLength` records the transient response allocation; it is not
included in sampled V8 heap allocation. After consuming a render in an owner phase,
the benchmark releases its private backing store, matching the successful HTTP
completion lifetime. Owner CPU includes release; the render-latency timer ends
before release. The HTTP phase releases only after Node's completion callback.
The scratch buffer retains only bytes, never pooled Buffer slabs or response
storage; reset releases its capacity and the current prefix chunk. The 1 ms event-loop monitor reports sample counts and tails for each phase;
synchronous owner loops normally have no samples.

Use `--updates-per-render <count>` with `--shape` to rotate through that many
existing series before each measured render and each HTTP request. Histogram
observations increment count/sum/buckets; counters increase and gauges change.
The synthetic event inputs are prepared before the store-retention baseline.
CPU and allocation include updates; the owner render-latency timer excludes
them. Both sides must use the same count. Updated HTTP bodies have variable
lengths, so compare aggregate received bytes and the final `.final.prom` files
between sides, as well as initial and escaped fixtures. This workload measures
invalidation cost; it does not claim to replay a production event distribution.

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
counts leave an adequately sampled per-pause p95 eligible to gate. Per-collection
p95/p99 changes with an absolute paired-mean delta below 1 ms are context only;
total GC time, promotion, and event-loop p99 retain their gates.

When paired baselines differ by more than 5x, or paired deltas have opposite
signs, report absolute and relative deltas and label that metric inconclusive.
If it gates the decision, run a third pair and decide on the absolute mean; do
not reject on a relative mean dominated by a tiny baseline. Whole-Gateway
confirmation must additionally compare matching work/reset counts and properly
sampled event-loop delay under the same host rules.

## Prefix backing-store retention

Add `--pool-churn` to interleave a disposable 8 KiB `Buffer.from`
allocation between new series. This models series accumulating between unrelated
Buffer traffic; compare post-GC `retained.populated` and `retained.warmed`, then
`retained.afterReset`. It changes fixture construction only, not the timed render
loops. Run at full capacity (omit `--shape`) and with the same observed shape on
both sides. Report heap and ArrayBuffer deltas separately, since moving bytes
between them is not a total-memory saving.

For a separate synthetic retention-only pass, use `--render-only` with
`--heap-snapshot <path>`.
This captures the live store after warmup and skips the large measured render
phases; do not compare its CPU with ordinary runs or combine it with HTTP.
Count `ArrayBuffer` objects and native `system / JSArrayBufferData` backing
stores in the snapshot. Use the runtime's actual pool allocation size rather
than assuming 8 KiB: Node 26.12.1 reports `Buffer.poolSize = 65536` and a
65,600-byte backing allocation for small pooled buffers.
