# CI planner baseline

`bench-ci-planner.mts` measures the complete Node CLI planning flow: startup,
imports, real test inventory and matrix construction, then the real check planner
when the manifest requests it. It does not execute the planned tests or change
planner policy, timing weights, caches, or runtime code.

The manually dispatched measurement job runs on one Ubuntu 24.04 runner with
Node 24.22.1 and the repository's integrity-pinned pnpm 12.15.0. It installs the
harness and workload separately with their own frozen lockfiles, validates the
harness, and writes one bounded JSON artifact. No provider credentials, simulator,
service, release, or publication step is part of this workflow.

Pull requests from branches in the canonical repository run focused validation,
including drafts, when a benchmark source, test, guide, workflow, or Knip entry
changes. This job checks out the exact PR head and runs the focused tests on
Node 24.22.1, including real-process timeout and cancellation contracts, plus
type, lint, format, workflow and Knip checks. It does not run the fifteen-flow
baseline or upload a measurement artifact. The baseline remains manual-only.

The harness revision is the selected workflow commit. The default workload is
`79f5aeb133830a1db60b55cff3cf7a617086aa07`; these revisions are deliberately
separate. The report records both trees, lockfile and timing-file hashes, actual
tool versions, workflow/run identities, and install provenance. No application
build is needed to plan; native compiler inventory queries need the workload's
installed dependencies and are included in the measurement.

## Run

From a clean, installed harness checkout on Linux:

```sh
node scripts/bench-ci-planner.mts --workload ../installed-workload --output /tmp/ci-planner-benchmark.json
```

The workload must also be clean and separately installed. The command never
installs dependencies or fetches source. `--workload-sha <full-sha>` selects an
explicit alternative workload; record that change when comparing reports.
`--case all|main|cron|discord` and `--repetitions 1..5` support focused verification;
all three cases and five repetitions are required for a fifteen-flow baseline.

The hosted workflow exposes `workload_sha`, `case`, and `repetitions`, but limits
workloads to these reviewed canonical repository commits:

- Historical default: `79f5aeb133830a1db60b55cff3cf7a617086aa07`.
- Reviewed landed workload: `ba284782cf1705d7e5f1f085b9cdefbb55932af6`.

Defaults remain the historical workload, `all`, and `5`. Runtime validation rejects
all other SHAs, including well-formed ones, before either checkout. Two mutually
exclusive checkout steps use literal commit refs; the selected checkout identity
is verified before installation. Adding a hosted workload requires a reviewed
workflow change. The local CLI remains general and accepts `--workload-sha`.
Both checkouts must declare the same complete integrity-pinned pnpm 12.15.0 version
before either frozen install runs.

The action-level cache switches remain off, but they do not revoke the runner's
cache tokens. The fixed reviewed source choices restrict execution authority;
input syntax checks alone do not establish that trust.

For the first single-flow qualification, select the reviewed landed workload,
`main`, and `1` to exercise the main-planning admission. A successful single flow proves
that selected planning path works; it is not a fifteen-flow baseline or a repeatability result. The
historical default main case can fail the frozen planner's job-cap admission;
selecting a different workload or case does not change that planner policy.

Each of five repetitions runs these cases in order, without overlap:

1. Canonical main/push planning with a null changed-path inventory.
2. Same-repository PR replay for `src/cron/schedule.ts`.
3. Same-repository PR replay for `extensions/discord/src/channel.ts`.

These are public path replays, not captured production PR traces. The profile
uses the GitHub runner policy and full release scope, with release gates off.
Each stage starts a fresh Node process. It runs `scripts/ci-build-manifest.mjs`
and forwards the manifest's exact `check_plan_input_json` to
`scripts/ci-check-plan.mts` only when `run_check_plan=true`. The report preserves
the actual matrices, selected files/groups/jobs and output hashes. A legitimately
omitted check stage is `null` with a reason, not a zero-duration measurement.
Later repetitions must match the first repetition's complete plan outputs for
that case. This checks repeatability; it is not an independent planner oracle.

## Interpret the report

- Stage wall milliseconds cover spawn, startup, CLI work, output drainage and
  owned cleanup. Flow wall time also includes reading and forwarding the protocol.
- GNU time user/system seconds include the command and descendants it waited for,
  including native compiler queries. Printed CPU and command-wall resolution is
  0.01 seconds; a printed zero can be below that resolution.
- GNU time maximum resident KiB is a per-process lifetime high-water, not sampled
  RSS and not the sum or simultaneous peak of the process tree.
- Fresh CLI processes do not imply cold filesystem, OS, package, or CPU caches.
  No explicit planner cache restore/save or cache-hit experiment is performed.
- Five samples support a small baseline screen. They do not establish tail
  latency, a speedup, queue share, cache benefit, or benefit from a Rust rewrite.

The collection has a twenty-minute deadline. Each stage has a four-minute
deadline, bounded output, and the existing managed
process cleanup. GNU time sits between the collector and planner, so interruption
cannot certify cleanup of detached compiler descendants. Such a result remains
invalid, collection stops, and unexecuted flows are counted explicitly. The
isolated hosted runner is the final cleanup boundary; do not run this tool against
a shared service host. Failed stages retain their status, diagnostics and available
metrics. Unavailable metrics are `null`, never invented zeros.

Accept a report only when every requested flow has the expected identities and
valid protocol, cleanup and resource accounting, with unchanged workload source.
A fifteen-flow baseline additionally requires all three cases and five repetitions;
shorter runs remain focused qualifications.
The artifact is capped at 16 MiB and retained for seven days. Keep raw repetitions;
do not compare summaries across changed workload, toolchain, runner, environment,
or measurement boundaries without explaining those differences. Normal CI proves
tool correctness, not a performance improvement.
