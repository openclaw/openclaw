# Synthetic boot scale acceptance

Preregistered before the first run on baseline `c2e29980f08775b8f2574820fc414ae0f2cfa42c`.

Flow: cold isolated Gateway boot, readiness probe, startup cleanup settling, one minute
warm idle, and clean shutdown. Use the frozen v3.1.4 observer and its causal hooks,
never live state. Seed 300, 1,000 and 3,000 sessions over three agents through the
existing session lifecycle fixture, with 50 registered worktrees. Exercise empty
transcript windows separately from historical windows with transcript events;
the empty cohort reproduces projection cleanup's per-session probes. Attribute the
largest twenty statement shapes to their source owners. Independently exercise the
existing real loopback Reef workload to separate event-driven boot-slice traffic
from work proportional to the number of sessions. The complete channel/plugin
inventory is pending; partial fixtures must be labeled as such.

Count statements, worker requests and main-thread SQL separately in boot, settling,
warm idle and shutdown. A candidate must remove its targeted per-entity requests
or statements at 1,000 sessions, without increasing runtime main-thread SQL. Count
the whole boot-plus-settling interval so deferral cannot masquerade as deletion.
Report any other increased family and stop for a 20% adverse cell. Ready means the
Gateway answers the readiness probe and real session RPC, not merely listening.

Counts and profiles may run under load through the campaign proof semaphore.
Latency comparisons require the campaign timing mkdir lock and one-minute load
below 24. Interleave baseline/candidate with at least five samples per side for
latency; report median, p95 and range, cold and warm separately. If the host stays
busy for 60 minutes, report counts and profile attribution only, with no latency
claim. Three alternating frozen-harness count pairs apply when load <64 and free
space >=12 GiB; otherwise one pair, or source attribution and the next census.

No schema changes, new caches or speculative production simplification. A live
pattern not reproduced on current main is rejected as a target for this lane.
