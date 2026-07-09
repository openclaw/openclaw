# Program Manager Handoff and Telemetry Contract

This is the canonical Phase 3 handoff and telemetry contract for the Program Manager.

## Required handoff targets

Every Program Manager plan or status answer must include a `Handoff Plan` when another agent owns a decision, execution surface, review, memory update, browser/session boundary, or metric/evaluation surface.

Required targets:

- Control Director
- Strategic Director
- Judge
- Automation & Playbook Architect
- Memory & Knowledge Curator
- Browser / Session / Credential Steward
- Telemetry & Evaluation Analyst

## Required handoff fields

Every handoff packet must include:

- target agent
- trigger condition
- input sent
- output expected
- owner
- approval requirement
- failure mode
- fix for failure mode

## Routing rules

- Program Manager must produce handoff packets only; it must not use session-message execution, browser/session mutation, shell execution, file mutation, or credential tools to perform downstream work.
- Configured delegation targets must keep high-risk execution or mutation tools approval-gated; Program Manager static checks must fail when a target exposes high-risk tools without deny/always approval posture.
- Completion claims route to Judge for review.
- Strategic priority conflicts route to Control Director or Strategic Director.
- Automation and playbook work routes to Automation & Playbook Architect.
- Memory promotion routes to Memory & Knowledge Curator.
- Browser, session, cookie, token, credential, SSH, wallet, and login work routes to Browser / Session / Credential Steward.
- Metrics, evaluation, dashboards, regressions, and quality signals route to Telemetry & Evaluation Analyst.

## Telemetry Events To Log

Program Manager outputs must list non-secret `Telemetry Events To Log` when relevant:

- `program_manager.plan.created`
- `program_manager.status.reported`
- `program_manager.milestone.updated`
- `program_manager.task.updated`
- `program_manager.blocker.raised`
- `program_manager.dependency.added`
- `program_manager.handoff.requested`
- `program_manager.approval_gate.added`
- `program_manager.verification.required`
- `program_manager.completion_claim.review_required`
- `program_manager.unknown.recorded`

## Telemetry privacy

Telemetry must be metadata-only and non-secret.

Allowed metadata fields:

- event name
- timestamp
- agent id
- milestone id
- task id
- status
- owner role
- handoff target
- risk level
- approval required
- evidence label

Forbidden telemetry fields:

- no credentials
- no cookies
- no tokens
- no raw private notes
- no browser/session data
- no secrets

## Runtime emission status

Runtime emission status: implemented through the agent event bus using `emitProgramManagerTelemetryEvent` on the `program_manager_telemetry` stream. Program Manager telemetry remains metadata-only and non-secret; validation fixtures and regression tests must continue proving that secret-like payload fields are rejected. The Program Manager may list `Telemetry Events To Log`, but it must not claim a specific event was emitted unless the runtime path emitted it or telemetry evidence is available.

## Secret-free example

```json
{
  "handoffPlan": [
    {
      "target": "Judge",
      "targetAgent": "judge",
      "triggerCondition": "Completion claim needs independent review",
      "inputSent": "Milestone id M1, evidence label Unknown, verification plan pending",
      "outputExpected": "Approve, reject, or request more verification",
      "owner": "Program Manager",
      "approvalRequirement": "Judge review required",
      "failureMode": "Judge evidence is missing",
      "fixForFailureMode": "Keep status Not complete and request exact verification proof"
    }
  ],
  "telemetryEventsToLog": [
    {
      "eventName": "program_manager.completion_claim.review_required",
      "agentId": "program-manager",
      "milestoneId": "M1",
      "status": "Not complete",
      "handoffTarget": "Judge",
      "approvalRequired": true,
      "evidenceLabel": "Unknown"
    }
  ]
}
```
