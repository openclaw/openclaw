# Transcript plans with partial statistics

`transcript-plan-stats.ts` executes the real transcript owners and captures their
bound native SQL. It then explains every captured statement with no statistics,
full `ANALYZE`, and partial `sqlite_stat1` rows. The partial fixture omits
`transcript_events` and cold-archive statistics. Both the no-statistics and partial
cases clear `sqlite_stat4` when the local SQLite build supports it; retained
histograms otherwise change the result.

The fixture uses the current agent schema, a 20,000-event ordinary session, and a
20,000-event session with dense compaction markers. It includes reset windows, a
prompt-update carrier, and a committed idempotency key. Everything is synthetic;
no live database is opened. No schema or index changes are proposed.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-plan-stats.ts --mode plans
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-plan-stats.ts \
  --mode timing --request visible-tail --iterations 2000
node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-plan-stats.ts \
  --mode allocation --request visible-tail --iterations 2000
```

For a baseline, save the changed source files at their original repository paths
under another directory and pass `--baseline-dir <directory>`. The existing
baseline loader substitutes those modules without another checkout or install.
Run timing and allocation separately, alternate arm order, and compare response
digests. Timing output includes thread CPU, elapsed time, GC collections, process
memory, and host load. Allocation sampling includes collected objects; it does
not measure SQLite's native allocations. Fixture construction, warmup, and cleanup
are outside the measured interval. Output reports are JSON lines; lifecycle
cleanup may also log a clean-close receipt.

## Query sweep

The conclusions below refer to the partial-statistics case. Plan output also
records the no-statistics and fully analyzed controls for every statement.

| Owner / query                                                  | Verdict                                                                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqlite-active-context`: bounded metadata tail                 | Active-position traversal, facts lookup, exact payload fallback; unchanged.                                                                                                                     |
| `sqlite-active-context`: latest boundary with window count     | Fixed: partial statistics could drive the outer join from every session event. The one-row boundary now drives an exact payload probe. Counting and sorting boundary metadata remains required. |
| `sqlite-active-context`: dependency discovery                  | Active metadata scan and exact fallback payload reads; existing facts owner retained.                                                                                                           |
| `sqlite-active-events-read`: recent active tail                | Fixed: partial statistics selected a session-wide payload scan and sort. The active position now drives bounded payload probes.                                                                 |
| `sqlite-closed-reset-interval`: preceding/following reset      | Uses active positions or reset-type identities; any sort is over reset candidates, not all payloads. Unchanged.                                                                                 |
| `sqlite-history-interval`: count and older/newer page          | Active interval drives identities and exact payload probes; unchanged. An apparent regression with leftover STAT4 was discarded.                                                                |
| `sqlite-projection-read`: latest reset                         | Reset-type index and exact active lookup; unchanged. Latest/first physical sequence subqueries remain index probes.                                                                             |
| `sqlite-reset-window`: latest boundary by type                 | Type/sequence index followed by active lookup; unchanged.                                                                                                                                       |
| `sqlite-suffix-read`: previous indexed event                   | Fixed: select the maximum eligible active position using metadata, then read one payload. Eligible metadata still needs traversal; no payload sort or session-wide payload read remains.        |
| `sqlite-transcript-metadata-read`: latest assistant            | Message-type/sequence index drives exact payload reads; unchanged.                                                                                                                              |
| `sqlite-transcript-parent`: visible append tail                | Fixed through the shared active-event query owner: one reverse active-position probe and one payload lookup.                                                                                    |
| `sqlite-transcript-suffix-idempotency`: replacement candidates | Residual: required prefix payload inspection, grouping, and ordering. An unindexed embedded idempotency key prevents a bounded metadata-only replacement; unchanged.                            |
| `sqlite-transcript-suffix`: unowned prefix                     | Residual: full eligible-prefix payload inspection remains necessary to recover idempotency owners; partial statistics add sorting. Unchanged.                                                   |
| `session-cache-ttl-prefix`                                     | Type-first marker selection and exact active/payload probes; sorts selected markers and small JSON projections. Unchanged.                                                                      |
| `session-pending-input-history.kernel`                         | Inner page has a limit before windowing/hydration; final sort is bounded to that page. Unchanged.                                                                                               |
| `session-pending-input-source.kernel`: both committed probes   | Unique idempotency-key lookup followed by exact payload lookup; unchanged.                                                                                                                      |
| `session-transcript-index`: reconcile candidates               | Session-window scan, one latest-sequence probe per session; unchanged.                                                                                                                          |
| `session-transcript-replay.kernel`: operator boundary          | Residual: navigation predicates plus a raw-sequence bound can select a range-and-sort plan. Forcing active/event join order alone did not remove it; unchanged.                                 |

The predecessor reader compiles SQL once through the existing connection-owned
query cache and binds fresh session/sequence inputs for every execution. It
retains no rows or results; native statement lifecycle remains with the executor.

These owner measurements establish query work and result equivalence, not
whole-Gateway CPU, allocation, or latency. They do not simulate cold production
payload overflow chains.

## Hydration follow-up

Use `--request active-context` for the bounded hydration owner. Baseline overlays
include `session-accessor.sqlite-active-context.ts` in the source fingerprint.
The plan regression covers ordinary and dense 20,000-event sessions and keeps
the exact boundary count while requiring a `(session_id, seq)` payload lookup.

The reported statement `fb325b6f86f6a35b` maps to
`readCacheTtlProjectionPrefix` in `session-cache-ttl-prefix.ts`, not the fixed
boundary query. Its existing type-first cross joins and marker sort are stable
under all three statistics states. Marker count, trailing-column access, and
legacy JSON fallback remain costs; this change does not alter that reader.

The context-snapshot model, full-message, and seed readers retain ordered sequence
range scans and exact payload probes. Maintenance version, identity, previous,
suffix, custom-branch, code-mode-store (full and incremental), and nested-activity
reads retain their indexed plans. Full context navigation and full maintenance
navigation still traverse history when their owners require it. JSON-member sorts
are per-record work, not session-wide ordering regressions.
