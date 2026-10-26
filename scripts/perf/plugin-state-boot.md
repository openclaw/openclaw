# Populated plugin-state boot attribution

This investigation distinguishes repeated writes from genuine startup work before
changing the plugin-state owners. No production change is proposed yet.

## Acceptance registered before measurement

Run the existing committed `plugin-state-polling.mts`,
`crabbox-state-polling.mts`, and `session-lifecycle-boot.ts` workloads on the same
platform and pinned head, using synthetic state and the frozen SQL observer.
Exercise Reef with a full 30,000-entry audit chain and 80 signed receipts, Crabbox
maintenance without provider effects, and populated historical session windows.
Keep each workload's boot, settling, warm, and shutdown phases separate; report
whole-owner totals so delayed work cannot count as a saving. These independent
fixtures do not establish a combined multi-plugin startup total.

Attribute inserts and deletes to their owner and classify them as identical
value-and-expiry rewrites, deletion followed by recreation of the same key, or
real changes. Classify indexed lookups and namespace counts separately from
writes. Never record values or bound parameters in reports. Read classification
must distinguish repeated reads of the same synthetic session from one read per
session. Include a populated cold-archive cohort before drawing conclusions
about cold-archive startup reads.

Counts come first: SQL statements, worker requests, and Gateway main-thread SQL
per phase and per operation. Record per-thread CPU profiles for attribution.
Main-thread runtime SQL must not increase. A candidate must eliminate its target
class without increasing that owner's whole-flow work; every adverse family
needs attribution, and a 20% adverse metric stops the change. Preserve expiry,
audit verification and retention, write ordering, and plugin contracts.

For a candidate collect three alternating baseline/candidate count pairs when
host load and disk allow; otherwise use one count pair and disclose the limit.
Timing comparisons additionally require exclusive timing admission and one-minute
load below 24, at least five interleaved samples per side, and separate cold/warm
median, p95, and range. Without qualifying timing samples, make no latency or
CPU-speedup claim. Do not change schemas or add caches to manufacture a saving.

If a targeted no-op class does not reproduce on current main, report its observed
count and reject that item. A reproduction that never reaches its owner is a
fixture gap, not evidence that the owner has no redundant work.
