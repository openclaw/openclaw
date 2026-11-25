# Concurrent attempt preparation

Measure `attempt.session-runtime`, its nested `history` and `actor` phases, and
the existing database reservation queue/execution durations through a real built
Gateway and WebSocket `chat.send`. The mock provider still executes real tools.
The preload forwards existing owner durations into the requesting run's diagnostic
observer; it does not add production instrumentation or SQL probes.

## Fixture and workload

Use a fresh task-owned directory with enough space for a populated 35 GiB database.
All content is synthetic. Create the fixture using the same tooling revision for
both arms; build each Gateway with `pnpm build:runtime` before measuring it.

```sh
fixture="$PWD/.local/attempt-runtime/fixture"
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir "$fixture" --sessions 5000 --agents 1 --runs 0 --approvals 0 \
  --cron 0 --projects 0 --transcript-mib 64 --port 42361
node --import ./scripts/tsx.mjs scripts/perf/session-resource-loader-fixture.mjs \
  --root "$fixture" --complete-gib 35
node --import ./scripts/tsx.mjs scripts/perf/attempt-session-runtime-fixture.mts "$fixture"
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir "$fixture" --entry dist/entry.js --port 42361 --mock-port 42362 \
  --scenario chat.send --turn-start-phases --runs 32 --clients 65 --exact-clients 32 \
  --plugins 40 --stress-tools --diagnostics \
  --history-turns 128 --history-payload-kib 16 --seed-history
```

The last fixture stage creates one linked active worktree with 62,000 files of
18,432 bytes. Foreground sessions each have 128 historical turns, including 16 KiB
tool payloads and reasoning items. The mock's context window accommodates this
seed without introducing an unrelated compaction workload.

Keep a pristine copy after seeding. Restore it to the **same absolute path** before
each run, preserving the fixture's linked worktree paths. Use filesystem clones
where available. Point `--entry` at the selected build, with its matching workspace
package outputs. Never rebuild or switch artifacts while a Gateway is running.

```sh
node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir "$fixture" --entry dist/entry.js --revision "$revision" \
  --port 42361 --mock-port 42362 --scenario chat.send --turn-start-phases \
  --runs 32 --clients 65 --exact-clients 32 --plugins 40 --stress-tools --diagnostics \
  --rounds 3 --chunks 3 --chunk-interval-ms 1 --history-turns 128 --history-payload-kib 16 \
  --gateway-preload scripts/perf/attempt-session-runtime-preload.mjs
```

## Comparison and interpretation

Run serial A/A controls followed by five interleaved A/B pairs, restoring the
fixture for every run. Record host load and keep task-owned builds/tests out of
the timing window. Preserve failures as failed cohorts. Profile separate restored
runs with `--allocations` (including A/A controls) and `--workload-cpu-profile`.

Compare 96 measured turns per run: read/reservation counts, phase median/p95/max,
first-model latency, main/process CPU, GC per fixed cohort, allocation, memory and
event-loop tails. Accept removal of unrelated-session rereads only with preserved
same-session freshness/progress, a material queue/tail reduction, and no unexplained
20% regression in a user-facing metric.

`turn-start-phases.json` keeps initial restoration in `unmeasuredPhases`; report
it separately from measured rounds. `session-runtime` contains its child phases,
so their durations must not be added. Model-context reservations can be joined by
run to `actor`, but hydration also happens elsewhere in that run: its aggregate
queue duration is not a percentage of `attempt.history`. Reservation blocker
labels identify the holder at enqueue, not every earlier queued job. Short mock
responses do not imply 32 simultaneously emitting provider streams; the concurrent
work is the 32 admitted/preparing sessions.

A local macOS run does not establish Linux/btrfs behavior or reproduce a production
maximum. Report those gaps explicitly, including whether `actor` exceeded two
seconds; do not extrapolate a measured queue reduction into a claim that all
production startup latency is resolved.
