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

## Benchmarks

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
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `tasks --json`, `tasks list --json`, `tasks audit --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
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

</Accordion>

<Accordion title="Gateway concurrency (scripts/bench-gateway-concurrency.ts)">

Runs synthetic streaming agent turns in parallel sessions on one isolated
Gateway. Add tool calls, session history, observers, and control-plane probes to
reproduce allocation pressure from a busy Gateway. Build with `pnpm build`
first; no provider key is required.

```bash
pnpm test:gateway:concurrency -- --concurrency 16 --tool-events --workspace-fanout --session-count 100 --history-messages 20 --history-clients 4 --subscribers 4 --visible-observer --control-plane --heap-prof-dir .artifacts/gateway-heap --output .artifacts/gateway-concurrency.json
pnpm test:gateway:concurrency -- --concurrency 64 --turns-per-session 8 --tool-events --timeout-ms 600000 --heap-prof-dir .artifacts/gateway-sustained-heap --output .artifacts/gateway-sustained.json
```

`--concurrency` controls parallel sessions; `--turns-per-session` controls serial
turns in each session (default 1, maximum 100). The second example completes 512
turns across 64 sessions. Each session starts its next turn as soon as its
previous turn completes, retaining its conversation history and workspace;
there is no barrier between rounds. The fresh-connection probe runs once after
every session has started its first turn. `--tool-events` requests a tool call
on every turn, including follow-ups. The per-run timeout still bounds the whole
workload. Health/control sampling is capped at 2,048 samples, while heap
sampling continues until the full workload finishes.

Use `--probe-rounds N` for allocation comparisons with equal probe work. It
attempts exactly N sampler rounds and N history bursts per configured history
client, regardless of which finishes first. Each sampler round requests
`/readyz`, the Control UI, and `sessions.list`; `--control-plane` adds one each
of `tasks.list`, `cron.list`, and `cron.status`. Enabling `--subscribers` adds
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
retained heap. Native allocations and separate worker isolates are outside this
profile. Each run records its `.heapprofile` path and the twenty largest
allocation stacks; open the raw file in the Chrome DevTools Memory panel.

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
sample count; open the raw profile in Chrome DevTools. Worker isolates are not
included. Profiled runs add overhead, so keep them separate from latency
comparisons. `--cpu-prof-dir` retains its startup-inclusive native profiling
behavior. `--load-cpu-prof-dir` and `--heap-prof-dir` require separate runs so
exporting one profile cannot contaminate the other capture.

</Accordion>

<Accordion title="Gateway restart (scripts/bench-gateway-restart.ts)">

macOS and Linux only (uses SIGUSR1 for in-process restarts; fails immediately on Windows). Same built-entry default and `--entry scripts/run-node.mjs` override as gateway startup above.

```bash
pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5
pnpm test:restart:gateway -- --case default --runs 3 --restarts 3 --warmup 1
```

Case ids: `skipChannels`, `skipChannelsAcpxProbe` (ACPX startup probe on), `skipChannelsNoAcpxProbe` (probe off), `default`, `fiftyPlugins`.

Output includes next `/healthz`, next `/readyz`, downtime, restart ready timing, CPU, RSS, startup trace metrics for the replacement process, and restart trace metrics for signal handling, active-work drain, close phases, next start, ready timing, and memory snapshots. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` and `OPENCLAW_GATEWAY_RESTART_TRACE=1`.

Use this benchmark when a change touches restart signaling, close handlers, startup-after-restart, sidecar shutdown, service handoff, or readiness after restart. Start with `skipChannels` to isolate Gateway mechanics from channel startup; use `default` or plugin-heavy cases only after the narrow case explains the restart path. Trace metrics are attribution hints, not verdicts — judge a restart change from multiple samples, the matching owner span, `/healthz`/`/readyz` behavior, and the user-visible restart contract.

</Accordion>
