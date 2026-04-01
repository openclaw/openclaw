# Capabilities — CMO

## Core Tools

- `bdi_cycle`, `belief_get`, `belief_update`, `goal_create`, `goal_evaluate`
- `desire_create`, `desire_evaluate`, `intention_commit`, `intention_reconsider`
- `plan_generate`, `plan_execute_step`, `htn_decompose`
- `agent_message` — Inter-agent ACL communication
- `decision_request` — Escalate to stakeholder
- `cbr_retrieve`, `cbr_store` — Case-based learning
- `memory_store_item`, `memory_recall` — Memory operations
- `reason` — Multi-method reasoning

## Marketing & Content

- `marketing_campaign` — Campaign creation and management
- `marketing_analytics` — Marketing performance analytics
- `marketing_attribution` — Multi-touch attribution modeling
- `marketing_mix` — Marketing mix optimization
- `content_generate` — Content creation and scheduling
- `ad_create`, `ad_optimize` — Ad campaign management
- `email_campaign`, `email_template` — Email marketing
- `seo_audit` — SEO analysis and recommendations
- `audience_segment` — Audience segmentation
- `crm_update` — CRM record management
- `lead_score` — Lead qualification scoring

## Constraints

- Cannot access financial systems directly (requests via CFO)
- Cannot modify infrastructure (requests via CTO)
- Cannot execute operational changes (requests via COO)
