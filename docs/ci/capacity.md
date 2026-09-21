---
summary: "Runner registration budget, concurrency headroom, and measured shard timings"
title: "CI capacity and shard weights"
read_when:
  - You are tuning CI concurrency or shard counts
  - You need the measured timings behind shard packing
---

## Runner registration budget

OpenClaw's current GitHub runner-registration bucket reports 10,000 self-hosted
runner registrations per 5 minutes in `gh api rate_limit`. Re-check
`actions_runner_registration` before each tuning pass because GitHub can change
this bucket. The limit is shared by all Blacksmith runner registrations in the
`openclaw` organization, so adding another Blacksmith installation does not add
a new bucket.

Treat Blacksmith labels as the scarce resource for burst control. Jobs that
only route, notify, summarize, select shards, or run short CodeQL scans should
stay on GitHub-hosted runners unless they have measured Blacksmith-specific
needs. Any new Blacksmith matrix, larger `max-parallel`, or high-frequency
workflow must show its worst-case registration count and keep the org-level
target below about 60% of the live bucket. With the current 10,000-registration
bucket, that means a 6,000-registration operating target, leaving headroom for
concurrent repositories, retries, and burst overlap.

Trusted automatic hybrid first-attempt preflight jobs request the existing
16-class after three nearby hosted preflights remained unassigned while their
Blacksmith security jobs completed. Each eligible hybrid run admits one
Blacksmith preflight plus security when optional hosted admission is closed,
for at most two control registrations; default Blacksmith retains one. Both jobs already
belong to the conservative 80 non-Node allowance, so the retained
`4 × 150 + 21 × 210 = 5,010` ceiling is unchanged. The exposed live bucket still
reported 10,000 on 2026-09-16; its pooled reader's unused quota does not establish
organization-wide free capacity. The remaining 990 allowance must still cover
adjacent repositories, releases, retries and carryover. This routing trial does
not prove available physical capacity or faster preflight execution.

The protected cache warmer has two platform rows: the existing Linux workload and one hosted macOS pnpm-store publisher. Its per-ref concurrency and pending-run coalescing are unchanged. Each admitted warmer run adds one hosted macOS job and no Blacksmith registrations; pull-request CI adds no writers or jobs. Native producer and consumer measurements must include cache transfer, extraction, installation, and archive size before claiming a setup-time saving.

The published-upgrade main tripwire reuses the reserved `docker-seed-e2e` job,
so the retained peak envelope stays `4 × 150 + 21 × 210 = 5,010` registrations.
Docs-only main tips remain excluded by the `**/*.md` and `docs/**` push filters.
Admitted main pushes retain the same two non-canceling parity slots; the bound
includes both active runs and both coalesced successors. It does not assume
that every pushed commit starts a run.
The weekly Update Migration dispatch uses one targeted Docker group per
supported baseline for native operator state and keeps synthetic cleanup on
the candidate-relative predecessor. If that predecessor is outside the
supported set, it adds one existing matrix row: at most five targeted jobs,
plus image preparation, the group planner, and the hybrid ref validator, for
at most eight Blacksmith registrations per weekly run. Its separate non-canceling concurrency group
coalesces pending scheduled runs and cannot cancel manual validation. Release
checks reuse the same bounded grouping and unchanged 32-job cap: at four
distinct baselines, normal Package Acceptance selects 16 targeted jobs (17
when the predecessor needs its own row) and release soak selects 20. The
three-scenario group limit and 32-job concurrency cap are unchanged. The additional weekly burst and expanded release jobs
share the existing headroom for releases, adjacent repositories, and carryover;
the live shared bucket must still be checked before further fanout changes.

The three Mac Node parts add two hosted jobs per run on `github` and `hybrid`, with no added Blacksmith registrations there. Normal Blacksmith routing adds two registrations per qualifying attempt-1 push or trusted PR; manual runs, retries, and untrusted PRs remain hosted. The matrix concurrency cap is three. GitHub's documented Enterprise macOS concurrency allowance is 50, shared with other hosted Mac workflows; it does not guarantee immediate runner admission. No runner class or repository capacity setting changes with this split.

`Release npm Cache Warm` (`release-npm-cache-warm.yml`) runs a hosted Linux job on scheduled and manual triggers to prepare an npm download seed from the latest published OpenClaw package with lifecycle scripts disabled. Its concurrency group is separate from push-triggered Vitest warming, so newer pushes cannot cancel a pending seed. Scheduled runs publish from `main`, so new release branches can restore that seed through GitHub's default-branch cache scope. Each seed starts empty and contains only the current baseline dependency graph. Cross-OS release checks first restore their candidate-specific cache, then a matching runtime/suite cache, then this shared seed. Only npm's content-addressed `_cacache` directory is archived; install prefixes, OpenClaw state, npm logs, and executable `npx` caches remain fresh. The producer and consumers use the same relative archive path and enable cross-OS archives. npm retains normal freshness and integrity checks and downloads missing platform-specific packages. This adds one hosted Linux job per scheduled or manual warmer run, no jobs on pushes, and no Blacksmith registrations.

Small precise PR changes use a focused Node plan. Broad, deleted or unknown changes retain compact core plus the affected plugin fallback; canonical pushes use the integration compact. Every compact planner profile is capped at 90 rows, and plugin fallback packing is capped at 50. The final canonical Node matrix also enforces 70 push rows or 130 PR rows, including precise plans. Missing changed paths, missing current planner capabilities and planner errors fail preflight instead of emitting an incomplete successful matrix. Approved historical dispatches retain their full named plans. Count every emitted matrix row and nonmatrix job, including all six Android rows despite its two-job concurrency cap.

Preflight reserves the actual appended plugin Node rows before packing compact
core work. Hosted tooling tail compaction therefore starts when the remaining
Node budget is exceeded, even below the standalone 90-row compact cap. Dist
descriptors belong to their separate matrix and do not consume this Node budget;
they still count toward the compact cap. The existing file-owner splitting,
timing weights, process boundaries, runner requirements, and admission limits
remain authoritative. If compaction cannot fit the complete inventory, preflight
fails instead of dropping work or increasing either cap.

The approved row-cap increase raises compact plans from 80 to 90 rows and final Node matrices from 64/120 to 70/130 push/PR rows. It reserves room for the measured isolated Gateway-server family and measured plugin-envelope packing. At the limits, each run can admit six more Node registrations on push or ten more on PR; compact rows are already included in that total. Across the retained four-main/21-PR arrival envelope, the increase is `4 × 6 + 21 × 10 = 234`, taking the conservative ceiling from 4,776 to 5,010. Runner classes, workers, matrix concurrency and timeouts retain their existing policies. The cap increase alone does not establish a runtime improvement.

The shared plugin catch-all, QA and provider suites use native Vitest sharding, sized from the existing 90-file envelope budget. Their complete configs still own discovery and exclusions; the counting inventory never narrows execution to the directly changed plugin. At `2f7fb353`, the catch-all has 486 counting entries and 474 effective files across six jobs, QA has 238/232 across three, and providers have 275/256 across four. Counting entries include files excluded by Vitest, so the budget is conservative. Each job retains its existing worker limits, isolation policy and per-file module cleanup.

Process-bounded plugin fallback uses each test file's effective config owner,
including files migrated from ordinary plugin suites to database workers.
Broad fallback retains the complete selected config inventory, including
built-in plugins without package manifests; plugin-only changes keep their scope.
Even a single bounded envelope retains its explicit file scope, so it cannot
silently execute the larger whole config. Uneven bounded chunks use their own
file counts with the existing cost rates; native Vitest shards retain equal
shares of the complete config estimate.

All files routed to the database-worker config share a 20-file CI job ceiling,
including every co-located envelope. The effective config owns classification;
migrated files also retain any tighter original plugin job and process limits.
This partitions the 185-file native envelope from [run 35176277297](https://github.com/openclaw/openclaw/actions/runs/35176277297)
into ten non-overlapping envelopes. That run continued passing tests for more
than 58 minutes before the job deadline; it is a lower bound, not a completed
family timing sample. In [run 35477485803](https://github.com/openclaw/openclaw/actions/runs/35477485803),
root-only counting allowed 149 database-worker files in one serial job; its
test step took 27 minutes 30 seconds. The ceiling now prevents both oversized
migrated envelopes and their reassembly during cost packing. Fork isolation,
process file limits, worker limits, timeouts, and the 50-job fallback cap stay
unchanged. Cost estimates remain advisory; hosted CI must establish the resulting
job durations.

Ordinary Codex tests use isolated thread workers and inherit file parallelism from the shared worker budget. Each file retires its mocked module graph and globals; an ordinary process contains at most 24 files. Database-worker-routed Codex tests already use isolated forks and retain an independent 12-file bound. The 300-second no-output watchdog, test deadlines, and assertions remain unchanged. These scheduling bounds are independent of the timing-weight calibration; a larger process bound does not by itself establish a wall-time or matrix-row improvement.

Precise and fallback plugin envelopes share the same packing owner and a 240-second aggregate estimated budget per job, including multiple envelopes of the same config. This budget belongs only to changed-extension jobs; compact core budgets are unchanged. Members retain compatible runner/dist requirements and run one at a time. Packing retains each produced envelope's child process, environment, native shard arguments and include scope, including process-bounded Codex, Matrix and Telegram work. Runtime-preparing envelopes remain separate, and an envelope above the budget stays alone. Worker limits, runner classes, timeouts, coverage and serial stop-on-failure behavior are unchanged.

For explicitly bounded plugin configs, the prerequisite owner identifies files that need a built runtime. When those files span multiple envelopes, the producer groups them before applying the existing file limits, so unrelated tests do not cause repeated runtime builds. Each resulting envelope retains its actual prerequisite charge and measured file costs. Whole-config native Vitest shards retain their complete discovery and preparation contract.

Most fallback rates use median wrapper seconds per counting file from 371 successful envelopes across four contributing PR runs in a ten-green-run sample: [35490342736](https://github.com/openclaw/openclaw/actions/runs/35490342736), [35490482496](https://github.com/openclaw/openclaw/actions/runs/35490482496), and [35491344005](https://github.com/openclaw/openclaw/actions/runs/35491344005). The 27-config table includes Feishu at 0.411 seconds/file. Existing runtime preparation allowances remain conservative additions to these fallback estimates.

The Codex rates were refreshed after the app-server fixture began reusing database workers. The newest three successful qualifying PR runs at the September 20, 2026 21:25 UTC cutoff were [35537834254](https://github.com/openclaw/openclaw/actions/runs/35537834254), [35537743091](https://github.com/openclaw/openclaw/actions/runs/35537743091), and [35537672782](https://github.com/openclaw/openclaw/actions/runs/35537672782), all on two detected CPUs with a two-worker budget. Ordinary Codex envelopes, then serial, have a median rate of 2.490 seconds/file across 78 observations. The database-worker config's overall median, which includes Codex, changes from 7.582 to 7.599 seconds/file across 114 envelopes. Explicit database-worker app-server files use a conservative 17.31 seconds/file, rounded up from the slowest 11-file envelope's 190.394 seconds; the previous floor was 46.26. This keeps the native tail visible above the mixed config median. Summed case time is a different measure: those app-server files averaged 11.672 seconds across 207 file observations. The wrapper rates already incorporate worker scheduling and must not be divided by the worker count again.

This calibration preserves execution policy: ordinary Codex files remain serial and non-isolated, database-worker-routed Codex files retain isolated forks, and both keep their 12-file process bound. The 300-second no-output watchdog and test deadlines remain unchanged. Weight changes affect packing and predictions, not per-file scheduling.

The landed caps are 90 compact rows, 130 final PR Node rows and 70 final push Node rows; changed-extension fallback retains its 50-row cap. These caps admit the 240-second budget without another policy increase. Replaying PR #153435's 38 changed paths and a broad SDK fallback on the `9034c0aa` counting inventory with the refreshed Codex rates emits 124 envelopes in 48 extension rows, down from 50 rows with the same envelope inventory and process bounds, for both changed sets:

| Profile    | Compact PR rows | Final PR Node rows before → after | Final push Node rows |
| ---------- | --------------: | --------------------------------: | -------------------: |
| Blacksmith |              76 |                         124 → 122 |                   56 |
| GitHub     |              82 |                         130 → 128 |                   54 |
| hybrid     |              72 |                         120 → 118 |                   47 |

Compact PR counts include two dist descriptors outside the Node matrix. Compact and push counts are unchanged because these Codex configs are outside compact groups, and canonical pushes do not append changed-extension envelopes. The largest Codex prediction falls from 609 to 291 seconds, including the existing 100-second runtime-preparation allowance. The remaining extension floor is 380 seconds in a non-Codex database-worker group. Overall longest predicted rows are 623 seconds on Blacksmith, 380 on GitHub, and 518 on hybrid. Every profile fits the landed caps, and the conservative registration ceiling remains the landed 5,010 bound.

With the effective-config ceiling and prerequisite grouping applied to the `f5138cb0b27f` inventory, broad fallback covers all 482 database-worker files exactly once in 47 jobs, with at most 20 worker files per job. The all-packaged-plugin precise plan covers 478 worker files in 47 extension jobs plus one selected core-test job; broad fallback additionally owns four built-in plugin files. Blacksmith, hybrid and GitHub final broad PR Node counts are 119, 113 and 125; push counts are 54, 44 and 49. Regular Codex runtime consumers share one prepared envelope instead of three, and Telegram consumers share one instead of two. The sole prepared database-worker envelope retains its original 11-file scope and the refreshed 291-second estimate. The total forecast is 10,167 seconds. These are planner counts and estimates, not new runtime measurements. The shared packing algorithm, current measured rates, time budgets and all row caps are unchanged.

Median rates are estimates, not elapsed-time guarantees. Before the Codex fixture change, replaying the historical 123-envelope layout against the largest matching observed child spans gave a 432.758-second combined envelope sum at 240 seconds, versus 520.688 seconds at the interim 320-second budget; its slowest individual envelope took 508.783 seconds. Whole-config observations can have different file inventories across source revisions. These are historical forecasts, not measured walls for the current combined jobs. The original job in run 35490342736 bundled 17 envelopes into 2,015.674 seconds of child spans and 2,049 seconds of wall time despite a 240-second prediction. Native PR CI must verify the improvement toward the ten-minute PR objective. Exact config/include-set observations and successful PR-run ingestion in the timing refit remain follow-up work; narrow PR samples must not prune unrelated observations merely because they were not selected.

GitHub-hosted core storage/state stripes also have a 64-file admission ceiling. In [run 35477045216](https://github.com/openclaw/openclaw/actions/runs/35477045216), a 203-file serial stripe continued passing tests until the one-hour job deadline; its 196-file sibling completed in 2,867 test seconds. The compact split owner bounds each hosted prerequisite-preserving stripe independently of older timing estimates, and the existing distinct-family rule prevents reassembly in one job. Blacksmith and hybrid retain their existing measured partitioning. Every file remains covered once, with fork isolation, serial file execution, worker limits, deadlines, and the 90-row compact cap. This is a workload bound, not a measured new runtime; hosted CI must establish the resulting duration.

Eligible Blacksmith and hybrid compact bins with multiple ordinary groups request the existing 32-vCPU runner with two child-process slots. Initial packing retains the 360-second aggregate budget and completes Gateway serialization, runtime placement, and worker pinning before compaction. Only jobs already admitted on the 32-class with two child-process slots are then repacked into 500-second bins. Those jobs may share capacity across logical runner classes while each child retains its original runner metadata and worker ceiling. Existing serial jobs retain their membership, ordering, estimates, and worker limits; widening their initial packing can concentrate slow Gateway work even when their final estimate remains below 360 seconds. Compatible parallel groups can fill the new budget without the ten-group cutoff retained by serial jobs. Blacksmith serial jobs retain their 200/276-second budgets; hybrid serial jobs retain 210 seconds. Exclusive jobs retain 150 seconds by default. Only complete ordinary hybrid bins of non-build CLI groups may use 250 seconds and share split siblings; every child must still fit 150 seconds. Groups above their existing serial cap stay alone. Exclusive groups, original single groups, dist descriptors and jobs with runtime preparation remain serial. Hybrid exclusive and dist bins retain their existing prerequisite sharing. The shard executor admits at most two processes only when the actual host has at least eight available CPUs and 24 GiB of memory; smaller capacity admits one. Each overlapping child keeps two Vitest workers, including a singleton left after compaction; inner project parallelism remains one. The primary `github` profile stays serial at 210 seconds. Preflight records the actual row count for each source revision; canonical inventory comparisons must preserve every original child plan and test input. Native elapsed-time, memory and cleanup evidence must establish the actual effect.

The `github` compact planner can place smaller ordinary groups on an already-required stronger logical runner. Each emitted job retains its strongest capacity owner, serial execution, original child processes and worker limits, the 210-second budget, and the ten-group limit. SDK and plugin runtime consumers are separated from ordinary files before packing; the SDK light project intersects shared include lists with its own inventory. Parent-derived fractional costs are rounded only at the emitted job boundary, so rounding small consumers cannot create a redundant runtime build. The shared packer can exchange groups to fill compatible capacity while rechecking complete replacements. Runtime-only hosted groups may share their strongest prerequisite within the existing 210-second serial budget; the build itself costs 160–166 seconds and is charged once per job. No-build exclusive groups keep their 150-second limit. Stranded tooling tails are sized against remaining compatible capacity before normal admission is reapplied. Exclusive, dist, oversized, and runtime-preparing bins retain their separate constraints.

The September 16 capacity repair removes the blanket post-packing 32-to-16 downgrade and the three named compact 32-to-16 overrides. On the inspected inventory, 18 existing hybrid jobs per push or broad PR return to the 32-class; the Blacksmith profile restores 19 push or 36 broad-PR placements, including agent-support and tooling. This changes zero total runner registrations and adds no hosted rows, so the conservative 5,010-registration envelope remains unchanged. Restoring real-Gateway E2E adds one 32-class assignment when that job is selected, for 19 hybrid assignments in total on this inventory, still with zero additional registrations. Other workflow sizing remains in place. These counts depend on the inventory; verify the emitted plan and actual eight-CPU/24-GiB admission before claiming a wall-time improvement.

Failed-job-only hybrid retries retain their original matrix and its admitted aggregate estimates when routing to hosted Ubuntu. They do not repack to 210 seconds. The existing capacity gate reduces concurrency to one on those hosts, while the retained two-slot descriptor keeps the two-worker child budget. Such retries can exceed the eight-minute normal-run objective; existing 60/120-minute job deadlines and watchdogs are unchanged. Requested runner labels do not establish actual CPU or memory capacity.

The final Node matrix admits longer estimated jobs first across compact and plugin descriptors. Plugin estimates reuse the extension batch cost owner, including existing process boundaries; runtime preparation is charged separately from the same prerequisite table used by compact jobs. Equal estimates and historical descriptors without estimates keep their original order. The 96-job concurrency ceiling bounds active jobs, while the manifest caps bound total admissions. In run `33449014227`, all 96 slots were occupied when the late QA job started; that dependency delay was matrix admission, not evidence of runner-registration throttling.

Expanded serial large/small jobs admit 210 predicted seconds; eligible hybrid parallel bins initially admit 360 before the final parallel-only compaction to 500 seconds. All profiles retain the shared 90-row compact cap. The 150-second file-split and default exclusive-group budgets stay unchanged; complete non-build CLI bins alone may use the 250-second ordinary hybrid admission budget. The PR-only performance lifecycle file retains its 136-second fallback from native spans of 127.288/135.808 seconds in runs 33532741896/33545657559; canonical pushes omit that tooling family. Trusted contributor forks can use the GitHub profile on Blacksmith, so every profile participates in the same registration bound. The widest current workflow profiles retain up to 87 other potential rows (14 nonmatrix and 73 matrix), or 88 for historical targets without the UI named-project contract. The conservative cap-based envelope already includes twelve Control UI shards plus the browser-extension row on every profile. Excluding the four unconditionally hosted iOS rows, three hosted macOS Swift phases, and the hosted aggregate gate gives the conservative ceiling of 80 potentially eligible rows. This includes the new Control UI performance job; keep the ceiling rather than spending savings from consolidated checks. With the final Node caps, the bounds are 150 registrations per main run and 210 per PR. Two active main slots, both pending successors and the observed peak of 21 non-skipped PR arrivals give `4 × 150 + 21 × 210 = 5,010` registrations in five minutes. This leaves 990 within the 6,000 reference operating target for release work, adjacent repositories and carryover; it does not prove those arrivals fit. The earlier 19-arrival estimate is obsolete. Using the prior 4,826-registration reference, the bounded 2026-09-02 cohort audit counted 321 unassigned Blacksmith jobs and reserved nine auxiliary rows, giving `4,826 + 321 + 9 = 5,156` planned registrations and an 844-row allowance below that reference. Its 40 exact attempts covered 4,830 jobs; queued observations spanned 21:50:48–21:57:11 UTC and were not simultaneous. Already-assigned jobs, old approval-waiting runs, unobserved retries and unlisted organization work remain outside that cohort, so this is a conditional planning bound rather than a live organization balance. Evaluate a single PR trial using its actual emitted rows separately from the rollout model. Budget all six npm qualification jobs and the relevant full-release children; a shared-token quota response or unused bucket does not establish organization-wide usage or physical runner capacity.

`checks-ui-e2e` emits thirteen rows for every newly planned target with the named-project contract: twelve combined weighted Control UI shards and one browser-extension row. This width applies across backend profiles, attempts, frozen targets, and missing attempt metadata. Control UI shards use the 16-class; the browser row uses the 8-class unless admitted to hosted Ubuntu by the bounded hybrid plan. Historical targets without the contract retain four total rows on the Blacksmith planner profile or fourteen on GitHub and hybrid profiles. The 2026-09-02 inventory at `49fb9c5` contains 359 files: 329 parallel bundle consumers, three parallel self-owned files, seven serial bundle consumers, and 20 serial private source/custom-build files. Ordinary CI excludes seven real-Gateway files, leaving 352. Four native projects represent resource ownership without adding jobs or execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` share group 0 with at most two workers total, then `ui-e2e-serial` and `ui-e2e-serial-standalone` share group 1 with one worker. Local throttling and explicit worker limits still apply. The shared weighted sequencer charges each file by its measured duration divided by that project's effective worker count and assigns every discovered specification once across the selected Control UI rows. The root config keeps the complete inventory visible for discovery. Serial scheduling still protects private source servers that share a Vite optimizer cache, real Gateways, and the runtime-budget measurement; test cases, deadlines, and isolation are unchanged.

Every selected project discovers Chromium. The first selected bundle-consuming project builds one private production bundle/preview and publishes its URL through Vitest's invocation-scoped root context; later consumers share it until invocation teardown. Standalone projects have no bundle setup or URL bridge, so standalone-only selections skip that build. Enabled manual proof capture uses the shared upload directory, including the MCP and Logs suites.

Ordinary and real-Gateway Control UI jobs upload only allowlisted `failure.public.json` summaries and retain them for seven days, with separate artifact paths for each job and run attempt. Raw `failure.private.json` reports and `failure.private.png` screenshots remain local and are excluded from these uploads. Older frozen targets without the public summary produce no matching upload; raw captures are never a fallback.

The dedicated real-Gateway job runs its complete selected inventory in one invocation through `test/vitest/vitest.ui-e2e-prebuilt.config.ts`. It requires a clean checkout and completed runtime, private QA, and canonical Control UI artifacts from `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build:ci-artifacts`. Source and built outputs must remain unchanged until all workers and children finish. A readiness failure stops the invocation without rebuilding or falling back to another config. Files outside the prebuilt config’s shared-reader/writer allowlist run serially first; audited fixtures with private HOME, state, ports, and cleanup then share the existing two-worker limit. The allowlist admits both invocation-preview consumers and fixtures serving canonical built UI bytes through their own prepared Gateway child. The invocation preview builds its own private output from the same source. This adds no CI jobs or shards. The ordinary local config keeps real-Gateway files serial, and frozen targets lacking the prebuilt config retain their original serial command.

The original two-worker rollout had a controlled Linux comparison covering its then-complete inventory of 14 files and 25 tests, reducing invocation elapsed time from 309.374 to 202.027 seconds. Those historical results do not measure later allowlist additions, complete CI timing, or achievement of the CI latency target.

Eligible `control-ui` rows request `blacksmith-16vcpu-ubuntu-2404`; the browser-extension row keeps the 8-vCPU request when optional hosted admission is closed, and eligible real-Gateway jobs request the 32-class. Backend, event, contributor-trust and cache-write boundaries are unchanged, including hybrid first attempts and trusted contributor forks. Historical [run 33692146223](https://github.com/openclaw/openclaw/actions/runs/33692146223) had two slowest UI rows requesting the 8-vCPU label but reporting two CPUs; their 356/383-second test steps set the 8:20 non-Windows wall. That run's 32-vCPU jobs reported eight CPUs. The larger request added no workers. In historical [run 33695337496](https://github.com/openclaw/openclaw/actions/runs/33695337496), all twelve UI rows on the 32-class reported eight CPUs and finished by 4:38 from workflow creation, with 102–145-second test steps. Those measurements do not establish timings on today's 16-class route. Stale file weights still need the existing refit's independent-run and replacement thresholds, rather than a one-run manual adjustment.

In [run 35028248954, UI job 6/7](https://github.com/openclaw/openclaw/actions/runs/35028248954/job/104582299257), the six-shard Control UI plan requested the 16-class and reported four CPUs. Setup took about 3m45s before the test command. The job recorded 168 passing tests and three failures before cancellation about 25m07s after runner startup; a test completed three seconds before cancellation. The twelve-shard plan still needs native CI timing proof, and widening the plan does not resolve those assertions or guarantee completion within the unchanged deadline.

The real-Gateway placement restores the 32-class request, adding zero jobs or registrations. The 16-class delivered four CPUs and canceled a progressing suite at 1,227 seconds in [run 35120538555](https://github.com/openclaw/openclaw/actions/runs/35120538555/job/104877350907). The Blacksmith job budget remains 20 minutes, hosted remains 40, and all test deadlines stay fixed. Its private artifact build may overlap exactly two canonical SDK cache misses only with at least two available CPUs and 25.5 GiB of observed remaining memory for both unchanged 12-GiB heaps and 768 MiB of native headroom each. Unknown finite-cgroup usage, smaller capacity, cache hits, or a single nonempty miss retain serial compilation. Runtime and UI publication still complete before browser readers start; browser worker limits, file inventory, and deadlines are unchanged. Standalone compiler measurements are not complete CI timings, so the full job must be validated on the selected native CI route.

The browser-extension row prepares only its native-host runtime JavaScript and assets through the existing `qaRuntime` build profile rather than rebuilding declarations and the Control UI. The thirteen-row named-project plan stays inside the existing conservative registration bound. A failed-job-only retry retains its previously emitted matrix, including older plans with six Control UI shards. PR retries and hybrid push retries select hosted Ubuntu through live routing, so they may take longer; the existing 25-minute timeout is unchanged. Rerunning preflight for a target with the named-project contract selects twelve Control UI shards plus the browser-extension row. Canonical push retries on the Blacksmith profile retain Blacksmith routing. The `max-parallel` ceiling stays 14 for historical targets without the named-project contract, which retain their previous width. Physical capacity must be checked separately from the registration bound.

The previous thirteen-serial-shard layout consumed 4,258 job-seconds in successful [run 33494931388](https://github.com/openclaw/openclaw/actions/runs/33494931388) on 2026-09-01, averaging 327.5 seconds per Control UI row; preflight added 39 seconds and the tail row took 363 seconds. The current projects reduce the modeled body through bounded bundled concurrency. In run `33638745824`, twelve successful first-attempt Control UI rows had median/p90 test steps of 197/235 seconds, while their checkout median reached 116.5 seconds. Reducing thirteen Control UI shards to twelve removes one repeated checkout and setup without combining the separate browser-extension work. The current target is eight minutes for normal non-Windows CI, with fewer jobs preferred over a tighter latency target. Measure queueing, checkout, setup and test work separately; the final gate still waits for Windows, which may exceed that target. The historical serial layout and the single hosted retry are not paired performance comparisons.

Canonical-repo CI keeps Blacksmith as the default runner path for pushes and first-attempt same-repo pull-request runs when the backend is unset or `blacksmith`. Hybrid keeps the heavy set plus the named critical-path plateau lanes on Blacksmith for attempt 1; other light lanes and every rerun Blacksmith lane use GitHub-hosted capacity. Pull-request retries of both UI E2E jobs use GitHub-hosted Ubuntu in every mode; push retries remain on their normal backend unless hybrid fallback applies. Manual `workflow_dispatch` and non-canonical repository runs use GitHub-hosted runners for the main test/build lanes. With an unset or `blacksmith` backend, ordinary canonical manual dispatches (`release_gate: false`) can still run the seven `check-shard` rows on their Blacksmith matrix runners; release-gate check rows remain hosted. Same-repo hybrid Full Release Validation sends only frozen-candidate lint to its matrix runner, both for exact main-ancestor SHAs without a release context and for canonical release-context candidates. These manual admissions are outside the main/PR arrival estimate above. The [`github` backend](/ci/runners#runner-backend-modes) provides a manual repository-wide fallback; canonical runs do not probe Blacksmith queue health or mutate the variable automatically.

## Vitest worker sizing

### Fixed job preparation

The September 20 overhead sample measured all job steps in green main run
`35520044205` and green PR run `35456568835`. Main had 72 active jobs and a
16m45s workflow wall; the PR had 152 active jobs and a 26m25s wall. Checkout
medians were 9/8 seconds and Node setup medians were 13/13 seconds. Across each
run, checkout plus setup consumed 30.63/82.18 machine-minutes. The jobs API
reports composite setup as one step; sampled logs confirmed dependency/store
hits and measured cold worker preparation at 7.1–21.7 seconds inside test steps.
These different inventories are baselines, not a paired performance comparison.

Compiled-worker reuse adds no jobs, registrations, test processes, or workers.
It uses the existing protected warmer and restore-only Actions cache mechanism.
The warm result must include transfer, validation, and joined cleanup; an archive
hit alone does not establish savings. Initial PR runs remain cold until the
protected warmer publishes the new namespace. Removing unused build archive
uploads saves their measured 5–6 seconds plus packing and plugin-asset upload
time in the artifact job, which was not the finishing bottleneck in either
baseline. Node runtime builds remain separate to preserve parallel startup and
private-QA output variants. Checkout already fetches depth-one selected source;
historical test prerequisites and revision-comparison inputs stay with their
existing owners.

A Linux Testbox probe on four CPUs, 15.4 GiB RAM, and Node 24.19.0 measured
preparation plus joined cleanup at 8.43/9.44 seconds without reuse and 3.21/3.17
seconds after restoring a 30 MiB archive. Peak process RSS fell from
2.59–2.66 GiB to 0.55 GiB. The two-sample midpoint saves 5.75 seconds before
download and extraction; transport must cost less than that to improve a
consumer's wall. The producer took 9.38 seconds on a cold cache. These are
preparation measurements, not full-workflow or production cache-hit rates.

At 36 runs per eight hours, one second saved across 152 active jobs is 1.52
machine-hours per eight-hour window, or 4.56 hours if that rate persists all day.
Use each run's actual eligible count; requested vCPU cost and machine wall time
are separate measures.

### Worker ceilings

Current serial self-hosted Node jobs sample the shared worker scheduler after
runtime preparation. Hosts with fewer than eight available CPUs or less than
24 GiB retain the workflow's existing CPU-based ceiling. Hosted runners, frozen
targets, and overlapping plans also retain their existing ceilings. Interactive
local scheduling is unchanged.

| Requested Blacksmith class | Observed CPUs / RAM | Serial job ceiling with headroom | Overlapping child ceiling |
| -------------------------- | ------------------- | -------------------------------: | ------------------------: |
| 4 / 8                      | 2 / 7.66 GiB        |                                2 |                         2 |
| 16                         | 4 / 15.42 GiB       |                                3 |                         2 |
| 32                         | 8 / 30.95 GiB       |                                8 |                         2 |

Group pins can lower these ceilings. Only the measured `agentic-gateway-core-2`
family loses its two-worker compact pin on Blacksmith and hybrid profiles;
GitHub-hosted planning and other timing-sensitive groups retain it. Gateway
plans still run exclusively. When core-2 shares a serial bin, its unproven
siblings retain their two-worker caps at group scope.

Agents-core files share the configured worker pool, including local scheduling
and its one-worker throttle. Compact agents-core groups retain a two-worker cap.
Their initial estimates divide serial timing history by the effective file
workers, preserving the cost of an indivisible file. Separate parallel timing
keys let subsequent measurements replace those estimates without being divided
again. The file inventory and import-heavy CLI stripes remain unchanged.

The [September 19 probe](https://github.com/openclaw/openclaw/actions/runs/35441442486)
ran two predefined samples per cell on eight CPUs, 30.95 GiB, and Node 24.19.0.
All twelve samples passed. Single-plan cells ran all 293 core-2 files; two-plan
cells also ran the complete core-1 group concurrently through a disposable
probe-only admission exception. Production Gateway exclusivity remains intact.
The default resolved to three workers.

|     Workers | Plans | Wall seconds, both samples | Peak summed RSS | Peak process RSS |
| ----------: | ----: | -------------------------- | --------------: | ---------------: |
| 3 (default) |     1 | 313.0 / 288.8              |        5.92 GiB |         5.63 GiB |
|           6 |     1 | 248.5 / 239.7              |        8.49 GiB |         8.12 GiB |
|           8 |     1 | 252.5 / 254.5              |       10.08 GiB |         9.69 GiB |
| 3 (default) |     2 | 364.9 / 347.2              |        9.04 GiB |         5.66 GiB |
|           6 |     2 | 359.0 / 316.4              |       12.12 GiB |         7.46 GiB |
|           8 |     2 | 380.0 / 339.6              |       14.71 GiB |         8.59 GiB |

Eight workers reduced the single-plan midpoint by 15.8%; six reduced it by
18.9%. Eight did not improve the combined two-plan wall, and six was slightly
faster in both layouts. These two-sample comparisons do not establish a precise
optimum or a full-workflow speedup. No failures were rerun, and no test assertions
or deadlines changed.

The CI memory tiers reserve 25% of total capacity for other work. Two copies of
the worst eight-worker single-plan RSS need `2 × 10.08 = 20.16 GiB`, fitting
within `28 × 0.75 = 21 GiB`. The six-worker bound is
`2 × 8.49 = 16.98 GiB`, fitting within `24 × 0.75 = 18 GiB`. Actual overlapping
RSS already includes both plans and is not multiplied again. This gives six
workers from 24 to below 28 GiB and eight from 28 through 128 GiB on hosts with
at least eight CPUs. Larger memory tiers, explicit overrides, the 16-worker cap,
load backoff, cgroup constraints, and the free-memory limits remain in place.
At most 8 GiB of free/process-available memory still caps automatic workers at
two; at most 4 GiB caps them at one. Committed timing weights are unchanged.

## Owner-path and release coverage

Docker seed and QA Smoke retain owner-path selection on canonical main pushes;
ordinary manual CI and Full Release Validation retain the supported complete
proofs. Pull requests and their exact-head fallback dispatches omit these jobs,
real-Gateway UI, and named built-process verifiers. Unit/boundary and mocked
Gateway coverage remain. The complete-file proof inventory belongs to
`scripts/lib/ci-proof-test-inventory.mts` and applies to precise and compact PR
plans after owner resolution. Main/manual plans keep every proof assertion.

The Windows planner consumes all explicit files in the two existing package
scripts and keeps every file intact. Reference run `35520647082` had
689/837-second Windows jobs. The first five-row run `35530187452` passed all
Windows tests in 333/496/425/450/370 seconds, exposing both uneven file costs
and a duplicated 67.2-second runtime build.

The planner now uses elapsed whole-file segments from that run, including
imports and hooks, instead of summed concurrent case times. Canonical Vitest
metadata groups compatible project files together; an oversized project splits
only at file boundaries. The canonical runtime prerequisite owner places its
two consumers together, so preparation happens once. Current project
invocations fall from 72 to 35, without changing process isolation or coverage.
The model reserves 104 seconds per row for observed setup, shared worker
compilation, and wrapper transitions, plus 68 seconds for the one runtime
preparation. It retains a three-second fallback for unmeasured files.
Four rows predict 489 seconds each; five predict 412 seconds each. These are
estimates requiring hosted verification, including actual runner queue time.
All 133 files and the shared worker-artifact fixture remain intact.

The worker-artifact fixture remains a Windows follow-up: the reference logged
one shared 18.087-second compile, then at least 139.608 seconds before its last
case finished (213.267 seconds summed concurrent cases). The first five-row run measured 170.203 seconds elapsed for the whole file
versus 217.299 summed concurrent case seconds. Profile generation
copy/verification and borrower startup on Windows before another optimization.

Proof tiering alone leaves the reference 924-second critical path unchanged.
With five Windows rows and every C1–C6 target shard at or below 500 seconds,
retaining the recorded Node matrix waits gives 793 seconds, led by compact-small-46.
If all job queues instead stay below eight seconds, compact-small-4 still gives
680 seconds. The 96-row Node concurrency cap caused observed waits of 140–160
seconds; reducing proof admission does not prove those waits disappear. Neither
scenario claims the ten-minute goal is already achieved.

Full-tier Windows expansion adds at most three non-Node registrations. Without
spending any PR proof savings, use 83 potentially eligible non-Node rows and the
unchanged 70/130 Node caps: `4 × 153 + 21 × 213 = 5,085`, leaving 915 below the
6,000 reference envelope. Historical calculations elsewhere on this page use
the earlier two-row Windows inventory. Compact90, push70, PR130, and the
96-concurrent-Node limit remain unchanged. The daily timing refit still observes
main and release proofs; no committed weight baseline was changed for tiering.

| Lane                            | PR coverage                                                                                             | Main/manual and full release coverage                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Docker seed                     | Selector, scheduler, update/Doctor/state unit and boundary owners                                       | Owner-selected main; exact published-upgrade survivor on ordinary manual CI     |
| QA Smoke CI                     | QA plan, catalog, transport, lifecycle and channel unit suites                                          | Owner-selected main; complete supported smoke profile on manual CI              |
| Real-Gateway UI                 | UI units and mocked-Gateway browser projects                                                            | Existing selected main/manual real-Gateway inventory                            |
| Built process proofs            | Browser registration, Doctor persistence, Discord multipart, SQLite store, watch and TUI boundary tests | Native host, Doctor, Discord, SQLite, watch and TUI canaries in build-artifacts |
| Doctor refusal / Codex recovery | Doctor admission/repair and harness replacement/cancellation boundaries                                 | Complete files in main/manual Node plans                                        |
| Windows                         | All 133 native unit/boundary/process files in measured whole-file rows                                  | Same inventory, historical targets retain their package commands                |

## Measured shard weights

Infrastructure and host-owned SQLite test consumers also follow the existing
worker ceiling, retaining isolated forks and fixture-owned home/state directories.
Directory-sensitive regressions run in joined child processes, and backup command
fixtures consume the invocation's prepared runtime. File parallelism does not add
compact groups, runner registrations, or a separate worker budget.

Gateway core, database-worker, methods, methods-isolated, server, and
server-isolated configs run with exclusive plan admission. Cold in-process
Gateway boot measured 37 seconds alone and 50 seconds under contention against
a 90-second test budget. Jobs containing these configs execute their packed
plans serially. Plan admission retains the existing summed duration budgets
and runner allocations; formerly parallel jobs retain
their two-worker ceiling through the job environment, except measured core-2
bins whose other groups retain that ceiling individually. This adds no jobs and
leaves ordinary jobs' concurrency unchanged. The shard runner enforces the same
config policy even when a caller requests two plans. Precise changed-test
selection retains the Gateway config owner and its admission metadata.
Gateway admission is finalized before runtime placement, so inventory changes
retain the admitted job ceiling instead of creating a different group policy.

The large workspace inventory proof runs in its own `agentic-gateway-core-inventory`
invocation, with exclusive plan admission in full CI plans. Its
13,000-file staging, apply, serialized journal, and recovery checks retain their
120-second deadline without competing with sibling Vitest files.

Within its exclusive plan, the Gateway database-worker cohort runs files in
parallel forks under the existing Vitest worker ceiling. Each fork retains the
non-isolated runner's file-boundary cleanup for native database owners, admission,
and module state. One worker still runs files serially; the file inventory and
no-output watchdog are unchanged.
Shared test port claims cover both child-process startup and in-process listener
lifetimes, including the handoff before a child binds its socket.

Gateway server files also run in parallel forks, with a two-worker compact cap
on every runner profile. The two native Vitest subprocess lifecycle fixtures run
first in a serial project within the same config; their cold Gateway collection
must not contend with ordinary files. The remaining files keep their parallel
phase. The planner retains each native fixture's measured cost and divides only
the remaining legacy serial work by the effective worker count; one-file groups retain
their indivisible cost. Whole parallel invocations and sums of split invocations
record separate timing identities. Singleton stripes restore the whole parent's
per-file cost without multiplying measured child spans again.
The existing file splitter and job packer consume those adjusted costs within
the unchanged row and duration budgets.

Complete hybrid main and pull-request plans retain their existing jobs and runner
allocations while admitting measured runtime groups within 440 seconds, including
the existing 100-second build allowance. This reserves 40 seconds of the
eight-minute objective for checkout/setup; it does not change test deadlines or
guarantee elapsed time. Only non-exclusive jobs without dist or private-QA
preparation participate. A whole runtime group can move to an already-required
equal-or-stronger runner only with its own explicit worker limit.

The recipient can already prepare a runtime or have spare ordinary capacity. An
ordinary recipient becomes serial and prepares one runtime; its previously
parallel groups retain their two-worker allowance through explicit pins. Their
prepared timing identities remain unchanged, preserving complete parent
generations. The CI executor applies the smaller of the supplied
job ceiling and group cap. When transfers have the same maximum estimate, the
planner prefers the recipient with more remaining time. This can add a runtime
build while reducing requested process concurrency, without adding a job or
runner registration. Count that preparation cost when verifying the result.

Both replacement bins must pass the shared family, group-count and budget
checks. If no transfer fits, CI retains the complete existing plan and reports
its over-budget estimate; an optimization cannot suppress test coverage.
Recipient capacity must preserve the donor job's fixed runner anchor, including
any earlier promotion of that group. Exclusive, private-QA, dist and hosted
policies remain unchanged. Precise changed-file plans retain their original
placement templates and admission floors.

The refit stores typed runtime-placement observations from the emitted group
descriptor, successful complete envelope and runtime-readiness marker. Configs,
group environment, complete file membership and prebuild mode accompany each
measurement. An exact matching observation takes precedence. When it is absent,
the largest compatible observation whose files are all still present supplies an
advisory floor. This retains known work after a file is added without summing
overlapping observations, borrowing another environment's cost, or interpreting
directory/glob selectors as complete files. A later exact measurement can lower
the estimate after an optimization.

These observations use the same independent-run sampling rules and apply only
after file splitting. They do not reconstruct a full parent or change the test
partition. Existing parent and exact-child timing keys retain their meaning.
Wrapper preparation is already included in each observation; the separate shared
runtime build is charged once per job. Unknown groups retain positive fallback
costs. Native evidence with the same inventory must verify latency, actual
resources and cleanup before claiming improvement.

`config/ci-test-timings.json` records CI measurements for UI and Gateway E2E files,
PR tooling files, and compact Node groups. UI and compact packers prefer active weights over their in-source cold-start
tables. UI E2E keys are repo-relative paths, including tests under `ui/src/pages/`,
and every file estimate includes the measured fork, import, and setup overhead.
Compact groups have separate Blacksmith and GitHub-hosted measurements, selected
from jobs API runner labels (`blacksmith-*` versus hosted `ubuntu-24.04`); hybrid
and large-group stripe adjustments continue to use their existing policies.
Compact weights use the complete `[shard:x] begin` to `end` span, preserving
process startup and any contention in the measured run. Ordinary Blacksmith compact jobs may execute two groups concurrently; serial
jobs retain `planConcurrency: 1`. The refit preserves each complete child span,
including contention, without subtracting setup or rewriting historical costs. Runner-profile
calibration remains a separate admission policy.

For split compact groups, the refit also records the parent cost from a complete
generation within one run and runner profile. It sums each part's median span,
takes the largest complete generation or direct parent measurement in that run,
and applies the same two-run minimum and median rules. The stable parent estimate
survives file additions and repartitioning, while exact child keys continue to
describe only their original inventory. Partial generations cannot create or
lower a parent estimate; observing a child preserves an existing parent during
pruning. Parts from different runs, profiles, or generations never form a total.

Gateway E2E uses the same greedy partition owner as UI E2E. Measured file durations
include suite hooks; new files use source bytes scaled by the discovered files'
measured seconds per byte. Without measurements, Gateway partitions use source
bytes alone. The CLI JSON suite is split by command family so its existing cases
can run across the four shards without an indivisible serial tail.

The compact plan is built once in preflight. E2E shards build their partitions
independently, so they must read the same committed file from the checkout. They
never download timing artifacts or consult restored timing caches. Missing or
invalid timing files, or `OPENCLAW_CI_TEST_TIMINGS=0`, use the cold-start estimates
for the entire file; stale keys cannot change the discovered test inventory.

With an authenticated `gh` CLI, run `pnpm ci:timings:refit` to regenerate the file.
Each invocation freezes one UTC upper bound and a lower bound seven days earlier.
Every run-list page uses both bounds. Returned run timestamps and successful job
timestamps outside that window fail validation.

The refit seeks up to five successful `ci.yml` push runs on `main` with parsed
compact measurements. Docs-only runs and unparseable logs do not fill that quota.
It also reads the newest five successful `ci.yml` `pull_request` runs for the
PR-only numbered tooling family. These tests execute the PR merge-ref, not a
canonical main revision; that provenance is appropriate for PR-only tooling.
PR logs update only `toolingFileSeconds`, never main compact or release weights.
Tooling measurements are collected ahead of planner activation: run `35506602947`
exceeds the current hosted and hybrid row caps when applied. Keep activation
separate until measured test improvements or approved capacity make every profile fit.
The map keeps separate Blacksmith and GitHub measurements. Numbered tooling
parents and their child timing keys change when files move, so per-file costs
can survive repacking and serve local tooling scheduling after activation. Unmeasured files use
the remaining cold hints or the positive two-second default.

Only successful complete tooling invocations contribute. Native file summaries
include suite hooks; older verbose-only logs supply summed case durations.
Those case costs exclude import/setup and can exceed wall time for concurrent
cases, so they are packing weights rather than claims of per-file wall time.
Retries contribute one median per file, profile and run. Ordinary refits require
two independent runs and retain the 15% write threshold. Partial PR plans do not
prove that absent files disappeared, so tooling maps retain unobserved files.

For an explicit reviewed seed, use `pnpm ci:timings:refit --tooling-run <id>`
(repeatable). It validates successful PR workflow and job metadata, permits a
single run only for tooling, preserves all other timing maps, and records the
seed run IDs and merge-ref provenance in `source`. The initial tooling seed uses
run `35506602947`; subsequent daily samples replace it under the ordinary rules.

It also samples up to five successful manual runs of each release-check workflow
that owns Gateway E2E. Run searches remain bounded by 25 pages and GitHub's
1,000-result filtered-query limit. Incomplete pagination fails without writing.

For each selected run, the refit captures `run_attempt` and enumerates attempts
one through that value. It verifies each job's run ID, attempt and workflow SHA
before reading successful, completed jobs. This retains original successful jobs
when a partial retry runs only failed jobs. Duplicate run and job IDs do not add
samples. Ordinary manual CI dispatches remain excluded because their measured
target can differ from the workflow head. Release workflows validate their
selected target before tests. Their workflow SHA identifies tooling, not the
measured source.

Use `--runs <n>` to change the run quota, not the seven-day window.
Use `--repo <owner/repo>` to select a repository, `--out <path>` to write elsewhere,
or `--dry-run` to report changes without writing. The report separates main and
release observations, including run IDs, attempts, workflow SHAs, creation dates,
parsed profiles and timing-job counts.

For a scoped repair using already downloaded main-job logs, use the same
`refitTestTimings` reducer with verified successful job metadata and the current
timing file. Preserve independent run IDs and runner labels. Two contributing
runs refresh eligible keys without enabling the three-run pruning rule for
unobserved groups; do not substitute job totals or local timings for child spans.
Keep the input run IDs and replacement table in the PR. The September 16 CLI
refresh used successful jobs in runs `35042635751` and `35044335386`: complete
child spans of 569.841 and 620.791 seconds replace the stale 136-second weight
with a rounded median of 595 seconds. Plugin fallback costs have a separate
estimator and are not inputs to this compact timing reducer.

The September 16 compact refresh sampled all 168 successful compact jobs in six
green main runs: `35117379165`, `35120372547`, `35123270863`, `35124135571`,
`35125714752`, and `35126089717`. Their 132 complete selector generations contain
no partial parent totals. The unchanged reducer supplies every replacement and
removal, retaining its independent-run minimum, outlier filter and 15% threshold.
The scoped output applies only its Blacksmith compact map; UI, Gateway E2E,
runtime-placement observations and hosted measurements retain their prior values.

| Compact family                |      Previous Blacksmith seconds | Six-run parent/span median | Refitted seconds |
| ----------------------------- | -------------------------------: | -------------------------: | ---------------: |
| Infrastructure storage/state  | 104 (unmeasured parent fallback) |                  1,403.158 |            1,403 |
| Doctor config/state           |  67 (unmeasured parent fallback) |                    614.943 |              615 |
| Runtime config                | 113 (unmeasured parent fallback) |                    847.352 |              847 |
| Infrastructure system/runtime |                               86 |                    692.647 |              693 |
| Gateway core-3                |                              167 |                    381.772 |              382 |
| Commands Doctor               |                               61 |                    304.648 |              305 |

Storage/state parts 2 and 3 measured 735.136 and 623.723 seconds; Doctor
config/state part 2 measured 505.405 seconds. Existing selector splitting turns
the hybrid storage/state family from three parts into ten, Doctor config/state
from two into five, and runtime config from three into six. Their complete file
inventories, process isolation, worker limits, naming scheme and timing-key
generation remain owned by the existing planner. Repartitioned children receive
new membership keys; the measured parent survives that change. Blacksmith also
adds Gateway core-1 and core-2 to its existing split-owner list after their
complete measurements reached 578 and 491 seconds. Hybrid and hosted already
split those owners. Standalone agent support retains its existing whole-group
contract.

Blacksmith-profile PRs changing the compact planner or committed timing file run
the complete compact core plan: focused planner tests alone cannot measure the
resulting packing. Hosted profiles retain precise changed-test targeting. This
uses the existing matrices and caps; plugin fallback keeps its separate owner.

The September 16 refresh retained three families' previous complete timing entries to avoid hosted expansion:
`agentic-gateway-server-isolated`, `agentic-gateway-core-runtime`, and
`agentic-agents-core-spawn-production-boundary`. Applying their Blacksmith refit
would have expanded the hosted fallback beyond its then-current 80-row compact cap. No two independent
recent hosted samples were available to calibrate them. That scoped refresh
therefore deferred those families rather than introducing extra hosted rows or
inventing hosted measurements. The unscoped refit and all observed overruns belong
in the PR evidence for a later capacity-aware refresh. The `agentic-cli-process`
family also retains its prior timings: distributing its new parent total by the
existing file weights prices an indivisible child at 239 seconds, beyond its
200-second contract. That family needs a separate file-cost refit; its assertions
and budget remain unchanged.

At the inspected inventory, hybrid compact descriptors change from 29 to 51 on
push and 53 to 75 on broad PRs; the maximum prediction remains 518 seconds for the
standalone CLI. At that revision, ordinary two-child bins remained within 360 seconds. Excluding dist,
the Node matrix uses 50 push rows and 113 broad-PR rows including 40 plugin rows,
within the then-current 64/120 caps. Blacksmith compact descriptors change from
34/52 to 59/77; the honest 804-second maximum belongs to standalone agent support.
Hosted plans remain byte-identical at 51/79 descriptors. Hybrid adds 22/22
registrations per push/PR, or 550 across the retained four-main/21-PR arrival
envelope; these rows consume existing reserved capacity, so the enforced
then-current 4,776-registration ceiling did not increase. Budgets and timeouts are unchanged.

The samples predate the 17:33 UTC runner-capacity restoration. They retain the
older allocation's contention, so these predictions are not a measured speedup.
Verify the restored eight-CPU/two-child admission, longest compact jobs, total
wall time and emitted registration counts on the PR and first main run.

Fewer than two independent main compact contributors fails the invocation.
It also fails if neither a compact key nor a runtime-placement observation meets the existing independent-run sampling rules.
Retained baseline weights and release measurements cannot satisfy these checks.
Both failures leave the timing file unchanged.
Measurements come only from successful UI E2E, Gateway E2E, and compact jobs; compact groups
also require an `exit 0` marker. Each entry needs at least two run samples;
multiple attempts within one run still contribute only one sample per key and
profile. Keys are pruned only when that profile has at least one observation in
each of at least three sampled runs, and only if the key is absent from every
contributing run. Profiles with fewer contributing runs retain all previous
keys; missing or unparseable logs do not count toward the threshold. Removals
remain explicit in the dry-run and PR change tables.
Samples above 2.5 times the key's median are discarded before taking the median,
and existing weights stay unchanged when the new median is within 15%. UI E2E
overhead is the median shard `(wall - body) / fileCount`, clamped to 0–5 seconds.

An empty `compactGroupSeconds.github` map is designed cold-start behavior:
main compact jobs normally run on Blacksmith, so the hosted profile keeps its
in-source `COMPACT_GITHUB_GROUP_SECONDS_HINTS` fallback until hosted observations
meet the sampling minimum. Later main attempts on the hybrid backend, or main
runs using `OPENCLAW_CI_RUNNER_BACKEND=github`, can fill it naturally. Once recorded,
hosted weights survive all-Blacksmith windows: pruning requires observations
from at least three hosted runs in the sampled window. Compact group sampling
stays main-only; PR samples influence only the separate tooling file map.

The `CI Test Timings Refit` workflow runs daily at 09:43 UTC and supports manual
dispatch on `main`. When weights change, it updates the single
`ci/test-timings-refit` branch and PR with sampled run IDs and the changed-entry
table. It never pushes to `main`; unchanged weights produce no commit or PR
update. The gitignored `.artifacts/vitest-shard-timings.json` remains a separate
whole-config timing cache for the local test-project runner, not an input to
these CI packers.

The shared generated-PR publisher refreshes `main` and rejects stale generator
inputs or overlapping timing-file changes before its leased branch push. It
uses separate repository-scoped GitHub App tokens for branch and PR writes;
the workflow's `GITHUB_TOKEN` has only contents-read permission. App-created
events trigger CI without the `GITHUB_TOKEN`-specific workflow approval step.
Normal repository review and required checks still apply; this workflow does
not enable auto-merge. See
[GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## Bounded hybrid hosted offload

Automatic canonical hybrid first attempts count the complete selected hosted inventory before adding short jobs: control and cache jobs, every selected check or Node matrix row, docs and i18n, performance, and hosted native jobs. Preflight records `hybrid_hosted_base_rows`, `hybrid_hosted_total_rows`, and `hybrid_hosted_offload`; the workflow guard independently expands the actual job gates, matrices, and runner expressions to verify the count. Eligible preflight runs on Blacksmith and is excluded from hosted rows; the performance row uses its canonical `run_control_ui_performance` owner.

`HYBRID_HOSTED_BASE_ROW_LIMIT` is 40 and `HYBRID_HOSTED_ROW_LIMIT` is 45. At or below 40 base hosted rows, preflight may move `security-fast`, the three `checks-ui` rows, and the browser-extension E2E row to hosted Ubuntu, adding at most five rows and never exceeding 45 through this admission. Above 40 base hosted rows, all five retain their existing Blacksmith routes. An eligible base above 45 emits a warning with the row count and retains the complete base manifest. The 45-row budget bounds optional offload admission; it does not reject existing coverage or reshape noneligible fallback manifests: retries, manual and frozen targets, untrusted authors, other repositories, and the `github` outage override retain their existing routing, including wholly hosted runs that can already exceed 45 rows.

After that admission, canonical main pushes and trusted Windows-selected PRs with a full compact Node plan and at least 500 predicted seconds in one serial row can move five measured check rows to hosted Ubuntu: dependencies, both core test-type stripes, extension package boundaries, and runtime topology architecture. The separate `hybrid_hosted_checks` decision requires fresh healthy [assignment evidence](/ci/runners#hybrid-hosted-assignment-guard) and enough room for every selected check within the same 45-row limit. Precise PRs without that measured latency floor retain their existing routes.

Main pushes then consider lint, central test types, and artifact builds under `hybrid_hosted_main_checks`. These jobs use at most four observed CPUs and had at least five minutes of finish slack in every sampled main run. Their slower hosted execution is acceptable for main's thirty-minute objective; PRs retain Blacksmith for all three jobs. This admission consumes only the remaining hosted capacity and fails closed with the five-check decision. It does not change their timeouts.

Control UI E2E shards, QA Smoke, real-Gateway checks, and Android retain their existing routes. Test inventory and worker limits remain unchanged. Security waits for preflight's original budget decision and still runs after a preflight failure unless the workflow was canceled. Hosted assignment delay and ordinary cache setup can offset compute savings, so compare the first exact-head run's hosted/Blacksmith row counts and queue times before widening admission.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
