# Channel-turn benchmark

Measure an inbound text message through a bundled channel plugin, a real Gateway agent turn, and outbound reply delivery. The fixture uses `qa-channel`, the local `qa-lab` HTTP bus, and the mock OpenAI provider. It needs no live channel account or model credential.

From an installed checkout, build the private QA runtime, then run the benchmark:

```sh
OPENCLAW_BUILD_PRIVATE_QA=1 OUTPUT_SOURCE_MAPS=1 \
  node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime
node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts
```

Use `--resources` for per-turn process, main-thread and native worker CPU counters and warm-window memory snapshots. `evidence.json` also records inbound-to-final-outbound time, settled dispatch time, and outbound message count. Worker snapshots use `Worker.cpuUsage()` once at each turn boundary, without an inspector or heap walk. Raw thread IDs and counters, sampling wall time and main-thread sampling CPU remain in the evidence, so analysis can report worker churn and measurement overhead. Process CPU includes worker and native background threads; process minus main-thread CPU is not a worker-only measurement.

Use a separate `--cpu-profile` run for attribution. It captures native `--cpu-prof` profiles through shutdown and a bounded `warm.cpuprofile` with worker profiles, CPU counters, worker-message counts and diagnostics using the existing private benchmark IPC. The bounded capture starts after the cold turn and ends after the tenth warm dispatch settles; inter-turn settling remains inside that window. Profiling is instrumented evidence, not an unprofiled latency result.

For warm-turn changes, publish the acceptance rule before running: one cold turn excluded, ten warm turns per sample, at least five samples per arm interleaved baseline/candidate, identical synthetic conversation and mock provider. Report median, p95 and range for first/final outbound latency, dispatch settlement, main CPU and total process CPU; report matched worker CPU separately from the boundary counters, plus outbound counts and warm memory. A win requires a measured reduction in the targeted operation and CPU or latency, no increase in outbound work, and no user-facing metric regression. A 20% regression in any cell stops the change. Keep cold and warm results separate and record host load and runtime.

Use `--entry /path/to/entry.js` to select an already-built runtime. The benchmark prints its artifact directory as `OUTPUT <path>` and sets a nonzero exit code on failure. `TMPDIR` controls the parent directory. Apply the host's build/benchmark capacity limit when running alongside other jobs.

The workload contains one cold and ten warmed turns in one direct conversation. Sender, conversation, message IDs, synthetic timestamps, prompts and mock replies are fixed. Each turn waits for the matching full reply and the channel's acknowledged inbound cursor, which follows dispatch, preview cleanup and receipt settlement. The existing one-second settling window separates turns. The fixture uses isolated HOME, state, configuration, workspace and loopback ports; it stops its Gateway, mock provider and bus before returning.

`evidence.json` contains turn identities, child PIDs, readiness, graceful shutdown, the final bus snapshot, and inbound-to-first-outbound latency for each turn. The first outbound may be a streaming preview. SIGINT and SIGTERM stop the child process groups and bus before exiting. Read the child logs when readiness, delivery or shutdown fails. Artifacts are intentionally retained for inspection; remove the printed directory after collecting results.

`--tool-args-chars N` measures streamed tool-call arguments instead. The mock provider moves to the Chat Completions API (`mock-completions/gpt-4.1`), and each turn first streams a `write` call whose JSON arguments carry N characters of this script's source in 4-character chunks; the reply text follows the tool result. Each turn uses its own direct conversation and session (`session.dmScope: "per-peer"`), so large arguments do not accumulate toward compaction. The written files stay in the fixture workspace.

For SQL measurement, set `OPENCLAW_CHANNEL_BENCH_NODE_OPTIONS` to the native SQL and causal tracing preloads. The Gateway receives `SQLMEASURE_OUT` pointing to the artifact directory; `phase`, `trace-map.json` and `channel-turns.json` are published atomically for observers. Preserve source maps and count all worker threads as well as Gateway MAIN. Report causal counts separately from wall-window/background counts and report latency as instrumented when preloads are active. The benchmark does not enable diagnostics or alter product sources.

This fixture covers the common channel boundary, not every transport. Its open direct-message policy and asserted sender do not exercise pairing, verified user-profile identity lookup, explicit conversation bindings, attachments, group policy, or external APIs. Attribute those paths with separate fixtures before claiming channel-wide savings. Inbound session recording and pending-final custody use the shared session owner; an apparent channel cost is not necessarily channel-owned SQL.
