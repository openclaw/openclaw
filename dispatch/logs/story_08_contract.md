# STORY-08 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-13 PST
Story: `STORY-08: Canonical E2E scenario harness`

## Goal

Deliver a deterministic node-native E2E test that validates the emergency scenario chain, including fail-closed rejection when required evidence is missing and success after evidence completion.

## Harness Scope

Test file:

- `dispatch/tests/story_08_e2e_canonical.node.test.mjs`

Execution model:

- fresh Postgres container
- apply `dispatch/db/migrations/001_init.sql`
- start `dispatch-api`
- execute scenario through dispatch tool bridge (`invokeDispatchAction`)

## Canonical Scenario (Current Implemented Slice)

1. `ticket.create` -> `NEW`
2. `ticket.triage` (`EMERGENCY`, incident template type) -> `TRIAGED`
3. `assignment.dispatch` with `EMERGENCY_BYPASS` -> `DISPATCHED`
4. `tech.check_in` progresses onsite state to `IN_PROGRESS`
5. `tech.complete` attempted with missing evidence -> fail-closed `409`
6. `closeout.add_evidence` uploads required evidence refs (with one idempotent replay)
7. `tech.complete` succeeds -> `COMPLETED_PENDING_VERIFICATION`
8. `qa.verify` succeeds -> `VERIFIED`
9. `billing.generate_invoice` succeeds -> `INVOICED`
10. `ticket.get` and `ticket.timeline` verify final state and ordered complete audit chain

## Deterministic Assertions

- Missing evidence branch returns bridge error wrapping `CLOSEOUT_REQUIREMENTS_INCOMPLETE`.
- Idempotent replay of one evidence request does not duplicate evidence row.
- Successful check-in writes derived transitions (`DISPATCHED -> ON_SITE`, `ON_SITE -> IN_PROGRESS`).
- Successful completion writes expected transition (`IN_PROGRESS -> COMPLETED_PENDING_VERIFICATION`).
- Verification and invoicing transitions are present (`COMPLETED_PENDING_VERIFICATION -> VERIFIED -> INVOICED`).
- Timeline ordering: `created_at ASC`, tie-breaker `id ASC`.
- Timeline correlation chain remains consistent for scenario events.
- Timeline count equals successful unique command mutations.

## Acceptance Coverage

- Canonical emergency chain executes end-to-end in node-native harness without DB state shims.
- Explicit fail-closed policy violation is asserted.
- Idempotency and audit completeness are asserted in the same E2E run.
