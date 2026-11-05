# Conditional Workboard card persistence measurement

## Acceptance rule

Measure the current main branch before changing production code. Use only a
new, synthetic state directory and a loopback Gateway with the Workboard plugin
enabled. Exercise card creation and card updates over its authenticated WebSocket
RPC transport. Separately count native statements at the persistence owner for
successful creation, duplicate creation, successful update, stale update, and
missing-card update, including populated child collections.

The proposed win is one fewer SQL statement per accepted conditional write, with
no additional worker requests, no additional main-thread SQL, and unchanged
parent/child contents and rejection/error ordering. Rejected writes must perform
no child replacement. A failed child write must roll back the parent and every
child table. Retain the existing transaction and PostgreSQL writer custody.

Use `scripts/perf/workboard-read-measure.ts` for the real Gateway control:
`--boards 1 --cards 20 --clients 1 --waves 20 --interval-ms 250`, with a fresh
`--root`, a free `--port`, and separate `--prepare` and measurement invocations.
Its after-mutation phase performs twenty conditional card updates; ordinary
creation is an unconditional control. Native owner proof covers conditional
creation. Its warm phase checks unchanged reads. Observe all processes/threads with the frozen SQL
observer; keep preparation, warm reads, and mutations separate. Report normalized
per-operation SQL and request counts, total counts, main-thread counts, and
per-minute rates. Discard raw synthetic state and ledgers after extraction.

For qualified timing, run baseline/candidate interleaved at least five times each
under the campaign timing lock with one-minute load below 24. Report cold and warm
separately, median, p95, and range. All user-facing metrics must hold or improve;
a 20% regression in any cell stops the change. If qualification takes over an
hour, report operation counts and CPU profiles without a wall-clock claim.
Profile the real Gateway and workers with the existing per-thread CPU-profile
support. Frozen-harness warm control follows the same campaign host qualification
and attribution rules.

## Results

The acceptance rule above was committed and published before the first run.
Baseline production was `6113057491a29b36239ae8f9400617fb1e47729a`. Both arms used
the committed workload at `4a90e314b7cbaa0fd23e96da1e7574e249ba5e4a`, which waits for
Gateway readiness before connecting. Only its relative imports were relocated
to the tested checkout; reversing that relocation reproduced the committed bytes.
The frozen v3.1.4 observer hashes passed verification (36 files).

One baseline/candidate pair, with twenty accepted updates in each arm, produced:

| Workload                         | Baseline SQL / requests / MAIN | Candidate SQL / requests / MAIN |
| -------------------------------- | ------------------------------ | ------------------------------- |
| Startup                          | 328 / 98 / 86                  | 329 / 100 / 85                  |
| Warmup                           | 24 / 7 / 0                     | 22 / 6 / 0                      |
| Warm unchanged reads             | 193 / 11 / 0                   | 181 / 9 / 0                     |
| Updates and shutdown             | 981 / 113 / 6                  | 978 / 116 / 6                   |
| Workboard update operations only | 900 / 100 / 0                  | 880 / 100 / 0                   |
| Workboard unchanged reads only   | 0 / 0 / 0                      | 0 / 0 / 0                       |

The twenty separate revision reads and twenty board-kind reads became twenty
combined admission queries. Parent and child writes are unchanged: one SQL
statement disappears per accepted update, with no additional worker request or
Gateway MAIN statement. The synthetic schedule is four updates per second, or
240 fewer statements per configured minute; this is not a live traffic estimate.
Both arms completed forty warm reads and forty post-update reads without RPC or
SQL errors. The six MAIN statements in the last phase belong to shutdown.
Seventeen additional statements and three requests in that phase are existing
background maintenance, independently visible in the normalized SQL shapes.

The populated-twelve-collection native probe measured accepted conditional
create/update at 29 → 28 statements, including BEGIN/COMMIT; duplicate, stale,
and missing writes stayed at 3. The existing owner test fails on baseline only
at the accepted-write count (27 → 26 prepared executions) and passes on the
candidate, preserving complete child postimages and rejection/error ordering.

These are deterministic operation counts from one pair, not qualified timing
statistics. Host load exceeded the timing threshold; forty per-thread CPU
profiles per arm provide attribution only. No latency, p95, or CPU-time gain is
claimed. The operation-count saving is deletion, with no caching or worker move.
