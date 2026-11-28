# Test planning

- Current fast plugin/channel contract families each share one checkout/setup.
  Their two weighted process envelopes run sequentially with unchanged include
  lists and package commands; channel invocations retain four project slots and
  one worker per project. Any nonzero exit stops admission of the next envelope.
  Frozen targets retain their original separate rows.
- CI matrix caps: fast/check lanes at 12, Node test shards at 130 only for
  same-repository PR first attempts on a non-frozen Blacksmith or hybrid Node plan, and otherwise 96. When selected outside ordinary PRs, Windows stays at 5.
  Hosted plans, RunsOn, retries, main, and all manual/qualification dispatches
  retain 96. This removes a second admission wave for 97–130-row PRs without
  adding jobs or planned vCPU-minutes. Keep the 130/70 final PR/main row caps and 90 native/96 hosted compact
  caps and 5,110-registration arrival envelope; it already counts every PR row
  inside five minutes. Actual provider capacity and the wall need native proof. Native compact profiles have an enforced 90-row budget and hosted profiles 96; plugin
  fallback has a 50-row budget, and the final Node matrix enforces 70 push or
  130 PR rows, including precise plans. Preflight reserves actual appended
  plugin Node rows in compact admission so existing hosted tooling compaction
  can meet that tighter budget; dist rows remain outside the Node budget and
  inside the compact cap. Excess inventory fails preflight.
- When selected outside ordinary PRs, Windows consumes the complete two package-script inventories and balances
  whole files into up to five rows. Current measured inputs need five to keep
  the longest prediction below 420 seconds (four predict 489, five predict 412). Each
  row retains serial projects and shared file fixtures. Self-hosted Windows uses
  four Vitest workers; hosted fallback uses one. Selected files enable file
  parallelism while single-file project budgets remain unchanged.
  Group by canonical project metadata; keep runtime consumers in one preparation
  row. Elapsed file costs include imports/hooks instead of concurrent case sums.
  Frozen targets without the planner retain their original two rows. Native
  runner capacity must be measured; a max-parallel setting is not capacity proof.
  Budget three additional non-Node registrations: the conservative full-tier
  envelope becomes `4 × 153 + 21 × 213 = 5,085`, with 915 below the historical
  6,000 target. Earlier 5,010 calculations below describe the two-row inventory;
  do not spend PR proof savings or raise the final 70/130 Node caps.
- PRs and exact-head PR fallback dispatches omit the Docker published-upgrade
  survivor, while retaining owner-selected Docker lanes. They omit QA smoke,
  real-Gateway UI, named built-process verifiers, and the explicit complete-file
  process-proof inventory. Main/ordinary manual CI retains that proof, including
  Full Release Validation's exact-target normal_ci child. PR unit/boundary and
  mocked-Gateway owners stay selected; no blanket E2E suffix filter is permitted.
- macOS Swift main-tier and PR `release_gate` CI runs complete app tests
  plus lint/schema guards in `tests`, alongside independent OpenClawKit trait,
  OpenClawKit test, and Swabble test graphs in `packages`.
  Ordinary full-scope manual validation adds independent release compilation,
  moves the guards to `release`, and retains health renders in `tests`.
  All phases use Xcode 27 on GitHub-hosted `xcode-27` (preview macOS 27),
  `max-parallel: 2`, and the existing 30-minute budget. The toolchain rollout
  changes no hosted/Blacksmith placement, job counts, coverage, or Swift 6.3
  source-language minimum. Require complete native proof and old/new job timings.
  The existing package split adds one hosted job and no Blacksmith registrations;
  measure complete hosted timing including duplicated setup. Packages do not
  restore or save app build products. Build caches stay phase-owned; the sole eligible shared
  SwiftPM cache writer is regular `tests` or full-validation `release`.
  Debug test/package builds disable indexing and use Swift line-table debug
  information, retaining coverage and source-line backtraces. Test build caches
  use the v7 profile; Release flags and v6 caches remain unchanged. Local debug
  builds retain full debugger metadata.
- Android regular CI uses four test/lint rows, including benchmark compilation
  in the Kotlin-lint row when benchmark/build/dependency inputs change or the
  changed-path manifest is unusable. The matrix admits up to four jobs
  concurrently regardless of runner backend, trigger, or attempt. Frozen task
  contracts and npm native deferral are unchanged.
- iOS admitted main pushes and PR `release_gate` CI run one required Debug build
  and Swift lint smoke; hourly main-tier CI retains the tests phase. Ordinary
  PRs defer both. Ordinary full-scope manual validation retains Release
  and Debug/native-test phases, both screenshot shards, and the evidence reducer.
  Frozen full-manual targets keep their Debug-only contract without screenshots;
  npm qualification still defers native jobs. All iOS build phases and screenshot
  shards use Xcode 27 on GitHub-hosted `xcode-27` from the first attempt.
  All four Periphery scans use the same toolchain and retain the checksum-pinned
  3.8.0 release pending native compatibility proof for both app scans and both
  shared consumers. Preserve zero findings and exact-USR intersection; selecting
  the new runner is not compatibility proof.
  The conservative full-tier non-Node inventory, including Control UI performance, is
  87 rows, or 88 for historical UI targets. Excluding those four hosted rows
  plus all three macOS Swift phases and the always-hosted aggregate gate leaves at
  most 80 potentially eligible jobs. The enforced Node caps therefore give
  150 registrations per main run and 210 per PR:
  `4 × 150 + 21 × 210 = 5,010` in the retained peak arrival envelope.
  The old 19-arrival estimate is obsolete. The remaining 990 below
  the 6,000 reference target must cover adjacent repositories, releases and
  carryover; the bounded 2026-09-02 census did not prove that upper bound.
  Treat a single PR concurrency trial separately from a global rollout.
  A shared-token quota response does not establish organization-wide usage.
  Budget all six npm qualification jobs and the actual full-release children;
  ordinary manual check rows can still use Blacksmith outside hybrid mode.
- Canonical PR Node tests use one precise changed-target job when possible;
  broad, deleted or unknown changes fall back to the compact full-suite plan
  plus affected plugin coverage. Current PR planner errors fail preflight.
  Targeted plans retain the full built-artifact
  boundary gate. `main` uses compact integration; manual and release runs use
  full named shards.
- `RELEASE_ONLY_TOOLING_SHARDS` in the Node planner owns the complete
  `core-tooling` family: ordinary tooling stripes plus the isolated/Docker
  catalogs. Matching non-E2E/non-live maintainer leaves in mixed fast configs
  join the same tier. Preserve their ordinary, isolated or fake-timer config,
  process pins and product neighbors; reduced groups need subset timing identities.
  The five `test/scripts/*.e2e.test.ts` product integration gates stay outside
  this tier. Product-only canonical PRs omit the family in precise and compact
  fallback plans. Tooling tests or owners select the full family: `scripts/**`,
  `src/scripts/**`, `test/**`, `.github/**`, `config/**`, root package/pnpm inputs,
  tooling configs, and other tooling facts owned by
  `scripts/test-projects.test-support.mts`, including Docker, agent/Crabbox,
  app script/Fastlane and extension script/package inputs. Directly changed
  tooling tests therefore retain PR coverage. Keep each config's complete
  inventory, exclusions, process metadata, timing floors and runner policy.
  Every CI manual dispatch includes the family; Full Release Validation's
  frozen-candidate `normal_ci` child executes it before regular publication
  admission. An independent duplicate release test is not required: these same
  tests supply that proof. Fork repositories retain full tooling because they
  do not use canonical targeting. Main already omitted named tooling shards;
  it now also omits maintainer leaves formerly retained by fast configs,
  including on tooling-owner changes. A regression introduced by a later main
  merge is invisible to main CI until an affected PR or full validation runs it. Existing
  `ci-gate` aggregates selected jobs, without requiring tooling proof against a
  later main revision. Report historical file-seconds, emitted rows, runner-class
  counts and predicted longest jobs separately; fewer test-seconds do not prove
  a workflow wall-time saving.
  CI's plugin flag stays false even on dispatch because Plugin Prerelease owns
  that separate sweep. Plugin-sensitive PR changes override that exclusion in
  both precise and fallback plans, including bundled metadata coverage. Do not infer release inclusion from a shard name or
  conflate regular full-campaign publication with approved preflight-only beta
  exceptions. Product security, migration, storage, protocol, SDK and
  update-correctness tests are outside this move.
- The combined Node matrix admits compact and plugin descriptors by estimated
  duration within the same cap. Catch-all, QA and provider configs use the
  existing 90-file envelope budget with native Vitest sharding; retain complete
  config discovery, exclusions and process isolation. Count every appended
  plugin row, including the five added QA/provider rows, in the burst envelope.
- Precise and fallback plugin groups retain separate child processes, including process-bounded
  configs. Compatible envelopes, including repeated configs, run one at a time
  within 300 predicted seconds without a pair-count limit; expanded serial compact
  jobs use 210. Envelopes with identical preparation mode, runner and dist
  requirements share one build before their separate sequential processes;
  packing charges that preparation once. Different preparation modes stay
  separate. Each job retains the 20-file database-worker ceiling and 300-second
  estimated budget; observed hosted durations must be reported separately.
  The earlier 124-envelope inventory projected 50 extension rows and
  125/119/130 PR Node rows on Blacksmith/hybrid/GitHub, with 57/46/55 push Node
  rows and 77/71/82 compact PR rows. Those are historical inventory projections;
  validate the current inventory against the unchanged 50/130/70/90
  extension/PR/push/compact caps. Each original envelope retains
  its file/process bounds, native shard arguments and worker limits. The complete supplemental boundary list runs in one job
  with four concurrent checks and one full-root focused-rule scan.
- Measured Blacksmith chat/session, Gateway core-3 and infrastructure storage/state
  outliers reuse the existing file splitter. Preserve serial execution, worker
  pins and complete timing-history floors; no blanket increase in sharding.
- Eligible main/release Docker seed jobs request `blacksmith-16vcpu-ubuntu-2404`;
  ordinary manual dispatch retains hosted routing. The weighted
  scheduler and serial declaration compiler policy stay unchanged.
  Hourly main-tier CI and admitted main pushes select the published-upgrade
  survivor independently of changed paths. Main pushes require
  `OPENCLAW_CI_ON_PUSH=true` to admit full CI. Ordinary manual and full release
  validation select all five lanes when supported by the target, retaining
  `legacy-operator-state` with `auto-auth`. Full Release Validation reaches this
  proof through `normal_ci`; expanded Package Acceptance scenarios alone do not
  replace its restart mode. PRs and exact-head PR fallbacks select the four
  non-survivor lanes through `resolveChangedDockerSeedLanes`' exact owner map.
- `run_control_ui_performance` selects production UI, plugin browser, workspace
  package, dependency/build/policy inputs and their relative import graph,
  including tooling. Workspace package aliases require conservative package
  ownership. Test-only files and unrelated runtime changes omit this lane;
  manual runs, unknown paths and older planners retain coverage. Preserve the
  target's existing performance-script capability checks.
- Partial PR UI unit selections target three files per job within the existing
  three-row cap and three-worker limit. Full UI owners and manual validation
  retain their established shards, runtime policy and first-row WebKit checks.
- Eligible Control UI E2E rows request the 16-vCPU class with unchanged live
  backend/event routing. Compact plans use nine mocked Control UI shards with four
  workers each, matching four observed CPUs per runner and fitting the 20-minute
  test step on slow hosted CPUs. Private source-server projects remain serial. The conditional
  browser-extension row keeps its existing reuse and routing rules. Hourly main
  uses the same compact plan without a changed-path inventory. Non-main full
  manual, noncanonical, compatibility, and other unknown-path inventories retain twelve Control UI
  shards plus one browser-extension row. Historical targets without the named-project contract retain four total rows on
  Blacksmith or fourteen on GitHub/hybrid. Failed-job-only retries retain their
  previously emitted matrix, including older six-shard Control UI plans; PR and
  hybrid push retries use hosted Ubuntu. The 25-minute timeout, max-parallel 14
  and conservative registration ceiling stay unchanged. The browser-extension row
  stays on 8 unless the bounded hybrid plan admits it to hosted Ubuntu. The twelve-row 4:38 result in historical run 33695337496 used the
  32-class with eight reported CPUs; it does not prove timing on the current
  16-class route or refresh stale timing weights.
- Current-target real-Gateway jobs use the 16-class and existing two-row planner
  split; frozen or unclassified targets retain the 32-class. Ordinary PRs omit
  them. Private preparation builds runtime, QA, and Control UI artifacts with
  SDK declaration generation disabled; `build-artifacts` owns SDK declarations
  and validation. Preserve browser workers, complete inventory, build-before-test
  ordering, routing, deadlines, and caps. Further sizing changes require complete
  job qualification, including preparation and desktop transport proof.
- Normal canonical hybrid first attempts use the existing four-part QA smoke
  plan, removing two repeated checkouts, setups and private runtime builds.
  Canonical `main` push/schedule first attempts on that plan use the 8-class
  only with explicit non-frozen, non-compatibility classification. A cold private
  runtime build and all 24 scenarios passed on two usable CPUs under a 7-GiB
  no-swap cap (5.96-GiB peak, no OOMs). This does not qualify older backport
  source: those targets may build with higher compiler concurrency. Other
  contexts retain the shared 16-class/hosted/release-group routing.
  Blacksmith profiles retain four parts; GitHub profiles and fresh hybrid
  retry/manual plans retain six. Failed-job-only retries retain their original
  matrix. Keep the complete scenario inventory, separate Matrix run, worker
  limits, stagger, cleanup and deadlines. Measure the four-part jobs natively;
  summed build intervals are not a wall-time saving estimate.
  Main selection uses the existing QA/channel/packaging/orchestration
  owners. Manual and Full Release Validation retain the full profile; unknown
  paths or older selectors retain supported coverage. Integration detection
  outside these owners now waits for manual/release validation. The burden
  analysis projects about 1,526 Blacksmith vCPU-minutes/hour saved across Docker
  and QA; zero failures in 20 Docker and 80 QA main jobs is limited evidence,
  not a measured post-change saving. Keep backend settings, caps, budgets and
  timeouts unchanged, and verify actual emitted rows and timings.
