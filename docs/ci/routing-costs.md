---
summary: "Measured CI provider costs, routing decisions, and the 15-minute qualification"
title: "CI routing costs"
read_when:
  - You are changing CI provider placement or packing budgets
  - You need to distinguish measured workflow walls from planner estimates
---

## Routing from measured wall time

Use GitHub-hosted runners for independent checks that fit the workflow's remaining time. Retain Blacksmith where the measured job tail threatens completion. Qualify RunsOn by workload before assigning it a production tier. Requested Blacksmith 8/16/32 labels delivered 2/4/8 CPUs in the capacity probe; labels are not worker counts.

The table compares eleven successful B1/R1 main runs with five later successful main runs: `35679872894`, `35679457587`, `35678156129`, `35677164460`, and `35675497006`. These are longitudinal observations with different source revisions, not controlled provider comparisons. Values are median [maximum] complete job seconds; a dash means unmeasured. Existing trust, retry, and [hosted assignment admission](/ci/runners#hybrid-hosted-assignment-guard) still apply.

| Job family                                                 |            Blacksmith |                               GitHub-hosted | Hybrid placement               |
| ---------------------------------------------------------- | --------------------: | ------------------------------------------: | ------------------------------ |
| `preflight`                                                |               46 [48] |                                           — | Blacksmith; starts the graph   |
| `security-fast`                                            |                     — |                                     45 [66] | Hosted when admitted           |
| `build-artifacts`                                          |             280 [314] |                                   599 [898] | Blacksmith 16-class            |
| `check-lint`                                               |             461 [499] |                                   624 [631] | Hosted on admitted main pushes |
| `check-lint-core-1` / `-2`                                 |                     — |                       311 [377] / 332 [358] | Hosted                         |
| `check-prod-types`                                         |                     — |                                   240 [282] | Hosted                         |
| `check-test-types`                                         |             358 [387] |                                   608 [664] | Hosted on admitted main pushes |
| `check-test-types-core-1` / `-2`                           | 281 [321] / 257 [329] |                       521 [572] / 496 [524] | Hosted when admitted           |
| `check-dependencies`                                       |             228 [260] |                                   434 [476] | Hosted when admitted           |
| `check-additional-extension-package-boundary`              |             200 [221] |                                   287 [377] | Hosted when admitted           |
| `check-additional-runtime-topology-architecture`           |             133 [161] |                                   289 [320] | Hosted when admitted           |
| `check-additional-boundaries`                              |                     — |                                   217 [232] | Hosted                         |
| `check-bundled-channel-config-metadata`                    |                     — |                                   107 [140] | Hosted                         |
| `check-guards` / `check-npm-lock`                          |                     — |                         148 [192] / 72 [82] | Hosted                         |
| `check-prompt-snapshots` / `check-source-contracts`        |                     — |                        76 [108] / 100 [104] | Hosted                         |
| Fast baseline / Bun launcher / bundled protocol / coercion |                     — | 158 [167] / 110 [147] / 211 [223] / 64 [89] | Hosted                         |
| Fast channel / plugin contracts                            |                     — |                       322 [325] / 225 [248] | Hosted                         |
| `control-ui-performance`                                   |                     — |                                   120 [130] | Hosted                         |
| Docs / Python skills / native and Control UI i18n          |                     — |                        No comparable sample | Retain existing hosted routes  |
| `openclaw/ci-gate`                                         |                     — |                                       3 [6] | Hosted                         |

Independent hosted checks reached at most 664 seconds in this sample. Artifact builds reached 898 seconds before the shared preflight and gate; they retain Blacksmith. Only the gate depends on `build-artifacts`: the workflow does not contain a serial build-to-test job dependency.

| Test family                               | Available complete-job evidence                                                    | Placement and remaining measurement                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Compact large, baseline bin 13            | Blacksmith 932 [967]s across five runs                                             | Retain Blacksmith; correct underestimated serial packing                                   |
| Other compact large bins                  | Blacksmith 57–616s                                                                 | No hosted comparator for the exact inventories                                             |
| Compact small bins                        | Blacksmith 70–731s; bin 23 median 668s                                             | No hosted comparator for the exact inventories                                             |
| Whole agents-support historical benchmark | Blacksmith 706s; hosted 1909s                                                      | Retain Blacksmith for this parallel-heavy workload; do not apply its ratio to every family |
| Changed-extension envelopes               | Recent 47-row PR sample: median 281s, maximum 473s; another sample has a 982s tail | Retain current runner and process boundaries; combined jobs need native proof              |
| UI unit shards                            | Hosted 296/411/317s, one run                                                       | Hosted when admitted                                                                       |
| Control UI E2E shards 1–12                | Blacksmith 269–526s, one run                                                       | Retain 16-class; hosted comparison missing                                                 |
| Browser-extension E2E                     | Hosted 232s, one run                                                               | Hosted when admitted                                                                       |
| Real-Gateway UI E2E                       | Blacksmith 712s, one run                                                           | Retain 32-class                                                                            |
| Windows                                   | Historical Blacksmith 676/797s on the old two-row inventory                        | Retain native route; current five-row and hosted comparison missing                        |
| macOS Node / Swift                        | No successful sample in these receipts                                             | Retain native routes; no latency claim                                                     |

Numbered compact bins change when membership changes. A matching suffix does not establish a matching workload. Full manual native qualification, including iOS and Android, is not proven within fifteen minutes by these Linux measurements.

## RunsOn qualification

Successful children in failed PR-shaped run `36038423993` provide exact admission
observations, not green qualification. The two serial Gateway-methods children
(jobs `107766128467` and `107766128662`) took 390.70 and 372.33 seconds on the
existing RunsOn memory32 on-demand pool. The planner separates each complete
child from its trailing siblings after resolving the execution runner. It
preserves their two-worker job ceilings, ordered selectors, deadlines and
runtime policy; unmatched siblings retain their original forecast. Prices bind
the requested runner contract and full child identity, expire when those inputs
change, and do not transfer AWS timings to Blacksmith or PR timings to main.

The retained Blacksmith32 tooling child in job `107766133218` took 225.96 seconds,
so its forecast rises from 48 to 311 seconds using measured headroom and the
existing 60-second setup reserve. Its runner remains unchanged. The two
Blacksmith8 extension children in job `107766132924` took 287.51 and 208.48 seconds;
exact selector floors separate them under the existing 300-second envelope.
Two further complete serial cohorts (jobs `107766128451` and `107766128634`)
took 507.40 and 522.21 test seconds against 360-second forecasts. Their complete
ordered observations allow greedy whole-child splits within the same 360-second
work allowance. Both retain their native provider and two-worker ceiling. The
latter keeps the Blacksmith32 allocation of its update-CLI envelope; its other
children have no independent AWS comparison. Neither job declares runtime build
preparation. Partial or reordered cohorts cannot use these aggregate placements.

The frozen broad-PR replay adds four compact rows and one plugin row: 123 Node
rows including the cron control, within the existing 130-row cap. Main-shaped
plans are unchanged. No native wall-time improvement is established by this
replay; the complete exact-head qualification remains required.

The next candidate diversifies every RunsOn request across five AMD types and
both AZs exposed by the installed stack. The former 32-class Node rows need at least eight CPUs and
32 GiB; UI, cron and eligible long tooling rows use 4–8 CPUs and 16 GiB. Existing memory gates and worker limits
still admit execution. Runtime builds and the measured update-CLI envelope
retain Blacksmith. The slow retained CLI process cohort is split using the
existing runtime admission owner and complete file costs; its former seven-file
child took 720 seconds inside a 1,142-second job.

The memory32 class now uses on-demand after failed run `36050763810` recorded
four confirmed Spot interruptions and two unconfirmed shutdown cancellations
among 17 Spot allocations. All selected `m8a.2xlarge`; 16 used one AZ despite the
unchanged five-family request and unrestricted configured AZs. The earlier
`36038423993` sample had zero interruptions in 17 `c7a.4xlarge` Spot allocations,
so its result does not establish reliability of the newly selected pool.
Repricing the same 5,420 allocation seconds at the saved M8a rates adds about
$0.48 ($0.24917 Spot versus $0.73302 on-demand). Those intervals include incomplete
work; this buys no-retry reliability, not a pure-compute break-even win or a
complete-run price. An on-demand campaign cannot claim Spot qualification.

The unchanged 134-file tooling envelope finished at +880 seconds in that failed
run: 557 seconds per job and 516.08 seconds in the timed runner, using 1.636 busy
cores on two available CPUs. Its three child spans totaled 514.64 seconds. The
prior matching envelope took 502/461.56 job/runner seconds with 1.607 busy cores.
Both had the same 7.656 GiB reported RAM and two-worker policy; no memory peak
was recorded. Complete source-cohort prices now inform the existing long-tooling
routing threshold before provider selection. The conservative 634-second
Blacksmith forecast moves this intact envelope to the existing general16
on-demand pool, without another shard or worker. Native comparison must establish
performance there; no speedup follows from the larger requested capacity alone.

For the remaining Spot-eligible pool, a known planner prediction plus a
320-second native timing reserve must fit 480 seconds. Longer or unknown rows use on-demand;
UI has no complete per-row forecast. This market-only reserve covers the
307-second maximum observed gap between prediction and Spot allocation wall,
including startup and underestimated test work. It never changes a deadline. The
GitHub-projects UI spec stays on Blacksmith in a disjoint inventory partition
until its previous AWS RPC timeout has an established cause. No coverage or
hosted lint/type routing changes accompany these placements.

Ordinary PR run `35881459999`, job `107251427442`, exposed a separate tooling
tail: 85 files in three serial two-worker children took 674.40 test seconds
inside a 786-second Blacksmith 8-class job. It averaged 1.5065 busy cores on
two available CPUs with 7.656 GiB delivered RAM; peak RSS was not recorded.
The exact ordered child contracts remain together in the RunsOn PR plan with
the same 549-second prediction, while main omits that release-only tooling.
Long ordinary tooling envelopes now request the existing 4–8-CPU, 16-GiB
on-demand pool without another shard or worker. Native qualification must
establish its runtime; the larger memory floor alone is not a speed claim.
The ordinary run also had a 137-second hosted gate wait and a Gateway fixture
type error. Its raw wall was 17m24s; removing queue time arithmetically does not
qualify the route.

The first diversified run, `35887809735` at `40cd43b1c572`, finished in 14m19s
with all 57 AWS jobs passing and no interruptions. Blacksmith used 223.700
machine-minutes / $8.1072; verified AWS allocations add $2.399377, totaling
$10.506577. Four retained-host failure rows and the aggregate gate prevent this
run from counting as green qualification. Actual Spot allocations used
`c7a.4xlarge` in `us-east-1b`; on-demand M8a allocations used both configured AZs.

Four Spot jobs took 524–594 seconds despite predictions of 308–315 seconds.
The former 150-second reserve covered startup but not this forecast error.
The revised 320-second reserve would move those four and one additional row to
on-demand, retaining 17 of the observed 22 Spot rows. At the same actual instance
types and allocation durations, that adds $0.389317, for $10.895894 total.
This is a market-budget scenario, not a measured replacement run or a fitted
interruption model; direct on-demand prefers M8a and must be priced from its
next actual allocation receipts.

The final single-pool controls at `791e06f63af6` all failed and exceeded 15 minutes:

| Shape | Hybrid run    | RunsOn run    | Blacksmith minutes | Combined reference cost | Raw wall        |
| ----- | ------------- | ------------- | ------------------ | ----------------------- | --------------- |
| Main  | `35856548503` | `35859004781` | 558.583 → 213.650  | $28.9979 → $10.9620     | 19m24s → 21m28s |
| PR    | `35861500888` | `35863745223` | 674.683 → 238.267  | $31.6341 → $10.5561     | 20m19s → 21m13s |

Raw Blacksmith reductions of 61.75% and 64.68% include interrupted partial work;
they are not successful equivalent-coverage savings. The same-source, same-Node
cron comparison did pass 255 files / 3,488 tests on both providers, taking
479 seconds on Blacksmith and 297 on AMD Spot. Its allocation estimates were
$0.510933 and $0.014176 respectively. Ordinary migrated rows used different
Node versions; the new candidate pins the actual runtime.

The two RunsOn runs lost all 19 `c8a.4xlarge` Spot allocations in two correlated
waves in one AZ. Across all types, 19 of 36 Spot allocations were interrupted;
none of 78 on-demand allocations was interrupted. This does not estimate a
stationary failure probability for the diversified pool. At the old
$0.3081/hour Spot and $0.86216/hour on-demand references, repeated full-length
attempts break even at a 64.26% interruption probability. A hypothetical single
Spot attempt followed by on-demand replacement, using the observed 189.84-second
mean lost allocation, breaks even at 81.97% for an eight-minute job. No such
retry is enabled. The observed AMD cohort exceeds both thresholds; the pooled
52.78% mixture does not establish an eight-minute statistical boundary. The
480-second cutoff protects critical-path slack instead of claiming a fitted
hazard model.

### Repeated slowdown retention

At `acd418249c462122f120a2455989cf553243b941`, RunsOn PR-shaped runs
`35944538318` and `35945850656` and hybrid control `35947306985` executed
the same source and runtime. Six complete rows exceeded the 25% slowdown
threshold in both AWS samples with matching ordered work and effective worker
policies. Their measured co-resident owners identify the retained envelopes;
generated row numbers do not. If packing separates the owners or changes their
resource contract, the exception no longer matches.

At that revision, main shared the four storage envelopes. Its update/archive row omitted one
release-only tooling file from the measured PR contract; the larger native fit
covers the included work, but no exact main-row speed ratio is inferred from
that PR comparison.

| Co-resident workload owners                          | RunsOn job seconds, two samples | Blacksmith control seconds |
| ---------------------------------------------------- | ------------------------------: | -------------------------: |
| Worktree acceleration and retirement snapshots       |                       296 / 290 |                        225 |
| Canonical descendants and transcript session custody |                       335 / 354 |                        240 |
| Update repair history and archived usage identity    |                       351 / 355 |                        246 |
| Shared embedded run and inference activation         |                       288 / 303 |                        198 |
| Unified declaration tooling                          |                       289 / 288 |                        212 |
| SDK declarations and changed-test planning           |                       527 / 551 |                        379 |

The controls used the Blacksmith 32-label with eight actual CPUs and about
31 GiB; AWS used `c7a.4xlarge` with sixteen CPUs and about 31 GiB. Setup and
cache differences remain part of these whole-job observations, so the comparison
does not isolate hardware causality. Cron stays on RunsOn: its complete
same-run comparison was 360 versus 323 seconds, below the retention threshold.

The SDK/planner pair's 148-second prediction plus the existing market reserve
admitted Spot, but both executions exceeded eight minutes. Its guarded
Blacksmith route addresses that repeated forecast exception without changing
other rows' reserves. A two-CPU, 8-GiB process scope passed its complete workload
but reached a 7.728-GiB kernel memory peak; the 16-label retains memory headroom.
A constrained process scope is not whole-VM performance proof. Actual-label,
exact-head qualification remains required for every reduced allocation.

The four storage envelopes passed separate two-CPU, 8-GiB scopes with zero
memory-limit or OOM events. Worktree and descendant peaks were 3.937 and
4.974 GiB on a constrained Blacksmith 16-label VM. Update/archive and
embedded/inference peaks were 4.666 and 4.336 GiB on AWS Ubuntu 26.04 after
two Blacksmith source transfers failed before tests started. The latter results
retain that provider and OS limitation. Their proposed 8-label allocations still
require actual Blacksmith CI; no test was repeated for the transport failures.
Unified declarations also passed its complete 80-file inventory on the AWS
scope with a 4.564-GiB peak and the original compiler admission guard. These
measurements describe the recorded workloads, not every later companion set.

Main's inventory and packing update at `63fa1d2dedac` changed all six
envelopes. The guarded storage and SDK/planner exceptions no longer matched
those broad plans: their owners separated, gained children, or changed
concurrency. The unified-declaration row had 47 files, only ten shared with its
previous 80-file probe. That revision retained its original Blacksmith 32-label;
the older process fit did not qualify the changed workload on a smaller host.
Its RunsOn planner emitted 81 compact PR descriptors (79 Node rows), plus 41
plugin Node rows before the cron comparator, and 68 main descriptors (67 Node).

The later integration at `aeb32f35468d` emits 77 compact PR descriptors
(75 Node rows), plus 42 plugin Node rows: 117 before the comparator, 118 with
it. Main has 65 compact descriptors and 64 Node rows. No guarded small-host
exception activates. Unified declarations now has 38 files, including both
declaration compiler fixtures, and retains the original Blacksmith 32-label.
Neither the historical 80-file fit nor the intervening 47-file plan qualifies
this workload on a smaller allocation.

That integration also adds a baseline-ratchet prerequisite before nondist Node
jobs. Both cron providers share it and retain their paired admission priority.
The new dependency and changed inventories require fresh exact-head wall and
cost measurements; earlier workflow timings do not qualify this revision.

The four candidate walls were 743, 810, 740 and 992 seconds. All tests passed,
but the last run fails the fifteen-minute requirement. Its Blacksmith cron
comparator was last in the 118-row Node matrix and waited 572 seconds before a
299-second execution. Both cron providers now receive the same existing
admission priority, ahead of ordinary rows. This corrects the ordering omission;
it does not explain the full wait, including 285 seconds after every other Node
row had started. Matrix caps, routing, worker limits and deadlines are unchanged.
The repository backend remains hybrid. Final same-head qualification and costs
are recorded in [PR #156158](https://github.com/openclaw/openclaw/pull/156158).

Reference hourly prices on September 23 are $0.1655 Spot / $0.48688 on-demand
for `m8a.2xlarge`, versus $0.4256 / $1.23876 for `m8azn.3xlarge`.
A 400-minute Node allocation envelope would cost about $3.25 on-demand on M8a
or $8.26 on M8azn, before ancillary charges; that is a sizing reference, not a
measured complete run. Direct on-demand prefers M8a; Spot's faster-family
preference can fall back to higher-priced on-demand capacity. Every final
report must price actual types and markets from allocation receipts, include
failed work, and report each exact-head workflow's wall. Regional public rates
are not invoices and exclude storage, networking, control-plane and teardown.

The following earlier measurements explain retained placements and superseded
candidates; they do not qualify the diversified candidate.

The first expanded [main qualification](https://github.com/openclaw/openclaw/actions/runs/35815956831)
at `c2bca829359` used 166.45 Blacksmith machine-minutes / $5.8117 versus the
327.88-minute / $17.2237 baseline: a raw 49.23% reduction with broader UI/Windows
coverage. Verified launch-through-completion AWS allocations add $2.6033 at the
observed Spot/on-demand reference rates, for $8.4150 before ancillary charges.
It failed in 18m03s: one Spot interruption, failures on the retained real-Gateway
path, and a 123-second hosted gate wait. This is not a green performance qualification.

The [PR-shaped qualification](https://github.com/openclaw/openclaw/actions/runs/35815959256)
at that same head passed in 24m24s, using 206.47 Blacksmith minutes / $5.8211 and
$3.3443 of observed-market AWS allocation estimates. Five AMD jobs waited
573–578 seconds before assignment; the extra hosted cron control was the final
718-second compute job. The hosted comparator is now removed because hosted
cron is not a candidate route; the complete cron suite and Blacksmith comparator
remain. Removing it alone does not solve the separate AWS admission delay.

Two execution exceptions determine the current routing. Identical cron contracts
on that same head took 420 seconds on Intel 8-vCPU Spot versus 324 on Blacksmith,
a 29.6% regression; the candidate switches that row to AMD while preserving its
two-worker ceiling. The matching update-CLI row took 732 versus 524 seconds
(39.7% slower), concentrated in `src/cli/update-cli.test.ts`, with nearly unchanged
CPU work. Blacksmith used Node 24.19.0 while AWS used 24.21.0, so this observation
does not isolate a hardware cause. Its existing Blacksmith allocation preserves
the row's measured worker and memory policy; the advertised 8-class supplies
only two CPUs and cannot preserve that admission. No storage or fixture timeout
workaround is added. Both revised routes still require native verification at
their new head.

The subsequent [hybrid main control](https://github.com/openclaw/openclaw/actions/runs/35828387224)
at `1b460535d579` failed in 22m14s, using 476 Blacksmith machine-minutes / $23.7893.
Its preflight and final gate waited 220 and 232 seconds for assignment. The
remaining 14m42s is arithmetic, not a passing or projected workflow result.
Type errors and two fixture failures prevent using this run as final acceptance;
comparisons after those repairs require a fresh shared head.

All 63 decoded Node/UI group jobs in that control used Node 24.19.0. The updated
packing placed the retained update test in a two-child row with two workers each,
eight observed CPUs and 30.95 GiB, completing in 352 seconds. The existing
24-GiB overlapping-child admission floor excludes the smaller Blacksmith class
for that row. This newer execution contract supersedes the earlier serial-row
description without establishing an AWS performance ratio for the new packing.

All eight Control UI rows passed on Intel Spot, with identical per-shard file
inventories and complete-job times 1–10% shorter than their earlier Blacksmith
runs. The historical Gateway history-reader LRU assertion passed in 5.27 seconds
on AMD. Cross-head inventory comparisons do not establish identical source bytes;
the qualification PR records those source and coverage differences explicitly.

[Main baseline 35810905247](https://github.com/openclaw/openclaw/actions/runs/35810905247)
reported eight actual CPUs in every one of its forty 32-class jobs. Test-step
`time -p` CPU time divided by elapsed time measured 2.32–5.18 busy cores on average,
not peak utilization. Eight rows used two children with two workers each; the
other 32 had one child slot and an eight-worker ceiling, with smaller group pins.
The 32-GiB replacement preserves the paired-plan 24-GiB and isolated Gateway
28-GiB admission floors; an 8-vCPU/16-GiB replacement would serialize those rows.

Fetch **all pages** of jobs: that main run has 105 records, including skipped
placeholders. Active Blacksmith 32/16/8-class jobs consumed 236.22/39.95/51.72
machine-minutes, or $15.118/$1.278/$0.827 at historical list rates. The complete
327.88-minute total is the baseline; the first 100 records undercount it.
The main runs at 02:34–02:47 UTC on September 23 consumed 298–328 Blacksmith
minutes and already exceeded the 900-second workflow objective. Queue delay
must remain visible in the native comparison.

The September 23 public regional Spot feed quotes `c8a.4xlarge` at $0.3081/hour
and `c8i.2xlarge` at $0.1763/hour in `us-east-1`. At equal runtime, the forty-row
236.22-minute slice would cost about $1.213 on AMD versus $15.118 on Blacksmith;
at 25% longer, about $1.516. These are upper-scope projections: build rows are
retained, and actual AWS cost also includes launch, teardown, storage, networking
and the control plane. Record exact-head per-class timings and allocation facts
in the qualification PR before claiming savings or the fifteen-minute objective.

For fallback budgeting, the September 23 [Vantage instance catalog](https://instances.vantage.sh/)
lists Linux on-demand at $0.86216/hour for `c8a.4xlarge`, $0.43108/hour for
`c8a.2xlarge`, and $0.37484/hour for `c8i.2xlarge` in that region. The same entire large slice would cost about $3.394
at equal runtime or $4.243 at 25% longer, before overhead. This secondary public
reference is not a billing receipt or evidence that fallback occurred.

The [on-demand pilot](https://github.com/openclaw/openclaw/actions/runs/35549787290) measured the two critical compact jobs at 561/816 seconds on Blacksmith versus 755/1259 seconds on `c8i.4xlarge`: 35%/54% slower. Full Gateway-core failed on AWS at every tested worker count. Cron scaled from 156 to 138 seconds on `c8i.8xlarge` and 126 to 110 seconds on `c8a.8xlarge` at 8 versus 16 workers, but lacks a matching Blacksmith control. Checks, artifact builds, extensions, and UI have no pilot comparison.

The pilot's compact comparisons had no runtime-build phase, so retaining builds
does not qualify their replacement. The AMD candidate requires fresh complete
job measurements. Its Gateway failure was the 64-target retained-history-reader
fixture timing out, while NVMe variants failed an overlay-mount verifier before
tests. Current fixture seeding skips unrelated maintenance; only a fresh AWS run
can establish that it resolves the earlier timeout.

The initial opt-in `runson` profile derived from hybrid and extracted the three `core-runtime-cron-parallel-*` children into one serial job on `c8i.8xlarge`: 32 vCPUs, 64 GiB RAM, `ubuntu24-full-x64`, and an 80 GB gp3 root. On that retained cron comparison inventory, all 258 files kept their two-worker job and group ceilings, and the source Blacksmith jobs retained their other children. The historical inventory counts and pricing are recorded in [measured compact packing](/ci/routing-costs#measured-compact-packing); the earlier fixed nine-to-four projection is not a universal result. The pilot's eight-worker, 156-second cron wall remains historical context, while the complete two-worker comparison below records that earlier provider evidence.

The compatible CLI observations retain **558 and 703-second forecasts including one 60-second setup allowance**. Separating their serial pair does not establish a 600-second maximum for each indivisible child. Eligible serial tooling pairs now split above a 600-second complete-wall estimate; packing separate short jobs uses a 720-second admission limit. These are placement estimates, not raised test deadlines or guarantees about the fifteen-minute workflow wall.

[Qualification run 35702772380](https://github.com/openclaw/openclaw/actions/runs/35702772380), attempt 1 at `84733d1a17a9a7321ac74099e421889099e411b4`, ran the same cron descriptors on all three providers. All three cron jobs passed with two workers and one serial child plan. The RunsOn allocation reported `instance-life-cycle=spot`; no interruption occurred. Wait below is job creation to start, including matrix admission, not pure provider boot time.

| Cron provider             | Observed CPUs | Workers | Job wall | Sum of child walls | Wait | Result |
| ------------------------- | ------------: | ------: | -------: | -----------------: | ---: | ------ |
| RunsOn `c8i.8xlarge` Spot |            32 |       2 |     396s |            344.49s |  24s | Pass   |
| Blacksmith 32-class       |             8 |       2 |     432s |            393.71s | 283s | Pass   |
| GitHub `ubuntu-24.04`     |             4 |       2 |     672s |            624.14s | 243s | Pass   |

RunsOn's job duration was 36 seconds shorter than the Blacksmith control's, an 8.3% reduction in this single same-run comparison. It does not establish a repeated distribution or qualify the complete workflow. The fresh Blacksmith child measurement is 393.71 seconds, or 6.56 minutes of candidate serial work removed from the existing source jobs, approximately $0.4200 at the historical $0.064/minute list rate. The control's complete 7.2-minute job is an added qualification job, not the amount removed from production. The source jobs retain other children and setup. Each additional Blacksmith 8-class split adds an estimated 45–60 seconds of setup; the current inventory accounting appears below. Runtime interactions, those added steps, and AWS allocation cost must be included before claiming net whole-run savings.

The earlier [baseline run 35688659765](https://github.com/openclaw/openclaw/actions/runs/35688659765) measured the same cron descriptors at 252.63 combined child seconds. The newer 393.71-second control replaces that 4.21-minute costing assumption; the variation is another reason not to equate a child-duration forecast with realized savings.

Selection uses the `runson` backend on a canonical, trusted same-repository PR's first attempt, or the [maintainer qualification dispatch](/ci/runners#runson-qualification) with an exact current PR head. The repository variable remains unchanged. The existing RunsOn GitHub App supplies runners from workflow labels; no interactive AWS login is part of dispatch. The latest operator identity check failed because the AWS SSO session was expired, so administrative state, teardown, and selected-AZ prices remain unverified. The public regional price feed is available without those credentials.

Jobs request `spot=true/retry=false`. Spot has native on-demand fallback when capacity is unavailable; the [provider's fallback documentation](https://runs-on.com/docs/costs/spot-pricing/#default-behavior) describes an additional 2–3 seconds, not a complete assignment SLA. `retry=false` opts out of automatic interruption reruns because the full-workflow recovery delay has not been shown to fit the original 900-second wall. An interruption can therefore fail this qualification. This is a Spot placement experiment, not an interruption-safe fifteen-minute tier.

The selected `c8i.8xlarge` has no local instance-store NVMe. No sticky disk, warm pool, custom image, or storage change is enabled. RunsOn automatically configures local NVMe on compatible instance-store types such as `c8id`; the pilot's corrected overlay verifier has not supplied a live performance comparison for that storage route. See [RunsOn local NVMe](https://runs-on.com/docs/runners/capabilities/local-storage-nvme/).

The [public AWS Spot price feed](https://website.spot.ec2.aws.a2z.com/spot.json) reported `c8i.8xlarge` Linux in `us-east-1` at $0.6586/hour when fetched on September 22, 2026, at 06:02:13 UTC; its HTTP last-modified timestamp was 06:01:21 UTC. This is a regional reference with no availability-zone identity or assumed averaging method, not the selected runner's billing rate. The observed Spot instance launched at 08:06:00 UTC and its job completed at 08:12:57 UTC: **417 seconds from launch through job completion**, giving **$0.076286 estimated compute** at that reference rate. This replaces the earlier 156/187-second illustrative costing.

Final instance termination was not independently verified, so 417 seconds is not the complete billable lifecycle. Add teardown, storage, networking, and control-plane charges. The $1.49936/hour on-demand reference remains the historical September 17 quote; no on-demand fallback was observed in this qualification. No expected blended rate is claimed without fallback and interruption frequencies. The earlier approximately $0.09 sample is not a flat job price.

Native [interruption recovery](https://runs-on.com/docs/runners/labels/#retry) remains a future option requiring measured slack. RunsOn [v3.3 permits two automatic reruns](https://runs-on.com/changelog/v3.3.0/) with `retry=when-interrupted`: it waits for the entire workflow attempt to finish, then reruns failed jobs and dependents. Newly launched recovery capacity is on-demand, but GitHub can assign an existing matching Spot runner. Admission must therefore account for `first-attempt completion + retry delays + both failed/dependent replays <= 900s`; merely placing a job off the critical path is insufficient. A 720-second first attempt leaves 180 seconds, already less than the measured 396-second cron job before recovery dispatch, assignment, and the gate.

Report observed interruptions and retry attempts separately from this documented provider behavior. No-capacity fallback or a manually requested rerun is not interruption-recovery proof. Until a complete recovery fits the original wall, the opt-in profile keeps automatic interruption retry disabled and makes no interruption-safe 900-second claim.

## Packing and cost arithmetic

The 300-second changed-extension budget combines the same 119 child envelopes into 40 jobs instead of 47 on the September 22 counting inventory. Estimated work remains 10,140 seconds. At 45–60 seconds of fixed setup per job, the extension slice changes from 204.25–216 to 199–209 machine-minutes: a 5.25–7 minute saving. At the historical 8-class list rate of $0.016/minute, that is $0.084–0.112 per broad PR. Public hosted execution has no metered Linux runner charge; this saving is capacity there, not a cash saving.

The following historical replay uses the capacity-pricing candidate's committed `47b18faa725` inventory with only the extension budget changed. These conditional counts describe that earlier experiment, not the final rebased inventory or qualification of the combined branch.

| Profile    | Broad PR Node rows, 240s → 300s | Unchanged core Node rows | Largest predicted core / extension job |
| ---------- | ------------------------------: | -----------------------: | -------------------------------------: |
| Blacksmith |                       132 → 125 |                       85 |                             595 / 300s |
| Hybrid     |                       130 → 123 |                       83 |                             518 / 300s |
| GitHub     |                       112 → 105 |                       65 |                             330 / 300s |

Each profile also has two dist descriptors outside the Node matrix. Main does not append these extension envelopes. Compact/PR/push/plugin caps stay 90/130/70/50. Worker counts, assertions, test deadlines, runtime-build ownership, and native-worker file ceilings remain unchanged. The workflow no longer promotes extension bundle numbers 16 and 25 to the 16-class: those positions now contain different work and follow their planner-owned 8-class route. Native proof must measure this capacity change too.

Predictions can be wrong. The old 982-second extension job included database-worker, Codex, and Matrix children taking 351/354/125 seconds; the candidate places their corresponding envelopes in separate bundles. Only the Matrix selector is identical. Its 27-second estimate substantially understates the observed 125 seconds. Applying that observation conservatively to all four Matrix children in their candidate bundle gives about 725 seconds including 60 seconds of setup, with uncertainty in the other children still requiring native proof.

## Measured compact packing

Hybrid placement reuses the canonical tooling estimator from the [capacity-pricing work](https://github.com/openclaw/openclaw/pull/155277). It reads committed Blacksmith file measurements through `readToolingFileTimings` and passes them through the existing estimator's optional file-map argument. Only this hybrid placement pass consumes that additional map; RunsOn inherits the hybrid plan. The broader timing payload and global pricing coefficients are unchanged, so this route does not create a competing file-price table.

The canonical collector accepts a complete singleton invocation duration when one declared tooling file, one passing file summary, one duration, matching reporter identity and successful exit agree. Native file summaries retain precedence. Six singleton file prices were refitted from successful jobs and children in three failed workflows; a seventh stayed within the owner's 15% threshold. Seven scoped native Testbox file updates fill missing eligible prices and correct the provision estimate. Failed workflows and cancelled lease cleanup never supply complete-inventory or pruning evidence.

Packing admits serial Blacksmith 8-class jobs with the existing two-worker ceiling, numbered tooling children and no runtime-build prerequisite. Every child needs **complete per-file measurements or an exact complete-child native observation** before its job can acquire additional packed work. Default two-second hints for unknown files do not satisfy that requirement. An incompletely measured job keeps its original membership and receives its conservative quoted cost and setup allowance.

The complete packed estimate is **60 seconds of setup plus the greater of the existing owner job price and summed canonical group prices**, retaining compatible native child observations as lower bounds. Native wall floors are not discounted by a worker ratio; the canonical file estimator keeps its normal worker-aware calculation. Each packed job must fit **720 seconds including setup**, preserve complete children and their order, respect sibling-family separation and retain its deadline. Higher owner prices cannot be replaced by faster historical samples.

Four new main tooling tests changed the earlier selectors. The same estimator now prices the changed inventory instead of disabling packing wholesale. Only affected jobs lacking complete file or native evidence are excluded from merging. Native observations bind to the executed config, environment, ordered selectors, child name and build mode; a parent timing key remains provenance, not admission authority. An unchanged child can therefore retain its observation when a sibling changes, while a changed executed contract expires the old observation safely.

Eligible serial tooling jobs with multiple children split above a **600-second complete-wall estimate**. Complete native child totals drive this decision when available, while the existing job prediction remains a floor; otherwise canonical estimates supply the child costs. Packing still retains any higher canonical price. Exact observed critical pairs also split. Runtime preparation stays only on the requiring child, and newly split critical rows cannot be repacked or charged another setup by that pass. The 703-second CLI forecast remains an unresolved indivisible tail.

### Native calibration

[Linux Testbox run 35722202780](https://github.com/openclaw/openclaw/actions/runs/35722202780) used source `2fd7485b450e12ef5574645d7b648d61ee5ce8a2` on the Blacksmith 8-class, with two observed CPUs, two workers and one child at a time. All eight selected children and the runtime preparation completed successfully. The enclosing workflow was **cancelled during lifecycle cleanup**, so it is not a green workflow or fifteen-minute qualification. Source correspondence retains the recorded runner-label fixture difference.

| Original parent    | Complete `core-tooling-*` children and successful walls | Parent test envelope | Separate runtime preparation |
| ------------------ | ------------------------------------------------------- | -------------------: | ---------------------------: |
| `compact-small-32` | `9-hosted-1`: 54.406s; `8-hosted-2`: 405.766s           |             461.693s |                     119.271s |
| `compact-small-34` | `6-hosted-2`: 327.673s; `9-hosted-2`: 637.106s          |             965.607s |                            — |
| `compact-small-35` | `12-hosted-1`: 140.024s; `13-hosted-2`: 350.159s        |             491.441s |                            — |
| `compact-small-36` | `12-hosted-2`: 148.109s; `13-hosted-1`: 101.797s        |             251.121s |                            — |

Rounded native components plus one 60-second setup yield **235/466-second floors** for the first pair and **388/698-second floors** for the second. Preparation is charged only to `9-hosted-1`. The new complete `9-hosted-2` sample replaces no failure outcome: the earlier failed 631-second observation remains censored. The four packing-child measurements update only their new exact fingerprints; final packing also retains the higher canonical prices. These are child/build receipts and forecasts, not complete Actions job walls with queueing.

### Current inventory

Main now includes the separately owned [runtime release tier](https://github.com/openclaw/openclaw/pull/155606); its coverage movement is not an R3 saving. On the candidate rebased onto `0a5b5381a26b`, hybrid's broad-PR plan separates two critical pairs and packs **seven eligible jobs into three**. Four removed setups save 3–4 minutes; the two splits add 1.5–2 minutes, leaving a conditional **1.5–2 Blacksmith 8-class minutes /$0.024–$0.032** before runtime interactions. Main adds one split and its setup. Extension packing retains its separate controlled 47→40-job comparison.

The immutable nine-job calibration cohort fits four jobs with canonical forecasts of **629, 539, 662 and 672 seconds**. That cohort checks the policy; it does not define the current inventory's job count. Current packed `compact-small-20` forecasts 617 seconds, and tooling `compact-small-32` forecasts 576.5 seconds. The longest known forecast remains the 703-second CLI child.

| Profile and shape                | Before Node /compact | Final Node /compact | Final Node classes        | Caps Node /compact |
| -------------------------------- | -------------------: | ------------------: | ------------------------- | -----------------: |
| Hybrid main                      |               42 /43 |              43 /44 | BS8: 13; BS32: 30         |             70 /90 |
| Hybrid broad PR                  |               99 /61 |              97 /59 | BS8: 65; BS32: 32         |            130 /90 |
| RunsOn main-shaped qualification |               43 /44 |              44 /45 | BS8: 13; BS32: 30; AWS: 1 |             70 /90 |
| RunsOn broad PR                  |              100 /62 |              98 /60 | BS8: 65; BS32: 32; AWS: 1 |            130 /90 |
| Blacksmith main                  |               51 /52 |              51 /52 | BS8: 18; BS32: 33         |             70 /90 |
| Blacksmith broad PR              |              105 /67 |             105 /67 | BS8: 57; BS32: 48         |            130 /90 |
| GitHub main                      |               58 /59 |              58 /59 | Hosted: 58                |             70 /90 |
| GitHub broad PR                  |              111 /73 |             111 /73 | Hosted: 111               |            130 /90 |

Compact counts include dist descriptors; broad-PR Node counts include 40 extension rows. RunsOn adds one cron job to the hybrid plan. All counts stay inside the unchanged 70/130/90 caps. Together, current Node and extension packing remove a net nine setups from a broad PR: an estimated 6.75–9 Blacksmith 8-class minutes, or $0.108–$0.144 before runtime interactions. Main adds one setup, approximately 0.75–1 minute or $0.012–$0.016. These counts and costs are planner arithmetic, not native performance acceptance. Final measurements are recorded in [PR #155403](https://github.com/openclaw/openclaw/pull/155403).

These historical counts predate the expanded class routing above. The repository variable remains unchanged; configuring `runson` now admits canonical main first attempts. The admitted main-shaped qualification can select RunsOn and excludes comparison controls. Its initial preflight stays hosted until authorization. Qualifications retain their coverage shape on reruns while using hosted routing, resource policies and deadlines; raw GitHub context continues to own authentication, concurrency and cache publication.

## Whole-run acceptance

[Baseline run 35679872894](https://github.com/openclaw/openclaw/actions/runs/35679872894) took 21m18s: 5m20s before preflight creation and 15m58s from preflight creation through the gate. Blacksmith class median assignment was 8/8/3 seconds for 32/16/8-class. Workflow admission and runner assignment are different waits; include both in whole-run latency.

The baseline allocated 29/2/10 active Blacksmith 32/16/8-class jobs and 25 hosted Ubuntu jobs. Skipped placeholders consumed no runners. That is 258.15 Blacksmith machine-minutes; historical label rates imply $13.84, while the campaign's supplied estimate was $18–20. These are pricing assumptions, not an invoice. Moving artifact builds back adds one Blacksmith job and approximately 4.67 Blacksmith minutes using the older build median; extension compaction applies to PRs only.

Completion requires measured main-shaped and broad-fallback PR-shaped runs for each changed profile at or below 900 seconds, with every Blacksmith class median assignment at most 60 seconds. Record actual job and step walls, total workflow wall, class counts, and cost against the same baseline. Planner estimates, reduced rows, and a successful test result alone do not establish this performance gate. The routing and packing changes remain unqualified until those exact-head observations exist.

The two native runs at `84733d1a17a9a7321ac74099e421889099e411b4` both failed and exceeded the wall target:

| Native run                                                                             | Complete wall | Active jobs | Blacksmith minutes | Hosted Ubuntu minutes | Estimated Blacksmith compute |
| -------------------------------------------------------------------------------------- | ------------: | ----------: | -----------------: | --------------------: | ---------------------------: |
| [Hybrid PR 35702479645](https://github.com/openclaw/openclaw/actions/runs/35702479645) |        17m57s |         151 |             906.50 |                111.32 |                     $33.5011 |
| RunsOn qualification 35702772380                                                       |        17m33s |         155 |             946.62 |                122.35 |                     $34.6651 |

Qualification additionally used 6.6 job minutes on Spot, with the $0.076286 launch-to-completion estimate above. It includes the two extra cron controls and different dispatch admission, so subtracting these total costs would not isolate the production routing change. Blacksmith Linux class median waits were 12 seconds in the PR and 9–10 seconds in qualification. Windows medians were 48 and **61 seconds**, respectively; qualification therefore also missed the under-60-second class wait target. The successful job tails were 950 seconds in the PR and 907 seconds in qualification. Passing cron controls do not turn either failed workflow into a green or fifteen-minute result. These runs predate the current calibrated packing candidate and do not qualify it. Current main-shaped and broad-PR receipts are recorded in [PR #155403](https://github.com/openclaw/openclaw/pull/155403).
