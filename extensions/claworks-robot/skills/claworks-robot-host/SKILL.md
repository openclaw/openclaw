# ClaWorks Robot — host plugin (`claworks-robot`)

Embedded ClaWorks runtime inside the ClaWorks product Gateway (`claworks.mjs`).  
For **remote** ClaWorks over HTTP/MCP, use the separate `openclaw-claworks-extension` (`plugins.entries.claworks`).

## When to use

- Product fork with `plugins.entries.claworks-robot` enabled
- Tools talk to the **in-process** `@claworks/runtime` (not HTTP hop)

## Complete tool reference

| Category                 | Tool                       | Description                                            |
| ------------------------ | -------------------------- | ------------------------------------------------------ |
| **Status**               | `cw_status`                | Health + plane status (kernel/data/orch)               |
|                          | `cw_doctor_run`            | Doctor checks (optional `fix: true`)                   |
| **Identity**             | `cw_get_identity`          | Robot name, role, constitution                         |
|                          | `cw_instances`             | All running robot instances                            |
| **IM bridge**            | `cw_bridge_im_message`     | Route IM message → EventKernel ingress                 |
| **Events**               | `cw_publish_event`         | Publish a domain event                                 |
|                          | `cw_list_events`           | List recent EventKernel events (filter by type/source) |
| **Playbooks**            | `cw_trigger_playbook`      | Trigger a Playbook by ID                               |
|                          | `cw_list_playbooks`        | Full Playbook list with trigger details                |
|                          | `cw_playbooks_list`        | Compact Playbook list (id, name, pack, trigger kind)   |
|                          | `cw_playbook_runs`         | List recent runs (filter by playbook_id/status)        |
|                          | `cw_write_playbook`        | Write Playbook YAML to custom pack and hot-reload      |
|                          | `cw_reload_playbooks`      | Reload all Playbooks from disk                         |
| **HITL**                 | `cw_hitl_pending`          | List pending HITL approvals                            |
|                          | `cw_hitl_approve`          | Approve a HITL gate                                    |
|                          | `cw_hitl_reject`           | Reject a HITL gate                                     |
| **ObjectStore**          | `cw_list_types`            | List all registered ObjectTypes                        |
|                          | `cw_query_objects`         | Query objects with optional filters                    |
|                          | `cw_get_object`            | Get single object by ID                                |
|                          | `cw_create_object`         | Create a new object                                    |
|                          | `cw_update_object`         | Patch specific fields on an object                     |
|                          | `cw_delete_object`         | Delete an object permanently                           |
|                          | `cw_import_objects`        | Bulk import objects from JSON array                    |
|                          | `cw_define_object_type`    | Define a new ObjectType at runtime                     |
| **Packs**                | `cw_list_packs`            | List installed packs with counts                       |
|                          | `cw_install_pack`          | Install pack from Nexus or local path                  |
|                          | `cw_reload_packs`          | Hot-reload all packs from disk                         |
| **Connectors**           | `cw_list_connectors`       | List connectors + running status                       |
|                          | `cw_invoke_connector`      | Invoke a connector method with params                  |
| **Knowledge Base**       | `cw_kb_search`             | Semantic search (optional namespace, layer)            |
|                          | `cw_kb_ingest`             | Ingest raw text                                        |
|                          | `cw_kb_ingest_folder`      | Ingest all files in a directory                        |
|                          | `cw_kb_status`             | KB statistics (doc count, namespace list)              |
|                          | `cw_kb_flush`              | Flush in-memory KB to disk                             |
| **KB document refinery** | `cw_kb_ingest_document`    | Ingest with metadata (auto_publish: false for draft)   |
|                          | `cw_kb_list_documents`     | List documents (filter by status: draft/published)     |
|                          | `cw_kb_get_document`       | Get document by ID                                     |
|                          | `cw_kb_lint_document`      | Lint document quality before publish                   |
|                          | `cw_kb_publish`            | Publish a draft document                               |
|                          | `cw_kb_create_ingest_job`  | Create batch ingest job                                |
|                          | `cw_kb_process_ingest_job` | Process pending ingest job                             |
| **Alarms**               | `cw_alarm_summary`         | Active alarm counts by severity                        |
| **LLM**                  | `cw_agent_chat`            | One-shot LLM completion via Gateway runtime            |

## Config

`plugins.entries.claworks-robot.config` — see `openclaw.plugin.json` `configSchema`.

**Minimal secure config:**

```json
{
  "robot": { "name": "MyRobot", "role": "monolith" },
  "api": { "api_key": "YOUR_SECRET_KEY", "require_api_key": true },
  "data": { "database_url": "~/.claworks/db/claworks.db" }
}
```

Production init: `CLAWORKS_INIT_SECURE=1 pnpm claworks:init` — generates API key and secure defaults.

## REST equivalents

All tools have a REST equivalent on the product Gateway port (default **18800**).  
Authenticated: `Authorization: Bearer <api.api_key>`

| Tool                  | REST                              |
| --------------------- | --------------------------------- |
| `cw_status`           | `GET /v1/health`                  |
| `cw_list_events`      | `GET /v1/observation-events`      |
| `cw_trigger_playbook` | `POST /v1/playbooks/{id}/runs`    |
| `cw_query_objects`    | `GET /v1/objects/{type}`          |
| `cw_create_object`    | `POST /v1/objects/{type}`         |
| `cw_update_object`    | `PATCH /v1/objects/{type}/{id}`   |
| `cw_publish_event`    | `POST /v1/events`                 |
| `cw_list_packs`       | `GET /v1/packs`                   |
| `cw_install_pack`     | `POST /v1/packs/install`          |
| `cw_list_connectors`  | `GET /v1/connectors`              |
| `cw_invoke_connector` | `POST /v1/connectors/{id}/invoke` |
