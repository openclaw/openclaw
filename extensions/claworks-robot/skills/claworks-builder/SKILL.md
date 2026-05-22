# ClaWorks Builder

Design and deploy new Playbooks, ObjectTypes, and Packs — live, in conversation.

## When to use

- User wants to automate a new business process ("当设备报警时自动创建工单")
- User wants to track new domain entities ("我想记录每次巡检的结果")
- User wants to install or build a new Pack
- User wants to hot-reload changes without restarting

## Core tools

| Goal                       | Tool                    |
| -------------------------- | ----------------------- |
| Define a new ObjectType    | `cw_define_object_type` |
| Write/update a Playbook    | `cw_write_playbook`     |
| List current Playbooks     | `cw_list_playbooks`     |
| List current ObjectTypes   | `cw_list_types`         |
| Install a Pack from Nexus  | `cw_install_pack`       |
| List installed Packs       | `cw_list_packs`         |
| Reload packs after changes | `cw_reload_packs`       |
| Test: trigger a Playbook   | `cw_trigger_playbook`   |
| Test: publish an event     | `cw_publish_event`      |
| Test: check recent events  | `cw_list_events`        |

## Building a Playbook — workflow

### Step 1: Understand the requirement

Ask the user:

- What event triggers this? (alarm? schedule? IM message? manual?)
- What objects are involved?
- Are there humans who need to approve anything? (HITL)
- What's the final action? (notify, create object, call connector, delegate to another robot?)

### Step 2: Ensure ObjectTypes exist

```
cw_list_types()   # check if needed types already exist
# if missing:
cw_define_object_type({ type_name: "WorkOrder", fields: [...] })
```

### Step 3: Write the Playbook

```
cw_write_playbook({
  id: "on_alarm_received",
  name: "设备告警处置",
  pack: "custom",
  trigger: { kind: "event", pattern: "alarm.created" },
  steps: [
    { id: "query", kind: "action", actionApiName: "objectstore.query", params: {...}, output: "eq" },
    { id: "llm",   kind: "llm",    prompt: "分析...", output: "diagnosis" },
    { id: "hitl",  kind: "hitl",   message: "确认处置？", options: ["是","否"], output: "decision" },
    { id: "notify",kind: "notification", message: "完成: {{ steps.decision }}" }
  ]
})
```

### Step 4: Test

```
cw_publish_event({ event_type: "alarm.created", source: "test", payload: { equipment_id: "PUMP-001", description: "压力异常" } })
cw_list_events(type="alarm.*")          # confirm event received
cw_playbook_runs(playbook_id="on_alarm_received")  # check run status
```

## Playbook step reference

```yaml
# Notify
{ id: "...", kind: "notification", message: "{{ event.payload.x }}" }

# LLM
{ id: "...", kind: "llm", prompt: "...", output: "result_var" }

# ObjectStore query
{ id: "...", kind: "action", actionApiName: "objectstore.query", params: { type_name: "T", filters: {} }, output: "rows" }

# ObjectStore create
{ id: "...", kind: "action", actionApiName: "objectstore.create", params: { type_name: "T", object: {} }, output: "obj" }

# HITL
{ id: "...", kind: "hitl", message: "...", options: ["Yes", "No"], output: "decision", timeout_seconds: 3600 }

# Condition
{ id: "...", kind: "condition", if: "steps.decision == 'Yes'", then: [...], else: [...] }

# Publish event
{ id: "...", kind: "publish_event", eventType: "follow.up", payload: {} }

# Connector
{ id: "...", kind: "connector", connectorId: "mes-connector", method: "create_work_order", params: {} }

# A2A delegate
{ id: "...", kind: "a2a_delegate", target: "pipeline-robot", task: "检查管线压力" }

# Sub-agent
{ id: "...", kind: "subagent", prompt: "分析以下数据...", output: "analysis" }
```

## Template variables

| Expression                   | Value                 |
| ---------------------------- | --------------------- |
| `{{ event.type }}`           | Triggering event type |
| `{{ event.payload.field }}`  | Event payload field   |
| `{{ steps.step_id.result }}` | Previous step output  |
| `{{ robot.name }}`           | Robot name            |

## ObjectType field types

`string`, `number`, `boolean`, `date`

Fields can have `required: true` and `foreign_key: OtherTypeName`.

## Installing a Pack

```
cw_install_pack({ source: "nexus", pack_id: "oil-gas-pack", version: "latest" })
# or from local path:
cw_install_pack({ source: "local", path: "/path/to/pack" })
cw_reload_packs()
```
