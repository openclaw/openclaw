# Cold session preparation

## Acceptance rule

Measure the frozen synthetic Gateway workload through its real WebSocket transport:
first turn, ten warm turns, second session with a spawned child, and the first turn
after restart. Keep cold and warm results separate. Count successful SQL statements,
worker requests, and main-thread statements by operation and phase.

The proposed change carries an already validated entry to the history reader when
the actor owns entry facts without a complete transcript snapshot. It must remove
the repeated entry and participant reads in that case (two statements per affected
accounting read), with identical accounting and history results. Transcript payload,
identity, projection, transaction, and write-invalidation behavior must remain intact.
Cold `session.turn.prepare` has six distinct reads; no saving there is presumed.

Use three alternating baseline/candidate pairs when host load is below 64 and
internal free space is at least 12 GiB; otherwise use one pair and report the limit.
For each phase and shared read family, report statement/request/main medians and
ranges. Warm requests and main-thread SQL must not rise. No count reduction means
reject the patch. A 20% regression in any user-facing metric stops the change.

Timing claims require five interleaved samples per arm, the campaign timing lock,
and load below 24. Without those conditions, report counts only; make no latency or
CPU speed claim. The frozen observer's retired causal-context support does not
justify treating background-contaminated window counts as causal counts.

## Attribution before the experiment

The earlier synthetic census at `3f7b7765585d` reported 18 preparation statements
and 14 preparation requests across the full workload, including ten zero-SQL warm
preparations. Each cold preparation reads the retained window key, full entry,
participants, transcript version/cold state, pending input, and idempotency index.

Its `history-page` total of 27 statements and six requests includes five internal
accounting reads: four three-statement transaction/payload reads and one
eight-statement read. The remaining seven statements belong to a display-history
RPC. The second-session phase includes both the second conversation and a spawned
child; phase equality alone does not prove that two reads address the same session.

The experiment must establish whether entry-only receipt reuse explains the extra
two entry reads. If it does not, report the actual result without claiming that the
historical second-session read was redundant.
