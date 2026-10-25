# Cron SQL attribution

Measure one explicit `cron.run` RPC through the real WebSocket Gateway, isolated
session, synthetic provider turn, run receipts, delivery, and cleanup. Use the
frozen SQL harness 3.1.5 standard workload. All fixtures are synthetic; never use
an operator's state directory or logs.

## Acceptance rule (recorded before measurement)

- Attribute all statements and worker requests in `06.cron` to the issuing owner
  and call site. Record repeats within one run and subtract the warm-turn median
  by operation. Keep cold and warm results separate.
- Start with three current-main runs. Compare a candidate using three alternating
  baseline/candidate pairs on the same platform when load permits; under load,
  use one pair plus source and per-owner count evidence. Verify frozen harness
  hashes before running it.
- Report total and main-thread statements, worker requests, per-operation counts,
  median and range. The touched owner must perform fewer statements or requests;
  warm and first-turn work must not increase because of the change. Main-thread
  work must never increase.
- Wall-clock or CPU-time comparisons require the campaign timing lock and a
  one-minute load below 24. For timing claims use at least five alternating
  samples per arm and report median, p95, and spread. A 20% regression in any
  user-facing metric stops the change. Loaded-host counts and CPU profiles do not
  establish a latency improvement.
- Preserve crash recovery, claim-before-effect ordering, per-job FIFO, 64 retained
  receipts per job, and current authority checks at external effects. Preserve
  ordered state-store and agent-store commits. Do not introduce caches, schema
  changes, generations, or handshakes.

Cron metadata reads, health reads, session-entry patch fusion, and the earlier
receipt-claim read removal belong to other changes. Attribute those costs but do
not duplicate their implementation.
