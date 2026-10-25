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

## Reproduction status

Preregistered before executing the workload. No saving is claimed yet.
