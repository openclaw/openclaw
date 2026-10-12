---
summary: "A bounded Hetzner dedicated-vCPU comparison with Blacksmith using preserved CI workloads"
title: "Hetzner CI pilot"
read_when:
  - You are evaluating Hetzner runners for CI
---

Keep latency-sensitive main CI on Blacksmith and retain **zero Hetzner boxes**
after this pilot. CCX43 rental is cheap, but the successful compact workloads
took **2.07× and 2.23× as long**. Cron and gateway-core did not establish reliable
paired throughput. No production routing changed, and this PR is not a merge
candidate.

The [benchmark run](https://github.com/openclaw/openclaw/actions/runs/35566177185)
ran all 24 originally planned attempts at commit
`764cdcd8de6f0f6218b3568ce365870f0c7fc709`: **13 passed, seven jobs failed tests,
and four were interrupted by host maintenance**. There were no reruns,
replacement samples, weaker assertions, or longer test deadlines.

| Workload         | Blacksmith successful job median | Hetzner successful job median | Hetzner / Blacksmith | Outcomes: Blacksmith; Hetzner                                       |
| ---------------- | -------------------------------: | ----------------------------: | -------------------: | ------------------------------------------------------------------- |
| Compact large-1  |                 729s (3 samples) |            1,512s (2 samples) |                2.07× | 3 pass; 2 pass + 1 infrastructure failure                           |
| Compact large-14 |                 605s (3 samples) |          1,346.5s (2 samples) |                2.23× | 3 pass; 2 pass + 1 infrastructure failure                           |
| Cron             |                No passing sample |               329s (1 sample) |          Unqualified | 3 test failures; 1 pass + 1 test failure + 1 infrastructure failure |
| Gateway core     |               682.5s (2 samples) |             No passing sample |          Unqualified | 2 pass + 1 test failure; 2 test failures + 1 infrastructure failure |

These are descriptive successful-sample medians, not three clean repetitions:
Ubuntu maintenance changed the Hetzner package image during the run. All
attempts, including failures and missing probes, appear below.

The conditional capacity model for **only the two compact jobs** is three
CCX43 boxes at 4.5 main runs/hour, with a 75% utilization target. Their roughly
25-minute execution would remain; more boxes address queueing. A
noncritical batch lane that accepts this latency could use that capacity model,
but this run does not justify moving the main critical path, cron, or gateway
core. The next hardware candidate is an AX102 measurement after Robot access is
available; its projection below is explicitly unmeasured.

## Host and cost

The pilot provisioned server `166705257` (`5.161.68.106`) in Ashburn (`ash`) on
September 21, 2026 at 05:41:55 UTC: CCX43, 16 dedicated AMD vCPUs, 64 GB RAM,
360 GB local storage, and Ubuntu 24.04. The Cloud API quotes €0.4479/hour net
plus €0.0008/hour for IPv4, or €0.53844/hour including its quoted 20% VAT.
The monthly caps total €279.99 net (€335.988 including VAT). Billing rounds
partial hours up; the total pilot budget is €20.

Two unprivileged systemd template services register ephemeral runners named
`hetzner-ccx-1` and `hetzner-ccx-2`. Each has eight disjoint CPU affinities and
a 28 GiB memory limit. They re-register after each job using a short-lived
repository registration token; no general GitHub credential is installed on
the host. Default runner labels are disabled: the sole custom label is
`openclaw-hetzner-ccx`. Only this guarded benchmark workflow requests it.

The host uses kernel `mitigations=off` after a reboot, Node 24.19.0,
the repository's pinned pnpm through Corepack, build-essential, and a 16 GiB
tmpfs mounted at `/tmp`. Workspaces reside on the local root disk, exposed
to the guest as a QEMU disk; physical NVMe backing is not independently visible
inside the guest. The firewall is a task-owned clone with TCP restricted to
SSH from the existing operator allowlist, plus ICMP. The server, its IPv4/IPv6 resources, task SSH key, and firewall were deleted
after measurement; absence was verified by the Cloud API at 07:36:46 UTC.
Creation-to-confirmed-deletion was 1h54m52s. Two rounded hours imply an estimated
**€0.8974 net / €1.07688 gross** rental, well below the €20 cap. This is a price
calculation, not an invoice. Temporary token copies and the private task SSH key
were removed locally.

| Observed resource   | Blacksmith 32-label job    | Hetzner job / host                                          |
| ------------------- | -------------------------- | ----------------------------------------------------------- |
| Node available CPUs | 8                          | 8 / 16                                                      |
| Guest CPU model     | AMD EPYC                   | AMD EPYC-Milan                                              |
| Guest topology      | 8 cores × 1 thread         | 4 cores × 2 threads per slot; 8 cores × 2 threads on the VM |
| Guest RAM           | 30.950 GiB                 | 61.313 GiB shared; each service capped at 28 GiB            |
| Kernel mitigations  | `mitigations=off` observed | `mitigations=off` observed                                  |
| Runtime             | Node 24.19.0, pnpm 12.4.0  | Node 24.19.0, pnpm 12.4.0                                   |

Guest topology does not prove physical hypervisor CPU placement. Equal logical
CPU counts do not establish equal physical compute capacity. The single-core
loop also does not measure parallel execution, filesystem behavior, or the
asymmetric CCDs of an AX102.

GitHub's runner API showed `hetzner-ccx-1` (initial registration `577`) and
`hetzner-ccx-2` (`578`) online before dispatch, each with only the benchmark
label. Local runner configuration confirmed `ephemeral: true` and
`disableUpdate: true`, using runner 2.337.0. Job metadata proves subsequent
re-registration and assignment.

**Registry cleanup remains:** the final idle registrations `590`
(`hetzner-ccx-1`) and `589` (`hetzner-ccx-2`) are offline. Both services were
stopped before server deletion. The local `gh` string-rewrite safety guard
blocked the runner DELETE command; it was not bypassed. These entries have no
running host or ongoing rental. They can be removed from the repository's
Actions runner settings by an authorized operator.

## Method

The source selection is successful main CI run
[35562872373](https://github.com/openclaw/openclaw/actions/runs/35562872373),
commit `befbed6bd6ef93fe6fb92230a034642f3183df5a`. Its two longest compact jobs
were `checks-node-compact-large-1` (1,180s job / 1,070s tests) and
`checks-node-compact-large-14` (991s / 946s). This takes the literal two longest
compact jobs; the preceding R2 pilot selected the longest large and small bins.
The fixture preserves their complete group inventories, per-group worker pins,
and the first job's `qaRuntime` build prerequisite. Two additional cells run
the complete cron and gateway-core configs.

The matrix contains two providers × four workloads × three independent samples.
All cells check out the same PR head and use Node 24.19.0, an eight-worker ceiling,
serial group execution, and fresh dependency/compile/transform caches. Existing
lower worker limits remain. The R2 phase observer is reused unchanged. The
single-core probe runs the historical 300-million-iteration `sum += i % 7`
loop after one identical warmup and verifies checksum `899999997`.

The workflow runs only when this same-repository, owner-authored pilot PR opens,
with `run_attempt == 1`. Three samples are matrix rows, never failed-job reruns.
Report pushes do not buy another benchmark. Matrix concurrency is four; the
Hetzner host admits two jobs. The maximum extra registrations are 24 job runners
plus two final idle ephemeral registrations. The pooled quota probe reported a
20,000-registration limit; it does not establish organization-wide free capacity.

Job/step timestamps supply checkout, setup, wall, and created-to-start intervals;
the latter includes matrix admission and is not pure provider assignment latency.
The observer supplies install, build, and test wall seconds. Failed samples stay
in the report, with failing file names, and are not used as successful throughput.
The tables distinguish per-job CPU affinity from host capacity.

The two slots share one VM and its kernel page cache. Ephemeral registration and
fresh workspaces do not create a fresh VM per job. The observer's `/proc/stat`,
host memory, and visible-process totals can include both slots; its cgroup
counters describe the individual service. Neither a runner label nor host-wide
CPU utilization substitutes for the recorded per-job CPU affinity.

## Per-cell outcomes and completed-workload medians

Completed-workload medians include full test attempts that failed, with failure counts explicit; interrupted attempts are excluded. A failed test duration is not successful performance proof. Setup sums checkout, Node, probe, cold-cache preparation, pnpm, install, workload selection, and runtime build. Build is a component of setup, not an additional wall charge.

| Provider      | Workload         | Pass | Test fail | Infra fail | Full test n |      Wall |   Setup | Install |  Build |      Test | Successful-only wall/test (n) |
| ------------- | ---------------- | ---: | --------: | ---------: | ----------: | --------: | ------: | ------: | -----: | --------: | ----------------------------- |
| blacksmith-32 | compact-large-1  |    3 |         0 |          0 |           3 |   729.000 |  71.000 |   4.999 | 32.843 |   645.247 | 729.000 / 645.247 (3)         |
| blacksmith-32 | compact-large-14 |    3 |         0 |          0 |           3 |   605.000 |  41.000 |   5.549 |  0.000 |   560.010 | 605.000 / 560.010 (3)         |
| blacksmith-32 | cron             |    0 |         3 |          0 |           3 |   181.000 |  53.000 |   6.216 |  0.000 |   129.572 | — / — (0)                     |
| blacksmith-32 | gateway-core     |    2 |         1 |          0 |           3 |   684.000 |  50.000 |   7.017 |  0.000 |   633.213 | 682.500 / 629.831 (2)         |
| hetzner-ccx   | compact-large-1  |    2 |         0 |          1 |           2 | 1,512.000 | 105.000 |   9.947 | 60.879 | 1,403.142 | 1,512.000 / 1,403.142 (2)     |
| hetzner-ccx   | compact-large-14 |    2 |         0 |          1 |           2 | 1,346.500 |  45.000 |  10.195 |  0.000 | 1,297.367 | 1,346.500 / 1,297.367 (2)     |
| hetzner-ccx   | cron             |    1 |         1 |          1 |           2 |   322.000 |  36.500 |   8.065 |  0.000 |   281.937 | 329.000 / 281.678 (1)         |
| hetzner-ccx   | gateway-core     |    0 |         2 |          1 |           2 | 1,564.000 |  43.000 |   8.472 |  0.000 | 1,518.069 | — / — (0)                     |

Integrity checks passed: exactly 24 unique provider/workload/sample cells cover 2×4×3 and are all terminal. Every observed BENCH_HEAD_SHA and machine-fact head is 764cdcd8de6f0f6218b3568ce365870f0c7fc709. All 21 observed machine probes report Node v24.19.0 and eight available CPUs. The three checkout-interrupted jobs have no CPU or loop measurement; their table entries remain unavailable. A zero step duration for a skipped Node or pnpm step does not establish that setup completed.

## CPU probe observations

The probe is 300 million fixed-work iterations after an identical 300-million-iteration warmup. Probe n is independent of test qualification: a completed probe remains listed when its later test was interrupted. Every successful checksum is 899999997.

| Provider      | Workload         | Probe n | Affinity CPUs | Host logical CPUs | Median loop seconds |
| ------------- | ---------------- | ------: | ------------- | ----------------- | ------------------: |
| blacksmith-32 | compact-large-1  |       3 | [8]           | [8]               |               0.294 |
| blacksmith-32 | compact-large-14 |       3 | [8]           | [8]               |               0.273 |
| blacksmith-32 | cron             |       3 | [8]           | [8]               |               0.265 |
| blacksmith-32 | gateway-core     |       3 | [8]           | [8]               |               0.258 |
| hetzner-ccx   | compact-large-1  |       2 | [8]           | [16]              |               0.424 |
| hetzner-ccx   | compact-large-14 |       2 | [8]           | [16]              |               0.434 |
| hetzner-ccx   | cron             |       3 | [8]           | [16]              |               0.424 |
| hetzner-ccx   | gateway-core     |       2 | [8]           | [16]              |               0.428 |

Hardware caveat: Blacksmith reports eight guest cores with one thread per core. Hetzner reports eight guest cores with two SMT threads each; affinities 0–7 and 8–15 each select four guest cores and eight logical CPUs. Matching eight logical CPUs therefore does not establish equal physical capacity. Guest topology does not prove hypervisor pinning, and these observations alone do not establish the cause of the performance ratio. Hetzner host RAM is 61.313 GiB with a 28 GiB cap per runner service; Blacksmith reports 30.950 GiB.

Pooled median loop: Blacksmith 0.265701017s; Hetzner 0.425940089s. Hetzner/Blacksmith duration ratio 1.603×.

## Host occupancy, throughput, and cost

Hetzner execution window: 2026-09-21T05:52:23Z through 2026-09-21T07:27:21Z: 5698s (1.582778h). Occupied runner-slot time is 9745s; mean occupied concurrency is 1.710249 of two slots (85.51% slot utilization). This sums first-step-to-completion intervals, never queued time. It excludes provisioning before the first job and teardown after the last job; the full rental estimate, including provisioning and teardown, is recorded above.

All 12 attempts: 7.581608 attempts/hour and €0.059183 per attempt. The 5 successful attempts deliver 3.159003 successes/hour and €0.142038 per successful completion. Prorated window compute estimate is €0.710192 at €0.4487/hour net including IPv4.

The following allocation spreads the observed window cost across jobs in proportion to occupied slot seconds: `€0.4487 × occupied_seconds / (3600 × observed_mean_concurrency)`. It includes the admission-related idle share; it is an allocation, not per-job cloud billing.

| Workload         | Attempts | Attempt cost total EUR | Mean cost/attempt EUR | Successful attempts | Full-workload median allocation EUR (n) |
| ---------------- | -------: | ---------------------: | --------------------: | ------------------: | --------------------------------------: |
| compact-large-1  |        3 |               0.221329 |              0.073776 |                   2 |                            0.110118 (2) |
| compact-large-14 |        3 |               0.196842 |              0.065614 |                   2 |                            0.098057 (2) |
| cron             |        3 |               0.062092 |              0.020697 |                   1 |                            0.023394 (2) |
| gateway-core     |        3 |               0.229929 |              0.076643 |                   0 |                            0.113944 (2) |

## Blacksmith list-price controls

At the [published Ubuntu x64 32-label price](https://www.blacksmith.sh/pricing)
of $0.064 per minute, prorated here using API job wall. These are list-price estimates, not invoice evidence; failed jobs remain costs.

| Workload         | Attempts | Total observed cost USD | Median cost/attempt USD |
| ---------------- | -------: | ----------------------: | ----------------------: |
| compact-large-1  |        3 |                2.339200 |                0.777600 |
| compact-large-14 |        3 |                1.941333 |                0.645333 |
| cron             |        3 |                0.587733 |                0.193067 |
| gateway-core     |        3 |                2.296533 |                0.729600 |

All 12 controls total **$7.1648** at list, before any discount or billing
rounding. The selected compact pair accounts for about **$1.43 per main run**,
not the supplied **$18.35 whole-main** baseline. Migrating this pair would not
replace the rest of that spend.

## Compact-only conditional fleet sizing

Use successful occupied-wall means for capacity: compact-large-1 1511.000s (n=2), compact-large-14 1345.500s (n=2). Sum S=2856.500s per main run. At 4.5 main runs/hour, two slots/box, and 75% utilization target, `N=ceil(4.5S/(7200×0.75))=3` boxes. Implied fleet utilization is 59.51%. An otherwise idle two-slot box can run the pair together in approximately 1511.0s (25.18min); extra boxes reduce queueing, not individual job runtime. This is selected-pair capacity only, not a whole-main runtime prediction or production qualification.

| Operating schedule (30 days) | Main runs | Conditional CCX fleet EUR net | Selected Blacksmith pair USD | Supplied whole-main Blacksmith USD |
| ---------------------------- | --------: | ----------------------------: | ---------------------------: | ---------------------------------: |
| 8h/day                       |      1080 |                        323.06 |                      1540.99 |                           19818.00 |
| 24h/day                      |      3240 |                        839.97 |                      4622.98 |                           59454.00 |

Eight-hour operation assumes deleting/recreating boxes; powered-off servers remain billable. Provisioning/drain reserves are extra. Continuous operation uses the live API's €279.99 monthly cap per box. Currency amounts are separate; no exchange-rate conversion or whole-main savings claim is implied. The four selected workloads do not establish coverage or sizing for all main CI.

## AX102

No Hetzner Robot login or webservice credential was found in the authorized
credential inventory, so no AX102 was ordered and there is no order ID.
The [AX102 product page](https://www.hetzner.com/dedicated-rootserver/ax102/)
currently advertises Falkenstein and Helsinki, not Ashburn: Ryzen 9 7950X3D,
128 GB DDR5 ECC, and two 1.92 TB NVMe drives in the default configuration.

To order, sign in to [Hetzner Robot](https://robot.hetzner.com/), open the AX102
configuration from the product page, choose Falkenstein (`FSN 1`) if available,
retain the default CPU/RAM/disks, choose Ubuntu 24.04 or the Linux rescue
installation path, add no optional hardware or services, review the displayed
setup/hourly price and terms, and submit the order. Record its order ID and wait
for provisioning. Cloud API credentials cannot place this Robot order.

An AX102 timing estimate remains a projection until the same probe and workloads
run on that hardware. A measured CCX-to-Blacksmith ratio alone does not establish
the AX102's single-core speed. Any numeric projection must state its assumed or
independently measured AX102 ratio and retain setup/I/O time separately.

## AX102 conditional projection — unmeasured and optimistic

Assume, without AX hardware evidence, that AX102 matches the pooled measured Blacksmith single-core loop. This gives test scaling factor `0.265701017/0.425940089=0.623799`. For each successful compact workload, project `CCX wall − CCX test + CCX test × factor`: setup, teardown and other elapsed time remain fixed, while every test second is optimistically treated as CPU-scalable. It does not predict storage, cache, SMT, memory, CCD placement, or reliability. No AX order exists and no AX performance was measured.

| Workload         | Observed CCX wall median | Observed CCX test median | Fixed setup/other | Conditional AX test | Conditional AX wall |
| ---------------- | -----------------------: | -----------------------: | ----------------: | ------------------: | ------------------: |
| compact-large-1  |                 1512.000 |                 1403.142 |           108.858 |             875.279 |             984.137 |
| compact-large-14 |                 1346.500 |                 1297.367 |            49.133 |             809.296 |             858.429 |

## Host maintenance interruption

Provisioning omitted suspending Ubuntu's automatic package maintenance before
starting the experiment. `apt-daily-upgrade.service` began at 06:17:28 UTC and
finished at 06:19:12. Its unattended package upgrades restarted both runner
services at 06:18:16 and again at 06:18:36. This interrupted Hetzner cron sample 1
during tests, gateway-core sample 1 during checkout, and both compact sample 2
jobs during checkout. Their failed outcomes remain infrastructure failures;
they are not passing samples or measured test-throughput results.

Both initial compact test phases finished before maintenance began:
`large-14` at 06:14:26.545 and `large-1` at 06:17:26.555. The latter job's final
housekeeping ended in the same second maintenance started. Cron sample 2 setup
overlapped maintenance. Later samples use the updated user-space package image,
so pooling their times does not establish a controlled three-sample qualification.

After verifying the upgrade service was inactive, recovery runtime-masked
`apt-daily.timer` and `apt-daily-upgrade.timer`. It did not restart the runners
or rerun a job. The running kernel stayed `6.8.0-138-generic` with
`mitigations=off`; the newly installed kernel was not booted. Future temporary
benchmark images should complete maintenance and suspend its timers before
runner admission, with maintenance outside the measurement window.

## Failure evidence

- Job 106228331600: blacksmith-32 / cron / sample-1: test-failure; cron src/cron/command-runner.test.ts > runCronCommandJob > kills shell process groups on timeout
- Job 106228331575: blacksmith-32 / cron / sample-2: test-failure; cron src/cron/command-runner.test.ts > runCronCommandJob > kills shell process groups on timeout
- Job 106228332405: blacksmith-32 / cron / sample-3: test-failure; cron src/cron/command-runner.test.ts > runCronCommandJob > kills shell process groups on timeout
- Job 106228331543: blacksmith-32 / gateway-core / sample-1: test-failure; gateway-core src/gateway/worker-environments/workspace-large-inventory.test.ts > stages, applies, and recovers 13,000 modified files through a serialized journal
- Job 106228331537: hetzner-ccx / compact-large-1 / sample-2: runner-shutdown; runner shutdown; no test verdict
- Job 106228331573: hetzner-ccx / compact-large-14 / sample-2: runner-shutdown; runner shutdown; no test verdict
- Job 106228331428: hetzner-ccx / cron / sample-1: runner-shutdown; runner shutdown; no test verdict
- Job 106228331533: hetzner-ccx / cron / sample-2: test-failure; cron src/cron/service.manual-delivery.test.ts > manual cron delivery occurrence > delivers according to the queued force occurrence after the scheduled slot ages
- Job 106228331524: hetzner-ccx / gateway-core / sample-1: runner-shutdown; runner shutdown; no test verdict
- Job 106228332441: hetzner-ccx / gateway-core / sample-2: test-failure; gateway-core src/gateway/session-history-worker-lifecycle.test.ts > evicts the least recently used of 64 retained targets without charging missing databases; gateway-core src/gateway/session-history-worker-lifecycle.test.ts > rejects the captured generation when A closes during restoration before worker admission; gateway-core src/gateway/session-row-selection.test.ts > reuses resident key predicates across list requests and refreshes legacy spawned classification; gateway-core src/gateway/worker-environments/workspace-large-inventory.test.ts > stages, applies, and recovers 13,000 modified files through a serialized journal
- Job 106228332519: hetzner-ccx / gateway-core / sample-3: test-failure; gateway-core src/gateway/session-history-worker-lifecycle.test.ts > evicts the least recently used of 64 retained targets without charging missing databases; gateway-core src/gateway/session-history-worker-lifecycle.test.ts > rejects the captured generation when A closes during restoration before worker admission; gateway-core src/gateway/session-row-selection.test.ts > reuses resident key predicates across list requests and refreshes legacy spawned classification; gateway-core src/gateway/worker-environments/workspace-large-inventory.test.ts > stages, applies, and recovers 13,000 modified files through a serialized journal

The four Hetzner infrastructure interruptions occurred during Ubuntu unattended upgrades. Maintenance began 06:17:28 UTC, stopped both runner units at 06:18:16 and 06:18:36, and finished 06:19:12. Original compact test phases ended at 06:14:26.544790 and 06:17:26.555339, before maintenance. Cron sample 2 setup overlapped maintenance. Later full samples use changed packages with the same running kernel. The host owner then masked maintenance timers after confirming the upgrade inactive.

Blacksmith cron failed the real-shell process-group cleanup assertion in all three planned samples. The fixture advances fake deadlines/grace while OS termination/reaping is real; this is a plausible race, not a proven root cause. Hetzner cron sample 2 missed the queued completion event within Vitest’s default 1000ms wait. Gateway failures include 120s history-worker, row-selection, and 13k-file reconciliation deadlines; cleanup assertions follow the history timeout. Blacksmith gateway sample 2 passed the 13k-file case in 114.380s, leaving only 5.620s margin. No failures were hidden with reruns, weaker assertions, or longer timeouts.

## Validation

Focused proof passed on Blacksmith Testbox `tbx_01m3183fvv1vphk1cycwgsett7`,
backed by [validation run 35565905369](https://github.com/openclaw/openclaw/actions/runs/35565905369).
The command completed in 268.196 seconds, including its frozen dependency
install, the unchanged `ci-workflow-guards.test.ts` suite with one worker,
`scripts/check-workflows.mts`, docs inventory, and changed-file formatting.
The lease was stopped. An earlier lease stopped before tests because its fresh
checkout lacked dependencies; the corrected command installed them first.
No new or changed tests are added by this PR.

The initial P2 autoreview was scoped-clean; the final review result is recorded
in the PR body. Source-log equality, manifest hashes,
the 24-cell matrix expansion, referenced-file existence, and `git diff --check`
also passed. Ordinary CI was skipped for the draft PR; this is not a claim that
the normal full CI suite passed. The measured workflow and test harness are
unchanged by subsequent report-only commits.

## Exact per-job normalized table

Loop and phase values in this table are seconds; CPU-loop values are rounded to milliseconds. The interrupted cron sample's 164.203s test value is partial. Setup values on checkout interruptions are also partial. API wait means job creation to API started_at and includes matrix admission; first-step wait is also retained. Queued placeholder started_at values were corrected when assigned. Actual completed jobs differ from first-step timing only by a few seconds. Both providers are limited by this workflow’s four admitted matrix rows; that queue is not pure provider assignment latency.

| Job          | Provider      | Workload         | Sample   | Result          | CPUs | Loop s | Checkout |   Node |  Pnpm | Install |  Build |   Setup |      Test |  API wall |  Occupied |  API wait | First-step wait |
| ------------ | ------------- | ---------------- | -------- | --------------- | ---: | -----: | -------: | -----: | ----: | ------: | -----: | ------: | --------: | --------: | --------: | --------: | --------------: |
| 106228331609 | blacksmith-32 | compact-large-1  | sample-1 | success         |    8 |  0.294 |   27.000 |  2.000 | 1.000 |   4.999 | 32.843 |  71.000 |   668.702 |   748.000 |   747.000 |     2.000 |           3.000 |
| 106228331554 | hetzner-ccx   | compact-large-1  | sample-1 | success         |    8 |  0.423 |   28.000 |  0.000 | 1.000 |  10.820 | 58.241 | 103.000 | 1,399.015 | 1,506.000 | 1,505.000 |     0.000 |           1.000 |
| 106228331585 | blacksmith-32 | compact-large-14 | sample-1 | success         |    8 |  0.273 |   28.000 |  3.000 | 1.000 |   5.549 |      — |  41.000 |   556.146 |   605.000 |   604.000 |     2.000 |           3.000 |
| 106228331589 | hetzner-ccx   | compact-large-14 | sample-1 | success         |    8 |  0.440 |   30.000 |  0.000 | 1.000 |  12.082 |      — |  48.000 | 1,273.958 | 1,326.000 | 1,325.000 |     0.000 |           1.000 |
| 106228331600 | blacksmith-32 | cron             | sample-1 | test-failure    |    8 |  0.265 |   29.000 |  3.000 | 2.000 |   5.978 |      — |  41.000 |   130.366 |   179.000 |   178.000 |   751.000 |         752.000 |
| 106228331428 | hetzner-ccx   | cron             | sample-1 | runner-shutdown |    8 |  0.424 |   30.000 |  0.000 | 1.000 |   9.641 |      — |  43.000 |   164.203 |   210.000 |   210.000 | 1,346.000 |       1,346.000 |
| 106228331543 | blacksmith-32 | gateway-core     | sample-1 | test-failure    |    8 |  0.258 |   29.000 | 13.000 | 1.000 |   7.017 |      — |  52.000 |   727.755 |   788.000 |   786.000 | 1,327.000 |       1,329.000 |
| 106228331524 | hetzner-ccx   | gateway-core     | sample-1 | runner-shutdown |    — |      — |   26.000 |  0.000 | 0.000 |       — |      — |  26.000 |         — |    29.000 |    28.000 | 1,526.000 |       1,527.000 |
| 106228331622 | blacksmith-32 | compact-large-1  | sample-2 | success         |    8 |  0.245 |   32.000 |  3.000 | 1.000 |   4.802 | 27.880 |  71.000 |   636.619 |   716.000 |   715.000 | 1,564.000 |       1,565.000 |
| 106228331537 | hetzner-ccx   | compact-large-1  | sample-2 | runner-shutdown |    — |      — |   12.000 |  0.000 | 0.000 |       — |      — |  12.000 |         — |    16.000 |    15.000 | 1,560.000 |       1,561.000 |
| 106228331505 | blacksmith-32 | compact-large-14 | sample-2 | success         |    8 |  0.340 |    8.000 |  3.000 | 2.000 |   5.452 |      — |  21.000 |   572.842 |   601.000 |   600.000 | 1,650.000 |       1,651.000 |
| 106228331573 | hetzner-ccx   | compact-large-14 | sample-2 | runner-shutdown |    — |      — |    8.000 |  0.000 | 0.000 |       — |      — |   8.000 |         — |    11.000 |    10.000 | 1,565.000 |       1,566.000 |
| 106228331575 | blacksmith-32 | cron             | sample-2 | test-failure    |    8 |  0.296 |   34.000 | 12.000 | 1.000 |   6.216 |      — |  55.000 |   129.572 |   191.000 |   190.000 | 1,896.000 |       1,897.000 |
| 106228331533 | hetzner-ccx   | cron             | sample-2 | test-failure    |    8 |  0.423 |   17.000 |  0.000 | 2.000 |   8.053 |      — |  29.000 |   282.196 |   315.000 |   314.000 | 1,580.000 |       1,581.000 |
| 106228332522 | blacksmith-32 | gateway-core     | sample-2 | success         |    8 |  0.266 |   35.000 |  2.000 | 1.000 |  10.214 |      — |  50.000 |   626.449 |   684.000 |   683.000 | 2,117.000 |       2,118.000 |
| 106228332441 | hetzner-ccx   | gateway-core     | sample-2 | test-failure    |    8 |  0.423 |   31.000 |  0.000 | 2.000 |   8.441 |      — |  44.000 | 1,520.834 | 1,567.000 | 1,567.000 | 2,088.000 |       2,088.000 |
| 106228332559 | blacksmith-32 | compact-large-1  | sample-3 | success         |    8 |  0.302 |   30.000 |  2.000 | 2.000 |   5.749 | 33.546 |  76.000 |   645.247 |   729.000 |   728.000 | 2,281.000 |       2,282.000 |
| 106228332551 | hetzner-ccx   | compact-large-1  | sample-3 | success         |    8 |  0.426 |   29.000 |  0.000 | 1.000 |   9.074 | 63.516 | 107.000 | 1,407.269 | 1,518.000 | 1,517.000 | 2,252.000 |       2,253.000 |
| 106228332368 | blacksmith-32 | compact-large-14 | sample-3 | success         |    8 |  0.233 |   33.000 |  3.000 | 1.000 |   6.254 |      — |  46.000 |   560.010 |   614.000 |   613.000 | 3,011.000 |       3,012.000 |
| 106228332617 | hetzner-ccx   | compact-large-14 | sample-3 | success         |    8 |  0.428 |   28.000 |  0.000 | 1.000 |   8.307 |      — |  42.000 | 1,320.775 | 1,367.000 | 1,366.000 | 3,674.000 |       3,675.000 |
| 106228332405 | blacksmith-32 | cron             | sample-3 | test-failure    |    8 |  0.242 |   30.000 | 12.000 | 2.000 |   8.605 |      — |  53.000 |   120.644 |   181.000 |   180.000 | 3,656.000 |       3,657.000 |
| 106228332540 | hetzner-ccx   | cron             | sample-3 | success         |    8 |  0.509 |   32.000 |  0.000 | 1.000 |   8.077 |      — |  44.000 |   281.678 |   329.000 |   328.000 | 3,790.000 |       3,791.000 |
| 106228332619 | blacksmith-32 | gateway-core     | sample-3 | success         |    8 |  0.252 |   28.000 |  3.000 | 2.000 |   6.713 |      — |  40.000 |   633.213 |   681.000 |   680.000 | 3,839.000 |       3,840.000 |
| 106228332519 | hetzner-ccx   | gateway-core     | sample-3 | test-failure    |    8 |  0.433 |   30.000 |  0.000 | 2.000 |   8.502 |      — |  42.000 | 1,515.303 | 1,561.000 | 1,560.000 | 4,138.000 |       4,139.000 |
