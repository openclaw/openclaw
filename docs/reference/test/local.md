---
summary: "Routine local test order, the core test commands, and the local PR gate"
title: "Run tests locally"
read_when:
  - You are running or fixing tests on your own machine
  - You need the local land and gate command list
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

Run the test toolchain on Node 24.16+ or Node 26.1+, matching the packaged
runtime floor. Older Node bindings can truncate SQLite TEXT values at embedded NUL characters.

To compare the same Vitest selection on Node and Bun, use the existing wrapper:

```sh
OPENCLAW_VITEST_RUNTIME=node pnpm test <path-or-filter>
OPENCLAW_VITEST_RUNTIME=bun pnpm test <path-or-filter>
```

Install the exact Bun fork build pinned by `.github/actions/setup-test-bun/action.yml`
for comparable results. This selects the
actual Vitest process and workers while retaining Node for orchestration and
compiler preparation. It does not use Bun's native test runner. `bun run` alone
does not select Bun for tests. Node remains the local default.

For the CI Control UI comparison, run the full Node selection followed by its
compatible Bun partition:

```sh
OPENCLAW_NODE_TEST_CONFIGS_JSON='["ui/vitest.config.ts"]' \
OPENCLAW_NODE_TEST_VITEST_ARGS_JSON='["--maxWorkers", "3"]' \
OPENCLAW_CI_TEST_RUNTIME_POLICY=dual \
node --import tsx scripts/ci-run-node-test-shard.mts
```

The Bun partition deliberately excludes two whole GC-sensitive files, which
remain covered by Node. Running the complete UI config directly with
`OPENCLAW_VITEST_RUNTIME=bun` also runs those currently incompatible assertions.

Test processes and their CLI fixtures keep Sparkplug baseline compilation enabled
but run it synchronously. This avoids a Node 24 shutdown deadlock where a
background compiler waits for main-thread garbage collection while `process.exit`
joins that compiler. The shared Node argument policy owns this test-only
mitigation; production CLI exit behavior, assertions, and deadlines are unchanged.

The script erasability gate uses Node's strip-only parser, including when package
checks run under Bun. It selects an installed Node runtime and skips Bun's `node` shim.

The test toolchain pins stable Vitest `5.0.1`, including its browser and coverage
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
module and WeakMap identity. Generated TUI fixtures remain `.mts` files: Node
launches them with `--import tsx` for their own syntax, while Bun handles that
syntax natively without the Node loader. Only their runtime imports change.
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

Native Bash output-lifecycle fixtures also prepare the real tool and executor
roots in this generation. Each scenario still uses a fresh process and real
shell, pipe, and spill file; its unchanged child deadline covers prepared
JavaScript startup and output handling instead of repeated TypeScript compilation.

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

## Local PR gate

For local PR land/gate checks, run:

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

If `pnpm test` flakes on a loaded host, rerun once before treating it as a regression, then isolate with `pnpm test <path/to/test>`. For memory-constrained hosts:

- `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`
