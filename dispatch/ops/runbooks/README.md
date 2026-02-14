# Dispatch Operability Runbooks

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
- `blind_intake_guardrails.md`
- `mvp_06_on_call_drill.md`
- `mvp_08_pilot_cutover_readiness.md`
- `mvp_launch_checkpoint.md` (recoverable startup/smoke-test snapshot)
