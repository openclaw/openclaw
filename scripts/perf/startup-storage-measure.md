# Startup storage attribution

Run only against a synthetic Git repository and a freshly built checkout. The
workload starts its own Gateway, creates a managed session, and sends real model
requests. It requires the scoped OpenAI live-test credential through the normal
credential owner. It never uses an operator Gateway or copies production state.

```sh
node --import ./scripts/tsx.mjs scripts/perf/startup-storage-measure.mts \
  --workspace /absolute/synthetic-repository --output /absolute/new-output \
  --entry dist/entry.js --samples 5 --commit-delay-ms 250
```

For the sandbox path, add `--sandbox-image <prepared-local-podman-image>`.
The workspace must have a configured local default remote/base. Each run retains
its isolated state, worktree, logs and timeline in the new output directory.
Stop and remove its guest through the sandbox owner before retiring that directory
through the native filesystem owner. Never reuse an output directory.

Two undelayed sends warm the session before the measured sends. Each send waits
for native turn completion and the session's projected idle state before ending
its CPU/allocation/wall window or disarming the delay, including the last sample.
A chat final event alone can precede ownership release and send the next input
through the queued admission path. Record chat-final latency and subsequent
settling time separately within the complete measurement. The preload holds
each explicit SQLite COMMIT for the selected delay while its transaction remains
open, then performs the real commit. This includes read-snapshot COMMITs; the
record count is not a write or fsync count. Use the recorded stacks to distinguish
read snapshots from write transactions. It covers MAIN and worker threads through
the existing `NODE_OPTIONS` runtime mechanism. It writes bounded stack records
without SQL or parameters to `state/benchmark-commits.<thread>.jsonl`; the sample
identifies the triggering measurement window, including concurrent background
work. Verify nonzero delayed worker commits before calling a run storage-pressure
evidence. This is controlled commit latency, not a reproduction of btrfs internals.

Compare identical baseline/candidate builds in serial AB/BA order, at least five
samples per arm, plus unchanged A/A controls. Repeat with `--commit-delay-ms 0`
to measure ordinary overhead. Use `--allocations` in separate runs for sampled
main-isolate allocations through the existing benchmark owner, or `--cpu-profile`
for main/worker CPU attribution. Neither profiled run supplies timing acceptance.
Use `--diagnostics` for the existing lightweight worker queue/run, storage, GC,
and event-loop counters without starting a CPU or allocation profiler. Capture
setup and aggregation stay outside the reported CPU/wall window. Keep these
diagnostic runs separate from the uninstrumented timing cohort.
CPU counters include the complete send, inference, and settlement. Model latency
is variable; use the `detail.*` fields in the existing slow-chat-send lines in
`gateway.log` for startup attribution. `timeline.jsonl` supplies enclosing request
and attempt spans. Configured diagnostic exporters receive the same detail fields
as `chat.send.detail.*` through the existing `diagnostic.phase.completed` events.
Cold sends, warm sends, and profiled measurements remain separate.

The instrumentation acceptance rule is unchanged successful replies and committed
input, an active storage phase throughout a deliberately blocked input admission,
and named owner spans for pre-attempt storage waits. Compare foreground transaction counts by recorded owner and disclose concurrent
background commits separately. These phase marks must not add writes or change
durability. Report
main/total CPU, allocation and timing spread rather than claiming a speedup.
Phases are nested and may overlap; sum only sibling phases, never all detail fields.
The existing MCP materialization phase remains owned by the tool-bundle path.
