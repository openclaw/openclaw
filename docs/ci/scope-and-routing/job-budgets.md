---
summary: "UI shards, concurrency and job budgets, lint memory policy, Android rows, and sticky-disk keys"
read_when:
  - You are changing job counts, concurrency caps, or matrix budgets
  - You are working on Android CI rows or sticky-disk keys
title: "Job budgets and platform lanes"
sidebarTitle: "Job budgets"
---

Shard counts, concurrency and matrix budgets, lint memory policy, Android rows, and cache-key bounds. Part of the [CI scope and routing](/ci/scope-and-routing) index.

The standalone UI suite runs three native Vitest shards through the same group
executor and cache leaf as its bounded four-file seed in the trusted warmer.
Each row retains the root Node worker limit of three; Chromium uses its project
default. The shards preserve the complete four-project inventory and each
project's isolation and cleanup policy. Every frozen target keeps its original
singleton, unsharded test command. The window.open lint runs once in row one.
The extra two jobs add two Blacksmith registrations per selected non-frozen run
on Blacksmith routes, and none on hosted routes. They do not guarantee an
eight-minute workflow: preflight, setup, queue time and other jobs still apply.
Its native reporter records runtime CPU and memory facts, configured project
workers, module diagnostics, and observed queue/end events. Browser pool logs
record actual Chromium sessions. Project counts at run start describe discovery
before sharding; completed module identities and final counts prove coverage.
Event intervals are not scheduler-admission times; repeated environment/prepare
durations must not be summed into wall time.
These receipts do not establish transform-cache hits.
Tooling stripes install Go only when their selected files include the docs
translation test; historical whole-config plans retain their existing setup.

Shell-heavy macOS signing and elevation cases admit up to three cases per file,
capped at Node's available parallelism. Independent checkout fixture tables
retain their two-case limit. Each case owns its commands and temporary roots;
cleanup joins its process tree and callback work before removing those inputs.
Outer suites and the remaining checkout contract cases stay sequential.

Once admitted, canonical Linux CI permits up to 96 concurrent Node test jobs.
The manifest separately enforces total-job budgets: 64 Node rows for canonical
pushes and 120 for canonical PRs, including precise and plugin plans. GitHub
also caps one job's combined outputs at 1 MiB measured in UTF-16, so preflight
has 524,288 characters for every matrix together. Grouped Node rows list each
striped test file explicitly. The manifest projects the five fields consumed by
the shard runner, then uses gzip+base64 (`groups_gzip_base64`) when the target
contains the codec. Historical targets without that capability receive the same
projection through legacy `groups` JSON. Workflow tests keep the complete
generated output under half of the cap. The smaller
fast/check lanes remain capped at 12; Windows is capped at two
and Android at two because those runner pools are narrower. Compact whole-config batches run
with a 120-minute batch timeout, while include-pattern groups share the same
bounded job budget.

Type-aware lint on CI runners with fewer than 8 CPUs or 24 GiB of RAM uses the
existing Go compiler memory policy (`GOGC=30`, `GOMEMLIMIT=3GiB`) to reduce swap
pressure. Explicit Go settings remain authoritative. The limit is soft and
applies only to the lint child; declaration preparation retains its own policy.

Regular Android PR/main CI and PR `release_gate` dispatches use four rows: Play and Wear-shared unit tests/lint, third-party unit tests/lint, Wear unit tests/lint, and Kotlin lint for all four modules. Each phone flavor has its own source set and `SensitiveFeatureConfig`; `apps/android/app/src/thirdParty/AndroidManifest.xml` declares additional permissions and components. The Kotlin-lint row also compiles the benchmark when benchmark or Android build/dependency inputs change; missing or unusable changed-path data keeps that build.

Ordinary full-scope manual validation retains six Android rows: the three test rows, `build-play`, `build-wear`, and Kotlin lint. The build rows own lint without repeating it in test rows. `build-play` assembles both phone flavors and the Wear shared module and compiles the benchmark; `build-wear` assembles Wear. `build-play-compat` retains Play-only packaging for older frozen targets. GitHub-hosted `build-play` gets a 35-minute job budget for its three memory-bounded Gradle invocations. Combined `test-third-party` unit tests and lint also get 35 minutes on either runner route: measured successful Gradle invocations consume 18–19 minutes before checkout, toolchain setup, and cleanup. Third-party tests without lint, Blacksmith `build-play`, and all other Android tasks retain 20 minutes. The budget follows the current attempt's runner route even when a retry reuses the original preflight matrix. Each current Gradle task has one protected sticky disk; PR jobs use disposable clones, while protected runs refresh content-addressed Gradle entries in place. Existing Android opt-in and npm qualification deferral are unchanged.

Robolectric resolves Android SDK artifacts outside Gradle's dependency cache, so every Android `test-*` task receives a workflow-owned Gradle init script that points test JVMs at a dedicated Maven-local repository. Actions cache restores are task-, platform-, and Android-contract-scoped; a prefix restore can seed a changed contract, but only a successful trusted run may publish the completed exact cache after a miss. Cold runs may download missing SDK artifacts, while warm runs reuse the exact archive. Build and lint tasks do not receive the Robolectric init script.

Remaining Blacksmith sticky-disk keys are deliberately bounded by supported task dimensions, never PR number, commit, run, branch, or dependency hash. Dependency, runtime transform, and compile caches use Actions cache instead because immutable archives expose verifiable restore/save results and avoid mutable snapshot-promotion failures. After a sticky key-version migration, add only the exact obsolete key, architecture, and region identities to `.github/retired-sticky-disks.json`, dispatch `Sticky Disk Cleanup` from `main` with the same dimensions and confirmation, verify deletion, then remove those entries. The workflow routes ARM identities to an ARM runner, rejects runner-region mismatches, uses Blacksmith's exact-key deletion action, and never deletes Docker builder caches or wildcard prefixes. Actions cache archives use normal LRU and inactivity eviction.

The `check-dependencies` shard runs Knip dependency, unused-file, and unused-export checks. Both guards enforce zero findings across production and full-tree scans, with no unused-file allowlist. The export guard also audits script entry exports. Production excludes test-support consumers; the full-tree and script scans include tests as consumers. Model intentional dynamic consumers in `config/knip.config.ts`, `config/knip.all-exports.config.ts`, or `config/knip.scripts-exports.config.ts` as appropriate. Each guard reports every scan outcome and fails if any scan fails. Historical targets run the export guard when they provide it and retain their older dead-code fallback otherwise.
