# Residual steady reader workload

Acceptance registered before the first run.

Use `scripts/bench-ingress-polling.mts` with its synthetic iMessage bridge,
local model provider, connected session subscriber, and optional placement fixture.
Run an isolated built Gateway with the frozen SQL observer. Never use operator data.
Record a 300-second idle phase after startup settles, followed by three sparse
messages. Keep startup, idle, and individual message phases separate.

Attribute exact session-entry reads, worktree owner lookups, proactive cron job
reads, and ingress recovery reads to their current owners before changing them.
Exclude reductions already owned by another change. If a shape does not reproduce,
report that result rather than change its reader speculatively.

For ingress, normal admissions, claim settlements, and retry deadlines already
wake the drain. The candidate may reduce the fallback recovery sweep to once per
five minutes. Startup still sweeps immediately; externally inserted rows and dead
claims remain recoverable within five minutes, plus execution time. This is the
accepted fallback-delay tradeoff; normal message freshness must not change.

Count statements and worker requests across all threads, and main-thread SQL,
per minute and per delivered message. Compare baseline/candidate in alternating
order, three pairs when load is below 64 and internal free space is at least
12 GiB; otherwise one pair and source attribution. Idle ingress scans and requests
must fall by 80%, with no new SQL shape, no main-thread increase, and no additional
work per sparse message. Prove immediate admission, retry deadlines, and bounded
external-enqueue/dead-claim recovery with the existing owner tests.

For timing claims, run at least five samples per arm, alternating on one platform
under the campaign timing lock and load below 24. Report median, p95, and min/max
for latency, CPU, and memory, keeping cold and warm separate. Every ordinary
user-facing metric must hold or improve; a 20% regression stops acceptance. After
60 minutes without a qualified timing slot, report counts and per-thread CPU
profiles, with latency explicitly unmeasured.
