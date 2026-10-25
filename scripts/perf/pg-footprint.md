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
