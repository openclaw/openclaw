# Sandbox template commit alternation

`sandbox-template-commit-measure.ts --alternate` exercises the real template owner
with three exact commits whose installation output depends on their source. It
seeds A, B, and C, then requests A, B, and C again. `--burst 20` divides the measured
requests into three consecutive waves of 7, 7, and 6 concurrent consumers. Each
wave settles before the next starts, so a return to an older commit and callers
waiting for the same preparation are measured without conflating them with
mixed-commit fallback checkout behavior.

Reuse a synthetic repository produced by this script with 62,000 payload files
(1,100,004,000 bytes **per checkout**). Do not regenerate an existing fixture:

```sh
node --import ./scripts/tsx.mjs scripts/perf/sandbox-template-commit-measure.ts \
  --repo /path/to/synthetic-repo --output /path/to/new-results \
  --image local-node-pnpm-image --alternate --burst 20
```

Use an exact-parent checkout and candidate checkout with isolated dependencies.
The older `--baseline-dir` hook freezes only three caller modules; it is not a
valid comparison when template-cache or registry owners change. Run at least two
controls of each variant in serial, interleaved order (for example B/C/C/B).
Extend the series if the A/A spread obscures the result. Seed costs are separate
from measured waves. Record ambient host load and preserve failed samples.

Acceptance is zero dependency-preparation calls after all three inputs have been
seeded, correct HEAD and source-dependent installed output for every consumer,
and retained generations within the production owner's bound. `results.json`
is written before the zero-work assertion, so the unfixed baseline's repeated
preparations produce both a failing regression and retained measurements. The
`installs` counter counts calls to the real dependency preparation owner; it is
not a count of nested timing phases. Generation snapshots are taken after timed
waves. Registry custody and stale-key collection are covered by owner tests.

Use wave totals for work counts, process CPU, and main-isolate allocated bytes:
simultaneous per-consumer deltas overlap and must not be summed. Process CPU includes worker
threads but excludes Git, container-engine, and guest processes. Main-isolate
allocation excludes workers and native allocation. This owner fixture does not
open a 35-GiB agent database or exercise Gateway recovery or full first-turn
latency; those require separate lifecycle evidence.

For native filesystem accounting, retain process-attributed write bytes and
independent output-block counters. btrfs referenced, exclusive, and set-shared
extent observations describe sharing; overlapping subtree totals must not be
summed or presented as unique newly allocated disk space. Sync and extent
inspection belong outside timing intervals. No global cache flush is needed.
