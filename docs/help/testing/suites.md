---
summary: "The unit, e2e, and live suites, which one to run, and the offline regression checks"
title: "Test suites and commands"
read_when:
  - You need to pick a test suite or command
  - You want to know what each suite covers
---

## Quick start

Most days:

- Full gate (expected before push): `pnpm build && pnpm check && pnpm check:test-types && pnpm test`
- Faster local full-suite run on a roomy machine: `pnpm test:max`
- Direct Vitest watch loop: `pnpm test:watch`
- Direct file targeting routes plugin/channel paths too: `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts`
- Prefer targeted runs first when iterating on a single failure.
- Docker-backed QA site: `pnpm qa:lab:up`
- Linux VM-backed QA lane: `pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline`

When you touch tests or want extra confidence:

- Informational V8 coverage report: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

Oxlint's `max-lines` rule warns when files exceed the per-scope limits in
`.oxlintrc.json`; these warnings remain visible in lint logs and do not fail CI.
PR CI and `pnpm check:changed` separately reject new line-cap violations and
growth in already over-cap files. The suppression baseline ratchet remains a
required check. See [surface ratchets](/ci/local-proof#surface-ratchets) for
comparison bases and shrink-only maintenance.

## Test suites (what runs where)

Think of the suites as "increasing realism" (and increasing flakiness/cost).

### Unit / integration (default)

- Command: `pnpm test`
- Config: untargeted runs use the `vitest.full-*.config.ts` shard set and may
  expand multi-project shards into per-project configs for parallel
  scheduling
- Files: core/unit inventories under `src/**/*.test.ts`,
  `packages/**/*.test.ts`, and `test/**/*.test.ts`; UI unit tests run in the
  dedicated `unit-ui` shard
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
  - Resolver and public-surface loader tests must prove broad `api.js` and
    `runtime-api.js` fallback behavior with generated tiny plugin fixtures,
    not real bundled plugin source APIs. Real plugin API loads belong in
    plugin-owned contract/integration suites.

Native dependency policy:

- Default test installs skip optional native Discord opus builds. Discord
  voice uses bundled `libopus-wasm`, and `@discordjs/opus` stays disabled in
  `allowBuilds` so local tests and Testbox lanes do not compile the native
  addon.
- Compare native opus performance in the `libopus-wasm` benchmark repo, not
  in default OpenClaw install/test loops. Do not set `@discordjs/opus` to
  `true` in the default `allowBuilds`; that makes unrelated install/test
  loops compile native code.

<AccordionGroup>
  <Accordion title="Projects, shards, and scoped lanes">

    - Untargeted `pnpm test` runs thirteen smaller shard configs (`core-unit-fast`, `core-unit-src`, `core-unit-security`, `core-unit-ui`, `core-unit-support`, `core-support-boundary`, `core-tooling`, `core-contracts`, `core-bundled`, `core-runtime`, `agentic`, `auto-reply`, `extensions`) instead of one giant native root-project process. This cuts peak RSS on loaded machines and avoids auto-reply/plugin work starving unrelated suites.
    - `pnpm test --watch` still uses the native root `vitest.config.ts` project graph, because a multi-shard watch loop is not practical.
    - `pnpm test`, `pnpm test:watch`, and `pnpm test:perf:imports` route explicit file/directory targets through scoped lanes first, so `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts` avoids paying the full root project startup tax.
    - `pnpm test:changed` expands changed git paths into cheap scoped lanes by default: direct test edits, sibling `*.test.ts` files, explicit source mappings, and local import-graph dependents. Config/setup/package edits do not broad-run tests unless you explicitly use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed`.
    - `pnpm check:changed` is the normal smart local check gate for narrow work. It classifies the diff into core, core tests, extensions, extension tests, apps, docs, release metadata, live Docker tooling, and tooling, then runs the matching typecheck, lint, and guard commands. Selected paths also schedule targeted Vitest owner tests via `pnpm test:serial`; use `pnpm test:changed` or explicit `pnpm test <target>` for additional test proof matching the touched contract. Release metadata-only version bumps run targeted version/config/root-dependency checks, with a guard that rejects package changes outside the top-level version field.
    - Live Docker ACP harness edits run focused checks: shell syntax for the live Docker auth scripts and a live Docker scheduler dry-run. `package.json` changes are included only when the diff is limited to `scripts["test:docker:live-*"]`; dependency, export, version, and other package-surface edits still use the broader guards.
    - Import-light unit tests from agents, commands, plugins, auto-reply helpers, `plugin-sdk`, and similar pure utility areas route through the `unit-fast` lane, which skips `test/setup-openclaw-runtime.ts`; stateful/runtime-heavy files stay on the existing lanes.
    - Selected `plugin-sdk` and `commands` helper source files also map changed-mode runs to explicit sibling tests in those light lanes, so helper edits avoid rerunning the full heavy suite for that directory.
    - `auto-reply` has dedicated buckets for top-level core helpers, top-level `reply.*` integration tests, and the `src/auto-reply/reply/**` subtree. CI further splits the reply subtree into agent-runner, dispatch, and commands/state-routing shards so one import-heavy bucket does not own the full Node tail.
    - Normal PR/main CI intentionally skips the bundled plugin batch sweep and release-only `agentic-plugins` shard. Full Release Validation dispatches the separate `Plugin Prerelease` child workflow for those plugin-heavy suites on release candidates.

  </Accordion>

  <Accordion title="Embedded runner coverage">

    - When you change message-tool discovery inputs or compaction runtime
      context, keep both levels of coverage.
    - Add focused helper regressions for pure routing and normalization
      boundaries.
    - Keep the embedded runner integration suites healthy:
      `src/agents/embedded-agent-runner/compact.hooks.test.ts`,
      `src/agents/embedded-agent-runner/run.overflow-compaction.test.ts`, and
      `src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts`.
    - Those suites verify that scoped ids and compaction behavior still flow
      through the real `run.ts` / `compact.ts` paths; helper-only tests are
      not a sufficient substitute for those integration paths.

  </Accordion>

  <Accordion title="Vitest pool and isolation defaults">

    - Base Vitest config defaults to `forks` on Windows and `threads` elsewhere.
      Windows workers need separate native handle tables: concurrent thread
      spawns can inherit another worker's temporary output pipe handles and
      prevent that worker's child cleanup from observing EOF. Worker counts
      and file parallelism remain unchanged.
    - The shared Vitest config fixes `isolate: false` and uses the
      non-isolated runner across the root projects, e2e, and live configs.
    - The root UI lane keeps its `jsdom` setup and optimizer, but runs on the
      shared non-isolated runner too.
    - Provider plugin shards reuse workers with the shared cleanup runner.
      Track global replacements with `vi.stubGlobal` so cleanup can restore them
      before the next file.
    - Each `pnpm test` shard inherits the platform pool and `isolate: false`
      defaults from the shared Vitest config unless its owner selects otherwise.
    - `scripts/run-vitest.mjs` adds `--no-maglev` for Vitest child Node
      processes by default to reduce V8 compile churn during big local runs.
      Set `OPENCLAW_VITEST_ENABLE_MAGLEV=1` to compare against stock V8
      behavior.
    - `scripts/run-vitest.mjs` terminates explicit non-watch Vitest runs
      when their configured no-output deadline expires. Expiry fails the run
      without retrying the shard, even when the child shuts down with exit code zero. Set
      `OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=0` to disable the watchdog for
      an intentionally silent investigation.
    - `scripts/run-tsgo.mjs` leaves tsgo unbounded by default, preserving the
      behavior of existing local workflows. Set `OPENCLAW_TSGO_TIMEOUT_MS` to
      a positive millisecond value to make a wedged compiler fail loudly
      instead of blocking its caller forever. On expiry the whole tsgo process
      tree is killed and the run fails. Values above Node's timer
      ceiling saturate at it instead of collapsing to a 1ms deadline; `0`, a
      negative, a fraction, or anything above `Number.MAX_SAFE_INTEGER` is
      rejected and fails the run. Surrounding whitespace is trimmed first;
      the remaining value must use plain decimal digits without leading zeros,
      so values such as `1e5` or `007` are rejected. Unset the variable to
      disable the watchdog.

  </Accordion>

  <Accordion title="Fast local iteration">

    - `pnpm changed:lanes` shows which architectural lanes a diff triggers.
    - The pre-commit hook formats and restages files. When private rules are
      configured, it also scans staged content before and after formatting.
      See [Local commit hook setup](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md#local-commit-hook).
      It does not run lint, typecheck, or tests.
    - Run `pnpm check:changed` explicitly before handoff or push when you
      need the smart local check gate.
    - `pnpm test:changed` routes through cheap scoped lanes by default. Use
      `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the agent
      decides a harness, config, package, or contract edit really needs
      broader Vitest coverage.
    - `pnpm test:max` and `pnpm test:changed:max` keep the same routing
      behavior, just with a higher worker cap.
    - Local worker auto-scaling is intentionally conservative and backs off
      when the host load average is already high, so multiple concurrent
      Vitest runs do less damage by default.
      CI hosts with at least eight available CPUs can use six workers at
      24 to below 28 GiB and eight workers at 28–128 GiB. The measured memory allowance
      reserves 25% of RAM even for two heavy test processes. Interactive local
      sizing is unchanged; explicit worker overrides, load backoff, process
      memory constraints, free-memory pressure limits, and the 16-worker cap
      still apply. See [CI worker sizing](/ci/capacity#vitest-worker-sizing)
      for the measurements and workflow limits.
    - The base Vitest config marks the projects/config files as
      `forceRerunTriggers` so changed-mode reruns stay correct when test
      wiring changes.
    - The config keeps `OPENCLAW_VITEST_FS_MODULE_CACHE` enabled on
      supported hosts; set `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/abs/path`
      for one explicit cache location for direct profiling.
    - Local Node runs also reuse compiled runtime-worker outputs from
      `.artifacts/vitest-worker-cache`. The runner reserves an exclusive
      checkout-local output slot and transfers verified artifacts into that slot.
      After its borrowers and resources join, it transfers completed artifacts
      back to the cache and removes the invocation directory. Occupied or
      uncertain generations are never reclaimed automatically.
      Content, compiler, configuration, or resolution changes invalidate the
      seed; timestamp-only touches do not. Build provenance and resource receipts
      are refreshed for each invocation, and source/output verification still
      runs before lending and after completion. Cold cache-enabled preparation overlaps
      the independent worker and finalizer builds when at least 8 GiB of memory
      is available; smaller hosts keep sequential compilation. CI keeps fresh compilation
      unless its workflow enables `OPENCLAW_VITEST_WORKER_CACHE=1` after restoring
      a protected cache. Only the protected warmer publishes shared generations;
      ordinary CI jobs remain remote-cache readers. Reuse requires the same
      absolute checkout and reserved output paths, Node version, compiler options,
      and verified inputs. Incompatible or missing generations compile normally.
      Bun and custom Node loader runs keep fresh compilation.
      This cache does not share Vitest's writable
      filesystem module cache with another checkout.

  </Accordion>

  <Accordion title="Perf debugging">

    - `pnpm test:perf:imports` enables Vitest import-duration reporting plus
      import-breakdown output.
    - `pnpm test:perf:imports:changed` scopes the same profiling view to
      files changed since `origin/main`.
    - Shard timing data is written to `.artifacts/vitest-shard-timings.json`.
      Whole-config runs use the config path as the key; include-pattern CI
      shards append the shard name so filtered shards can be tracked
      separately.
    - When one hot test still spends most of its time in startup imports,
      keep heavy dependencies behind a narrow local `*.runtime.ts` seam and
      mock that seam directly instead of deep-importing runtime helpers
      just to pass them through `vi.mock(...)`.
    - `pnpm test:perf:changed:bench -- --ref <git-ref>` compares routed
      `test:changed` against the native root-project path for that
      committed diff and prints wall time plus macOS max RSS.
    - `pnpm test:perf:changed:bench -- --worktree` benchmarks the current
      dirty tree by routing the changed file list through
      `scripts/test-projects.mts` and the root Vitest config.
    - `pnpm test:perf:profile:main` writes a main-thread CPU profile for
      Vitest/Vite startup and transform overhead.
    - `pnpm test:perf:profile:runner` writes runner CPU+heap profiles for
      the unit suite with file parallelism disabled. Profiles span each worker's
      files and finish before teardown acknowledgement, including failed runs.
      Both commands print their output directory; see [Test performance tooling](/reference/test/performance#test-performance-tooling)
      for output selection, capture boundaries, and supported runners.

  </Accordion>
</AccordionGroup>

### Stability (gateway)

- Command: `pnpm test:stability:gateway`
- Config: `test/vitest/vitest.gateway.config.ts`, `test/vitest/vitest.logging.config.ts`, and `test/vitest/vitest.infra.config.ts`, each forced to one worker
- Scope:
  - Starts a real loopback Gateway with diagnostics enabled by default
  - Drives synthetic gateway message, memory, and large-payload churn through the diagnostic event path
  - Queries `diagnostics.stability` over the Gateway WS RPC
  - Covers diagnostic stability bundle persistence helpers
  - Asserts the recorder remains bounded, synthetic RSS samples stay under the pressure budget, and per-session queue depths drain back to zero
- Expectations:
  - CI-safe and keyless
  - Narrow lane for stability-regression follow-up, not a substitute for the full Gateway suite

### E2E (repo aggregate)

- Command: `pnpm test:e2e`
- Scope:
  - Runs the gateway smoke E2E lane
  - Runs the mocked Control UI browser E2E lane
- Expectations:
  - CI-safe and keyless
  - Requires Playwright Chromium to be installed

### E2E (gateway smoke)

- Command: `pnpm test:e2e:gateway`
- Config: `test/vitest/vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`, `test/**/*.e2e.test.ts`, and bundled-plugin E2E tests under `extensions/`
- Runtime defaults:
  - Uses Vitest `threads` with `isolate: false`, matching the rest of the repo.
  - Uses one worker by default to keep non-isolated gateway state deterministic.
  - Runs in silent mode by default to reduce console I/O overhead.
- Useful overrides:
  - `OPENCLAW_E2E_WORKERS=<n>` to opt into parallel workers (capped at 16).
  - `OPENCLAW_E2E_VERBOSE=1` to re-enable verbose console output.
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### E2E (Control UI mocked browser)

- Command: `pnpm test:ui:e2e`
- Config: `test/vitest/vitest.ui-e2e.config.ts`
- Files: `ui/src/**/*.e2e.test.ts` and the QA Lab media-transcript real-Gateway suite
- Scope:
  - Uses four resource groups in two execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` share the parallel phase (at most two workers total); `ui-e2e-serial` and `ui-e2e-serial-standalone` share the later single-worker phase
  - The two bundle-consuming projects lazily acquire one temporary UI bundle/preview per invocation; standalone projects own their fixture, source, or custom-build servers
  - Selecting only standalone suites skips the shared bundle build; new E2E files default to bundled ownership
  - Every selected project discovers Chromium and drives real pages through Playwright; the root config retains the complete discovery inventory
  - Most suites replace the Gateway WebSocket with deterministic in-browser mocks; some start isolated real Gateways
- Expectations:
  - Runs in CI as part of `pnpm test:e2e`; the resource groups add no CI jobs
  - No provider keys required; `OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY=1` excludes real-Gateway suites
  - Browser dependency must be present (`pnpm --dir ui exec playwright install chromium`)

The dedicated real-Gateway CI lane uses `test/vitest/vitest.ui-e2e-prebuilt.config.ts` after `OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm build` completes in each clean checkout. The separate artifact job retains SDK declaration validation. The planner balances existing serial files and selected standalone companions in one row, with the remaining audited parallel files in another. The companions share the existing two-worker phase after serial execution without an extra bundled preview. The real node/SSH desktop resize tour is release-only: when its file is selected by full manual/release validation or a direct spec edit, the first row runs `node --import tsx scripts/test-desktop-resize-real.mts` once for both carriers. The bootstrap remains required; invoking the desktop spec without its real fixture is not equivalent proof. Frequent resize, revocation, view-only filtering, takeover, and UI sizing tests remain in ordinary CI. Placement consumes the parallel-eligibility allowlist from `vitest.ui-paths.mjs` without changing Vitest scheduling. Each selected file has one CI owner; the desktop bootstrap executes each carrier once. Full manual and release selection retain the complete inventory. Prebuilt previews borrow the validated canonical Control UI assets without rebuilding or deleting them; default mocked Gateway hellos use the same artifact identity, and explicit mock identity overrides still apply. Ordinary local runs retain their private builds. Keep source and built outputs unchanged until all workers and children finish. Fixtures retain their private HOME, state, ports, cleanup, and existing worker limits. Readiness failures stop without rebuilding or falling back. The ordinary local config keeps real-Gateway files serial; frozen targets and older planners retain one complete CI row and their own config/command. See [CI](/ci) for the resource policy and timing evidence.

### Network-isolated local E2E

When Chromium is available, UI E2E setup proves loopback HTTP through the parent
Node process's normal `fetch` before acquiring Gateway fixtures or the shared UI
build. A proxy refusal or malformed response fails this environment preflight
with a sanitized error instead of consuming the Gateway startup budget. Existing
optional missing-browser skips remain unchanged. If later Gateway readiness
expires, its error also retains the last completed HTTP failure so a final
deadline-edge timeout does not hide useful status and error-category evidence.

Gateway-hosted exec can inherit the [secret egress proxy](/gateway/secrets/secret-store-and-egress#secret-egress-proxy). Its plain-HTTP refusal also applies to a test process calling its own loopback fixture. A Gateway can therefore log that it is ready while its parent receives a proxy error from `/readyz`. Building the UI again or increasing the readiness timeout does not repair that transport mismatch.

For trusted, keyless local tests, run the complete invocation in an isolated Linux container instead. Select an already prepared, trusted image by its full image ID or digest; the runner never pulls an image or falls back to the host:

```bash
node scripts/run-vitest.mjs --isolated-image "$IMAGE_ID" run \
  --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner \
  ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts
```

The adapter requires Linux, an existing rootless Podman installation, checkout-local `pnpm install --frozen-lockfile` dependencies, and native Node and pnpm executables compatible with the image. Put the native pnpm executable matching `package.json` on `PATH`, or select it through the existing `npm_execpath` environment variable; a Corepack/download shim is not an offline executable. The image must already contain the Chromium revision required by the installed Playwright package under `/ms-playwright`, including its headless shell and system libraries. The runner checks versions and launches Chromium before starting the test command. SELinux-labeled hosts are not supported by this initial adapter: it refuses before creating a container rather than relabeling shared host files or disabling enforcement. Use an already supported isolated runner instead of changing host security policy.

It runs Vitest, Chromium, the provider fixture, and the test Gateway in the same network-none namespace. Host proxy settings stay unchanged; host credentials, Gateway state, Git metadata, and private scratch are not exposed to the container. There are no published ports or external network access. Missing prerequisites fail with setup guidance instead of installing packages or weakening isolation.

Use the ordinary local config, not the CI-only prebuilt config. For the canonical Control UI E2E config, the adapter runs the existing private-QA `ciArtifacts` build inside the container before admitting tests; backend readiness alone does not mean the dashboard assets are ready. The isolated source snapshot uses tracked working-tree files, including staged new files; stage a new test before selecting it. Keep source and dependencies unchanged during the invocation, and keep dependency installation separate. The initial interface supports exact tracked test files, a tracked config, and console reporters; it does not export files from the disposable snapshot. This route is not suitable for live-provider tests or tests that must contact services outside their own container.

### E2E: OpenShell backend smoke

- Command: `pnpm test:e2e:openshell`
- File: `extensions/openshell/src/backend.e2e.test.ts`
- Scope:
  - Reuses an active local OpenShell gateway
  - Creates a sandbox from a temporary local Dockerfile
  - Exercises remote and default mirrored OpenShell backends over real SSH
  - Creates an isolated non-default OpenShell workspace and custom workspace roots
  - Verifies nested mirrored file writes and excludes host Git metadata and hooks
  - Verifies remote-canonical filesystem behavior through the sandbox fs bridge
- Expectations:
  - Opt-in only; not part of the default `pnpm test:e2e` run
  - Requires a local `openshell` CLI plus a working Docker daemon
  - Requires an active local OpenShell gateway and its config source
  - Uses isolated `HOME` / `XDG_CONFIG_HOME`, then waits for durable sandbox absence before deleting the test workspace
  - Reports cleanup failures, including failed inventory queries; it does not retry database errors
- Useful overrides:
  - `OPENCLAW_E2E_OPENSHELL=1` to enable the test when running the broader e2e suite manually
  - `OPENCLAW_E2E_OPENSHELL_COMMAND=/path/to/openshell` to point at a non-default CLI binary or wrapper script
  - `OPENCLAW_E2E_OPENSHELL_CONFIG_HOME=/path/to/config` to expose the registered gateway config to the isolated test
  - `OPENCLAW_E2E_OPENSHELL_HOST_IP=172.18.0.1` to replace the host policy fixture's default ranges with one explicit Docker gateway address and its existing `/32` suffix

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `test/vitest/vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`, `test/**/*.live.test.ts`, and bundled-plugin live tests under `extensions/`
- Default: **enabled** by `pnpm test:live` (sets `OPENCLAW_LIVE_TEST=1`)
- Scope:
  - "Does this provider/model actually work _today_ with real creds?"
  - Catch provider format changes, tool-calling quirks, auth issues, and rate limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer running narrowed subsets instead of "everything"
- Live runs use already-exported API keys and staged auth profiles.
- By default, live runs still isolate `HOME` and copy config/auth material into a temp test home so unit fixtures cannot mutate your real `~/.openclaw`.
- Set `OPENCLAW_LIVE_USE_REAL_HOME=1` only when you intentionally need live tests to use your real home directory.
- `pnpm test:live` defaults to a quieter mode: it keeps `[live] ...` progress output and mutes gateway bootstrap logs/Bonjour chatter. Set `OPENCLAW_LIVE_TEST_QUIET=0` if you want the full startup logs back.
- API key rotation (provider-specific): set `*_API_KEYS` with comma/semicolon format or `*_API_KEY_1`, `*_API_KEY_2` (for example `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`) or per-live override via `OPENCLAW_LIVE_*_KEY`; tests retry on rate limit responses.
- Progress/heartbeat output:
  - Live suites emit progress lines to stderr so long provider calls are visibly active even when Vitest console capture is quiet.
  - `test/vitest/vitest.live.config.ts` disables Vitest console interception so provider/gateway progress lines stream immediately during live runs.
  - Tune direct-model heartbeats with `OPENCLAW_LIVE_HEARTBEAT_MS`.
  - Tune gateway/probe heartbeats with `OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS`.

## Which suite should I run?

Use this decision table:

- Editing logic/tests: run `pnpm test` (and `pnpm test:coverage` if you changed a lot)
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging "my bot is down" / provider-specific failures / tool calling: run a narrowed `pnpm test:live`

## Live (network-touching) tests

For the live model matrix, CLI backend smokes, ACP smokes, Codex app-server
harness, and all media-provider live tests (Deepgram, BytePlus, ComfyUI,
image, music, video, media harness) - plus credential handling for live runs

- see [Testing live suites](/help/testing-live). For the dedicated update and
  plugin validation checklist, see
  [Testing updates and plugins](/help/testing-updates-plugins).

## Docs sanity

Run docs checks after doc edits: `pnpm check:docs`.
Run the shared publishing parser's anchor audit when you need in-page heading checks too: `pnpm docs:check-links:anchors`.
Diagnostics show `unknown` when a reliable source line is unavailable.

## Offline regression (CI-safe)

These are "real pipeline" regressions without real providers:

- Gateway agent admission (real Gateway with a mock OpenAI provider): `src/gateway/gateway.test.ts` (case: "accepts a gateway agent request over ws and returns a run id"; checks acceptance, a run ID, and an abort response).
- Gateway wizard (WS `wizard.start`/`wizard.next`, writes config + auth enforced): `src/gateway/gateway.test.ts` (case: "runs wizard over ws and writes auth token config")
