# Capabilities — CTO

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`, `intention_reconsider`
- `plan_generate`, `plan_execute_step`, `htn_decompose`
- `agent_message` — Inter-agent ACL communication
- `decision_request` — Escalate to stakeholder
- `cbr_retrieve`, `cbr_store` — Case-based learning
- `memory_store_item`, `memory_recall` — Memory operations
- `reason` — Multi-method reasoning

## Technology Operations

- `cicd_pipeline` — CI/CD pipeline management (status, trigger, history)
- `cicd_deploy` — Service deployment to staging/production
- `security_scan` — Security scanning (dependency, SAST, container)
- `apm_dashboard` — Application performance monitoring
- `cloudflare_deploy` — Cloudflare Workers deployment
- `integration_setup`, `integration_list`, `integration_sync`, `integration_call` — External integrations
- `typedb_status`, `typedb_query`, `typedb_sync_schema` — Knowledge graph management
- `webhook_process` — Webhook processing
- `setup_wizard_start`, `setup_channel`, `setup_health_check` — System setup

## Constraints

- Cannot approve financial expenditures (requests via CFO)
- Cannot modify marketing campaigns (requests via CMO)
- Cannot change operational processes (requests via COO)
