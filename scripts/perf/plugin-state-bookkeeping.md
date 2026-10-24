# Plugin-state bookkeeping workload

## Acceptance rule

Use `scripts/perf/plugin-state-polling.mts --messages 0 --receipts 173
--audit-prefill --seconds 60` with the frozen SQL observer and an isolated Gateway,
loopback Reef relay, and synthetic state. Use the same workload without
`--audit-prefill` for the fresh-state control. Separate boot and warm windows.

Before changing production code, attribute every namespace aggregate and expiry
probe in the boot workload. Count data statements per completed append, total
statements, worker requests, and main-thread statements. A candidate must remove
at least one statement per affected append, preserve the audit-chain result and
quarantine count, and add no statements or requests to warm polling. Retain quota,
TTL, rollback, and read-after-write behavior at the generic operation owner.

For wall-clock or CPU A/B comparisons, take at least five alternating samples per
arm under the campaign timing lock and load below 24. Report median, p95, and
range separately for cold and warm. Every user-facing metric must hold or improve;
a 20% adverse cell stops the candidate. Counts and profiles on a loaded host do
not establish latency improvement. Use one paired frozen-harness warm run when
the host does not qualify for timing, and report that limit explicitly.

## Attribution hypotheses

Reef appends touch two bounded namespaces: audit entries and the audit head.
Each namespace currently loads transaction-local count and expiry facts on its
first set. The retained-entry delete is adjacent to those scans but does not
issue them. The generic owner can avoid quota accounting for an already observed
live-key replacement under `reject-new`; the key consumes no additional slot.
New keys, expired keys, eviction, and the next operation must still get current
facts. No state may survive its owning transaction.

The table-wide expiry probe may avoid a namespace scan when no expiry is due.
Removing a statement alone is insufficient if its replacement scans more rows.
