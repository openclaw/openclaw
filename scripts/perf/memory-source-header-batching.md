# Memory source header publication

## Acceptance rule

Measure source header publication inside the existing memory index publication
owner. Synthetic sources contain one deterministic chunk each. Keep SQLite and
PostgreSQL results, replacement order, rollback, tombstones, and revision receipts
unchanged. This changes neither the schema nor the worker request protocol.

Before changing production code, reproduce the source-header UPSERT loop in the
boot/compaction phases of the frozen SQL workload v3.1.4 on current main, through
an isolated Gateway and its WebSocket client. Its observer records statements,
requests, and main-thread statements; profiles cover the Gateway and workers.
Never use operator data. Verify the frozen workload's hashes before running it.

The deterministic owner cases are one source and 100 distinct sources, plus a
repeated source whose final replacement must win. The acceptance target is one
source-header UPSERT for each case, bounded to at most 128 distinct headers per
statement. The one-source case must stay at one UPSERT. An existing publication
remains one worker request, with no added main-thread SQL. All other SQL families
must hold their counts. Preserve the outer transaction and its single revision
advance. Reject any result or ordering regression.

Compare baseline and candidate Gateway runs in alternating order. Use three
frozen workload pairs when host load and disk capacity allow; otherwise use the
campaign's one-pair/source-attribution rule and state that limitation. Keep cold
boot, compaction, and warm turns separate. Report statement/request/main medians
and ranges, per-operation deltas, and p95 where there are enough samples.

Timing requires the campaign timing lock and a one-minute load average below 24.
For any latency/CPU claim, use at least five alternating samples per head and
report median, p95, and spread separately for cold and warm flows. Stop on a 20%
regression in any user-facing cell. Without that qualification, report work
counts only; do not call fewer statements a measured latency improvement.

## Reproduction

The frozen Gateway workload is `sqlharness-v3.1.4/measure.py --repo <checkout>
--out <fresh-directory> --sha <exact-head> --repetitions 1`, using the campaign's
internal temporary root and proof slot. Inspect the `source.replace.group`
operation in its statement ledger and the warm-turn operation vectors. The
committed `scripts/bench-memory-search-sqlite.mjs` also exercises this exact
`MemorySourceIndexKernel.replaceGroup` boundary with deterministic sources.

The owner regression cases live in
`extensions/memory-core/src/memory/manager-source-index-kernel.test.ts`.
PostgreSQL publication coverage lives in
`extensions/memory-core/src/memory/manager-publication-batch.test-helpers.ts`.
These must assert stored/searchable results and committed rollback behavior as
well as the bounded source-header statement count.

## Expected change

The current group already batches chunk, recall, and provenance rows, but writes
each source header separately. Move those headers into the same bounded group
owner. A repeated `(path, source)` must be deduplicated before PostgreSQL
`ON CONFLICT`, retaining the last header. Keep source checks and chunk/vector
effects in their current order. No new cache, freshness probe, or admission
protocol is needed.

Results are pending. This preregistration makes no measured savings claim.
