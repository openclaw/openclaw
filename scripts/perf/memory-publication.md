# Memory publication SQL

## Acceptance rule

Reproduce memory publication on an isolated Gateway with synthetic data using
the frozen SQL workload v3.1.5. Inspect `schema.admit`, `database.publish`, and
`cache.prune` in the post-compaction tail. Record statements, requests, and MAIN
statements separately, plus the unchanged warm-turn operations. No operator data
or live Gateway is used.

The focused workload is `node --import ./scripts/tsx.mjs
scripts/bench-memory-publication.mjs`. Set `MEMORY_PUBLICATION_OUT` to a fresh
directory and preload the frozen observer with `NODE_OPTIONS`. It exercises the
real publication backend with an existing target, a fresh shadow, full index
publication, and a mandatory cache recount. Its phase file isolates each action.
It is owner-level attribution, not a substitute for the Gateway workload.

The acceptance target for pruning is one exact COUNT inside its existing write
transaction, rather than a preliminary COUNT followed by that exact recount.
Retain the final cache cap, bounded eviction, rollback, failed-settlement
invalidation, and scoped write-token ownership. PostgreSQL retains its existing
advisory lock and multiwriter rules. Schema observations may be removed only if
the same operation already prepared an equivalent fact; real DDL, migration,
repair, revision-conflict detection, and fresh-shadow creation remain intact.

Run baseline/candidate in alternating order: three Gateway pairs on a qualified
host, otherwise one pair or explicitly identified source-attribution evidence.
Report count medians and min/max ranges; warm and cold phases stay separate.
Requests and MAIN must not increase. Count the whole process and workers.

Any timing claim requires the campaign timing lock, one-minute load below 24,
and at least five alternating samples per head, with median, p95, and spread.
A 20% regression in any user-facing cell stops the change. Otherwise report
counts and CPU-profile attribution only, with no latency claim.
