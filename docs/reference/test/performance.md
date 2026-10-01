---
summary: "Import profiling, CPU and heap profiles, shard timings, and benchmark scripts"
title: "Test performance and benchmarks"
read_when:
  - You are profiling a slow test run
  - You need a startup, gateway, or model latency benchmark
---

## Test performance tooling

- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting, while still using scoped lane routing for explicit file/directory targets. `pnpm test:perf:imports:changed` scopes the same profiling to files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` benchmarks the routed changed-mode path against the native root-project run for the same committed git diff; `pnpm test:perf:changed:bench -- --worktree` benchmarks the current worktree change set without committing first.
- `pnpm test:perf:profile:main` writes a CPU profile for the Vitest main thread; `pnpm test:perf:profile:runner` writes CPU + heap profiles for each unit worker. Both print their output directory (a temporary directory by default). Use `-- --output-dir <dir>` or `OPENCLAW_VITEST_PROFILE_DIR` to retain profiles at a chosen location.
- `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json`: runs every full-suite Vitest leaf config serially and writes grouped duration data plus per-config JSON/log artifacts. Full-suite reports isolate files by default so retained module graphs and GC pauses from earlier files are not charged to later assertions; pass `-- --no-isolate` only when intentionally profiling shared-worker accumulation. `pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json` compares grouped reports after a performance-focused change.
- Full, extension, and include-pattern shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later whole-config runs use those timings to balance slow and fast shards. Include-pattern CI shards append the shard name to the timing key, which keeps filtered shard timings visible without replacing whole-config timing data. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.
- `pnpm ci:timings:refit`: regenerate committed `config/ci-test-timings.json` from the last five successful main CI runs; add `--dry-run` to preview the changed-entry table. This file owns per-file UI E2E and per-profile compact-group weights, unlike the gitignored `.artifacts/vitest-shard-timings.json` whole-config timing cache. Independent CI shards use only the committed weights, never that cache. See [CI timing refits](/ci/capacity#measured-shard-weights) for the daily refresh and sampling rules.

Runner profiling preserves the selected `forks` or `threads` pool, isolation, environment, and custom runners extending Vitest's `TestRunner`. Capture starts in a Node preload before Vitest worker imports, spans all files assigned to that worker, and finishes both profile files in awaited worker cleanup before teardown is acknowledged. It does not depend on exit-time profile flushing. Root global setup configures every selected project without replacing its reporters or setup. Main capture spans Vitest/Vite startup through run completion and close. Process termination before cleanup, bootstrap failures before runner construction, and teardown timeouts can still prevent output. Browser/VM pools, custom runners without `onCleanupWorkerContext`, and additional native `--cpu-prof`/`--heap-prof` flags are rejected for runner profiling.

Forward Vitest options after the profiler separator. Forwarded options use Vitest's native CLI validation before loading config. Config-only settings, such as `runner` and `globalSetup`, belong in the Vitest config file, not CLI flags. For example:

```bash
pnpm test:perf:profile:runner -- --output-dir .artifacts/profiles -- --config test/vitest/vitest.unit.config.ts --pool threads
```

`pnpm test:extensions:memory` profiles built plugin index entries from `dist/extensions` (including nested `dist` output) and package-local `extensions/<id>/dist` output; TypeScript source entries are excluded. Root artifacts take precedence when both builds exist. Selecting an already-built plugin with `--extension <id>` reuses its output without requiring unrelated plugin builds; build the plugin package first if its output is not supplied by `pnpm build`.

Native imports also need the plugin's declared dependencies and a resolvable `openclaw` host package. The profiler does not install or link dependencies: missing dependencies remain import failures in the JSON report and cause a nonzero exit.

The report labels this **cold-import** screening, not plugin activation, Gateway startup, or workload coverage. Each fresh child reports process user/system CPU in microseconds through its exit hook and process peak RSS in MiB (the existing `maxRssMb` field). CPU and peak RSS come from one observation bound to the importing child PID; inherited descendant output cannot replace it. CPU totals reconcile with user plus system counters. Deltas subtract the same empty-child baseline, retain negative values, and must not be summed across plugins. The combined-import case measures a separate process with shared imports. Explicit process exit is not proof of plugin lifecycle cleanup or memory retention.

Source commit/tree and tracked cleanliness, build metadata and selected entry hashes are observed before and after the run. Child Node/V8/ABI/platform/architecture identify the measured runtime. These snapshots do not attest the transitive dependency closure or prove that build metadata describes every generated byte. Package-local builds without their own provenance remain unqualified. Schema 2 preserves the existing `repoRoot` and absolute `results[].file` fields for saved-report readers and adds `results[].relativeFile` for portable screening. Entry provenance paths are repository-relative. Raw reports still contain local paths and captured diagnostics; use the screening consumer’s public projection or redact them before sharing.

`qualification.qualified` admits only complete cold-import snapshots with matching source/build declarations, stable selected inputs, resource counters, a child-recorded completion after every awaited import, and verified process-group/output and temporary-home cleanup. Missing identity or cleanup proof stays explicit in `qualification.gaps`; screening consumers must reject unqualified reports even when the observation command exits successfully. Windows currently verifies child/output closure without descendant-group proof, so those observations remain unqualified. Import failures (including exit zero before the sequence completes), missing RSS, timeouts, and cleanup failures produce their nonzero command outcome.

### Kitchen Sink Gateway resource comparison

The existing Kitchen Sink RPC walk can compare a fresh Gateway with plugins
disabled against a fresh Gateway with only Kitchen Sink `conformance` active:

```bash
OPENCLAW_KITCHEN_SINK_NPM_SPEC=npm-pack:/fixtures/kitchen-sink.tgz \
  pnpm test:plugins:kitchen-sink-rpc -- --resource-profile /out/resources.json
```

This mode requires Linux Node with `process.threadCpuUsage`, a built OpenClaw
entry in the current package root, `dist/build-info.json` with a full source
commit, and a local npm-pack fixture. It does not download a floating fixture.
The normal RPC walk, including its Bun command, is unchanged.

Run only in a prepared secretless container or remote runner. For example, bake
the frozen built host, its dependencies and the pinned fixture into a reviewed
image, then execute with explicit limits and networking disabled:

```bash
docker run --rm --network none --memory 4g --cpus 2 --pids-limit 512 \
  -v "$PWD/proof-output:/out" -w /app \
  -e OPENCLAW_KITCHEN_SINK_NPM_SPEC=npm-pack:/fixtures/kitchen-sink.tgz \
  <prepared-image> \
  node --import ./scripts/tsx.mjs scripts/e2e/kitchen-sink-rpc-walk.mts \
  --resource-profile /out/resources.json
```

Prepare any managed npm installation prerequisites in the image; an offline
install failure is blocked proof, not permission to copy credentials or enable
network access. The harness supplies a minimal child environment, but does not
enforce container isolation itself. Preserve the image digest and runner limits
alongside the report.

Each case records startup from the initialized measurement preload to HTTP
readiness, one unmeasured health warmup, a 250 ms idle window, 20 completed
`health` RPCs, and a 250 ms post-work window. The conformance case additionally
measures one asserted `session-create`, then 20 asserted `kitchen_sink_text`
calls with unique idempotency keys, followed by another observation window.
The `plugin-tool` aggregate retains all 20 calls. Its nested `breakdown` separates
`plugin-tool-first` (the original first call) from `plugin-tool-warm` (the remaining
19); no call is discarded or added as warmup. Both children share the same raw
midpoint snapshot, and the aggregate uses the original outer snapshots. Do not
sum the aggregate and its children. The aggregate includes midpoint sampling
overhead; these are whole-Gateway costs in an already started host, not isolated
schema construction, cold loading or plugin allocation costs. Neither session
creation nor plugin tools have an empty-host subtraction.

Setup and package installation are outside measured phases. Failed measured
calls are not retried. Missing or invalid boundary samples fail the observation
without changing the completed-call count; an unavailable midpoint stops work
before warm calls. A later failure preserves the successful first-call receipt.

After those matched phases, the conformance case uses `kitchen.resources` to
verify ten million CPU iterations and a fixed checksum, hold a 16 MiB Buffer,
and start a referenced 10 ms timer. Timer progress is observed with bounded
status probes. Each calibration operation counts one asserted control step,
including its probes; it is not an RPC throughput count. The fixture must include
the calibration controls from Kitchen Sink commit `051db418820c2f0a73f8d349c88eb002b3c2d6e2`
or later. Older fixtures fail visibly instead of skipping calibration.

The harness resets the controls, asserts empty owner state, then reacquires the
Buffer and timer before `plugins.setEnabled` disables the fixture. It requires
an applied runtime receipt, no restart or cleanup warnings, an inactive catalog,
and before/after samples from the same Gateway PID. This gives an in-process
retirement observation before normal Gateway shutdown. Forced termination or a
nonzero Gateway exit fails the report even when the process group is gone.

The report preserves raw phase-boundary snapshots, completed/failed operation
counts, provenance hashes and signed conformance-minus-empty deltas. CPU counters
cover the Gateway process and main thread, excluding separate child processes.
RSS is process-wide; other memory fields describe the main isolate. ArrayBuffers
overlap external memory. Boundary samples are not peaks, and no forced GC occurs.
Active-resource histograms count the types keeping the event loop alive, not
plugin ownership or all live objects. The report labels CPU, held-memory and timer
signals as observed or inconclusive; unrelated collection or host timers can
obscure them. Reset proves owner-state release, not immediate RSS reclamation.
The fixed post-work window is not a plugin drain receipt. Host shutdown is checked
separately; post-process-exit sampling and guaranteed reclamation remain unsupported.
These observations establish neither a leak nor a budget violation. Repeat comparable pairs through the campaign owner before drawing
performance conclusions; do not sum individual plugin costs.

### Plugin coverage inventory

Export the source plugin inventory before a profiling campaign:

```bash
pnpm --silent plugins:inventory:json > plugin-inventory.json
pnpm --silent plugins:inventory:json --commit <full-commit-sha> > plugin-inventory.json
```

The command reads committed Git objects, defaults to `HEAD`, and needs Git 2.45
or newer. It works without installed dependencies or a complete working tree.
Local edits do not affect the export. Missing objects fail the command; it does
not fetch them or load plugin code.

The versioned JSON includes the commit and tree, plugin IDs, relative paths,
package metadata, distribution classes, and declared surfaces. It shares the
documentation inventory's collector and distribution rules but excludes
docs-only external seeds. `sha256` hashes the payload without that field using
the shared stable JSON serializer (object keys sorted, array order preserved).
Declaration in this inventory is not evidence that a workload was exercised.
Keep import, registration, workload, and cleanup coverage separate when joining
profiling results to this inventory.

### Reusing the resource host

Source-checkout campaign tools can import `resolveResourceGatewayRuntime` and
`runResourceGatewayCase` from `scripts/e2e/kitchen-sink-rpc-walk.mts`. Kitchen Sink
uses this same host lifecycle. Run from one frozen, built OpenClaw package root
per process; this is a testing seam, not a published plugin SDK API.

The preparation callback receives an isolated config path, loopback port, test
token and a local-archive installer that verifies the supplied SHA-256. Enable
only the selected plugins there. The workload callback receives authenticated
CLI-mode RPC calls, resource snapshots and counted `measure(name, count, run)`
phases. Assert the active plugin inventory and operation results in the workload;
registration or a successful transport response alone does not establish coverage.
Pass `{ splitFirst: true }` as the fourth `measure` argument to retain a nested
first/warm breakdown with shared boundary samples and unchanged operation indices.

The host records startup, preserves failed phases and joins Gateway shutdown
before checking service-stop logs. A failed workload, nonzero exit, attempted
forced cleanup or shutdown error retains temporary state and fails the case.
The campaign owns bounded callback deadlines, mock-service cleanup, runner
isolation, repetitions and report publication. Keep mock-service measurements
separate from Gateway observations and preserve host, archive and harness hashes.
On an outer timeout, the runner must terminate and join the whole container or
cgroup: the Gateway has its own process group, so killing the campaign process
alone does not clean it up.

### Zod schema compilation

Compile individual schemas only after measuring a repeated validation path.
Use the pinned Zod package's `z.compile(schema)` API and retain the compiled
schema at its existing owner. The `zod/compile` side-effect import enables a
process-wide hook and is unsuitable for a selective optimization.

Nested tool activity validation compiles its schema on the first matching read
or creation and reuses it across Gateway turns. Ordinary transcript rows bypass
that compilation. Config, transcript entry, and browser relay schemas retain
their existing parsers because their measured caller costs did not justify
compilation.

Measure compilation and the first operation separately from warmed operations.
Compare valid, invalid, and mixed inputs through the actual caller, including
any JSON decoding, copying, or context construction it performs. For predicates
that discard parsed output, compare ordinary `safeParse(...).success`,
`z.validate(schema, input)`, and validation with a compiled schema; avoiding
error allocation can help independently of compilation.

Keep schemas shared with the strict-CSP Control UI uncompiled: explicit
compilation attempts code generation even when `jitless` is set. Reusing a
stable schema across calls is a separate optimization that needs no compiler.

Keep refinement and transform callbacks pure: an invalid compiled parse can
fall back to the runtime parser and execute those callbacks twice. Default
compilation preserves runtime fallback for unsupported schemas; async parsing
and encoding keep their existing runtime behavior.

## Benchmarks

<Accordion title="Session history (scripts/bench-session-history.ts)">

Measure SQLite history pages and the Gateway's bounded history reader with
synthetic conversations, including sparse markers, dense markers, and resets:

```bash
pnpm test:sessions:history:bench --samples 30 --output history.json
pnpm test:sessions:history:bench --profile sparse,trailing,reset --operation recent --analyze --samples 15 --output history-analyzed.json
```

The second command includes 5,000 trailing compaction markers and refreshes
SQLite planner statistics before reading. Compare both statistics states when
changing a query. `--operation` selects `recent`, `page`, or `gateway-tail`;
omitting it measures all three.

Each reader runs in a fresh process. Reports separate imports, the first read
(including database open), and warm p50/p95 wall and CPU time. OS caches are not
flushed. SQL plans, statement counts, rows delivered to JavaScript, and JSON
parsing counts come from a separate instrumented read. Heap deltas are
uncollected observations, not total allocations. Fixtures are removed afterward.

</Accordion>

<Accordion title="Model latency (scripts/bench-model.ts)">

```bash
pnpm tsx scripts/bench-model.ts --runs 10
```

Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`. Default prompt: "Reply with a single word: ok. No punctuation or extra text."

</Accordion>

<Accordion title="CLI startup (scripts/bench-cli-startup.ts)">

```bash
pnpm test:startup:bench
pnpm test:startup:bench:smoke
pnpm test:startup:bench:save
pnpm test:startup:bench:update
pnpm test:startup:bench:check
pnpm tsx scripts/bench-cli-startup.ts --runs 12
pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3
pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all
pnpm tsx scripts/bench-cli-startup.ts --runtime-rss --case status --runs 3
```

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
- `all`: both presets combined

Output includes `sampleCount`, avg, p50, p95, min/max, exit-code/signal distribution, and RSS per command. The `maxRssMb` fields use MiB. By default, RSS uses the last preload marker received on stderr, preserving the historical fixture's attribution. A respawning launcher can supply that last marker. Default reports omit `memoryMetric` and sample `memory`; no runtime identity or temporary observation files are required. For a silent command, the exit marker can count as first output.

Pass `--runtime-rss` to opt into runtime-process attribution. `primary.memoryMetric` identifies `cli-runtime-max-rss-v1`, and each sample's `memory` records PID, parent PID, role, and high-water RSS in bytes. The runtime is the terminal process in a unique matching CLI invocation chain; launcher and auxiliary observations are not added to it. This is not simultaneous process-tree memory.

High-water RSS is observed when the preload's `exit` listener runs. Allocations in later application exit handlers are outside this observation; this is not a full-lifetime OS measurement.

With `--runtime-rss`, the preload records observations in temporary files, separate from stdout/stderr and first-output timing. Runtime identity does not depend on command output; a silent entry has `firstOutputMs: null`. Missing or ambiguous runtime identity fails the sample only in this opt-in mode. Both modes are instrumented launches, separate from the no-preload, no-respawn `scripts/check-cli-startup-memory.mjs` diagnostic. `--cpu-prof-dir` / `--heap-prof-dir` write V8 profiles per run.

Saved-report comparison uses report metadata, not `--runtime-rss`. Comparison, enforced fixture budgets, and source-summary memory trends reject mixed legacy/runtime metrics rather than silently comparing different processes. Historical fixtures cannot be relabeled; any replacement baseline needs separate validation and approval.

Saved output: `pnpm test:startup:bench:smoke` writes `.artifacts/cli-startup-bench-smoke.json`; `pnpm test:startup:bench:save` writes `.artifacts/cli-startup-bench-all.json` (`runs=5 warmup=1`). Checked-in fixture: `test/fixtures/cli-startup-bench.json`, refreshed by `pnpm test:startup:bench:update`, compared by `pnpm test:startup:bench:check`.

</Accordion>

<Accordion title="Gateway startup (scripts/bench-gateway-startup.ts)">

Gateway startup, restart, and agent concurrency benchmark fixtures use temporary home and state directories, loopback binding, and `discovery.mdns.mode: "off"` so synthetic Gateways do not advertise on the LAN, including on macOS.

Defaults to the built CLI entry at `dist/entry.js`; run `pnpm build` first. Pass `--entry scripts/run-node.mjs` to measure the source runner instead, and keep those results separate from built-entry baselines.

```bash
pnpm test:startup:gateway -- --runs 5 --warmup 1
pnpm test:startup:gateway -- --case skipChannels --case fiftyPlugins --runs 5
node --import tsx scripts/bench-gateway-startup.ts --case default --runs 5 --output .artifacts/gateway-startup.json
node --import tsx scripts/bench-gateway-startup.ts --case incidentCombined --runs 5 --warmup 1 --timeout-ms 60000 --output .artifacts/gateway-startup-incident.json
```

Case ids: `default`, `skipChannels` (channel startup skipped), `oneInternalHook`, `allInternalHooks`, `fiftyPlugins` (50 manifest plugins), `fiftyStartupLazyPlugins` (50 startup-lazy manifest plugins), `incidentDatabase`, `incidentNullMetadata`, `incidentWorkspace`, `incidentPackagedPlugins`, and `incidentCombined`.

The incident cases are opt-in because each sample builds an isolated, non-sensitive load fixture: current global and agent databases, 100,000 retained audit rows with freelist fragmentation, eight agent workspaces containing 80,000 files (about 800 MB), and the packaged plugin inventory. Run the combined case only on a clean machine with enough free disk space; the fixture directory is removed after each sample. `incidentCombined` fails when `/healthz` p95 reaches 30 seconds or `/readyz` p95 reaches 60 seconds.

Output includes first process output, `/healthz`, `/readyz`, HTTP listen log time, Gateway ready log time, CPU time, CPU core ratio, max RSS, heap, startup trace metrics, event-loop delay, and plugin lookup-table detail metrics. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` in the child Gateway environment.

`/healthz` is liveness (HTTP server can answer). `/readyz` is usable readiness (startup plugin sidecars, channels, and ready-critical post-attach work have settled). Startup hooks dispatch asynchronously and are not part of the readiness guarantee. Ready log time is the Gateway's internal timestamp, useful for process-side attribution but not a substitute for the external `/readyz` probe.

Use JSON output or `--output` when comparing changes. Use `--cpu-prof-dir` only after trace output points at import, compile, or CPU-bound work that phase timings alone cannot explain.

After readiness, the Gateway uses idle turns to prepare common Control UI handler
modules and configured local agent skill discovery. Each item yields to admitted
foreground work, and shutdown joins preparation that has already started. This
work does not execute chat requests, create connection state, or fetch live provider
catalogs. Context-window cache preparation shares this sequence and starts no
earlier than five seconds after scheduling. Compare immediate first requests with
requests after an idle interval; readiness alone does not guarantee every optional
cache is warm.

</Accordion>

<Accordion title="Workspace computation (scripts/bench-workspace-computation.ts)">

Compare workspace inventory, manifest capture, and result preparation against a
frozen source checkout with its own installed dependencies:

```bash
node --import ./scripts/tsx.mjs scripts/bench-workspace-computation.ts \
  --baseline /path/to/baseline-checkout \
  --scenarios inventory,manifest,delta,unchanged \
  --sizes 1000,32000,100000 --concurrency 1,4 \
  --runs 3 --warmup 1 --output .artifacts/workspace-computation.json
```

Use `--changed-files 2000 --scenarios delta --sizes 32000` to include a larger
changed payload, and `--file-bytes` to vary the content hashed during capture.
The default workload is smaller: 1,000 entries and one concurrent operation.

The benchmark checks identical inventory bytes, manifest references, and changed
payloads. Separate processes measure first invocation and warm throughput, CPU,
event-loop delay, memory, and HTTP latency from an external probe. Worker task
diagnostics distinguish queueing, input preparation, transfer, and execution.
The HTTP probe measures responsiveness of the computation's owning process;
paired-node wire tests provide the full Gateway dispatch and reconciliation proof.

</Accordion>

<Accordion title="Gateway concurrency (scripts/bench-gateway-concurrency.ts)">

Runs synthetic streaming agent turns in parallel sessions on one isolated
Gateway. Add tool calls, session history, observers, and control-plane probes to
reproduce allocation pressure from a busy Gateway. Build with `pnpm build`
first. The default mock provider needs no key. Dreaming is disabled in this
isolated benchmark; ordinary indexing, recaps, and database idle retention keep
their normal settings.

If a sample fails, `--output` and `--json` retain completed measured runs,
completed `warmupRuns`, and a `failedAttempt` with its phase, one-based index,
available observations, and workload, diagnostics, or cleanup errors. Failed
attempts and warmups do not enter aggregate summaries. Null or absent partial
measurements mean unavailable, not zero. The command still exits with status 1;
live and activity-summary diagnostic failure sidecars remain available.

```bash
pnpm test:gateway:concurrency -- --concurrency 16 --tool-events --workspace-fanout --session-count 100 --history-messages 20 --history-clients 4 --subscribers 4 --visible-observer --control-plane --heap-prof-dir .artifacts/gateway-heap --output .artifacts/gateway-concurrency.json
pnpm test:gateway:concurrency -- --concurrency 64 --turns-per-session 8 --tool-events --timeout-ms 600000 --heap-prof-dir .artifacts/gateway-sustained-heap --output .artifacts/gateway-sustained.json
```

Use `--provider openai` with `OPENAI_API_KEY` supplied in the environment for
real OpenAI turns:

```bash
pnpm test:gateway:concurrency -- --provider openai --runs 1 --warmup 0 \
  --agent-warmup-turns 0 --agent-count 32 --concurrency 32 --turns-per-session 3 \
  --session-count 1000 --history-messages 20 --history-message-chars 1024 \
  --probe-rounds 64 --cadence-ms 100 --session-updates 100 \
  --session-update-clients 2 --history-clients 2 --history-burst 2 \
  --subscribers 4 --control-plane --timeout-ms 120000 \
  --load-cpu-prof-dir .artifacts/gateway-live-cpu \
  --output .artifacts/gateway-live.json
```

Live mode uses a fixed OpenAI model, denies tools, and limits output to 128
tokens. It permits one run with no warmups and at most 96 turns, and checks
streamed replies, terminal receipts, history, and persisted replies after
shutdown. It does not report synthetic provider request counts. CPU profiles
are instrumented observations; keep them separate from unprofiled latency
measurements. The [manual workflow](/ci/scheduled-workflows#gateway-concurrency-benchmark)
runs this workload with repository-managed credentials.

`--concurrency` controls parallel sessions; `--turns-per-session` controls serial
turns in each session (default 1, maximum 100). The second example completes 512
turns across 64 sessions. Each session starts its next turn as soon as its
previous turn completes, retaining its conversation history and workspace;
there is no barrier between rounds. The fresh-connection probe runs once after
every session has started its first turn. `--tool-events` requires a matching
successful `exec` result and the expected visible final reply on every turn,
including follow-ups. Missing or duplicate tool evidence fails the run. The load
timeout bounds turns and probes; startup, setup, and probe warmup have separate
budgets. Health/control sampling is capped at 2,048 samples, while heap
sampling continues until the full workload finishes.

The fixture gives the utility model its own structured mock response, preserving
the agent model's automatic tool loop. `turnEvidence.observerModelDigestTurns`
counts turns with a published model-derived observer digest. A short run can
legitimately report zero; observer correctness proof requires a positive count.

`mockRequests` retains six mock-server counter checkpoints and their parent
monotonic request bounds. Ingress deltas cover `startupAndWarmup` (readiness,
connect, visibility, and probe warmup), `setup`, `agentWarmup` (optional agent
turns on the same Gateway), `loadBracket`, and `postLoad` (through Gateway
shutdown). The `agentWarmup` bracket remains present when `--agent-warmup-turns`
is zero (the default); warmup turns are excluded from measured load. These
deltas distinguish Responses, Chat Completions, embeddings, and other routes,
including rejected request bodies; health and
model-catalog reads are excluded. These HTTP brackets are not exact CPU capture
windows or causal attribution. `selections` through the final checkpoint separately
count model/global controlled responses and automatic tool/text branches, not completed
responses. Auxiliary model requests remain included; neither total is a count
of agent turns. Missing, regressing, or replaced-server checkpoints fail instead
of becoming zero. Reports retain counters, not raw prompts or request bodies.

`--agent-count N` distributes the same session inventory round-robin across
1–128 configured agents. It defaults to one agent and cannot exceed the larger
of `--session-count` and `--concurrency`. Increasing it does not add sessions or
turns. Multi-agent runs use `main`, `bench-agent-2`, and subsequent IDs with
separate workspaces. `--workspace-fanout` still assigns a distinct workspace per
session. Separate browser click targets remain on `main`.

For example, `--agent-count 32 --session-count 1000 --concurrency 32
--turns-per-session 3` seeds 1,000 sessions and completes 96 turns, three per
agent. Before the load window and its CPU/allocation profiling, multi-agent runs
require each agent's current published configured model through `models.list`,
then verify its complete seeded inventory and reported per-agent SQLite path
through all pages of scoped `sessions.list` reads. This checks the Gateway's
reported storage route; it does not independently inspect database files.
`agentCoverage.beforeLoad` retains the model response and every session page.
`activeTurnAgentIds` and
`completedTurns` distinguish the agents handling turns from the configured
roster: 128 configured agents with 16 parallel sessions does not mean 128 agents
handled turns. Multi-agent history probe rows retain `sessionKey`, which maps
successful requests to the independently verified store inventory. These extra
setup reads do not run in the default one-agent case.

Use `--probe-rounds N` for allocation comparisons with equal probe work. It
attempts exactly N sampler rounds and N history bursts per configured history
client, regardless of which finishes first. Each sampler round requests
`/readyz`, the Control UI, and `sessions.list`; `--control-plane` adds one each
of `cron.list` and `cron.status`. Enabling `--subscribers` adds
one subscribe attempt per round and an unsubscribe after each successful
subscription. History attempts total `N × historyClients × historyBurst`, capped
at 2048 per run. Slow clients receive the same history budget as fast clients.
Failed probes remain recorded failures; counts describe attempts, not successes.
Omitting the flag retains adaptive probing until agent turns and mutations end.

Fixed probes can finish before or after agent turns. Every configured workload
joins before final memory and allocation capture; an exhausted load deadline
fails the run instead of reporting a partial fixed workload as complete. Output
records the mode and requested counts in `probeWorkload`; actual sampler and
history counts remain in `summary.sampleCount` and `summary.historySampleCount`.
Peak RSS is sampled during sampler rounds plus the final memory observation. If
those rounds finish early, a later transient RSS peak can be missed; this is not
continuous peak-RSS coverage of the entire agent workload.
Equal request counts do not equalize their overlap with agent turns or the
Gateway's time-dependent background work.

Each run's `cpuUsage` records user, system, and total CPU milliseconds for the
Gateway process and its main thread. Two private IPC snapshots bound the load
after setup and profiler activation through completion of all configured work,
before the final memory probe, profile export, and teardown. Their child-side
monotonic timestamps define `wallMs`; CPU time can exceed wall time when threads
run in parallel. Ordinary runs do not connect an inspector or start a profiler.

The process counters include Workers and native threads, including Workers that
exit during the load, but exclude separate child processes, the mock provider,
and the browser. Main-thread CPU is part of process CPU; do not add them. Their
difference estimates work on other threads, with small skew from reading the
counters sequentially. The summary reports `gatewayProcessCpuMs`,
`gatewayProcessCpuMsPerTurn`, `gatewayMainThreadCpuMs`, and
`gatewayProcessCpuCoreRatio`. CPU per turn includes the configured concurrent
probes and mutations. Compare fixed workloads and identical profiling settings;
moving work to Workers can improve responsiveness without reducing process CPU.
The existing `cpuCoreRatio` summary remains sampled readiness-window data.

To measure clicking an existing session in the Control UI sidebar during load,
build the UI and install Playwright Chromium, then enable the browser probe:

```bash
pnpm ui:build
pnpm --dir ui exec playwright install chromium
pnpm test:gateway:concurrency -- --session-count 1000 --concurrency 16 --turns-per-session 2 --browser-session-clicks 3 --browser-history-messages 80 --timeout-ms 240000 --no-diagnostics-timeline --output .artifacts/gateway-session-clicks.json
```

`--browser-session-clicks` defaults to 0 and accepts up to 20 first visits,
followed by one revisit to a recent pane. The probe seeds separate idle click
targets after the inventory. `--browser-history-messages` defaults to 80 per
target (maximum 500), independent of `--history-messages`, so a large inventory
does not require history in every session. `--history-message-chars` also sizes
the browser targets' synthetic Markdown. The browser uses the built assets in
`dist/control-ui`; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an installed
Chromium executable.

`browser.inventory` records requested load and click target counts alongside
the authoritative unarchived and retained session counts before load, including
the click targets. Retained counts include archived sessions; normal inventory
maintenance can reduce the unarchived count during seeding.

Each run's `browser.clicks` records time from the actual browser click event to
the target pane's visible history, enabled composer, and successful transcript load
followed by a paint opportunity (`readyMs`). These timings exclude Playwright
actionability waits. RPC `windowStartMs` offsets begin before that wait;
`latencyMs` measures the observed request/response round trip. Request records
include socket identity, method, session key, success, error, and response bytes.
An `inherited` request began before the click window and has a negative
`windowStartMs`; its latency includes the earlier wait. Completed click records
remain unchanged when a later window observes the response. The probe includes
message subscribe/unsubscribe requests to expose subscription recovery waits.
`connections` records observed socket, hello, and outer event sequence gaps;
negative offsets include recent setup events. Close events report observed inbound
silence, without inferring a close reason. `paneStates` records changes to the selected pane's loading,
readiness, connection epoch, and rendered history error. A displayed history
failure retains visible-history/composer timings but fails the click instead of
counting as ready. Browser `longTasks`
contains the milliseconds each observed long task overlaps the click-to-ready
interval, separate from the Gateway's Node CPU, event-loop, and memory
samples. Pre-load `/new` and initial-session timings stay outside the click
summary. Compare first visits and cached revisits separately, and check
`activeLoadAtStart`, `activeLoadAtFinish`, and `samplesOutsideActiveLoad` before
attributing latency to concurrent work. A recorded click failure makes the benchmark
exit unsuccessfully after writing its report.

`--heap-prof-dir` samples allocations in the Gateway's main V8 isolate, starting
after startup, session seeding, and probe warmup. Sampling ends after the load
and its final memory probe, before profile serialization and teardown. It uses
a 32 KiB sampling interval and includes objects collected by both minor and
major GC, so `sampledAllocatedBytes` estimates gross allocations rather than
retained heap. Each run records its `.heapprofile` path and the twenty largest
allocation stacks with `scope: "main-isolate"`; open the raw file in the Chrome
DevTools Memory panel. Worker isolates have separate profiles, described below.
Native allocations are outside these V8 profiles.

The summary includes sampled allocation bytes per run and per completed turn.
The per-turn figure also includes concurrent probes and session mutations;
compare identical workload settings and Node versions across multiple runs.
Initial and follow-up turns overlap across sessions, so the allocation profile
covers their combined workload rather than attributing separate cold and warm
allocations. Compare matched one-turn and sustained runs to study reuse.
Sampling is statistical and adds overhead. Use unprofiled runs for latency
comparisons. Existing heap/RSS measurements are taken before exporting the
profile. `--cpu-prof-dir` remains available separately and includes startup;
the recorded `loadWindow` identifies the measured interval in that CPU profile.

For CPU attribution during concurrent work, including on Windows, add
`--load-cpu-prof-dir .artifacts/gateway-load-cpu`. This captures the Gateway's
main V8 isolate at a 1 ms sampling interval after setup and through the final
memory probe. The private benchmark IPC channel stops the profiler and writes
the `.cpuprofile` before process teardown, without depending on signal-driven
profile flushing. Each run's `loadCpuProfile` records its path, duration, and
sample count with `scope: "main-isolate"`; open the raw profile in Chrome
DevTools. Profiled runs add overhead, so keep them separate from latency
comparisons. `--cpu-prof-dir` retains its startup-inclusive native profiling
behavior. `--load-cpu-prof-dir` and `--heap-prof-dir` require separate runs so
exporting one profile cannot contaminate the other capture.

Both load-profile flags also capture observed Worker isolates over the existing
private inspector connection. The main profile summary links
`workersManifestPath`, a `.workers.json` manifest beside the main profile. Its
rows distinguish native `threadId` from `inspectorWorkerId` and link each
Worker's profile. `completed: true` means that profile was written; inspect
row-level errors for missing identity, retired Workers, or other incomplete
captures. A successful profiling command does not mean every Worker produced a
usable profile. Workers are not paused at birth, so profiling can miss their
earliest work. These files exclude separate child processes.

The Worker manifest's samples use `performance.now` in the Gateway process, with
timestamps taken before asynchronous Worker reads. The 100 ms cadence is
nominal; overlapping reads are coalesced. CPU counters are cumulative
microseconds: difference observations for the same thread identity instead of
summing samples. Those deltas cover each Worker's observed interval and can
miss work before its first or after its last successful sample. The sample's
`memory.rss` covers the process; other `memory` fields describe the main isolate,
while each Worker's `heap` contains its own V8 heap statistics.

Capture windows differ: load CPU counters end before the final memory probe;
the main V8 profile includes that probe; Worker profiles and samples also extend
through main-profile serialization before their own stop. Use the raw CPU
profiles' timestamps and manifest observations for attribution, and keep these
windows separate from `cpuUsage`. Main-thread CPU plus observed Worker CPU does
not account for every native thread or unobserved Worker interval. Profiling and
periodic Worker inspection add overhead; compare equally instrumented runs.

Both load-phase profile modes also attach `diagnostics` and a `diagnosticsPath`
to the run report. The private benchmark preload subscribes only during capture
and aggregates the main isolate's redaction, session writer, session list, and
worker-task completion records, including fast work below slow-log thresholds.
It records counts, totals, and maxima in at most 256 groups; `droppedEvents`
and `collectionErrors` report incomplete collection. No per-call record history,
session or agent IDs, paths, message text, regex patterns, or exception text is
retained in these aggregates. Worker artifact basenames identify task groups.

Redaction reports synchronous thread CPU separately from elapsed time and input
UTF-16 character counts. These are inclusive measurements: nested redaction
operations overlap, so do not add their times. Session writer timing separates
queue wait, writer-held elapsed time, and completion delay. List records
distinguish `sessions.list` from the initial `sessions.subscribe` snapshot and
separate projection owners, in-flight followers, and completed cache hits.
Worker-task records separate queue, preparation, run, and transfer measurements.
Elapsed intervals can overlap across concurrent work and do not measure CPU.

The capture also aggregates main-isolate GC pause entries. Allocation profiles
identify allocation sites, including collected objects; they do not establish
which objects remain reachable or prove a leak. Raw profiles contain function
names and source locations and need inspection before sharing.

These diagnostics channels have no collector in an ordinary Gateway. The
benchmark uses isolated synthetic state, private process IPC, and no inspector
listener. It does not attach to or modify an existing operator Gateway.

</Accordion>

<Accordion title="Gateway restart (scripts/bench-gateway-restart.ts)">

macOS and Linux only (uses SIGUSR2 for in-process restarts; fails immediately on Windows). Same built-entry default and `--entry scripts/run-node.mjs` override as gateway startup above.

```bash
pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5
pnpm test:restart:gateway -- --case default --runs 3 --restarts 3 --warmup 1
```

Case ids: `skipChannels`, `skipChannelsAcpxProbe` (ACPX startup probe on), `skipChannelsNoAcpxProbe` (probe off), `default`, `fiftyPlugins`.

Output includes next `/healthz`, next `/readyz`, downtime, restart ready timing, CPU, RSS, startup trace metrics for the replacement process, and restart trace metrics for signal handling, active-work drain, close phases, next start, ready timing, and memory snapshots. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` and `OPENCLAW_GATEWAY_RESTART_TRACE=1`.

Use this benchmark when a change touches restart signaling, close handlers, startup-after-restart, sidecar shutdown, service handoff, or readiness after restart. Start with `skipChannels` to isolate Gateway mechanics from channel startup; use `default` or plugin-heavy cases only after the narrow case explains the restart path. Trace metrics are attribution hints, not verdicts — judge a restart change from multiple samples, the matching owner span, `/healthz`/`/readyz` behavior, and the user-visible restart contract.

</Accordion>
