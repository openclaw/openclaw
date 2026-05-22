# ClaWorks Ops

Operational tasks: monitor health, inspect events, manage HITL queues, and handle production incidents.

## When to use

- Operator asks about system status, active alarms, or pending approvals
- Troubleshooting a failed Playbook run
- Approving or rejecting HITL gates on behalf of an engineer
- Checking connector health or invoking a connector test method

## Workflow

### 1. Check system health

```
cw_status             → overall health (ok / degraded / unavailable)
cw_doctor_run         → detailed checks; pass fix: true to auto-repair
```

### 2. Inspect recent activity

```
cw_list_events        → recent events (filter: type="alarm.*", limit=50)
cw_playbook_runs      → recent runs (filter: status="failed" or playbook_id="...")
```

### 3. Handle HITL approvals

```
cw_hitl_pending       → list waiting approvals
cw_hitl_approve(id)   → approve with decision text
cw_hitl_reject(id)    → reject with reason
```

### 4. ObjectStore inspection

```
cw_list_types         → available ObjectTypes
cw_query_objects(type_name, filters?)   → query with optional field filters
cw_get_object(type_name, id)           → single object
cw_alarm_summary(station_id?)          → alarm counts by severity
```

### 5. Connector health

```
cw_list_connectors    → status of all connectors (pid, ready, lastError)
cw_invoke_connector(connector_id, method, params?)  → invoke test method
```

## Playbook run diagnosis

When a run fails:

1. `cw_playbook_runs(playbook_id="...", status="failed", limit=5)` — find the run
2. Check the `steps` array for the first `status: "failed"` step
3. Check `output.error` for the error message
4. Fix the underlying cause (connector offline, missing object, RBAC denied)
5. `cw_trigger_playbook(playbook_id="...", input={...})` — retry

## Common HITL incident flow

```
Feishu message: "需要审批工单 WO-001"
  → cw_hitl_pending()                        # find token
  → cw_get_object("WorkOrder", "WO-001")     # review details
  → cw_hitl_approve(token, "确认派工")       # approve
```
