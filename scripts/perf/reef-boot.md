## Problem and proposed change

At startup, replayed receipts with no outbound delivery binding append a read observation and an invalid-delivery observation in separate audit operations. Each operation repeats the same encrypted audit-head and retention work. Reuse the existing grouped audit operation from the Reef owner to append those two observations together.

This is a preparation PR. Production changes and measurements are pending.

## Preregistered acceptance

Use the committed `scripts/perf/plugin-state-polling.mts` workload on the same platform and current main: real isolated Gateway, loopback Reef transport, 80 synthetic signed receipts without outbound bindings, a prefilled 30,000-entry audit chain, zero messages, 60 seconds of separate warm polling, frozen v3.1.4 observer and per-thread CPU profiles. Never use personal state or logs.

Count whole boot SQL, worker requests and main-thread SQL, then warm SQL/requests/runtime MAIN separately. The target is one fewer append operation per missing-binding receipt: 80 fewer requests and the SQL belonging to 80 duplicate head/retention passes. The earlier attribution was 2,738 boot SQL / 479 requests / 53 cold MAIN; reproduce on the new base before comparing. Candidate must retain all 80 quarantines, a verified encrypted chain, a 30,000-entry retained suffix, and runtime MAIN zero. Count whole boot and warm phases so deferral cannot masquerade as removal. Report every adverse operation family; stop on an unexplained 20% increase.

High-load fallback is one baseline/candidate count pair. If the host qualifies for timing, acquire the campaign timing lock and collect at least five interleaved samples per side, with cold and warm separate, reporting median, p95 and range. Otherwise claim no latency or CPU speedup.

Regressions must prove: a failed read-only binding lookup still commits the read observation before propagating the lookup error; a failed missing-binding group stores neither event and an unadvanced cursor retries both together; a present binding commits the read before receipt verification, notification or consume. Existing authority, migration, legacy-chain, encryption, retention and receipt checks stay in place.

## Accepted failure edge

When the grouped missing-binding append fails, neither event is stored. The cursor stays unadvanced and the retry records both. Previously the read could remain stored and be duplicated on retry. Successful audit order is unchanged. This exact failure edge is approved; it is not identical failed-attempt persistence.

## Gates

Two isolated Codex reviews, focused Reef owner tests, static gates and exact-head CI; no schema or SDK API change. PostgreSQL review is required for grouping the existing PG-reachable write operation before landing. Open-PR overlaps must introduce no new conflicts.
