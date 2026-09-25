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
| `check-lint-core-1` / `-2`                                 |                     — |                       311 [377] / 332 [358] | Blacksmith 16/8-class          |
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
| `openclaw/ci-gate`                                         |                     — |                                       3 [6] | Blacksmith 4-class             |

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

## Hosted assignment on the critical path

In main run `35810905247` (September 23, 2026), the gate completed 1,068 seconds
after `run_started_at`; the run metadata finalized one second later. The jobs
endpoint reports 105 rows, including skipped jobs, so the second page is required
to observe the gate. Each creation interval below starts when the preceding
required job completed, or at `run_started_at` for preflight.

| Required hop                   |       Job ID | Creation/admission | Queue | Runtime |
| ------------------------------ | -----------: | -----------------: | ----: | ------: |
| Preflight, Blacksmith 16-class | 107022697718 |               189s |    2s |     60s |
| Core lint 1, hosted            | 107022907577 |                 1s |  244s |    398s |
| CI gate, hosted                | 107025083351 |                 0s |  172s |      2s |

This is 416 seconds of hosted queueing, 190 seconds of creation/admission,
460 seconds of execution, and two seconds of Blacksmith queueing. The initial
189 seconds end exactly when run `35809764899` releases the same even main
parity slot. They are workflow admission, not planner execution. The planner
is inside preflight's 60 seconds; downstream creation costs one second.
The six extension-lint rows finish before the slowest Node job and remain hosted.

The newest green PR at the sampling cutoff, run `35811411598`, completes the
gate in 780 seconds (metadata finalizes at 781 seconds):

| Required hop                         |       Job ID | Creation/admission | Queue | Runtime |
| ------------------------------------ | -----------: | -----------------: | ----: | ------: |
| Preflight, Blacksmith 16-class       | 107023611849 |                 1s |    8s |     56s |
| Compact small 40, Blacksmith 8-class | 107023832566 |                 1s |    8s |    573s |
| CI gate, hosted                      | 107025790309 |                 0s |  130s |      3s |

That chain spends 130 seconds in hosted queueing, two in creation, 632 executing,
and 16 in Blacksmith queueing. No test depends on the artifact build in either
chain. Changing matrix shape would not remove the gate's serial queue.

Trusted hybrid first attempts therefore request the 16-class for the heavier
first packed core-lint row, the 8-class for the second, and the 4-class for the gate. The logical lint partitions, single
lint thread, extension-lint rows, main parity slots,
workflow dependencies, and deadlines stay unchanged. Hosted remains the route
for independent cheap work. RunsOn's cron evidence does not qualify lint or a
Bash-only gate, so those workloads retain the measured Blacksmith route.
The existing health owner also rejects optional check offloads after observed
hosted waits reach sixty seconds, replacing its former three-minute threshold.
This protects the central type and dependency rows when assignment consumes
their execution slack without changing API deadlines or test coverage.
The first native candidate used the 8-class for both lint rows. Its PR run
`35813098351` passed in 785 seconds, but core lint 1 took 621 seconds (568 in
lint itself), versus the 398-second hosted baseline (350 in lint). Core lint 2
took 353 seconds versus 323 hosted. Retaining four actual CPUs only for the
heavier row avoids spending the queue saving on slower execution. At the
historical list rates and old hosted runtimes held constant, the 16/8 split
costs about $0.2984 instead of $0.1923 for two 8-class rows. These unrounded
estimates exclude minimum billing and ancillary charges; native measurements,
rather than that forecast, own the final cost and wall comparison.

The revised PR run `35814962786` measured core lint 1 at 275 seconds on the
16-class and core lint 2 at 385 seconds on the 8-class. The heavier row's
reference compute was about $0.1467, versus $0.1469 for its 551-second 8-class
main-shaped observation and $0.1656 for the earlier 621-second PR observation.
These are unrounded complete-job costs across different CI contexts, excluding
minimum billing and ancillary charges. The revised workflow still failed a UI
test and had a 118-second hosted median wait; it is not a complete fifteen-minute
qualification.

The change adds three actual Blacksmith registrations on ordinary hybrid main
and same-repository PRs. Trusted fork PRs using the logical GitHub profile emit
five core-lint rows, so their increase can be six including the gate. A fresh
current-source audit totals 70 potentially self-hosted non-Node rows across the
supported automatic main/PR profiles. This conservative union includes five
core-lint rows, five core-type rows, five Windows rows, and thirteen UI E2E rows;
its profile maxima do not all coexist. The six extension-lint rows stay hosted.

Retain an 84-row non-Node allowance, leaving fourteen rows reserved above that
union. With the unchanged 70/130 Node caps and four-main/21-PR arrival envelope,
`4 × (70 + 84) + 21 × (130 + 84) = 5,110`. That leaves 890 below the 6,000
operating target from the reported 10,000-per-five-minute registration limit.
This replaces the stale historical `80 + 3 + 1` explanation without spending
headroom or changing matrix caps. Manual/frozen release jobs and other workflows
are outside this conditional arrival envelope; it does not establish complete
organization-wide usage.

## RunsOn remains unqualified

The [on-demand pilot](https://github.com/openclaw/openclaw/actions/runs/35549787290) measured the two critical compact jobs at 561/816 seconds on Blacksmith versus 755/1259 seconds on `c8i.4xlarge`: 35%/54% slower. Full Gateway-core failed on AWS at every tested worker count. Cron scaled from 156 to 138 seconds on `c8i.8xlarge` and 126 to 110 seconds on `c8a.8xlarge` at 8 versus 16 workers, but lacks a matching Blacksmith control. Checks, artifact builds, extensions, and UI have no pilot comparison.

The opt-in `runson` profile derives from hybrid and extracts the three `core-runtime-cron-parallel-*` children into one serial job on `c8i.8xlarge`: 32 vCPUs, 64 GiB RAM, `ubuntu24-full-x64`, and an 80 GB gp3 root. On the retained cron comparison inventory, all 258 files kept their two-worker job and group ceilings, and the source Blacksmith jobs retained their other children. RunsOn inherits hybrid's current splitting and packing before adding its cron row. Current inventory counts and pricing are recorded in [measured compact packing](/ci/routing-costs#measured-compact-packing); the earlier fixed nine-to-four projection is not a universal result. The pilot's eight-worker, 156-second cron wall remains historical context, while the complete two-worker comparison below owns the available provider evidence.

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

Ordinary main still does not select AWS. The admitted main-shaped qualification can select RunsOn and excludes comparison controls. Its initial preflight stays hosted until authorization. Qualifications retain their coverage shape on reruns while using hosted routing, resource policies and deadlines; raw GitHub context continues to own authentication, concurrency and cache publication.

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
