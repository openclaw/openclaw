# Test harness cost workload

Profile the twelve highest-cost eligible files in the parent-baseRef replay of
300 main commits, retaining prior KEEP cases. Exclude the two previously optimized
smoke files, Control UI, PostgreSQL matrix roots, and active lane claims.

## Acceptance rule

Use the existing per-file Vitest selection and all cases and assertions. Collect
operation counts and diagnostic CPU profiles before changing tests. Run each
candidate file on the same host as its baseline with pinned Bun and Node 26.12.1.
A Node V8 diagnostic profile is separate from pinned-Bun timing evidence.

For each changed file run five alternating baseline/candidate pairs after one
unmeasured warmup of each arm. Keep cold observations separate. Record command
wall time, user plus system CPU, peak RSS, case counts, median, p95, and min/max.
Admit timed runs only while the campaign timing lock is held and load1 is below 24. Reject any 20% adverse metric; smaller adverse movement requires explicit
acceptance. Require measured harness work reduction and unchanged assertions.
No case deletion, skips, planner changes, shards, runners, or suites are permitted.
Failure messages must identify the differing artifact or field.

Use `node scripts/run-vitest.mjs <file> --maxWorkers=1 --reporter=json` for timing.
Use the committed `scripts/run-vitest-profile.mts runner --output-dir <dir> --
<file> --maxWorkers=1` with Node for diagnostic per-thread CPU attribution; its
profiles are not timing samples. Capture main startup with `node --cpu-prof`.

## Ranked inventory

Historical case-seconds price selection frequency, not current elapsed time.
The replay predates subsequent harness improvements, so current profiles decide
whether any removable overhead remains.

| File                                                                            | Selections / 300 | Case-seconds / 100 |
| ------------------------------------------------------------------------------- | ---------------: | -----------------: |
| `src/agents/subagents/spawn/subagent-spawn.production-boundary.test.ts`         |               14 |            513.427 |
| `src/commands/agent.test.ts`                                                    |               21 |            477.414 |
| `src/config/sessions/session-history-eviction.test.ts`                          |               21 |            198.758 |
| `src/agents/prepared-model-catalog-worker.pool.integration.test.ts`             |               14 |            132.309 |
| `src/agents/agent-command.live-model-switch.test.ts`                            |               27 |            122.571 |
| `extensions/browser/chrome-extension/bootstrap.chromium.test.ts`                |                8 |            117.969 |
| `src/gateway/server-restart-sentinel.test.ts`                                   |               21 |            111.755 |
| `src/cli/gateway-cli/run-loop.test.ts`                                          |               14 |            106.834 |
| `src/gateway/worker-environments/destination-authority.e2e.test.ts`             |               15 |             99.235 |
| `src/commands/agent.acp.test.ts`                                                |               17 |             98.549 |
| `src/gateway/worker-environments/worker-turn-launcher-terminal-results.test.ts` |                9 |             75.846 |
| `src/gateway/server-worker-placement-reclaim.preparation.test.ts`               |                5 |             71.290 |
