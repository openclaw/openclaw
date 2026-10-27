---
summary: "Job graph, failure reporting, and the Control UI size budgets"
title: "CI pipeline jobs"
read_when:
  - You need to know which CI job owns a check
  - You want the order jobs run in and what blocks what
  - You need to satisfy or configure security-sensitive pull request review
---

OpenClaw CI runs on pushes to `main` that change a path outside `**/*.md` and
`docs/**`, on every non-draft pull request, and on manual dispatch. Docs-only
main pushes skip CI; mixed docs and code pushes still run it. Pull-request docs
scoping is unchanged.
Upstream `main` pushes use a two-slot pipeline keyed by run-number parity, so
at most two integration runs overlap. Each slot is non-canceling and keeps one
coalesced pending tip: a new merge replaces that slot's older pending run
instead of canceling work that already registered a Blacksmith matrix. Runs in
the two slots can complete out of order; exact-head consumers remain bound to
their requested SHA and are unaffected. Pull requests still cancel superseded
heads, and manual dispatches use isolated groups. Draft no-op events use per-run
isolated groups before job gating, so a delayed draft event cannot displace
pending or running ready-for-review CI. `converted_to_draft` keeps the PR-wide
group to cancel earlier CI while skipping its own jobs. Explicit workflow
cancellation and manual dispatch behavior are unchanged; draft isolation adds no
downstream automatic recovery. `preflight` classifies the
diff and turns expensive lanes off when only unrelated areas changed. Ordinary
manual `workflow_dispatch` runs intentionally bypass smart scoping and fan out
the full graph for release candidates and broad validation. Exact-head
`release_gate` fallbacks retain the pull request's macOS, iOS smoke, and native
generated-locale scope instead of forcing unrelated Apple lanes or locale
parity. Native source verification still runs. Android lanes stay opt-in through
`include_android` (or the `release_gate` input). Release-only
plugin coverage lives in the separate
[`Plugin Prerelease`](/ci/release-validation#plugin-prerelease) workflow and only runs from
[`Full Release Validation`](/ci/release-validation#full-release-validation) or an explicit manual
dispatch.

The full named Node plan retains the complete maintainer-tooling family through
`RELEASE_ONLY_TOOLING_SHARDS` and the matching maintainer leaves in mixed fast
configs. Product-only PRs omit this family in both precise and broad fallback
plans. A PR touching a tooling test or owner runs the full family:
`scripts/**`, `src/scripts/**`, `test/**`, `.github/**`, `config/**`, root
package and pnpm inputs, tooling configs, and the other inputs classified as
tooling by the shared changed-path owner in `scripts/test-projects.test-support.mts`.
That owner also covers Docker, agent/Crabbox tooling, app scripts/Fastlane, and
extension scripts/package inputs. The existing tooling Vitest configs and fast
config inventories still determine execution. Maintainer leaves keep their
original ordinary, isolated, or fake-timer config and process pins; filtering a
mixed group retains its product tests and uses separate subset timing identities.
The five `test/scripts/*.e2e.test.ts` product integration gates remain outside
this maintainer tier.

The shipped-updater composition in
`src/cli/update-cli/update-command-legacy-finalize.test.ts` uses the existing
`tooling-isolated` project in this tier. Its real finalizer, native restart,
lease-authority and cancellation-cleanup cases stay intact. Ordinary product
PRs and main pushes omit it; tooling-owner PRs and manual/full-release validation
retain it. Direct file runs and broad `pnpm test src/cli` runs still select its
isolated owner.

Every CI manual dispatch includes the full tooling family. Full Release
Validation's `normal_ci` child dispatches CI on the frozen candidate, where
`Run Node test shard` executes those unchanged tests before the regular release
publication gate accepts the campaign. OpenClaw Release Checks and Plugin
Prerelease are separate proof owners. This is candidate validation, not a test
deferred until promotion. Direct human beta publication with approved
preflight-only evidence remains an explicit existing exception to full-campaign
validation; this tier does not change publication authority.
Fork repositories keep their existing full tooling coverage because they do not
use the shared changed-test planner. Fork-origin PRs targeting this repository
use the standard PR selection and retain changed-owner coverage.

Main push plans already omitted named tooling shards; they now also omit the
maintainer leaves previously retained by fast configs, even for tooling-owner
changes. A regression introduced by a later main merge can therefore remain invisible to
main CI until an affected PR or full manual/release validation runs the family.
The PR merge-ref result proves only the tree it tested. The current `ci-gate`
aggregates selected jobs; it does not add a separate tooling proof against later
main revisions.

Scheduled QA runs nightly at 04:41 UTC. Its live runtime job runs the
`gateway-restart-full-access-live` scenario with `openai/gpt-5.6-luna` alongside
the three-restart replay-safety scenario. The Full Access check must preserve
shell access and delegation without repeating the interrupted side effect;
failure fails the job. Both scenarios run serially and retain their reports in
the job's uploaded artifacts.

## Pipeline overview

| Job                              | Purpose                                                                                                                                                                                                                                                                                                  | When it runs                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `preflight`                      | Detect changed scopes and build the CI manifest; all-Blacksmith upstream Node-relevant runs also restore the exact dependency cache before fanout                                                                                                                                                        | Always on non-draft pushes and PRs                   |
| `security-fast`                  | Private key detection and changed-workflow audit via `zizmor`; warn-only production lockfile audit for release dispatches                                                                                                                                                                                | Always on non-draft pushes and PRs                   |
| `build-artifacts`                | Build `dist/`, Control UI, built-CLI smoke checks, startup memory, and embedded built-artifact checks                                                                                                                                                                                                    | Node-relevant changes                                |
| `control-ui-performance`         | Compare Control UI CSS with the exact base revision and enforce asset budgets independently of artifact generation                                                                                                                                                                                       | UI/build/dependency/import owners and manual CI      |
| `control-ui-i18n`                | Verify generated Control UI locale bundles, metadata, and translation memory; advisory on automatic runs, blocking on manual release CI                                                                                                                                                                  | Control UI i18n-relevant changes and manual CI       |
| `checks-baseline-ratchets`       | Baseline ratchets, including environment-variable counts, max-lines suppression, PR line-cap growth, assertion safety, config docs, and plugin inventory; run alongside Node test shards and remain required by `ci-gate`                                                                                | Node-relevant, non-frozen targets                    |
| `checks-fast-core`               | Parallel fast Linux correctness lanes: startup corpus, coercion helpers, bundled + protocol, Bun launcher, and the CI-routing fast task                                                                                                                                                                  | Node-relevant changes                                |
| `qa-smoke-ci-profile`            | Self-contained balanced parts of the automatic QA Smoke coverage set; one private-overlay build per part (the smoke set has no docker-lane or Control UI scenarios; the run step rejects any such scenario)                                                                                              | QA-owned main changes and ordinary manual CI         |
| `checks-fast-contracts-plugins`  | One setup shared by two sequential weighted plugin contract processes; frozen targets keep separate rows                                                                                                                                                                                                 | Node-relevant changes                                |
| `checks-fast-contracts-channels` | One setup shared by two sequential weighted channel contract envelopes; frozen targets keep separate rows                                                                                                                                                                                                | Node-relevant changes                                |
| `checks-node-*`                  | Changed-target Node tests on pull requests; compact integration shards on `main`; metadata-complete compact fallback on broad PRs; full named shards on manual and release runs                                                                                                                          | Node-relevant changes                                |
| `docker-seed-e2e`                | One Docker scheduler job; main retains the published-upgrade survivor with legacy operator state and an authenticated managed restart; ordinary manual/release CI adds the four MCP and update-channel lanes                                                                                             | Every admitted upstream main run; ordinary manual CI |
| `check-*`                        | Sharded main local gate equivalent: guards, transient npm-lock validation, bundled-channel config metadata, prod types, lint, dependencies, test types                                                                                                                                                   | Node-relevant changes                                |
| `check-additional-*`             | Boundary check stripes (including prompt snapshot drift), session accessor/transcript reader/SQLite transaction boundaries, extension lint groups, package boundary compile/canary, and runtime topology architecture; the pure-reporting plugin SDK API diff runs on manual and release dispatches only | Node-relevant changes                                |
| `checks-node-compat-node24`      | Node 24 minimum compatibility build and smoke lane                                                                                                                                                                                                                                                       | Full Release Validation and manual dispatches only   |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                                                                                                                                                                                                                            | Docs changed (PRs and manual dispatch)               |
| `native-i18n`                    | Verify native source extraction and localization safety on source PRs and release gates; enforce generated parity on generated PRs, generated-scope release gates, and ordinary manual CI, with warnings for proven obsolete native IDs, Android rows, and Apple catalog rows                            | Native i18n-relevant changes                         |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                                                                                                                                                                                                                                   | Python-skill-relevant changes                        |
| `checks-windows`                 | Windows-specific process/path tests plus shared runtime import specifier regressions                                                                                                                                                                                                                     | Windows-relevant changes                             |
| `macos-node`                     | Focused macOS TypeScript tests: launchd, Homebrew, runtime paths, packaging scripts, process-group wrapper                                                                                                                                                                                               | macOS-relevant changes                               |
| `macos-swift`                    | Swift lint and build for the macOS app, plus tests for the app, shared OpenClawKit, and standalone Swabble package                                                                                                                                                                                       | macOS-relevant changes                               |
| `ios-build`                      | Debug build and Swift lint smoke; hourly main runs native tests; full manual CI also adds a Release device phase                                                                                                                                                                                         | iOS/capture changes and full manual CI               |
| `ios-screenshot-capture`         | One simulator build with the locked Ruby/Fastlane bundle, followed by all four iPhone captures, four 13-inch iPad captures, and one Watch capture. Phase timings and hardware diagnostics remain available.                                                                                              | Screenshot-input changes and full manual CI          |
| `ios-screenshot-evidence`        | Hosted reducer that verifies exact artifact/family topology, digests, one successful OpenClaw-managed capture per screenshot, and run provenance before publishing the release screenshot artifact; replacement attempts cannot turn failed captures into passing evidence                               | After the combined screenshot capture                |
| `android`                        | Phone and Wear unit tests, debug builds, Android lint, and Kotlin lint                                                                                                                                                                                                                                   | Android-relevant changes                             |
| `android-screenshots`            | Phone and Wear emulator captures using the same script as Play Store releases, with scene readiness and JPEG validation; retains images and synthetic fixture diagnostics                                                                                                                                | Screenshot-input PRs and full manual CI              |
| `openclaw/ci-gate`               | Final aggregate: requires preflight and security; rejects selected skips and every downstream failure or cancellation                                                                                                                                                                                    | Every non-draft CI run                               |
| `openclaw-performance`           | Separate workflow: daily/on-demand Kova runtime performance reports with mock-provider, deep-profile, and GPT 5.6 live lanes                                                                                                                                                                             | Scheduled and manual dispatch                        |
| `docs-external-links`            | Separate workflow: Docs External Link Audit checks external documentation links with lychee and uploads a report; it reports findings without failing, so it never blocks a pull request                                                                                                                 | Scheduled and manual dispatch                        |

A reducer-only rerun can reuse the successful combined screenshot capture from an earlier attempt of the same run. The reducer still requires matching source and workflow SHAs, run ID, pinned tooling, artifact digests, and successful captures. All three families must come from one capture attempt. The final manifest preserves that producer attempt and records the reducer attempt separately; future-attempt artifacts remain invalid.

Android screenshot capture runs phone and Wear serially on `ubuntu-24.04`, using
the shared Android toolchain action's API 36 phone and API 34 Wear images and KVM
setup. It calls `pnpm android:screenshots`, the script also invoked by the Android
Fastlane release lane, without signing or store credentials. Capture failures,
cancellations, and selected skips fail `openclaw/ci-gate`. Artifacts retain JPEGs,
source/hash manifests, UI dumps, activity starts, and emulator/app diagnostics for
14 days, including available evidence from failed captures.

Selection covers Android app and build inputs, screenshot tooling, shared assets,
native protocol and locale generation inputs, and CI setup. Ordinary JVM tests,
benchmark-only changes, store listing metadata, and documentation do not select capture. Unavailable
changed-path information selects capture. Like iOS screenshots, the lane excludes hourly main,
compatibility targets, and partial npm release scopes. It checks pipeline integrity
and scene readiness; it does not compare pixels against a baseline.

### Test runtime selection

Pull requests and automatic main CI use the pinned Bun fork. The planner
selects `bun-all` for every Linux test lane routed through
`scripts/lib/ci-test-runtime.mts`, including Control UI Chromium unit shards and
plugin prerelease extension batches. Full Release Validation uses `dual-all`:
the complete Node selection runs first, followed by its Bun portion in the same
runner slots. Either runtime failing fails the job.

Manual dispatches retain the optional `test_runtime_policy` override: `node`,
`bun-all`, or `dual-all`. Leaving it empty uses the event default: Bun for daily
CI and main-shaped validation, both runtimes for full validation. To force Node
for an existing ref:

```bash
gh workflow run ci.yml -f target_ref=<ref> -f test_runtime_policy=node
```

`bun-all` sends all selected configs, include patterns, and extra Vitest arguments
to Bun except the exact Node-only contracts and confirmed fork defects recorded
with their reasons in the runtime owner. Those files retain Node coverage.
Native Bun test-runner qualification remains limited to its verified inventory;
other files use Vitest on Bun.

Every selected Bun process checks its revision against
`scripts/lib/openclaw-bun.json` before launch. Missing or upstream Bun fails with
the job identity and setup instruction. The existing `setup-test-bun` action
installs the pinned fork for jobs that need it.

The workflows retain their job definitions, matrix shapes, runner classes, and
concurrency caps. Both runtime passes reuse the selected runner; there are no
per-runtime duplicate jobs. Runtime-specific timing estimates can repack selected
tests within the existing planner caps. `dual-all` doubles
each selected Linux test row's deadline, including the default 60-minute budget,
to cover its sequential runtime passes. `bun-all` keeps the original deadline.
macOS and Windows runtime policies remain unchanged.

The following direct-entrypoint lanes still use Node and remain follow-up work:

| Remaining Node lane                                          | Work needed before a Bun trial                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Plugin/channel contract shards                               | Route each contract envelope through the runtime owner, retain include files and cleanup admission, and install the pinned fork. |
| `checks-fast-core`                                           | Separate static/build checks from test envelopes and route those envelopes, preserving sequential failure handling.              |
| `build-artifacts` dist/core-boundary tests and TUI PTY proof | Route direct build-dependent test commands and install the pinned fork without changing artifact ownership.                      |
| `checks-node-compat`                                         | Keep its named Node-version compatibility proof; add a separate Bun contract if needed.                                          |
| `qa-smoke-ci-profile`                                        | Thread runtime selection through the QA harness and its subprocesses, with isolated artifacts and pinned setup.                  |
| `postgres-conformance`                                       | Teach the database conformance launcher to select and verify the runtime, retaining PostgreSQL service lifecycle.                |
| `checks-ui-e2e` and `checks-ui-e2e-real-gateway`             | Route browser fixtures and Gateway subprocesses together; prove browser/Gateway lifecycle on both runtimes.                      |
| Control UI's auxiliary WebKit step                           | Route its direct project invocation through the runtime owner and retain WebKit-only selection.                                  |
| `docker-seed-e2e`                                            | Install the fork inside the test images and thread selection through container entrypoints.                                      |
| Plugin prerelease Node/static shards                         | Route test commands individually; keep compiler, package, and static checks with their existing owners.                          |
| `node-runtime-compat` / `node-runtime-conformance`           | Preserve the intentional Node/Rust compatibility matrix; define separate Bun proof rather than replacing it.                     |
| `openclaw-performance`                                       | Add runtime identity to benchmark artifacts, isolate runs, and compare matching workloads before changing performance baselines. |

The protected cache warmer continues to publish its existing Node/Bun inventory.
Timing learning, refit, and refresh keep separate identities for Node,
`bun-all`, and `dual-all`. A `bun-all` measurement covers its complete envelope:
Bun/Vitest, native Bun, and any named Node companions. A `dual-all` measurement
records the combined wall time of its sequential runtime passes. Old `bun:`
timings from qualified partial selections are not reused. Per-runtime pruning
cannot remove the other policies' samples, and failed or incomplete measurements
never become timing samples.
Until matching policy measurements exist, scheduling retains historical Node or
release-envelope estimates. Measured runtime-placement observations never fall
back across policies.

Five paired main trials established the switch: runs
[38870726251](https://github.com/openclaw/openclaw/actions/runs/38870726251),
[38902779924](https://github.com/openclaw/openclaw/actions/runs/38902779924),
[38989076752](https://github.com/openclaw/openclaw/actions/runs/38989076752),
[39034539771](https://github.com/openclaw/openclaw/actions/runs/39034539771), and
[39042099307](https://github.com/openclaw/openclaw/actions/runs/39042099307).
Bun/Node aggregate wall-time ratios ranged from 0.727 to 0.752 across roughly
400 paired Linux shards; the fifth trial had no incomplete shards. Individual
families can still be slower on Bun, so comparisons retain per-shard results.

Compare an existing run without dispatching another one:

```bash
node scripts/ci-compare-test-runtimes.mjs <run-id>
```

The comparison downloads logs once and reports each shard's Node and Bun wall
time, failures, and incomplete measurements. Dual validation reuses the selected
jobs and their runner registrations. The `dual-all` deadline multiplier budgets both serial
runs; a silence-watchdog failure or exhausted budget remains failed or incomplete
evidence and is never treated as a timing sample.

CI's `setup-test-bun` action consumes `scripts/lib/openclaw-bun.json` through
`scripts/stage-openclaw-bun.sh`, the same owner used by the macOS and Tauri apps.
Every pin bump requires **both** the paired CI Bun-lane replay and Bun-only smoke,
and the macOS runtime checks plus two-binary test set, against the same published
fork tag. Neither app nor CI advances if either gate fails; Linux-only runtime
regressions stop the shared repin too. Preserve the last jointly admitted tag
and attach exact-tag evidence to the repin PR. Publication alone is not admission.
Shared pin/stager changes select macOS, Linux companion, and Bun test lanes.
See [the shared pin schema and regeneration](/platforms/mac/dev-setup#shared-bun-pin-and-repin-gate).

Linux test shards select Bun through `scripts/lib/ci-test-runtime.mts`. The
ordinary unit-fast lane partitions its existing file inventory: Node diagnostic
reports, transferable pipe-handle contracts, and the native Node/SQLite history
benchmark stay on Node; the compatible remainder runs on Bun. Those Node files
still execute; they are not excluded from CI. The isolated unit-fast lane
runs completely on Bun.

Bun test processes disable the Node-compatible bytecode cache because the pinned
fork generates bytecode during Vitest teardown. Bun's transpiler cache and the
Vitest transform cache remain available. Node orchestration, worker compilation,
and Node test selections retain their existing cache settings.

Bun's Vitest parent completes the shared SQLite native-close check before
creating test threads. Each worker inherits that decision, allowing capable
runtimes to reuse readers while negative checks retain conservative cleanup.

Audited ordinary unit-fast tests use Bun's native test runner, including
qualified async callbacks and self-contained zero-argument setup hooks. Hooks
that take a Vitest context retain Vitest: Bun interprets a hook parameter as a
completion callback. Tests that register a pending promise
assertion before settling it retain Vitest: native Bun waits inside that matcher.
The same runtime owner intersects their qualification data with the
standard inventory and each existing stripe's include patterns. The remaining
files keep Vitest on Bun. Native admission checks test, setup, and
fixture-helper bytes; changed or unreadable inputs return the affected tests to
Vitest without dropping coverage. Production sources remain free to change and
are still exercised. Extra Vitest arguments, including cache-warming collection,
retain the existing Vitest path.

A changed shared setup fingerprint invalidates the entire native cohort.
Refreshing those fingerprints requires fresh qualification of the retained
entries; tests without matching proof keep their Vitest coverage.
CI preflight inspects the recorded fingerprints once per workflow attempt. When
shared setup, test, or fixture-helper inputs change or become unreadable, it adds
one notice and a job-summary section listing the stale entries and affected
inputs. This report does not change runtime selection or fail CI. Shards do not
repeat the notice; local planning and historical targets without the inspector
remain silent.

Native Bun receives explicit file paths, the existing hermetic environment setup,
the repository tsconfig, and the shared test deadline. It disables automatic env
file loading and runs one test process inside the existing plan and worker budget.
The shared process owner retains output watchdogs, interruption handling, and
joined descendant cleanup. Release validation runs the complete Node selection
before the Bun/Vitest and native Bun portions in that same slot;
every result remains required. Native execution adds no CI jobs or worker fanout.

The runtime owner's named Node routes cover documented Node/V8 contracts and
confirmed fork defects. They remain exact-file exceptions even for broad or
mixed selections; new configs and include patterns use Bun without adding an
allowlist entry. The owner preserves config exclusions, selected files, pools,
and worker budgets. The shared Vitest config resolves `ws` to the installed
package so imports and mocks use the same module identity on both runtimes.

Control UI uses three native shards and three workers per row, including
exact-target Full Release Validation dispatches. The runtime partition applies
after Vitest selects a shard, preserving original file ownership. Files with
Node-only heap or WeakRef contracts keep Node coverage; the remaining selection
uses Bun. `dual-all` runs the original shard on Node before its Bun portion.
Partitions without browser files retain browser discovery for native sharding
but omit Chromium version checking and Playwright's speculative browser startup.
Historical targets without runtime-selection support retain their original Node
behavior and unsharded browser package command.

On both runtimes, non-isolated UI projects without cached test results group
files by environment and options after native sharding. The sequencer targets
96-file batches and spreads smaller environments across the same rounds to
reduce restarts without keeping every compatible file in one long worker run.
Native ordering within each environment, project order, coverage, isolation, and
worker budgets remain unchanged. The batch target is a scheduling heuristic,
not a worker-lifetime or memory limit; the native pool still decides reuse.
Cached projects retain Vitest's failure/duration ordering, and explicit file
shuffling retains its native seeded order.

The UI runtime owner delays FTL compilation with warmup/soon thresholds of
512000/8000. These short-lived workers benefit from less compilation work;
the protected cache publisher uses the same policy when collecting its seven
standard UI seed files on Bun. PR jobs restore that Bun seed alongside the
Node seed, with separate transform-cache leaves.
The same owner sets `MIMALLOC_PURGE_HOLES_MIN_INTERVAL=1000` to reduce allocator
scavenger work between short UI updates; normal reclamation and default heaps remain enabled.

The test-runtime setup action installs a checksum-pinned prerelease of `openclaw/bun`
only for jobs that need it. The source commit, archive checksum, and executable
checksum live together in `scripts/lib/openclaw-bun.json`, shared by CI and the apps.
The shared stager checks the release zip and manifest against `SHA256SUMS`, then checks
the extracted executable against the manifest. Independent archive and executable
pins keep the selected bytes fixed even if release metadata changes.
The fork owns the backing storage of `node:vm` cached bytecode, so compiled
functions remain valid after the original cache buffer is garbage-collected.
It also keeps allocator ownership during zero-time event-loop polls, while
retaining the idle handoff for polls that can block.

The pinned build pairs Bun `807211511f81e0a6639bc9eb41d67120f6b85316` with WebKit
`a2976f02e69fde8ccc45dc8fb346173f9d63f8a1` in prerelease
`openclaw-v1.4.4-20261024-807211511f-webkit-a2976f02e6`.

It restores SNI set with `tlsSocket.setServername()` before connecting, including
with `autoSelectFamily` ([fork change #197](https://github.com/openclaw/bun/pull/197)).
The Buffer copy reduction was withdrawn pending a container-neutral design;
serialization remains unchanged from the previous `ef37c31de3` pin.

It includes 58 upstream Bun commits through `ad4089bf`, including native
lint/format performance improvements and `--no-script` to bypass package scripts.
The engine replays the 16 fork patches onto upstream WebKit `87ee10da`.
It retains disabled source-map handling in the transpiler cache and shares
identical `node:vm` source buffers and source-map URIs.
This build preserves `DONT_CONTEXTIFY` global receiver identity for jsdom, keeps
`availableParallelism()` independent of `navigator`, and fixes `SourceMap.findOrigin()`
coordinates. It registers `fs.watch` callbacks on the returned watcher, treats
`ENOTDIR` as no entry for non-throwing stat calls, settles IPC send callbacks after
peer disconnect, and binds `FileHandle.close()` to its handle. Exiting Workers close
their owned file handles and tracked descriptors. A per-Worker hash set avoids
quadratic descriptor tracking during file open/close workloads. Corked HTTP responses
use the socket's Writable queue; the uncorked fast path is unchanged.
This build sends TLS SNI only for an explicit, nonempty `servername`, completes
missing cached function bytecode in place, and uses GreedyDual-Size eviction at
the same 256 MiB per-VM cache budget. Completed Workers release user listeners
while retaining Bun's internal `newListener` and `removeListener` hooks;
`eventNames()` therefore still exposes those two internal events after exit.
It measures CPU profiles over the full monotonic capture interval, drains
Worker stdio before exit, preserves unpaired UTF-16 surrogates in `node:path`, and
waits for the final socket write before setting `ServerResponse.writableFinished`.
It cancels destroyed child stdin only when a write is pending, exposes native HTTPS
request sockets as `tls.TLSSocket`, and preserves cloneable Worker loader errors.
ESM specifiers now decode URL escapes per Node; a literal `#` starts a fragment,
so filenames containing `#` must use `%23` in their import URL.
It retains shared source buffers on `node:vm` cache hits, refactored module
resolution, Node-compatible TLS teardown, subprocess retirement fixes, and
enforces Node-compatible process and Worker heap limits. It fixes N-API cleanup
and external strings across Workers, releases Worker-local event-name state,
and skips the preliminary full collection at Worker shutdown. WebKit fixes
stale VM-entry storage initialization, uses a two-pointer VMEntryScope, and
fixes Linux foreign-stack suspension deadlocks.
It retains deferred VM bytecode generation, integral heap-sampling byte sizes,
inspector snapshot cleanup, and the previous worker heap-cap, module-resolution,
test-deadline, GC cadence, and idle-worker fixes. The release publishes
Darwin/Linux targets and Authenticode-signed Windows x64/arm64 targets from the
OpenClaw Foundation. Darwin executables remain Developer ID signed and notarized;
the shared pin records Windows targets as signed and not test-only.

The build adds an adaptive, bounded `node:vm` compilation cache for large module
graphs. It activates after 1,750 distinct compiled sources and defaults to a
256 MiB byte budget per VM. CI uses these defaults. This cache is separate
from the Node-compatible bytecode cache disabled for Bun test processes above.

The build retains synchronous
`module.registerHooks` resolve/load chains and deregistration. JavaScriptCore
limitations remain explicit: static input attributes are unavailable, static cycles
can repeat resolution, and completed imports can be reused by `require`.
Unsafe in-flight record collisions throw `ERR_MODULE_HOOK_REENTRANCY`, and static
resolve-returned type attributes throw `ERR_MODULE_HOOK_ATTRIBUTE_IDENTITY`.
The plugin loader keeps its Bun-native path even when hooks are available;
tooling and fixtures that call hooks directly use the new implementation.
Hooks receive valid WHATWG URLs for Bun-replaced packages and virtual modules,
while native loading keeps its original module identity. Installed replacements
expose file URLs; missing packages and opaque virtual IDs use `bun-builtin:` and
`bun-virtual:` URLs. This avoids tsx `Invalid URL` failures without replacing Bun's
native implementations.
It retains fixes for child-process
spawn tracing outcomes, preservation of destroy errors during in-flight socket writes,
MessagePort creation async context and emitted payloads, retained duplicated standard
I/O descriptors, inherited `NODE_OPTIONS` preloads, and socket standard I/O shutdown.
Forced full GC now completes in-flight JIT plans, addressing the usage-page retention
failure. The standard I/O
shutdown workaround remains necessary for supported stock Bun releases.
It retains fixes for worker heap capacity reporting, OS-visible `process.title`,
synchronous event-listener exception propagation, and queued WebSocket upgrades.
Runtime auto-install defaults to off: fixtures must declare and install their
dependencies. Darwin watch coalescing does not affect Linux CI.
It retains fixes for post-script `--` argument separators, hidden CommonJS data
exports, large native standard I/O writes, and Darwin kqueue file watches.
It retains fixes for compile-cache idle wakeups, `v8.queryObjects`, repeated
native readable `ref`/`unref` calls, the default `module-sync` condition, and
`process.once` wrapper identity.
It retains the upstream Bun sync through `4b02e1031d` and fixes for thread-safe
function ownership, shared-environment deletion, and a module-key crash.
The shared provider-catalog retention test is qualified on this build and runs
on Bun; unqualified tests that assert V8 heap behavior continue to run on Node.
UI retention tests use the local inspector's `HeapProfiler.collectGarbage` on
both runtimes. Only an unavailable inspector method permits the older Bun GC
fallback. The runtime owner retains exact Node-only retention routes where
JavaScriptCore conservative stack scanning prevents forced WeakRef collection.
The fork keeps the lifecycle-script `node` shim in a per-user directory, with a
private fallback when that directory is unusable. `NODE` and `npm_node_execpath`
point to the executable in either location. This lets several accounts on one
host run Bun installs without Node. The same build retains the tsconfig,
diagnostics-channel, and inspector/GC fixes. Its prerelease tag includes both source revisions because `Bun.revision` alone
does not distinguish builds linked against different WebKit revisions.

Node continues to own orchestration, builds, compiler preparation, and cleanup.
Vitest and its workers use the selected runtime; qualified native selections use
`bun test` and skip Vitest compilation and transform caching. Bun/Vitest, native
Bun, and Node have separate timing identities, and the two Vitest runtimes keep
separate transform-cache directories. Any test engine failing fails the job.
Both runtimes reuse the selected matrix rows and runner registrations.

`NODE_OPTIONS`, where configured, limits Node heaps; the UI lane retains Node's
default heap limit. Bun does not use that V8 limit. Compare observed memory use alongside elapsed time before admitting more
lanes. Compatibility evidence must use the exact fork build installed by CI;
stock Bun results and different fork revisions are separate measurements.

### Node execution and runtime compatibility

Most Node test, lint, and typecheck jobs currently inherit `24.x` from
`.github/actions/setup-node-env`; the Node shard also supplies that default
explicitly. The composite's `ensure-node.sh` reuses a matching active or cached
runtime before downloading one. A wildcard therefore does not guarantee the
newest patch. Compare exact versions when measuring a toolchain change, and
measure setup separately from the test body.

Preflight's manifest bootstrap uses the exact `NODE_VERSION` pin in `ci.yml`
(24.22.1). Unlike the repository helper, `actions/setup-node` can satisfy a
`24.x` request from an older cached patch below OpenClaw's support floor.

CI's execution version does not define the supported user runtime matrix.
`package.json` accepts Node 24.22.1+ and Node 26.12.1+. The full manual CI graph checks
the Node 24.22.1 floor; `node-runtime-compat.yml` checks Node 26.12.1 weekly and on
dispatch. Current packaged fresh-install and upgrade checks run on both
Node 24.22.1 and Node 26.12.1, with Windows Node 24 fresh-install proof on 24.22.1.
Both runtime variants use the same candidate package. These support cells stay
independent of changes to the ordinary execution pin; source/build smoke alone
does not prove an installed upgrade. See the
[package validation matrix](/ci/release-validation/package-acceptance).

Select a supported Node runtime before project commands, including lightweight
workflow checks and release orchestration. Hosted images can default to Node 22;
an absent version pin does not prove a supported runtime. Runner images can also
contain unused older toolchains, and recovery bundles intentionally retain
older syntax targets so unsupported runtimes can print upgrade diagnostics.
Those are separate from the supported runtime and test-job versions. GitHub
JavaScript actions also have their own runtime, independent of the `node` on
the job's `PATH`.

### iOS simulator evidence

iOS and Watch simulator test commands write complete `xcodebuild` output directly
to files. Forwarding simulator logs into a congested Actions pipe can stall timed
test operations before their mocked transport runs. After each command exits,
CI prints at most 8 KiB of its log and preserves its exit status. The lifecycle
evidence artifact retains the full logs alongside `.xcresult` bundles on success
and failure; test timeouts, assertions, and diagnostic collection stay unchanged.

### macOS Swift phases

`macos-swift (tests)` builds and runs the app's complete default- and named-profile
test partitions with coverage. `macos-swift (packages)` independently runs the
OpenClawKit Talk-trait opt-out build, OpenClawKit tests, and Swabble tests. These
separate package graphs previously ran before the app build in one job; a hosted
baseline spent 7m57s on them in a 21m48s job. Separating them gives app compilation
and tests their own 30-minute budget without removing coverage or increasing
test-process parallelism.

Package tests start after preflight and do not consume the Linux runtime artifact.
App tests wait for `build-artifacts` before allocating their macOS runner, so Linux
runner queueing cannot consume the native test job's 30-minute budget. They download
the producer's artifact by its output ID and verify the selected checkout SHA before
execution. Failed-job reruns retain the successful producer's artifact output.
The aggregate CI gate still requires the Linux checks and both native phases.

Full nonpublishing manual validation also stages the exact candidate runtime and runs
ordinary bundled recovery and relaunch through two fresh `.app` test-host processes.
The existing launcher owns their private home, Keychain, selected service, and process
settlement. Both phase event streams are retained in `macos-bundled-recovery-proof`.
Only this full-tier test phase has a 75-minute budget for the runtime build, staging,
and native composition; ordinary tests and independent packages retain 30 minutes.
The proof does not sign or publish an app.

App tests run in three sequential launcher invocations: the default-profile suite,
rendered Quick Chat in a fresh default-profile process, then named-profile fixtures.
The rendered suite keeps its catalog, disclosure, and shortcut flows together and
separate from tests that change the process-wide executor. Each partition retains
coverage instrumentation and completion checks; ordinary CI failures do not stop later partitions.
Rendered Quick Chat uses an AppKit-owned run loop for native menu tracking.
Historical targets with a launcher retain their original default- and named-profile
partitions, including XCTest's rendered-flow ordering.

Each launcher invocation retains a full log in the `macos-native-test-logs`
artifact. CI forwards only a bounded tail after the invocation exits, keeping
Actions log backpressure outside the tests while preserving process and output
closure checks before resource cleanup.
The default-profile capture artifact retains each invocation's directory, so
browser sign-in captures from the bulk suite survive the later Quick Chat run.

Both phases use Xcode 27 on GitHub-hosted `xcode-27`, the preview macOS 27
image, with at most two concurrent jobs. Full manual
validation adds the existing `release` phase under the same cap. The package split adds one
hosted Mac job and its checkout/setup cost per selected run, with no additional
Blacksmith registrations. Compare complete hosted timings, including queue and
setup time, before treating the removed serial work as an observed speedup.

The Xcode 27 rollout preserves the existing hosted placement, job counts,
30-minute phase budgets, coverage, and Swift 6.3 source-language minimum.
Native builds/tests and complete job timings must qualify the new toolchain;
the earlier package-split measurement does not establish its performance.

Only the app phases restore the app build cache. SwiftPM dependency caches remain
restore-only in `packages`; the existing primary phase owns shared cache writes.
The aggregate gate requires every selected phase to succeed.

Debug Swift CI builds omit the IDE index and use line-table debug information.
Coverage instrumentation and source-line backtraces remain enabled; interactive
debugger type/value inspection requires a normal local debug build. The app test
cache uses a separate build profile so it cannot restore the old indexed products;
Release build flags and caches remain unchanged.

The macOS Periphery jobs build tests with the native SwiftPM backend and its
scratch directory and index store under `.cache/periphery-swift`, then scan that
index with `--skip-build`. An explicit index path makes Periphery skip its build.
Periphery 3.8 unconditionally excludes `.build` sources, which would hide first-party protocol
models generated by the SwiftPM plugin. The separate scratch path makes those
models visible while its dependency checkouts remain excluded. Native test
crashes emit noninteractive Swift backtraces, without register dumps.

Ordinary Markdown and MDX pages under `docs/`, plus root `README.md`, retain
their separate `check-docs` coverage beside precise pull-request Node tests.
Page deletions and renames preserve this targeting. Explicit Node owners for
Markdown inputs remain selected; workspace templates under
`docs/reference/templates/` and unowned source inputs retain the full fallback.

When `docker-seed-e2e` selects the published upgrade survivor, it uploads
`docker-seed-upgrade-survivor-proof` even after a failure. The artifact contains
scheduler summaries and sanitized survivor reports. Failed reports include
bounded, redacted baseline and candidate agent-turn output; private scenario
state and raw logs remain outside the upload.

Full upstream `main` pushes run the operator config and prior-release state
startup corpora once through the Node `runtime-config` owner. Upstream pull
requests also omit the duplicate **Check startup corpus** step when preflight
certifies every corpus file in the required Node matrix on the exact same
checkout revision. Partial, filtered or unknown plans retain the explicit step;
release-gate dispatches retain their separate merge-tree proof. Both state
repair passes, all static baseline ratchets and required Node failure aggregation
remain unchanged.
Eight state test files share one matrix inventory so the executor can distribute
all release/config pairs across workers. Each pair still runs both Doctor and
Gateway startup checks. The explicit step prepares the runtime once with
`pnpm build qaRuntime`, then runs the config corpus and all eight state files in
one Vitest process with at most four workers. A failed preparation stops the step
before workers consume memory or attempt their own builds. Frozen targets from
before the file split retain their config process and four state processes,
admitted in batches with one slot per four available CPUs (at least one slot).
A failed corpus run is reported while the remaining shards still run.
The corpus uses the normal bundled-plugin resolver to select the prepared
runtime from this checkout instead of forcing TypeScript plugin entrypoints.
Plugins whose Doctor contracts require source loading retain that behavior;
the complete config/state matrix and its assertions remain intact.

Ordinary pull requests that change only independent Control UI unit-test entries
keep all three UI unit rows and existing type/lint gates,
without repeating dedicated UI E2E jobs. Browser and Node test entries, shared
fixtures/helpers, production or build inputs, and tests imported by another
owner retain E2E coverage. Main pushes, manual validation, and frozen targets
keep their existing selection.

The `docker-seed-e2e` job uses `resolveDockerSeedLanes` from
`scripts/lib/ci-docker-seed-plan.mts` to select exactly
`published-upgrade-survivor` on every admitted upstream `main` run, independently
of changed paths. Docs-only pushes remain excluded at the trigger. The lane runs
`legacy-operator-state` against an exact published predecessor with `auto-auth`:
the published driver must update and replace the running managed Gateway.
Schema refusal or rollback fails the gate. Operator state, plugin convergence,
cron ownership, agent turns, no-op updates, and backup rollback assertions remain.

Main, including hourly `validation_tier=main` dispatches, prepares its smoke tarball with `pnpm build:ci-artifacts` followed by
`scripts/package-openclaw-for-docker.mjs --skip-build`. This retains all runtime
JavaScript, plugin assets, Control UI, metadata, and public SDK declarations;
the shared packer still runs its complete tarball integrity check. The
scheduler consumes that tarball through `OPENCLAW_CURRENT_PACKAGE_TGZ` without
rebuilding it. Full Release Validation children use the same smoke package;
ordinary full-tier manual CI retains the declaration-complete full package build.

Ordinary upstream manual CI retains the survivor and adds
`cron-mcp-cleanup`, `mcp-channels`, `mcp-code-mode-gateway`, and
`update-channel-switch`. This includes Full Release Validation's `normal_ci`
child in `full`, `npm-beta`, and `npm-stable` scopes. Frozen targets
must declare the Docker seed capability; targets without `resolveDockerSeedLanes`
retain the survivor fallback. CI loads the target's Docker tier planner directly.

The scheduler retains one 16-class Blacksmith runner on eligible main pushes.
Full Release Validation children also use that class when no release runner group
is configured; hosted outage overrides and retries retain hosted recovery.
Main, release, and ordinary manual CI retain serial weighted admission. Pull requests and their
exact-head fallback dispatches do not select this proof. Installed-driver
upgrade coverage remains required on every admitted upstream main run and
ordinary manual/release CI; the existing infrastructure timeout stays unchanged.
The job is part of `openclaw/ci-gate`. It uses at most one runner registration per
selected run; widening survivor selection does not increase the full-inventory
registration cap, job count, or matrix fanout.

The iOS and combined macOS Periphery workflows enforce zero dead-code findings for their apps. The combined macOS workflow builds one Swift index for separate app and shared OpenClawKit scans, alongside an independent iOS shared scan. It reports a shared declaration only when Periphery emits the same Swift USR from both consumers. The shared OpenClawKit workflow remains a manual entrypoint for those shared scans. Its generated `GenerateGatewayProtocol/GatewayModels.swift` build-plugin output is retained as generator-owned code rather than treated as app-local dead code. The shared scan and native CI jobs install the filtered gateway-protocol generator dependencies alongside their existing native asset dependencies; CodeQL installs the same generator dependencies before its Swift build.

All four scans use `scripts/install-periphery.sh` to install the checksum-pinned Periphery 3.8.0 OSS release, including its adjacent `libIndexStore.dylib`, in a dedicated runner-temporary directory. The installer rejects download, checksum, and version failures without falling back to Homebrew. Installer changes automatically select the iOS and combined macOS workflows, including both shared consumers.

[Upstream archived the OSS project](https://github.com/peripheryapp/periphery/commit/56a0eb6fb97b785c8fbc1044ccbc7b5d9f06ebec). The pin remains a maintainer-owned bridge, not a claim of ongoing upstream support. All four scans target Xcode 27 on GitHub-hosted `xcode-27`. Toolchain, pinned-release, or analyzer changes require native compatibility proof for both app scans and both shared consumers, preserving the zero-findings policy and exact-USR intersection without a baseline or weaker fallback. Four declaration-specific annotations retain confirmed SwiftUI false positives; they do not exclude their files or runtime tests from validation.

## Security review checks

Security review separates product changes that maintainers can approve from the
small set of security policy and enforcement files that require SecOps approval.

| Change                                     | User account with `maintain` or `admin` access   | Other authors                                                                    |
| ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Sensitive product code                     | Informational notice; no extra security approval | `/allow-security-sensitive-change` from a user with `maintain` or `admin` access |
| Dependency changes requiring review        | Same maintainer exemption                        | `/allow-dependencies-change` from a user with either role                        |
| SecOps-owned files in `.github/CODEOWNERS` | Independent SecOps code-owner approval           | Independent SecOps code-owner approval                                           |

The **Security Review** workflow runs both guards from trusted repository code.
It publishes a commit status named `openclaw/ci-gate` that requires both the
applicable approvals and a successful native CI gate from the latest applicable
CI run for the current PR head. Completed, wholly skipped pull-request runs do
not replace substantive CI runs. Newer running, failed, or canceled runs still
take precedence, and skipped release-gate dispatches still block approval. The
existing CI job retains its check with the same name.
GitHub requires both the check and the commit status when both share a required
context. Missing approval, failed CI, or evaluation errors fail the review status.
Missing or running CI leaves it pending and keeps merging blocked. CI completion
automatically evaluates it again. An unfinished run-list entry is refreshed by
exact run ID before waiting, so delayed list updates do not hide a completed
attempt. Approval comments do not rerun the test suite.

Every ten minutes, the resolver reconciles CI completions
from five minutes before the previous successful scheduled pass started until
five minutes ago (sixty-minute fallback, twelve-hour cap). Passes tile without gaps;
late or dropped cron ticks only widen the next window, up to the cap. Run listing
covers creation times from three hours before the window through the current time.
GitHub caps each filtered query at 1,000 results, so the resolver bisects ranges
whose reported total exceeds that limit. Each smaller range is paged until a short
page, and its distinct run count must cover the total reported on its first page.
Ten full pages or fewer distinct runs than reported fail the pass before any
status publication or matrix output, retaining the anchor for a complete retry.
Inclusive range endpoints are separated by one second, and run IDs are deduplicated
across pages and slices. A range shorter than ten minutes that still exceeds
1,000 runs fails before status publication or matrix output, so the covered window
does not advance. The next pass rescans from the last successful pass.
Scheduled resolver passes share one
concurrency group without canceling an active pass; GitHub keeps one
pending pass, which still starts from the last successful window.
Each pass selects at most 100 PR heads, oldest CI completion first, with run ID
breaking ties, and stops reading statuses when the cap is reached. If candidates
remain, the `reconcile-backlog` job fails the workflow after the selected reviews
finish. This keeps the same anchor: reviewed heads have fresh statuses, allowing
the next scheduled pass to select the remainder from the same window.

After a reconciler outage longer than twelve hours, older lost completions need
a new push or a Security Review rerun.

A CI rerun keeps its original creation time. A rerun of a run created more than
three hours before the window relies on its own completion delivery; if that is
lost, a new push or a Security Review rerun recovers it.

The resolver reads each head's status history in reverse chronological order and
uses only the newest `openclaw/ci-gate` status from `github-actions[bot]` with creator
type `Bot`. Other publishers are ignored. It schedules normal review when that
Actions-owned status is missing, older than CI completion, or pending. Only a
non-pending status created at or after CI completion is settled and stops
reselection. Every pending status remains eligible, including a review wait
published after a pre-completion CI read. Tiled windows bound the harmless extra
review when a head legitimately waits on newer in-progress CI. Wholly skipped
runs are ignored. It never checks out PR code.
Each pass costs one hosted `ubuntu-24.04` resolver job,
run-list reads plus paginated status-history reads per newly completed head,
and no Blacksmith registrations.

The Security Review Actions job succeeds when evaluation completes, including
when the required commit status blocks merging for missing approval or failed CI.
This prevents an earlier evaluation from leaving a stale failed job after automatic
reevaluation clears the status. Evaluation errors still fail the job and keep the
required status closed.

If the PR head changes before or during evaluation, the obsolete run stops
successfully without publishing approval for the replacement commit. The new
head's automatic event owns its evaluation. Closing an unmerged PR, making it a
draft, or changing its target also stops the obsolete evaluation successfully.
GitHub disabling maintainer edits as a PR closes does not prevent this clean stop
or completion of merged review evidence. Permission changes on open PRs, other
identity changes, and real evaluation errors still fail; a lifecycle change does
not hide an earlier guard error. Cleanup and merge admission retain strict checks.

A merge of the scheduled revision lets the security evaluation finish, including
when enforcement starts after the merge. Both guards retain their findings in
statuses, comments, and workflow summaries so a force-merge does not discard that
evidence. Automatic lockfile cleanup still requires an open PR immediately before
its write. The resolver selects only open PRs, so this does not schedule new
post-merge reviews. If ordinary CI is still running, the combined status can remain
pending after merge; the CI workflow retains its own final result.

During long read sequences, the review checks the live
PR again before admitting another read after 30 seconds. Non-quota recovery waits
check every 30 seconds too, so superseded work stops without finishing pagination
or waiting out diff recovery. In-flight requests retain their 30-second deadline;
writes and autoscrub cleanup are not interrupted. Server-directed rate-limit
waits must finish before another API request is allowed. Checkout and runtime
setup are outside these checkpoints. Per-head non-canceling publication
serialization and all final approval checks remain unchanged.

When GitHub returns a rate-limit response, the resolver and review scripts stop
API requests, honor `Retry-After` and exhausted-quota reset times, and restart
with fresh PR, approval, role, and CI data. Each script permits up to three restarts
within a shared 65-minute deadline for its job; individual HTTP requests still
have a 30-second timeout. Secondary limits without timing guidance use at least
one minute of exponential backoff. Small randomized delays spread retries after
quota resets. Jobs have a 75-minute ceiling, and waiting occupies their runner.
Recovery is automatic in the same run and does not require another PR event or
manual dispatch. Exhausted recovery fails the job; GitHub errors can also prevent
a new status from being published. Ordinary permission errors and other
evaluation errors are not retried.
Checkout, runtime setup, and separately minted autoscrub token expiry are outside
this recovery mechanism.

Transient commit-status publication failures also restart the complete evaluation.
HTTP `500`, `502`, `503`, and `504` responses and recognized connection failures
use one-, two-, and four-second delays, sharing the three-restart limit and job
deadline with rate-limit recovery. GitHub may have accepted the failed write, so
the review rereads current PR, approval, role, and CI data instead of replaying an
old decision. During enforcement, the same bounded recovery handles transient
sticky-notice creation and update failures. Each restart rereads comments and
updates an existing owned notice if GitHub accepted the earlier write, rather
than blindly posting another comment. Required approval remains required.
Automatic lockfile cleanup, other uncertain writes, cancellation, and write
request timeouts remain outside this publication recovery.

Separately, read-only `GET` and `HEAD` requests retry HTTP `500`, `502`, `503`,
and `504` responses and recognized transient connection failures before headers
arrive or while reading a successful response body. They share one retry budget
of one, two, and four seconds, within the original 30-second request timeout.
These retries exclude writes, caller cancellation, certificate errors, invalid
JSON, oversized responses, and unrecognized errors. HTTP, connection, and
response-body errors identify the request method and endpoint.

GitHub can persistently fail a 100-job page of a CI attempt while smaller pages
succeed. The review reads CI jobs at page sizes of 100, then 50, then 25. A size
above 25 skips the server-error retries and immediately requests the same job
range at half size. Pages at 25 jobs use the normal read retries, timeout, and
recovery. Enumeration must still reach the reported job count.

If a read-only request reaches its 30-second deadline, including while reading
its response body, the script restarts the complete evaluation with fresh PR,
approval, role, and CI data. These restarts use one-, two-, and four-second delays
and share the existing three-restart limit and job deadline. A persistent read
timeout fails the job. Write timeouts do not trigger this recovery because GitHub
may already have accepted the mutation.

If GitHub's changed-file count and file list disagree, or the count changes after
validation, the script restarts the complete evaluation after one, two, and four
minutes. These retries share the three-restart limit and job deadline with API
recovery. Each attempt rereads the full file list, PR metadata, approvals, roles,
and CI state; target, author, and other approval-relevant metadata must still
match the original evaluation. A newer head supersedes the obsolete run.
Both guards share each attempt's validated file list. On direct PR events, the
preparation step analyzes dependencies and completes both guards in one process
when no lockfile cleanup is needed. A cleanup candidate still passes through the
existing App-token/autoscrub steps and a fresh final enforcement. Only a completed
evaluation can skip the duplicate enforcement process; errors and ineligible PRs
leave that step active. CI-completion, scheduled, and command reviews keep their
separate enforcement step and publication admission. Recovery also runs within
the detection step, so a recovered mismatch does not leave an earlier step red.
A persistent mismatch fails the review and reports the expected, returned, and
current file counts.

The **Security Sensitive Guard** publishes `openclaw/security-sensitive-review`.
Its inventory in `.github/security-review-policy.yml` covers Gateway
authentication, pairing and permissions; credentials, secrets and redaction;
sandbox and execution policies; product security checks; and `.gitignore`.
Ordinary documentation, tests, and test support do not trigger this inventory.
Renames inspect both the old and new paths so moving a sensitive file does not
remove its review requirement.

The **Dependency Guard** publishes `openclaw/dependency-review` and retains its
dependency classification and lockfile autoscrub behavior. Dependency removals
that already qualify as informational remain informational.
Automatic lockfile cleanup is best effort. If neither cleanup App can provide a
write token, or GitHub explicitly denies the cleanup mutation's permissions, the
dependency notice explains how to remove the remaining changes or request
maintainer approval. These expected access limitations do not fail the Actions
job or satisfy dependency review. Unexpected cleanup errors remain failures.

Edit `.github/security-review-policy.yml` to change path classification. Its
`categories` group product paths with descriptions and review guidance;
`exclude` names the product-only exclusions; and `dependencies` lists manifests,
lockfiles, and other dependency files. Paths are quoted, repository-relative
globs: `*` stays within a path segment, `**` crosses directories, and `{a,b}`
matches either alternative. Hidden paths are included. Matching is
case-sensitive unless an exclusion explicitly sets `case-insensitive: true`.
Product exclusions never exempt dependency changes. The first matching product
category supplies the notice's guidance; matches are not CODEOWNERS rules.

The JavaScript loader handles validation and matching; it contains no path
inventory. Invalid policy fails security review. Both the
YAML inventory and its loader require SecOps code-owner approval. The workflow
loads them from the trusted checkout and installs only the locked parser/matcher
runtime through `.github/actions/setup-security-review`, with lifecycle scripts
and dependency caches disabled. That action's manifest and npm lock mirror the
root dependency pins and `pnpm-lock.yaml`; update them together when those pins
change. Approval decisions and dependency graph analysis remain in JavaScript.

Both guards use current repository permissions. Only GitHub user accounts with
`maintain` or `admin` access can grant command approval or receive the author exemption.
`write` access and organization membership are insufficient. A maintainer pushing
to an external contributor's branch does not transfer the author exemption.
Automation using a GitHub user account qualifies under the same role check;
GitHub App bot identities do not qualify.

For other authors, wait for the applicable guard notice to show the current PR
commit, then post the command on its own line in a new PR comment:

```text
/allow-security-sensitive-change
/allow-dependencies-change
```

Each command approves only its own guard. When both guards require approval, both
commands are required and can appear on separate lines in one comment. Use only
command lines in that comment, without prose, quotes, or code fences. Normal
GitHub **Approve** reviews and labels do not replace these commands.

The guard associates a command with the revision recorded in its trusted notice.
A command posted before the notice requests approval for that revision cannot
approve it. After a new commit, wait for the notice to update and post a new
comment. Editing an older comment does not grant fresh approval. Deleting an
approval comment or removing its command revokes that approval; current roles
are checked again whenever the guard runs.

GitHub commit statuses apply to a commit rather than one PR. Before publishing
success, security review verifies that the head belongs to only the current open
PR targeting that base branch. Duplicate heads block approval so one PR cannot
reuse another PR's author exemption or command. Close the duplicate PR or push a
distinct commit; security review evaluates the affected PRs automatically.

Each guard updates one PR comment with affected files, review guidance, the
current revision, and the remaining action. The sensitive-change label remains
after approval so reviewers can still identify the affected responsibility.
Trusted `issue_comment` events reevaluate approval commands and edits or
deletions of approval comments automatically. Edits inspect both the previous
and current text so removing a command still revokes approval. Ordinary comment
activity does not reevaluate the guards or change their statuses. Command mentions
in prose, quotes, or code fences are not approval comments. The workflow filters
ordinary comments before allocating a runner; a command mention can start the
lightweight resolver, which validates the syntax before scheduling review.
GitHub still records skipped workflow runs for ordinary comments.
Both guards share one review job, and comment events do not rerun the test suite.
Evaluation uses trusted repository code and GitHub metadata without
executing contributor code or comment text.

The hard tier lives only in `.github/CODEOWNERS`: security policy, ownership,
CodeQL, selected scanning configuration, and the security-review enforcement
closure. Keep SecOps as the sole owner on those entries. GitHub accepts any owner
on a matching line, and later matching patterns replace earlier ownership. The
release-manager entries retain their separate approval responsibility. This
inventory does not make every general CI or scanner change SecOps-owned.

The soft tier protects the review flow for fork contributors. It is not a
security boundary against hostile repository writers: another workflow with a
write token can publish the same status context. Binding the required context to
the GitHub Actions app identifies the publisher app, not the specific workflow.
This is an accepted tradeoff to avoid a separate credential-bearing publisher.
The existing maintainer CI bypass also permits bypassing missing command approvals.
Native CODEOWNERS review enforcement remains independent of these statuses and
that CI bypass.

Results apply to the PR head evaluated by the workflow. New PR heads, base-branch
retargeting, command comment events, and CI completion reevaluate automatically;
ten-minute reconciliation recovers lost CI-completion deliveries. Unrelated pushes
to `main` do not. Sensitive-path policy and permission changes
take effect on the next automatic evaluation. Guard execution does not require
manual dispatches or manual reruns.

### Enable enforcement after deployment

Merging workflow files does not enable GitHub merge protection. After the
workflow and the reviewed CODEOWNERS inventory are on the default branch:

1. Keep `openclaw/ci-gate` required and bound to the GitHub Actions app. Preserve
   the existing maintainer bypass and leave **Require branches to be up to date**
   disabled. The two review statuses remain visible without separate required-check entries.
2. Verify the native CI check and security review commit status on a PR's current
   head, including after command approval, a subsequent push, and CI completion.
   Confirm approval updates do not start another test run.
3. In a separate ruleset with no bypass actors, enable **Require a pull request**,
   **Require review from Code Owners**, and **Dismiss stale pull request
   approvals when new commits are pushed**. Verify that `openclaw-secops` is
   eligible for code ownership and that its approval is required for the hard
   inventory. Keep the general required approval count at zero if ordinary
   unowned changes should retain their existing review policy; code-owner review
   is a separate requirement. Existing release-manager entries also become required.
4. Verify that the CI bypass cannot skip the separate code-owner review rule.
   Requiring a PR also restricts direct pushes to the protected branch.

Verify the live GitHub settings and the maintainer, external contributor,
automation account, and SecOps-owned-path cases before declaring enforcement active.

<a id="fail-fast-order" />

## Job ordering and failure reporting

1. `preflight` decides which lanes exist at all. Mobile protocol event coverage runs in the existing required `security-fast` job, so a correctness failure cannot suppress the manifest fanout. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs. Upstream `main` starts immediately in one of two parity slots; each slot admits one complete run and coalesces later pushes into its newest pending tip. Downstream jobs wait for the manifest, then eligible Blacksmith jobs restore exact dependencies from the trusted warmer or fall back to the ordinary pnpm-store cache on a miss. Pushes, pull requests, and manual runs targeting the workflow revision run preflight with native Node and skip dependency setup. Manual runs targeting a different revision install dependencies and retain that target's `tsx` tooling.
2. `security-fast`, `check-*`, `check-additional-*`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs. Additional checks start directly after preflight. Narrow PRs with additional checks also place the existing `check-guards` and `check-dependencies` rows there: their complete guard, dependency, unused-file, and export scans do not consume the installed compiler/lint plan. Guards use the same commands and fetch the exact comparison base during checkout. Full selections and runs without that family retain the central rows, and the aggregate requires each selected owner. Extension-only compiler inputs can be planned from the four noncore graphs when an already selected additional boundary row owns the full core graph check. This requires existing regular source files without symlink aliases; mixed source changes retain complete discovery, and missing or uncertain inputs retain full checking. Known full selections skip discovery and retain boundary proof in an already selected additional boundary row or the required planner. No extra boundary row is admitted for that optimization. Ordinary pull-request, push, and scheduled CI skip the production dependency audit. Only `workflow_dispatch` IDs beginning with `full-release-validation-` or `release-native-android-` run it. The audit sends one complete graph with up to four attempts and a four-minute total request budget, including retries and response reading. Every non-zero audit exit produces a warning and exits 0, including findings, unavailable advisories, and invalid data. An unavailable audit is incomplete coverage, not a clean result. The optional pre-commit audit hook uses the same warn-only wrapper. The separate daily [Dependency Audit](/ci/scheduled-workflows#dependency-audit) remains strict for triage, is not a required PR check, and points to a dependency-bump follow-up. Release dependency evidence retains its separate known-malware gate; vulnerability advisories remain warnings.
3. `build-artifacts` and the locale checks overlap with the fast Linux lanes. Control UI and native app source PRs exclude generated locale snapshots/resources; their serialized refresh workflows repair and auto-merge isolated generated PRs in the background. Source CI still blocks stale source inventories and unsafe localization calls. Generated PRs, manual CI, and release prep enforce full translated/platform-generated parity. Upstream `release/YYYY.M.PATCH` branches may include release-prep locale repairs with the other generated release output.
4. Baseline ratchets and selected Node test shards start independently after preflight. Node rows consume the manifest, not ratchet outputs. `ci-gate` still requires every selected ratchet to pass; a failed ratchet leaves sibling jobs running. Frozen targets retain their existing ratchet selection.
5. Current plans with guards run `check:coercion-helpers` there once; fast-only plans retain its standalone row. Other platform and runtime lanes fan out independently: `checks-fast-core` (including startup corpus), `checks-fast-contracts-plugins`, `checks-fast-contracts-channels`, `checks-windows`, `macos-node`, `macos-swift`, `ios-build`, `ios-screenshot-capture`, and `android`.
6. PR jobs and independent check steps keep running after failures, including forks and reruns. `check-plan` materializes its outputs before running required global guards; consumers need those outputs rather than a green guard result. Prepared SDK and candidate-package consumers likewise need the uploaded artifact, rather than every check in the producer job passing. Independent shell checks collect every exit and then fail together. Node projects, static compiler groups, lint, documentation checks, and Docker seed lanes finish their selected inventory. Setup/build/plan failures still prevent consumers of missing data, and contract envelopes stop after failure to avoid admitting another envelope before safe cleanup. Cancellation, watchdogs, and timeouts remain deliberate stops. Failing runs take longer and consume more runner time; selection, names, runner counts, and concurrency stay unchanged. `pr-failure-report` waits for the planned jobs, then uses `ci-known-main-red.mjs` to compare every failed or timed-out job with the same name/shard in the newest completed scheduled `ci.yml` run on main. A matching failed job is **pre-existing**, with matching signatures required wherever the existing Node or static evidence helpers support comparison. Other jobs identify their job-name-only match in the reason; check the failing tests against main before attributing those failures. A main pass or different failure signature is **new**. A missing, canceled, unplanned, or otherwise incomparable main job is **unknown**; unavailable supported evidence never implies a match. Detected build-verifier or lint-mode scope differences are **unknown**; the reason notes when selected scope was not compared. The compact summary links the main run and job and is copied into `openclaw/ci-gate`'s summary and log. JSON output exposes `job`, `conclusion`, `class`, `mainRunId`, `mainJobId`, and `reason` for scripts and agents. Reporting keeps the existing runner routes and fanout budget; it never cancels work.
7. `openclaw/ci-gate` waits for every selected lane and the failure report. Preflight and security must succeed; downstream jobs may skip only when unselected by the manifest and existing event, runner, and compatibility conditions. Unexpected selected skips, failures, and cancellations retain their existing gate semantics, including the known-main-red allowance below. Classification alone does not make a failed gate pass. Superseded runs keep their existing concurrency behavior.

Bot-authored, same-repository PRs containing only generated native locale data
and resources retain strict native source and generated-parity verification,
while omitting unrelated Node and native builds. Source changes, empty or unknown
diffs, and base Android XML without a hard-generated companion keep ordinary
selection. Add `ci:full` before the next PR run to retain ordinary selection for
that generated cohort. Labels alone do not trigger extra CI runs. Main and manual
validation keep their normal coverage.

The existing known-main-red allowance reads the latest completed hourly main run directly from GitHub.
Within one failure report, attribution and the allowance share that scheduled run
inventory, its attempt job pages, and downloaded logs. Each report starts a fresh
observation; PR identity, current main, ancestry, and changed-subject checks remain
separate admission reads.
A supported Node Vitest assertion, compiler diagnostic, or hosted lint diagnostic
is advisory only when its file and complete signature match main, and the PR
changes neither the file nor its direct subjects. Subject ownership conservatively
includes the file directory, directories of relative imports, and verified
workspace package directories; unresolved imports retain blocking behavior.
Workflow, tooling, configuration, and dependency changes cannot use this exception.
The main run must descend from the PR merge base, or validate current main itself.
Later main changes to those subjects retire the exception before the next hourly run.
Both matrix siblings and packed test groups finish before the report emits an
attempt-bound receipt. The shard runner records complete plan and process counts
after cleanup; the existing evidence owner reconciles every inner invocation with its native test
summaries. Compiler graphs and hosted lint stripes likewise require joined native
diagnostics and complete group and step receipts. These runners finish ordinary
diagnostic failures before reporting coverage. Mixed or narrowed lint commands
without that complete contract retain blocking behavior. The aggregate then
annotates **known main red, owned by main**.
Missing or incomplete evidence, suite/import errors, boundary checks,
and every unmatched or PR-owned failure stay blocking, including tiny lint and
type errors. The separate maintainer landing policy owns any explicit exception
for a PR-caused error with an immediate follow-up fix. The failed job remains visible in
Actions even when the aggregate accepts its main-owned assertion.

Repeated head SHAs are duplicate candidates, not reusable validation: the PR
merge tree may have changed. Per-PR concurrency coalesces pending work and cancels
superseded work; CI does not turn a previous head-only success into skipped tests
on a different merge tree.

To retranslate every Control UI or native app string, dispatch **Control UI Locale Refresh** or **Native App Locale Refresh** from `main` with `full_refresh=true`. Ordinary runs remain incremental. Both workflows read the primary and fallback models from the `OPENCLAW_I18N_MODEL` and `OPENCLAW_I18N_FALLBACK_MODEL` GitHub secrets, using the existing translation OpenAI API key. Only an explicit `model_not_found` provider error selects the fallback; authentication, quota, and network failures do not. Generated metadata and public diagnostics omit model identifiers.

The merge coordinator may reuse an authenticated successful `openclaw/ci-gate`
for the same pull-request head for up to 24 hours. This avoids rewriting a
contributor branch after unrelated `main` changes. The reusable result does not
replace the separate strict, App-owned test-merge check against current `main`.
A later pending or failed rerun does not erase an earlier successful result for
that unchanged head during the freshness window.
Reusing a CI check does not replace the current security review commit status.

The default-branch ruleset requires the GitHub Actions-owned `openclaw/ci-gate`
context. Repository maintainers and admins retain their CI bypass, including
for missing command approvals. Normal pull-request merges use the gate. The
separate code-owner ruleset requires a PR and the applicable owner approval even
when CI is bypassed; organization rules still block deletion and non-fast-forward
updates. The separate strict App-owned test-merge check still binds the head to
current `main`.

GitHub may mark superseded pull-request jobs as `cancelled` when a newer head lands. Treat that as CI noise unless the newest run for the same PR is also failing. Upstream `main` runs are not canceled after admission; each of the two parity slots replaces only its older pending run with the newest tip. All CI matrices use `fail-fast: false`, and `build-artifacts` reports embedded channel, core-support-boundary, and gateway-watch failures directly instead of queuing tiny verifier jobs. The upstream-main CI concurrency key is versioned (`CI-v8-*`) so GitHub-side zombies in the old group cannot block the two-slot pipeline; runnable PR groups remain on `CI-v7-*`, while passive draft runs use `CI-draft-v1-*`. Manual full-suite runs use `CI-manual-v1-*` and do not cancel in-progress runs. The plugin-list startup-memory guard keeps a 400 MiB ceiling on self-hosted Blacksmith Linux and allows 425 MiB on GitHub-hosted Linux, whose RSS baseline is higher for the same built CLI. The startup-memory check finishes alone before other built-artifact checks start on every runner, so concurrent verifiers do not perturb the RSS measurement.

The Testbox validation, native Periphery, OpenGrep PR Diff, Sandbox Common Smoke,
and Plugin Init Scaffold Validation workflows isolate passive draft PR events
(`opened`, `reopened`, and `synchronize`) from useful PR work at concurrency
admission. A delayed draft payload therefore cannot cancel an active ready run or
replace a pending one before the draft job or scan is skipped. Disabling
`cancel-in-progress` alone would still replace pending work. Where subscribed,
`converted_to_draft` stays in the ordinary PR group to intentionally cancel work;
non-draft head supersession and each workflow's existing manual/push grouping
remain unchanged. Periphery report publication separately checks source intent
and live PR state; see [Scope and routing](/ci/scope-and-routing).

The singleton smoke then rebuilds the runtime plugin overlay before any other verifier reads it. On Blacksmith, Gateway watch finishes its build-receipt writes and whole-tree measurement next; Doctor, SQLite lifecycle, channel, core-support-boundary, and Discord attachment checks can then overlap. Hosted 4-core runners keep their existing serial sequence and channel/core pair. TUI canaries run after all other verifiers finish. Every verifier owns a separate Vitest module cache, and each selected result remains part of the same failure aggregation. The wave step is unconditional because its startup and singleton checks always run; individual checks retain their selection gates. The artifact job consumes only its selected checkout, so base-commit fetching stays with jobs that actually compare revisions.

Use `pnpm ci:timings`, `pnpm ci:timings:recent`, or `node scripts/ci-run-timings.mjs <run-id>` to summarize wall time, start delay, slowest jobs, and failures from GitHub Actions. Use `pnpm ci:timings:trend` for a 72-hour baseline and a latest-12-hours versus prior-12-hours comparison. Trend mode includes every main push outcome, cancellation/pass rates, and successful-run wall time, then loads a balanced latest/prior sample of at most 100 successful runs by default. Its detailed sample separates workflow admission, job dependency/gate delay (`job.created_at` minus the first job's creation), runner queue/start latency (`job.started_at` minus `job.created_at`), and execution; it also reports critical-path ownership and the actual GitHub API request count. Reruns use attempt-specific jobs and are excluded from run-level wall/admission distributions because GitHub retains the original workflow creation time. Raise or lower the detailed-run selection cap with `--detail-runs` (a run with more than 100 jobs requires multiple requests), emit JSON to stdout with `--json`, or save the same report with `--output .artifacts/ci-timings/trend.json`; missing output directories are created automatically. The baseline must cover at least two comparison windows.

Run the timing helper locally; there is no in-workflow timing-summary job (a permanently disabled one was removed once the local helper became the tool everyone actually used). For build timing, check the `build-artifacts` job's `Build dist` step: `pnpm build:ci-artifacts` prints `[build-all] phase timings:` and includes `ui:build`; the job also uploads the `startup-memory` artifact.

The `Run Node test shard` step prints Bash `time -p` totals: elapsed (`real`), user CPU (`user`), and system CPU (`sys`) seconds, including waited-for child processes. Compare CPU totals with elapsed time across equivalent runs to distinguish extra CPU work from slower execution with similar CPU work. These totals alone do not establish runner contention.

Android test rows retain their existing Gradle JUnit XML for 14 days in
`android-test-reports-<task>-<checkout-revision>-<run-attempt>` artifacts, including
failed runs unless canceled. Reports identify test cases and durations; compilation,
lint, setup, and queue time remain separate in the job log. Read the XML alongside
that attempt's Gradle task outcomes: reports restored by `FROM-CACHE` or reused by
`UP-TO-DATE` describe an earlier execution, so their times are historical. They do
not show fresh test execution or a speedup in the current run. A failure before
Gradle writes XML can leave no artifact; the upload warns without replacing the
original failure. The artifact contains only phone and Wear unit-test XML, not
dependency caches or application build outputs.

Node test shards that need a built CLI run `pnpm build qaRuntime` before starting
Vitest. This profile builds runtime JavaScript, plugin assets, and freshness and
provenance metadata. Private QA shards select their private runtime entries. The
`build-artifacts` job owns Control UI and SDK declaration validation; release
package builds still generate the full declarations.

Successful scheduled-main artifact builds publish their existing build-all cache
after compilation, including the SDK-only declaration record. Publication requires
trusted current-main source and cache-write authority; PRs, manual runs, frozen or
compatibility targets, release gates, and exact-dist-cache hits do not publish.
The full warmer retains its release declaration profile. Both profiles share the
archive while their existing compiler-input and output checks decide reuse; no
extra compiler pass runs to populate it. Archive upload cost and consumer hit
rates still need CI measurement.

Source-only Linux Node 24 shards can restore compiled Vitest workers from the
protected cache warmer. The warmer prepares one generation before SDK or runtime
builds change package resolution, joins the preparation owner, and publishes only
the retained cache. PR jobs restore it without publishing. Consumers enable
reuse only when an archive exists; cold runners keep ordinary fresh compilation.
The worker owner verifies source and dependency bytes, compiler identity,
resolution topology, environment, output inventory, and the exact checkout and
output-slot paths before lending a generation. Changed or incompatible inputs
rebuild locally. Frozen targets, other Node versions, and runtime-building shards
retain fresh preparation.

The artifact job keeps its built outputs for its own smoke and boundary checks.
It no longer packs or uploads the unused `dist-runtime-build` and
`bundled-plugin-assets` archives. Runtime shards still start after preflight;
they do not wait for SDK declarations, the Control UI build, or artifact checks.
Diagnostic and proof uploads remain available.

Hosted Linux SDK declarations are published by the existing full main lint stripe 1,
after lint succeeds. Hybrid uses its plugin-lint row; the GitHub profile uses its
core row that also checks plugin stripe 1. Both use the workflow's pinned Node
runtime and preserve the restore archive's path contract for the prepared SDK
and its validated receipt. The warmer keeps
its other caches and non-hosted SDK ownership, avoiding a second hosted SDK emit.
PRs remain restore-only, and semantic source/toolchain/output checks still run.

Completed upstream-main extension boundary jobs publish their existing compiler
receipts into a cache separated by OS, architecture, and runner environment. PRs
restore that archive, falling back to the SDK warmer's declaration-only archive.
Every restored receipt still validates its compiler, configuration, source,
resolution lookups, and output hashes; the negative boundary canary always runs.
Receipts include missing candidates, directory listings, and symlink resolutions,
so an unrelated new test can retain a hit while a newly effective type dependency
invalidates it. Each validation snapshot shares actual check results across
receipts, while comparing every recorded fact. Fresh compiles still seal the
whole resolution namespace against changes during compilation. Old or malformed
receipts recompile. This adds no producer job or package-selection exemption.

Declaration caches hash the selected writer's transitive generator imports,
package and plugin metadata, explicit schema and build metadata inputs, and
the compiler's recorded source files. Editing an unrelated CI script does not
rebuild declarations. Resolution topology still participates in the cache key,
and an unresolved generator import stops the build instead of trusting a cache.
Full builds finish isolated plugin runtime and source-asset generation before
capturing declaration inputs. Runtime cleanup preserves final declarations
while discarding their staging-only `dist-runtime` copies, which postbuild
recreates. Retained cache inputs therefore do not depend on leftover plugin
artifacts from an earlier build; package output changes still invalidate them.

Local `pnpm build:ci-artifacts` uses the same memory admission as full and package
builds. The orchestrator passes the resolved heap budget to every child process,
including the SDK declaration writer, so local builds do not depend on CI's
`NODE_OPTIONS` setting. The existing policy accounts for host and cgroup limits
and reserves native-memory headroom. If the default budget cannot fit the build,
it stops before build steps or cache restoration; `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB`
remains the explicit operator override for attempting a different budget.

## Control UI size budgets

`pnpm ui:build` produces and verifies the bundle, then reports its compressed
sizes. Budget violations do not prevent artifact generation. The separate
`control-ui-performance` job enforces the budgets without blocking other jobs
from building or testing the same source.

Every production UI build checks generated protocol validators before building
or reusing cached output. After changing a schema used by the Control UI, run
`pnpm ui:validators:gen` and commit the generated
JavaScript and declarations. The generator compiles the canonical Gateway schemas
without shipping their compiler or schema builders to the browser;
`pnpm ui:validators:check` verifies that the output is current.

Startup CSS has a 45 KiB advisory target and a 50 KiB hard ceiling. Growth below
1 KiB passes; an increase of 1 KiB or more in either startup CSS or the largest
CSS file fails the comparison. The existing largest-file, JavaScript, request-count,
and isolated-renderer ceilings still apply independently. Reports include exact
bytes, base deltas, and remaining headroom, with an early warning when the largest
CSS file has less than 1 KiB of headroom.

JavaScript accounting separates ordinary chunks, deferred special-purpose
chunks, startup assets, and the full bundle total. The 215 KiB ordinary-chunk
ceiling excludes the isolated Mermaid renderer and configured locale catalogs.
A locale catalog must match `assets/<locale>-<nonempty-suffix>.js`; each
configured locale may produce one deferred chunk, with at most 20 locale chunks
overall and a 300 KiB ceiling per chunk. Locale chunks remain forbidden in the
startup asset set. Total JavaScript accounting includes ordinary, deferred, and
startup assets for reporting while enforcement stays on the category-specific
limits.

CI builds the selected checkout and the exact preflight base with the same
installed Node, Vite, and dependencies. The temporary base's CSS sidecars are
normalized through the candidate's pinned compressor before comparison. The
report identifies both revisions and the toolchain. There is no manually updated
CSS baseline, and the cumulative ceilings still bound a series of small changes.
If a base already exceeds a size ceiling, the head may hold or reduce that
surface, but growth beyond 64 bytes of gzip build variance fails the check.
Request counts have no variance allowance. Locale comparisons track each locale
separately, so shrinking one catalog cannot hide growth in another. Absolute
checks and newly introduced violations fail locally and in GitHub Actions.

Run the same comparison locally after installing dependencies:

```bash
pnpm ui:check-performance:base <base-commit-sha>
```

To enforce absolute budgets on an existing build, run `pnpm ui:check-performance`.
Use `--base-dist <directory>` to compare with an already-built base, or
`--report-only` to report violations without failing. Missing or malformed build
artifacts remain errors in report-only mode.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
