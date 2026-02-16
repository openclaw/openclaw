# Dispatch Operability Runbooks

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

These runbooks include MVP-06 operational alert response and MVP-08 pilot cutover readiness for the v0 dispatch release.

Alert sources:

- `GET /metrics`
- `GET /ops/alerts`
- durable sink files:
  - `DISPATCH_LOG_SINK_PATH`
  - `DISPATCH_METRICS_SINK_PATH`
  - `DISPATCH_ALERTS_SINK_PATH`

Runbook index:

- `stuck_scheduling.md`
- `completion_rejection.md`
- `idempotency_conflict.md`
- `auth_policy_failure.md`
- `glz_12_autonomy_rollout_controls.md`
- `blind_intake_guardrails.md`
- `mvp_06_on_call_drill.md`
- `mvp_08_pilot_cutover_readiness.md`
- `mvp_launch_checkpoint.md` (recoverable startup/smoke-test snapshot)
- `sprint_g2_scheduling_and_commitment.md`
- `v0_launch_gate_evidence_packet.md` (pilot gate closure proof for V0 launch)
