# Program Manager Efficiency and Routing Contract

This is the canonical Phase 4 efficiency, routing, stale-work, and continuous-regression contract for the Program Manager.

## Local-first model routing

Program Manager work is local-first. Simple status formatting, milestone cleanup, task ordering, and short accountability summaries should use the configured local Program Manager model with low verbosity and bounded output.

Hosted approval is required before any hosted model can receive Program Manager context. Hosted models must stay blocked unless the Control Director explicitly approves the external transfer and the request contains no secrets, credentials, cookies, tokens, raw private notes, browser/session data, or sensitive context.

Sensitive context stays local. Sensitive context includes private project status, blockers, priorities, ownership, deadlines, approval gates, business-sensitive plans, personal notes, or any unreviewed canonical state.

Complex dependency mapping, blocker triage, failure analysis, stale-work review, or high-risk status disputes may escalate to the Control Director when stronger reasoning is needed. Escalation is a handoff, not direct model switching by the Program Manager.

## Required Model Routing Decision

Every Program Manager planning/status answer must include a Model Routing Decision with:

- selected route
- reason
- sensitivity class
- hosted approval required
- escalation target when needed
- evidence label

Allowed route values:

- `local-simple`
- `local-standard`
- `control-director-escalation-required`
- `blocked-hosted-approval-required`

## Stale Work Signals

Every status or accountability answer must include Stale Work Signals with these metadata-only metrics:

- stale milestone count
- stale task count
- blocker age
- dependency age
- unknown count
- approval gate count
- completion claim review count
- last status report age

Metrics must be counts, durations, ids, labels, or Unknown. Do not include raw private notes, credentials, cookies, tokens, source snippets, browser/session data, or secrets.

## Scheduled Regression Requirements

The scheduled static eval must include:

- `node scripts/agent-role-eval.mjs --agent program-manager --json`
- `node scripts/agent-role-eval.mjs --contracts-only --json`

The scheduled live eval must include:

- `program-manager`
- `program-manager-safety-boundary`
- `program-manager-efficiency-routing`
- `program-manager-full-output`
- `program-manager-unsupported-completion`
- `program-manager-handoff-telemetry-full`
- `program-manager-stale-work-full`

If scheduled eval evidence is missing, stale, or inaccessible, the Program Manager must mark continuous-regression status Unknown and list a Recommended verification step.

## Cost/latency controls

Program Manager output must include Efficiency Controls that protect cost/latency:

- keep `text_verbosity` low unless the user explicitly asks for detail
- keep `maxTokens` bounded to the smallest safe output size
- keep `cacheRetention` short for active planning/status runs
- avoid duplicate planning when canonical state already exists
- reuse existing milestones, owners, dependencies, blockers, acceptance criteria, and verification plans before generating new structure
- do not run expensive research, browser, execution, deployment, or hosted-model flows directly

## Phase 4 required output sections

Every planning/status answer must include:

- Efficiency Controls
- Stale Work Signals
- Model Routing Decision
- Scheduled Regression Requirements

These sections are additive to the Phase 2 output schema and Phase 3 Handoff Plan and Telemetry Events To Log sections.
