# Provider admission retention proof

Run the native-stream probe with `node --expose-gc --import ./scripts/tsx.mjs
scripts/perf/provider-rate-limit-retention.ts --turns 1100`. It reports retained
callback bytes for 100 turns each of eleven scenarios: consumed success and 429,
result-only 429, rejected result, early-consumer abort, unread success, bare end,
abandoned 429, queued abort, 429 retry, and completed 429 async-context cleanup.
Streams stay reachable during collection except in the async-context scenario,
which drops completed streams and keeps the real recovery timers enabled.
Result reads happen afterward for abandoned consumers; a delayed 429 must still
gate the next same-account request. Admission observation needs only account scope
and identity, not request options or callbacks after the provider starts. Shared
recovery timers must not inherit the request's async context.

Corroborate transport behavior with `OPENCLAW_STATE_DIR=.local/rate-limit-http timeout 120s node
--expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-rate-limit-http-retention.ts
--turns 100 --scenario abort`. Repeat with `--scenario success` and `--scenario retry`.
This uses a synthetic loopback HTTP provider and the real Responses transport;
retry turns receive a 429 with `retry-after-ms: 1` before succeeding. Aborted
consumers close iteration first, wait for native producer completion, and only
read `result()` after collection. Each scenario reports physical requests and
retained callback bytes. It does not sample allocation or exercise Gateway RPCs.

An allocation stack below admission is not a retaining path. In particular,
Responses continuation deliberately keeps its latest request input between turns.
Distinguish that session-owned baseline from abandoned-stream callback retention
with a heap snapshot and session-resource cleanup; do not erase continuation state
just to make a stream-lifetime probe report zero.

Use the retention owner probe alongside the existing built-Gateway soak. Generate
separate, deterministic synthetic fixtures for baseline and candidate. Preserve the
baseline build before editing source; use identical workload and probe files for
both arms. Never point these commands at operator state or a production Gateway.

```sh
pnpm build
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir .local/rate-limit-base --sessions 10000 --runs 8000 --settled-runs \
  --transcript-mib 16 --approvals 0 --cron 10 --projects 1 --port 42732

node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
  --state-dir .local/rate-limit-base --entry dist/entry.js --scenario memory-soak \
  --port 42732 --mock-port 42734 --clients 64 --exact-clients 8 \
  --sessions 8 --runs 8 --plugins 40 --stress-tools --mixed-rpc \
  --list-filter-churn --list-interval-ms 2000 --row-mode sidebar --poll-seed 1732 \
  --duration-ms 600000 --warmup-ms 60000 --round-interval-ms 15000 \
  --memory-interval-ms 5000 --retained-profile-ms 0 --diagnostics \
  --chunks 100 --chunk-interval-ms 10 --prompt-kib 128 \
  --gateway-preload scripts/perf/provider-rate-limit-stress-probe.mjs
```

Run serially on a shared Mac. Reserve the two loopback ports first. The harness
owns its synthetic HOME, config, state, workspace, provider, and child cleanup.
It checks completed tool calls, concurrent streams, RPC responses, and connected
clients. A failed or incomplete workload is setup evidence, not a performance
verdict. The fixture has mostly completed child sessions and archived rows; the
workload adds concurrent turns and sidebar, search, history, diff, and connect RPCs.

The primary ten-minute run has no allocation sampler or GC tracing. Read
`stress-probe.json` in the fixture for whole-window main-thread CPU and five-second
RSS/heap samples. In its `broadcast-measure-*/result.json`, use
`wholeSoakDiagnostics.gc` for total and per-kind GC counts, totals, and maxima;
GC seconds/minute is `durationMs.total * 60 / wholeSoakDiagnostics.durationMs`.
Use `wholeSoakDiagnostics.eventLoopDelay` for p99 and sample count. Pool
`samples[].sessionsList.latencies` before calculating sessions.list p95/p99.
Report completed turns and fixture/build identities with every comparison.

Measure allocation in a **separate** matched pass, never as a GC/tail gate. The
harness intentionally filters arbitrary child environment variables, so create a
small local preload that enables the committed probe:

```sh
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const probe = pathToFileURL(path.resolve('scripts/perf/provider-rate-limit-stress-probe.mjs'));
writeFileSync('.local/rate-limit-allocation.mjs',
  `process.env.OPENCLAW_RATE_LIMIT_STRESS_ALLOCATION = '1';\nawait import(${JSON.stringify(probe.href)});\n`);
JS
```

Repeat the same soak command with `--duration-ms 60000` and
`--gateway-preload .local/rate-limit-allocation.mjs`. This records one thirty-second
sample beginning five seconds into the measured load in
`stress-allocation-probe.json`. The sampler includes collected objects and exports
only aggregate bytes; it opens no network inspector listener. Its forced collection
and timing overhead are excluded from the primary run by using a separate process.
Keep this pass's CPU/GC/tails separate and report allocation as sampled context.

Compare retained bytes at the admission owner first, then check the loaded Gateway
for adverse CPU, GC, latency, or memory changes. Report absolute and relative deltas,
tail sample counts, and both GC maxima. Investigate meaningful adverse measurements
with counterbalanced repeats and matched A/A controls before attributing harm.
This synthetic workload does not measure provider-network latency or reproduce
private production plugins. Its mock does not emit 429s; the focused
`test/e2e/qa-lab/runtime/gateway-rate-limit-prompt-cache.e2e.test.ts` exercises a real
mock-provider HTTP 429 with `retry-after-ms` after a tool call and verifies recovery.
