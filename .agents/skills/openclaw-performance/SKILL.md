---
name: openclaw-performance
description: "Performance work in OpenClaw: a slow or heavy flow (latency, CPU, memory, SQL, RPC, renders), writing or reviewing a perf PR, or adding a cache. Count the work, delete waste first, cache last."
---

# OpenClaw Performance

**Waste** is work a request does not need. Big speedups come from deleting waste, not from doing the same work faster. A cache is the last resort: it hides waste until its key, invalidation or hit rate breaks, and the waste returns.

## 1. Measure

Write the acceptance rule in the PR **before** the first run: flow, workload, metric, cold or warm, samples, and the change that counts as a win or a regression.

| Flow                            | Committed workload                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CLI startup                     | `pnpm test:startup:bench` (`:check` holds the budget)                                                                |
| Gateway startup / restart       | `scripts/bench-gateway-startup.ts`, `scripts/bench-gateway-restart.ts`, `scripts/perf/post-restart-burst-measure.ts` |
| Chat turn, frames per turn      | `scripts/bench-channel-turn.mts`, `scripts/perf/transcript-broadcast-measure.ts`                                     |
| Control UI cold load            | `scripts/bench-control-ui-cold-load.ts`, `pnpm ui:check-performance` (`:base` compares)                              |
| Control UI older-history paging | `scripts/bench-control-ui-history-depth.ts`                                                                          |
| Session list, multi-agent shape | `scripts/perf/team-shape-fixture.ts`, `src/gateway/session-list-viewers.perf.test.ts`                                |
| Concurrency, SQLite state       | `scripts/bench-gateway-concurrency.ts`, `pnpm test:sqlite:perf`                                                      |

- **Counts first:** operations per action (SQL statements, RPCs and frames, file reads, catalog or registry loads, spawns, renders) before wall time. Counts hold steady on a loaded host. A count that should be zero is the bug.
- **Real flow:** an isolated Gateway on the head under test, real transport, the slow path included. A mock Gateway, a stale build or a dev server measures something else.
- **Samples:** baseline and candidate interleaved (ABAB), at least 5 each, cold and warm apart; median and p95 with spread, run serially, host load recorded.
- **Rerunnable:** only committed scripts count; extend an existing one when none fits.
- **Profile:** `node --cpu-prof` per thread, or a browser performance trace, on the hot path.

Done when the flow has a committed workload, a baseline table and a written rule.

## 2. Find waste

Ask of every counted operation: does this request need it? Recurring OpenClaw waste:

- **Eager work on the critical path:** a registry lookup imported the plugin loader (#133518, 47.07 s → 10.36 s); optional runtimes loaded at startup (#119374).
- **Per-row or per-call recompute:** a sync read per archived row (#156665, 56,700 reads → 0); log patterns resolved per frame (#150042, 539 → 17 ms per 10,000 frames).
- **Re-checking admitted state:** schema, admission or freshness checks on warm handles (#166102, #172676; 14 PRs in the SQLite admission chain).
- **Full rescan per streamed delta:** every token reprocessed the whole reply (#158526, 5,342 → 1 ms CPU at 256 KiB).
- **Re-reading your own write:** two database backups per lookup (#161551, 772.8 → 7.7 ms); Doctor rescanned and backed up what it had just checked (#174665, ~26 → 3.0 s).
- **Repeated catalog or registry builds:** a per-agent catalog rebuild at startup (#116261, 24.9 → 5.0 s); rebuilds per miss or TTL (#127178, #167008).
- **Waiting on optional data:** the Usage page waited on provider plans and retried unrelated reads (#176358).
- **Defensive copies and wrapping:** `structuredClone` per turn (#172940, 1.685 MiB → 0); per-value boundary wrapping (#163818, 11,571 → 500 ns/event).
- **Spawn or fan-out per call:** a child process per resolution (#155779, 100 → 0).
- **Render cascades and full payloads:** a render per update (#159400, 250 → 79); full rows resent for one delta (#165404, 21.75 → 0.95 MB).

Done when each dominant count traces to the code that issues it, with a yes or no on "needed".

## 3. Fix in this order

1. **Delete** the waste. Deletes rarely come back; a failed delete removed a guard, so keep every check that protects a contract and prove the contract still holds.
2. **Once at the owner:** callers consume the owner's recorded fact.
3. **Carry the prepared fact** through the hot path.
4. **Batch** independent work, and prove the batch keeps frames, latency tails and cold start steady: coalescing was reverted three times (#162560, #173901, #175092).
5. **Cache**, with a written reason why steps 1–4 do not apply. Follow root "Cache identity", invalidate from the owner's writes, bound the size, and add an interleaved work-count test. Three of four cache re-fixes were silent misses: readers evicting each other (#115369 → #174741), a budget that thrashed (#149773 → #149879).

A worker move or a deferral relocates cost; count main-thread and total work both.

Done when the waste is gone from the counts, or the PR says which step stopped and why.

## 4. Land

- Rerun the step 1 workload on baseline and candidate under the same rule.
- **Every user-facing metric holds or improves:** latency, p95/p99, frames, cold start, CPU, memory, counts. A worse metric needs the owner's explicit acceptance in the PR. A 20% move in one cell is a stop, never "within spread": five of six reverted performance PRs showed their regression in their own body.
- Revert changes without a measurable gain.
- **Proof lives in the PR**, not in new tests: the before/after counts are the evidence. Extend a flow's existing work-count test only when this waste has come back before; [test-audit](../test-audit/SKILL.md) owns test value.
- PR evidence: workload command, acceptance rule, before/after table (counts and times, median and p95, samples), waste removed, and any metric that moved the wrong way.

Done when the table meets the rule written in step 1.

## Related

Test-suite speed: [openclaw-test-performance](../openclaw-test-performance/SKILL.md). Test heap growth: [openclaw-test-heap-leaks](../openclaw-test-heap-leaks/SKILL.md). CI capacity: [openclaw-ci-limits](../openclaw-ci-limits/SKILL.md).
