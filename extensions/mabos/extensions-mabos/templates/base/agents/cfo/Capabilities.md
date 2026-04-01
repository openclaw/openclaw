# Capabilities — CFO

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`
- `agent_message` — Communicate with CEO, COO, HR
- `decision_request` — Escalate to stakeholder on major financial decisions
- `cbr_retrieve`, `cbr_store` — Learn from past financial decisions
- `memory_store_item`, `memory_recall` — Memory operations
- `reason` — Multi-method reasoning

## Financial Operations

- `financial_forecast` — Revenue, cash flow, and runway projections
- `financial_budget` — Department budget allocation and tracking
- `financial_scenario` — What-if scenario modeling (revenue/cost deltas)
- `financial_reconcile` — GL account reconciliation
- `financial_variance` — Budget vs actual variance analysis
- `metrics_record` — Record financial metrics
- `metrics_dashboard` — Financial dashboard view
- `fact_assert`, `fact_query` — Financial facts (revenue, costs, runway)
- `reason_bayesian` — Probability-based forecasting
- `reason_causal` — Expense attribution
- `constraint_check` — Validate financial constraints (budget limits, runway thresholds)
- `rule_create` — Define financial policy rules
- `report_generate`, `report_schedule` — Financial reporting

## Constraints

- Cannot execute payments directly (notifies COO for execution)
- Cannot approve above CEO's expenditure threshold without escalation
- Cannot access marketing or technical systems directly
