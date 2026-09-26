---
summary: "Trust-based runner routing, Blacksmith classes, and runner backend modes"
title: "CI runner classes"
read_when:
  - You need to know which runner a lane uses
  - You are choosing or changing a runner class
---

## Runners

Pull requests route preflight, the failure monitor, every static-check family,
artifact builds, Windows tests, Control UI E2E, and the final aggregate gate
directly to GitHub-hosted capacity. This PR policy takes
precedence over the default backend routes below without changing the repository
variable. Hybrid PR core lint uses five separate rows and retains six separate
extension rows. Current PR dependency scans run in three separate jobs, and three
topology stripes divide the commands declared by `check:architecture` in
`package.json`; malformed pipelines fail instead of dropping coverage.
Extension package compilation uses twelve PR stripes drawn from its complete,
source-size-ordered plugin inventory. Each stripe retains SDK preparation and
the existing worker limits. Shared preparation defaults to four Go execution
threads and a `6GiB` memory target; explicit overrides remain authoritative.
The owner still divides the hosted runner between two plugin compilers with
two threads each. The first stripe also runs the whole-inventory negative
canary, even if its compile step fails. Local, main, manual, and frozen checks
retain the unsharded command.
Windows PRs use measured hosted file costs and up to twelve rows; main and
manual targets retain their five-row plan. Windows retains one Vitest worker on hosted runners and four on
Blacksmith. Declaration fixtures already overlap native compilers inside each
file; four hosted workers caused a measured 120-second case timeout. The monitor still
reserves five minutes of its 60-minute job budget for cancellation cleanup and
publishes the failure cause before cancellation, so the required aggregate stays
red. The gate retains its failure-cause and cancellation checks on hosted runners.
Control UI keeps its existing matrix, worker limits, and Chromium commands.
Main, manual qualification, and release routing remain unchanged.

Current PR Node plans use measured hosted costs kept separately from hourly main
costs. Smaller groups retain the complete inventory, worker limits, and test
deadlines. Ordinary group admission targets 340 seconds and packed compute targets
375 seconds; CLI process groups retain a 120-second target for runtime preparation.
The 200-second setup reserve includes shared worker-bundle preparation once per
job, leaving another 25 seconds for workload variation. PR timing records keep
raw spans separate from workload measurements: only a uniquely attributed parent
preparation is removed from its triggering group's workload. The emitted
`sharedPreparationSeconds` records that cost in the job's setup reserve; runtime
and private-QA builds retain their existing compute allowance. Storage groups
balance file cost and the 16-file ceiling together. Measured heavy singleton files
and Gateway agent-chat groups have dedicated rows.
Hosted PRs may emit up to 210 compact rows and 256 total Node rows,
with a 200-row concurrency cap. Other backends retain their existing caps. The
optional PR hosted admission budget is 300 jobs; main retains 45. These are
per-run bounds, not a reservation of the organization’s shared hosted pool.
Qualification records job-created-to-started waits separately from prerequisite
waits and complete job walls.

Runner choice follows contributor trust, not whether a pull request came from a fork. Every `runs-on` expression admits Blacksmith only when `github.event.pull_request.author_association` is `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR`, so a fork pull request from someone who has already landed a commit is routed exactly like a maintainer pull request. `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, and `MANNEQUIN` stay on GitHub-hosted runners, which are free for public repositories, so an unreviewed author cannot spend Blacksmith capacity. Maintainers report `CONTRIBUTOR` here because org membership is concealed; keep `CONTRIBUTOR` in that list or maintainer pull requests lose Blacksmith. Pushes and manual dispatches are unaffected. Cache trust is a separate, stricter boundary: exact dependency restores require a pull request from `openclaw/openclaw`, and ordinary CI never publishes the shared archives. The separate trusted warmer owns publication.

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ubuntu-24.04`                   | the hosted `openclaw/ci-gate` fallback, hybrid preflight retries, `check-docs` in every mode (its ClawHub mirror clone is unauthenticated by design), `security-fast` outside hybrid first attempts, manual CI dispatch and non-canonical repository fallbacks, CodeQL security and quality scans, workflow-sanity, labeler, auto-response, the standalone Docs workflow, the whole Install Smoke workflow, all configurable CI jobs in `github` mode, and the remaining light lanes plus rerun Blacksmith lanes in `hybrid` mode. The GitHub/hybrid planner profile expands the Node matrix, QA Smoke to six parts, core oxlint across five stripes (two jobs on ordinary non-frozen hybrid push/PR runs), and current test-type checks across five core stripe jobs plus the central extensions/root/scripts tail. Extension/scripts lint plus optional UI and format checks stay in `check-lint`; frozen targets retain their historical three-job type layout. |
| `blacksmith-4vcpu-ubuntu-2404`   | `openclaw/ci-gate` on retained hybrid and failure-cancellation routes, `preflight` when the backend is unset or `blacksmith`, hybrid first-attempt `security-fast`, `native-i18n`, `checks-fast-core` except QA Smoke CI, plugin/channel contract shards, most bundled/lower-weight Linux Node shards, `check-*` lanes except `check-lint`, selected `check-additional-*` shards, and `skills-python`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `blacksmith-8vcpu-ubuntu-2404`   | Retained heavy Linux Node suites and native compact rows previously requesting the 4-class, the `checks-ui-e2e` browser-extension row, boundary/extension-heavy `check-additional-*` shards except runtime topology architecture, and `android`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `blacksmith-16vcpu-ubuntu-2404`  | Trusted automatic hybrid first-attempt preflight, main CI build artifacts, automatic QA Smoke, Docker seed, Control UI E2E, lint, dependencies, test types, core test-type stripes, extension package boundaries, and runtime topology architecture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `blacksmith-32vcpu-ubuntu-2404`  | Full CLI bins, memory-gated Node rows, two-child compact bins, Blacksmith tooling and agent-support bins, hybrid unified and SDK declaration compiler fixture bins, real-Gateway E2E, separate npm release preflight and reusable release/E2E workflows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `blacksmith-6vcpu-macos-15`      | `macos-node` on `openclaw/openclaw` when the backend is unset or `blacksmith`; hybrid and existing fallback routes use `macos-15`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `xcode-27`                       | All selected `macos-swift` and iOS build phases, both full-manual screenshot shards, and all four Periphery scans always use GitHub-hosted capacity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The table lists default placement. On eligible hybrid first attempts, the [hosted budget](/ci/capacity#bounded-hybrid-hosted-offload) can move `security-fast`, all three `checks-ui` rows, and only the browser-extension E2E row to `ubuntu-24.04`; the default Blacksmith routes apply when optional admission is closed.

Healthy eligible main pushes and Windows-selected PRs can additionally offload five check rows under the [assignment guard](#hybrid-hosted-assignment-guard). Main alone can then offload lint and central test types. Each decision consumes remaining capacity within the same 45-row limit; the original runner remains the fallback. Artifact builds retain the 16-class: their hosted maximum reached 898 seconds before preflight and gate overhead. See the [routing measurements and qualification gaps](/ci/routing-costs).

Native Swift builds/tests, iOS build phases, screenshot shards, and Periphery scans use Xcode 27 on GitHub-hosted `xcode-27`, the preview macOS 27 image. This toolchain change preserves hosted placement, job counts, worker caps, coverage, and deadlines; it adds no Blacksmith registrations. The Swift source-language minimum remains 6.3. Native compatibility and complete job timings require proof on the new image.

The earlier hosted-routing validation used `macos-26`: repeated first attempts left the Blacksmith macOS jobs unassigned while other CI completed. In [run 33616182173](https://github.com/openclaw/openclaw/actions/runs/33616182173), the hosted retry assigned all three waiting Mac jobs within eight seconds; the Debug/simulator job passed in 15m31s. That historical result predates Xcode 27. Complete native evidence remains required for full manual qualification.

The Node test planner marks only shards that run the real native grep fixture.
Those Linux jobs install the `ripgrep` package when the selected runner image
does not provide it. Other Node shards do not pay that setup cost.

Current targets share one checkout/setup per fast contract family. The two weighted plugin selections still run as separate `test:contracts:plugins` processes; the two channel selections still run separate `test:contracts:channels` invocations, each retaining its four owning configs, four project slots and one worker per project. The envelopes run sequentially, and any nonzero exit stops the job before another envelope is admitted. Frozen targets keep their original matrix rows and execute one envelope per row. Runner routing, caches, worker budgets and aggregate-gate selection stay unchanged. In main run `33704083233`, the separate plugin bodies totaled 94 seconds and the channel bodies 145 seconds; those sums support consolidation but are not measured combined durations.

The dependency warmer publishes the completed pnpm store immediately after setup,
before unrelated SDK, build, or transform work can fail. All cache-enabled Node
setups use the same workspace-local store path, including store-only readers;
Actions includes that path in cache compatibility. Pnpm's side-effects cache
carries native postinstall outputs such as Matrix crypto's binary and version
marker, so a compatible warm install skips the download. Cold caches and changed
native build inputs still require the upstream asset.
Setup restores the configured store root before activating pnpm. The same
artifact contains the pinned pnpm wrapper and Linux native executable archives
under `toolchain/`, keyed by the complete `packageManager` pin. Bootstrap checks
their SHA-512 hashes in private staging before extraction; missing or invalid
archives fall back to the runner image, then the registry. Exact dependency
archives carry the same files, and dependency repair preserves them. Store v2
and exact-dependency v4 entries reseed once to include these bootstrap archives.
Cache publication still belongs to the existing warmer on each backend.
Node discovery scans only the toolcache's executable levels, avoiding bundled
npm dependency trees before selecting an already-installed runtime.

In hybrid mode, independent hosted dependency and code-warming jobs populate
GitHub's cache backend. Blacksmith and GitHub-hosted cache archives remain
separate. See [cache ownership and seed selection](/ci/scope-and-routing/node-test-lanes)
for the full Linux and bounded hosted profiles.

### Windows dependency-cache experiment

Normal Windows CI keeps dependency setup uncached. In the September 20
[benchmark](https://github.com/openclaw/openclaw/actions/runs/35547255790), median
complete setup took 45.295s cold versus 52.738s with a restored store (+16.4%),
despite reusing all 1,453 packages with zero downloads. Restoring the 763.8-MiB
archive took 23.601/25.978/26.980s; the first sample spent 20.966s extracting it.
Producer setup plus archive publication added 62.527s of job work.

All seven native jobs passed, but the workflow failed qualification: its reducer
rejected a 24-KiB difference in reported total RAM. These measurements use the
original receipts, with no assertion changes or reruns. The exactly RAM-matched
subset had a 47.369s cold median versus 52.738s warm (+11.3%); this descriptive
comparison does not replace the failed qualification. Revisit caching only when
complete setup improves after accounting for restore, extraction, frozen
reconciliation, and producer work.

### Blacksmith runner capacity

Npm preflight retains `blacksmith-32vcpu-ubuntu-2404`. Main CI previously used
the same class for test types, core type stripes, and runtime-topology checks
to compensate for smaller delivered machines.
In the [2026-09-01 capacity probe](https://github.com/openclaw/openclaw/actions/runs/33538827388),
that label was the first measured class meeting the eight-CPU/24-GiB threshold
used by OpenClaw's parallel-check policy:

| Requested x64 Ubuntu 24.04 label | Observed CPUs | Observed RAM |
| -------------------------------- | ------------: | -----------: |
| `blacksmith-2vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-4vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-8vcpu-ubuntu-2404`   |             2 |     7.66 GiB |
| `blacksmith-16vcpu-ubuntu-2404`  |             4 |    15.42 GiB |
| `blacksmith-32vcpu-ubuntu-2404`  |             8 |    30.95 GiB |

OS CPU count, affinity, Node, and CPU-time measurements agreed. Guest cgroup
quotas were unlimited. The provider-side reason for the mismatch is unresolved;
the table records observed capacity, not Blacksmith's advertised specifications
or a guaranteed allocation. The probe measured capacity, not whole-release
speedup or billing equivalence.

Compact Node jobs retain the planner's 32-class request for two-child bins and
Blacksmith tooling or agent-support owners. The 16-class delivered four CPUs and
15.42 GiB, forcing two-child plans to execute serially despite their unchanged
aggregate packing budget. The 32-class is the measured allocation that meets
the existing eight-CPU/24-GiB admission threshold. Packing, check names, timing
identities, budgets and worker limits remain unchanged; actual capacity still
gates overlap. This moves existing jobs between classes without adding runner
registrations or hosted rows. Real-Gateway E2E also retains its 32-class request;
other main CI placements retain the 16-class sizing.
Native CI must establish the resulting execution and queue times.

Compact groups with a memory-gated worker allowance also request the 32-class,
including standalone serial bins. The isolated Gateway groups already request
eight workers with a 28-GiB memory floor and a two-worker fallback. On main run
`35791016837`, two 8-class rows received two CPUs and 7.66 GiB: their isolated
children took 413 and 369 seconds, and the complete jobs took 678 and 685 seconds.
The 32-class meets that existing allowance. Promotion happens after packing;
file membership, child ordering, memory checks and fallback workers remain owned
by the same planner and executor. Hosted routing still uses the workflow's trust
and retry rules. This adds no jobs or runner registrations.

Native compact rows that would request the 4-class now request the 8-class after
packing. Both delivered two CPUs and 7.66 GiB in the capacity probe, while the
five-run September 21 sample showed a 125-second median assignment wait on the
4-class. Logical packing classes, child processes, worker limits, and hosted
fallbacks stay unchanged. This avoids that queue at a higher per-minute rate;
the combined packing and hosted-check changes must establish the net cost saving.

Current-target `build-artifacts` uses the existing 16-class. A [controlled Testbox proof](https://github.com/openclaw/openclaw/actions/runs/34669346942) at `3ccc3710bd6` completed all eight job compute steps in 229.3 seconds (252.8 seconds including payload setup) on four CPUs and 15.42 GiB RAM, with a 12.59 GiB cgroup peak and no recorded OOM events. The proof retained the complete parallel verifier wave and passed final source, worker-generation cleanup, and memory-event checks. The existing SDK memory gate keeps declarations serial below the capacity needed for both compiler heaps. Frozen targets and missing target classifications now request the same 16-class; hosted fallbacks, job counts, concurrency, and deadlines are unchanged. The recorded measurements establish compute fit for that tested current target, not historical targets or a guaranteed full Actions duration.

Existing recommendation-based promotions from the 8-class remain for `checks-node-compact-large-5` and `checks-node-compact-large-9`. Extension bundles follow the planner's runner metadata: the former bundle-16/bundle-25 overrides would attach old recommendations to different work after compaction. The former 32-to-16 overrides for `checks-node-compact-small-3`, `checks-node-compact-small-4`, and `checks-node-compact-small-10` are removed so these rows retain their planner-owned parallel or tooling capacity. Numbered bins can contain different work across profiles and revisions; the retained compact recommendations use a 24-hour window and still need ownership-based replacement when those bins change. A later recommendation identified CPU saturation for `build-artifacts` on the 16-class. Current complete-job duration and memory headroom still need measurement; the earlier controlled proof retains its original source scope.

Eligible `checks-ui-e2e-real-gateway` rows retain their planned 32-class. The
planner balances serial fixtures and audited parallel standalone files in the
first row; the second owns the remaining parallel files. The first row also owns
the desktop transport proof when selected by full manual/release validation or
a direct desktop-spec edit. Both rows retain their existing worker limits, build-before-test
ordering, hosted fallbacks, and test deadlines. Runtime-only preparation leaves
SDK declaration generation and validation with `build-artifacts`. The split adds
one job and possible registration when the lane is selected, while ordinary PRs
continue to omit it. Runner labels and backend routing are unchanged. Exact-head
CI measures complete row walls, including setup and transport proof.

The 32-class restores capacity for the unchanged 20-minute Blacksmith budget.
In [run 35120538555](https://github.com/openclaw/openclaw/actions/runs/35120538555/job/104877350907),
the 16-class delivered four CPUs and was canceled after 1,227 seconds while
real-Gateway files continued passing; the last file passed 13 seconds before
cancellation. Setup, artifact build and desktop proof consumed 6m31s before the
browser suite. Keep the complete job inside its existing budget by restoring
capacity, with the hosted routes and all test deadlines unchanged.

The real-Gateway job has a 40-minute budget when its existing routing selects
`ubuntu-24.04`, and 20 minutes on Blacksmith. In [run 34707873095, attempt 2](https://github.com/openclaw/openclaw/actions/runs/34707873095/attempts/2),
7m42s elapsed before the browser suite began; the 20-minute job limit then
canceled a progressing suite before its widget cases. The hosted budget covers
the complete setup, private artifact build, and test workload. Individual test
and subprocess deadlines, test inventory, workers, routing, and concurrency
limits apply unchanged on both routes. This adds no jobs or runner registrations
and makes no claim that execution is faster.

The full CLI compact bin requests the 32-class after packing and uses measured
workers with `fallbackMaxWorkers: 2`. Serial self-hosted execution can admit
eight workers on the observed eight-CPU/30.95-GiB allocation. Hosted, frozen,
constrained, and overlapping execution retain the fallback. Process-only CLI
bins, serial companion execution, packing, and job counts keep their existing
policies. See [Vitest worker sizing](/ci/capacity#vitest-worker-sizing).

The earlier 16-class placement had a controlled 2026-09-10 Linux Testbox
comparison at the same source, memory, starting caches, and case inventory:
12m20s–14m15s with two available CPUs versus 9m17s with four, both at two Vitest
workers. All 307 files and 7,977 cases were retained. Those measurements do not
describe the 32-class policy or include CI setup, queueing, or companion groups.
The later CLI timing weight of 595 seconds and complete CLI config remain
unchanged by the measured-worker cutover.

Backend routing still applies. Hybrid retries and untrusted pull requests retain
their hosted routes. Ordinary manual CI dispatches remain hosted in hybrid mode;
Full Release Validation's existing frozen-target lint exception remains separate.
Npm preflight uses the larger Blacksmith request by default and retains its
explicit `use_github_hosted_runners` option.

Ordinary iOS smoke CI builds the app and embedded Watch targets for the runner's
architecture, using the same iPhone simulator for compilation and voice-cleanup
tests. It omits compiler indexes, which CI does not consume, and finishes
simulator preparation before XCTest launch. Smoke retains complete test results
and logs but disables verbose system-diagnostic collection: Xcode 27 can spend
600 seconds collecting it after passing tests. Full manual validation retains
universal simulator compilation, verbose diagnostics, the Release device build,
and lifecycle/UI/Watch tests. Frozen targets keep their original build settings.

Scheduled main CI uses the same automatic runner and dependency-cache policy as
main pushes. A `runson` configuration keeps the existing hybrid baseline for
scheduled work; only qualified paths opt into RunsOn. Manual dispatches stay
hosted under their existing policy, even when their dispatch ID resembles the
retired hourly marker. Native runner labels and worker limits are unchanged.

### Runner backend modes

The `macos-swift` lane builds Swift tests once and runs each test once per job. The ordinary suite retains default-profile behavior; rendered Quick Chat tests follow in a fresh default-profile process, then AppState isolation tests run in a named-profile process through the same resource-owning launcher. Historical targets retain their original two partitions. Each launch owns a private home and disposable, unlocked default Keychain until the test process group and output pipes close. HOME and profile markers do not isolate macOS services; all partitions run only on the disposable credentialless macOS worker. Current launcher-capable targets bound Swift Testing parallelism to the runner's logical CPU count, capped at 12, for automatic runs, manual dispatches, and rerun attempts. Only frozen targets that predate the resource owner use the serial fallback. A failing test fails the job without an in-job retry. See [native test safety](/platforms/mac/dev-setup#run-native-tests-safely).

The repository variable `OPENCLAW_CI_RUNNER_BACKEND` controls the runner backend for `ci.yml`:

| Value                 | Light lanes                                                                 | Heavy lanes                                                               | Rerun behavior                                                                        |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| unset or `blacksmith` | Blacksmith-first, with the existing manual-dispatch and fork fallbacks      | Blacksmith-first, with the existing manual-dispatch and fork fallbacks    | Existing behavior is unchanged                                                        |
| `github`              | GitHub-hosted                                                               | GitHub-hosted                                                             | Every configurable job remains hosted                                                 |
| `hybrid`              | Eligible preflight and other critical-path jobs use Blacksmith on attempt 1 | Blacksmith on attempt 1; GitHub-hosted on `github.run_attempt > 1`        | Rerunning a failed or stuck Blacksmith job automatically moves it to hosted capacity  |
| `runson`              | Hybrid baseline                                                             | Hybrid baseline; manual qualification can route cron child rows to RunsOn | Automatic Spot-interruption retries disabled; other reruns retain the hybrid fallback |

Configurable heavy lanes are `build-artifacts` and `android`. The macOS Swift, iOS build, and screenshot jobs always use GitHub-hosted `xcode-27` with Xcode 27. The focused `macos-node` lane uses the existing GitHub-hosted `macos-15` image in hybrid mode, with the same test inventory and two-worker limit. `openclaw/ci-gate` always uses `ubuntu-24.04`: its Bash-only result aggregation needs no checkout or dependency setup. This removes one Blacksmith registration from previously eligible runs without adding jobs or changing the required check. Hosted runner assignment can still delay completion. Trusted automatic hybrid first-attempt `preflight` requests the existing 16-class after three nearby hosted preflights remained unassigned while their Blacksmith security jobs completed. Hybrid retries, manual dispatches, untrusted and noncanonical contexts, and the `github` override stay hosted. Unset or `blacksmith` keeps the existing 4-class route. Logical planner profile, cache trust, steps and the 20-minute deadline remain unchanged; actual assignment and completion still require CI proof. `security-fast` uses Blacksmith only on eligible hybrid first attempts when the [hosted budget](/ci/capacity#bounded-hybrid-hosted-offload) cannot admit optional work, and stays hosted outside `hybrid`. It waits for preflight to count the selected hosted rows, and still executes after a preflight failure unless the workflow is canceled. Security hooks use pinned installed packages and local hook definitions, so they no longer initialize remote Git repositories. Budget two control-job registrations per eligible hybrid first attempt when optional hosted admission is closed, one when admitted, and one per normal Blacksmith run; both jobs are already reserved in the conservative registration ceiling. The `github` override remains unchanged. Hybrid sends the compact Node matrix, up to 80 compact rows plus separately appended plugin fallback rows, thirteen-row `checks-ui-e2e` matrix for targets with the named-project contract, the `checks-ui-e2e-real-gateway` lane that shares its serial Chromium workload, four-row QA Smoke matrix on canonical automatic runs (six rows for manual dispatches), the two-part Windows matrix, `checks-ui`, `check-lint`, `check-test-types`, the five `check-test-types-core-*` rows, `check-dependencies`, `check-additional-extension-package-boundary`, `check-additional-runtime-topology-architecture`, and `report-plugin-sdk-api-diff` to Blacksmith on attempt 1. Eligible two-child ordinary compact rows request `blacksmith-32vcpu-ubuntu-2404`; bins containing the full `agentic-cli` group request `blacksmith-32vcpu-ubuntu-2404` after planning. Other compact-small rows retain `blacksmith-4vcpu-ubuntu-2404`, compact-large rows retain `blacksmith-8vcpu-ubuntu-2404`, and the planner's measured small queue-tail promotions retain their 8-vCPU labels. Within that set, `checks-ui` and only the browser-extension E2E row move to hosted Ubuntu when preflight admits at most five optional rows below the 45-row hosted limit. Every other configurable `ci.yml` lane stays hosted in hybrid, including the core-lint jobs, the remaining lint/check rows, docs, and Python skills. Separate Opengrep workflows remain GitHub-hosted.

### RunsOn qualification

The opt-in `runson` profile derives its plan from `hybrid`. It extracts the three
`core-runtime-cron-parallel-*` children into one serial job on `c8i.8xlarge`
with 32 vCPUs, 64 GiB RAM, `ubuntu24-full-x64`, and an 80 GB gp3 root. The
current 258-file cron inventory retains its two-worker job and group ceilings.
The three source Blacksmith jobs retain their other children. Hybrid owns the
shared serial-tail splits and measured nine-to-four tooling packing, preserving
child contracts, workers and deadlines. Broad-PR Node /compact counts are
98 /60 on hybrid and 99 /61 on RunsOn, within unchanged caps. No NVMe,
sticky disk, warm pool, or test-inventory change is enabled.
The exact-head comparison passed cron on Spot, Blacksmith, and GitHub in
396, 432, and 672 seconds, respectively. Both native workflows still failed
and exceeded fifteen minutes; see the
[measured routing costs and remaining qualification gaps](/ci/routing-costs#runson-remains-unqualified).

Automatic PRs use the hosted Node plan even when the repository backend is
`runson`. The repository variable remains unchanged during qualification.
A maintainer can explicitly dispatch
`ci.yml` with `runner_backend=runson`, `release_gate=true`,
`pull_request_number`, and `target_ref` set to the full current PR head SHA.
The workflow branch must be that PR's canonical branch and head, and the
existing maintainer admission must pass. The qualification adds two identical
cron controls, on Blacksmith and GitHub, with the same pinned Node version and
two-worker ceiling. They count against the final Node cap (101/130 for this
inventory) and are absent from normal PR plans. A qualification must select cron
tests; otherwise preflight fails before allocating comparison runners. Qualification uses the profile’s
normal downstream placement, read-only cache admission, and lint partitions.
Its preflight remains hosted until authorization succeeds and is counted in
the hosted budget. Release-only lint and minimum-Node compatibility jobs stay
with ordinary manual validation. Ordinary manual dispatches and
untrusted or unrelated targets cannot use this override.

For a main-shaped measurement, set `ci_shape=main` with the same exact-head
PR admission and choose `runner_backend=hybrid` or `runson`. This uses push
coverage, the 70-row Node cap, Node runtime, and ordinary main proof/native
selection. It omits PR extension fallback and the two cron comparison controls;
it does not add full-manual release-only work. Raw GitHub event/ref still own
trust, concurrency, cache publication and provenance. The initial preflight is
hosted and included in the measured wall. Ordinary dispatches retain
`ci_shape=default` and their existing behavior. Explicit hybrid qualification
with the default shape uses PR coverage.

RunsOn uses one opaque label per row, with a unique run/row identifier:

```yaml
runs-on: runs-on=${{ github.run_id }}-${{ matrix.check_name }}/family=c8i.8xlarge/cpu=32/ram=64/spot=true/retry=false/image=ubuntu24-full-x64/volume=80gb
```

The existing GitHub App handles this label route. It does not require a new AWS
login from the operator, though the expired operator SSO session prevents current
administrative, selected-AZ price, and teardown verification. The public AWS feed
supplies a regional Spot reference without authentication: $0.6586/hour for this
type in `us-east-1`, fetched September 22, 2026, at 06:02:13 UTC. See the
[price source, timestamp, and measured allocation estimate](/ci/routing-costs#runson-remains-unqualified).
No interactive login is part of qualification.

`spot=true` retains the provider's automatic on-demand fallback when Spot
capacity is unavailable. `retry=false` explicitly disables automatic
interruption reruns: native `retry=when-interrupted` can rerun failed jobs and
their dependents twice, after the entire failed workflow attempt completes.
That recovery has not been measured inside the original 900-second wall, so
an interrupted qualification can fail. Manual reruns retain the hybrid hosted
fallback and do not establish Spot-recovery performance. See the
[provider's retry contract](https://runs-on.com/docs/runners/labels/#retry) and
[routing costs and qualification gaps](/ci/routing-costs#runson-remains-unqualified).
This opt-in route makes no interruption-safe fifteen-minute claim.

### Hybrid hosted assignment guard

Automatic canonical hybrid first attempts inspect recent hosted assignment before admitting additional checks. Main pushes qualify directly; PRs must select Windows coverage and a full compact Node plan containing at least 500 predicted seconds in one serial row. The admitted hosted checks completed within 549 seconds including setup in the native PR trial, with at least 289 seconds of slack before the final Node job. The serial prediction is an admission floor; actual setup, assignment delay, and workflow completion still require measurement. Precise plans, shorter serial rows, and aggregate two-slot estimates do not qualify. The five Windows shards alone no longer establish the old two-shard latency floor. Fast-only scopes, frozen targets, manual dispatches, retries, other repositories, and untrusted authors retain their existing routing.

`scripts/lib/ci-hybrid-hosted-health.mts` uses preflight's read-only Actions permission. One ten-second deadline bounds at most four requests: the newest ten main push runs created within the past day, then the first hundred attempt-bound jobs from up to three fresh eligible runs. The server-side date filter prevents an unrestricted history listing from omitting recent matches. It samples only known hosted jobs whose sole dependency is preflight. Wait begins at the later of job creation and successful preflight completion, excluding dependency delay. Evidence must be within thirty minutes; any assignment wait of at least sixty seconds, missing assigned samples, malformed response, or API failure keeps the new offloads on Blacksmith. The step reports the reason, sample count, and maximum wait without exposing request diagnostics.

Dependencies, core type stripes, extension package boundaries, and runtime topology have measured hosted execution within the eligible PR workload's slack. Main additionally admits lint and central types. In the September 22 five-run sample, the largest independent hosted check took 664 seconds; artifact builds reached 898 seconds and therefore retain Blacksmith. These observations replace the earlier projections made against a thirty-minute main objective. The current qualification target is a complete run within fifteen minutes, including preflight, assignment, setup, and the gate; routing estimates alone do not establish it. Automatic preflight retains Blacksmith. The admission guard now rejects waits at sixty seconds to match that target; API and job deadlines remain unchanged.

This is an admission decision for future jobs. A hosted stall beginning after the snapshot can still delay admitted work, and existing hosted jobs remain exposed. The probe itself can add up to ten seconds to preflight. It never changes repository variables, migrates an already queued job, or retries failed work.

Hybrid is the normal degraded-capacity mode. If Blacksmith is down: rerun the failed or stuck heavy job; it lands on hosted automatically. During a full Blacksmith outage, record whether `OPENCLAW_CI_RUNNER_BACKEND` is set and its current value, then enable the `github` circuit breaker:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

The `github` override also routes Full Release Validation orchestration, npm qualification, live QA, performance, package Telegram, OpenWebUI, and release runtime-pair jobs to GitHub-hosted Ubuntu. Existing explicit hosted-runner inputs remain supported. Runner placement changes; coverage, artifact identities, approvals, worker limits, and timeouts do not. Already-running jobs are not moved. Keep OpenWebUI disk requirements and performance baseline hardware differences in mind when interpreting hosted results.

Hosted `ci.yml` paths use the same setup exercised by manual dispatches and fork pull requests. Fork PRs are forced into the logical `github` planner profile even when repository variables are unavailable, so broad core lint and test-type workloads retain hosted stripes instead of falling back to oversized all-in-one jobs. Frozen targets opt into this event-aware profile through `hosted-runner-profile-contract-v1`; targets without the marker retain their historical workload shape. Blacksmith-only Docker and sticky-disk steps are skipped, dependency setup uses the ordinary Actions pnpm-store cache, and low-memory Android builds use separate Gradle processes. Hybrid attempt-1 Blacksmith Node and plateau lanes restore the exact workspace dependency archive from the trusted warmer. Eligibility uses the actual runner environment, so hosted lanes and retries stay on the ordinary store cache. The exact key includes the resolved Node patch, OS, architecture, and semantic dependency inputs; a different runner image safely misses and follows the existing store-install path. The Node toolchain itself is also cached through that API: Blacksmith's image tracks an older runner-images snapshot whose toolcache Node patches (measured 2026-08-16: 20.20.0, 22.22.0, 24.13.0) sit just under this repo's `engines` floor, so every job otherwise re-downloads Node from nodejs.org. Restores are prefix-keyed and saves carry the resolved patch, because an exact-key hit suppresses the post-job save and would pin the first payload forever once the floor advanced past it. A restored payload below the floor is rejected, pruned, and replaced. Vitest transform and Node compile caches still use the upstream Actions cache API; their Linux-only `runner.os != 'Windows'` conditions do not exclude Blacksmith labels, and the trusted warmer alone publishes each backend-local protected seed. The warmer's selected runner route determines whether that publication reaches Blacksmith's cache or GitHub's cache. Core oxlint keeps five deterministic hosted stripes with one lint thread per process. The large agents, Gateway, infrastructure, and UI targets run in separate processes within their assigned stripe so native semantic caches are released before neighboring targets run. This isolation applies to explicit core-stripe invocations. Automatic full lint, including the published Git updater preflight, retains its original five aggregated core Programs even when CI environment variables are inherited. Ordinary non-frozen hybrid push/PR runs group stripes 1+2 and 3+4+5 sequentially across two jobs. Trusted first attempts and admitted qualification dispatches use the Blacksmith 16-class for the heavier first packed row and the 8-class for the second; hosted assignment placed them on the measured critical path. The first row took 621 seconds on the 8-class, including 568 seconds of lint, so it retains four actual CPUs. Unpaired trusted-fork stripes use the 8-class. The aggregate gate uses the 4-class under the same backend, trust, and attempt admission, independently of the target checkout. The GitHub override, retries, ordinary manual dispatches, and untrusted contexts retain hosted routing. A failing stripe stops its row. The `github` profile, frozen targets, manual dispatches, and release gates retain five jobs; GitHub plugin stripes keep their existing owners. Plugin lint ownership is described below; script lint and optional UI and format checks stay in the existing `check-lint` row. Extension type-aware lint discovers `extensions/tsconfig.json` for plugin tests and helpers, retaining imported dependencies and shared ambient declarations without adding unrelated core/UI/package source roots. Plugin production files keep their existing package-boundary projects. Eligible core-source and test changes in pull requests reuse the local changed-check selector. On current targets with stripe support on `github` or `hybrid`, each of the five `check-test-types-core-*` rows validates the complete core graph boundary, then compiles the changed tests' consuming graphs that belong to its canonical stripe. Stripe membership is assigned before narrowing, so empty intersections stay empty and the union preserves every selected consumer. Ambiguous compiler ownership or a removed test selects every canonical core test graph across those same five stripes. The additional-boundary lane transfers its core graph check to these required type rows, and `check-test-types` owns only the extensions/root/scripts tail. Full runs use the same five stripes without consumer narrowing. Frozen targets retain two paired rows for stripes 1+2 and 3+4, with stripe 5 in the central row. Targets without stripe support and the all-Blacksmith profile keep the full central path. Each core type row preserves at most two concurrent compiler children and one builder per child. Core checks retain the standalone resource policy; the remaining type commands retain their existing environment. A failed boundary or compiler stops its row before another command starts.

The `agents-sessions` graph owns the complete `src/agents/sessions/` and `src/config/sessions/` test subtrees, keeping session runtime and storage tests together. The `agents-tools` graph also owns shell/tool tests, nested sandbox tests, managed-worktree tests, and the complete security and secrets test subtrees. The `config-cli` graph owns configuration, hook, and CLI tests except the separately owned session, daemon, cron, program, and update subtrees. The `cli-update` graph owns `src/cli/update-cli/` and root `src/cli/update*.test.ts(x)` tests; `commands` owns `src/cli/program/`. Root-level Gateway session tests belong to `gateway-root`; `gateway-server` owns root-level `server*.test.ts(x)` tests and the complete `src/gateway/server/` test subtree. The `gateway-methods` graph owns `src/gateway/server-methods/`; `gateway-other` owns `src/gateway/worker-environments/` and the remaining nested Gateway tests. The `infra` graph owns infrastructure and media tests; `state-logging` owns audit, state, logging, and shared tests. The `plugin-sdk` graph owns the complete `src/plugin-sdk/` and `src/channels/` test subtrees; `messaging` owns auto-reply and outbound infrastructure tests. The `services` graph owns daemon CLI, cron CLI (the nested `src/cli/cron-cli/` tests and root `src/cli/cron*.test.ts(x)` tests), cron, daemon, heartbeat, process, skills, and infrastructure update tests. New graph splits are appended to the canonical registry so existing stripe assignments stay stable. The core-test boundary guard requires every test root exactly once across the canonical graphs, with at most 720 roots per graph. The inventory regression test requires at most 700 roots per graph so rebalancing happens before a shard reaches the hard cap. The graphs keep their existing stripe assignments and compiler concurrency; moved tests follow their new graph's stripe. Changed-test selection still checks every consuming graph.

Android Play and ThirdParty rows run their unit tests. In the normal four-row tier, Wear also owns third-party app lint, while the Kotlin-lint row owns Play app and Wear-shared lint. Every row keeps separate, sequential Gradle processes and shares one UTC build timestamp through the existing `openclawBuildTimestamp` property when it has multiple native invocations, avoiding `BuildConfig` regeneration solely because a later command starts. Phone test classes on Blacksmith run in at most two isolated JVMs, bounded by available processors, with the existing 1 GiB heap per JVM. Classes remain sequential within each JVM; hosted tests keep one JVM. Full manual and historical compatibility task inventories are unchanged.

Task-scoped Blacksmith sticky disks retain the Gradle user home across dependency changes. Gradle owns content-addressed invalidation and periodic expiry of unused caches and wrapper distributions; CI does not erase the warm home when a dependency fingerprint changes. Protected pushes remain the only snapshot writers, and pull requests consume read-only clones. Dependency resolution remains online so a changed dependency or cold snapshot can populate missing artifacts.

On hosts with less than 24 GiB RAM, serial plugin lint runs use eight-directory chunks by default. Automatic Linux CI uses sixteen-directory chunks with at least four CPUs and 15 GiB of verified physical and cgroup memory capacity, including ancestor limits. Unknown or smaller capacity, local runs, Windows, explicit plugin stripes, and explicit serial selections retain eight-directory chunks. This amortizes repeated type-graph startup while covering every plugin and root source file. Outside Windows, explicit full-speed or parallel overrides keep the previous unsplit workload. The Windows chunk-size override remains Windows-only. Lint prepares only the SDK declaration tree; the separate package TypeScript boundary check still prepares the SDK and plugin declarations.

For current targets using the `github` profile, plugin lint chunks are divided deterministically across six existing jobs. Each of the five core-lint jobs runs its core Program, then its plugin chunks; `check-lint` owns the sixth stripe, script lint, and formatting. Current hybrid targets instead run six independent hosted extension-lint stripes, preserving the two packed core-lint jobs and leaving scripts, optional UI checks, and formatting in `check-lint`. This avoids adding declaration preparation to the heaviest core stripe. Every extension stripe uses the existing eight-directory chunks, one lint thread, and serial semantic Programs. Restored boundary artifacts still pass the existing content-freshness checks; a miss or changed input rebuilds them. The added rows count toward the unchanged hosted admission limit. Frozen hybrid targets, Blacksmith, release gates, and historical targets without extension-stripe support retain their existing plugin-lint ownership.

The compact Node planner keeps separate Blacksmith and standard 4-core hosted timing ownership. The `github` profile and serial `hybrid` jobs admit 210 predicted seconds per job, including shared runtime preparation. Eligible ordinary hybrid bins use the larger Blacksmith capacity policy below; file partitions, process envelopes and explicit worker pins stay intact. GitHub applies a 1.6x median scaling fallback only to unmeasured groups. Hybrid splits groups using the slower of the first-attempt Blacksmith estimate and the hosted retry estimate against the unchanged 150-second ceiling. This prevents a faster retry estimate from leaving a slow first attempt indivisible. Its attempt-1 packing applies the existing 0.87 scale to Blacksmith estimates, using committed measurements before the cold-start hints. These calibrated predictions remain separate from the recorded wrapper wall times. Refits can change the number and composition of compact jobs without changing runner policy. Direct sampled hints cover the doctor and cron-service outliers. In hybrid, the unmeasured `agentic-gateway-core-3` tail retains its 140-second fallback within the applicable serial or parallel admission budget.

Hybrid compact jobs containing `test/scripts/write-unified-entry-dts.test.ts` request `blacksmith-32vcpu-ubuntu-2404` after packing. In [run 35186413697](https://github.com/openclaw/openclaw/actions/runs/35186413697/job/105089529454), the unchanged 120-second cache and cold-output test took 168.96 seconds on a two-CPU allocation from the 8-vCPU class; every measured compiler phase returned successfully. This promotion preserves job names, file partitions, two-worker pins, serial execution, compiler invocations, and deadlines. GitHub mode and hybrid retries retain hosted routing. Final exact-head CI must verify timing on the larger allocation.

The Blacksmith profile reuses the existing file partitioner for three measured serial outliers: chat/session control-plane tests, the third Gateway core group, and infrastructure storage/state tests. Their complete file inventory, config ownership, worker pins, build prerequisites and complete timing-history floors remain intact. Agent support stays one larger-runner job. On the captured 2026-09-02 inventory, these exceptions add three compact jobs while plugin consolidation removes twenty-two. The resulting broad-PR projection is 103 Node jobs; the last measured run used 121. Source inventory has changed between those observations, so actual CI must establish the final count and wall-time improvement.

GitHub pull-request and push packing checks for a single exchange between two existing bins before opening another anchor job. This avoids stranding time when one bin reaches the ten-group limit. Both replacement bins and the incoming group must pass the original admission rules, including time, prerequisite and sibling-family constraints. Pull-request anchor placement stays independent of hosted tooling inventory; Blacksmith and hybrid plans retain their existing packing.

Ordinary non-Windows CI targets eight minutes; Windows must still pass but sits outside this latency objective. The 210-second expanded packing budget is an estimate, not a job timeout or a measured workflow result. Preflight, checkout/setup, queueing and actual test walls all count.

Dynamic child timings bind to the configs, environment, complete parent file inventory, and ordered child allocation. Human shard names stay readable in logs; wrapper timing spans use the membership key. A parent total can be reconstructed only from every part of one matching allocation, so partial samples from different partitions cannot be combined. Every child retains its file-weighted share of the current parent estimate, and a matching child sample can raise that floor. GitHub admission uses hosted measurements; hybrid admission uses scaled Blacksmith measurements while either profile can require a wider shared split. Failed and timeout-and-retry samples are excluded from refreshes.

Whole-config groups with registered file listers (CLI processes, agent support, gateway methods, runtime config, isolated unit fast) split into file-weighted hosted stripes. CLI file weights use serial file-boundary intervals from successful main runs, so the longest process fixture is separated from the remaining files without overcounting concurrent cases. Agent support and chat also carry relative file weights to separate their slowest owners; support anchors include median case-body sums from three successful main runs. The subprocess-heavy tooling family uses sixteen file-weighted stripes based on 2,412 seconds of observed serial work in run 33364935118. Tooling file weights include import/setup time; a shared runtime prerequisite is charged once to the stripe that owns its consumers. Compact admission charges the strongest prerequisite once per job (100 seconds for runtime, 104 seconds for private QA, with the hosted scaling fallback). Mixed explicit file groups keep their runtime consumers together and stripe the remaining test work separately; the fixed build cost does not create extra stripes for files that need no build. GitHub tooling retains its packing of remaining files into the existing 150-second budget. A single packing pass applies that complete cost and the existing sibling-separation rules; no later rebalance can invalidate an admitted cap. Hosted child splits retain nonempty file partitions and recompute build ownership for each child. Indivisible files may exceed the target and retain their truthful prediction.

If a GitHub pull-request compact plan exceeds the 90-row cap, the planner repartitions hosted tooling tails once before applying the same packing rules. Full-size chunks stay intact; only the final divisible tail is split into parts of at most half the existing 150-second budget, allowing tails from different families to share a job. The splitter regenerates membership-bound timing identities and retains measured floors, build costs, runner requirements, worker pins, and serial isolation. The final 90-row guard still rejects plans that do not fit. Blacksmith and hybrid planning are unchanged.

When agent-support membership changes, its native fallback retains 479 seconds from complete main-run spans of 478.25, 450.21, and 418.13 seconds in runs 33537556582, 33537739443, and 33543106647. The hosted fallback remains 253 seconds. Hybrid keeps that observed native fallback without applying the older whole-suite scale; matching child samples can still raise the file-weighted parent floor. This kept the measured 241-file inventory in four hybrid parts when the old 240-file generation no longer matched. On the Blacksmith profile, the whole support group now requests `blacksmith-16vcpu-ubuntu-2404`; its files, process envelope and resource-derived worker limit stay unchanged.

Compact descriptor counts and predicted maxima vary with the committed measurements; the serial TUI PTY dist descriptor keeps its indivisible measured wall. In `github` mode compact jobs run hosted; hybrid attempt 1 uses each row's 4-vCPU, 8-vCPU, 16-vCPU or 32-vCPU Blacksmith label, while hybrid retries use hosted runners. Every fresh Control UI E2E plan for a target with the named-project contract uses twelve combined weighted shards plus one browser-extension row, across backend profiles, attempts and frozen targets. Eligible Control UI rows request the 16-class; the browser-extension row keeps the 8-class unless admitted to hosted Ubuntu by the bounded hybrid plan. Targets without the named-project contract retain the same combined Control UI command and their historical width: three shards on the Blacksmith planner profile or thirteen on hosted profiles, plus the browser-extension row. Failed-job-only reruns retain their previously emitted UI matrix, including older six-shard plans; rerunning preflight selects the current width. Two/one-worker project limits, the 25-minute timeout, max-parallel 14 and the conservative registration ceiling remain unchanged. QA Smoke uses its existing four-part plan on normal canonical hybrid first attempts, removing two repeated checkouts, dependency setups and private runtime builds. Blacksmith profiles retain four parts; GitHub profiles and freshly planned hybrid retries, manual targets and runs with missing attempt metadata retain six. Failed-job-only retries preserve the original matrix width. Hybrid first attempts use Blacksmith; GitHub mode and hybrid retries use hosted runners. All scenarios, separate channel runs, concurrency limits, stagger and deadlines remain unchanged; native timings must establish the effect on completion time. QA's planner reserves the final part's observed roughly two-minute Matrix rider before greedily assigning primary scenarios, keeping that separate run from becoming the tail. Windows uses the complete two package-script inventories as input to `scripts/lib/ci-windows-test-plan.mts`, which emits up to five disjoint whole-file rows. Current measured inputs need five rows to stay below the 420-second estimate; four predict 489 seconds each; five predict 412 seconds each. Canonical project grouping reduces repeated Vitest starts, and the runtime-consuming files share one preparation row. Each row retains one project process at a time, with the runtime prerequisite prepared before readers start. The Blacksmith 16-class delivers four native CPUs and 14 GiB and uses four Vitest workers; hosted fallback retains one worker. Windows invocations explicitly enable file parallelism for their selected files. The single-file package-contract and fake-timer selections retain their own one-worker budgets. See the [worker-count measurements](https://github.com/openclaw/openclaw/pull/154261) for the prior two-row measurements and source identities. The worker-artifact fixture remains shared within its unsplit file. Historical targets without this planner retain two package-script rows. `max-parallel: 5` permits overlap; actual Blacksmith/hosted capacity and queue time must be measured because the older two-runner capacity observation does not establish five available slots. A hybrid retry retains the emitted inventory on hosted `windows-2025`. Expect slower individual builds on standard 4-core hosted runners. Blacksmith's runner-registration budget is irrelevant for hosted jobs, but GitHub-hosted concurrency limits apply.

The two package-script input inventories keep small projects together: general unit, Gateway, infrastructure, runtime config, media, and CLI selections are in the first inventory; fast unit, plugin SDK, shared core, and agent support selections are in the second. That alignment removed eight repeated project processes from the earlier two-job plan while preserving all 133 explicit targets. The five-row planner consumes their union and regroups execution by canonical project metadata rather than preserving the two input parts as job boundaries. Tooling remains divisible by whole file because its compiler fixtures dominate execution; the extension catch-all retains plugin-owned process boundaries. Windows still proves native path casing and aliases, PATH/shim resolution, spawn and process-tree cleanup, scheduled-task services, SQLite/file-locking and publication behavior, plus shared CLI, package, and runtime-import smoke.

Mac Node coverage uses three disjoint package-script parts on the existing runner labels. The elevation lifecycle suite owns one part; native artifact and packaging proofs own the second; checkout and the remaining platform projects own the third. The aggregate `test:macos:ci` command runs every part, and historical targets without part scripts retain one complete job. Project execution stays serial, tooling stays one file at a time, and the existing CPU-clamped three-case Mac fixture limit and two-case checkout limit are unchanged. Retained native costs place about 152 seconds of test work in the longest part, but setup and runner admission still require native measurement before claiming an eight-minute workflow.

After recovery, restore the value recorded before enabling the circuit breaker. For example, restore a previous `hybrid` setting with:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body hybrid
```

Delete the variable only if it was previously unset; deletion selects the default Blacksmith-first routing:

```bash
gh variable delete OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw
```

`ci.yml` does not probe Blacksmith or mutate this variable. Hybrid fallback is per job and activates only when a coordinator reruns the workflow or selected failed jobs.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
