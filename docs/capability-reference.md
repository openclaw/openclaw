# ClaWorks 能力参考

> 能力（Capability）是 Playbook 步骤中 `action:` 字段可以使用的操作。
> 所有能力均可通过 `GET /v1/capabilities` 或 `system.describe` 能力动态列出。

## 通信能力

### comms.send

向指定通道发送消息（支持富格式卡片）。

```yaml
action: comms.send
params:
  channel: "user_123" # 通道 ID 或用户 ID
  message: "Hello" # 消息内容（纯文本）
  card: {} # 可选：飞书互动卡片 JSON
```

### notify.dispatch

向指定角色/用户发送通知，支持多通道路由和优先级。

```yaml
action: notify.dispatch
params:
  subject_type: role # "role" 或 "user"
  subject_id: operator # 角色名或用户 ID
  priority: normal # low / normal / high / critical
  message: "通知内容"
```

---

## 数据能力

### object.query

查询 ObjectStore 中的对象。

```yaml
action: object.query
params:
  type: alarm # 对象类型（大写驼峰，如 WorkOrder、Alarm）
  filter: # 过滤条件（可选）
    status: active
  limit: 20 # 返回数量（默认 20）
store_result_as: results
# 结果：{ items: [...], count: N, has_more: bool }
```

### object.create

创建新对象。

```yaml
action: object.create
params:
  type: WorkOrder
  title: "紧急维修"
  priority: high
  status: open
store_result_as: new_order
```

### object.update

更新对象字段（patch 语义，非覆盖）。

```yaml
action: update_object
params:
  type: WorkOrder
  id: "{{ order_id }}"
  status: resolved
  resolved_at: "{{ _now }}"
```

### kb.search

语义搜索知识库。

```yaml
action: search_kb
params:
  query: "液位报警处理规程"
  namespace: ops # 可选命名空间
  limit: 5
store_result_as: kb_hits
# 结果：{ results: [{ id, text, score, namespace, source }], count: N }
```

### kb.ingest

向知识库写入文本。

```yaml
action: ingest_kb_text
params:
  text: "操作规程内容..."
  namespace: ops
  title: "液位报警 SOP v2"
```

### memory.store

向 RobotMemory 写入键值（跨 Playbook 持久）。

```yaml
kind: memory_write
id: save_pref
subject: "{{ user_id }}"
key: preferred_language
value: "zh-CN"
category: user_preference
confidence: 0.95
```

### memory.get

读取 RobotMemory。

```yaml
kind: memory_read
id: load_pref
subject: "{{ user_id }}"
key: preferred_language
output: lang_result
# 结果：{ found: bool, value: "...", subject, key }
```

---

## LLM 能力

### llm.scaffold

用预定义模板调用 LLM（弱模型友好，输出可靠）。

```yaml
action: llm.scaffold
params:
  scaffold_id: alarm_diagnosis
  variables:
    equipment_name: "1号泵"
    alarm_type: "压力异常"
    alarm_value: "3.2 MPa"
store_result_as: result
# 结果：{ text: "...", scaffold_id, ... }
```

### perceive.intent

分析用户消息意图。

```yaml
action: perceive.intent
params:
  message: "{{ trigger.text }}"
store_result_as: intent
# 结果：{ intent: "create_work_order", confidence: 0.92, entities: {...} }
```

### perceive.sentiment

感知消息情绪（用于 HITL 优先级判断）。

```yaml
action: perceive.sentiment
params:
  message: "{{ trigger.text }}"
store_result_as: sentiment
# 结果：{ sentiment: "negative", score: -0.7, urgency: "high" }
```

---

## 流程能力

### hitl.request

请求人工审批（HITL 门控）。

```yaml
kind: hitl
id: approval
message: "请审批工单 {{ order_id }}"
options:
  - approve
  - reject
timeout_seconds: 3600
on_timeout: reject
output: decision
```

### skill.run

调用 OpenClaw ClawHub Skill（AI 推理，带超时保护）。

```yaml
kind: skill
id: diagnose
skillId: industrial.diagnose_alarm
input:
  equipment_id: "{{ equipment_id }}"
  alarm_data: "{{ alarm }}"
output: skill_result
```

也可作为 action 调用：

```yaml
action: skill.run
params:
  skill_id: industrial.diagnose_alarm
  input:
    equipment_id: "{{ equipment_id }}"
store_result_as: diagnosis
```

### script.run

调用纯代码辅助脚本（无 LLM，确定性输出）。

```yaml
kind: script
id: classify
scriptId: default.severity_classifier
input:
  value: "{{ alarm_value }}"
  threshold: 3.0
output: severity
# 结果：{ level: "high", action_required: true }
```

### call_playbook

调用子 Playbook 并等待结果。

```yaml
kind: call_playbook
id: run_escalation
playbookId: process.detect_and_escalate
params:
  alarm_id: "{{ alarm_id }}"
  severity: "{{ severity.level }}"
storeResultAs: escalation_result
```

### learn.from_interaction

记录交互用于离线进化。

```yaml
action: learn.from_interaction
params:
  interaction_type: alarm_response
  context:
    alarm_id: "{{ alarm_id }}"
    resolution: "{{ resolution }}"
  outcome: success
  confidence: 0.9
```

---

## 系统能力

### system.health

检查系统健康状态。

```yaml
action: system.health
store_result_as: health
# 结果：{ status: "ok"|"degraded"|"unavailable", checks: {...} }
```

### system.has_skill

检查指定 Skill 是否已安装。

```yaml
action: system.has_skill
params:
  skill_id: industrial.diagnose_alarm
store_result_as: skill_check
# 结果：{ available: bool, skill_id: "..." }
```

### system.list_skills

列出所有可用 Skills 和内置脚本。

```yaml
action: system.list_skills
store_result_as: skills
# 结果：{ skills: ["industrial.diagnose_alarm", ...], scripts: ["default.severity_classifier", ...] }
```

### observe.audit_log

记录审计日志（合规/溯源）。

```yaml
action: observe.audit_log
params:
  event: work_order_dispatched
  actor: "{{ user_id }}"
  target: "{{ order_id }}"
  detail: "{{ summary }}"
```

### evolution.export_data

导出进化数据包（离线学习用）。

```yaml
action: evolution.export_data
params:
  since_days: 30
  include_types:
    - alarm_response
    - hitl_decision
store_result_as: export_result
```

### evolution.import_pack

导入进化包（将改进的 Playbook/Scaffold 应用到运行时）。

```yaml
action: evolution.import_pack
params:
  pack_path: "/tmp/improved-pack.zip"
store_result_as: import_result
```

---

## 完整能力列表

运行时动态枚举所有已注册能力：

```bash
curl http://localhost:18800/v1/capabilities
```

或在 Playbook 中：

```yaml
action: system.describe
store_result_as: all_caps
```

---

## 扩展能力（Pack 注册）

Pack 可通过 `actionHandlers` 注册自定义能力，无需修改 runtime：

```typescript
// claworks-packs/my-pack/src/entry.ts
export const contribution: PackContribution = {
  actionHandlers: {
    "my_pack.custom_action": async (params, ctx) => {
      // 处理逻辑
      return { status: "ok", result: "..." };
    },
  },
};
```

注册后可在 Playbook 中直接使用：

```yaml
action: my_pack.custom_action
params:
  foo: bar
```

参见 [PACK_DEVELOPMENT.md](../../claworks-packs/PACK_DEVELOPMENT.md) 了解完整开发指南。
