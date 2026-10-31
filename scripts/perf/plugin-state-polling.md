# Plugin-state polling workload

## Acceptance rule (before measurement)

Exercise an isolated Gateway with the bundled Reef channel enabled against a
loopback HTTP/WebSocket relay. Seed synthetic identities and parked inbound
messages awaiting review. Keep the real replay, review, trust, and plugin-state
workers in the path. Do not use operator state or external services.

Count statements and worker requests per completed retry and per steady-state
minute, with main-thread SQL reported separately. Separate startup and first
delivery from warm polling. Attribute each recurring shape to its owner before
changing production code. Also test an empty inbox control.

A candidate must remove recurring work while preserving replay exclusion,
pending-review decisions, TTL visibility, quota behavior, and committed updates
from other supported writers. No SDK signature or schema change is intended.
Warm statements, requests, and main-thread work must not increase. Retain a
regression for each removed read/write class and TTL/cross-writer correctness.

For wall-clock or CPU A/B comparisons, interleave at least five samples per arm;
report median, p95, and range, keeping cold and warm separate. Every user-facing
metric must hold or improve; a 20% adverse cell stops the candidate. Acquire the
campaign timing lock and wait for load below 24 before timed comparisons. Counts
and CPU profiles remain useful independently of wall-clock qualification.

If current main does not reproduce the live shape, report the workload and rates
and stop that item. No optimization is justified by a synthetic direct-store loop
that bypasses the channel owner.

## Boot audit workload

Use `--messages 0 --receipts 173 --audit-prefill --seconds 60` to seed a full
30,000-entry synthetic audit chain offline, then deliver 173 correctly signed
receipts with no matching outbound binding through the real relay transport.
Reef must quarantine those receipts and retain a valid bounded audit suffix.
Each receipt produces two audit appends: a read observation and its quarantine
record, for 346 appends. Wait until the relay observes the completed cursor
before starting the warm phase.
The seed is outside measurement; the Gateway's boot, warm polling, and shutdown
remain separate phases. A fresh audit control omits `--audit-prefill`; an empty
inbox control also sets `--receipts 0`.

The target is the boot-only audit append: three upserts, two multi-key reads,
two namespace count/expiry aggregates, and one retained-entry delete per append
on the full chain, plus one transaction envelope. Attribute other owners
separately. A candidate wins only if it removes target statements or requests
without increasing warm statements, requests, or MAIN SQL, while preserving
the audit chain, capacity, expiration visibility, and real-writer visibility.
Use five alternating samples per arm for a performance claim; any adverse
20% metric stops the candidate. No wall-time claim without the timing lock
and host load below 24.
