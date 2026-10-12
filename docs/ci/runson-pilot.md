---
summary: "One-attempt comparison of on-demand RunsOn and Blacksmith CI runners"
title: "RunsOn on-demand pilot"
read_when:
  - You are evaluating runner speed, setup cost, or warm pools
---

## Measured outcome

**Keep production routing unchanged.** On this revision, on-demand c8i.4xlarge
was slower than the same-run Blacksmith controls for both critical-path jobs.
Cron completed at every requested worker count, with useful but modest scaling;
the Gateway-core configuration failed at both the baseline and higher ceilings.
NVMe and sticky performance remain unmeasured because the first-attempt verifier
rejected a valid overlay layout. Windows part 1 passed on 16 delivered CPUs.

[Benchmark run 35549787290](https://github.com/openclaw/openclaw/actions/runs/35549787290)
ran from September 21, 2026, 01:06:11 to 01:55:34 UTC, on source
`d58ebb2d103ae6eb9338a48e9562ca4ca5f284ef`, attempt **1**. All 21 cells reached a
terminal result: **10 passed, five failed tests, six stopped at storage verification**.
No cell was rerun. The corrected verifier in this PR was not used by that run.

| Critical-path comparison | Blacksmith wall | c8i.4xlarge wall | Intel change | Blacksmith test | Intel test |
| ------------------------ | --------------: | ---------------: | -----------: | --------------: | ---------: |
| Large                    |           561 s |            755 s |       +34.6% |         512.2 s |    696.8 s |
| Small                    |           816 s |          1,259 s |       +54.3% |         766.0 s |  1,204.9 s |

Blacksmith delivered eight CPUs; c8i.4xlarge delivered 16. Both used eight-worker
caps and genuinely empty pnpm stores: each Linux install downloaded 1,453
packages and reused zero. Most of the Intel regression occurred inside the test
step, rather than checkout or dependency setup. This comparison does not establish
whether CPU, filesystem behavior, or another provider difference caused it.

## Every cell

CPUs are Node's observed available parallelism. Workers are requested Vitest
ceilings, not simultaneous busy-worker measurements. Invalid rows did not reach
workload selection or testing. A dash means unavailable or not applicable, never
zero-cost execution. Failed test durations are observations, not successful
performance samples.

| Cell                                                                                                      | Instance            | CPUs | Workers | Wall s | Test s | Setup s | Wait s | Result                 | EC2 USD |
| --------------------------------------------------------------------------------------------------------- | ------------------- | ---: | ------: | -----: | -----: | ------: | -----: | ---------------------- | ------: |
| [large-bm32](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268700)              | Blacksmith 32 label |    8 |       8 |    561 |  512.2 |      40 |      7 | Pass                   |       — |
| [large-c8i](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268733)               | c8i.4xlarge         |   16 |       8 |    755 |  696.8 |      53 |     21 | Pass                   |  0.1572 |
| [large-nvme](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268799)              | c8id.4xlarge        |   16 |       8 |     37 |      — |      33 |     22 | Invalid: storage check |  0.0091 |
| [large-sticky](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268716)            | c8id.4xlarge        |   16 |       8 |     40 |      — |      34 |     59 | Invalid: storage check |  0.0099 |
| [large-sticky warm](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106189438478)       | c8id.4xlarge        |   16 |       8 |     48 |      — |      43 |     21 | Invalid: storage check |  0.0118 |
| [small-bm32](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268944)              | Blacksmith 32 label |    8 |       8 |    816 |    766 |      42 |    100 | Pass                   |       — |
| [small-c8i](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268769)               | c8i.4xlarge         |   16 |       8 |   1259 | 1204.9 |      49 |    568 | Pass                   |  0.2622 |
| [small-nvme](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268694)              | c8id.4xlarge        |   16 |       8 |     37 |      — |      33 |    777 | Invalid: storage check |  0.0091 |
| [small-sticky](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268771)            | c8id.4xlarge        |   16 |       8 |     40 |      — |      35 |    814 | Invalid: storage check |  0.0099 |
| [small-sticky warm](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106189438642)       | c8id.4xlarge        |   16 |       8 |     38 |      — |      34 |     21 | Invalid: storage check |  0.0094 |
| [cron-c8i.8xlarge-w8](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268844)     | c8i.8xlarge         |   32 |       8 |    156 |  106.3 |      45 |    854 | Pass                   |  0.0650 |
| [cron-c8i.8xlarge-w12](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268888)    | c8i.8xlarge         |   32 |      12 |    139 |   88.9 |      45 |    917 | Pass                   |  0.0579 |
| [cron-c8i.8xlarge-w16](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268919)    | c8i.8xlarge         |   32 |      16 |    138 |   86.4 |      47 |   1011 | Pass                   |  0.0575 |
| [cron-c8a.8xlarge-w8](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268834)     | c8a.8xlarge         |   32 |       8 |    126 |   78.8 |      43 |   1056 | Pass                   |  0.0604 |
| [cron-c8a.8xlarge-w16](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268966)    | c8a.8xlarge         |   32 |      16 |    110 |   65.6 |      41 |   1150 | Pass                   |  0.0527 |
| [gateway-c8i.8xlarge-w8](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182269494)  | c8i.8xlarge         |   32 |       8 |    744 |  695.5 |      44 |   1182 | Fail: tests            |  0.3099 |
| [gateway-c8i.8xlarge-w12](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182269511) | c8i.8xlarge         |   32 |      12 |    748 |  698.8 |      46 |   1260 | Fail: tests            |  0.3115 |
| [gateway-c8i.8xlarge-w16](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182269559) | c8i.8xlarge         |   32 |      16 |    740 |  690.9 |      45 |   1827 | Fail: tests            |  0.3082 |
| [gateway-c8a.8xlarge-w8](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182269498)  | c8a.8xlarge         |   32 |       8 |    767 |  720.2 |      42 |   1926 | Fail: tests            |  0.3674 |
| [gateway-c8a.8xlarge-w16](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182269580) | c8a.8xlarge         |   32 |      16 |    884 |  834.4 |      46 |   2009 | Fail: tests            |  0.4234 |
| [windows-part-1](https://github.com/openclaw/openclaw/actions/runs/35549787290/job/106182268519)          | c8i.4xlarge         |   16 |       1 |   1078 |    788 |     239 |    162 | Pass                   |  0.4449 |

The requested price-times-job-wall estimate totals **$2.94**. Using the
observed EC2 launch timestamps through job completion, with EC2's 60-second
minimum, gives **$4.74**. Neither is an AWS invoice. An additional ten
minutes per instance for unobserved teardown would put compute at **$8.78**,
still below $15. Storage and other service charges are separate. No pool was
activated. An account-side cleanup audit was unavailable with the existing
credentials, so individual EC2 termination and final billing were not
independently verified. The largest observed launch-to-assignment interval was 565 seconds;
job wall alone materially understates allocation time.

`Wait` is GitHub job creation to runner start, and includes this experiment's
matrix admission queue. It must not be presented as pure provider assignment or
boot latency. Warm jobs became eligible after the cold matrix; their dependency
wait is likewise not pool-startup evidence. The experiment does not measure a hot
pool's latency benefit.

## Setup steps

Step values below use GitHub's second-resolution timestamps. `Other setup` covers
machine/storage checks, workload selection, and Windows Defender configuration.
Setup totals exclude runner housekeeping and gaps between steps. `Worker prep`
is the existing compiler's reported duration **inside** the test step; it must
not be added to job wall or counted again in setup totals.

| Cell | Checkout | Node | RunsOn/cache | pnpm setup | Install | Other setup | Worker prep |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| large-bm32 | 27 | 2 | — | 2 | 6 | 3 | 6.52 |
| large-c8i | 29 | 3 | 0 | 2 | 17 | 2 | 9.37 |
| large-nvme | 29 | 4 | 0 | — | — | 0 | — |
| large-sticky | 31 | 3 | 0 | — | — | 0 | — |
| large-sticky warm | 35 | 8 | 0 | — | — | 0 | — |
| small-bm32 | 27 | 3 | — | 1 | 10 | 1 | 6.92 |
| small-c8i | 27 | 3 | 1 | 1 | 16 | 1 | 9.02 |
| small-nvme | 29 | 4 | 0 | — | — | 0 | — |
| small-sticky | 32 | 3 | 0 | — | — | 0 | — |
| small-sticky warm | 29 | 5 | 0 | — | — | 0 | — |
| cron-c8i.8xlarge-w8 | 27 | 4 | 0 | 1 | 12 | 1 | 9.34 |
| cron-c8i.8xlarge-w12 | 28 | 3 | 0 | 1 | 12 | 1 | 8.32 |
| cron-c8i.8xlarge-w16 | 28 | 3 | 0 | 1 | 14 | 1 | 9 |
| cron-c8a.8xlarge-w8 | 26 | 3 | 0 | 1 | 13 | 0 | 6.86 |
| cron-c8a.8xlarge-w16 | 26 | 2 | 0 | 0 | 11 | 2 | 6.85 |
| gateway-c8i.8xlarge-w8 | 27 | 4 | 0 | 1 | 12 | 0 | 8.28 |
| gateway-c8i.8xlarge-w12 | 27 | 3 | 1 | 1 | 12 | 2 | 8.59 |
| gateway-c8i.8xlarge-w16 | 27 | 4 | 1 | 1 | 11 | 1 | 8.23 |
| gateway-c8a.8xlarge-w8 | 27 | 3 | 0 | 1 | 11 | 0 | 6.82 |
| gateway-c8a.8xlarge-w16 | 29 | 3 | 0 | 1 | 12 | 1 | 7.07 |
| windows-part-1 | 79 | 7 | 0 | 3 | 146 | 4 | 71.14 |

Cold Blacksmith dependency installation took 6/10 seconds for the large/small
cells, versus 17/16 seconds on c8i.4xlarge. Worker preparation was approximately
6.5–6.9 versus 9.0–9.4 seconds. Windows checkout, installation, and worker
preparation took 79, 146, and 71.1 seconds respectively. Its complete test part
passed in 788 test-step seconds, with 1,078 seconds of job wall.

No valid sticky-warm installation or worker-preparation measurement exists.
A snapshot cache hit from a cold job that never installed dependencies is not a
warm pnpm sample.

## Worker ceilings and failures

Cron's c8i.8xlarge wall changed from 156 seconds at eight workers to 139 at 12
and 138 at 16: an 11.5% gain from eight to 16, with little difference between
12 and 16 in this single observation. On c8a.8xlarge, eight to 16 workers reduced
wall from 126 to 110 seconds, a 12.7% gain. Both types delivered 32 CPUs.
C8a at 16 workers was 20.3% faster in job wall than c8i at 16. These five cells
passed, but there is no same-run Blacksmith cron control, so this establishes
within-pilot scaling rather than a production provider win.

All five full Gateway-core cells failed. Keep the following concurrency and
lifecycle failures with their exact conditions; do not raise limits or remove
assertions:

| File and case                                                                                                                                         | Observed failure                                                                                                                                                        | Cells                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/gateway/session-history-worker-lifecycle.test.ts`: evicts the least recently used of 64 retained targets without charging missing databases      | Test exceeded 120,000 ms                                                                                                                                                | All five Gateway cells, including both eight-worker baselines |
| Same file: rejects the captured generation when A closes during restoration before worker admission                                                   | 120,000-ms timeout; cleanup `expect(worker.threadId).toBe(-1)` received 658 on Intel and 569 on AMD; pending rejection assertion was not awaited before test completion | Both 16-worker cells                                          |
| Same file: does not restore a replacement database for a revoked history read (before restoration)                                                    | Test exceeded 120,000 ms                                                                                                                                                | AMD 16                                                        |
| Same file: joins the history worker when its 30-minute idle timer fires (`missing=true`)                                                              | Expected thread ID -1; received 1020                                                                                                                                    | AMD 16                                                        |
| `src/gateway/session-row-selection.test.ts`: reuses resident key predicates across list requests and refreshes legacy spawned classification          | Test exceeded 120,000 ms                                                                                                                                                | Intel 12/16 and AMD 16                                        |
| `src/gateway/worker-environments/workspace-large-inventory.test.ts`: stages, applies, and recovers 13,000 modified files through a serialized journal | Test exceeded 120,000 ms                                                                                                                                                | Intel 12/16 and AMD 16                                        |

The eight-worker failures prevent attributing the entire failure set to raising
the ceiling. Higher concurrency exposed additional failures and cleanup
assertions. These are the full Gateway-core configuration, not a claim that an
existing packed production Gateway shard is failing. The underlying timing and
lifecycle causes remain owner follow-ups; none was repaired or hidden here.

## NVMe verifier correction and missing evidence

The runner supplied the requested on-demand c8id.4xlarge with 16 CPUs and actual
EC2 instance storage. However, `/tmp` and `/home/runner` were overlay filesystems:

```text
/tmp: upperdir=/mnt/ephemeral/upper/tmp
/home/runner: upperdir=/mnt/ephemeral/upper/home/runner
/mnt/ephemeral: md0 over Amazon EC2 NVMe Instance Storage
```

The original harness compared the overlay's `st_dev` with the underlying NVMe
filesystem's `st_dev`. Those identifiers differ even when all new writes reach
NVMe. This was a pilot verifier defect, not evidence that RunsOn supplied the
wrong disk. Four cold and two warm cells stopped before pnpm or tests; the cold
sticky stores were never primed.

The correction follows an overlay's writable `upperdir`, verifies its device,
and retains the physical NVMe model check. Sticky stores must still reside on
the separate mounted cache device. A three-second, single-file regression replay
of the actual workflow block reproduced the original rejection and verified six
cases: NVMe overlay, sticky bind mount, and direct NVMe accepted; EBS-backed
overlay, missing writable layer, and wrong physical disk model rejected. This is
captured-layout validation, not a fresh live NVMe performance run. No existing
product test assertion, timeout, worker configuration, or retry policy changed.

## Recommendation and follow-ups

- Route **none of the measured critical compact jobs** to c8i.4xlarge on the
  strength of this pilot: both comparisons regressed materially.
- Cron is a candidate for a separately approved 12/16-worker comparison against
  Blacksmith, with c8a.8xlarge the fastest RunsOn option observed here. One passing
  attempt per cell does not establish broader concurrency stability.
- Resolve the named Gateway history-worker, selector, and large-inventory
  failures at their existing owners before raising that family's worker ceiling.
- A new authorized experiment is needed for NVMe and sticky-warm performance
  after the verifier correction. The one-attempt constraint leaves those
  conclusions blocked in this report.
- Do not activate a hot pool based on the raw matrix queue times. Its configuration
  must be published through the owning default-branch runner configuration, and
  its latency benefit has not been measured.

## Method

The harness reuses `scripts/ci-provider-bench-phase.py` unchanged from the last
September provider experiment, commit
`bb1124465258037271a6b1dfae20d07b7c8f96d1`, whose workflow was
`.github/workflows/provider-bench-5.yml`. Origin no longer advertises the
`ci-probe/*` branches; the retained local branch supplied the original harness.
There are no provider benchmark report links in the current runner guide.

The newest successful main CI run at selection was
[35542241125](https://github.com/openclaw/openclaw/actions/runs/35542241125),
at `7d1371e25f693185f6f2b1e4a4cd111b5552b4b6`. Its longest large and small
compact jobs supplied the complete encoded group manifests:

| Main job                       | Wall seconds | Test-step seconds |
| ------------------------------ | -----------: | ----------------: |
| `checks-node-compact-large-16` |          849 |               794 |
| `checks-node-compact-small-12` |          794 |               748 |

Each manifest runs on the same PR revision on Blacksmith's 32 label, on-demand
`c8i.4xlarge`, NVMe `c8id.4xlarge`, and `c8id.4xlarge` with a sticky pnpm store.
The sticky pair has distinct cold and warm jobs with the same lineage, Git ref,
and source revision. Main timings explain selection; same-run controls determine
provider comparisons because main and the PR can contain different source.

The full cron config and full Gateway-core config separately run on
`c8i.8xlarge` at 8, 12, and 16 workers, and `c8a.8xlarge` at 8 and 16. The
workflow verifies the effective worker count and file parallelism. Existing
assertions, exclusions, group pins, and timeout policies remain intact. A failure
is a result, with the file and assertion retained; it never triggers a rerun.
Windows runs the complete first Windows CI part on `c8i.4xlarge` with
`windows25-full-x64`, retaining CI's one-worker, serial-project policy.

Node is pinned to `24.19.0`, the actual version recorded by the selected CI
run's `24.x` lane. This replaces the old harness's Node 26. Dependency
installs use the repository's pinned pnpm, frozen lockfile, and native side-effects
cache. All initial stores are cold; the sticky warm jobs alone reuse their cold
cell's store. No shared Actions dependency cache is read or written. Setup-node,
checkout, installation, and test steps remain separately timed. Worker compilation
is owned by the existing shard runner and its reported preparation duration is
identified separately within test-step time.

AWS NVMe images automatically mount instance storage for `/tmp` and
`/home/runner`; the corrected workflow verifies the writable layer and physical NVMe models. The sticky variant
keeps `/tmp` on NVMe and places pnpm's store on the snapshot-backed disk. It
verifies the mounted device and requires both an action cache hit and the cold
cell's revision marker before accepting a warm observation.

## Budget and timing definitions

Every AWS label uses `spot=false/retry=false`. The workflow admits one run on PR
opening, only on the named same-repository maintainer branch; report updates do
not run it again. Each cell has a 25-minute job limit. The complete AWS inventory
is two Linux c8i.4xlarge, six c8id.4xlarge, six c8i.8xlarge, four c8a.8xlarge,
and one Windows c8i.4xlarge. Blacksmith supplies two controls. The cold matrix
admits at most three jobs concurrently; Windows is one independent job.

The sum of hourly rates is $24.20072. At 25 minutes plus a ten-minute allocation
and teardown reserve per instance, the planned EC2 ceiling is **$14.11709**,
below the **$15** cap. This is a conservative reservation, not a billing receipt.
Stop the pilot if observed allocation overhead threatens the remaining reserve.
No pool is provisioned. EBS, snapshots, network, and control-plane charges are
separate from the requested EC2 estimate.

Report job wall as GitHub `completed_at - started_at`, and assignment wait as
`started_at - created_at`. Warm jobs additionally depend on the cold matrix;
their dependency wait must not be described as runner assignment latency. Setup
seconds sum the named checkout, runner/cache, Node, machine verification, pnpm,
install, workload-selection, and Windows Defender steps. Test seconds use the observer's elapsed
duration, including runner-owned worker preparation. Windows uses its named test
step duration. Report worker preparation as a component, not an additional wall
charge. AWS compute estimates are `hourly_rate × job_wall_seconds / 3600`;
boot and teardown add billable time outside that comparison.

## Prices and pools

Official AWS us-east-1 on-demand prices, feed published September 18, 2026:

| Instance / OS       | Advertised vCPU | RAM GiB | USD/hour | Two hot instances/day |
| ------------------- | --------------: | ------: | -------: | --------------------: |
| c8i.4xlarge Linux   |              16 |      32 |  0.74968 |              35.98464 |
| c8id.4xlarge Linux  |              16 |      32 |  0.88704 |              42.57792 |
| c8i.8xlarge Linux   |              32 |      64 |  1.49936 |              71.96928 |
| c8a.8xlarge Linux   |              32 |      64 |  1.72432 |              82.76736 |
| c8i.4xlarge Windows |              16 |      32 |  1.48568 |              71.31264 |

Sources: [AWS Linux price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Linux/index.json)
and [AWS Windows price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20East%20%28N.%20Virginia%29/Windows/index.json).
Delivered CPU counts come from the jobs, not these specifications. C8a is Zen 5,
with one physical core per vCPU; it does not use the earlier Zen 4 experiment's
custom mitigation-disabled image. The pilot records the kernel command line.

RunsOn reads public-repository runner configuration from the default branch.
[Pools](https://runs-on.com/docs/performance/warm-pools/) additionally belong to
the organization's `.github-private` repository, at `.github/runs-on.yml`.
Therefore this PR documents the following example without installing it:

```yaml
runners:
  r2-c8i-on-demand:
    family: [c8i.4xlarge]
    image: ubuntu24-full-x64
    spot: false
    volume: 80gb:gp3:125mbps:3000iops
pools:
  r2-c8i-hot:
    env: production # Match the deployed stack environment.
    runner: r2-c8i-on-demand
    timezone: UTC
    schedule:
      - name: always
        hot: 2
        stopped: 0
```

Two hot c8i.4xlarge instances cost **$35.98/day compute**, plus approximately
$0.43/day for two 80-GiB baseline gp3 roots and other service charges. Jobs would
select `runs-on=<run-id>/pool=r2-c8i-hot`. A pool trades continuous idle cost for
lower startup latency; this pilot does not measure that benefit.

References: [labels and configuration](https://runs-on.com/docs/runners/labels/),
[NVMe mounts](https://runs-on.com/docs/runners/capabilities/local-storage-nvme/),
[sticky disks](https://runs-on.com/docs/runners/capabilities/sticky-disks/), and
[Windows images](https://runs-on.com/docs/runners/platforms/).

## Validation status before the benchmark

Workflow lint (including shell checks), formatting, the report's MDX check, and
`node scripts/check-changed.mjs` passed. The Python observer is byte-identical to
the September harness. Production `ci.yml` has no diff.

The single local guard run on base `21f3d71a09d4` ran all four requested files:
2,147 cases passed, 12 skipped, and two timed out. Vitest reported 2,663.55 seconds;
the wrapper wall was 2,675.72 seconds. Both Node planner files passed. These failures remain explicit proof gaps:

- `ci-workflow-guards.test.ts`: **keeps the preflight manifest import closure
  dependency-free** killed its native Node child after 30.079 seconds, with
  empty output and `status=null` instead of zero. It extracts the unchanged
  preflight script from `ci.yml` and uses a fixed direct-test-path fixture.
- `test-projects.test.ts`: **bounds extensionless prefix probes while excluding
  deleted cached matches** exceeded its 120-second timeout, returning after
  155.101 seconds. It uses a separate six-file Git fixture; the log does not
  identify whether Git setup, selector inventory, or cleanup stalled.

Neither failing path directly consumes the pilot files. Their helpers remain
unchanged through base `21688de06dae`, but their timing root cause is unproven;
no retry, timeout increase, assertion change, or passing result replaces them.
Follow-up belongs with the [tooling lane](https://github.com/openclaw/openclaw/pull/153820),
with the [planner lane](https://github.com/openclaw/openclaw/pull/154057) involved
if the preflight child stalls in planning. Neither linked change is claimed to
fix these exact failures. This experiment is not a merge candidate.

The original-head [regular CI run](https://github.com/openclaw/openclaw/actions/runs/35549787305)
passed. That does not erase the recorded local guard failures or the separate
benchmark failures. Initial candidate and committed-branch P2 autoreviews were
scoped-clean. The fresh review verdict for the verifier correction and final
report is recorded in the PR body. Raw job/step metadata, one download of each job log, normalized
metrics, and the storage regression are retained locally under
`.artifacts/provider-bench-r2-35549787290/`.
