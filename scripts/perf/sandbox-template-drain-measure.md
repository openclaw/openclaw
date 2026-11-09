# Sandbox template graceful-drain fixture

This workload launches the real Gateway CLI with an isolated state directory,
real WebSocket requests, a loopback synthetic OpenAI Responses provider, native
Git, and real Docker or native Podman dependency installation. It never sends requests to a live
model or an existing Gateway. Use only generated synthetic repositories/state.

Run with Node exposing `v8.getHeapStatistics().total_allocated_bytes` (verified on
26.12.1). Build each checkout with `pnpm build:runtime` before measurement. Build
checkouts sharing package dependencies serially. The source entrypoint remains
available by omitting `--entrypoint`; report its compilation/startup separately.

Create a task-specific image from `node:26.12.1-bookworm` with
`RUN npm install --global pnpm@12.15.0`. Generate the large repository using the
existing owner workload:

```sh
node --import ./scripts/tsx.mjs scripts/perf/sandbox-template-commit-measure.ts \
  --fixture --seed-only --repo /path/to/new-synthetic-repo \
  --output /path/to/new-generation-proof --image task-node-pnpm:local
```

That repository contains 62,000 distinct tracked payload files (1,100,004,000
bytes), a local dependency, and a real pnpm lockfile. Generation and image setup
are outside measured intervals.

For a large agent database, use the existing offline fixture generator. Its
transcript size is logical text before compression; record the actual
`agentDatabaseBytes` in `team-shape-summary.json`, not just the requested size.
For example, a prior run produced a 35.196 GiB agent database from 12 GiB logical
text, because the database also stores derived transcript facts. Verify the
actual size on the tested revision:

```sh
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-synthetic-state --sessions 5000 --agents 1 \
  --runs 0 --approvals 0 --cron 0 --projects 0 --transcript-mib 12288 \
  --now 1794182400000
```

The generator owns and closes its databases. `--state-fixture` requires its
synthetic manifest and clones the offline `agents`, `state`, and matching synthetic `client` trees before
first Gateway boot. Native copy-on-write support is mandatory, so keep the seed
and the test helper's system temporary directory on the same supporting
filesystem. The existing fs-safe native copy owner requires `clone: "always"`
and fails if cloning is unavailable. The client identity is generated with the
synthetic fixture and must accompany its state migration receipt; no real
credentials or fixture configuration are copied. Check free space
before generation. The state fixture remains reusable; every run removes its
own cloned state and task-created containers. Cleanup reads the stopped instance's
canonical sandbox registry, resolves its names to immutable engine IDs, removes
only those IDs, and verifies absence before deleting state. An unresolved cleanup
fails the run and preserves its state; successful receipts are in `cleanup.json`.

```sh
node --import ./scripts/tsx.mjs scripts/perf/sandbox-template-drain-measure.ts \
  --candidate /path/to/baseline-checkout --entrypoint dist/entry.js \
  --repo /path/to/new-synthetic-repo --state-fixture /path/to/new-synthetic-state \
  --output /path/to/new-run-output --image task-node-pnpm:local \
  --sessions 20 --case validation --action drain --expected-rebuilds 1
```

The fixture first prepares a real template, creates the cohort's managed
worktrees, and gracefully stops the seed Gateway. The next Gateway pauses the
actual sandbox-template Git status command during idle validation. It accepts
all cohort turns before recording a supported restart intent and sending
SIGTERM. Exit must be code zero with no terminating signal. The successor starts
with the same state; the harness never resends accepted turns.

For native rootless Podman, pass `--backend podman` and supply the task's isolated
`podman` executable/store through PATH and its normal engine environment. The
same backend is used for dependency builders, runtime containers, and cleanup.
The fixture leaves the Podman user unspecified so the existing runtime owner
selects `keep-id`; Docker uses `0:0`. Bake package-manager installation into the
image. Do not route the Docker backend through Podman's Docker-compatible API or
override daemon identity checks. On Linux, keep the synthetic state seed and
the helper's TMPDIR on the same clone-capable filesystem, such as btrfs, and
record that filesystem with the selected backend in the measurement report.

Use `--action control --expected-rebuilds 0` to release the same gate without a
drain. Run two control/control samples, then at least five interleaved
baseline/candidate drain pairs. Same-input candidate acceptance is zero native
installer calls after the gate, one successful initial template build, all 20
accepted sessions reaching the provider, and p50/max readiness below 60 seconds.
A count above zero is a regression even when a tiny fixture completes quickly.

`--case refresh` changes the synthetic prepare script before creating the cohort
and pins each worktree to the exact new commit. Its marker is written from inside
the real dependency-builder container, proving installation is in flight.
SIGTERM interrupts that build. After restart the harness releases new installer
markers. A rebuild for the new source input is expected; the old ready generation
and its recorded source hashes must survive the interrupted attempt. This is a
separate correctness case, not the unchanged-input latency acceptance test.

The run repository is a local clone whose origin retains the seed commit. The
refresh commit is local and explicitly selected by the cohort, while startup
prewarm requests the origin/default commit. Thus baseline refresh may perform two
post-drain installs (old default, then new cohort source), while the candidate
reuses the old ready generation and installs the new source once. These are
separate requested inputs, not proof of duplicate work by same-input waiters.

`result.json` records native installer counts, emitted successful template-build
events, inclusive worktree phase records, template status/source hashes at the
seed/gate/after-drain/ready boundaries, startup durations, graceful exit facts,
and first-provider-request p50/max. `p50Ms`/`maxMs` include successor boot;
`*AfterGatewayReadyMs` subtract the separately reported Gateway readiness time.
Controls measure from releasing the gate. These are readiness metrics, not final
response latency. The fixture provider's reply content is synthetic.

`process-metrics.jsonl` records Gateway lifetime process CPU, exact cumulative
main-thread V8 allocation, and peak RSS. CPU includes Gateway workers but excludes
Git, engine CLI, and container processes. Allocation excludes worker heaps. RSS is
not allocation. Keep all metrics; report filesystem/backend, host load, actual
state size, sample spread, and any differences from the production shape.

Retain the output JSON/logs for review, then remove only the task-owned synthetic
repository, database seed, proof directories, and image. The script does not
remove a supplied seed or image. It performs no deployment or service restart.
