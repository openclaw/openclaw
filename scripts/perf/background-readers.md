# Background reader workload

Acceptance registered before the first measurement for the small background
reader lane. Only synthetic state and loopback transports are permitted.

Run the committed `scripts/perf/idle-gateway-measure.ts` with one connected client,
60 seconds of boot settling, then two steady minutes. Separately run
`scripts/perf/plugin-state-polling.mts` with `--messages 0 --seconds 125` against its
synthetic Reef relay. Use the frozen SQL observer v3.1.4 and a fresh fixture per run.
Profile the real Gateway and its worker threads with `--cpu-profile-dir` (idle)
or `--profile` (Reef); profiles provide attribution, not a timing claim.

Count SQL statements, worker requests and main-thread statements by phase and
operation, including transaction envelopes. Report per-minute steady rates;
startup, shutdown and warm traffic stay separate. A target that does not reproduce
on current main is rejected for this lane, with counts and the setup gap recorded.

A candidate wins only when its owner-attributed statements or requests decrease,
main-thread work does not increase, and freshness after an owning write, supported
external writes, TTL expiry and restart remain correct. Keep multi-statement
snapshots and effect-time authority. Preserve the WAL checkpoint cadence unless
its redundancy is demonstrated. No schema change is authorized.

For Reef empty delivery recovery, each operation must use one autocommit namespace
read instead of four statements. Populated recovery must reread deliveries and
peers inside its normal snapshot (five statements including the initial probe).
The existing watched namespaces and receipt invalidation must remain unchanged.
Deliveries arriving just after an empty read may wait until the next reconciliation.

For SQL counts use three alternating baseline/candidate pairs when load is below
64 and internal free space is at least 12 GiB; otherwise use one pair and attribute
every operation delta. No latency or CPU improvement is claimed from these counts.
If wall-clock or CPU A/B timing is needed, first take the campaign timing lock and
wait for one-minute load below 24; collect at least five alternating samples per
head, separate cold/warm, and report median, p95 and spread. A 20% regression in any
user-facing metric stops acceptance.
