# Control UI reactive graph counts

Build an isolated Solid observe bundle, then use the existing synthetic Gateway
interaction and reconnect workloads. This command never changes the shipping
build or installed packages. Keep output under the checkout's `.artifacts/`.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/build-control-ui-reactive-graph.mts --out-dir .artifacts/graph/base

NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-interactions.ts --bundle-dir .artifacts/graph/base \
  --steps chat-typing,session-switch,model-picker-open-search,graph-stream-100-deltas,graph-sidebar-live-update \
  --viewport desktop --graph-counts --output .artifacts/graph/interactions

NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-reconnect.ts --bundle-dir .artifacts/graph/base \
  --scenarios brief-drop --panes 10 --rtt 0 --graph-counts \
  --output .artifacts/graph/reconnect
```

Each result links a `reactive-graph.json` artifact. Scopes include source locations,
owner paths, creations, reruns, unchanged runs, and effect applications. Unchanged
runs count only plain, unheld executions whose output compared equal. Undefined
side-effect outputs and optimistic/held runs do not count as waste. Fresh but
structurally equal objects still count as changed. Writes rank observed transitive
fan-out; they do not enumerate every direct subscriber. Multiple root causes can
share the cost of one rerun, so do not sum their attributed time.

The probe retains aggregated counts and identities, never signal value previews.
Solid's bookkeeping scopes are excluded by its attribution engine. Diagnostic
compute/effect times include observation overhead and are wall time, not CPU.
Measure CPU separately with normal production bundles, `--thread-cpu-time`,
interleaved pairs, and the existing A/A control flags. Do not compare observe
bundle sizes or timings with production results.

The streaming scenario submits a real composer turn and delivers exactly 100
cumulative deltas on separate native frames, then verifies all finalized text.
The sidebar scenario updates one visible session and checks both its new title
and the retained active transcript. Both scenarios are opt-in.
