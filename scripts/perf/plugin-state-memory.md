# Resident plugin-state acceptance

Preregister this rule in the PR before the first run. The baseline is the PR's
recorded current-main commit; candidate results name the exact tested commit.
Use only synthetic fixtures and the frozen SQL observer. Never use operator
state, logs, database rows, or message contents in reports.

## Flow and workload

Run `scripts/perf/plugin-state-polling.mts --messages 0 --receipts 0
--pending-delivery --seconds 180` with an isolated Gateway and the real bundled
Reef channel against its loopback HTTP/WebSocket relay. The dormant outbound
delivery populates the local trust operation without triggering a remote send.
Use the existing Crabbox polling workload as an empty control. Keep startup,
first load, warm polling, and shutdown separate. If main does not reproduce
recurring plugin-state reads, stop this target and report the evidence.

## Counts and correctness

After the first load, resident read-only polling must execute zero plugin-state
SELECTs and zero plugin-state read BEGIN/COMMIT statements per minute. Preserve
remote polling cadence and results. Runtime main-thread SQL must stay zero.
Count worker requests separately: a worker handler still requires a request,
while a simple resident getter can avoid one.

Report every namespace load and reload per minute during the populated cell,
including unknown-order retirement, eviction and oversize fallback. For the
small fixed fixture, warm namespace reloads bound unknown-order reloads even
if no additional diagnostic signal is available. If reloads happen on most
polls, stop; an invalidating side cache does not satisfy this change.

Known committed writes must be visible to the next ordinary resident read
without SQL. Preserve rollback, cross-store commit order, sync compatibility,
transaction-local reads, expiry, comparison authority, and native deletion and
compensation. Cold, evicted, oversized and unknown-outcome cases may use the
existing coherent SQL path; report them separately. Include Doctor raw repair,
test clear/seed, TTL/capacity eviction, retained moves and journal writes in
writer coverage. A stale reply must not overwrite a later committed write.

## CPU, memory and sampling

Count first with three alternating baseline/candidate pairs when the host meets
the campaign capacity rules; report median and min/max for statements, requests
and MAIN, plus per-operation and shared-reader-family deltas. Keep the warm
non-regression workload. A qualified one-pair fallback is labeled as such.

Profile the real Gateway with `node --cpu-prof` on main and worker threads.
Include snapshot serialization, transfer and decoding; report both main-thread
and total CPU work. Moving work between threads is not a saving. Account for
resident bytes and transient snapshot copies; report process and worker memory.

For timed comparisons, use the same platform, interleave at least five samples
per arm, and separate cold from warm. Take the campaign timing lock and wait
for load1 below 24. Report median, p95 and spread. Every user-facing metric must
hold or improve; any adverse 20% cell stops the candidate. If the timing wait
exceeds 60 minutes, report counts/profile evidence and explicitly leave latency
unmeasured rather than interpreting loaded-host elapsed times.

## Required proof and landing

Exercise expiry, eviction, restart/crash reload, writer visibility, malformed
JSON error behavior, key normalization and read ordering in existing owner
suites. Remove tests of the replaced dual cache while preserving distinct
behavior contracts. Run focused checks, dependency-cycle/unused-code checks,
T1 and dialect ratchets, and affected SDK/prompt-prefix checks as applicable.

Complete two isolated Codex reviews of the production change. Report net
production and test LOC; more than approximately 150 added production lines
requires coordinator disposition before READY. Check open-PR overlap through
the campaign index and prove no new conflicts.

Before landing, request PostgreSQL review with the exact head and answers for
transaction/lock ordering, bounded SQL/payload work, owner invalidation,
schema/identity/admission, thread/request/MAIN accounting, and actual PG proof
or gaps. Wait for exact-head REVIEW-OK and green required CI. Doctor repair
also requires the published-driver upgrade cell under the campaign's
immediately-available-box/post-land policy.
