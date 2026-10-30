---
summary: "Measure fixed-duration Control UI protocol load against an isolated Gateway"
read_when:
  - Comparing Gateway runtimes under connected Control UI load
---

# Control UI protocol load

Build with `pnpm build`. The Linux benchmark creates private Gateway state,
synthetic signed devices/credentials, loopback listeners, and a mock provider.
Supply a delegated cgroup-v2 parent with CPU accounting; run the controller inside
that subtree so Gateway migration is permitted. The benchmark owns a unique child
cgroup and verifies cleanup. Use an isolated runner, never a live service cgroup.

```bash
taskset --cpu-list 4-31 node scripts/bench-gateway-concurrency.ts \
  --control-ui-clients 50 --active-clients 25 --drivers 4 \
  --duration-ms 60000 --timeout-ms 180000 --runs 1 --warmup 0 \
  --gateway-runtime /path/to/node --gateway-cpus 0,1,2,3 \
  --resource-cgroup /sys/fs/cgroup/benchmark-parent \
  --transpiler-cache /benchmark-cache/node \
  --output /benchmark-results/node-50-25.json
```

For 100/50, change the two client counts. Keep the Node driver unchanged when
selecting another Gateway runtime. Record executable hashes, source/build/lockfile
identities, host topology, kernel, and observed affinity with each campaign.

## Workload contract

Drivers partition clients round-robin. Each signed Control UI webchat connection
subscribes to inventory and its own session, with the default observer HUD enabled.
Inactive clients select distinct idle
sessions, so they do not spectate active ones. This fixes the event fan-out topology.
Each active client completes one unscored warmup, then keeps one request outstanding
until the common monotonic deadline. Submitted requests drain within their timeout.
This measures the wire protocol, excluding browser rendering and external networks.

ACK means admission. Queued requests may emit an empty custody final and a visible
follow-up reply under different run IDs, in either order. Unique echoed mock tokens
and session identity correlate replies. Empty/status events are not first deltas;
duplicate finals cannot advance the loop. Journals retain partial observations and
unmatched first deltas by stream identity without inventing a request association.

## Results

`requests` contains send, ACK, first-delta, and visible-final times relative to start.
Latencies subtract send time; p50/p95 use nearest rank and include later drained
requests. Missing observations remain null. `streamObservations` retains unbound
first-delta identities. Failures, missing replies/deltas, or lost clients invalidate
a trial; keep failed trials instead of silently replacing them.

`summary.replies` and throughput count only fixed-window completions;
`drainedReplies` counts later completions. `windowCpu` divides fixed-window cgroup
CPU by in-window replies, retaining actual boundary times and skew. `cpu` instead
brackets admission through drain and divides by all completions. Both include
exited Gateway descendants and exclude drivers/provider; keep denominators separate.

The 50 ms sampler distinguishes lifetime/load-window RSS and thread peaks, recording
thread affinity and PID/TID birth ticks. Summed RSS can double-count shared pages
and miss brief peaks; it is not cgroup `memory.peak`. Observations bound thread
lifetimes. Verify Gateway JavaScript-worker event coverage separately for each runtime.
Workers without individual exit notifications have only the recorded process-exit
upper bound; report them separately instead of inventing complete lifetimes.
Worker `atNs` has a runtime-local origin. Use `epochMs` with the driver's
`startEpochMs` to classify load-window events; raw Node/Bun `hrtime` origins differ.

## Cache policy and proof

Keep user state fresh. Use a separate `--transpiler-cache` directory per immutable
Bun build, prime each shape with one full unscored workload, retain it across scored
trials, and record inventories. Empty-cache trials form a separate campaign.
Record OS pages, transpiler cache, product-owned Node compile-cache policy, and JIT
warmup independently. Compare per-trial summaries from two Node/Bun/Bun/Node blocks
per release/shape, including dispersion. Profile separately with exact build IDs
and lost-sample counts; individual requests are not independent runtime trials.

Run `node --import ./scripts/tsx.mjs scripts/bench-gateway-control-ui-proof.ts /path/to/runtime /delegated/cgroup`
for opt-in Linux process/protocol proof of exited-child CPU, workers, forced cleanup,
reply ordering, disconnects, timeouts, late errors, and cancellation. This stays
outside per-PR unit CI. Separately prove a small real Gateway workload's signed
admission and subscriptions before scoring. Drivers remain monitored through the
coordinated finish/close handshake, with available failure evidence retained.
Gateway teardown uses the existing acknowledged IPC stop and shared service stop
budget before forced cleanup, preserving admitted descendant work during drain.
