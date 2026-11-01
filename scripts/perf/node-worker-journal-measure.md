# Node turn recovery measurement

Acceptance rule, registered before the first run: prepare twenty synthetic physical
launches with running turns, then emulate an offline predecessor ending only the
physical launches (five each completed, failed, interrupted and cancelled). Start
an isolated Gateway on the head under test and read these receipts through the
production journal worker's real message transport. Repeat the twenty reads warm.
No operator state, external providers or worker processes are used.

Count every native statement and worker request with frozen sqlharness v3.1.4.
Separate startup, recovery, warm and shutdown. Recovery must remove exactly one
turn SELECT per receipt; warm statements, requests and MAIN SQL must not increase.
All returned states, error/result fields and monotonic timestamps must be correct.
The focused owner regression also preserves previously completed turns and proves
the selected postimage agrees with subsequent durable reads.

Use three alternating baseline/candidate pairs when load is below 64 and internal
free space is at least 12 GiB; otherwise use one pair and operation attribution.
Report statement/request/MAIN median, range and per-operation deltas. Timing, if
attempted, requires the campaign timing lock and load below 24, five samples per
arm, separate cold/warm medians/p95/spread, and no adverse cell of 20% or more.
Otherwise report counts and per-thread CPU profile attribution without a latency
or CPU-time saving claim.

Run `scripts/perf/node-worker-journal-measure.ts --root <owned-root> --prepare`
through the repository TypeScript runtime, then run the same script without
`--prepare` with the frozen observer in NODE_OPTIONS and SQLMEASURE_OUT pointing
at a fresh internal directory containing a `phase` file. Keep TMPDIR and Bun/Vitest
caches on the internal disk. Node `--cpu-prof` and the existing
`scripts/lib/gateway-bench-cpu-profile.mjs` cover Gateway and worker threads.

This workload reaches the journal through its worker transport while the Gateway
owns the database. It does not claim an end-to-end remote node WebSocket command
or model-turn latency result; those transports do not own the SQL being changed.

## Launch claim postimages

Use `--flow launch` on both preparation and measurement invocations. Preparation
creates twenty synthetic pending launches with an absent predecessor PID. Under
an isolated Gateway, measurement creates twenty more launches, reclaims the
predecessor's twenty pending launches through the production process observation
and journal worker transport, then replays all forty claims warm. No process is
spawned or killed. The same frozen observer and per-thread profiles apply.

Acceptance rule, registered before running this flow: each successful create and
pending reclaim removes exactly one exact-entry launch SELECT; worker requests,
all other target statements, and runtime MAIN SQL must not increase. Warm replay
must retain its current counts. Returned action, supervisor, pending state,
monotonic timestamp and durable receipt must match. Preserve capacity, pruning,
plan mismatch, stale observations, conditional zero-row outcomes, and optional
companion metadata. These remain transactional decisions, not retained state.

Keep startup, create, reclaim, warm and shutdown separate. Use the sample/host and
timing rules above, and report raw cells plus per-operation attribution. Any 20%
adverse cell is a stop for explicit disposition. This workload establishes the
journal owner cost, not remote node WebSocket or model-turn latency.
