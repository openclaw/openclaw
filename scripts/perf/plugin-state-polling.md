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
