# Channel-turn benchmark

Measure an inbound text message through a bundled channel plugin, a real Gateway agent turn, and outbound reply delivery. The fixture uses `qa-channel`, the local `qa-lab` HTTP bus, and the mock OpenAI provider. It needs no live channel account or model credential.

From an installed checkout, build the private QA runtime, then run the benchmark:

```sh
OPENCLAW_BUILD_PRIVATE_QA=1 OUTPUT_SOURCE_MAPS=1 \
  node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime
node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts
```

Use `--entry /path/to/entry.js` to select an already-built runtime. The benchmark prints its artifact directory as `OUTPUT <path>` and sets a nonzero exit code on failure. `TMPDIR` controls the parent directory. Apply the host's build/benchmark capacity limit when running alongside other jobs.

The workload contains one cold and ten warmed turns in one direct conversation. Sender, conversation, message IDs, synthetic timestamps, prompts and mock replies are fixed. Each turn waits for the matching full reply and the channel's acknowledged inbound cursor, which follows dispatch, preview cleanup and receipt settlement. The existing one-second settling window separates turns. The fixture uses isolated HOME, state, configuration, workspace and loopback ports; it stops its Gateway, mock provider and bus before returning.

`evidence.json` contains turn identities, child PIDs, readiness, graceful shutdown, the final bus snapshot, and inbound-to-first-outbound latency for each turn. The first outbound may be a streaming preview. SIGINT and SIGTERM stop the child process groups and bus before exiting. Read the child logs when readiness, delivery or shutdown fails. Artifacts are intentionally retained for inspection; remove the printed directory after collecting results.

For SQL measurement, set `OPENCLAW_CHANNEL_BENCH_NODE_OPTIONS` to the native SQL and causal tracing preloads. The Gateway receives `SQLMEASURE_OUT` pointing to the artifact directory; `phase`, `trace-map.json` and `channel-turns.json` are published atomically for observers. Preserve source maps and count all worker threads as well as Gateway MAIN. Report causal counts separately from wall-window/background counts and report latency as instrumented when preloads are active. The benchmark does not enable diagnostics or alter product sources.

This fixture covers the common channel boundary, not every transport. Its open direct-message policy and asserted sender do not exercise pairing, verified user-profile identity lookup, explicit conversation bindings, attachments, group policy, or external APIs. Attribute those paths with separate fixtures before claiming channel-wide savings. Inbound session recording and pending-final custody use the shared session owner; an apparent channel cost is not necessarily channel-owned SQL.
