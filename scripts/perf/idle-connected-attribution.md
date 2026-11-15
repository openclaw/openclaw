# Connected idle SQL attribution

## Acceptance rule

Run the frozen v3.1.5 SQL observer's standard workload on an isolated Gateway
with synthetic state, its loopback model provider, and a real WebSocket client.
Use three fresh fixtures on current main before changing production code.
Keep the five-second post-turn settling window separate from the subsequent
300-second connected-idle window. Preserve the standard warm turns and restart.

Report every SQL shape and worker operation in both idle windows, its issuing
owner, timer or subscription, and rate per minute. Report SQL, requests, and
main-thread SQL separately. Mark unchanged results only when supported by
observations or the owner's write and read contracts; the observer does not
record result rows. Never collect operator state or include row values.

A candidate must eliminate recurring work from an unchanged source through
the existing owner's write signal or prepared facts, while preserving visibility
of real changes and supported external writers. Lease and heartbeat liveness,
checkpoint cadence, and final authority checks remain protected. An unobserved
pattern or a missing safe invalidation source does not justify a removal.

Compare three alternating baseline/candidate pairs on the same platform,
reporting per-owner counts and per-minute rates, median, p95, and range. Warm
turns and main-thread SQL must not increase; every user-facing metric must hold
or improve. A 20% adverse cell stops the candidate. Prove removed read classes
on the baseline and real-change freshness on the candidate.

Counts and profiles are distinct from timing claims. Before any wall-clock or
CPU A/B measurement, acquire the campaign timing lock and wait for load below 24. Use at least five alternating samples per arm, with cold and warm separated.
If no qualified timing slot is available, report counts and profile attribution
without claiming a latency or CPU improvement.
