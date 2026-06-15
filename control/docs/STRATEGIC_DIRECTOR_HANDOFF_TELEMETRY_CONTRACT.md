# Strategic Director Handoff and Telemetry Contract

This is the canonical Phase 3 handoff and telemetry contract for the Strategic Director / Einstein.

## Required handoff targets

Every Strategic Director recommendation must include a `Handoff Plan` when another role owns execution, tracking, review, memory, browser/session/credential boundaries, automation design, or metrics.

Required targets:

- Control Director
- Program Manager
- Judge
- Automation & Playbook Architect
- Memory & Knowledge Curator
- Browser / Session / Credential Steward
- Telemetry & Evaluation Analyst

## Required handoff fields

Every handoff packet must include:

- trigger condition
- input sent
- output expected
- owner
- approval requirement
- failure mode
- fix for failure mode

## Routing rules

- Strategic recommendations route execution to Control Director.
- Completion claims, proof claims, and final-quality decisions route to Judge.
- Milestone, task, dependency, blocker, and tracking translation routes to Program Manager.
- Automation or playbook design routes to Automation & Playbook Architect.
- Memory promotion, durable lessons, and reusable knowledge routes to Memory & Knowledge Curator.
- Browser, session, cookie, token, credential, SSH, wallet, login, and profile-boundary work routes to Browser / Session / Credential Steward.
- Metrics, evaluation, dashboards, regressions, and quality signals route to Telemetry & Evaluation Analyst.

## Telemetry Events To Log

Strategic Director outputs must list non-secret `Telemetry Events To Log` when relevant:

- `strategic_director.recommendation.created`
- `strategic_director.option.compared`
- `strategic_director.tradeoff.recorded`
- `strategic_director.risk.raised`
- `strategic_director.missing_proof.recorded`
- `strategic_director.approval_required`
- `strategic_director.control_handoff.requested`
- `strategic_director.judge_review.recommended`
- `strategic_director.unknown.recorded`

## Telemetry privacy

Telemetry must be metadata-only and non-secret.

Allowed metadata fields:

- event name
- timestamp
- agent id
- decision id
- option id
- risk level
- approval required
- evidence label
- handoff target
- owner role
- status

Forbidden telemetry fields:

- no credentials
- no cookies
- no tokens
- no raw private notes
- no secrets
- no browser/session data
- no unredacted strategic private context

## Secret-free example

```json
{
  "handoffPlan": [
    {
      "target": "Control Director",
      "triggerCondition": "Strategic recommendation requires execution",
      "inputSent": "Decision id SD-1, recommendation label Recommended verification step, risk level medium",
      "outputExpected": "Approve an execution path, delegate implementation, or block pending proof",
      "owner": "Strategic Director",
      "approvalRequirement": "Control Director approval required before execution",
      "failureMode": "Recommendation is treated as direct approval",
      "fixForFailureMode": "Stop execution and route to Control Director"
    }
  ],
  "telemetryEventsToLog": [
    {
      "eventName": "strategic_director.control_handoff.requested",
      "agentId": "strategic-director",
      "decisionId": "SD-1",
      "handoffTarget": "Control Director",
      "approvalRequired": true,
      "evidenceLabel": "Recommended verification step"
    }
  ]
}
```
