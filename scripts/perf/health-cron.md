# Cron health projection workload

Create fresh offline state with `health-cron-fixture.ts --state-dir <new-dir>`.
It extends the existing team fixture with three agents, three synthetic sessions,
two disabled primary proactive jobs, one converted sibling, an absent receipt
target, and one ordinary job. No inference or external service is required.

Run the committed `idle-gateway-measure.ts` against that state with `--subscribe`
(signed real WebSocket client), `--minutes 2 --settle-seconds 10`, the frozen SQL
observer, and `--cpu-profile-dir`. Profiles include Gateway threads. Use a fresh
port and fresh output directory. The connected client activates the real
one-minute health refresh owner; this is not a mock health collector.

Acceptance rule, registered before measurement: count all-thread statements,
worker requests, and MAIN separately per steady minute. Baseline must show the
proactive receipt/job reader. Candidate must remove that reader from steady
health refreshes, preserving its initial/invalidation reads. Expected saving per
refresh is one worker request, three receipt SELECTs, one selected-jobs SELECT,
and the existing transaction envelope; actual observed counts decide. The
primary job retains precedence over its converted sibling. Deleted/ordinary
jobs do not appear as primary heartbeat jobs. No warm statement/request/MAIN
regression is accepted.

Use alternating baseline/candidate runs: three pairs when host load is below 64
and internal free space is at least 12 GiB; otherwise one pair and report the
source-attributed count limits. Keep cold boot and steady windows separate.
Use the frozen general workload for warm-turn non-regression.

Timing runs additionally require the campaign timing lock, load below 24,
at least five interleaved samples per side, and median/p95/range reporting.
Counts and CPU profiles do not establish a latency result on a loaded host.
Any 20% user-facing metric regression stops the change.
