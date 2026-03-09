# Atlas direct tool surface (clean)

## Allowed (clean surface)

Admin:

- atlas_ping
- atlas_counts
- atlas_tool_catalog

Semantic memory (read):

- atlas_fact_get
- atlas_facts_search
- atlas_memories_recent
- atlas_memories_search
- atlas_decision_get

Semantic memory (write):

- atlas_fact_upsert
- atlas_memory_append
- atlas_decision_upsert

Workflow (read):

- atlas_task_get
- atlas_tasks_open
- atlas_tasks_due
- atlas_tasks_search

Workflow (write):

- atlas_task_create
- atlas_task_update
- atlas_task_done
- atlas_task_snooze
- atlas_task_set_due
- atlas_task_tag_add
- atlas_task_tag_remove
- atlas_task_link_external

## Must be absent (not registered)

- atlas_query
- atlas_mutate
- atlas_state_get / atlas_state_list / atlas_state_set
- atlas_kv
- atlas_deals_table / atlas_deals_funnel / atlas_deals_evidence
- atlas_ingest

## Verification recipe

1. Call `atlas_tool_catalog(surface="all")` and ensure none of the “must be absent” tools appear.
2. In OpenClaw, set `tools.allow` to the clean surface (optionally read-only in prod).
3. Restart gateway.
