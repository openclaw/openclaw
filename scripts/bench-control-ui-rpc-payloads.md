# Control UI RPC payload census

Run the production Control UI against a **compiled**, isolated Gateway with a
synthetic team fixture. This runner never selects an existing Gateway or reads
operator state. The default fixture contains 12,000 sessions, 40 configured
agents, 1,000 models, 1,000 disabled automation jobs, 5,000 completed automation
runs, 100 workspace skills, and 30 no-op plugins. A local OpenAI-compatible SSE
fixture handles `--stream`; no model service is contacted.

Build once with `pnpm build:runtime`. Keep the comparison bundles immutable.

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-rpc-payloads.ts \
  --output .artifacts/rpc-census --profile local --screenshots --stream
```

Use `--profile remote` for the existing shared 10 Mbps link with 50 ms one-way
delay (100 ms application RTT). It does not simulate TLS setup or packet loss.
`--routes` selects comma-separated application route IDs (the default `all`
visits every registered route). Redirected routes are recorded as such rather
than credited with another route's readiness. Each route is visited
in the same document after cold New Session and its warm reload. Warm reload
waits for the application's persisted boot record. `--engines chromium,webkit`
is the default. All browsers are headless. `--idle-ms` defaults to 5,000.

`report.json` records every request and push observed during each window, with
synthetic parameters (connect parameters are always redacted), decoded UTF-8
frame/payload/field bytes, top-level array sizes, actual protocol JSON parse
time, and synchronous message-listener application time. The separate
`microtaskSettleMs` marker includes scheduler delay; it is not CPU time or an
exclusive per-RPC render cost. Request/response IDs are scoped to a socket.
Server diagnostics retain handler, queue, and worker measurements. Concurrent
same-method calls have no server request ID and must remain ambiguous.

`readyMs` ends at a connected application's route-specific ready control;
`settledMs` also waits for recorded requests and a 350 ms quiet tail. Routes
without a specialized selector have shell-level readiness only: inspect their
rendered evidence before making route-readiness claims. A route error is
retained, never turned into a passing sample. Byte counts are decoded payload
sizes, not compressed wire bytes. For wire compression use
`bench-control-ui-wire.ts`.

For a focused comparison, preserve the base bundle, then provide the candidate:

```sh
NODE_DISABLE_COMPILE_CACHE=1 node --import ./scripts/tsx.mjs \
  scripts/bench-control-ui-rpc-payloads.ts \
  --compare-bundle-dir .artifacts/rpc-base-ui --bundle-dir dist/control-ui \
  --boot-route appearance --routes-only --routes cron \
  --samples 20 --idle-ms 0 --profile remote \
  --output .artifacts/rpc-remote-comparison
```

The coordinator holds three isolated Gateways/browser workers (base, a second
base as A/A control, and candidate), but admits only one complete sample at a
time. Six rotated orders distribute every arm across first, middle, and last
positions. Contexts are fresh per sample, and Gateway startup is outside timing.
Check each worker's `report.json` for errors before aggregating. Chromium
reports renderer main-thread CPU; untraced WebKit has no equivalent public CPU
counter. `--trace` enables a separate diagnostic run using the existing engine
collector. Do not mix those traced timings into untraced comparisons.

`--routes-only` prepares the selected boot route outside measurement and then
records only route visits, idle, and optional streaming. It does not claim a
warm boot; use the ordinary census to measure persisted cold/warm startup.
SIGINT/SIGTERM close the active browser and wait for owned Gateway teardown.

Artifacts contain synthetic data, but system metadata and build paths can still
appear in screenshots. Inspect and sanitize before uploading. Remove superseded
large output at closeout, retaining only reports and cited proof.
