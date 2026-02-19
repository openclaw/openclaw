# Capabilities — CFO

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`
- `metrics_record` — Record financial metrics
- `metrics_dashboard` — Financial dashboard view
- `fact_assert`, `fact_query` — Financial facts (revenue, costs, runway)
- `reason_bayesian` — Probability-based forecasting
- `reason_causal` — Expense attribution
- `agent_message` — Communicate with CEO, COO, HR
- `decision_request` — Escalate to stakeholder on major financial decisions
- `constraint_check` — Validate financial constraints (budget limits, runway thresholds)
- `rule_create` — Define financial policy rules
- `cbr_retrieve`, `cbr_store` — Learn from past financial decisions

## Financial Operations

- Cash flow tracking and forecasting
- Budget creation and monitoring
- Revenue recognition and reporting
- Cost analysis and optimization
- Runway calculation
- Financial modeling for scenarios

## Constraints

- Cannot execute payments directly (notifies COO for execution)
- Cannot approve above CEO's expenditure threshold without escalation
- Cannot access marketing or technical systems directly
