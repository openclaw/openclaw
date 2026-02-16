# V0 Launch Gate Evidence Packet

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

## Scope

- Story: `V0-LAUNCH-GATE`
- Canonical dependency chain satisfied: `V0-WORKER-LAUNCH -> GLZ-01 -> GLZ-02 -> GLZ-03 -> V0-E2E-LOCK -> GLZ-04 -> GLZ-05 -> GLZ-06 -> GLZ-07 -> GLZ-08 -> GLZ-09 -> GLZ-10 -> GLZ-11 -> GLZ-12`
- Objective: production pilot readiness for internal rollout with operational controls validated.

## Go/No-Go Summary

- `GLZ-10`, `GLZ-11`, and `GLZ-12` are implemented and have published artifact/runbook surfaces.
- Operator override and rollback drills for autonomy are present and include immutable replay references.
- Dispatcher/technician lifecycle and closeout evidence gates are covered by pilot UAT tooling.
- No open P0 blocker remains in canonical chain for `V0-LAUNCH-GATE` completion.

## Evidence Bundle Checklist

### Required evidence files

- `dispatch/tests/mvp_08_pilot_readiness.node.test.mjs`
- `dispatch/tests/story_glz_12_autonomy_rollout_controls.node.test.mjs`
- `dispatch/tests/story_10_ux_spec.node.test.mjs`
- `dispatch/tests/mvp_06_operability.node.test.mjs`
- `dispatch/ops/runbooks/glz_12_autonomy_rollout_controls.md`
- `dispatch/ops/runbooks/mvp_08_pilot_cutover_readiness.md`
- `dispatch/api/README.md`

### Required command traces

- `node --test --test-concurrency=1 dispatch/tests/mvp_08_pilot_readiness.node.test.mjs`
- `node --test --test-concurrency=1 dispatch/tests/story_glz_12_autonomy_rollout_controls.node.test.mjs`
- `node --test --test-concurrency=1 dispatch/tests/story_10_ux_spec.node.test.mjs`
- `node --test --test-concurrency=1 dispatch/tests/mvp_06_operability.node.test.mjs`

### Required transition controls

- `GET /ops/autonomy/state` and `GET /ops/autonomy/replay/{ticketId}` return scoped control decision and immutable history.
- `/tickets/{ticketId}/closeout/candidate`/`/tickets/{ticketId}/tech/complete` respect `AUTONOMY_DISABLED` when rollout is paused.
- `/ux/dispatcher/cockpit` reflects final `INVOICED` records with open packet actionability.
- `ticket.timeline` retains immutable entries for state transitions and control commands.

### Pilot freeze controls

- `dispatch/ops/runbooks/mvp_08_pilot_cutover_readiness.md` go/no-go gates complete.
- Rollback rehearsal path is available in the same artifact.
- Evidence and audit artifacts are captured during pilot gates and escalation/override events.

## Signoff

- Product Architect: `v0-launch-gate` packet required.
- PM/SRE/QA: packet capture + roll-forward authority confirmation required before internal pilot start.
