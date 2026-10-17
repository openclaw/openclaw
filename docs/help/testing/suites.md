---
summary: "The unit, e2e, and live suites, which one to run, and the offline regression checks"
title: "Test suites and commands"
read_when:
  - You need to pick a test suite or command
  - You want to know what each suite covers
---

## Quick start

Select proof using the canonical
[proof policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#proof-policy).
Use the commands below for the suite you need:

- Focused test: `pnpm test <file> --maxWorkers=1`
- Failed PR CI tests: `pnpm test:ci-failed <pr>`; execute the selection with `--run`
- Watch loop: `pnpm test:watch`
- Full suite: `pnpm test`; higher worker cap: `pnpm test:max`
- Informational coverage: `pnpm test:coverage`
- E2E: `pnpm test:e2e`
- Docker QA site: `pnpm qa:lab:up`
- Linux VM QA: `pnpm openclaw qa suite --runner multipass --scenario channel-chat-baseline`

The QA site requires Docker and source (the npm tarball omits QA Lab); the VM
runner requires Multipass. See [QA runners](/help/testing/qa-runners).

PR CI owns broad proof. After CI fails, run `pnpm test:ci-failed <pr>` and read
the pre-existing/new/unknown classification. Fix new failures and investigate
unknown ones, then use `pnpm test:ci-failed <pr> --run` until the selected tests
pass locally and push once. Do not run the full local suite or use
`gh run rerun` to chase green. Pre-existing failures follow the
[failure-table landing rule](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures).
See [failed CI test selection](/reference/scripts/pr-tooling#rerun-failed-ci-tests)
for targets, classification, and command options.

Oxlint's `max-lines` rule warns when files exceed the per-scope limits in
`.oxlintrc.json`; these warnings remain visible in lint logs and do not fail CI.
Local `pnpm check:changed` rejects over-cap changed files and separately checks
new violations and growth; untouched overages found by broad lint are warnings.
PR CI reports numeric ratchet violations as warnings too. The suppression
baseline ratchet remains strict locally. See [surface ratchets](/ci/local-proof#surface-ratchets) for
comparison bases and shrink-only maintenance.

## Runner exit status

`pnpm test`, `scripts/test-projects.mts`, and `scripts/run-vitest.mjs` distinguish
Vitest failures from runner infrastructure failures:

- `0`: the command completed successfully.
- `1`: Vitest failed, or rejected the requested tests or arguments.
- `2`: loader startup, runner preparation, child completion, worker disposal, or report publication failed.
  Existing native failure codes other than `1` remain unchanged.

The runner completes worker disposal and requested report publication before it
returns. A later infrastructure failure takes precedence over an earlier test
failure. Across parallel completions, the first observed native status other than
`0`, `1`, or reserved infrastructure `2` wins, regardless of when `2` arrives.
Infrastructure outcomes stop new shard admission; already admitted shards still
join. Ordinary assertion failures keep the selection's continuation policy.
Forwarded signals retain their signal outcome after cleanup.

For an expected-failure proof, require exit `1` and the intended assertion in its
report. Wait for the outer command to terminate. A report alone does not prove
that cleanup succeeded. An interrupted command or missing terminal result is
not a completed expected failure.

## Test suites (what runs where)

Think of the suites as "increasing realism" (and increasing flakiness/cost).

The maintainer-tooling family uses `RELEASE_ONLY_TOOLING_SHARDS` and matching
maintainer leaves in mixed fast configs: product-only PRs and main omit it,
tooling-owner PRs select their affected files (with full-family fallback for unresolved owners), and manual CI and Full Release Validation
retain it. Keep tests in their assigned configs, with their process and timer
policies, so new files inherit the same owner routing. Dedicated product E2E
and live tests remain outside this tier. See [Node test lanes](/ci/scope-and-routing/node-test-lanes).

### PostgreSQL conformance

`node scripts/test-database-conformance.mjs --engine postgres --connection <dsn>`
runs the PostgreSQL infrastructure, state, and integration suites against a disposable
PostgreSQL database. The runner passes the connection through a Node preload
and worker environment data to test processes and threads, without a DSN
environment variable. It redacts the connection from child output.

Arguments after `--` go to the normal test runner. Start with a file or directory
to replace the default targets; options alone retain all suites. For example,
append `-- src/infra/postgres-sync/locks.test.ts --maxWorkers=1` for a smoke test.
Use `--shard infra` for infrastructure and state tests or `--shard integrations`
for the remaining groups. Each shard retains normal test-runner options after
`--`; explicit target overrides require omitting `--shard`.

For a local Homebrew `postgresql@17` cluster, use a temporary directory on a disk
with enough free space. This subshell stops and removes its cluster on exit:

```bash
(
  D=$(mktemp -d /Volumes/External/openclaw-pg.XXXXXX)
  PG=$(brew --prefix postgresql@17)/bin
  trap '"$PG/pg_ctl" -D "$D/data" -m immediate stop; rm -rf "$D"' EXIT
  "$PG/initdb" -A trust -U postgres -D "$D/data"
  "$PG/pg_ctl" -D "$D/data" -l "$D/server.log" \
    -o "-p 55436 -k $D -h ''" -w start
  node scripts/test-database-conformance.mjs --engine postgres \
    --connection "postgresql://postgres@localhost:55436/postgres?host=$D"
)
```

Alternatively, on a Docker-enabled Testbox, start `postgres:17` with trust auth
and a loopback-only port, run the same command with
`postgresql://postgres@127.0.0.1:5432/postgres`, then remove the container.

The port-command integration scenarios share their fixture across separate files so
the existing Vitest workers can overlap independent recovery and custody cases.
They retain real one-shot command workers, isolated state, and PostgreSQL namespaces;
no additional job or service is started.

CI's **PostgreSQL conformance** matrix runs both shards in parallel, each with a
fresh PostgreSQL 17 service using the pinned `pgvector/pgvector:pg17` image and
the `unaccent`, `pg_trgm`, and `vector` extensions. It runs
on scheduled main CI, manual CI validations, and PRs touching `src/infra/database-engine/**`,
`src/infra/postgres-sync/**`, `src/infra/sql-connection.ts`,
`src/infra/sql-query-compiler.ts`, `src/infra/kysely-sync*.ts`,
`src/infra/sqlite-transaction.ts`, `extensions/workboard/**`,
`src/config/zod-schema.database.ts`, or `scripts/test-database-conformance*.mjs`.
Unknown PR paths conservatively select it; older targets without the runner
omit it. Both selected shards are required by `openclaw/ci-gate`.

### Unit / integration (default)

- Command: `pnpm test`
- Config: untargeted local runs expand the `vitest.full-*.config.ts` shard set
  into bounded per-project invocations for parallel scheduling; CI retains
  its aggregate shard policy
- Files: core/unit inventories under `src/**/*.test.ts`,
  `packages/**/*.test.ts`, and `test/**/*.test.ts`; UI unit tests run in the
  dedicated UI leaf projects
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Repeatable regression tests for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
  - Resolver and public-surface loader tests must prove broad `api.js` and
    `runtime-api.js` fallback behavior with generated tiny plugin fixtures,
    not real bundled plugin source APIs. Real plugin API loads belong in
    plugin-owned contract/integration suites.
  - Native plugin resolver suites run in `plugins-native-loader` on Node and Bun,
    without shared source-loader overrides. A global Bun `--tsconfig-override`
    can resolve denied fixture aliases into checkout source and bypass the
    ownership boundary the suite is testing. Bun's native workers also disable
    automatic package installation so missing fixture dependencies stay missing.

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

    - Untargeted local `pnpm test` expands the twelve aggregate shard configs into their leaf projects, then splits large inventories into bounded invocations. The invocation count grows with the test inventory; it is not twelve processes. Separate process lifetimes bound retained module graphs and let auto-reply and plugin work share the scheduler with other suites. CI keeps its existing aggregate policy, including the Testbox expansion of agentic and extension shards.
    - Expanded local full-suite runs batch ordinary tooling tests into at most eight files per Vitest process to amortize startup. The shared UI lane also uses batches of at most eight files so a retained jsdom/module generation cannot slow the entire UI inventory. The shared Gateway database-worker fork is bounded to fifty files per process to avoid retaining its entire module graph. Isolated, browser, timing, and Docker lanes keep their existing owners and policies; batching does not remove tests or relax exclusive Gateway scheduling.
    - Local extension database-worker invocations also use the existing twenty-file job bound within each process cohort. Telegram native-worker tests retain their one-file process lifetime, and other smaller process limits remain in force. This prevents a single hundreds-file cohort from becoming a serial tail.
    - Local shard concurrency comes from the CPU, load, and available-memory worker budget, capped at ten processes. Ordinary shards receive one Vitest worker each. Exclusive Gateway shards run alone and can use that same concurrency budget inside their own process, while their config-level serial phases stay serial. `OPENCLAW_TEST_PROJECTS_PARALLEL=<n>` overrides shard concurrency; `OPENCLAW_TEST_PROJECTS_SERIAL=1` selects serial scheduling. Explicit `OPENCLAW_VITEST_MAX_WORKERS` or `OPENCLAW_TEST_WORKERS` values retain their worker policy. None of these local defaults changes CI scheduling.
    - `pnpm test --watch` still uses the native root `vitest.config.ts` project graph, because a multi-shard watch loop is not practical.
    - `pnpm test`, `pnpm test:watch`, and `pnpm test:perf:imports` route explicit file/directory targets through scoped lanes first, so `pnpm test extensions/discord/src/monitor/message-handler.preflight.test.ts` avoids paying the full root project startup tax.
    - Non-watch package and agent directory targets, such as `pnpm test packages/gateway-client` or `pnpm test src/agents/tools`, and quoted agent globs such as `pnpm test 'src/agents/failover/**/*.test.ts'`, discover regular `*.test.ts` files and route each to its owning lane. This preserves fast, isolated, harness, and database-worker ownership, shared exclusions, and inherited include limits; ordinary selections do not opt into live or E2E tests.
    - Non-watch root-project runs, such as `node scripts/run-vitest.mjs run src/config`, prepare any built runtime required by their selected tests before starting them.
    - `pnpm test:changed` expands changed git paths into cheap scoped lanes by default: direct test edits, sibling `*.test.ts` files, explicit source mappings, and local import-graph dependents. Config/setup/package edits do not broad-run tests unless you explicitly use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed`.
    - `pnpm check:changed` is an optional smart local check for narrow work; PR CI owns the broad gate. It classifies the diff into core, core tests, extensions, extension tests, apps, docs, release metadata, live Docker tooling, and tooling, then runs the matching typecheck, lint, and guard commands. Selected paths also schedule targeted Vitest owner tests via `pnpm test:serial`; use `pnpm test:changed` or explicit `pnpm test <target>` for additional test proof matching the touched contract. Release metadata-only version bumps run targeted version/config/root-dependency checks, with a guard that rejects package changes outside the top-level version field.
    - In the default Git diff mode against `HEAD`, comment/whitespace-only TypeScript edits skip their typecheck lanes and core graph boundary check when tokens and line-break boundaries match the merge base. Files with TypeScript/JSX directives, triple-slash comments, parse errors, or path lifecycle changes retain typechecking, as do JavaScript files. Lint, formatting, ratchets, guards, and tests keep the full changed-path scope. Staged, explicit-path, and non-`HEAD` comparisons retain normal typecheck selection; `--dry-run` reports any skipped paths.
    - Changed core test checks run the shards that own changed test roots before their other selected consumers. Both groups keep their canonical order, and CI stripe membership stays unchanged. Source-only changes keep the normal order. The boundary inventory is reused for selection and ordering.
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
    - SQLite admission runs before test collection in each Vitest worker. Bun threads
      inherit the config process's decision; OS forks initialize it locally.
      Bun runs the existing native-close conformance probe before database pools
      capture their policy; Node retains its runtime-provided capability.
    - The shared Vitest config fixes `isolate: false` and uses the
      non-isolated runner across the root projects, e2e, and live configs.
    - The root UI lane keeps its `jsdom` setup and optimizer, but runs on the
      shared non-isolated runner too.
      The shared preload registers the jsdom adapter without importing its DOM
      bindings; those initialize when a jsdom environment starts.
    - Provider plugin shards reuse workers with the shared cleanup runner.
      Track global replacements with `vi.stubGlobal` so cleanup can restore them
      before the next file.
    - Before each test attempt and before a file's cleanup, the shared runner
      waits for agent database closes that earlier teardown scheduled without
      awaiting, so a Worker lease release never overlaps the next test. A failed
      close stays with its owner and the file-end drain, as before.
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
      Canceling a compiler shard batch joins each compiler, including forced
      termination when needed, before releasing checkout artifact ownership so
      the next build or check can proceed.

  </Accordion>

  <Accordion title="Fast local iteration">

    - `pnpm changed:lanes` shows which architectural lanes a diff triggers.
    - The pre-commit hook formats and restages files. When private rules are
      configured, it also scans staged content before and after formatting.
      See [Local commit hook setup](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md#local-commit-hook).
      It does not run lint, typecheck, or tests.
    - Use `pnpm check:changed` when an optional smart local check helps select
      focused proof. PR CI runs broad checks after publication.
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
    - Bun test processes with an isolated HOME keep their transpiler cache in
      the checkout's `.cache/bun-transpiler` directory across runs. Set
      `BUN_RUNTIME_TRANSPILER_CACHE_PATH` to use another location, or `0` to
      disable it. Explicit values, including an empty value, are preserved.
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
      keep heavy dependencies behind a narrow local `*.runtime.ts` module and
      mock that module directly instead of deep-importing runtime helpers
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

The node-worker process group runs on owner-changing PRs and hourly main CI.
Its explicit inventory, selection, and capacity policy are documented in
[Node test lanes](/ci/scope-and-routing/node-test-lanes).

- Command: `pnpm test:e2e:gateway`
- Config: `test/vitest/vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`, `test/**/*.e2e.test.ts`, and bundled-plugin E2E tests under `extensions/`
- Runtime defaults:
  - Uses Vitest `threads` with `isolate: false`, matching the rest of the repo.
  - Uses one worker by default to avoid concurrent changes to shared Gateway state.
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
  - Most suites replace the Gateway WebSocket with fixed-response in-browser mocks; some start isolated real Gateways
- Expectations:
  - Runs in CI as part of `pnpm test:e2e`; the resource groups add no CI jobs
  - No provider keys required; `OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY=1` excludes real-Gateway suites
  - Chromium and Playwright FFmpeg must be present; `node --import tsx scripts/ensure-playwright-chromium.mts` installs them, and `pnpm test:ui:e2e` already runs it
  - The workboard native-bundle suite also needs WebKit with system dependencies (`pnpm --dir ui exec playwright install --with-deps webkit`); Crabbox Linux hydration installs both browser prerequisites

The dedicated real-Gateway CI lane uses `test/vitest/vitest.ui-e2e-prebuilt.config.ts` after `OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm build` completes in each clean checkout. The separate artifact job retains SDK declaration validation. The planner balances existing serial files and selected standalone companions in one row, with the remaining audited parallel files in another. The companions share the existing two-worker phase after serial execution without an extra bundled preview. The real node/SSH desktop resize tour is release-only: when its file is selected by full manual/release validation or a direct spec edit, the first row runs `node --import tsx scripts/test-desktop-resize-real.mts` once for both carriers. The bootstrap remains required; invoking the desktop spec without its real fixture is not equivalent proof. Frequent resize, revocation, view-only filtering, takeover, and UI sizing tests remain in ordinary CI. Placement consumes the parallel-eligibility allowlist from `vitest.ui-paths.mjs` without changing Vitest scheduling. Each selected file has one CI owner; the desktop bootstrap executes each carrier once. Full manual and release selection retain the complete inventory. Prebuilt previews borrow the validated standard Control UI assets without rebuilding or deleting them; default mocked Gateway hellos use the same artifact identity, and explicit mock identity overrides still apply. Ordinary local runs retain their private builds. Keep source and built outputs unchanged until all workers and children finish. Fixtures retain their private HOME, state, ports, cleanup, and existing worker limits. Readiness failures stop without rebuilding or falling back. The ordinary local config keeps real-Gateway files serial; frozen targets and older planners retain one complete CI row and their own config/command. See [CI](/ci) for the resource policy and timing evidence.

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

The adapter requires Linux, an existing rootless Podman installation with its native init helper (normally catatonit), checkout-local `pnpm install --frozen-lockfile` dependencies, and native Node and pnpm executables compatible with the image. Put the native pnpm executable matching `package.json` on `PATH`, or select it through the existing `npm_execpath` environment variable; a Corepack/download shim is not an offline executable. The image must already contain the Chromium revision required by the installed Playwright package under `/ms-playwright`, including its headless shell and system libraries. The runner checks versions and launches Chromium before starting the test command. SELinux-labeled hosts are not supported by this initial adapter: it refuses before creating a container rather than relabeling shared host files or disabling enforcement. Use an already supported isolated runner instead of changing host security policy.

It runs Vitest, Chromium, the provider fixture, and the test Gateway in the same network-none namespace. Podman’s init owns PID 1 so detached test children are reaped after their launchers exit; the Node entrypoint still owns the test invocation and cleanup. Host proxy settings stay unchanged; host credentials, Gateway state, Git metadata, and private scratch are not exposed to the container. There are no published ports or external network access. Missing prerequisites fail with setup guidance instead of installing packages or weakening isolation.

Use the ordinary local config, not the CI-only prebuilt config. The adapter uses the standard test selection to prepare `qaRuntime` artifacts inside the container for tests that consume built runtime, including private-QA artifacts when required. Source-only selections do not pay for a runtime build and retain the 8 GiB container memory cap. Runs that prepare built artifacts use a bounded 16 GiB cap to accommodate the compiler heap and native build memory; CPU, network, filesystem, and process limits are unchanged. For the standard Control UI E2E config, it retains the private-QA `ciArtifacts` build before admitting tests; backend readiness alone does not mean the dashboard assets are ready. The host’s live-Gateway artifact admission is unchanged. The isolated source snapshot uses tracked working-tree files, including staged new files; stage a new test before selecting it. Keep source and dependencies unchanged during the invocation, and keep dependency installation separate. The initial interface supports exact tracked test files, a tracked config, and console reporters; it does not export files from the disposable snapshot. This route is not suitable for live-provider tests or tests that must contact services outside their own container.

### E2E: OpenShell backend smoke

- Command: `pnpm test:e2e:openshell`
- File: `extensions/openshell/src/backend.e2e.test.ts`
- Scope:
  - Reuses an active local OpenShell gateway
  - Creates a sandbox from a temporary local Dockerfile
  - Exercises remote and default mirrored OpenShell backends over real SSH
  - Creates an isolated non-default OpenShell workspace and custom workspace roots
  - Verifies nested mirrored file writes and excludes host Git metadata and hooks
  - Verifies filesystem operations against the remote workspace through the sandbox fs bridge
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
- Runtime: Node by default; `OPENCLAW_VITEST_RUNTIME=bun pnpm test:live` selects the Bun executable on `PATH` for Vitest and its workers, using the same runtime selector as the CI test lanes. The live wrapper still runs on Node.
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
  - Tune gateway/check heartbeats with `OPENCLAW_LIVE_GATEWAY_HEARTBEAT_MS`.

### Prompt-cache regression coverage

Full Release Validation runs the existing `live-cache` suite in its default
stable profile and in the full profile. Beta runs it when repo/live coverage is
selected, including soak or a focused live rerun. To select it alone, use
`rerun_group=live-e2e` and `live_suite_filter=live-cache`. Its `provider` and
`mode` inputs select cross-OS onboarding coverage; they do not change the
providers in this cache suite.

The suite first runs `pnpm test:live:cache` for the stored provider baselines,
then runs the shared transport prompt-prefix harness and focused live agent
scenarios:

```sh
node --import ./scripts/tsx.mjs scripts/e2e/anthropic-cache-live.mts
OPENCLAW_LIVE_CACHE_TEST=1 OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL=claude-sonnet-5 \
  pnpm test:live src/agents/embedded-agent-runner.cache.live.test.ts --testNamePattern 'release prompt-prefix gate'
```

The transport harness uses Node. The stored baselines and agent scenarios honor
the selected test runtime in advisory Bun runs.

The harness requires `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. It also checks
OpenRouter when `OPENROUTER_API_KEY` is present; an absent optional credential
omits that route. Release CI supplies these through its existing
live-test secrets. `--provider anthropic`, `--provider openai`, or
`--provider openrouter` selects a single provider for diagnosis. `--mock` uses
local synthetic HTTP/SSE responses and proves request construction only, not
provider cache hits.

Each transport route makes four requests: an initial long conversation, two
tool-result continuations, and a new user turn. It checks serialized prefix stability,
provider cache identity, and cached-token usage while moving transient runtime
context beyond the cacheable history. Failures identify the first differing
segment with digests; output does not include prompt contents. Usage records
include input, output, cache reads and writes, and request gaps so provider
availability and cache misses remain distinguishable from changed inputs.

The live agent scenarios are designed to run four turns each through Anthropic
Messages and OpenAI Responses. The Anthropic scenario requires an in-history
system-message model; release CI selects `claude-sonnet-5`. The fixture activates
the root plugin registry, exercises real prepend/append prompt hooks, and updates
the Skills, Temporal Context, and Runtime instructions. Before the fourth turn,
it clears the in-memory prompt projection so the runner must rehydrate it from
the persisted session and closes the provider transport. Anthropic also closes
the transport before the other turns. OpenAI retains it and calls a synthetic
tool twice per turn, exercising stored-response continuations with the same
session cache key. Its 2,048-section starting prefix and large tool results
exercise long conversations. The assertions require every warm request to reuse
at least 80% of the preceding prompt's tokens, preserve the effective prefix and
cache identity, and report no tracked cache-input change. OpenAI's effective
prefix includes inherited response output; its comparison ignores JSON object
key order, optional provider item IDs/status on assistant messages and function
calls, and response-only log-probability fields. Call IDs and tool-output
envelopes remain exact, and outgoing request bodies remain unchanged. Each request reports input tokens, cached
tokens, cache ratio, and request gap. This covers retained HTTP continuation and
cold-transport replay through the embedded agent pipeline; it does not restart
a Gateway process.

Requests run consecutively without intentional delays or retries; the scenarios
require gaps below 30 seconds. Each of the three checks has an eight-minute
outer deadline within the thirty-minute job. The transport fixture starts near
8,000–10,000 input tokens and caps output at 512 tokens per request. Its two
Anthropic routes plus OpenAI make 12 requests; optional OpenRouter adds four.
Use a planning estimate of approximately $0.50 for the transport scenario. The
agent scenario makes sixteen requests: twelve OpenAI tool-loop requests and
four Anthropic requests. Its larger OpenAI prefix costs more than the transport
fixture; use the reported token counts and current model prices when budgeting
or recording a run. Actual billing depends on model selection and cache reuse.
These are fixture descriptions, not spending caps. The stored-baseline check
has its own cost.

The transport check uses a synthetic conversation; the live agent scenario adds
persisted prompt-projection rehydration. The separate
`pnpm test:docker:live-anthropic-cache` lane checks the installed candidate
package's Anthropic builders in the stable/full Docker `core` chunk. See
[Docker cache proof](/reference/test/docker#anthropic-runtime-context-cache-regression)
for that package boundary.

### Advisory Bun release checks

Maintainers can dispatch `openclaw-live-and-e2e-checks-reusable.yml` on `main`
with `test_runtime=bun`. The manual input offers `node` and `bun`; reusable
callers accept the same values as a string. Node remains the default, including
the existing Release Checks and Full Release Validation callers.
Reusable Bun callers must use the same repository and revision as the called
workflow so the pin comes from that exact workflow source. Direct dispatches meet
this requirement automatically.

For the normal stable release repo/live selection:

```sh
target_sha="$(gh api repos/openclaw/openclaw/commits/main --jq .sha)"
gh workflow run openclaw-live-and-e2e-checks-reusable.yml --ref main \
  -f ref="$target_sha" -f test_runtime=bun -f release_test_profile=stable \
  -f include_repo_e2e=true -f include_live_suites=true \
  -f include_release_path_suites=false -f include_openwebui=false \
  -f gateway_repo_e2e_use_github_hosted_runners=false \
  -f allow_unreleased_changelog=true
```

Bun jobs are labeled advisory and report failures normally in their separate
run. They do not replace Node release evidence or add PR jobs. The trusted
admission checkout includes `scripts/lib/openclaw-bun.json` and its staging
helper from the workflow revision. The existing `setup-test-bun` action installs
that pin once and shares its executable by artifact ID with the test jobs.
Only test steps select Bun; dependency
installation, build preparation, packaging, and workflow tooling keep their
current toolchain.

The selector covers native live shards, live cache checks, Gateway shards,
agent-plugin Gateway, the complete UI E2E suite (including real-Gateway files),
and the OpenShell Vitest host. Native media shards support the same selector
when selected by the `full` profile. The separate required PR CI real-Gateway
job remains governed by its existing runtime policy and is not this release lane.

Docker live/model, packaged-product, upgrade, and OpenWebUI lanes retain Node:
their images and launchers own the container runtime, so a host Vitest selector
does not switch them. External provider CLIs and the OpenShell service also keep
their own runtimes. These lanes still run when selected but are not Bun proof.
Use a current target containing the runtime-aware live and E2E launchers; older
frozen release targets may not support this advisory selector.

## Which suite should I run?

Follow the [proof policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#proof-policy).
Target the touched owner first. Gateway networking, WebSocket, and pairing
contracts have E2E lanes; provider/tool-calling diagnosis may require a narrowed
live lane. Suite descriptions above identify their scope and prerequisites.

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
- Prompt/KV-cache request prefixes: `src/agents/embedded-agent-runner.prompt-cache.test.ts` drives admitted agent turns against capturing mock providers for Anthropic Messages, Claude in-history system messages, OpenAI Chat Completions, and OpenAI Responses.
- User replay and failed-attempt persistence: `src/agents/embedded-agent-runner/run/attempt-prompt-submit.projections.test.ts`, `src/agents/session-tool-result-guard.transcript-events.test.ts`, and `src/agents/sessions/agent-session-responses-eof.test.ts` exercise recorded user content, append-only errors, and retry/reopen prefixes at their owning boundaries.
- Gateway chat, completion, and restart prefixes: `src/gateway/gateway.prompt-cache.test.ts` uses authenticated `chat.send`, a real `sessions_spawn` child and its completion, an in-process Gateway server stop/start, and another `chat.send` in the same session. It compares the parent conversation's requests and nonempty cache keys separately from the child's requests.

The prompt-cache fixture drives ten turns through the real embedded agent
pipeline, transcript store, and provider serializers. It activates the root
plugin registry and advertises its tools directly with tool search disabled.
It also compares retained user-envelope digests, including runtime carriers,
before provider serialization, covering timestamps, idempotency keys, and
metadata that wire serializers omit.
Five tool results are individually truncated to about 16,000 characters each;
together they exceed the 65,536-character aggregate budget. The intended
invariant is that already-sent result bytes remain frozen under that pressure,
not that the protected batch is elided. Real prepend/append hooks and model-only
replacement prompts exercise transcript projection. Instruction refresh runs on
OpenAI Responses and Claude's in-history system-message route; older Chat
Completions and Anthropic Messages routes retain their initial instructions.

The scenario sends images on the first two turns, expires a real MCP session and
captures a turn while its reconnect is blocked, steers the sixth turn, and
reopens durable runner state before the seventh. Turn eight assembles and replays
a synthetic typed subagent completion event; it does not spawn a subagent or
prove announcement delivery or authorization. The channel-derived history limit
crosses on turn nine. The Responses route also exercises a partial assistant
error followed by a new turn. Captures include system, tools, history, and cache
identity. Prefix comparisons permit only the exact history-prefix removal on
turn nine; previously sent image blocks remain unchanged. At the pruning
boundary, legacy Chat Completions relocates the same runtime facts from the
retired first user to the retained first user. Legacy Messages can refresh its
identified transient runtime context, including date facts and announcements.
The fixture compares all history through the last cache breakpoint and rejects
any breakpoint that includes transient runtime context, including during steering.
The other three routes compare their complete retained history. Every other retained byte must
remain identical. Failures identify the first differing segment and JSON field
with digests and lengths, without printing content.

The Responses fixture retains its transport and models the provider's stored
response context. It verifies that the first tool continuation sends the
five new tool outputs, references the completed response, and retains its cache
key. Prefix comparisons include that response's inherited input and output,
so a smaller continuation body cannot hide a changed conversation prefix.
Implicit output omits provider item IDs and function-call status to match full
replay; call IDs, content, and raw incoming request bodies remain exact.

The admitted-agent matrix reopens the session database and clears in-memory
prompt state without booting a Gateway socket server. The Gateway companion
closes and starts its real server between the completion and final chat turn,
retaining the same state and configuration and reconnecting an authenticated
client. This covers the RPC, internal-dispatch, and server-restart boundaries
within one test process; it does not restart the OS process. The Gateway
companion uses the actual child lifecycle and private parent completion, while
the admitted-agent matrix supplies a synthetic typed completion event. Neither
fixture delivers an external announcement. These assertions define the offline regression contract; mock
token usage is not evidence of provider cache reuse, which requires a successful
live run.
