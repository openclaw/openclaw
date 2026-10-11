# Update writer contention

Related: #169260

Status: draft plan only. No runtime behavior has changed. Replace this planning file with the reviewed implementation before marking the PR ready.

## Observed problem

During native beta-update validation, an update.run IMMEDIATE transaction held the shared writer for 14,265 ms while cron.run-reservation exhausted a 5,004 ms lock wait and failed its timer tick. Secret-store cleanup also deferred. The update eventually succeeded; no permanently missed job or lost data is established.

## Implementation plan

1. Trace update-step recording, the SQLite worker broker, and live host authority admission/settlement. Establish which phase consumed the observed hold. Existing logs establish overlap, not the internal cause.
2. Reproduce through the supported update flow with isolated operator state and a concurrent cron consumer. Retain the original ordering. Separate filesystem slowness, authority waits, transaction work, and fixture failures.
3. Move asynchronous planning outside the transaction at the existing producing owner, or correct the identified admission/settlement lifecycle. Reread authoritative rows immediately before writing. Preserve FIFO ordering, current authority checks, and settlement of write-capable work.
4. Extend existing broker/update/cron coverage only where it protects the demonstrated failure. Use controlled gates rather than sleeps or weaker timeouts. Confirm that a concurrent reservation completes without exceeding its existing admission budget.
5. Validate with the published installed updater and the candidate. Run focused owner checks and required worker/package builds; obtain fresh review and record measured test cost. No schema, durability, retention, permission, or timeout changes are proposed by this plan.

## Acceptance

- A reproduced long writer hold is removed at its owner with evidence of the actual cause.
- Concurrent cron and cleanup consumers retain their existing successful behavior and ordering.
- Authority, transaction integrity, cancellation, and settlement remain enforced.
- The PR does not claim that a passing replay alone fixes the observed failure.

