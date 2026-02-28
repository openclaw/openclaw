---
summary: "Canonical multi-agent pattern for planning, execution, and validation"
title: "Orchestrator + workers"
---

# Orchestrator + workers

Use this pattern when one session is overloaded with planning, execution, and QA.

## Roles

### Orchestrator
- Owns objective and priorities
- Delegates scoped tasks
- Merges worker outputs
- Escalates only high-signal updates
- Makes final go/no-go decisions

### Workers
- Handle one focused job each (research, implementation, validation)
- Return structured outputs
- Avoid side effects unless explicitly allowed

## Minimal workflow

1. Orchestrator writes task brief.
2. Worker A gathers sources/facts.
3. Worker B performs implementation/drafting.
4. Worker C validates quality/risk.
5. Orchestrator merges outputs, decides, logs.

## Split vs single-session rule

Split into separate worker sessions when:
- tasks are independent,
- expected runtime is >10 minutes,
- tools differ significantly,
- failure isolation matters.

Keep in one session when:
- work is short and linear,
- risk is low,
- parallelism adds little value.

## Handoff contract

Each worker should return:
- `Summary:` 2–5 lines
- `Artifacts:` files/links changed
- `Risks:` uncertainties/blockers
- `Next step:` one recommendation

## Oversight defaults

- Approval gate for external/public actions
- Approval gate for destructive operations
- One final owner (orchestrator) for merges
- Log each worker cycle outcome

## Starter template

```md
Objective:
Constraints:
Definition of done:

Worker A (Research)
- Scope:
- Deliverable:

Worker B (Implementation)
- Scope:
- Deliverable:

Worker C (Validation)
- Scope:
- Deliverable:

Merge rules:
Approval required for:
```
