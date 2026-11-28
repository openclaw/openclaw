# Common work lifecycle decision record

Status: accepted for this candidate

## Context

Agent work previously exposed several facts as if they were one state: the logical goal, an
execution attempt, an internal callback, delivery to a user route, and archival. Retries and route
changes can make those facts diverge. Treating one successful step as completion causes duplicate
workers, reports to superseded threads, or lost responsibility.

## Decision

Workboard remains the single persistence owner. The registered
`workboard.commonWork.transition` operation stores the optional `CommonWorkRecord` in the
`workboard_cards.common_work_json` column through the existing database worker and ordered writer.
No new database, scheduler, message bus, or competing state writer is introduced.

The contract separates six concerns:

| Module            | Owned facts                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| M1 responsibility | logical work identity, admitted objective/scope/acceptance, reporting lead, outcome |
| M2 conversation   | source session, callback endpoint, canonical user route and route opener            |
| M3 execution      | execution identity, generation, terminal receipt, three-slot lane assignment        |
| M4 evidence       | callback, delivery, close, archive, artifact and resource evidence                  |
| M5 policy         | TO-only cross-owner correction and managed-publisher drift/rollback checks          |
| M6 recovery       | checkpoints, watcher generation, late-result fencing, outage reconciliation         |

Every mutating transition consumes an expected identity, generation, revision, receipt, or
idempotency key. Admission fixes the objective and its digest, scope, acceptance criteria, and one
reporting lead; only a receipt-backed user correction may revise those facts. A discovered A-prime
is recorded as a prerequisite blocker, separate follow-up, or irrelevant item. It cannot replace the
admitted objective or open an execution, route, worker, or resources until an explicit approval receipt is
persisted. A replay with the same facts is a no-op; a replay with different facts is a conflict.
Delivery is complete only when its receipt matches the latest route version. Archive status is
independent from outcome and delivery responsibility.

The scheduler starts with three slots. It guarantees an assignment opportunity to common and
specialist work when both are queued, while allowing either side to borrow otherwise-idle capacity.
It never interrupts active work to create that opportunity.

## Acceptance trace

The focused suites packages/workboard-contract/src/common-work.test.ts and
packages/workboard-contract/src/common-work-objective.test.ts map the preserved requirements to
T01-T31. The runtime dispatcher boundary has an additional focused adapter suite.

- R01-R04: T01-T04 cover goal corrections, deduplicated accounting identity, fresh worker identity,
  and route-family titles.
- R05-R08: T05-T08 cover one opener, exactly-once callback, one active worker, and separation of
  source/callback/user route.
- R09-R12: T09-T12 cover TO authority, terminal/delivery/archive separation, generation fencing,
  and watcher checkpoints.
- R13-R16: T13-T16 cover managed publication, resource release, mutation safety, and lane fairness.
- R17-R20: T17-T20 cover decision promotion, file evidence, one build identity, and canonical route
  delivery.
- Recovery additions: T21-T24 cover bounded ledger outage behavior, reconciliation, protected
  archive refusal, and drain without callback or route loss.
- Objective continuity: T25-T28 cover fixed admission facts, user-only correction, classified
  A-prime handling, and approval-gated resource allocation.
- Role-aware reporting: T29-T31 cover one admitted reporting lead, normal directly-requested
  specialist reporting, helper/specialist single-return behavior, and terminal review outputs.

## Consequences

- The contract is deterministic and can be tested without mutating an operating store.
- SQLite schema version 5 and the PostgreSQL schema add `common_work_json`; reads and writes stay in
  the existing Workboard database owner. The runtime adapter performs an authoritative ordered
  read-back and only marks terminal relay complete when callback and canonical delivery receipts
  are both persisted.
- The Gateway transition parser is strict: admission requires objective digest, scope, acceptance
  criteria, and reporting lead, and every objective/discovery/helper operation is parsed before the
  shared adapter dispatches it.
- Channel transports and specialist plugins retain their existing authority; they provide receipts
  to the contract rather than becoming common-work state owners.
- Managed publication remains restricted to declared markers and exact hash read-back.
- Live installation and registered-agent/channel canaries are separate operational gates. Unit
  evidence cannot substitute for those gates.

## Rollback

Disable the registered transition operation and restore the prior artifact hash. The nullable
`common_work_json` column can remain during rollback; older readers ignore it, avoiding destructive
schema reversal. Verify the installed build identity before claiming rollback.
