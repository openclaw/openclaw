# Phase 04 Plan 02 Acceptance Matrix

Date: 2026-03-08  
Owner: FrankOS governance rollout track  
Status: ready for execution

## Evidence Template (use per scenario)
1. Scenario ID
2. Preconditions
3. Command(s)/trigger
4. Expected governance decision
5. Expected telemetry (`diagnostics` and OTEL mapping)
6. Observed output/evidence
7. Result (`pass|fail|blocked`)
8. Notes/next action

## Scenario Set

| ID | Area | Mode | Intent | Expected decision | Result |
| --- | --- | --- | --- | --- | --- |
| P04-S01 | Tool governance | off | Baseline mutating tool call | permit | pass (live harness: off-mode permit test) |
| P04-S02 | Tool governance | shadow | Mutating tool call with policy match | prohibit observed, execution allowed | pass (unit: governance shadow test) |
| P04-S03 | Tool governance | enforce | Mutating tool call with policy match | prohibit enforced (fail-closed) | pass (unit: governance enforce + fail-closed tests) |
| P04-S04 | Tool governance | enforce | Ambiguous tool request | escalate or prohibit with reason code | pass (unit: escalation-required action test) |
| P04-S05 | Tool governance | shadow/enforce | Same input across modes | deterministic reason codes by mode | pass (unit: stable reason prefix tests) |
| P04-S06 | Memory governance | shadow | low confidence/inferred write | correction/prohibit observed, write behavior per mode | pass (unit: shadow provenance/inference tests) |
| P04-S07 | Memory governance | enforce | invalid provenance write | prohibit enforced | pass (unit: enforce provenance/inference tests) |
| P04-S08 | Memory governance | enforce | supersession correction flow | correction + supersession event emitted | pass (unit: supersession event test) |
| P04-S09 | Telemetry | all | decision event shape | required fields present (`mode`, `decision`, `reasonCode`) | pass (unit: governance + memory telemetry tests) |
| P04-S10 | Telemetry/OTEL | all | exporter mapping | counters/histograms/spans emitted as expected | pass (unit: diagnostics-otel service test) |
| P04-S11 | Rollback | enforce->shadow | rollback readiness | enforcement relaxes without stale blocks | pass (live harness: transition test) |
| P04-S12 | Rollback | shadow->off | rollback completion | governance passive baseline restored | pass (live harness: transition test) |

## Required Fields Validation
For each executed scenario, verify:
1. `governance.decision` includes `runId`, `sessionId|sessionKey`, `mode`, `decision`, `reasonCode`.
2. Memory events include expected type when applicable:
   - `memory.governance.decision`
   - `memory.provenance.validation_failure`
   - `memory.correction.supersession`
3. OTEL exporter includes matching metric/span dimensions for mode, decision, reason code.

## Gate Thresholds
1. Blocking failures: any enforce-mode scenario where prohibit/escalate is not enforced as designed.
2. Blocking failures: missing required telemetry fields in any scenario.
3. Conditional approval: non-blocking shadow-mode divergence allowed only with documented mitigation and owner.

## Rollout Decision Record (to complete after execution)
1. Total scenarios: 12
2. Passed:
3. Failed:
4. Blocked:
5. Rollback readiness: yes/no
6. Promotion recommendation: canary only / production / hold
