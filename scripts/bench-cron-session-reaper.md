# Cron reaper runtime proof

This standalone harness supplies runtime evidence for
[openclaw/openclaw#142591](https://github.com/openclaw/openclaw/pull/142591), without
changing the reaper or using production state.

## Run

From a checkout with its pinned dependencies installed:

```sh
node --import ./scripts/tsx.mjs scripts/bench-cron-session-reaper.ts 2
node --import ./scripts/tsx.mjs scripts/bench-cron-session-reaper.ts 632
```

Run contributor code only in an appropriately isolated environment. The harness
creates disposable state, binds the OpenClaw state/config paths before runtime
imports, and removes its fixture tree afterward. It accepts 1–1000 agents.

## What it measures

Each agent gets a real canonical SQLite database with four persisted sessions
and 512 KiB of synthetic padding in the existing cache table. The harness calls
the production `sweepCronRunSessions` sequentially, matching the scheduler's
per-agent await ordering without adding yields, accessor spies, or mocks.

- **Discovery:** no expired run; all four sessions must survive unchanged.
- **Pruning:** advance the supplied clock six minutes, crossing the retention
  cutoff and five-minute throttle. Exactly one run per agent must disappear.
  Recent runs, old base cron sessions, and old ordinary sessions must survive
  with the same keys, session IDs, and timestamps.

Seeding and persisted readback are outside the timing window. Database handles
and validation caches are closed before each phase and before verification.
`REAPER_PROOF` reports sweep duration, maximum delay of a 10 ms interval, timer
sample count, successful sweeps, removals, and verified survivor count. The timer
includes 30 ms observation windows before and after the sweep, so a blocked final
sweep is observable. Reaper warnings or incorrect persisted results fail the run.

## Comparison boundary

The comparison holds the target source constant and reverts only the discovery
accessor import/call to `listSessionEntriesCore` for the before condition. Each
condition starts in a new process with newly seeded, equivalently shaped state.
Both run on the same CI runner. The after condition uses the exact PR source.

These are **real SQLite reaper/lifecycle calls on synthetic state**, not a full
Gateway boot, HTTP health probe, production-fleet trace, transcript archival
proof, or benchmark of the entire cron scheduler. Handles are cold; OS disk
caches are not controlled. Padding approximates database size, not the reporter's
data distribution. Discovery still performs synchronous reads, and pruning still
enters integrity-checked writes. A faster sweep does not promise stall-free
operation or establish an improvement on every workload.

## Recorded result: September 9, 2026

[Successful isolated GitHub Actions run](https://github.com/PollyBot13/openclaw/actions/runs/34373216011)
on Ubuntu 24.04, Node 24.21.0, Linux x64, four available CPUs. Source target:
`47505f292c83b04f00d0d073ca95daad96ccd1c9`; CI carrier:
`0a7d673dce9` (see the run for its full commit and execution recipe).
Harness SHA-256: `f75a637fada5e45d3ce17857f8a3fb7591c2f6526920bf50e2ff1aca15df015c`.

The 632 databases totaled 711,884,800 bytes (about 679 MiB). One sample per
condition on the same runner, before then after; not a statistical benchmark.

| 632-agent phase                | Before elapsed | After elapsed | Before max timer delay | After max timer delay |
| ------------------------------ | -------------: | ------------: | ---------------------: | --------------------: |
| Nothing expired                |   18,329.34 ms |   1,054.29 ms |           18,326.94 ms |           1,050.52 ms |
| One expired run in every agent |   21,738.98 ms |  23,043.66 ms |           21,739.31 ms |          23,043.85 ms |

Both conditions completed all 632 sweeps without reaper warnings. Discovery
preserved all 2,528 rows. Pruning removed exactly 632 expired runs and verified
all 1,896 survivors. The two-agent smoke comparison also passed both phases.
The timer recorded five samples per phase: even after the fix, a sweep can block
the event loop; the maximum delay is therefore more useful here than percentiles.

**Interpretation:** read-only discovery reduced this no-expiry sweep by about
94%. The deliberately deletion-heavy case did not improve: it retained roughly
23 seconds of blocking with the fix. This supports the narrow discovery benefit
and continued pruning correctness, not a claim that fleet maintenance is now
universally responsive. The writable deletion path remains a separate limitation.

Validation in the same run: formatting, script lint, full script typecheck,
and all 28 existing reaper tests passed. CI restored the original after-source
and checked it against Git after the comparison. Structured `REAPER_PROOF` lines
are in the run log and its `reaper-proof` artifact (14-day artifact retention);
the summary above is retained here independently of artifact expiry.
