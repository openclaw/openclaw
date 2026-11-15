# Plugin-state bookkeeping workload

## Acceptance rule

Use `scripts/perf/plugin-state-polling.mts --messages 0 --receipts 173
--audit-prefill --expired-audit-orphan --seconds 60` with the frozen SQL observer
and an isolated Gateway, loopback Reef relay, and synthetic state. Use the same
workload without `--expired-audit-orphan` for the no-expiry control. Separate boot
and warm windows.

Before changing production code, attribute every namespace aggregate and expiry
probe in the boot workload. Count data statements per completed append, total
statements, worker requests, and main-thread statements. A candidate must remove
one expiry probe per aggregate-confirmed sweep, preserve the audit-chain result and
quarantine count, and add no statements or requests to warm polling. Retain quota,
TTL, rollback, and read-after-write behavior at the generic operation owner.

For wall-clock or CPU A/B comparisons, take at least five alternating samples per
arm under the campaign timing lock and load below 24. Report median, p95, and
range separately for cold and warm. Every user-facing metric must hold or improve;
a 20% adverse cell stops the candidate. Counts and profiles on a loaded host do
not establish latency improvement. Use one paired frozen-harness warm run when
the host does not qualify for timing, and report that limit explicitly.

## Attribution

Reef appends touch two bounded namespaces: audit entries and the audit head.
Each namespace currently loads transaction-local count and expiry facts on its
first set. The retained-entry delete is adjacent to those scans but does not
issue them. Those aggregates also trigger bounded expired-sibling cleanup, even
when replacing an existing live key, so they remain. An aggregate that found
expired rows can supply that fact to the sweep in the same transaction. A scanned
live view and a full cleanup batch do not establish that fact. No state may
survive its owning transaction.

The table-wide expiry probe may avoid a namespace scan when no expiry is due.
Removing a statement alone is insufficient if its replacement scans more rows.

## Baseline and scope

On production base `61deaaef587` (workload source `124015bbea3`), a real isolated
Gateway on a Blacksmith Testbox (Node 24.22.1, four available CPUs) produced:

| Scenario                                     | Boot SQL / requests / MAIN | Warm 60s SQL / requests / MAIN |
| -------------------------------------------- | -------------------------- | ------------------------------ |
| Full audit, 173 receipts, one expired orphan | 5,363 / 858 / 52           | 33 / 13 / 0                    |
| Same workload, no expired orphan             | 5,361 / 858 / 52           | 33 / 13 / 0                    |

Both scenarios verified a 30,000-entry retained audit chain, head sequence 30,346,
and 173 quarantined receipts. In the expired scenario, plugin-state boot emitted
865 aggregates, 867 multi-key reads, 346 keyed deletes, 1,211 upserts, one expiry
probe, and one bounded expiry delete. Every aggregate traced to operation `set`;
the expiry probe followed the aggregate-confirmed expiry in registration.

The fix removes that one redundant probe. It does not remove aggregates, ordinary
compare/update probes, or the next probe after a full 1,024-row cleanup batch.
SQLite query plans show why unknown-expiry probes stay: their covering expiry
index can avoid scanning a large clean namespace.

The deterministic owner regression covers aggregate-known expiry, a live-only
scan, and more than one cleanup batch. Before the fix, the known-expiry cases
perform one extra probe; read-own-write and the scanned control already pass.
The tests also retain cap rejection and physical expired-row cleanup checks.

This is statement-count evidence only. The local host load exceeded 64, selecting
the campaign's single-pair fallback; no latency or CPU speedup is claimed. CPU
profiles are attribution evidence, not timing samples. The prepared expiry fact
lives in the existing transaction-local view; no persistent cache, invalidation
protocol, SQL text, schema, public SDK signature, or payload bound changes.
