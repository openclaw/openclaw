# Starter Pack

ClaWorks 入门示范 Pack — 演示完整的告警处置工作流。

## 包含内容

| 文件                                         | 说明                                     |
| -------------------------------------------- | ---------------------------------------- |
| `ontology/types/Equipment.yaml`              | 设备对象类型                             |
| `ontology/types/WorkOrder.yaml`              | 工单对象类型                             |
| `ontology/playbooks/on_alarm_received.yaml`  | 告警到达 → 诊断 → 创建工单 → HITL → 派工 |
| `ontology/playbooks/daily_health_check.yaml` | 每日 8:00 定时巡检 + LLM 日报            |

## 流程图

```
alarm.created 事件
       │
       ▼
查询 Equipment 对象
       │
       ▼
LLM 故障诊断
       │
       ▼
创建 WorkOrder 对象
       │
       ▼
HITL 通知工程师（飞书/Telegram）
       │
   工程师选择
  ┌────┴──────────┐
派人处理      观察/忽略
  │                │
更新工单状态  更新工单状态
```

## 快速安装

### 方法一：从本地目录安装

将此目录复制到 `~/.claworks/packs/starter-pack/`，然后：

```bash
curl -X POST http://127.0.0.1:18800/v1/packs/reload \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 方法二：通过 API 安装

```bash
curl -X POST http://127.0.0.1:18800/v1/packs/install \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source": "local", "path": "/path/to/starter-pack"}'
```

## 测试触发告警

```bash
curl -X POST http://127.0.0.1:18800/v1/events \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "alarm.created",
    "source": "test",
    "payload": {
      "equipment_id": "PUMP-001",
      "description": "压力异常，超出正常范围 20%",
      "severity": 3
    }
  }'
```

## 自定义扩展

1. 修改 `Equipment.yaml` 添加业务字段
2. 修改 `on_alarm_received.yaml` 中的 HITL 选项或通知文案
3. 添加新 Playbook 响应其他事件
4. 在 `entry.ts` 中注册自定义 action handler 调用外部 API

## 用 SDK 生成此 Pack

等价的 TypeScript 代码（使用 `@claworks/sdk`）：

```typescript
import {
  definePackManifest,
  defineObjectType,
  definePlaybook,
  step,
  writePack,
} from "@claworks/sdk";

const manifest = definePackManifest({
  id: "starter-pack",
  name: "Starter Pack",
  version: "0.1.0",
  license: "MIT",
  provides: {
    objectTypes: ["Equipment", "WorkOrder"],
    playbooks: ["on_alarm_received", "daily_health_check"],
    actionTypes: [],
  },
});

const Equipment = defineObjectType({
  name: "Equipment",
  displayName: "设备",
  fields: [
    { name: "equipment_id", type: "string", required: true },
    { name: "name", type: "string", required: true },
    { name: "status", type: "string" },
    { name: "location", type: "string" },
  ],
});

const onAlarmReceived = definePlaybook({
  id: "on_alarm_received",
  name: "设备告警处置",
  pack: "starter-pack",
  trigger: { kind: "event", pattern: "alarm.created" },
  steps: [
    step.action(
      "query_equipment",
      "objectstore.query",
      {
        type_name: "Equipment",
        filters: { equipment_id: "{{ event.payload.equipment_id }}" },
      },
      { output: "equipment" },
    ),
    step.llm(
      "llm_diagnosis",
      "设备: {{ steps.equipment.result }}\n告警: {{ event.payload.description }}",
      "diagnosis",
    ),
    step.hitl(
      "notify_engineer",
      "⚠️ {{ event.payload.equipment_id }}\n诊断: {{ steps.diagnosis.result }}",
      ["立即派人", "观察中"],
      "decision",
    ),
    step.notify("done", "工单已更新: {{ steps.decision }}"),
  ],
});

await writePack("./starter-pack", manifest, [Equipment], [onAlarmReceived]);
```
