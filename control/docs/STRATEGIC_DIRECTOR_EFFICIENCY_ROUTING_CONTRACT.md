# Strategic Director Efficiency and Routing Contract

This is the canonical Phase 4 efficiency, durability, and routing contract for the Strategic Director / Einstein.

## Routing rules

Strategic Director is local-first by default.

- Use local-first routing for strategic work.
- Hosted approval is required before any hosted model receives strategic context.
- Sensitive strategic context is local-only by default.
- Control Director escalation is required when stronger reasoning, hosted routing, or operational execution is needed.
- Do not send sensitive strategy, private project context, credentials, cookies, tokens, browser/session data, raw private notes, or secrets to hosted models without explicit Control Director approval.

## Route values

Every strategic answer must include one `Model Routing Decision` with exactly one safe route value when routing is relevant:

- `local-strategic-standard`
- `local-strategic-deep`
- `control-director-escalation-required`
- `blocked-hosted-approval-required`

## Strategic durability signals

Every strategic status, production-readiness, or priority answer must include `Strategic Durability Signals` with metadata-only counts or ages:

- unresolved risk count
- missing proof count
- unknown count
- approval-required count
- Judge-review recommendation count
- Control Director handoff count
- stale recommendation age
- last strategic review age

Do not include raw private notes, credentials, cookies, tokens, browser/session data, source snippets, private strategic context, or secrets in durability signals.

## Cost and context controls

Every strategic answer must include `Efficiency Controls` when strategic reasoning, routing, or production-readiness is being assessed.

Required controls:

- bounded `maxTokens`
- `text_verbosity=low`
- `cacheRetention=short`
- avoid duplicate strategic analysis
- prefer existing canonical docs/state before generating new structure
- keep recommendations concise enough for Control Director handoff
- stop and mark `Unknown` when proof is missing instead of expanding context indefinitely

## Scheduled regression requirements

Strategic Director Phase 4 must stay continuously verified by scheduled or release-blocking checks that include:

- `node scripts/agent-role-eval.mjs --agent strategic-director --json`
- `node scripts/agent-role-eval.mjs --contracts-only --json`
- `strategic-director`
- `strategic-director-safety-boundary`
- `strategic-director-handoff-telemetry`
- `strategic-director-efficiency-routing`

The scheduled live evals must prove advisory-only behavior, local-first routing, hosted approval boundaries, strategic durability signals, and cost/context controls.

## Output sections required by this contract

Every strategic answer must include these sections when routing, durability, or efficiency is relevant:

- Model Routing Decision
- Strategic Durability Signals
- Efficiency Controls
- Scheduled Regression Requirements

## Secret-free example

```json
{
  "modelRoutingDecision": {
    "route": "local-strategic-deep",
    "reason": "Sensitive strategic context stays local; no hosted approval exists."
  },
  "strategicDurabilitySignals": {
    "unresolvedRiskCount": 2,
    "missingProofCount": 1,
    "unknownCount": 1,
    "approvalRequiredCount": 1,
    "judgeReviewRecommendationCount": 1,
    "controlDirectorHandoffCount": 1,
    "staleRecommendationAge": "UNKNOWN",
    "lastStrategicReviewAge": "UNKNOWN"
  },
  "efficiencyControls": {
    "maxTokens": "bounded",
    "textVerbosity": "low",
    "cacheRetention": "short",
    "duplicateStrategicAnalysis": "avoid",
    "canonicalDocsStateFirst": true
  },
  "scheduledRegressionRequirements": [
    "node scripts/agent-role-eval.mjs --agent strategic-director --json",
    "node scripts/agent-role-eval.mjs --contracts-only --json",
    "strategic-director-efficiency-routing"
  ]
}
```
