# Background plugin-state reads

## Acceptance rule

Run the existing `scripts/perf/plugin-state-polling.mts` against a real isolated
Gateway and loopback Reef relay, using synthetic state only. Use both an empty
inbox (`--messages 0`) and pending-review workload (`--messages 18`), each with a
60-second steady window after startup. The existing
`scripts/bench-ingress-polling.mts --idle-seconds 60 --sparse-events 0` supplies the
iMessage control. Count with the frozen campaign observer; keep boot and steady
windows separate. Attribute namespace reads, exact-key reads, count probes, and
single-statement transaction envelopes to their actual owners before editing.

A candidate must remove recurring statements and requests in the touched flow,
keep runtime main-thread SQL at zero, and preserve TTL expiry, committed writes,
recovery, and final effect authority. Reuse the existing write/receipt owner;
retain direct reads when there is no complete invalidation contract. No schema
or public SDK signature change is intended.

Run three alternating baseline/candidate count pairs when host load is below 64
and internal free space is at least 12 GiB; otherwise use one pair and disclose
that limit. Also run a frozen warm-turn control. For any timing claim, acquire the
campaign timing lock, wait for load below 24, and run at least five alternating
samples per arm on the same platform. Report median, p95 and range separately
for cold and warm work. Any adverse 20% cell stops acceptance. Without a qualified
host, report counts and per-thread CPU profiles, not latency or CPU speedups.

If current main does not reproduce a target, record the observed per-minute rate
and stop that item. A direct store loop cannot stand in for the Gateway flow.
