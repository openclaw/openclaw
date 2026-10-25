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
