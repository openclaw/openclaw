# PostgreSQL conformance harness cost

## Acceptance rule

The workload is the existing PostgreSQL conformance runner against an isolated
PostgreSQL 17 server with `unaccent`, `pg_trgm`, and `vector`, `CI=1`, and synthetic
fixtures. Preserve every case and assertion unless a duplicate is demonstrated;
preserve independent mutable schemas, planner fixture sizes, and pool lifecycle
contracts. Do not change the shard inventory or add CI jobs.

Before changing tests, rank the sum of printed case durations from the three
newest successful PR CI runs whose three PostgreSQL shards executed. Profile the
top ten files with the existing Node/V8 runner profiler. A fenced file is inspected
and profiled only; it remains unmodified. Diagnostic Node profiles identify work,
not pinned-Bun timing gains.

Count fixture creation, migration, snapshot, subprocess, and worker operations
before comparing elapsed time. For every changed file, run five alternating
baseline/candidate pairs on the same host using the pinned Bun runner. This also
satisfies the minimum three-pair per-file check. Keep cold preparation separate
from warm runs. Report all samples, median, p95, and range for wall time, process
CPU, and peak RSS; report case counts and setup operations alongside them.

A win requires fewer unnecessary setup operations, identical contract coverage,
and lower median test-file cost without a regression in any measured cell. A
20% adverse change in any cell stops acceptance. No runtime main-thread work may
increase. Only claim wall-time gains while holding the campaign timing lock with
one-minute host load below 24. After 60 minutes waiting for that condition, report
counts and CPU-profile evidence and label wall-time gains unmeasured.

Final proof includes the PR's own three successful PostgreSQL shards, their
durations compared with the recorded baseline runs, required static gates, two
isolated Codex reviews, and PostgreSQL owner review of the exact head. Shard durations
are contextual CI observations, not controlled cross-host measurements.

## Commands

Use the existing `scripts/test-database-conformance.mjs --engine postgres
--connection <synthetic-local-dsn> -- <file> --maxWorkers=1` for behavior and timing.
Use `scripts/run-vitest-profile.mts runner --output-dir <internal-output> --
--config test/vitest/vitest.infra.config.ts <file> --maxWorkers=1` for diagnostic
Node CPU profiles, with the existing database-conformance preload and a separate
`node --cpu-prof` capture for the coordinator process. Resolve each file's existing
Vitest configuration rather than moving it to another suite.

Keep Node at the campaign version, `NODE_DISABLE_COMPILE_CACHE=1`, and `HOME`,
`TMPDIR`, Bun's transpiler cache, and the Vitest filesystem cache in the test's
internal scratch directory. CPU-heavy runs use the campaign proof semaphore.

## Baseline provenance

Initial source: `6f8748ad889`.
Successful PR CI runs: `40256840043`, `40256709284`, `40256387656`.
Profiles and raw synthetic measurements are local scratch; publish only
operation counts, durations, and source attribution.

### November 2 follow-up

Source: `e2e3e4765ed3234099bc7cf5364cfbf59146e26c`.
The three newest successful PR runs with all three PostgreSQL shards executed,
at collection time, were `41429015158`, `41419559501`, and `41417862250`.
Ranked by summed printed case duration across those runs, the top ten files are:

1. `port-command.integration.test.ts`
2. `doctor-migration.postgres.test.ts`
3. `matrix-roots.postgres.test.ts` (fenced: profile only)
4. `startup-client-credentials.postgres.test.ts`
5. `port-command.recovery.integration.test.ts`
6. `interactive-setup.integration.test.ts`
7. `port-command.mixed.integration.test.ts`
8. `update-preflight.conformance.test.ts`
9. `port-command.credentials.integration.test.ts`
10. `client-credential-update.test.ts`

Use the acceptance rule above for this follow-up. Printed case durations rank
diagnostic work; they do not establish elapsed time or savings.
