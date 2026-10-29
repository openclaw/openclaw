---
summary: "CI job graph, scope gates, release umbrellas, and local command equivalents"
title: "CI pipeline"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging a failing GitHub Actions check
  - You are coordinating a release validation run or rerun
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
---

CI continues during Full Release Validation; the legacy release-priority variable
does not pause workflow admission. See [deferred CI recovery](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#deferred-ci-recovery)
for runs already deferred by older workflow revisions.

Gateway server tests use the same 16-file process bound in local full-suite runs
and CI config/include selections. This retires the shared worker before retained
module graphs exhaust a 16 GB runner on Bun. The CI shard keeps its original file
membership, runtime selection, and outer timing key; the project runner executes
its chunks sequentially. Native `--shard` and suite-wide state or output options
retain their single-invocation semantics.

The existing `live-cache` release job has a 30-minute budget for three sequential
eight-minute checks on one runner: stored cache floors, transport prefixes, and
agent-turn prefixes. See [prompt-cache regression coverage](/help/testing/suites#prompt-cache-regression-coverage).

Native video smoke coverage uses four shards of four providers. Each provider has a ten-minute operation timeout plus 30 seconds of test overhead; each shard has a 50-minute job budget, leaving eight minutes for setup. These shards keep full-mode video testing disabled.

The `Linux App` Linux companion and Windows installer jobs allow 105 minutes for
source staging, packaging, and native proof. Their canonical core builds use the existing
`OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS` override with a 60-minute allowance:
cold declarations exceeded the default 45-minute package deadline. A Linux run
completed its package declarations in 38 minutes before the deadline interrupted
the following declaration phase; a complete Windows installer job previously took
78 minutes. The remaining job budget covers dependency installation, Rust
compilation, desktop tests, and installer packaging. The override stays on each
source-build step; release-workflow budgets and package-integrity checks are unchanged.

Broad PRs retain their compact selected-owner Node plan when time-based splitting
would exceed the 130-row matrix cap. See [Node test lanes](/ci/scope-and-routing/node-test-lanes).

Agent auth-store admission and configured model-owner changes explicitly select
the Gateway agent-config readiness suite. Its lazy startup path is not fully
visible to the bounded import graph; the owner watch preserves overlap coverage.

PR Node plans also select the QA scenario catalog's reference check when a
changed path is absent from the checkout, including the removed side of a rename.
This catches stale YAML code references without selecting the full QA smoke lane.
Removed UI test paths also select the UI runtime inventory check so its literal
Node-driven browser list cannot silently retain deleted tests. Both checks use
the existing bounded Node planner and leave native and real-Gateway tiers unchanged.

Added tests outside the ordinary suite roots select the full-suite ownership
inventory, including rename destinations. The policy watch uses the PR base
to distinguish additions from existing-file edits, which add no inventory work.
See [selection and routing](/ci/scope-and-routing/selection) for the scope.

Gateway close and run-shutdown owner changes likewise select the Gateway
detached-execution shutdown and late-admission suites. `server.close()` reaches
those owners through the kernel's lazy shutdown runtime, beyond the bounded
import graph.

This page is an index. CI is documented on nine pages, one per reader
job. Open the page that matches your task.

Storage-engine PRs, scheduled main runs, and manual CI validations include three hosted PostgreSQL 17
[conformance shards](/help/testing/suites#postgresql-conformance), required by the CI gate when selected.
They run in parallel with separate databases and unchanged three-worker test limits,
with a 30-minute job budget each. The conformance runner models sequential configuration processes, three parallel file
workers within each process, and the shared runtime preparation paid by each job.
Committed `config/postgres-conformance-timings.json` measurements price file work,
configuration startup, and preparation; they never select the test inventory.
Cold file scheduling follows Vitest's file-size order. The allocator minimizes
predicted tail time, then total work, so preparation consumers can share one job.
Unknown targets retain a default weight. Inspect any assignment with
`--shard 1/3 --list` (or `2/3`, `3/3`). Refresh measurements from successful natural
runs as the suite changes. The latest two file samples track recent workload
changes; configuration and preparation costs use observed medians. These are
estimates, including inferred import/hook costs from verbose logs, not exact
per-file profiler measurements. Refresh weights when adding expensive files:
the unknown-target default preserves coverage but can underestimate their cost
enough to unbalance a shard. Rebalancing adds no jobs or per-job setup.
The combined inventory matches the local full suite; a failure in one shard leaves
the others running and fails the aggregate gate.

The PostgreSQL Scheduled Qualification workflow (`postgres-conformance-weekly.yml`) runs
the same three conformance shards on main with digest-pinned images: PostgreSQL 17 daily
at 07:17 UTC, and PostgreSQL 16 and 18 every Monday at 06:43 UTC. Manual dispatch accepts
`versions=all` (the default), `pg16`, `pg17`, or `pg18`. PostgreSQL 17 uses the same image
pin as PR CI. The daily run adds three hosted jobs at roughly 25 minutes each
(75 runner-minutes per day); Monday's weekly run retains six jobs. All runs use the same
measured shard allocator with a 50-minute job budget and at most three jobs running at once.
PR CI keeps its existing path selection and three PostgreSQL 17 shards.
All versions start with `max_locks_per_transaction=512` for the conformance workload.
Scheduled failures are visible in Actions through the workflow's failed jobs, with no additional notifications;
the PR failure classifier continues to compare against hourly main CI's matching PostgreSQL 17 jobs.

Full hybrid extension lint packs the same standard chunks into three existing rows, sharing setup and SDK preparation within each row. Targeted plans and frozen routes retain their existing layout; see [runner profiles](/ci/runners#runner-backend-modes).

Full hybrid PR checks share central formatting and scripts lint with core lint stripe 1 when those are the complete central command inventory. The existing 16-class runner executes them sequentially within its 15-minute deadline, removing one checkout and dependency setup. Additional central checks, targeted core stripes, and plans without another required check row retain their separate lint job. Central lint still runs after a core lint failure and fails the shared job if it fails.

Default fork first attempts run their existing core lint stripes on Blacksmith16, retaining the same core and extension chunk assignments and restore-only caches. Retries and the GitHub override remain hosted; see [runner placement](/ci/runners#runners).

[Automation admission](/ci/scheduled-workflows#comment-automation) filters known
no-op events before runner allocation and concurrency, keeping automation on
GitHub-hosted runners.

PR jobs and independent checks run to completion after a failure, including forks and retries. Setup, planning, build dependencies, cancellation, and watchdog deadlines still stop work that cannot safely proceed. Failing runs therefore take longer and use more runner time; successful runs keep the same selected checks, job names, and concurrency. `pr-failure-report` compares
every failed or timed-out job with the newest completed scheduled main CI run
and publishes a **pre-existing**, **new**, or **unknown** classification in its
summary and `openclaw/ci-gate`, with machine-readable JSON output. When GitHub reports
only successful or skipped prerequisites, the reporter records that no failures
need classification without enumerating job pages. The CI gate still checks
selected lanes and rejects unexpected skips. Reasons identify
matched signatures or job-name-only matches. The existing known-main-red
allowance and gate result stay unchanged. Detected build-verifier or lint-mode
scope differences are **unknown**; other reasons say when selected scope was
not compared. See
[job ordering and failure reporting](/ci/pipeline#fail-fast-order).

Add `ci:full` before a PR run to select every `checks-ui` unit shard, all
`checks-ui-e2e` shards (Control UI and browser extension), and every
`checks-ui-e2e-real-gateway` shard, including desktop resize proof. These use the
same UI inventories and shard budgets as scheduled `main` CI. Unlabeled PRs keep
change-selected UI coverage; the label does not expand unrelated platform lanes.

Current UI unit/browser CI retains three native shards with three workers each,
complete discovery, runtime ownership, and first-shard WebKit selection.
Two-shard trials did not reduce measured runner minutes and exceeded the
critical-path budget.

Compact mocked Control UI E2E uses six 16-class jobs with four workers each,
matching the four observed CPUs per runner and retaining 24 aggregate worker slots.
Private source-server projects stay serial. The conditional browser-extension
row, noncompact plans, and real-Gateway worker limits retain their existing rules.
Browser suites that only exercise the rendered UI borrow the invocation's
production bundle. Private source servers are reserved for source-module
interception, custom build identities, or development-server contracts.

The mocked Control UI sharder keeps four measured source fixtures that need
compiled subprocesses together in one existing shard. Their combined timing
weight participates in normal packing, so preparation is shared without adding
jobs or changing test selection, isolation, or worker limits. The group is an
explicit scheduling hint; a new subprocess borrower can add preparation to
another shard until the measured group is refreshed.

UI fixtures import pure protocol constants and data builders directly, so mocked
browser cases do not load backend stores or Gateway policy. The shared E2E
cleanup hook reads the canonical admission state through its thin state module;
policy and logging remain owned by the Gateway admission module.

When artifact reuse is enabled, service-worker-update, phone stale-build, and
real protocol-mismatch recovery fixtures run in `build-artifacts`. Each copies
the verified production UI artifact and refreshes its own build identity before
serving it. Protocol recovery also uses the producer’s built Gateway and retains
its incompatible-protocol UI build. Local, compatibility, and frozen targets
retain their ordinary preparation path.

When the selected mocked Control UI shard includes production stale-build recovery,
its workflow step prepares the Gateway runtime before starting Vitest. This moves
the existing cold build outside the fixture's subprocess budget without adding a
job or building on shards that do not select that fixture. Production-artifact
reuse still omits the delegated fixture from the mocked shards.

The exact Doctor plugin-index and SQLite sessions/transcripts built-CLI proofs
use the runtime-only compiled-worker registry. The local TUI file does the same
when its existing built-CLI mode is enabled; source TUI and broad, mixed, or
custom selections retain the full registry.

When the artifact producer selects both channels and core support checks with
matching compiler heap options, they share one full compiled-worker generation.
Both test commands still run concurrently with their original configurations,
worker limits, and separate transform caches. The generation remains owned until
both commands finish; either failure fails the producer without canceling its
sibling. Single selections, differing compiler heap options, and older targets
without the shared runner retain their independent commands. Changes to the shared
runner select both checks in the artifact producer on current targets, while the
changed Node plan defers its boundary coverage to that producer. This opt-in does
not enable unrelated proof-tier checks.

Full and runtime-only compiled workers reserve separate live/cache slots, so
runtime checks cannot replace a retained full generation. The protected warmer
keeps its prebuild full seed for source-only Node shards and publishes the full
generation already prepared by postbuild collection separately. Only selected
source verifiers in the artifact producer restore that postbuild seed, keyed by
the existing Node toolchain identity. A missing archive keeps their uncached path;
an input, topology, runtime, or exact-output-path mismatch still compiles fresh.
The producer creates no shared cache archive.

Real-Gateway UI shards have a 30-minute whole-job budget on the normal Blacksmith
path. Successful 16-class jobs reached 19:04, leaving too little margin under the
former 20-minute limit. Hosted and retry paths retain their 40-minute budget;
runner size, worker count, shard split, and individual test deadlines are unchanged.
Current targets overlap desktop transport proof with the one-worker serial UI
phase. The planner balances serial files across the two existing runners; each
runner keeps those files serial and joins cleanup before qualified fixtures use
its existing two-worker ceiling. The serial and qualified phases share one prepared
worker generation when both run; the desktop carrier keeps its separate lifecycle,
and the shared generation is disposed only after both borrowers join. One-worker
overrides, desktop-only selections, and frozen targets retain sequential execution.

First-hop compatibility uses a 3,200-second container budget and a 3,500-second lane
budget, based on hosted 4-vCPU measurements with a slow-host margin. The release
self-upgrade job gives first-hop lanes weight two at npm limit five, admitting at
most two concurrently. It allows 210 minutes for three waves of six source versions,
the survivor, and setup.
Authenticated update restart uses a 3,420-second container budget, a 62-minute lane
budget, and a lane-specific 1,500-second command timeout. Its dedicated recovery
chunk allows 75 minutes; the remaining OpenAI package chunk allows 60 minutes. See
[release-path chunks](/ci/release-validation/install-smoke-and-docker-e2e#release-path-chunks).

For the published-upgrade regression gate, see [selection and routing](/ci/scope-and-routing#scope-and-routing), [runner budgets](/ci/capacity#runner-registration-budget), and [Package Acceptance baselines](/ci/release-validation#suite-profiles). Weekly validation is listed under [Update Migration](/ci/scheduled-workflows#update-migration).

Updater, state-lease, SQLite identity, native-plugin, startup-trace, and updater-tooling PRs also require the [published-driver update cell](/ci/scope-and-routing/selection#published-driver-update-cell). One GitHub-hosted Linux job runs the latest stable npm updater against the candidate package with two synthetic agents. Its twenty-minute budget and result are included in `openclaw/ci-gate`; the broader main/release Docker survivor remains separate.

Full `main` CI and cache warming are [hourly by default](/ci/scheduled-workflows#hourly-main-ci); `OPENCLAW_CI_ON_PUSH=true` restores their existing per-push admission. CodeQL, Workflow Sanity, and CI's `security-fast` keep their existing main-push scopes. Docs-only `main` pushes still skip the CI workflow and push-triggered cache warming. The cache warmer publishes dependencies independently of long builds and maintains a bounded hosted seed in hybrid mode. Every admitted upstream `main` run exercises one published-driver × candidate Docker upgrade; ordinary manual/release validation adds the other five Docker seed lanes. QA Smoke, real-Gateway browser checks, and named process proofs retain their selected `main` coverage and manual/release validation. Pull requests and exact-head PR fallback dispatches run static correctness gates, owner-bounded tests, transitive import consumers, protected regressions, and a six-file runtime smoke set. Node rows target at most 150 estimated test seconds. Single files and indivisible standard groups can exceed that target; setup, builds, and queues are separate from test time. Node shards selecting sandbox container E2E cases prepare the Docker sandbox image when the runner does not already have it. Missing or unbounded runtime selection fails preflight instead of falling back to every test. Windows, browser, Docker, QA Smoke, packaging, contract, and extension families opt in through their existing owners; individual built-process proofs have independent owner flags. Full static fallback does not widen them. The [PR-exempt integration tier](/ci/scope-and-routing/node-test-lanes) retains measured slow tests in hourly `main` and Full Release Validation, with PR opt-in when their tests or subjects change. The existing Plugin Prerelease workflow owns complete extension runtime coverage hourly and in Full Release Validation; normal CI selects affected extension owners on PRs. Windows retains its complete inventory across five measured file shards on hourly main and ordinary manual/release validation; Windows-owner PRs retain that complete inventory.

Hourly iOS retains `ios-build (tests)` with Rust, voice, native Access, and focused lifecycle coverage. Successful current iOS builds run SwiftLint and SwiftFormat once through their required Xcode prebuild phases; a standalone fallback retains both checks after failed or skipped builds and for historical or frozen targets. Debug builds select their simulator before compiling, overlap its boot and SimSlim preparation with compilation, and join preparation before either focused simulator test group. Preparation failures or a timed-out join fail the job with its log; test selection and build settings stay unchanged. Current smoke builds prepare testing products once with `build-for-testing`; the voice cleanup and lifecycle groups separately reuse those products with `test-without-building`. Historical targets and other phases retain their existing build actions. Managed attachment UI/export, Watch operation, and Watch delivery UI suites retain every assertion in full manual/release validation. Main-tier simulator builds use the native architecture without indexing or verbose test diagnostics; logs and xcresult bundles remain available. A coalesced scheduled iOS cancellation can leave `openclaw/ci-gate` green with a notice delegating iOS proof to a later scheduled job; it does not validate the canceled revision, and the workflow can still be canceled. Genuine failures remain red. Screenshot capture runs for its own changed inputs and full manual/release validation. See [scope selection](/ci/scope-and-routing/selection) and [capacity](/ci/capacity#owner-path-and-release-coverage) for the coverage trade-off.

Current iOS builds restore three independent input caches: verified Mermaid assets, SwiftPM source packages and binary artifacts, and the Watch RTC Cargo registry and compiled simulator library. Only trusted `main` push and scheduled runs save them; PRs restore only. Frozen targets retain their original cold path. Mermaid validates source and output hashes before copying resources. Its key covers the renderer's complete locked dependency graph, including workspace sources and optional build dependencies, so unrelated root dependency upgrades reuse the assets. SwiftPM keys cover Xcode, package manifests, and available `Package.resolved` files; automatic resolution remains enabled (the generated iOS project currently has no tracked lockfile). Watch keys cover Xcode, architecture, target mappings, the pinned Rust toolchain, lockfile, crate sources, and iOS build settings; the build phase verifies the library checksum and input fingerprint before reuse, and otherwise runs the locked Cargo build. Caching the finished slice avoids rebuilding the Rust standard library when a fresh runner installs `rust-src` with new timestamps. The hourly Watch engine test shares registry downloads, while its host Debug products stay out of the simulator Release cache.

Current iOS Debug builds log CPU count, memory, machine model, booted simulators, and timestamps immediately around Xcode execution. The read-only hardware and simulator checks each have a five-second limit; unavailable diagnostics do not block the build. These markers distinguish simulator-query delays from Xcode startup, package resolution, and compilation.

Shared OpenClawKit Periphery scans restore the same verified Watch RTC libraries published by trusted main CI, without saving caches. Both Apple consumers build their complete index in a separate timed step with streamed output retained as `build.log` in the consumer artifact. iOS uses a fresh run-owned index; Periphery analyzes that exact index without rebuilding. Scan scope and the shared dead-code intersection stay unchanged. Cache misses retain the locked Cargo build.

iOS screenshot capture, release qualification, Store Release, and its screenshot-only operation use [larger hosted capacity](/ci/runners). Screenshot capture uses stock simulators and creates and cleans up one at a time; the screenshot-only operation can validate a selected branch without signing or uploading a release. The pairing, chat, and native Overview tests retain their existing assertions and deadlines.

iOS Store Release and daily TestFlight check out the exact selected commit at depth one, then fetch its complete ancestry without unrelated branches, tags, or historical file contents. Release-note reads fetch their recorded baseline refs and hydrate historical contents as needed. Source identity and main-ancestry checks remain unchanged.

Both release destinations share a separate Watch RTC device-library cache, populated only by successful trusted `main` release runs. It retains both `arm64` and `arm64_32` device slices without sharing the simulator cache. The existing build phase verifies each slice's input fingerprint and checksum before reuse; a miss runs the locked Cargo build. Cache transfer failures do not block a release.

Release qualification disables Spotlight indexing on the disposable runner's Data volume before checkout. After Simulator boot, it requires ten seconds of at least 30% idle host CPU within five minutes before issuing the pairing credential. This keeps first-launch background work out of the Gateway and XCTest deadlines. Local qualification uses the same CPU readiness check and leaves host indexing settings to the operator.

Android screenshot-input PRs and ordinary full manual CI run the existing phone
and Wear store capture script in one hosted Ubuntu job. The final CI gate requires
capture to succeed; unit-test-only and documentation changes omit it. See
[the job graph](/ci/pipeline#pipeline-overview) for capture evidence and scope details.

Android Store Release and Internal distribution use the Blacksmith 32-class for
their shared build/upload job. A controlled cold-build comparison measured eight
usable CPUs on this class and reduced median signing preflight plus phone/Wear
bundle time from 621 to 217 seconds. This trades paid compute for shorter release
runs; qualification and ordinary screenshot CI retain hosted Ubuntu. See
[runner evidence and cost](/ci/runners#android-release-runner).

Android Release E2E adds one hosted Ubuntu KVM job to exact-source, full-scope
manual validation when Android is selected, matching the iOS qualification
selection. The final CI gate requires its success. Manual Android Store Release
also requires qualification before the signing/upload job; internal distributions
and Gateway APK publication retain their existing paths. It validates phone
onboarding/chat/relaunch against a pinned stable Gateway, native transcript and
keyboard behavior, and Wear native input, chat, history, restarts, and reply-reader
behavior through a local raw-message transport at the Google Data Layer boundary.
The production wire codec, phone bridge/controller, Gateway, and response/event
path still execute. Real Google capability discovery, listener-service delivery,
and Play services package/signature enforcement remain separate physical-device
smoke coverage. Built debug APK hash, signature, package, version, and listener
declaration checks remain in the gate; Release/R8, store signing, and upload
remain owned by the existing release lane. See the
[Android release validation contract](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md#release-validation)
for evidence, rerun, and coverage details. Standard SDK images and build
dependencies are downloaded during setup; no Google account, companion APK, or
paired-device image is provisioned.

Eligible core-source and core-test PRs use targeted type checks when every selected compiler input exists in the checkout. Deleted Markdown files and UI stylesheets do not prevent narrowing for accompanying code changes. GitHub and hybrid profiles distribute the selected consumers across their existing core stripes; the Blacksmith profile checks them in the central row. Ambiguous ownership and deleted compiler inputs keep the full type-check coverage.

Scoped PR plans inspect the four root-test partitions separately and select every
partition that consumes a changed input, including type-only imports. A change
used only by tooling tests checks that partition; shared setup can select all
four. Full checks retain the aggregate root alias. Missing or duplicate compiler
inventories retain full coverage. Selected partitions keep their original stripe
identities when four admitted core rows are available; smaller plans run only the
selected partitions serially in the central row.

Preflight passes the complete changed-path manifest between steps as a local JSON
file, so large PRs do not lose test-planning inputs to Actions output or environment
size limits. Frozen targets that predate this transport retain their bounded JSON
output contract. Missing or invalid inputs still reject current PR Node planning.

The [Testbox check workflow](/ci/local-proof#testbox-validation) requests the Blacksmith 16-class for routine dispatched proof, with a 60-minute total-job deadline including hydration. The explicit high-memory 32-class workflow retains 240 minutes for memory-heavy full-suite gates. The outer GitHub deadline can terminate active SSH commands; the separate 15-minute idle limit does not extend it. PR hydration checks stay on hosted Ubuntu; individual test deadlines remain unchanged.

All five lease workflows allow up to 60 minutes from dispatch to admission and
runner startup, then reject expired requests before checkout and hydration. This
queue allowance does not extend running-job or idle deadlines; see
[Testbox spending limits](/ci/runners#testbox-spending-limits).

Full GitHub and hybrid type checks run the five core stripes independently, retaining two compiler children per job. The last four rows then each run one root-test partition serially, leaving extension tests and scripts in the central row. Narrow plans reuse four already-selected rows when available; smaller selections retain central root checking. This adds no jobs or compiler overlap. Current hybrid full runs use three hosted extension-lint jobs; targeted layouts retain six stripe identities. Trusted hybrid first attempts retain both packed core-lint rows on the Blacksmith 16-class. Ordinary upstream hybrid push and scheduled runs, plus same-repository PRs, place `preflight`, the selected `pr-failure-report`, and `openclaw/ci-gate` on hosted `ubuntu-24.04`; fork first attempts and all dispatch, qualification, release, and other backend routes retain their existing overrides. The mandatory controls count toward the existing hosted-row budget. See [critical-path assignment evidence](/ci/routing-costs#hosted-assignment-on-the-critical-path). Frozen targets keep their earlier layout; see [static checks](/ci/runners#runner-backend-modes).

Additional checks and narrow-PR guards and dependency scans start directly after preflight. Ordinary PRs selecting Madge or Kysely divide guards into `check-guards` and `check-guards-architecture`, with the same runner routing and no compiler-plan wait. The manifest retains every check once, and both selected rows must pass. Other events retain their existing rows. Guards retain the exact comparison base and shared check commands; compiler and lint rows wait for their selected graphs. Known full compiler selections skip discovery while retaining the core graph boundary in an existing required owner; see [pipeline ordering](/ci/pipeline#fail-fast-order).

Changed compiler planning queries each config's complete file membership with `--listFilesOnly`, using tsrs by default and tsgo on unsupported hosts or when `OPENCLAW_TYPECHECKER=tsgo`. Type-only consumers and dependency declarations remain included; the selected compiler's bundled library directory is excluded because it describes compiler identity, not repository membership. Config expansion and shard/buildinfo validation still use tsgo's `--showConfig`. Queries run serially without opening native API snapshots. Upstream first-attempt `check-plan` jobs use the 16-class when the backend is unset, `blacksmith`, or `hybrid`, including fork PRs. Fork type stripes also use the 16-class with an unset or `blacksmith` backend; their logical GitHub profile and restore-only cache policy stay intact. Existing hybrid health admission, the explicit GitHub override, retries, and frozen routing remain in effect.

The extension package boundary row has a 40-minute job budget for SDK preparation,
all selected plugin compiles, input-receipt validation, the required negative
canary, and cleanup. Hosted four-CPU runs spent about 19 minutes in the compile
command alone; one completed compile and canary but exceeded the former
20-minute whole-job deadline. Release validation on hosted `ubuntu-24.04` later
spent about 6 minutes preparing and 23 minutes compiling 128 plugins, passed
both checks, and was cancelled at the former 30-minute deadline.
Optional hybrid hosted overflow retains this row on Blacksmith: compiled receipt
archives include checkout-specific paths and links, and hosted cold runs exceeded
22 minutes. Explicit hosted overrides, retry and trust fallbacks remain available.
Other jobs keep their existing admission thresholds; the hosted row total counts
only the rows actually offloaded. Compiler concurrency, coverage and cache guards
are unchanged.

The Plugin SDK API diff row also has a 30-minute job budget. Two hosted runs took
722 and 725 seconds to render the base revision, then reached the former
20-minute deadline while rendering the candidate. The budget allows both full
revision renders plus setup and cleanup. Rendering stays serial below eight CPUs
or 24 GiB of memory; larger hosts retain two render workers. Other
additional-check rows retain 20 minutes.

Core lint discovers separate source and UI TypeScript projects, retaining shared ambient declarations and imported dependencies. The source project also includes `src/**/*.test-support.cjs`; unrelated JavaScript files are not added as roots. See [local checks](/ci/local-proof#local-equivalents).

Runtime topology checks inherit the existing [Go memory defaults](/ci/local-proof#local-equivalents), with caller overrides and the full architecture check sequence retained.

Full Release Validation's Docker seed child uses the 16-class Blacksmith runner
when no release runner group is configured, prepares the existing smoke package,
and retains serial weighted lane admission. Hosted outage overrides and retries
keep their recovery route. Ordinary manual dispatches retain hosted
serial execution. All six lanes remain selected. The three long, unfitted hosted
test rows (`core-runtime-config`, `agentic-cli-process`, and
`agentic-control-plane-agent-chat`) have a 90-minute job cap until complete timing
observations allow the release planner to split them. The targeted
`update-restart-auth` lane has a 62-minute budget and a 75-minute job cap.
Release-path migration matrices isolate channel switching and each published
baseline on separate runners when multiple baselines are selected; per-host
weighted resource limits and exact-candidate artifact checks remain unchanged.
Package Acceptance admits its long standalone upgrade lanes before expanded
scenario jobs and orders pinned baseline cohorts newest first, without changing
its matrix cap or scenario coverage.

Android native resource preparation uses the Mermaid renderer's filtered dependency install, including optional build tooling. Pnpm retains root dependencies but omits unrelated plugin packages; Gradle still builds the assets and runs the selected native tests and lint. Historical targets keep their compatibility path.

Android phone tests use up to four isolated JVMs on Blacksmith and retain [Gradle-owned cache expiry](/ci/runners#runner-backend-modes). The same four normal rows split phone tests from app lint: Wear owns Wear tests and lint plus third-party app lint, and Kotlin lint owns Play/shared lint. Upstream Blacksmith push and PR first attempts, including forks, overlap all four rows; the GitHub override, retries, manual dispatches, schedules, and other repositories retain two. All test and lint tasks remain selected.

macOS Swift CI runs the app and independent package suites in separate [native phases](/ci/pipeline#macos-swift-phases), retaining every test and the existing concurrency limits. Ordinary native phases retain
a 30-minute budget; full nonpublishing app-host recovery proof has 75 minutes to build
and stage the exact runtime, exercise Retry, and verify a fresh-process relaunch.

Native test builds retain coverage and source-line backtraces while omitting IDE indexes and full debugger type metadata. Local development builds keep their normal debug settings.

The macOS app test phase installs the full workspace dependencies and builds the CLI runtime before Swift tests that use the shared exec policy owner. Other native phases keep the filtered Mermaid and protocol dependency install. Policy fixtures exercise the real local CLI rather than building it on their first request.

Short hybrid jobs use a [40-row base threshold and 45-row hosted admission limit](/ci/capacity#bounded-hybrid-hosted-offload), with unchanged coverage and Blacksmith fallback when optional work does not fit.

Additional hybrid check offloads require [fresh hosted assignment evidence](/ci/runners#hybrid-hosted-assignment-guard). Eligible PRs can move dependency, core type and topology checks; main pushes can also move lint and central types within the same hosted row limit. Artifact builds retain Blacksmith because their measured hosted tail leaves no room for the [15-minute routing objective](/ci/routing-costs).

Windows keeps its complete explicit test inventory in five [measured project-aligned shards](/ci/runners#runner-backend-modes) for main and release validation. Windows-owner PRs retain the complete family; unrelated PRs omit it.

Real-Gateway browser checks use [job budgets matched to their selected runner](/ci/runners#blacksmith-runner-capacity).
They restore the protected full-build cache and still run private-QA preparation.
The Control UI step can reuse public build content because backend-only private
plugins do not change its output. Native UI declarations, assets, source plugin
discovery, and Vite-consumed inputs remain part of its validated cache identity.
Existing UI test bodies do not invalidate an otherwise unchanged bundle; their
complete path inventory still invalidates new or removed glob matches.

Control UI, repo E2E, and native live browser CI restore the Chromium revision pinned by the selected target's installed Playwright package, with separate OS/architecture cache keys and no fallback prefixes. The protected-main Vitest cache warmer publishes the browser cache in its short dependency job for both Linux backends; PR and release jobs remain restore-only. A cache miss still installs the managed browser, and current targets use the installer's `--require-playwright-chromium` mode rather than substituting system Chrome. Historical targets retain their Playwright installer and Linux dependency setup. Browser startup diagnostics include provider, page, WebSocket, and Chromium process events to diagnose a session-readiness timeout even when it is reported only after unrelated unit work finishes.

The first `checks-ui` shard also runs a curated WebKit overlay and composer-focus project when changed paths touch its interaction owners, their styles, or the subset in `ui/vitest.config.ts`. The manifest owns that selection. WebKit runs sequentially after the existing UI tests, with the same three-worker limit and no additional runner or matrix row. Scheduled runs without changed paths and frozen targets omit it. The selected row installs the pinned Playwright WebKit browser and Linux dependencies. Run the same project explicitly with `OPENCLAW_UI_WEBKIT=1 pnpm --dir ui test --project=webkit --maxWorkers=3`; ordinary UI test runs remain Chromium-only. CDP-dependent modal media and accessibility-tree suites stay on Chromium until their browser-neutral replacements land.

The WebKit project requires every selected assertion to pass, with no expected-failure exceptions. Shared fixtures wait for usable overlay content, inspect native adopted stylesheets, and establish keyboard traversal independently of Safari's pointer-focus behavior.

Linux baseline ratchets and native grep tests reuse an existing `rg` or download the checksum-pinned ripgrep 15.2.0 release directly into the runner's temporary directory. Setup does not use apt, sudo, package-index refreshes, or package-manager locks. The small archive download has bounded retries and transfer timeouts; unsupported architectures and checksum failures fail the job.

Browser extension CI launches the installed, patched Chrome MCP dependency directly, on Node and on the pinned Bun fork.

When an ordinary PR, push, or scheduled run already selects the public artifact build, current-target Control UI locale checks share that job's checkout and dependency setup. Source verification and locale parity run before generators, with their result settled after the existing build diagnostics. Source failures remain blocking; generated-locale drift retains its strict or advisory policy. Standalone selections, dispatches, frozen targets, and compatibility targets keep the separate locale job.

When the public artifact build is already selected, current-target browser extension E2E and the selected production deployment fixtures run directly in `build-artifacts`, before mutable built-artifact verifiers. They reuse that exact checkout's public build without an extra checkout, runtime archive, or runner. Native-policy and published-driver consumers wait for this browser proof with the rest of the producer job. Standalone browser selections and frozen targets retain their local runtime build. Real-Gateway fixtures retain their separate private-QA preparation. The native-host, Doctor and SQLite built-CLI verifiers opt into the existing validated worker cache to reuse their identical runtime-only compiled worker graph sequentially within the producer job; TUI retains its separate heap configuration and worker preparation.

Build, QA and test orchestration restore the same [protected Node compile cache](/ci/scope-and-routing/node-test-lanes). The trusted warmer populates build tools before collecting test imports. Scheduled and push warming use ordinary CI's Bun policy, retaining the runtime owner's Node-only exceptions; explicit workflow dispatches prime both runtimes for full validation. Optional full Node runs may start colder between manual dual-runtime warmings. Both Linux cache backends retain the same seven Control UI seed files on Node and the pinned Bun fork, and hosted tooling and contract seeds keep their existing runtime owners. Ordinary CI remains restore-only.

Scheduled current-main artifact builds also [publish their completed build-all cache](/ci/pipeline#job-ordering-and-failure-reporting) without another declaration compile. The full warmer keeps its release profile; PRs and manual runs do not publish this archive.

In-process Gateway test configs use [exclusive plan admission within existing packed jobs](/ci/capacity#measured-shard-weights).

Changed-owner Node rows use existing file/group timing evidence with a
150-test-second admission target and the existing 130-row PR cap. Complete files,
standard configs, and worker policies remain intact; predicted test seconds
are separate from measured CI wall time.
Known indivisible-file costs remain a floor when selected subsets are priced;
older complete-group measurements cannot cap those costs. Process-heavy worktree
and updater suites carry explicit case-cost weights so they do not share a row
on the default per-file estimate.

Plugin-sensitive PRs select their owner tests, transitive import consumers,
protected regressions, and policy watches. The existing Plugin Prerelease workflow retains complete
extension coverage hourly and in Full Release Validation; see
[Node test lanes](/ci/scope-and-routing/node-test-lanes).

Roomy serial Blacksmith Node jobs use [measured Vitest worker sizing](/ci/capacity#vitest-worker-sizing), with existing hosted, frozen-target, and overlapping-plan limits.

Source-only Linux Node shards can reuse content-validated compiled workers from the protected warmer; [fixed preparation costs](/ci/capacity#fixed-job-preparation) remain separate from test execution and runner capacity.

Changed-target shards whose executed file routes use the E2E config prepare the
private-QA runtime once before launching test children, even when selection maps
those files to a registered unit-suite owner. Preparation builds runtime JavaScript
and assets without global declaration emission; the AI package test separately
prepares its required declarations. Only a successful preparation step
enables prebuilt consumption, so the children reuse its JavaScript, assets, and
freshness stamps instead of starting another full build.

Vitest transform-cache generations include direct Vitest configs at every depth and the shared `test/vitest/` inputs, except the two database-worker membership inventories, unit-fast discovery inventory, and the E2E config factory. Each project fingerprints its declaring config and imported config dependencies; the E2E factory also supplies its canonical file when loaded through a wrapper. E2E-only config edits therefore invalidate E2E transforms while preserving unrelated unit transforms. Shared compiler, helper, dependency, and schema inputs retain their invalidation. Generations exclude the generated `.ci-harness` checkout so CI consumers and the protected warmer hash the same source inputs. Node bytecode caching remains enabled for ordinary Vitest runs; Vitest owns the worker-level coverage safeguard described in [local testing](/reference/test/local#core-commands).

Transform keys also include each project's dependency optimizer directory. This
prevents cached UI imports from mixing separate projects' Lit instances when a
focused run and a full run share the persistent cache.

Linux PR tests use Bun for compatible unit lanes and Control UI Vitest selections.
Audited synchronous unit-fast tests can use Bun's native runner; changed test or
setup bytes return to Vitest. Full Release Validation retains complete Node
coverage plus qualified Bun coverage; see
[test runtime selection](/ci/pipeline#test-runtime-selection).
Both runtimes group uncached, non-isolated UI files by environment in batches
to reduce worker restarts while retaining native shard ownership and worker budgets.
Bun UI workers also use an [allocation-based collection trigger](/ci/scope-and-routing/job-budgets)
to preserve memory headroom across the three native shards.
Main runs UI on Node, so a PR changing the runtime owner
(`scripts/lib/ci-test-runtime.mts`) selects the three existing UI unit shards on
Bun; see [scope selection](/ci/scope-and-routing/selection).

Frozen-target CI loads its Node shard planner, planning helpers, and measured
costs from the pinned `workflow_sha` checkout. Test discovery and execution still
use the candidate source, so current shard budgets do not replace release bytes.

The npm/ClawHub release decision treats normal CI tests, plugin prerelease,
cross-OS, performance, and QA lanes as advisory recorded evidence. Artifact,
install-smoke, survivor, all first-hop compatibility, pack/npm qualification,
package-integrity, and target-resolution proofs remain required. Aggregators follow required inputs;
identity and provenance verification still apply.

For publication, the sealed manifest supplies the SDK evidence digest,
per-package npm decisions, and any approved `OPENCLAW_RELEASE_STABLE_SOAK_WAIVER`
text. Explicit publisher inputs override those defaults; historical manifests
retain their existing input contract. SDK API changes still need an
operator-supplied acknowledgement, and the sealed waiver applies only while the
repository variable still holds the same text. Publishers still validate live authority,
artifact bytes, and registry state at the mutation boundary.

Flaky tests never block npm/ClawHub publication: record advisory failures and
investigate their owners without waiting for a green rerun. A passing replay
alone does not prove a fix. Required artifact, install, update, target, and
provenance proofs remain enforced. Native app publication is fully decoupled
from npm/ClawHub, GitHub finalization, and main closeout; report each platform's
readiness separately. The approximately 20-minute validation and one-hour
publication targets require hosted timing evidence before being claimed.

Release closeout refreshes hosted full-release shard costs with
`node --import ./scripts/tsx.mjs scripts/ci-shard-timings-refresh.mts --run <ci-child-run-id>`.
The generator records successful hosted job walls, including setup, in the existing
`config/ci-test-timings.json` store. Release keys stay separate from compact CI
spans and survive the daily refit. The hosted full planner splits measured rows
above 12 minutes after file bundling, retaining exact coverage and worker settings.
Complete split generations keep subsequent plans from recombining expensive work.
Agents-support, CLI-process, Gateway chat, Gateway methods, and runtime-config
owners retain their completed hosted cost when files are added or removed, until
a complete observation covers the new inventory. Partial generations never supply
that floor. Their full-validation rows use the existing
`-hosted-N` split, while compact main and PR routing retain their existing policy.
An indivisible over-budget test fails planning with its owner named; unmeasured
rows still need native timing evidence before claiming the 20-minute objective.

Full Release Validation's exact-target UI job retains the current three native
shards for both runtimes. Historical compatibility targets keep their original
unsharded package command; see [UI job budgets](/ci/scope-and-routing/job-budgets).

Set the repository variable `OPENCLAW_RELEASE_RUNNER_GROUP` to reserve a runner
group for Full Release Validation and its artifact, validation, and reusable
worker jobs. The Release Publish parent and its dispatched publish children read
the same variable. It selects the group; it does not provision runners or increase
concurrency limits. Missing group capacity queues jobs. Shared workflows receive
an optional `runner_group` from their release caller, including `docker-release.yml`
and `vercel-container-registry-publish.yml` from Release Publish; `docker-image-refresh.yml`,
ordinary CI, scheduled performance, and unrelated reusable callers retain their routing.
Approval and credentialed publish jobs (npm trusted publishing, ClawHub, Docker,
and GitHub App-backed release dispatch)
keep their default GitHub-hosted labels, and the hourly plugin npm preview routes
only when Release Publish dispatches it.
The runner count, matrix caps, and default labels do not change.

To reserve capacity outside ordinary PR/main pools:

1. Create an org runner group with Linux runners labelled `ubuntu-latest`/`ubuntu-24.04`, plus the Windows/macOS labels used by validation.
2. Grant `openclaw/openclaw` access to the group.
3. Set `OPENCLAW_RELEASE_RUNNER_GROUP` to the group name; unset it to release the reservation and restore ordinary routing.

Linux runners for jobs that set `semantic-checks: true` also require:

- systemd as PID 1 and an active `systemd-logind` service.
- Noninteractive sudo access to check logind, enable linger for the runner user,
  and start that user's systemd manager.
- cgroup v2 with memory and swap accounting, delegated to the user manager.

These requirements apply to custom release groups as well as ordinary runners.
The shared setup action starts the user manager and verifies a real 64 MiB scope
with swap disabled and group OOM termination before checks run. Unsupported
runners fail setup; provision these capabilities before assigning the validation
labels, or unset the release-group override to restore ordinary routing. Setup
qualifies the backend; it does not itself limit later lint or compiler commands.

Full Release Validation starts source-only children alongside artifact producers
after admission and reuse selection. Candidate consumers start as soon as the
candidate is verified, while npm qualification and independent validation can
continue; see the [release procedure](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md).

Release-dispatched validation children add one best-effort hosted receipt job
each, up to seven per full campaign and none for ordinary PR/main CI. It retains
job results independently of parent completion. With `reuse_evidence=true`, each
dispatch checks bounded prior receipts for its exact target and inputs, including
candidate bytes, and adopts only verified successful children. Other roles still
dispatch. Failed, cancelled, and active parents can supply green children; the
current parent seals and revalidates each immutable selection. Discovery adds no
jobs or Blacksmith registrations and falls back to fresh work on a miss.

Auto-reply reply tests run files in parallel with two workers per compact group. Their planner uses separate parallel timing identities; until those have measurements, serial group costs are divided by the effective worker count, with single-file groups retaining their full cost.

The Gateway isolated/database-worker cohort keeps its two-worker budget, including
roomy serial Blacksmith and hybrid jobs, to leave cold startup headroom within
existing test deadlines. Other packed groups retain their existing caps.

Commands tests share the existing worker budget across independent files. The
Doctor session SQLite cases are split by operation while preserving the complete
repair and recovery coverage; see [shard weights](/ci/capacity#measured-shard-weights).

The complete [startup corpus](/ci/pipeline) uses eight state test files so existing workers can share its release/config matrix. Its explicit fallback prepares the runtime once and uses up to four workers, capped by available CPU parallelism; historical frozen targets retain their legacy process layout with CPU-bounded admission.

| Page                                                           | Read it when                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [CI pipeline jobs](/ci/pipeline)                               | The job table, job ordering and failure reporting, and the Control UI size budgets.                                 |
| [Watch a CI run](/ci/watching-runs)                            | Wait on one pull request head, recover a stuck run, and pass the evidence gate.                                     |
| [CI checkout ownership](/ci/checkout)                          | Shared checkout anchors, fetch retry budgets, and trusted action policy.                                            |
| [CI scope and routing](/ci/scope-and-routing)                  | Why a job did or did not run: changed-scope detection and manual dispatch.                                          |
| [CI runner classes](/ci/runners)                               | Trust-based runner routing, preflight and ratchet admission, Blacksmith classes, and runner backend modes.          |
| [CI capacity and shard weights](/ci/capacity)                  | Runner registration, bounded PR concurrency, and measured shard packing.                                            |
| [Release validation workflows](/ci/release-validation)         | Full Release Validation, live and E2E shards, Package Acceptance, install smoke, Docker E2E, and Plugin Prerelease. |
| [Scheduled and maintenance workflows](/ci/scheduled-workflows) | OpenClaw Performance, QA Lab, CodeQL, the maintenance jobs, and ClawSweeper activity forwarding.                    |
| [Local checks and Testbox](/ci/local-proof)                    | Reproduce a lane locally, keep the shrink-only ratchets, and run Crabbox or Testbox proof.                          |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/ci#pipeline-overview` still resolves. Each entry points at the page that now holds the content.

- <a id="pipeline-overview" />[Pipeline overview](/ci/pipeline#pipeline-overview)
- <a id="fail-fast-order" />[Job ordering and failure reporting](/ci/pipeline#fail-fast-order)
- <a id="control-ui-size-budgets" />[Control UI size budgets](/ci/pipeline#control-ui-size-budgets)
- <a id="watching-pull-request-ci" />[Watching pull request CI](/ci/watching-runs#watching-pull-request-ci)
- <a id="recover-an-existing-pr-run-first" />[Recover an existing PR run first](/ci/watching-runs#recover-an-existing-pr-run-first)
- <a id="pr-context-and-evidence" />[PR context and evidence](/ci/watching-runs#pr-context-and-evidence)
- <a id="checkout-ownership" />[Checkout ownership](/ci/checkout#checkout-ownership)
- <a id="scope-and-routing" />[Scope and routing](/ci/scope-and-routing#scope-and-routing)
- <a id="measured-shard-weights" />[Measured shard weights](/ci/capacity#measured-shard-weights)
- <a id="clawsweeper-activity-forwarding" />[ClawSweeper activity forwarding](/ci/scheduled-workflows#clawsweeper-activity-forwarding)
- <a id="manual-dispatches" />[Manual dispatches](/ci/scope-and-routing#manual-dispatches)
- <a id="windows-testbox-probe" />[Windows Testbox Check](/ci/scope-and-routing#windows-testbox-probe)
- <a id="runners" />[Runners](/ci/runners#runners)
- <a id="blacksmith-runner-capacity" />[Blacksmith runner capacity](/ci/runners#blacksmith-runner-capacity)
- <a id="runner-backend-modes" />[Runner backend modes](/ci/runners#runner-backend-modes)
- <a id="runner-registration-budget" />[Runner registration budget](/ci/capacity#runner-registration-budget)
- <a id="surface-ratchets" />[Surface ratchets](/ci/local-proof#surface-ratchets)
- <a id="local-equivalents" />[Local equivalents](/ci/local-proof#local-equivalents)
- <a id="openclaw-performance" />[OpenClaw Performance](/ci/scheduled-workflows#openclaw-performance)
- <a id="vitest-paired-benchmark" />[Vitest paired benchmark](/ci/scheduled-workflows#vitest-paired-benchmark)
- <a id="full-release-validation" />[Full Release Validation](/ci/release-validation#full-release-validation)
- <a id="live-and-e2e-shards" />[Live and E2E shards](/ci/release-validation#live-and-e2e-shards)
- <a id="package-acceptance" />[Package Acceptance](/ci/release-validation#package-acceptance)
- <a id="jobs" />[Jobs](/ci/release-validation#jobs)
- <a id="candidate-sources" />[Candidate sources](/ci/release-validation#candidate-sources)
- <a id="suite-profiles" />[Suite profiles](/ci/release-validation#suite-profiles)
- <a id="legacy-compatibility-windows" />[Legacy compatibility windows](/ci/release-validation#legacy-compatibility-windows)
- <a id="examples" />[Examples](/ci/release-validation#examples)
- <a id="install-smoke" />[Install smoke](/ci/release-validation#install-smoke)
- <a id="local-docker-e2e" />[Local Docker E2E](/ci/release-validation#local-docker-e2e)
- <a id="tunables" />[Tunables](/ci/release-validation#tunables)
- <a id="reusable-livee2e-workflow" />[Reusable live/E2E workflow](/ci/release-validation#reusable-live/e2e-workflow)
- <a id="release-path-chunks" />[Release-path chunks](/ci/release-validation#release-path-chunks)
- <a id="plugin-prerelease" />[Plugin Prerelease](/ci/release-validation#plugin-prerelease)
- <a id="qa-lab" />[QA Lab](/ci/scheduled-workflows#qa-lab)
- <a id="codeql" />[CodeQL](/ci/scheduled-workflows#codeql)
- <a id="security-categories" />[Security categories](/ci/scheduled-workflows#security-categories)
- <a id="platform-specific-security-shards" />[Platform-specific security shards](/ci/scheduled-workflows#platform-specific-security-shards)
- <a id="critical-quality-categories" />[Critical Quality categories](/ci/scheduled-workflows#critical-quality-categories)
- <a id="maintenance-workflows" />[Maintenance workflows](/ci/scheduled-workflows#maintenance-workflows)
- <a id="dependency-audit" />[Dependency Audit](/ci/scheduled-workflows#dependency-audit)
- <a id="docs-agent" />[Docs Agent](/ci/scheduled-workflows#docs-agent)
- <a id="duplicate-prs-after-merge" />[Duplicate PRs After Merge](/ci/scheduled-workflows#duplicate-prs-after-merge)
- <a id="local-check-gates-and-changed-routing" />[Local check gates and changed routing](/ci/local-proof#local-check-gates-and-changed-routing)
- <a id="config-baseline-count-ratchet" />[Config baseline count ratchet](/ci/local-proof#config-baseline-count-ratchet)
- <a id="testbox-validation" />[Testbox validation](/ci/local-proof#testbox-validation)

## Related

- [Tests](/reference/test)
- [Scripts](/help/scripts)
- [Maturity scorecard](/maturity/scorecard)
- [Install overview](/install)
- [Release channels](/install/development-channels)

Ordinary PR iOS smoke keeps app and test-bundle compilation while selecting its two simulator groups by source owner. With neither group selected, simulator preparation is skipped. `OPENCLAW_CI_IOS_SIMULATOR_FULL=true` restores full PR execution; [selection and routing](/ci/scope-and-routing/selection) documents the owners and full hourly/release coverage.

Android's existing `android-access-native` emulator rows retain their packaged
Access-crypto proof and exercise Gateway WebSocket and widget HTTPS clients on
Android Conscrypt. Each client must pass matching leaf-pin and platform-root
controls, reject a wrong pin and wrong hostname before an origin request, and
reject the verified incident OV G3C intermediate in both trust modes. The report
reducer requires all twelve TLS class/method identities exactly once, separately
from the existing Access case and packaged-library checks.

These secretless, disposable emulators temporarily import a synthetic localhost
root and the verified incident root into copied APEX CA stores in the zygote
mount namespaces before launching the test app. Stock roots and SELinux remain
intact. Cleanup stops/uninstalls the task app, unmounts the copied stores, verifies
the full original-store manifests and SELinux state, and always disposes the
emulator and deletes its AVD without a snapshot. Failed restoration is preserved as contaminated
runner evidence; that emulator must never be reused. Reports include fixture
identities, before/after manifests and cleanup/disposal receipts. This adds no
jobs, runner tiers or fanout and never changes host trust.
