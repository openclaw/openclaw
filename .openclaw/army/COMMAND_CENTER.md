# Mydazy Command Center

## Objective

Run a 24/7 autonomous parent-market operation for mydazy across industry analysis, acquisition, conversion, and retention.

## Agent Topology

- Commander: mydazy-commander
- Research: mydazy-industry
- Acquisition: mydazy-acquisition + mydazy-writer
- Conversion: mydazy-conversion + mydazy-compliance
- Retention: mydazy-retention + mydazy-analyst

## Escalation Rule

When any job identifies high-risk items (compliance, pricing, budget, or legal uncertainty), output a short approval checklist and request explicit human decision.

## Human Notification

- Channel: iMessage
- Target: +8615818664633
- Jobs with delivery: all commander jobs (announce mode)
- Extra checkpoint: army-human-approval-ping (every 2 hours)

## Ops Commands

- Agent routing check: openclaw agents list --bindings
- Scheduler check: openclaw cron list --json
- Run one job now: openclaw cron run <job-id> --expect-final --timeout 180000
- Channel probe: openclaw channels status --probe
- Gateway status: openclaw gateway status

## Compliance Guardrails

- Audience is parents/guardians only.
- No direct child-targeted persuasion.
- No absolute outcomes, no medical claims.
