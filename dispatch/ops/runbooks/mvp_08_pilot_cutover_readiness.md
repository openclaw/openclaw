# MVP-08: Pilot UAT and Cutover Readiness

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

## Purpose

Define the production cutover readiness gate for the v0 dispatch release. This runbook is intended for pilot start/stop windows and verifies that dispatcher/technician lifecycle paths are stable across top incident templates.

## Pilot UAT Matrix (Dispatcher + Technician)

This document confirms the dispatcher/technician lifecycle across top incident templates.

Run as part of the release freeze window and include at least one incident of each template listed below:

- `DOOR_WONT_LATCH`
- `CLOSER_LEAKING_OR_SLAMMING`
- `AUTO_OPERATOR_FAULT`
- `CANNOT_SECURE_ENTRY`
- `HARDWARE_REPLACEMENT`
- `FRAME_OR_GLASS_DAMAGE`

### Primary UAT commands

1. Start a fresh Postgres + dispatch-api stack in test topology.
2. Seed required pilot account/site/contact fixtures.
3. Execute `node --test --test-concurrency=1 dispatch/tests/mvp_08_pilot_readiness.node.test.mjs`.
4. Confirm at least one successful full life-cycle per incident template through:
   - create
   - triage
   - dispatch
   - technician check-in
   - closeout evidence + completion gate
   - dispatch verification
   - invoice generation

### Readiness checks

For each incident template above, UAT must confirm:

- Dispatcher cockpit returns ticket rows and selected-ticket details from API truth.
- Technician packet shows correct template-specific required evidence/checklist requirements.
- Missing closeout evidence fails `409 CLOSEOUT_REQUIREMENTS_INCOMPLETE` with policy dimension `evidence`.
- Completion succeeds only when all template requirements are satisfied.
- `ticket.timeline` contains audit trail for each lifecycle step.

## Go/No-Go Gates

- [ ] `dispatch/tests/mvp_08_pilot_readiness.node.test.mjs` passes with no skips.
- [ ] At least one template executes the alternate no-signature path.
- [ ] All incident templates in the matrix execute with deterministic assertions.
- [ ] Dispatcher cockpit + technician packet endpoints are available and enforce policy-aligned constraints.
- [ ] No blocker regression introduced in `node --test --test-concurrency=1 dispatch/tests/*.mjs`.

## Rollback Rehearsal

### Trigger

Pilot cannot progress if any gate fails twice in the same runbook window.

### Steps

1. Freeze new request intake.
2. Record last known good commit and release candidate identifier.
3. Repoint API consumers back to previous stable image/branch.
4. Re-run `node --test --test-concurrency=1 dispatch/tests/story_10_ux_spec.node.test.mjs` against rollback target.
5. Keep audit logs and request timeline snapshots for incident review.
6. Resume rollout only after the rollback path is validated.

## Release Candidate Freeze Controls

- Do not merge or hotfix outside the freeze branch while gates are active.
- Keep source-of-truth contract docs and runbooks updated before RC tag.
- Confirm `dispatch/ops/runbooks/README.md` includes this cutover document.
- Preserve a signed rollout log with:
  - test pass/fail timestamps,
  - rollback rehearsal outcome,
  - final go/no-go decision with owner initials.
