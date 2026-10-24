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

## Deterministic owner results

The corrected SQLite owner suite passes all 33 tests on the candidate. The same
count assertions fail on the baseline for 100 and 129 sources, while one source
passes. Other chunk, recall, and provenance insert counts stay unchanged.

| Distinct sources | Baseline header UPSERTs | Candidate header UPSERTs |
| ---------------- | ----------------------- | ------------------------ |
| 1                | 1                       | 1                        |
| 100              | 100                     | 1                        |
| 129              | 129                     | 2                        |

The large UTF-8 empty-source case emits two statements instead of three and
preserves the final repeated header. These are deterministic operation counts,
not latency samples. An initial enlarged fixture exceeded the schema's maximum
importance value; those failures were discarded and the corrected fixture was
rerun on both baseline and candidate.

## Baseline attribution

The shared s45 synthetic Gateway run at `3f7b7765585` completed successfully and
recorded three source-header UPSERTs in one `source.replace.group` worker request
in `07.idle-settle`. The kernel, worker, PostgreSQL publication adapter, and
transfer module are byte-identical at this lane's production base `90d9772045f`.
The earlier s44 run independently records the same three-statement pattern.

The current-head baseline build was canceled before starting while six jobs
were queued ahead and the one-minute host load exceeded 80. Use the campaign's
source-attribution exception for that evidence; it is not a fresh-head runtime
or latency measurement. Frozen causal labels use a retired diagnostic source,
so only observed execution phase/request identity is used for this attribution.

Header batches hold at most 128 distinct keys and 64 KiB of estimated UTF-8
payload. A single larger header retains the existing supported single-row write.
The estimate includes path/hash UTF-8 bytes and fixed room for source/numbers.
A repeated key replaces its pending header; committed chunks and metadata still
follow the original per-source ordering inside the existing transaction.
