# Git worker steady-state allocation

This workload invokes `runGitWorkerOperation` on a real synthetic repository,
with production Git commands, worker transport, and worker handlers. It bypasses
the parent read cache so cache hits cannot hide residual per-operation cost.
It instruments only the handler inside each Git worker. Thread CPU excludes Git
subprocesses and host-broker work. RSS is process-wide; heap is worker-local.
Imports and the first five operations per worker/operation are warmup. Allocation
sampling includes collected objects and runs separately from untraced timing.

Generate the fixture once in a task-owned directory (about 210 MiB). It contains
5,000 commits, 512 tracked files, 128 packs, 64 linked worktrees, 4,100 packed refs,
10,000 untracked files, and 20 dirty tracked files. It has a synthetic GitHub remote;
the workload does not fetch. The 10,000-entry diff-revision metadata budget can
return `oversized`; that is recorded separately from successful revision probes.

```sh
python3 scripts/perf/git-operation-allocation-fixture.py "$PWD/.local/git-allocation"
mkdir -p .local/git-allocation/home .local/git-allocation/state .local/git-allocation/tmp
export OPENCLAW_STATE_DIR="$PWD/.local/git-allocation/state"
export OPENCLAW_HOME="$PWD/.local/git-allocation/home"
export TMPDIR="$PWD/.local/git-allocation/tmp"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
fixture_base=$(git -C .local/git-allocation/repo rev-parse HEAD~10)
node --import ./scripts/tsx.mjs scripts/perf/git-operation-allocation-measure.ts \
  --repo .local/git-allocation/repo --base "$fixture_base" \
  --output .local/git-allocation/timing --iterations 30
node --import ./scripts/tsx.mjs scripts/perf/git-operation-allocation-measure.ts \
  --repo .local/git-allocation/repo --base "$fixture_base" \
  --output .local/git-allocation/allocation --iterations 30 --allocations
```

Use distinct output directories for every run. Run the same commands on baseline
and candidate with the same fixture; alternate order for repeated measurements.
For a patch confined to the three measured owners, `--baseline <commit>` loads
those original modules through the same source loader without switching the
checkout. Other runtime modules must be unchanged between arms.
`--operations checkout.revision:context,checkout.revision:refs` selects specific
operations for longer samples. The fixture's pack count does not reproduce the
physical size, disk pressure, or maintenance activity of a production repository.

Each `worker-*.jsonl` row records one measured operation. Sum `sampledBytes` and
`cpuMs` by `key`, then divide by count; use CPU only from untraced runs. Results
are in `results.json`; compare them byte-for-byte by operation after excluding
measurement fields. A sample profile for each operation identifies allocation
sources. Preserve success/fallback counts when interpreting costs; cheap failure
is not evidence of a successful read. Cached branch suggestions are deliberately
warm, matching steady state. This is owner evidence, not whole-Gateway evidence.
