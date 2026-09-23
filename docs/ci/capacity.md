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

Every admitted canonical main run selects the published-upgrade tripwire in the
reserved `docker-seed-e2e` job, so the retained peak envelope stays
`4 × 150 + 21 × 210 = 5,010` registrations.
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

Small precise PR changes use a focused Node plan. Broad, deleted or unknown changes retain compact core plus the affected plugin fallback; canonical pushes use the integration compact. Every compact planner profile is capped at 90 rows, and plugin fallback packing is capped at 50. The final canonical Node matrix also enforces 70 push rows or 130 PR rows, including precise plans. Missing changed paths, missing current planner capabilities and planner errors fail preflight instead of emitting an incomplete successful matrix. Approved historical dispatches retain their full named plans. Count every emitted matrix row and nonmatrix job, including the conservative six-row Android inventory, independently of concurrency.

Android retains four normal rows and six full-manual rows. Normal same-repository canonical first attempts on Blacksmith overlap all four rows; the GitHub override, retries, manual dispatches, forks, and noncanonical repositories retain two. Reassigning app lint to the existing Wear and Kotlin-lint rows adds no jobs or registrations. A three-row cap kept every job below ten minutes but left a 941-second Android span in [run 35812544118](https://github.com/openclaw/openclaw/actions/runs/35812544118), so normal runs admit all four independent rows together. The conservative six-row allowance and `4 × 150 + 21 × 210 = 5,010` registration envelope remain unchanged, below the 6,000 operating target against the 10,000 live bucket checked on September 23, 2026. This allowance does not establish physical runner availability or a measured wall-time improvement.

Preflight reserves the actual appended plugin Node rows before packing compact
core work. Hosted tooling tail compaction therefore starts when the remaining
Node budget is exceeded, even below the standalone 90-row compact cap. Dist
descriptors belong to their separate matrix and do not consume this Node budget;
they still count toward the compact cap. The existing file-owner splitting,
timing weights, process boundaries, runner requirements, and admission limits
remain authoritative. If compaction cannot fit the complete inventory, preflight
fails instead of dropping work or increasing either cap.

The approved row-cap increase raises compact plans from 80 to 90 rows and final Node matrices from 64/120 to 70/130 push/PR rows. It reserves room for the measured isolated Gateway-server family and measured plugin-envelope packing. At the limits, each run can admit six more Node registrations on push or ten more on PR; compact rows are already included in that total. Across the retained four-main/21-PR arrival envelope, the increase is `4 × 6 + 21 × 10 = 234`, taking the conservative ceiling from 4,776 to 5,010. Runner classes, workers, matrix concurrency and timeouts retain their existing policies. The cap increase alone does not establish a runtime improvement.

Full manual Node plans split the Gateway isolated/database-worker cohort with
the existing 64-file envelope limit and deterministic file weights. Run
35727279415 exhausted its 60-minute job after completing the 18 isolated files
and passing cases from only 137 of 235 database-worker files. The current 257-file
inventory now occupies five complete, disjoint stripes, adding four manual jobs
while preserving both configs, two workers and the job deadline. Dispatches
route these rows to GitHub-hosted runners, so the split adds no Blacksmith
registrations. Compact main/PR planning and the 90/70/130 row caps are unchanged;
neither the file limit nor advisory weights guarantee a wall time.

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

Precise and fallback plugin envelopes share the same packing owner and a 300-second aggregate estimated budget per job, including multiple envelopes of the same config. This budget belongs only to changed-extension jobs; compact core budgets are unchanged. Members retain compatible runner/dist requirements and run one at a time. Packing retains each produced envelope's child process, environment, native shard arguments and include scope, including process-bounded Codex, Matrix and Telegram work. Runtime-preparing envelopes remain separate, and an envelope above the budget stays alone. Worker limits, runner classes, timeouts, coverage and serial stop-on-failure behavior are unchanged.

On the September 22 counting inventory, increasing this admission budget from 240 to 300 seconds packs the same 119 envelopes into 40 instead of 47 jobs. Their aggregate estimated work remains 10,140 seconds. Seven fewer checkouts/setups save an estimated 315–420 machine-seconds at 45–60 seconds per job. This is a packing projection, not measured elapsed-time proof; see [routing costs and the 15-minute qualification](/ci/routing-costs). All four row caps remain unchanged.

For explicitly bounded plugin configs, the prerequisite owner identifies files that need a built runtime. When those files span multiple envelopes, the producer groups them before applying the existing file limits, so unrelated tests do not cause repeated runtime builds. Each resulting envelope retains its actual prerequisite charge and measured file costs. Whole-config native Vitest shards retain their complete discovery and preparation contract.

Most fallback rates use median wrapper seconds per counting file from 371 successful envelopes across four contributing PR runs in a ten-green-run sample: [35490342736](https://github.com/openclaw/openclaw/actions/runs/35490342736), [35490482496](https://github.com/openclaw/openclaw/actions/runs/35490482496), and [35491344005](https://github.com/openclaw/openclaw/actions/runs/35491344005). The 27-config table includes Feishu at 0.411 seconds/file. Existing runtime preparation allowances remain conservative additions to these fallback estimates.

The Codex rates were refreshed after the app-server fixture began reusing database workers. The newest three successful qualifying PR runs at the September 20, 2026 21:25 UTC cutoff were [35537834254](https://github.com/openclaw/openclaw/actions/runs/35537834254), [35537743091](https://github.com/openclaw/openclaw/actions/runs/35537743091), and [35537672782](https://github.com/openclaw/openclaw/actions/runs/35537672782), all on two detected CPUs with a two-worker budget. Ordinary Codex envelopes, then serial, have a median rate of 2.490 seconds/file across 78 observations. The database-worker config's overall median, which includes Codex, changes from 7.582 to 7.599 seconds/file across 114 envelopes. Explicit database-worker app-server files use a conservative 17.31 seconds/file, rounded up from the slowest 11-file envelope's 190.394 seconds; the previous floor was 46.26. This keeps the native tail visible above the mixed config median. Summed case time is a different measure: those app-server files averaged 11.672 seconds across 207 file observations. The wrapper rates already incorporate worker scheduling and must not be divided by the worker count again.

This calibration preserves execution policy: ordinary Codex files remain serial and non-isolated, database-worker-routed Codex files retain isolated forks, and both keep their 12-file process bound. The 300-second no-output watchdog and test deadlines remain unchanged. Weight changes affect packing and predictions, not per-file scheduling.

The landed caps are 90 compact rows, 130 final PR Node rows and 70 final push Node rows; changed-extension fallback retains its 50-row cap. At the earlier 240-second budget, replaying PR #153435's 38 changed paths and a broad SDK fallback on the `9034c0aa` counting inventory with the refreshed Codex rates emitted 124 envelopes in 48 extension rows, down from 50 rows with the same envelope inventory and process bounds, for both changed sets:

| Profile    | Compact PR rows | Final PR Node rows before → after | Final push Node rows |
| ---------- | --------------: | --------------------------------: | -------------------: |
| Blacksmith |              76 |                         124 → 122 |                   56 |
| GitHub     |              82 |                         130 → 128 |                   54 |
| hybrid     |              72 |                         120 → 118 |                   47 |

Compact PR counts include two dist descriptors outside the Node matrix. Compact and push counts are unchanged because these Codex configs are outside compact groups, and canonical pushes do not append changed-extension envelopes. The largest Codex prediction falls from 609 to 291 seconds, including the existing 100-second runtime-preparation allowance. The remaining extension floor is 380 seconds in a non-Codex database-worker group. Overall longest predicted rows are 623 seconds on Blacksmith, 380 on GitHub, and 518 on hybrid. Every profile fits the landed caps, and the conservative registration ceiling remains the landed 5,010 bound.

With the effective-config ceiling and prerequisite grouping applied to the `f5138cb0b27f` inventory, broad fallback covers all 482 database-worker files exactly once in 47 jobs, with at most 20 worker files per job. The all-packaged-plugin precise plan covers 478 worker files in 47 extension jobs plus one selected core-test job; broad fallback additionally owns four built-in plugin files. Blacksmith, hybrid and GitHub final broad PR Node counts are 119, 113 and 125; push counts are 54, 44 and 49. Regular Codex runtime consumers share one prepared envelope instead of three, and Telegram consumers share one instead of two. The sole prepared database-worker envelope retains its original 11-file scope and the refreshed 291-second estimate. The total forecast is 10,167 seconds. These are planner counts and estimates, not new runtime measurements. The shared packing algorithm, current measured rates, time budgets and all row caps are unchanged.

Median rates are estimates, not elapsed-time guarantees. Before the Codex fixture change, replaying the historical 123-envelope layout against the largest matching observed child spans gave a 432.758-second combined envelope sum at 240 seconds, versus 520.688 seconds at the interim 320-second budget; its slowest individual envelope took 508.783 seconds. Whole-config observations can have different file inventories across source revisions. These are historical forecasts, not measured walls for the current combined jobs. The original job in run 35490342736 bundled 17 envelopes into 2,015.674 seconds of child spans and 2,049 seconds of wall time despite a 240-second prediction. Native PR CI must verify the improvement toward the ten-minute PR objective. Exact config/include-set observations and successful PR-run ingestion in the timing refit remain follow-up work; narrow PR samples must not prune unrelated observations merely because they were not selected.

GitHub-hosted core storage/state stripes also have a 64-file admission ceiling. In [run 35477045216](https://github.com/openclaw/openclaw/actions/runs/35477045216), a 203-file serial stripe continued passing tests until the one-hour job deadline; its 196-file sibling completed in 2,867 test seconds. The compact split owner bounds each hosted prerequisite-preserving stripe independently of older timing estimates, and the existing distinct-family rule prevents reassembly in one job. Blacksmith and hybrid retain their existing measured partitioning. Every file remains covered once, with fork isolation, serial file execution, worker limits, deadlines, and the 90-row compact cap. This is a workload bound, not a measured new runtime; hosted CI must establish the resulting duration.

Eligible Blacksmith and hybrid compact bins with multiple ordinary groups request the existing 32-vCPU runner with two child-process slots. Initial packing retains the 360-second aggregate budget and completes Gateway serialization, runtime placement, and worker pinning before compaction. Only jobs already admitted on the 32-class with two child-process slots are then repacked into 500-second bins. Those jobs may share capacity across logical runner classes while each child retains its original runner metadata and worker ceiling. Existing serial jobs retain their membership, ordering, estimates, and worker limits; widening their initial packing can concentrate slow Gateway work even when their final estimate remains below 360 seconds. Compatible parallel groups can fill the new budget without the ten-group cutoff retained by serial jobs. Blacksmith serial jobs retain their 200/276-second budgets; hybrid serial jobs retain 210 seconds. Exclusive jobs retain 150 seconds by default. Only complete ordinary hybrid bins of non-build CLI groups may use 250 seconds and share split siblings; every child must still fit 150 seconds. Groups above their existing serial cap stay alone. Exclusive groups, original single groups, dist descriptors and jobs with runtime preparation remain serial. Hybrid exclusive and dist bins retain their existing prerequisite sharing. The shard executor admits at most two processes only when the actual host has at least eight available CPUs and 24 GiB of memory; smaller capacity admits one. Each overlapping child keeps two Vitest workers, including a singleton left after compaction; inner project parallelism remains one. Commands files follow the measured worker allocation in serial self-hosted rows, with a two-worker fallback for hosted, constrained, frozen, or overlapping execution; the existing non-isolated fork runner retains file-boundary cleanup. The primary `github` profile stays serial at 210 seconds. Preflight records the actual row count for each source revision; canonical inventory comparisons must preserve every original child plan and test input. Native elapsed-time, memory and cleanup evidence must establish the actual effect.

The `github` compact planner can place smaller ordinary groups on an already-required stronger logical runner. Each emitted job retains its strongest capacity owner, serial execution, original child processes and worker limits, the 210-second budget, and the ten-group limit. SDK and plugin runtime consumers are separated from ordinary files before packing; the SDK light project intersects shared include lists with its own inventory. Parent-derived fractional costs are rounded only at the emitted job boundary, so rounding small consumers cannot create a redundant runtime build. The shared packer can exchange groups to fill compatible capacity while rechecking complete replacements. Runtime-only hosted groups may share their strongest prerequisite within the existing 210-second serial budget; the build itself costs 160–166 seconds and is charged once per job. No-build exclusive groups keep their 150-second limit. Stranded tooling tails are sized against remaining compatible capacity before normal admission is reapplied. Exclusive, dist, oversized, and runtime-preparing bins retain their separate constraints.

The September 16 capacity repair removes the blanket post-packing 32-to-16 downgrade and the three named compact 32-to-16 overrides. On the inspected inventory, 18 existing hybrid jobs per push or broad PR return to the 32-class; the Blacksmith profile restores 19 push or 36 broad-PR placements, including agent-support and tooling. This changes zero total runner registrations and adds no hosted rows, so the conservative 5,010-registration envelope remains unchanged. Restoring real-Gateway E2E adds one 32-class assignment when that job is selected, for 19 hybrid assignments in total on this inventory, still with zero additional registrations. Other workflow sizing remains in place. These counts depend on the inventory; verify the emitted plan and actual eight-CPU/24-GiB admission before claiming a wall-time improvement.

Failed-job-only hybrid retries retain their original matrix and its admitted aggregate estimates when routing to hosted Ubuntu. They do not repack to 210 seconds. The existing capacity gate reduces concurrency to one on those hosts, while the retained two-slot descriptor keeps the two-worker child budget. Such retries can exceed the eight-minute normal-run objective; existing 60/120-minute job deadlines and watchdogs are unchanged. Requested runner labels do not establish actual CPU or memory capacity.

The final Node matrix admits longer estimated jobs first across compact and plugin descriptors. Plugin estimates reuse the extension batch cost owner, including existing process boundaries; runtime preparation is charged separately from the same prerequisite table used by compact jobs. Equal estimates and historical descriptors without estimates keep their original order. The 96-job concurrency ceiling bounds active jobs, while the manifest caps bound total admissions. In run `33449014227`, all 96 slots were occupied when the late QA job started; that dependency delay was matrix admission, not evidence of runner-registration throttling.

Expanded serial large/small jobs admit 210 predicted seconds; eligible hybrid parallel bins initially admit 360 before the final parallel-only compaction to 500 seconds. All profiles retain the shared 90-row compact cap. The 150-second file-split and default exclusive-group budgets stay unchanged; complete non-build CLI bins alone may use the 250-second ordinary hybrid admission budget. The PR-only performance lifecycle file retains its 136-second fallback from native spans of 127.288/135.808 seconds in runs 33532741896/33545657559; canonical pushes omit that tooling family. Trusted contributor forks can use the GitHub profile on Blacksmith, so every profile participates in the same registration bound. The widest current workflow profiles retain up to 87 other potential rows (14 nonmatrix and 73 matrix), or 88 for historical targets without the UI named-project contract. The conservative cap-based envelope already includes twelve Control UI shards plus the browser-extension row on every profile. Excluding the four unconditionally hosted iOS rows, three hosted macOS Swift phases, and the hosted aggregate gate gives the conservative ceiling of 80 potentially eligible rows. This includes the new Control UI performance job; keep the ceiling rather than spending savings from consolidated checks. With the final Node caps, the bounds are 150 registrations per main run and 210 per PR. Two active main slots, both pending successors and the observed peak of 21 non-skipped PR arrivals give `4 × 150 + 21 × 210 = 5,010` registrations in five minutes. This leaves 990 within the 6,000 reference operating target for release work, adjacent repositories and carryover; it does not prove those arrivals fit. The earlier 19-arrival estimate is obsolete. Using the prior 4,826-registration reference, the bounded 2026-09-02 cohort audit counted 321 unassigned Blacksmith jobs and reserved nine auxiliary rows, giving `4,826 + 321 + 9 = 5,156` planned registrations and an 844-row allowance below that reference. Its 40 exact attempts covered 4,830 jobs; queued observations spanned 21:50:48–21:57:11 UTC and were not simultaneous. Already-assigned jobs, old approval-waiting runs, unobserved retries and unlisted organization work remain outside that cohort, so this is a conditional planning bound rather than a live organization balance. Evaluate a single PR trial using its actual emitted rows separately from the rollout model. Budget all six npm qualification jobs and the relevant full-release children; a shared-token quota response or unused bucket does not establish organization-wide usage or physical runner capacity.

`checks-ui-e2e` emits nine rows for ordinary canonical PR/main plans with the named-project contract and a known changed-path inventory: eight weighted Control UI shards and one browser-extension row. Full manual inventories, forks, and unknown changed paths retain thirteen rows. This removes four Blacksmith registrations from each eligible ordinary run without increasing the existing registration ceiling. Control UI shards use the 16-class; the browser row uses the 8-class unless admitted to hosted Ubuntu by the bounded hybrid plan. Historical targets without the contract retain four total rows on the Blacksmith planner profile or fourteen on GitHub and hybrid profiles. The 2026-09-02 inventory at `49fb9c5` contains 359 files: 329 parallel bundle consumers, three parallel self-owned files, seven serial bundle consumers, and 20 serial private source/custom-build files. Ordinary CI excludes seven real-Gateway files, leaving 352. Four native projects represent resource ownership without adding jobs or execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` share group 0 with two workers by default or three in ordinary CI, then `ui-e2e-serial` and `ui-e2e-serial-standalone` share group 1 with one worker. Local throttling and explicit worker limits still apply. The shared weighted sequencer charges each file by its measured duration divided by that project's effective worker count and assigns every discovered specification once across the selected Control UI rows. The root config keeps the complete inventory visible for discovery. Serial scheduling still protects private source servers that share a Vite optimizer cache, real Gateways, and the runtime-budget measurement; test cases, deadlines, and isolation are unchanged.

Every selected project discovers Chromium. The first selected bundle-consuming project builds one private production bundle/preview and publishes its URL through Vitest's invocation-scoped root context; later consumers share it until invocation teardown. Standalone projects have no bundle setup or URL bridge, so standalone-only selections skip that build. Enabled manual proof capture uses the shared upload directory, including the MCP and Logs suites.

Ordinary and real-Gateway Control UI jobs upload only allowlisted `failure.public.json` summaries and retain them for seven days, with separate artifact paths for each job and run attempt. Raw `failure.private.json` reports and `failure.private.png` screenshots remain local and are excluded from these uploads. Older frozen targets without the public summary produce no matching upload; raw captures are never a fallback.

The dedicated real-Gateway lane partitions its complete selected inventory into two jobs through `createUiRealGatewayTestShards` and `test/vitest/vitest.ui-e2e-prebuilt.config.ts`. The serial row owns files outside the audited parallel allowlist and the single desktop transport proof; the parallel row owns the allowlisted files. The planner and Vitest config consume the same allowlist in `vitest.ui-paths.mjs`. Each job requires a clean checkout and completed runtime, private QA, and canonical Control UI artifacts from `OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm build`; `build-artifacts` retains SDK declaration generation and validation. Source and built outputs stay unchanged until all workers and children finish, and readiness failures stop without rebuilding or falling back. Audited fixtures keep their private HOME, state, ports, cleanup, and existing two-worker bound. Only selected invocation-preview consumers acquire a private UI bundle. Frozen targets and planners predating the split retain one complete job; the ordinary local config keeps its serial policy.

The original two-worker rollout had a controlled Linux comparison covering its then-complete inventory of 14 files and 25 tests, reducing invocation elapsed time from 309.374 to 202.027 seconds. Those historical results do not measure later allowlist additions, complete CI timing, or achievement of the CI latency target.

Eligible `control-ui` rows request `blacksmith-16vcpu-ubuntu-2404`; the browser-extension row keeps the 8-vCPU request when optional hosted admission is closed, and eligible real-Gateway jobs request the 32-class. Backend, event, contributor-trust and cache-write boundaries are unchanged, including hybrid first attempts and trusted contributor forks. Historical [run 33692146223](https://github.com/openclaw/openclaw/actions/runs/33692146223) had two slowest UI rows requesting the 8-vCPU label but reporting two CPUs; their 356/383-second test steps set the 8:20 non-Windows wall. That run's 32-vCPU jobs reported eight CPUs. The larger request added no workers. In historical [run 33695337496](https://github.com/openclaw/openclaw/actions/runs/33695337496), all twelve UI rows on the 32-class reported eight CPUs and finished by 4:38 from workflow creation, with 102–145-second test steps. Those measurements do not establish timings on today's 16-class route. Stale file weights still need the existing refit's independent-run and replacement thresholds, rather than a one-run manual adjustment.

In [run 35028248954, UI job 6/7](https://github.com/openclaw/openclaw/actions/runs/35028248954/job/104582299257), the six-shard Control UI plan requested the 16-class and reported four CPUs. Setup took about 3m45s before the test command. The job recorded 168 passing tests and three failures before cancellation about 25m07s after runner startup; a test completed three seconds before cancellation. The twelve-shard plan still needs native CI timing proof, and widening the plan does not resolve those assertions or guarantee completion within the unchanged deadline.

The two real-Gateway rows retain the existing 32-class request. They add one job and one possible registration when this proof lane is selected; ordinary PR admission still omits the lane. Blacksmith budgets remain 20 minutes and hosted budgets 40, with unchanged test deadlines. The earlier 16-class delivered four CPUs and canceled a progressing unsplit suite at 1,227 seconds in [run 35120538555](https://github.com/openclaw/openclaw/actions/runs/35120538555/job/104877350907). The split does not change backend, contributor-trust, retry, or cache routing.

The browser-extension row prepares only its native-host runtime JavaScript and assets through the existing `qaRuntime` build profile rather than rebuilding declarations and the Control UI. Both the nine-row ordinary plan and thirteen-row full-inventory plan stay inside the existing conservative registration bound. A failed-job-only retry retains its previously emitted matrix, including older plans with six Control UI shards. PR retries and hybrid push retries select hosted Ubuntu through live routing, so they may take longer; the existing 25-minute timeout is unchanged. Rerunning preflight selects eight Control UI shards for an ordinary known-inventory plan, or twelve for complete validation, plus the browser-extension row. Matrices emitted before worker metadata existed retain the two-worker fallback. Canonical push retries on the Blacksmith profile retain Blacksmith routing. The `max-parallel` ceiling stays 14 for historical targets without the named-project contract, which retain their previous width. Physical capacity must be checked separately from the registration bound.

The previous thirteen-serial-shard layout consumed 4,258 job-seconds in successful [run 33494931388](https://github.com/openclaw/openclaw/actions/runs/33494931388) on 2026-09-01, averaging 327.5 seconds per Control UI row; preflight added 39 seconds and the tail row took 363 seconds. The current projects reduce the modeled body through bounded bundled concurrency. In run `33638745824`, twelve successful first-attempt Control UI rows had median/p90 test steps of 197/235 seconds, while their checkout median reached 116.5 seconds. Reducing thirteen Control UI shards to twelve removed one repeated checkout and setup without combining the separate browser-extension work. The current Control UI target is eight minutes per ordinary job within the fifteen-minute PR/main workflow objective. Measure queueing, checkout, setup and test work separately; the final gate still waits for the other selected jobs. The historical serial layout and the single hosted retry are not paired performance comparisons.

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

Group pins can lower these ceilings. The `agentic-gateway-core-2`,
`agentic-agents-embedded-base-*`, `agentic-agents-embedded-run`, and
`agentic-agents-tools` families, commands groups, and the whole `agentic-cli`
group use measured workers on Blacksmith and hybrid profiles, with
`fallbackMaxWorkers: 2`. Full CLI bins request
`blacksmith-32vcpu-ubuntu-2404` after packing and retain serial execution. The
observed eight-CPU/30.95-GiB allocation can admit eight workers; actual CPU,
memory, and load still determine the ceiling. The shard runner applies the
two-worker fallback on hosted, frozen, constrained, or overlapping execution,
intersected with any lower job or group limit. The four-CPU/15.42-GiB 16-class
allocation receives that fallback even when the workflow ceiling is three.
GitHub-hosted planning, `agentic-cli-process`, and other timing-sensitive groups
retain their existing pins. Gateway plans still run exclusively; unproven
siblings sharing its serial bin retain their two-worker group caps. The CLI
inventory, split policies, timing weights, and admission budgets are unchanged.

The `agentic-gateway-server-isolated` family, including its database-worker
config, is capped at eight workers on Blacksmith and hybrid profiles and
additionally requires 28 GiB total memory. Its historical 20.70 GiB peak fits
within 75% of that floor, leaving at
least 7.30 GiB for the runner, operating system, and variation. Smaller hosts,
hosted retries, frozen targets, and overlapping plans retain its two-worker
fallback; the independently planned GitHub profile is unchanged.

The historical [September 20 paired probe](https://github.com/openclaw/openclaw/actions/runs/35543209292)
at source `39b3aa10677c99af54e3bffb43cadf3bb6c89eb8` used the same eight-CPU,
30.95 GiB, Node 24.19.0 Testbox for a fixed 2/8/8/2
sequence, with fresh JavaScript cache paths for each round. Every round ran the
same 114 files and passed 2,776 tests with one existing skip. Two-worker walls
were 481.535 and 474.459 seconds; eight-worker walls were 225.123 and 225.151
seconds, a 52.9% reduction in the midpoint. Peak summed process RSS rose from
8.71 to 20.70 GiB, and aggregate user plus system CPU increased about 8.1%.
No descendant processes survived a round. The remaining 14 runtime-bearing
files also passed at eight workers, with 39 passing tests, one existing skip,
and 14.96 GiB peak summed RSS. These measurements cover that source's 128-file
cohort. Its inventory and shared Gateway fixtures have since changed;
candidate-specific functional, memory, and cleanup proof must be recorded
separately. The 52.9% result does not establish a current-source or whole-CI
speedup. Existing two-worker timing generations stay
as advisory floors until the normal complete-group refit replaces them.

Commands splitting and packing retain the conservative two-worker retry budget.
After placement, their predicted child seconds use the expected allocation:
eight on uncapped serial 32-class rows and two on constrained or overlapping rows, capped
by file count and bounded below by the longest file. Runtime preparation is not
divided. Separate timing identities preserve direct two/eight-worker samples;
new parallel observations are not divided as though they were serial. Live
CPU load and memory pressure can lower the scheduler's allocation.

Embedded base, attempt-runner, and tool files follow the shared scheduler's file
parallelism. The base keeps three balanced stripes for its large harness files;
the separate overflow-compaction and incomplete-turn configs remain serial.
Parallel agent wall times use distinct timing keys. Until those measurements
arrive, the planner divides legacy serial costs by two effective workers while
retaining the largest indivisible file's cost. Fresh parallel measurements
replace that fallback without another discount.

Agents-core files share the configured worker pool, including local scheduling
and its one-worker throttle. Compact agents-core groups retain a two-worker cap.
Their initial estimates divide serial timing history by the effective file
workers, preserving the cost of an indivisible file. Separate parallel timing
keys let subsequent measurements replace those estimates without being divided
again. The file inventory and import-heavy CLI stripes remain unchanged.

Tooling files use the shared worker scheduler instead of forcing one file at a
time. Compact tooling groups retain their two-worker cap and exclusive child
admission. Their planner estimate uses current file costs divided by the effective
worker count, bounded below by the longest file; a single slow file cannot benefit
from file parallelism. Historical serial group totals no longer floor those
estimates. Docker helper fixtures retain their separate serial config, and the
isolated tooling config keeps fresh module state without disabling file parallelism.
Focused tooling plans defer unrelated full-suite inventory discovery and retain
both the boundary and built TUI checks. Other precise selections and broad plans
keep their complete canonical owners.

The specialized Codex, Slack, Telegram, package-contract, and release-only plugin
configs also inherit file scheduling from the worker ceiling. Codex, Telegram,
package contracts, and plugins keep isolated module graphs. Slack uses file-local
transport fixtures and the existing runner's module cleanup between files, so
forks can reuse their prepared dependencies. Slack and the plugin runtime use
forks for the application main-thread SQLite worker broker. Ordinary
Telegram files share a process within each existing ten-file job envelope, while
native Telegram database-worker files retain their one-file process lifetime.
The plugin shard stays release-only. These changes reduce process overhead and
allow file concurrency without expanding the job inventory or worker budgets.
Slack and Telegram multi-file estimates conservatively discount their historical
serial rates by 1.2 after two-worker qualification. Singleton and native-worker
costs stay unchanged; new parallel measurements replace those serial references
without another discount. Packing saves one Node PR row on each runner profile,
with unchanged compact and push budgets.

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

Docker seed runs one published-upgrade survivor on every admitted canonical main
run; QA Smoke retains owner-path selection. Ordinary manual CI and Full Release
Validation select all six Docker seed lanes. Main builds the complete runtime
and public SDK declarations through `ciArtifacts` before canonical packaging;
manual/release runs retain full package generation. Pull requests and their
exact-head fallback dispatches omit these jobs,
real-Gateway UI, and named built-process verifiers. Unit/boundary and mocked
Gateway coverage remain. The complete-file proof inventory belongs to
`scripts/lib/ci-proof-test-inventory.mts` and applies to precise and compact PR
plans after owner resolution. Retained main proofs and the full manual inventory
keep every assertion.

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

| Lane                            | PR coverage                                                                                             | Main/manual and full release coverage                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Docker seed                     | Selector, scheduler, update/Doctor/state unit and boundary owners                                       | Published-upgrade survivor on every admitted canonical main run; all six lanes on ordinary manual/release CI |
| QA Smoke CI                     | QA plan, catalog, transport, lifecycle and channel unit suites                                          | Owner-selected main; complete supported smoke profile on manual CI                                           |
| Real-Gateway UI                 | UI units and mocked-Gateway browser projects                                                            | Existing selected main/manual real-Gateway inventory                                                         |
| Built process proofs            | Browser registration, Doctor persistence, Discord multipart, SQLite store, watch and TUI boundary tests | Native host, Doctor, Discord, SQLite, watch and TUI canaries in build-artifacts                              |
| Doctor refusal / Codex recovery | Doctor admission/repair and harness replacement/cancellation boundaries                                 | Complete files in main/manual Node plans                                                                     |
| Windows                         | All 133 native unit/boundary/process files in measured whole-file rows                                  | Same inventory, historical targets retain their package commands                                             |

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
their two-worker ceiling through the job environment, except measured Gateway
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
Every run-list page uses both bounds. Returned run creation timestamps outside
that window fail validation. Before downloading logs for a run, the collector
validates all captured attempts' job metadata. Successful jobs with missing
completion, invalid provenance, stale starts, reversed chronology, or completion
after the metadata observation time still fail validation.

A run created inside the window can finish after its frozen upper bound while
earlier cohorts are being collected. When otherwise valid successful jobs end
after that cutoff, scheduled sampling skips the entire run, reports its ID and
cutoff, and seeks a replacement without consuming the sample quota. It never
downloads that cohort's logs or drops only the late jobs into an apparently
complete inventory. Explicit `--tooling-run` requests instead fail with the run
ID and cutoff; neither path moves the window.

The refit seeks up to five completed `ci.yml` push runs on `main` with a success
or failure conclusion and parsed compact measurements from successful jobs.
Cancelled, timed-out, neutral, and other workflow outcomes are excluded.
Docs-only runs and unparseable logs do not fill that quota. Failed workflows
supply positive timing samples only: their missing jobs never count as evidence
for pruning absent keys. Successful workflow cohorts retain their existing
pruning policy, including when mixed with failed-workflow samples.
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
Main pages contain up to 100 runs so cancelled tips do not exhaust that search
before contributing runs; the requested contributor quota remains unchanged.

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
workflow conclusions, parsed profiles and timing-job counts.

For a scoped repair using already downloaded main-job logs, use the same
`refitTestTimings` reducer with verified successful job metadata and the current
timing file. Preserve independent run IDs and runner labels.
Set each run's `completeInventory` fact explicitly: successful workflows may
supply pruning evidence; failed or partial workflow inventories may not.
Two contributing runs refresh eligible keys without enabling the three-run pruning rule for
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

The September 21 isolated Gateway refresh replaces its original one-file
30-second weight with 1,043 seconds. The unchanged refit reducer measured the
complete child spans in the newest five successful main-push contributors within
the frozen September 14–21 window ending at 14:07:53 UTC: `35591186572`,
`35592313474`, `35593033375`, `35601102699`, and `35607421993`. The median is
1,043.136 seconds across both `gateway-server-isolated` and
`gateway-database-workers`; one child's wall is not the complete family cost.
Two repeated inventory-specific children retain their measured 396- and
690-second weights. Other families and profiles keep their existing measurements.
The matching fallback covers future inventory changes without suppressing refits.
The existing 150-second split threshold produces 12 children, including the
separate runtime-prerequisite child. This is distinct from exclusive-bin packing:
Gateway configs retain exclusive plan admission and their current worker policy.
With the tooling release tier and measured tooling workers applied, broad fallback
fits the unchanged caps: 111 hybrid, 120 GitHub, and 117 Blacksmith PR Node rows.

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
each of at least three sampled successful workflows, and only if the key is absent from every
contributing run, including failed workflows. Duplicate run fragments with
incomplete inventory cannot become pruning evidence by changing their order.
Profiles with fewer complete-inventory contributing runs retain all previous
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

After that admission, canonical main pushes and trusted Windows-selected PRs with a full compact Node plan and at least 500 predicted seconds in one serial row can move eight check rows to hosted Ubuntu: dependencies, five core test-type stripes, extension package boundaries, and runtime topology architecture. The five stripes distribute the same complete compiler graphs formerly grouped into two rows and the central type-check job. The separate `hybrid_hosted_checks` decision requires fresh healthy [assignment evidence](/ci/runners#hybrid-hosted-assignment-guard) and enough room for every selected check within the same 45-row limit. Precise PRs without that measured latency floor retain their existing routes.

The six current hybrid extension-lint stripes are part of the base hosted inventory. The type split adds at most three Blacksmith registrations when hosted admission is unavailable; using the existing conservative four-main/21-PR arrival envelope, the 153/213 registration bound becomes 156/216, or 5,160 registrations, below the 6,000 operating target. No Node matrix cap or hosted admission limit changes. Reserving the additional real-Gateway row conservatively for every run raises that envelope to 157/217, or 5,185 registrations (`4 × 157 + 21 × 217`), leaving 815 below the operating target. This reservation does not spend ordinary PRs’ existing proof-tier omission; the eligible hybrid hosted inventory is unchanged because these rows retain Blacksmith.

Main pushes then consider lint and central test types under `hybrid_hosted_main_checks`; artifact builds retain Blacksmith. This admission consumes only the remaining hosted capacity and requires the earlier check admission. PRs retain Blacksmith for these two central jobs. The complete workflow targets fifteen minutes, including assignment and setup; compare exact-head timing against that target. Timeouts remain unchanged.

Control UI E2E shards, QA Smoke, real-Gateway checks, and Android retain their existing routes. Test inventory and worker limits remain unchanged. Security waits for preflight's original budget decision and still runs after a preflight failure unless the workflow was canceled. Hosted assignment delay and ordinary cache setup can offset compute savings, so compare the first exact-head run's hosted/Blacksmith row counts and queue times before widening admission.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
