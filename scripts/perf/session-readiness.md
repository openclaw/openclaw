# Session readiness workloads

These workloads use fresh synthetic state and real Gateway transports. They must
not read an operator's configuration, sessions, or logs. The frozen SQL observer
is supplied by the caller; it is not modified by either workload.

## Acceptance, registered before measurement

The projection workload seeds ordinary durable sessions with an unreconciled
transcript projection, launches the exact-head Gateway, and requests history over
WebSocket while the background owner is reconciling. Count projection-status
worker requests per history request and all SQL/requests on both the main thread
and workers. A qualifying reproduction requires an actual repeated status read;
zero observed polling is a rejected target for this workload, not a speedup.

The cost workload sends concurrent `/usage cost` commands for distinct synthetic
sessions through the bundled iMessage adapter and a loopback bridge. Count busy
refresh attempts, filesystem identity work, SQL, and worker requests. Busy
admission currently precedes worker dispatch, so a successful optimization may
remove preparation work without reducing SQL or worker requests. Every command
must still include the requested session's fresh detail.

For a reproduced target, the candidate must remove repeated waiting work while
preserving early per-session readiness, cancellation, error behavior, and fresh
detail. The projection goal is at most one initial status read per waiter; the
cost goal is one preparation followed by owner completion, without timed retries.
No new schema, generation, cache, or cross-store transaction is allowed.

Counts and CPU profiles are collected before any latency comparison. Cold startup
and warm requests are reported separately. A latency comparison uses at least
five interleaved baseline/candidate samples each, reporting median, p95, and range;
all user-facing metrics must hold or improve and a 20% regression stops landing.
Timing runs hold the campaign timing lock and start below load 24. If that cannot
be achieved within 60 minutes, report counts and profile evidence without a
wall-clock or latency improvement claim. The shared frozen workload supplies the
warm non-regression comparison under the campaign's host-capacity policy.
