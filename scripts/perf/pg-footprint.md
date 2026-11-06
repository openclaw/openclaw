# PostgreSQL transport footprint

This synthetic workload uses twenty agents, forty sessions per agent and 912
transcript events per agent. It starts a real isolated Gateway, reads history
over WebSocket once per agent, waits beyond the three-minute idle-bridge expiry,
and repeats the reads. No model or external channel credentials are used.

## Acceptance rule (written before measurement)

Count worker launches, live workers, PG bridges, database connections, SQL
statements and worker requests, by owning worker and phase. Report process RSS
once per process; isolate heap/external memory may be grouped by owner, but RSS
must never be summed across workers. PostgreSQL server connections and process
memory are separate from Gateway memory. Sample native resource child processes
as well as the Gateway; process/thread identity must include both PID and thread
ID. Cold startup and post-idle first
requests stay separate from warm requests.

For a candidate, run five interleaved baseline/candidate pairs under the campaign
timing lock and load below 24. Report median, p95 and range for readiness,
per-agent first-request latency, whole-process/thread CPU and idle RSS. Primary
win: fewer bridge launches and lower idle Gateway RSS. Every user-facing metric
must hold or improve; any 20% adverse cell stops acceptance. Never classify
relocated work as removed work. If quiet-host admission takes over an hour,
report counts and CPU profiles only, explicitly leaving timing unqualified.

The initial attribution run has no candidate and makes no speedup claim. Capture
one unprofiled baseline for counts/memory, then a separate per-thread CPU profile.
The profile pass omits duplicate memory snapshots and validates its per-thread
profile coverage after shutdown; its sampled timing never replaces the baseline.
The frozen SQL observer stays byte-identical. PG bridge instrumentation is
supplemental because the frozen observer observes native SQLite, not PG wire
queries. Match before/after data shapes, transaction ordering and failures through
the existing PG conformance runner before accepting a transport change.

Production edits require the coordinator's explicit design approval. Pooling
workers does not authorize pooling transactional sessions: each logical
connection must retain its own search path, active transaction, error outcome,
publication anchor and disposal. No schema, permission or durability change is
part of this work.

The default `--pool-topology fixed-four` asserts the physical topology in counts
and profile runs: the Gateway and each PG-using native process own exactly four
I/O service launches. The declared native children are schema inspection and the
native resource broker; an unused child may own zero. Every service must be
created by its process main thread using the private pool envelope. Any worker
thread self-root or undeclared process through shutdown fails the fixture. This is an ownership
assertion, not a ceiling inferred from candidate measurements. Use the explicit
`--pool-topology legacy` only for the pinned pre-pool baseline.

Observer-free RSS runs load no observer or supplemental instrumentation. Their
controller requires a completed fixed-four count assertion on the same candidate
head and workload before collecting RSS, and samples all process descendants
externally. Physical worker launches are proved by the counts run; they are not
inferred from RSS or OS thread counts.

## Controlled topology diagnostics

`pg-footprint-topology.mjs` uses an owned local synthetic PostgreSQL server from
`PGFOOTPRINT_DSN`, without observers or production changes. Run it with Node and
`NODE_OPTIONS` unset. It varies independent clients per I/O worker through direct
MessagePorts. It reports process RSS once, worker heaps separately, total/main CPU,
query/transport counts and per-client latency samples. It returns real synthetic
rows so the large-result cell includes cloning. It is a diagnostic transport,
not a candidate implementation or replacement for Gateway20/C64 acceptance.

For marginal memory, use fresh processes with `--mode rss --clients 20` and
`--workers 20`, `4`, `1`, then hold `--workers 1` and vary `--clients 1`, `4`, `20`.
Keep the ten-second idle interval and five consecutive RSS observations; five
observations of one process are not independent trials. Use five alternating
pairs for any comparative claim, report median/p95/range across processes, and
separate worker-count effects from client-count effects. The expected diagnostic
win is lower RSS at fixed clients with fewer workers; no value is assumed.

For interference, compare `--mode interference --clients 4 --workers 4` against
`--workers 1`, separately for `--kind slow` and `--kind large`. Client zero issues
repeated 200-ms sleeps or 8-MiB synthetic results; other clients issue small
queries concurrently for five seconds. Report each client's p50/p95/p99 and
spread, background progress, total/main CPU, errors and connection count. Any
adverse user-facing cell stops acceptance; a 20% adverse cell is a mandatory
stop. A shared parser is allowed to fail this diagnostic: return the result for
design review instead of adding an unbounded worker escape path.

Also compare twenty independent workers/clients with four workers/twenty clients
and `--background-clients 4`: the first four clients load all four shared
services while the remaining sixteen issue foreground queries. Keep slow and
large-result cells separate. Client IDs and worker assignments accompany each
latency series. Sample the reported PID externally with `ps -o rss=` when the
JSON `idle` event arrives; record five observations 200 ms apart alongside the
in-process observations. This external sampling uses no observer preload.
Use `--external-rss` for this controller: after the five external observations,
write a byte to its stdin to release the idle workers for teardown. This keeps
the last external observation from racing process exit.

These comparative wall/CPU runs require the campaign timing lock and load below 24. Register the exact committed workload head and cells in the PR before the
first run. Keep PG HOME/TMPDIR/data internal, output under owned internal scratch,
and delete fixtures and dependency caches before the design-review wait.
