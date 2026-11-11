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
The `--baseline-dir` hook freezes the two local-workspace caller modules,
`dependency-template.ts`, and `template-cache.ts`. It is not a valid comparison
when other owners, such as the registry, change. Run at least two
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

## Divergent source refresh attribution

Use `--fixture --divergent` to generate sibling commits with 22-path and
6,002-path changes and an unchanged lockfile. Later `--divergent` runs reuse that
fixture, measure both refreshes, and finish with same-commit reuse. Every clone
checks the selected source and source-dependent installed outputs. The `phases`
field records diagnostic owner spans; parent and child durations are inclusive
and must not be summed together.

Freeze both baseline and candidate owner snapshots and pass `--baseline-dir` to
both arms. The initial owner imports occur outside the clone timer, but using
the same loading mechanism keeps that difference out of the comparison.

For attribution-only changes, compare at least five serial, counterbalanced
baseline/candidate pairs on the same host. Report cold creation, small and large
refreshes, and same-commit reuse separately. Acceptance is unchanged source and
installed outputs and paired owner medians within ±10%. Record p95, process and
main-thread CPU, main-isolate allocated bytes, and host load alongside the medians;
retain failures and investigate tail regressions separately. Profile outside the
timing series with `--profile`.

The fixture uses a small real local dependency; its installation time does not
represent a large production dependency graph. APFS changes clone inode identities
and may make Git rehash unchanged files; do not project that cost onto Btrfs.

For behavioral changes, use matched A/A controls and counterbalanced A/B pairs
with the same sample counts on one host. Retain all samples and report latency
medians, tails, CPU, and allocation separately. Investigate adverse tail changes
and any group spread of at least 2×; a noisy control alone does not qualify a
candidate regression. Keep cold creation separate from commit-change refreshes.

## Native Btrfs Git refresh attribution

`sandbox-template-git-refresh-measure.py` isolates the private-checkout Git path
using the synthetic repository generated with `--divergent`. It requires
`fixture-initial`, `fixture-source-one`, and `fixture-source-two` to be sibling
commits with the same lockfile. Use the full 62,000-file fixture; the unchanged
identity probe selects a file outside both the 22-file and 6,002-file diffs.

Run it inside a disposable privileged Linux container with Python, Git,
`btrfs-progs`, mount, and losetup already installed. Disable networking and mount
only the synthetic fixture read-only. The image must support a loop-backed Btrfs
mount; reserve at least 6 GiB of disposable disk space. For example, with the
fixture and script paths made absolute:

```sh
docker run --name template-git-proof --privileged --network none \
  --mount type=bind,src=/absolute/synthetic-repo,dst=/fixture,readonly \
  -d <prepared-linux-image> sleep 1200
docker cp scripts/perf/sandbox-template-git-refresh-measure.py template-git-proof:/measure.py
docker exec template-git-proof python3 /measure.py \
  --fixture /fixture --root /scratch --output /results
docker cp template-git-proof:/results ./template-git-results
docker rm -f template-git-proof
```

The workload runs two baseline controls per diff size, then five alternating
A/B pairs. The candidate changes only `git repack -ad` to include `--window=0`.
It records phase wall time, waited-child CPU, cumulative child peak RSS, pack and
index bytes, file identities, and Git Trace2 refresh counts. Dirty-seed flushes
and preceding filesystem transactions settle outside the measured samples.
Retired commits/blobs must remain inaccessible; selected source, retained
synthetic dependencies, unchanged-file identity, and `git fsck` must pass.

The script unmounts its volume and detaches its loop device in `finally`; remove
the disposable container after collecting results, including after failures.
This measures native Git work, not full `templatePrepare`: it excludes the
installer, template registry, manifests, projection synchronization, agent DB,
and Gateway. Peak RSS is not allocated bytes. Record exact fixture commit IDs
and ancestry with results; an ancestor transition does not prove divergent
commit behavior merely because its file diff has the same size.
