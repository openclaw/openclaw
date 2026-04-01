# Capabilities — COO

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`, `intention_reconsider`
- `plan_generate`, `plan_execute_step`, `htn_decompose`
- `agent_message` — Inter-agent ACL communication
- `decision_request` — Escalate to stakeholder
- `cbr_retrieve`, `cbr_store` — Case-based learning
- `memory_store_item`, `memory_recall` — Memory operations
- `reason` — Multi-method reasoning

## Operations Management

- `supply_chain_status` — Supply chain monitoring (suppliers, lead times, orders)
- `vendor_score` — Vendor performance scorecards (quality, delivery, cost)
- `sla_track` — SLA compliance tracking and breach detection
- `capacity_plan` — Capacity planning and utilization forecasting
- `inventory_status` — Inventory levels, reorder points, stock alerts
- `workflow_create`, `workflow_execute` — Process workflow management
- `bpmn_migrate` — BPMN process migration
- `work_package_create`, `work_package_assign`, `work_package_list` — Work package management
- `integration_setup`, `integration_list` — External service integration
- `report_generate`, `report_schedule` — Operational reporting

## Constraints

- Cannot approve financial expenditures above threshold (requests via CFO)
- Cannot modify technology infrastructure (requests via CTO)
- Cannot launch marketing campaigns (requests via CMO)
