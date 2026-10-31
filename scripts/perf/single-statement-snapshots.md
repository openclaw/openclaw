# Single-statement read snapshots

An explicit read transaction is unnecessary when its complete callback consumes
one SELECT and never carries a snapshot into another read. Keep snapshots around
multiple statements, paged reads, asynchronous streaming, imported PostgreSQL
snapshots, advisory locks, and transaction-local settings.

## Acceptance rule, registered before measurement

Inspect the whole callback, including conditional paths and iterator consumption.
For each qualifying operation, reproduce BEGIN, one SELECT, COMMIT with the frozen
SQL observer before editing production code. After removal, require the same
result and one SELECT, with no replacement SQL or extra worker request. Count
both total work and Gateway main-thread work; main-thread SQL must not increase.
An operation without a reproduced envelope is not a measured saving.

The candidate flows are transcript projection-status reads through `chat.history`
and Team Reports week/month aggregation.
Preserve owner admission, cancellation, committed-write visibility, report
ordering and date bounds. This change must
not alter schema, durability, write transactions, or cross-store commit ordering.

Use the existing projection workload with a new synthetic output directory:

```sh
node --import ./scripts/tsx.mjs scripts/bench-session-projection-ready.mts \
  --out <new-output> --observer <frozen-observer.cjs> --counts-only \
  --sessions 6 --messages 100 --payload-bytes 256 --target-index 0 \
  --warm-samples 5 --cpu-profile
```

Run the Team Reports workload through a real Gateway with one synthetic commit,
summaries and automatic scheduling disabled, and week/month rollups enabled:

```sh
node --import ./scripts/tsx.mjs scripts/bench-team-reports-snapshots.mts \
  --out <new-output> --observer <frozen-observer.cjs> --samples 5 \
  --settle-ms 2000 --cpu-profile
```

Run real owner regressions for committed-write visibility. Report entry-point
gaps explicitly. Managed-update handoff and nested auth snapshots remain: their
actual PostgreSQL callers already hold an outer transaction, so removing the
inner wrapper saves no statements. Reuse the
frozen standard Gateway workload for whole-SQL and warmed-turn non-regression.
Keep cold startup, cold requests, warm requests, and background work separate.
Compare statement/request/main-thread medians and ranges for three alternating
baseline/candidate pairs when host capacity permits; use one pair on a loaded
host and make no wall-clock improvement claim.

Counts and per-thread CPU profiles precede any timing comparison. Timing runs
require the campaign timing lock and one-minute load below 24. Use at least five
interleaved samples per head on the same platform, reporting median, p95 and
range separately for cold and warm phases. Every user-facing metric must hold or
improve; a 20% regression in any cell stops the change. If timing admission is
unavailable for 60 minutes, report count/profile evidence without a latency claim.
