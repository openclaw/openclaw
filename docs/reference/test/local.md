---
summary: "Focused local proof, core test commands, and optional full local runs"
title: "Run tests locally"
read_when:
  - You are running or fixing tests on your own machine
  - You need focused local proof or an explicitly needed full local run
  - You need to select the runtime, formatter, or linter for source development
---

## Routine local order

1. `pnpm test:changed` for changed-scope Vitest proof.
2. `pnpm test <path-or-filter>` for one file, directory, or explicit target.
3. `pnpm test` only when you intentionally need the full local Vitest suite.

The repository wrappers partition ordinary unfiltered Gateway-server run-mode
selections and expanded full-suite plans into at most 50 test files per process.
This bounds the non-isolated module graph as the inventory grows without changing
worker concurrency, heap limits, or individual file boundaries. Raw Vitest and
existing single-invocation selections, such as explicit targets, coverage, report
output, bail, and watch mode, retain their existing behavior.

Expanded full-suite runs split infrastructure and host-owned SQLite tests into
batches of at most 64 files. Each batch keeps isolated fork workers within the
existing full-suite worker budget. Focused selections and watch mode retain their
usual routing.

Gateway configurations marked exclusive drain other test plans before starting
and finish before later plans are admitted. This applies to full-suite runs and
explicit `OPENCLAW_TEST_PROJECTS_PARALLEL` overrides as well as automatic
exact-target scheduling. Ordinary plans retain their configured parallelism.

Tests that create real managed worktrees must satisfy the
[capacity and disk-space requirements](/concepts/managed-worktrees#capacity-and-disk-space),
including the additional allowance for executable setup scripts. Keep that space
available throughout the run.

The project runner prints wrapper usage for a sole `--help` or `-h` request.
Compound requests, including `--help --no-help`, follow native Vitest option semantics.

An existing UI directory target stays scoped to that directory, including when
combined with explicit E2E test files. Tests retain their owning shared, isolated,
or browser lane. UI source/support-file targets that need whole-lane coverage
(such as shared styles or setup files) still use that broader fallback; use a
directory or explicit test files when you want a bounded run.

When a one-shot routed run targets only explicit test-file paths, each selected
Vitest invocation must discover at least one test file. Excluding every selected
file fails even when the lane normally permits empty runs. To allow that outcome
intentionally, use `pnpm test <test-file-path> -- --passWithNoTests`. Use
`--passWithNoTests=false` to require nonempty discovery explicitly. Broader
selectors and source-derived selections retain their lane defaults.

An explicit `--config` run through `scripts/run-vitest.mjs` keeps its stricter
named-file policy and does not permit empty named-file runs. Plugin
`--allow-no-tests` and `--allow-empty-after-exclude` controls are unchanged.

Codex and other linked/sparse worktrees can run local tests and checks. Tooling
requires prepared dependencies; it does not create an implicit link to the
primary checkout. Keep any existing borrowed install unchanged while another
task uses it. A source install's `pnpm:devPreinstall` check refuses borrowed links
at the checkout-root module directories and their `.pnpm` directories before
normal dependency reconciliation. It does not inspect every workspace package's
dependencies or lock paths against concurrent replacement; `--ignore-scripts`
skips it, and alternate pnpm directory settings are not exhaustively validated.
When dependencies are ready, use the normal commands above. To avoid pnpm's
package-manager preflight against an existing shared install, use these direct
Node harnesses:

- Bounded focused proof with ready dependencies:
  `node scripts/run-vitest.mjs <path-or-filter>`.
- Changed typecheck/lint/guard proof: `node scripts/check-changed.mjs`.

Fresh source installs clone package files from the pnpm store, falling back to
copies when the filesystem cannot clone. Separate checkouts therefore keep
independent file metadata: installing dependencies elsewhere cannot change an
active compiler input's modification history through a shared hardlink. Existing
hardlinked installs are not converted by an up-to-date `pnpm install`; use a fresh
task-owned checkout and install for isolated proof. Do not reinstall borrowed
dependencies or replace an installation while another task uses it.

For Control UI route tests, run `node scripts/run-tsgo-core-test-shards.mjs ui`
to check fixture types; `node scripts/run-tsgo.mjs -p tsconfig.ui.json` checks
production UI code and excludes tests. Type route fixtures against the loader's
required capabilities instead of asserting a partial fixture as the full
application context. Keep real selection capabilities in lifecycle tests so
agent scope changes and subscription cleanup follow the application behavior.

For remote-environment proof, invoke `node scripts/crabbox-wrapper.mjs`
directly. Avoid local `pnpm crabbox:run` in linked worktrees because pnpm may
reconcile dependencies before the remote wrapper starts.

## Core commands

Node 24.22.1+ or Node 26.12.1+ is required for orchestration and build preparation.
Older Node bindings can truncate SQLite TEXT values at embedded NUL characters.

### OpenClaw Bun fork

Local source development uses the [OpenClaw Bun fork](https://github.com/openclaw/bun)
for tests, `pnpm dev`, local formatting, and linting.
The exact release, revision, and checksums are pinned in
`scripts/lib/openclaw-bun.json`. Use this fork for the Bun development path:
its runtime and built-in formatter and linter are the versions validated against
this repository. These defaults do not change an installed Gateway's runtime;
see [Bun compatibility](/install/bun-compatibility).

`scripts/lib/pinned-bun.mts` owns resolution for tests, `pnpm dev`, formatting,
and linting. On first use it downloads the pinned release through
`scripts/stage-openclaw-bun.sh`, verifies the archive and executable checksums
and release identity, and caches the executable at
`~/.cache/openclaw/bun/<tag>/<platform>-<arch>/bin/bun`. `XDG_CACHE_HOME` replaces
`~/.cache` when set. Later runs reuse the verified cache; no global Bun installation
or manual `PATH` change is required.

Automatic local staging supports macOS and Linux on `arm64` and `x64`. Windows,
other platforms, and machines that cannot obtain a usable pinned executable use
the command's fallback. Windows artifacts in the shared pin serve other consumers;
they do not enable automatic staging in this development resolver.

Local tests and `pnpm dev` default to the pinned fork. If it is unavailable, they
fall back to Node with one notice explaining why. `pnpm format` and
`pnpm format:check` also default locally to the pinned fork, falling back to
oxfmt with one notice if it is unavailable. `pnpm lint` and its shared lint
callers default locally to the pinned fork via `bun lint --no-script`, falling
back to oxlint with the same notice if the fork is unavailable.
Explicit Bun formatting or linting fails if the fork is unavailable.

The October 18, 2026 comparison used pinned Bun `1.4.4-canary.1+7bd4fdff3`
and oxfmt 0.72.0 on the same clean tree. These are median wall times from three
interleaved runs after a warm-up, with native default thread counts:

| Host and command                       | Bun     | oxfmt   |
| -------------------------------------- | ------- | ------- |
| AWS `c7a.8xlarge`, `pnpm format`       | 0.62 s  | 1.41 s  |
| AWS `c7a.8xlarge`, `pnpm format:check` | 0.62 s  | 1.38 s  |
| Loaded Mac, `pnpm format`              | 15.65 s | 14.74 s |
| Loaded Mac, `pnpm format:check`        | 14.31 s | 16.40 s |

On AWS, native write/check medians were 0.52/0.52 s for Bun and 1.30/1.33 s
for oxfmt. The wrappers add about 0.10 s to Bun, without thread caps, batching,
or an extra local formatting pass. Every run preserved the tracked bytes.
The Mac run held the shared build lock but had substantial background load
(about 65); it does not establish a write-speed gain there. Use the oxfmt
override below when it performs better on your machine.

The earlier S3 lint comparison used Bun `1.4.4-canary.1+ef37c31de` and
oxlint 1.87.0 on AWS `c7a.8xlarge`. Summed across core, scripts, extensions,
and UI at default threads, Bun took 23.3 s versus 143.3 s for oxlint: 6.15×
faster, with no missing or extra diagnostics. These native timings exclude
installation and wrapper preparation.

An October 24, 2026 paired run on a loaded M3 Ultra Mac (32 logical cores,
512 GiB RAM) used the same S3 fork and oxlint 1.88.0 through `pnpm lint
--format=json`, under the shared build lock. Both reported the same 243
diagnostics, including complete diagnostic payloads. Whole-command times were
635.0 s for Bun and 912.7 s for oxlint. Summed native lint times were 1,037.8 s
for Bun and 819.6 s for oxlint, with the wrapper's one-thread policy. The first
oxlint run generated declarations that the Bun run reused, and background load
reached 86. This single pair confirms parity, not a Mac lint-speed gain; use the
oxlint override when it performs better locally.

Formatting reads `.oxfmtrc.jsonc`, including the 100-column print width and ignore
patterns. Selecting Bun lint retains the existing pipeline, configuration,
type-aware checks, shards, and resource policy. Other phases, such as stylesheet
linting, retain their own tools. Dedicated generated-artifact and docs formatters
keep their existing oxfmt contracts; see the
[formatter caller inventory](https://github.com/openclaw/openclaw/blob/main/scripts/README.md#formatting-and-lint-selection).

Use the selectors to compare tools or force a fallback:

```sh
OPENCLAW_VITEST_RUNTIME=node pnpm test <path-or-filter>
OPENCLAW_VITEST_RUNTIME=bun pnpm test <path-or-filter>
OPENCLAW_VITEST_RUNTIME=node pnpm dev
OPENCLAW_FORMAT_TOOL=oxfmt pnpm format
OPENCLAW_FORMAT_TOOL=bun pnpm format:check
OPENCLAW_LINT_TOOL=oxlint pnpm lint
OPENCLAW_LINT_TOOL=bun pnpm lint
```

Explicit `bun` selection fails if the executable is unavailable instead of
silently using another tool. Explicit Node, oxfmt, or oxlint selection suppresses the
fallback notice. `OPENCLAW_BUN_PATH=/absolute/path/to/bun` overrides the executable
for every Bun-selected command. This custom binary must be executable, but does
not receive the pinned cache's checksum validation. An invalid path follows the
command's explicit-selection or fallback behavior above. To verify a custom
binary, compare its `--revision` output with the `revision` in
`scripts/lib/openclaw-bun.json`.

To identify the selected formatter and linter locally, use the same environment
as the real command and request their versions:

```sh
pnpm format --version
node scripts/run-oxlint.mjs --version
```

Bun prints its runtime version; oxfmt and oxlint print their tool versions.
These probes use the same selector without formatting files or running lint
preparation. They may perform the first-use download. Avoid `pnpm lint --version`
for this check because other lint phases still run.

The test selection applies to the actual Vitest process and workers. Node retains
orchestration and compiler preparation. Source-runner CLI fixtures use the selected
runtime after preparation. Ordinary Vitest suites do not switch to Bun's native
test runner.

CI is an explicit policy boundary. The daily workflow selects the pinned fork for
eligible tests; Full Release Validation runs Node and Bun. Named Node-only
contracts and direct-entrypoint lanes retain their declared runtime. A standalone
wrapper with `CI` set to a nonempty value other than `false` defaults tests to Node
unless runtime policy selects Bun. CI Bun tests use the workflow-provisioned
`bun` on `PATH` and verify its revision, unless `OPENCLAW_BUN_PATH` supplies it.
See [CI runtime selection](/ci/pipeline#test-runtime-selection).

CI formatting always gates on oxfmt and checks that pinned Bun identifies the same
files needing formatting, even when a format override is set. CI lint continues
to gate on oxlint, regardless of the lint override, and runs Bun sequentially
against the same prepared configs and files. The existing lint jobs fail if exit
status or full diagnostic multisets differ, preserving duplicate findings and all
spans, messages, severity, and help text. Only rule spelling, documentation URLs,
report order, and timing metadata are normalized. No additional runner is needed.
Windows CI retains oxlint alone unless `OPENCLAW_BUN_PATH` supplies an executable;
automatic fork staging supports macOS and Linux.
Metadata queries and commands that write fixes or output files do not run parity.

On macOS, Bun test runs select SQLite like a standalone Bun install and refuse
Apple's system library; see [SQLite library selection](/install/bun-compatibility#sqlite-library-selection).
For an x64 Bun under Rosetta, build the pinned library with
`scripts/build-mac-sqlite.sh universal <dir>` and set
`OPENCLAW_SQLITE_LIBRARY=<dir>/lib/libsqlite3.dylib`.

For the CI Control UI comparison, run the full selection on Node followed by Bun:

```sh
OPENCLAW_NODE_TEST_CONFIGS_JSON='["ui/vitest.config.ts"]' \
OPENCLAW_NODE_TEST_VITEST_ARGS_JSON='["--maxWorkers", "3"]' \
OPENCLAW_CI_TEST_RUNTIME_POLICY=dual-all \
node --import tsx scripts/ci-run-node-test-shard.mts
```

The Node pass covers the complete selection; exact Node-only retention contracts
stay on Node. To run the CI Bun selection with its named Node companions, use
`OPENCLAW_CI_TEST_RUNTIME_POLICY=bun-all` in the same command.

Test processes and their CLI fixtures keep Sparkplug baseline compilation enabled
but run it synchronously. This avoids a Node 24 shutdown deadlock where a
background compiler waits for main-thread garbage collection while `process.exit`
joins that compiler. The shared Node argument policy owns this test-only
mitigation; production CLI exit behavior, assertions, and deadlines are unchanged.

The script erasability gate uses Node's strip-only parser, including when package
checks run under Bun. It selects an installed Node runtime and skips Bun's `node` shim.
Maintainer-tooling tests that need `node:module.registerHooks` or
`stripTypeScriptTypes` also select Node explicitly for their tooling children.
Use `requireNodeTool("node")` and `stripNodeTypeScriptTypes` from
`test/helpers/node-toolchain.ts`, which share that Node-selection owner, while
keeping the Vitest worker on the selected test runtime.

Isolated native worker and subprocess fixtures use `mockNativeModuleExports` from
`test/helpers/native-module-mock.ts` for controlled module exports on either runtime.
The mocks live until that child exits. Capture original call-through functions before
registering replacements because Bun updates existing module namespace bindings.

The test toolchain pins stable Vitest `5.0.3`, including its browser and coverage
packages. Use `describe(name, { concurrent: false }, callback)` for ordered
suites. Await asynchronous assertions, keep `vi.mock`/`vi.hoisted` at module
scope, and perform actions whose mock calls you assert inside the test.
OpenClaw sets `clearMocks: false`, so setup and `beforeAll` calls are preserved.
Clear or reset each assertion's owned mock actions explicitly as needed.
Name patterns spanning suites use `suite > test`; native JSON retains its
space-joined `fullName`, so evidence readers match `ancestorTitles` plus `title`.

Filesystem transform caching uses `test.fsModuleCache` and
`test.fsModuleCachePath`; the existing `OPENCLAW_VITEST_FS_MODULE_CACHE` and
`OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` controls retain their ownership and
disable behavior. Cache-key plugins use `defineCacheKeyGenerator`.
The jsdom lanes optimize Lit and its exported subpaths together through
`deps.optimizer.client`. CodeMirror and Lezer stay in Vite's module graph so
editor classes and parser properties retain one dependency identity.
When `NODE_COMPILE_CACHE` is configured, test launchers preserve it for Vitest
and its workers. Vitest disables bytecode caching in workers and their child
processes for V8 and custom coverage providers; explicit
`NODE_DISABLE_COMPILE_CACHE=1` still disables caching for the entire invocation.
Inline projects inherit root configuration in Vitest 5, including concatenated
setup and include arrays. The four UI E2E resource projects declare
`extends: false` because each supplies its complete inventory and setup.

Maintained JavaScript tooling wrappers and root package commands load TypeScript
through `scripts/tsx.mjs`, using tsx's ESM entry. This preserves native loading of
compiled ESM plugins and their import-only dependencies, including when loaded
through `require()`. Source TypeScript imports and tsconfig path aliases remain
available.

These launchers retain tsx's in-process transform cache and Node's module cache.
They skip tsx's shared disk cache before the loader starts, and child tooling
inherits that policy. This cache policy does not clean
existing temporary directories, Node or Vitest caches, or other global caches. Standalone
`pnpm ui:build` starts natively and runs its post-build validators directly with Node.
Those validators do not load tsx or require `TSX_DISABLE_CACHE` in the invoking shell.
Raw external `tsx` and `node --import tsx` invocations outside these launchers are unchanged.

Node Vitest workers also preload `scripts/tsx.mjs` once per worker. Vitest still
owns test module mocks, while native plugin SDK imports use Node's source module
graph with TypeScript syntax and `.js`-to-`.ts` resolution. Bun uses its native
TypeScript loader. This keeps source-host tests from relying on Jiti to evaluate
another copy of the host SDK.

Scheduler-owned project runs on macOS and Linux reuse filesystem transforms within
exclusive slots, including serial runs that mix configurations. Each Vitest
configuration keeps separate directories. A slot stays owned through preflight,
retries, and verified child/group completion; uncertain cleanup retires it.
Same-config serial runs without scheduler assignment, explicit isolated cache paths,
watch runs, and Windows retain their existing cache ownership. Concurrent invocations
still need separate cache roots.

Control UI builds report size budgets without enforcing them. Run
`pnpm ui:check-performance` after a build to enforce absolute budgets, or
`pnpm ui:check-performance:base <base-commit-sha>` to build and compare both
revisions with the same toolchain. See [Control UI size budgets](/ci/pipeline#control-ui-size-budgets).

### Source tests and subprocess builds

Non-watch runs through `pnpm test` or `scripts/run-vitest.mjs` keep Vitest tests
and runtime parents on TypeScript. Importing a declared subprocess entrypoint
compiles the fixed test entry set and its workspace dependencies into one fresh
invocation directory under `.artifacts/vitest-workers/`.

The declared application entries run as plain Node JavaScript without a
TypeScript loader: SQLite read-only snapshots, database verification, Tailscale
route ownership, the service relay, its POSIX and Windows anchors, the memory
plugin's KNN child, session transcript archive and reconciliation workers, and
managed GitHub credential resolution. The same generation also compiles the fake-backend TUI
fixture's four runtime roots together: the real TUI, embedded reply producer,
reply metadata reader, and outbound normalizer. Shared chunks preserve their
module and WeakMap identity. Prepared TUI fixtures are compiled to `.mjs` and run
as JavaScript without a TypeScript loader. Direct source fixtures
remain `.mts`: Node launches them with `--import tsx`, while Bun handles their
syntax natively. The session-identity PTY tests load real provider policies, so
their runtime prerequisite prepares the built host SDK before Vitest workers start.
Existing package build entry paths and Vitest source parents stay unchanged. The
CLI fork-recovery regression also compiles the real CLI entry and its concurrent
rebind's session accessor and binding helper together. Both processes use the same
runtime graph while retaining the durable-write race and process-exit assertions.
Doctor process output tests with bundled plugins disabled reuse that compiled CLI
inside one lazily created package fixture per test run, keeping real UI checks on
fixture-owned assets and each scenario’s state separate. Standalone and watch runs
use live source inside the same fixture.

Broadcast output coverage prepares its message helper and exit finalizer together,
preserving command substitution and joining its process tree before fixture cleanup.

Isolated Doctor config scripts also share the prepared config-flow, health-writer,
and install-index modules. Each case still starts a fresh process with separate
state; standalone and watch runs resolve the original TypeScript entrypoints.

The model-catalog, Codex catalog-page, and session model-context workers also use this compiled generation.
Model-catalog workers still belong to their prepared model generations; context reads
retain their serial worker pool. Plugin source/built selection remains independent
of worker compilation.
Other worker-thread entries and arbitrary source CLI fixtures remain outside
this declared set.

The agent database module-identity test shares the compiled host and SQLite SDK
entries while forcing a separate plugin transform of the SDK. Its standalone and
watch runs retain a disposable build from current source because this regression
specifically checks a packaged graph. Both modes use the same assertions and
subprocess deadline.

The session-title and child-link retention tests declare their title-reader,
session-utils, and listing roots in this same generation. Each fresh
heap-measurement child runs their JavaScript without spending its execution
deadline on TypeScript imports.

Automatic-triage process fixtures share this generation for admission, failure handling, execution, process identity, and respawn checks. Compilation finishes before readiness deadlines begin, so children load prepared JavaScript. The detached helper uses the same sealed lease runtime as the installed package.

Known core database-worker consumers prepare the invocation's compiled generation
before test processes start, including when a case imports its worker declaration
dynamically. Selection uses the existing database-worker inventory and honors CLI
filters, exclusions, and include files. Other tests retain lazy preparation across
projects and shards. Config imports, listing tests, watch runs, custom selections,
and tiny tests that do not import these declarations do not eagerly compile workers.
A shard that imports a declaration requests the outer runner's single build through
its existing Node IPC channel; eager consumers reuse the completed generation.
Static imports acquire it during module collection, before fixture hooks and readiness
deadlines. Every finite invocation
that needs a declaration pays for this fixed entry set; preparation timing is
reported separately from child execution. The runner starts one short-lived native
Node or Bun compiler child and joins it before returning the verified manifest to
borrowers. The compiler module graph lives in that child, not the long-lived runner
or Vitest worker. No shard can select a different build graph or adopt another invocation's output. The outer
runner retains the generation until child close and process-group cleanup
finish, then verifies it before reporting success. Verification reads every recorded
input and output with bounded asynchronous I/O, keeping the runner responsive during
large shutdown scans. The invocation owner verifies each borrower's preparation
before replying and verifies again after all borrowers close; Vitest does not repeat
these scans inside each shard or during its concurrent pool shutdown. Standalone
Vitest and watch runs retain source execution: compilation, verification, and artifact
deletion require the repository runner's ownership.
A lost owner or failed build fails the run.
Disposal cancels pending compilation and joins it, every borrower, and outstanding
preparation requests before asynchronously removing the directory. Signal handlers
remain active through removal, even when large generations take time to delete.
Borrower completion does not wait for compilation, so an early child exit can reach that cancellation path. An uncertain compiler or borrower join retains the
generation and fails the run. Abnormal termination can also leave an unused
directory; later runs never adopt it.

Every preparation compiles current source; checkout `dist/` is neither an input
nor a fallback. Build errors, missing artifacts, and changes to recorded build
inputs fail the run. Compilation includes the native subprocess fixtures before
they impose resource limits. Third-party dependencies remain external except for
the always-bundled OpenClaw packages. fs-safe remains external so its native loader
resolves the optional platform package from fs-safe's own dependency scope, including
nested pnpm installs. Compiled workers use that same installed package; they do not
copy native binaries. Native mode defaults to `auto` on macOS, Linux, and Windows.
No-clobber Root moves require native support; Windows secure credential reads
require the matching helper for descriptor-bound ACL checks. Explicit
`off`/`auto`/`require` settings and programmatic configuration retain their
precedence. Sealed portable worker bundles use guarded JavaScript only and
explicitly disable native loading.

Watch mode deliberately keeps the existing live-source path, including tsx for
Node subprocesses and native TypeScript handling for Bun. It creates no prepared generation, so a new child launch
reads current source rather than reusing a compiled snapshot. Existing Vitest
watch dependency tracking still determines when tests rerun.

Test wrapper runs end with a short `[test] passed|failed|skipped ... in ...` summary; Vitest's own duration line stays the per-shard detail.

A failed invocation ends with one `[test] FAILED (exit N)` line after child
processes, cleanup, and report publication settle. Direct `run-vitest.mts` calls
use `[vitest]` instead. Nested runners retain their diagnostics and exit status;
the top-level CLI owns the final failure line. Successful runs emit no failure
trailer.

| Command                                           | What it does                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                       | Explicit file/directory targets route through scoped Vitest lanes. Untargeted runs are full-suite proof: fixed shard groups expand to leaf configs for local parallel execution, with the expected shard fanout printed before starting. The extension group always expands to per-extension shard configs instead of one giant root-project process. |
| `pnpm test:changed`                               | Cheap smart changed-test run: precise targets from direct test edits, sibling `*.test.ts` files, explicit source mappings, and the local import graph. Broad/config/package changes are skipped unless they map to precise tests.                                                                                                                     |
| `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` | Explicit broad changed-test run; use when a test harness/config/package edit should fall back to Vitest's broader changed-test behavior.                                                                                                                                                                                                              |
| `pnpm test:force`                                 | Frees the configured OpenClaw gateway port (default `18789`), then runs the full suite with an isolated gateway port so server tests do not collide with a running instance.                                                                                                                                                                          |
| `pnpm test:coverage`                              | Emits an informational V8 coverage report for the default unit lane (`vitest.unit.config.ts`); no coverage thresholds are enforced.                                                                                                                                                                                                                   |
| `pnpm test:coverage:changed`                      | Unit coverage only for files changed since `origin/main`.                                                                                                                                                                                                                                                                                             |
| `pnpm changed:lanes`                              | Shows the architectural lanes triggered by the diff against `origin/main`.                                                                                                                                                                                                                                                                            |
| `pnpm check:changed`                              | Runs the local changed formatting/typecheck/lint/guard plan, including targeted Vitest owner tests for selected paths. Use `pnpm test:changed` or `pnpm test <target>` for additional test proof matching the touched contract.                                                                                                                       |

`pnpm check:changed` also runs the mobile protocol-event coverage guard when
changes affect the gateway event catalog or constants, scanned mobile sources,
coverage declarations, or the guard, its execution helpers, and its routing.
All-lane checks include it too. Every gateway event must have a handler or an
explicitly approved non-consumption declaration for each mobile client. To run
only this guard, use `pnpm check:protocol-coverage`.

For native app changes, `pnpm check:changed` uses platform scope to select lint:
Android selects `pnpm android:lint` (the Gradle ktlint checks), while Apple app
changes retain Swift lint. Android-only changes do not select Swift lint or its
missing-tool notice. Android framework/resource lint and runtime tests remain
separate checks; Kotlin lint does not replace them.

Remote filesystem fixtures that execute GNU `stat` and `readlink` run locally
only on Linux. The shared leading-`@` file-tool scenario
also runs against a portable remote-only bridge on every platform. Native
Python helper coverage remains separate, including macOS; these fixture gates
do not restrict the [SSH backend's Gateway host](/gateway/sandboxing#ssh-backend).

Tests that discover real bundled provider runtimes declare that prerequisite in
`scripts/lib/vitest-build-prerequisites.mts`, including Telegram sticker-model
selection. Local runners and CI prepare those artifacts before admitting workers.

<a id="local-pr-gate" />

## Full local run (only when explicitly needed)

PR CI is the broad gate. Before opening a ready PR, run focused tests for touched
code and targeted typecheck, lint, and format checks. Do not run the full local
suite to diagnose a failed PR CI run; use `pnpm test:ci-failed <pr>` instead.

The full local commands remain available for an explicitly needed investigation:

- `pnpm check:changed`
- `pnpm check`
- `pnpm check:test-types`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

`pnpm check --base <ref>` pins the line-cap, max-lines suppression, and assertion
safety ratchets to the merge base of `HEAD` and that ref. Native PR gates pass
their candidate's fork from the captured main snapshot, so inherited main
changes retain their allowance even when the shared `origin/main` ref is stale.
Other check stages still run normally.

If an explicitly requested full local run fails, isolate the failed tests with
`pnpm test <path/to/test>` and investigate the owner; a passing replay does not
prove a repair. For a PR CI failure, read its published classification, fix new
failures, run `pnpm test:ci-failed <pr> --run` until those pass locally, then push
once. Pre-existing failures follow the
[failure-table landing rule](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures).
Never rerun CI just to chase green. For memory-constrained hosts explicitly
running the full local suite:

- `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`
