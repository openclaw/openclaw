---
name: openclaw-ci-limits
description: Manage OpenClaw GitHub Actions and Blacksmith CI capacity, runner-registration budgets, fanout caps, main-push single-flight, shard sizing, hosted-runner offload, queue health, and safe ramp-down/ramp-up changes. Use when tuning `.github/workflows/*`, `docs/ci.md`, CI runner labels, matrix `max-parallel`, ClawSweeper/Blacksmith burst protection, CodeQL runner placement, or investigating slow/queued OpenClaw CI.
---

# OpenClaw CI Limits

Use this skill for CI capacity changes, not ordinary test failure triage. The
goal is to keep OpenClaw fast while distinguishing runner registration, runner
availability, Blacksmith control-plane health, and downstream queue drains.

## Core Facts

- Do not assume the scarce resource. Prove whether pressure is runner
  registrations, eligible runner availability, Blacksmith capacity/control
  plane, workflow dependencies, test runtime, or a downstream queue writer.
- GitHub runner registrations for `openclaw` currently report a 10,000 per
  5-minute bucket in `actions_runner_registration`. Verify the live bucket
  before each tuning pass because GitHub can change it. The `openclaw`
  organization shares one bucket.
- Core REST quota does not draw down this bucket. Check
  `actions_runner_registration` separately; core quota can be healthy while
  runner registration is throttled.
- Use about 60% of the live bucket as the operating target. With the current
  10,000-registration bucket, keep planned Blacksmith burst load under 6,000
  registrations per 5 minutes and leave the rest for other repos, retries, and
  burst overlap.
- Jobs that route, notify, summarize, choose shards, or run short CodeQL quality
  scans should stay on GitHub-hosted runners unless measured evidence says
  Blacksmith is required.

## Rejected Experiments

- **Boundary asynchronous input preparation (2026-09-26):** Adding the existing
  `CompilerInputSnapshot.prepare()` calls at the three declaration/boundary
  callers increased full cold validation from 464.21s to 544.68s on the same
  four-CPU/15.42-GiB Testbox; warm validation increased from 12.62s to 14.63s.
  All 125 plugin checks and the canary passed, but CPU use also increased.
  The six caller additions were removed. Do not repeat this as an assumed
  speedup; any different use needs measured end-to-end benefit.
- **Windows pnpm store (2026-09-20):** Original receipts from
  [run 35547255790](https://github.com/openclaw/openclaw/actions/runs/35547255790)
  measured median complete setup at 45.295s cold versus 52.738s restored
  (+16.4%), despite reusing all 1,453 packages with zero downloads. The
  763.8-MiB archive took 23.601–26.980s to restore; producer setup/save added
  62.527s. All seven native jobs passed, but the qualification reducer failed
  on a 24-KiB reported-RAM difference. No assertions were relaxed or jobs
  rerun. The exactly RAM-matched subset was still 11.3% slower; that is
  descriptive evidence, not a replacement passing qualification. Keep normal
  Windows setup uncached. Reconsider only with net complete-setup savings,
  including restore, extraction, frozen reconciliation, and producer work.
- **Hosted Mac exact dependencies (2026-09-01):** The same-head publisher and
  consumer in [run 33458856298](https://github.com/openclaw/openclaw/actions/runs/33458856298)
  successfully saved and restored a 1.66-GB dependency archive, but setup took
  142s versus 86s with the ordinary store cache. Extraction took 82s versus 27s;
  install improved only from 43s to 35s. Keep hosted Mac jobs on the ordinary
  store cache. Reconsider only with measured total setup savings, including
  transfer, extraction and frozen reconciliation, not a successful cache hit.
- **Actions-artifact checkout (2026-08-16):** Do not recommend replacing the
  shared Blacksmith Git fetch with a preflight-produced workspace or `.git`
  artifact. [PR #124818](https://github.com/openclaw/openclaw/pull/124818)
  measured a 16s Blacksmith checkout baseline versus 7s hosted. The best direct
  artifact variant cost 1s to pack, 3s to upload, and 11s median to restore;
  including the serial prefix left only about 1s median improvement and
  regressed Blacksmith's fast-fetch runs. The official artifact client was
  worse: [run 31971531521](https://github.com/openclaw/openclaw/actions/runs/31971531521)
  measured 22s median download plus 2s materialization. Blacksmith's fast
  Actions-cache path does not imply fast Actions-artifact downloads. Reconsider
  only with measured end-to-end proof for a different transport, including its
  producer cost and fast-fetch regressions.

## First Checks

Before changing CI, collect current pressure:

```bash
gh api rate_limit --jq '{core:.resources.core,graphql:.resources.graphql,search:.resources.search,actions_runner_registration:.resources.actions_runner_registration}'
gh run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
gh run list -R openclaw/clawsweeper --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
gh api repos/openclaw/clawsweeper/actions/runs/<run-id>/jobs --paginate --jq '.jobs[] | {id,name,status,conclusion,labels,created_at,started_at,completed_at,runner_name,runner_group_name}'
blacksmith testbox list --all
curl -fsS https://clawsweeper.openclaw.ai/api/status | jq '{generated_at,fleet,diagnostics:{errors:.diagnostics.errors}}'
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '{generated_at,review:.lanes.review,publication:.lanes.publication,state_writer,state_append}'
node scripts/ci-run-timings.mjs --latest-main
node scripts/ci-run-timings.mjs --recent 10
```

For a suspicious queued run, inspect its jobs. A run-level `queued` status does
not reveal whether the job is waiting on dependencies or has no eligible
runner. Compare `created_at`, `started_at`, `labels`, and `runner_name`. Recheck
stale queued runs live before canceling them; cancel only runs proven obsolete.

`scripts/ci-run-timings.mjs` start delay can include workflow dependency wait
plus runner queue time. It is trend evidence, not runner-pressure proof alone.

Read:

- `.github/workflows/ci.yml`
- `.github/workflows/codeql-critical-quality.yml`
- `docs/ci.md`
- `test/scripts/ci-workflow-guards.test.ts`
- `test/scripts/ci-workflow-planning.test.ts`
- `test/scripts/ci-workflow-evidence.test.ts`
- touched planner files under `scripts/lib/*ci*`, `scripts/lib/*test-plan*`, or
  `scripts/ci-changed-scope.mjs`

## Diagnose The Bottleneck

Classify the issue before changing caps:

- **Runner-registration throttle:** many jobs queued before runner assignment,
  Blacksmith/GitHub reports 403/429 or spam-style 422 responses from
  `generate-jitconfig`, and API core quota is still healthy. Treat 422 as this
  signal only when the request payload is otherwise valid. Fix burstiness and
  Blacksmith job count.
- **Blacksmith capacity:** Blacksmith dashboard shows actual concurrency caps or
  unavailable capacity. Do not solve this with GitHub workflow fanout alone.
- **Blacksmith Testbox control plane:** list, warm, status, or run calls time out
  before a lease is returned. This is separate from Actions runner registration
  and Actions job capacity. Trusted source may use the documented local
  fallback; untrusted source stays blocked.
- **Unavailable runner label:** a job is queued with a custom `runs-on` label,
  `started_at` and `runner_name` remain empty, and no eligible runner exists.
  Restore an available hosted or registered label; fanout cannot fix it.
- **Workflow dependency wait:** the job is queued but required predecessors are
  not terminal. Fix or wait for the dependency; do not call the whole delay
  runner queue pressure.
- **OpenClaw test runtime:** jobs start quickly but one lane dominates wall time.
  Use `$openclaw-test-performance` instead of runner tuning.
- **Real failing CI:** one job fails after starting. Use `$github:gh-fix-ci` or
  `$openclaw-testing`, not this skill.
- **ClawSweeper review backlog:** review pending/ready grows while publication
  and state writers remain healthy. Tune review admission/workers in
  `openclaw/clawsweeper`.
- **ClawSweeper publication backlog:** publication pending/ready and oldest age
  grow, net drain is zero or negative, or dead letters rise. Inspect publication
  batches, state-writer coordination, and GitHub mutation latency first.
- **State materializer/append backlog:** `state_append.pending_rows`,
  `pending_bytes`, or oldest age grows while the materializer is queued or
  absent. Recover that sole drain first; more review workers make it worse.

## Registration Budget Math

Estimate worst-case registrations for a change before editing:

```text
new Blacksmith registrations ~= number of Blacksmith jobs that can become queued
inside one 5 minute window
```

For matrix jobs, count every row that can start in the 5-minute window.
`strategy.max-parallel` only caps simultaneous rows; short rows can turn over
and register more runners before the window resets. Use job duration, retries,
and queue turnover to justify any lower estimate. Add non-matrix Blacksmith jobs
such as `preflight`, `security-fast`, `build-artifacts`, and platform lanes.

For repeated pull-request pushes, multiply by the number of runs expected to
reach Blacksmith admission in the same 5-minute window, including runs canceled
after admission. Canonical `main` uses two run-number-parity slots. Each slot
keeps one active non-canceling run and one coalesced pending tip. Budget for up
to two active main matrices plus their two pending tips entering the next
admission wave, not every intermediate merge.

Reject a change unless the org-level worst case stays below about 60% of the
live bucket. With the current 10,000-registration bucket, keep planned
Blacksmith burst load under 6,000 registrations per 5 minutes with headroom for
ClawSweeper, ClawHub, Clownfish, OpenClaw RTT, and Clawbench.

The compact cap is 90 rows; final Node caps are 70 push and 130 PR rows.
The current automatic main/PR source has a conservative union of 71 potentially
self-hosted non-Node rows, including five core-lint stripes for trusted forks,
five type stripes, five Windows rows, and thirteen UI E2E rows. Retain an 84-row
allowance with thirteen rows reserved: `4 × 154 + 21 × 214 = 5,110` for the
four-main/21-PR arrival envelope, leaving 890 below the 6,000 reference target.
The six extension-lint rows remain hosted. Manual/frozen releases and other
workflows are outside this envelope. This is conditional planning, not live
organization-wide capacity proof; older 5,010/5,085/5,160 examples below describe
historical inventories and do not replace this source-audited reserve.

## Safe Levers

Prefer these in order:

1. Preserve cancel-in-progress for superseded pull-request heads.
2. Preserve canonical `main` as two non-canceling parity slots; each slot's
   default pending run coalesces to the newest tip.
3. Move high-frequency, short, non-build jobs to `ubuntu-24.04`.
4. Reduce matrix rows by bundling related tests inside one runner job when the
   combined job stays under timeout and keeps useful failure names.
5. Lower `strategy.max-parallel` for bursty Blacksmith matrices.
6. Right-size runners from timing evidence. Use fewer/larger jobs only when
   elapsed time improves enough to justify registration count.
7. Split truly slow tests with `$openclaw-test-performance`; do not hide a slow
   test problem by registering more runners.

Do not:

- add another Blacksmith installation expecting a higher registration bucket;
- move CodeQL Critical Quality back to Blacksmith;
- raise all `max-parallel` values at once;
- make manual `workflow_dispatch` runs cancel normal push/PR validation;
- delete coverage just to reduce runner count;
- treat cancelled superseded pull-request runs as failures without checking the
  newest run for the same ref.
- cancel old queued runs from a stale snapshot; re-query the exact run first and
  preserve any current run that still owns live work.

## Current OpenClaw Knobs

These are intentionally guarded by the `ci-workflow-guards`,
`ci-workflow-planning`, and `ci-workflow-evidence` tests under `test/scripts/`:

- `CI` concurrency key version, PR cancellation, and canonical `main`'s two
  non-canceling parity slots, each with one coalesced pending tip.
- `preflight` starts immediately without a debounce or standalone admission job.
  `security-fast` waits for its hosted budget decision and still runs after
  preflight failure unless the workflow was canceled. The protected `vitest-cache-warm` workflow
  publishes the immutable semantic dependency archive after setup succeeds,
  in an independent short job. Dependency and code publishers serialize per
  backend/platform/ref without a workflow-wide lock or cross-platform dependency.
  Hybrid adds a bounded hosted tooling/contract/UI seed and native SDK archive,
  without repeating the full Linux build. Docs-only pushes skip warming. The split
  adds one Blacksmith registration per eligible warmer admission, not per CI job;
  include short-publisher turnover in burst estimates. Preflight and downstream Node jobs are
  restore-only consumers on eligible self-hosted runners. Exact misses and
  hosted paths, including Mac Node jobs, use the ordinary pnpm-store cache.
- Trusted canonical hybrid first attempts route `ci-gate` to the Blacksmith
  4-class and the packed core-lint rows to the 16/8-classes after hosted assignment
  added 416 seconds to main's critical chain. Admitted qualifications use the
  same route. The first packed lint row took 621s on the 8-class; retain four
  actual CPUs for that row. The gate has no checkout or dependency setup; retries, ordinary
  manual dispatches, untrusted contexts, and the GitHub override stay hosted.
  Core lint additionally retains hosted routing for frozen targets. Normal hybrid
  main/same-repository PRs add three assignments; trusted fork PRs can add six
  because their logical GitHub profile emits five lint rows. These fit the fresh
  71-row union and reserved 84-row non-Node allowance described above.
  Trusted automatic hybrid first-attempt `preflight` requests the existing
  16-class after hosted assignment stalled across three nearby runs while
  Blacksmith security jobs succeeded. Its logical planner profile, cache trust,
  and 20-minute deadline stay unchanged. Default Blacksmith preflight keeps the
  4-class; hybrid retries, manual dispatches, untrusted/noncanonical contexts,
  and the `github` override retain hosted routing. `security-fast` stays hosted
  outside eligible hybrid first attempts and when the bounded hosted plan is admitted. Security hooks use pinned installed packages
  and local hook definitions, without remote Git initialization. The `github`
  outage override remains intact. Budget three control-job registrations per eligible
  hybrid first attempt when optional hosted admission is closed, two when admitted,
  and one per normal Blacksmith run. All occur in the reserved non-Node inventory.
  Selected PR baseline ratchets run inside preflight on its existing runner,
  sharing one command body with the standalone adapter for other events.
  Use the actual workflow event, not a release-gate's normalized PR scope.
  Preserve exact merge-parent/base validation, every ratchet, cache trust,
  and explicit step-outcome admission in Node and the final gate. Required
  missing/skipped outcomes fail; job-count and hosted-budget inventories exclude
  the removed PR job. Self-hosted ratchets also remove one registration; other lanes wait for
  preflight's added setup/check time. Run 36263945802 projects 205s earlier Node
  admission, 46s later sibling admission, and +6.8 class-vCPU-minutes; native
  proof must establish the combined wall and cost. Non-PR ratchets retain their
  existing runner, deadline, and release-gate merge-tree preparation.
  The existing `check-plan` prerequisite keeps the 4-class on trusted same-repository
  hybrid PR first attempts, automatic main runs, and admitted qualification dispatches. Its 165–209s hosted wall delayed narrowed type/lint consumers; use
  the unchanged 209s as a conservative 13.93-vCPU-minute added-cost bound until
  native proof measures it. This consumes one non-Node reserve slot and adds no
  jobs. Exact dependency restoration still requires an actual self-hosted runner
  and same-repository cache trust. Admitted qualification dispatches retain the
  automatic first attempt's Blacksmith routes. Keep compiler inventory
  completeness and the observer's exact count.
  This measured control-job offload is hybrid-only; RunsOn keeps its existing
  hosted standalone ratchet and check-plan routes, including qualification dispatches.
  Trusted fork PRs retain hosted hybrid check planning; their ratchets use the
  preflight runner and preserve the existing cache trust restrictions.
  Optional compiler/check offloads reject observed hosted assignment waits at
  sixty seconds; the former three-minute cutoff exceeded the latency objective.
  API and job deadlines remain unchanged.
  The aggregate preserves failure-triggered PR cancellation through the
  `pr-fail-fast` cause outputs; superseded runs without a failure cause still
  skip the aggregate. PR Node matrices use native fail-fast. The same-repository
  PR first-attempt monitor alone has `actions: write` and adds one 4-class registration per
  eligible PR, or uses hosted Ubuntu under the outage override. Main/manual
  matrices remain complete. The monitor starts after preflight, observes failures
  while the installed check planner waits, and uses the planner's successful
  versioned count step for exact completion rather than its early reservations.
  Existing critical-path routing serves hybrid failures; only the uncovered
  default/explicit-Blacksmith failure case adds the same 4-class route. Retries,
  ordinary manual dispatches and the GitHub override retain hosted aggregation.
  The monitor consumes one existing non-Node reserve slot: the 71-row union
  leaves thirteen inside the unchanged 84-row allowance and 5,110 bound.

- Automatic canonical hybrid first attempts count every selected hosted row in
  preflight. `HYBRID_HOSTED_BASE_ROW_LIMIT = 40` admits at most five optional
  rows within `HYBRID_HOSTED_ROW_LIMIT = 45`: security, three Control UI unit
  rows, and only browser-extension E2E. Above 40 base rows, retain their
  Blacksmith routes; an eligible base above 45 warns with counts and retains
  the complete base manifest. The budget limits optional admission, not coverage.
  Record base/total rows and compare the actual workflow expansion in guards.
  This never expands test coverage or workers; Control UI E2E shards, QA,
  real-Gateway, Android, and compiler-heavy jobs retain their existing routes.
  Frozen/manual targets, retries, untrusted authors and fully hosted fallback
  manifests remain outside this first-attempt limit, including existing >45-row
  fallbacks. Do not change the backend variable or existing caps to enable it.
- The existing extension-package-boundary matrix row requests the 32-class
  whenever its existing route selects Blacksmith. Its two-CPU compiler reserve
  admits four children on the observed eight-CPU/30.95-GiB allocation, versus
  two on the previous 16-class. Run 36248684656 measured a 569s complete job
  on the 16-class; unchanged duration on the 32-class would add 151.7
  class-vCPU-minutes (1.17% of that broad run). Include that allowance with
  Node packing costs until native proof measures the new duration. No jobs,
  registrations, permissions, compiler checks, or hosted eligibility are added.
- Current fast plugin/channel contract families each share one checkout/setup.
  Their two weighted process envelopes run sequentially with unchanged include
  lists and package commands; channel invocations retain four project slots and
  one worker per project. Any nonzero exit stops admission of the next envelope.
  Frozen targets retain their original separate rows.
- CI matrix caps: fast/check lanes at 12, Node test shards at 130 only for
  trusted same-repository PR first attempts on a non-frozen Blacksmith or hybrid plan, and otherwise 96; Windows stays at 5 and Android at 2.
  Hosted plans, RunsOn, forks, retries, main, and all manual/qualification dispatches
  retain 96. This removes a second admission wave for 97–130-row PRs without
  adding jobs or planned vCPU-minutes. Keep the 130/70/90 PR/main/compact row
  caps and 5,110-registration arrival envelope; it already counts every PR row
  inside five minutes. Actual provider capacity and the wall need native proof. Every compact profile has an enforced 90-row budget, plugin
  fallback has a 50-row budget, and the final Node matrix enforces 70 push or
  130 PR rows, including precise plans. Preflight reserves actual appended
  plugin Node rows in compact admission so existing hosted tooling compaction
  can meet that tighter budget; dist rows remain outside the Node budget and
  inside the compact cap. Excess inventory fails preflight.
- Windows consumes the complete two package-script inventories and balances
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
  do not spend PR proof savings or raise the 90/70/130 Node caps.
- PRs and exact-head PR fallback dispatches omit Docker seed, QA smoke,
  real-Gateway UI, named built-process verifiers, and the explicit complete-file
  process-proof inventory. Main/ordinary manual CI retains that proof, including
  Full Release Validation's exact-target normal_ci child. PR unit/boundary and
  mocked-Gateway owners stay selected; no blanket E2E suffix filter is permitted.
- macOS Swift regular PR/main and PR `release_gate` CI runs complete app tests
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
  changed-path manifest is unusable. Full manual validation retains all six
  rows and memory-bounded phone/Wear/benchmark builds without duplicate lint.
  The cap stays at two; frozen task contracts and npm native deferral are unchanged.
- iOS regular PR/main and PR `release_gate` CI runs one required Debug build
  and Swift lint smoke. Ordinary full-scope manual validation retains Release
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
  jobs use 210. The rebased 124-envelope inventory emits 50 extension rows and
  125/119/130 PR Node rows on Blacksmith/hybrid/GitHub; push Node rows are
  57/46/55 and compact PR rows are 77/71/82. These fit the landed 130/70/90
  PR/push/compact caps without another increase. Runtime preparation stays separate. Each original envelope retains
  its file/process bounds, native shard arguments and worker limits. The complete supplemental boundary list runs in one job
  with four concurrent checks and one full-root focused-rule scan.
- Measured Blacksmith chat/session, Gateway core-3 and infrastructure storage/state
  outliers reuse the existing file splitter. Preserve serial execution, worker
  pins and complete timing-history floors; no blanket increase in sharding.
- Blacksmith and hybrid compact bins with multiple ordinary groups request the
  existing 32-vCPU class and two child slots with a 360s aggregate budget.
  Gateway-exclusive serial bins and numbered tooling bins use a 300s test
  budget. Ordinary self-hosted bins share promoted capacity across logical
  classes; the existing group exchange fills stranded slots without raising caps.
  Matrix predictions use the ordered two-slot test wall, while admission keeps
  aggregate work and separately charges the measured 60s runtime preparation.
  Compatible two-slot bins use the time budget without the ten-group cutoff;
  serial bins retain that cutoff. Blacksmith serial bins retain 200/276s, hybrid serial bins retain 210s,
  exclusive bins retain 150s by default, and groups above their serial cap stay alone.
  Complete ordinary hybrid bins containing only non-build CLI groups may use
  250s and co-locate split siblings, provided each original child still fits
  150s. Keep file splits, workers, process isolation and other profiles unchanged.
  Initial packing separates runtime consumers from ordinary groups. Complete
  hybrid main and PR runtime-placement observations apply only after file splitting;
  precise changed-file templates retain their original capacity and floors.
  Typed observations preserve configs, environment, complete files and build mode.
  Prefer an exact measurement; otherwise use the maximum compatible contained
  workload as an advisory floor, never sum overlaps or treat globs as whole files.
  Whole pinned runtime groups may move to existing compatible ordinary jobs under
  a 360s budget including the 60s build reserve. Keep runner anchors,
  test partitions, invocation counts and worker limits. An ordinary recipient
  becomes serial, explicitly retaining its old parallel groups' two-worker budget
  while preserving their prepared timing identities and complete parent
  generations. The CI executor applies the smaller of the
  supplied job ceiling and group cap. This may add one runtime preparation while
  reducing requested process slots; measure the tradeoff without adding jobs or
  registrations. Equal maximum estimates prefer more recipient headroom.
  Reapply shared family, group-count and budget admission to both replacements;
  never suppress coverage or count a runtime subset as a complete parent.
  An unfit optimization retains the runnable plan and its truthful estimate.
  Compare recipients with the donor job's fixed anchor, not only its group class.
  Exclusive, private-QA, dist and hosted policies stay unchanged.
  Affordable generated CLI runtime children may share one preparation in an
  exclusive serial bin within the same 150s budget; fixed stripe families remain
  separate. Other hybrid exclusive/dist sharing is unchanged. Complete inventories
  remain intact.
  The canonical shard executor admits two CI children only with at least eight
  available CPUs and 24 GiB actual memory; otherwise it admits one. Inner project
  parallelism stays one and each overlapping child keeps two Vitest workers.
  Gateway methods use four workers in serial, non-frozen self-hosted jobs with
  at least eight actual CPUs and 28 GiB memory, with the existing two-worker
  fallback elsewhere. Keep its worker-specific timing identity and require
  three original-shard replays plus sampled memory evidence when changing it.
  The measured Gateway server-isolated/database-worker family uses at most eight
  workers only in a serial, non-frozen self-hosted job with at least eight actual
  CPUs and 28 GiB memory. Its 20.70 GiB observed aggregate RSS leaves the existing
  25% reserve at that floor. Preserve its two-worker fallback, other groups' pins,
  hosted planning, complete inventory, and old timing generations until refit.
  The primary GitHub profile remains serial at 210s. Failed-job-only hybrid
  retries retain the original wider matrix on hosted Ubuntu, clamp to one child,
  and keep two workers per child; they can exceed the eight-minute normal-run
  objective without changing existing deadlines. Fewer jobs must retain native
  elapsed-time, actual memory and cleanup proof; requested labels are not capacity.
- The whole Blacksmith agent-support group requests `blacksmith-32vcpu-ubuntu-2404`.
  Its file inventory and resource-derived worker policy remain unchanged.
- Numbered Blacksmith tooling bins request the same 32-vCPU class after packing.
  Keep their logical classes, names, file inventories, serial project execution
  and two-worker pins. Tooling files use the shared worker scheduler; price their
  current file costs by effective workers without dividing the longest file.
  Docker helper fixtures retain their separate serial config. This does not
  promote hosted or hybrid tooling; capacity alone is not a measured speedup.
- Numbered tooling measurements in `toolingFileSeconds` drive file packing with
  native profile costs; a hosted fallback scales measured Blacksmith costs.
  The daily refit samples the newest five contributing successful PR CI runs.
  Those measurements describe the PR merge-ref and update exact compact and tooling identities;
  main compact and release sampling retain their existing provenance. Preserve
  independent-run medians, runner profiles and partial-plan history. An explicit
  `--tooling-run <id>` seed records its source and may use one successful run.
  Verbose-only case sums are conservative packing costs when cases overlap,
  not measured file walls. Do not discount them to make row caps pass.
- The Docker seed job requests `blacksmith-16vcpu-ubuntu-2404`; its weighted
  scheduler and serial declaration compiler policy stay unchanged.
  Canonical `main` uses `resolveChangedDockerSeedLanes` owner-path
  selection; unknown paths retain the published survivor. Canonical manual CI
  selects survivor when the target declares the Docker seed capability, retaining
  `legacy-operator-state` with `auto-auth`. Full Release Validation reaches this
  exact proof through `normal_ci`; expanded Package Acceptance scenarios alone
  do not replace its restart mode.
  PRs and exact-head PR fallbacks do not run Docker seed. Main selection uses
  only the triggering push's diff, without accumulating coalesced/cancelled
  pushes. A skipped proof waits for a later non-cancelled main run that selects
  its lane or applicable manual/release validation; the next main run alone
  does not guarantee coverage. Ordinary manual CI and `normal_ci` select the
  published-upgrade survivor independently of changed paths.
- `run_control_ui_performance` selects production UI, plugin browser, workspace
  package, dependency/build/policy inputs and their relative import graph,
  including tooling. Workspace package aliases require conservative package
  ownership. Test-only files and unrelated runtime changes omit this lane;
  manual runs, unknown paths and older planners retain coverage. Preserve the
  target's existing performance-script capability checks.
- Eligible Control UI E2E rows request the 16-vCPU class with unchanged live
  backend/event/contributor routing and two/one-worker project limits. Every fresh
  plan for a target with the named-project contract uses twelve Control UI shards
  plus one browser-extension row, across backend profiles, attempts and frozen
  targets. Historical targets without that contract retain four total rows on
  Blacksmith or fourteen on GitHub/hybrid. Failed-job-only retries retain their
  previously emitted matrix, including older six-shard Control UI plans; PR and
  hybrid push retries use hosted Ubuntu. The 25-minute timeout, max-parallel 14
  and conservative registration ceiling stay unchanged. The browser-extension row
  stays on 8 unless the bounded hybrid plan admits it to hosted Ubuntu. The twelve-row 4:38 result in historical run 33695337496 used the
  32-class with eight reported CPUs; it does not prove timing on the current
  16-class route or refresh stale timing weights.
- Eligible real-Gateway jobs request the existing 32-class for the private artifact
  build's two canonical SDK cache misses. Overlap requires at least two available
  CPUs and 25.5 GiB of observed remaining memory for unchanged 12-GiB heaps plus
  768 MiB native headroom each. Unknown finite-cgroup usage or insufficient capacity
  keeps compilation serial. Keep browser workers, inventory, build/read ordering,
  routing, deadlines and all caps unchanged. This adds zero jobs or registrations.
  Compiler-only AWS evidence does not prove CI timing; validate the complete job
  through exact-head native CI before claiming an improvement.
- Current-target `build-artifacts` uses the existing 16-class after a complete
  four-CPU/15.42-GiB compute proof, including the unchanged parallel verifier wave.
  The SDK memory owner keeps declarations serial when two heaps do not fit.
  Eligible frozen or unclassified targets also request 16-class; hosted fallbacks, job counts,
  concurrency and deadlines stay unchanged. Measured compute fit does not prove
  queue savings; observe the next exact-head CI cycle.
- Normal canonical hybrid first attempts use the existing four-part QA smoke
  plan, removing two repeated checkouts, setups and private runtime builds.
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
- Current GitHub/hybrid test types use five canonical core stripe jobs plus
  the central extensions/scripts/root tail. Eligible core-change PRs keep the
  same rows: each validates the complete graph boundary and intersects selected
  consumers with its original stripe. Empty intersections stay empty; ambiguous
  selection falls back to every canonical graph across those same stripes.
  Frozen targets retain two paired rows for stripes 1+2 and 3+4 sequentially,
  with stripe 5 in the central row. Keep at most two compiler children per
  stripe and one builder per child. A failing stripe stops its row; other
  matrix rows keep running. Pure Blacksmith and targets without stripe support
  retain the central path. Keep row caps and deadlines unchanged; measure actual
  hosted completion rather than inferring wall-time savings from partitioning.
- CPU-heavy test-type, core test-type stripe, and runtime-topology jobs in `ci.yml`
  request `blacksmith-16vcpu-ubuntu-2404`. The separate `openclaw-npm-preflight.yml`
  jobs retain `blacksmith-32vcpu-ubuntu-2404`. The 2026-09-01 x64 probe
  [run 33538827388](https://github.com/openclaw/openclaw/actions/runs/33538827388)
  measured requested 8/16/32 labels delivering 2/4/8 CPUs respectively. Treat
  larger requests as a measured capacity workaround, never as worker counts.
  Keep existing routing, fanout, and resource-based worker limits; reassess
  sizing after provider allocation changes. See `docs/ci.md` for the full table.
- lower-weight Node/check shards on `blacksmith-4vcpu-ubuntu-2404`.
- heavy retained Linux/Android shards on `blacksmith-8vcpu-ubuntu-2404`.
- CodeQL Critical Quality on `ubuntu-24.04` with no `blacksmith-` labels.
- `OPENCLAW_CI_RUNNER_BACKEND=github` routes every configurable `ci.yml` job
  to its existing GitHub-hosted fallback label. Unset or `blacksmith` preserves
  the normal Blacksmith-first route.
- Vitest transform and Node compile caches are restore-only in CI and use
  immutable Actions caches; the main-push/daily/dispatch warmer is their sole
  writer. Build, QA and test orchestration consume its shared Node compile seed.
  PRs create no runtime-cache archives.

When changing one knob, update `docs/ci.md` and the guard test in the same PR.

## Blacksmith Outage Circuit Breaker

Use the repository variable only after confirming a Blacksmith outage or
unavailable runner capacity. Do not set it merely for a failing test that has
already started.

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

In degraded mode, `ci.yml` uses the same hosted labels and non-Blacksmith paths
as manual dispatches and fork pull requests. Blacksmith-only Docker and sticky
steps stay off, dependency setup uses the ordinary Actions pnpm-store cache,
and Android's large build uses separate low-memory Gradle processes. Standard
4-core hosted runners make builds and test lanes slower. Blacksmith runner
registration is no longer part of the budget, while GitHub-hosted concurrency
limits apply.

Flip back after the outage by deleting the variable:

```bash
gh variable delete OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw
```

Scheduled health detection and automatic flipping are a follow-up, not part of
the current circuit breaker.

## Validation

For workflow-only or docs/skill-only changes in a Codex worktree:

```bash
node scripts/run-vitest.mjs test/scripts/ci-workflow-guards.test.ts test/scripts/ci-workflow-planning.test.ts test/scripts/ci-workflow-evidence.test.ts
node --import tsx scripts/check-workflows.mts
node scripts/docs-list.js
./node_modules/.bin/oxfmt --check .github/workflows/ci.yml .github/workflows/codeql-critical-quality.yml docs/ci.md test/scripts/ci-workflow-guards.test.ts test/scripts/ci-workflow-planning.test.ts test/scripts/ci-workflow-evidence.test.ts test/scripts/ci-workflow.test-support.ts .agents/skills/openclaw-ci-limits/SKILL.md .agents/skills/openclaw-ci-limits/agents/openai.yaml
git diff --check
```

If `pnpm docs:list` tries to reconcile dependencies in a linked Codex worktree,
stop and use `node scripts/docs-list.js`.

For a PR before requesting maintainer approval, bind the watcher to the PR's
full 40-character head SHA:

```bash
.agents/skills/autoreview/scripts/autoreview --mode branch --base origin/main
node scripts/watch-pr-ci.mjs <pr> <head-sha> --repo openclaw/openclaw
```

Use hosted exact-head gates for CI workflow tuning. This explicitly selects
completed-proof mode, not the default pending-GitHub handoff in the
[maintainer landing workflow](../openclaw-pr-maintainer/references/landing.md#review-prepare-merge).
Do not burn local `pnpm test` on unrelated full-suite proof. Never combine
`OPENCLAW_TESTBOX=1` with `OPENCLAW_PR_GATES_REMOTE=github`.

Only after the maintainer explicitly asks you to prepare or land the PR, run the
repo-native mutating wrapper:

```bash
scripts/pr review-init <pr>
scripts/pr review-artifacts-init <pr>
scripts/pr review-validate-artifacts <pr>
env -u OPENCLAW_PR_GATES_REMOTE OPENCLAW_TESTBOX=1 scripts/pr prepare-run <pr>
```

`prepare-run` can push a prepared commit to the PR branch. Only run
`scripts/pr merge-run <pr>` after the maintainer has explicitly asked you to
land the PR. Both commands mutate GitHub state.

## Post-Land Monitoring

After merge, watch at least one fresh main cycle and the adjacent repos:

```bash
gh run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
for repo in openclaw/clawsweeper openclaw/clawhub openclaw/clownfish openclaw/openclaw-rtt openclaw/clawbench; do
  gh run list -R "$repo" --limit 12 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
done
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '.'
```

Report:

- exact PR/commit landed;
- expected registration reduction or added headroom;
- CI run status and slowest/queued jobs;
- queued job labels, runner assignment, and dependency state for any outlier;
- Blacksmith Actions runner evidence separately from Testbox control-plane
  health;
- ClawSweeper queue pending, dispatching, leased, oldest pending age;
- publication net drain/dead letters, state-writer queued/waiting, and state
  append rows/bytes/oldest item;
- any real failures that remain outside runner registration.
