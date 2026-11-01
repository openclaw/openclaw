# Sessions-board placement precondition

Acceptance rule, written before baseline execution:

- Flow: an authenticated loopback WebSocket client creates a synthetic session and
  Sessions board, then moves the session between `working` and `done` through
  `workboard.sessionsBoard.move` on an isolated source Gateway.
- Workload: `workboard-read-measure.ts --placements --prepare --root <fresh-root>
  --output <report> --waves 10 --clients 1`; one cold insertion followed by ten
  warm updates. No inference or external service is used.
- Count successful SQL statements and worker requests with the frozen campaign
  observer v3.1.4. Keep cold, each warm action, and shutdown separate. Count MAIN
  and total work. The target is one fewer placement point SELECT per move,
  unchanged requests and MAIN, with each requested column visible in the reply.
- Verify insert, existing-row update, expected absence on an existing row,
  missing row with an expected revision, stale revision, and stale board spec
  through the existing storage owner tests. Preserve per-effect authority checks.
- Counts are deterministic evidence. Do not infer latency improvement on a busy
  host. Timing comparisons require the campaign timing lock, load below 24,
  at least five interleaved baseline/candidate samples, median/p95/range, and no
  user-facing regression. A 20% regression stops the change.

Run the workload with the campaign proof semaphore. Set `SQLMEASURE_OUT` to an
internal-disk directory containing a `phase` file initially set to `placement.setup`;
preload the frozen `observer.cjs` with `NODE_OPTIONS`. Its sibling `causality.cjs`
and `background-roots.json` remain unchanged. The workload advances the phase
before each move. Source and runtime must match the recorded Git head.

The existing board/spec/column checks and placement-list reader remain. The
candidate replaces only the redundant point read inside the serialized write
with its expected-revision predicate and consumes the affected-row count. There
is no schema, retained-state, public API, or transaction-boundary change.
