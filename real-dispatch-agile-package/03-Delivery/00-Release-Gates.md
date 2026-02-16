# Release gates (v0 → v1 → v2)

## v0 “Shadow Autonomy”

Allowed:

- proposals only
- humans approve to execute

Gate checklist:

- 100% commands have requestId + correlationId
- policy engine provides deterministic decisions with reason codes
- evidence gating enforced on closeout
- replay can reconstruct ticket decisions from: command log + policy hash + evidence + workflow history
- global and scoped kill switch works

## v1 “Assisted Autonomy”

Allowed:

- auto-execute low-risk reversible actions
- approvals required for high-risk actions

Additional gate checklist:

- rollback rate for low-risk actions below threshold
- comms evidence capture complete
- escalation timers behave correctly
- pricing/estimating deterministic (if enabled)

## v2 “Scoped Autonomy”

Allowed:

- auto-dispatch + schedule commit only in whitelisted scopes
- auto-closeout only if evidence gates pass

Additional gate checklist:

- safety brakes proven (pause/resume, incident-level disable)
- disputes resolvable from evidence + audit
- policy drift monitored (bundle hash stamped everywhere)
