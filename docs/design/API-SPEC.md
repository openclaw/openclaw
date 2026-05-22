# ClaWorks REST API Specification

> 这是 ClaWorks robot 进程对外暴露的 HTTP API。
> OpenClaw `claworks` 插件通过这些端点操作机器人。
> 所有路径以 `/{version}` 开头，当前版本 `v1`。

---

## 基础约定

```
Base URL:   http://127.0.0.1:{port}
Port:       18800 (claworks.mjs 产品入口), 8000 (robot 内部默认)
Auth:       Bearer token via Authorization header (可选，由 api.api_key 配置)
Format:     JSON, Content-Type: application/json
Errors:     { "error": "...", "code": "SNAKE_CASE_CODE" }
RBAC:       写操作需通过 RBAC 守卫；失败返回 403 + { "code": "RBAC_DENIED" }
```

---

## 一、系统端点

### `GET /v1/health`

返回机器人健康状态。

```json
{
  "status": "ok", // "ok" | "degraded" | "unavailable"
  "robot": "my-robot",
  "role": "monolith", // "monolith" | "twin" | "ops" | "nexus"
  "version": "2026.5.0-alpha.1",
  "uptime_s": 3600,
  "planes": {
    "kernel": "ok",
    "data": "ok",
    "orch": "ok"
  }
}
```

### `POST /v1/doctor`

运行自诊断，返回问题列表和建议。

```json
// response
{
  "checks": [
    { "id": "db_connection", "status": "ok", "message": null },
    {
      "id": "pack_load",
      "status": "warn",
      "message": "pack 'process-industry' v1.1 available, installed v1.0"
    }
  ]
}
```

---

## 二、ObjectStore（数据面）

### `GET /v1/objects/{type}`

查询本体对象列表。

**Query params**:

- `filter` — JSON 过滤条件（`{"status": "open"}`）
- `limit` — 最大返回数（默认 50）
- `cursor` — 分页游标

```json
// response
{
  "type": "WorkOrder",
  "items": [
    { "id": "wo-001", "status": "open", "equipment_id": "eq-101", ... }
  ],
  "next_cursor": null
}
```

### `GET /v1/objects/{type}/{id}`

获取单个对象。

### `POST /v1/objects/{type}`

创建新对象。

```json
// request body
{ "equipment_id": "eq-101", "description": "异常振动", "priority": "high" }
```

### `PATCH /v1/objects/{type}/{id}`

更新对象字段。

### `POST /v1/objects/{type}/{id}/actions/{actionType}`

对对象执行已定义的 ActionType。

```json
// request: POST /v1/objects/WorkOrder/wo-001/actions/acknowledge_alarm
{ "acknowledged_by": "engineer-zhang", "note": "已现场确认" }
```

---

## 三、知识库（KB，数据面）

### `GET /v1/kb/search`

语义搜索 KB。

**Query params**:

- `q` — 查询文本（必填）
- `limit` — 返回数（默认 5）
- `namespace` — KB 命名空间

```json
{
  "results": [
    { "id": "doc-001", "score": 0.92, "text": "...", "source": "equipment_manual_v2.pdf" }
  ]
}
```

### `POST /v1/kb/ingest`

写入文本到 KB。

```json
// request
{
  "text": "设备 EQ-101 的维护周期为每季度一次...",
  "namespace": "equipment",
  "source": "manual_v3.pdf"
}
```

---

## 四、Playbook（编排面）

### `GET /v1/playbooks`

列举所有可用 Playbook。

```json
{
  "playbooks": [
    {
      "id": "mro_alarm_to_workorder",
      "name": "报警→工单",
      "trigger": "alarm.created",
      "pack": "process-industry"
    }
  ]
}
```

### `POST /v1/playbooks/{id}/runs`

手动触发一个 Playbook。

```json
// request
{ "input": { "alarm_id": "alm-005" } }

// response
{ "run_id": "run-abc123", "status": "running", "started_at": "2026-05-19T20:00:00Z" }
```

### `GET /v1/playbooks/{id}/runs`

查询 Playbook 运行历史。

**Query params**: `status`, `limit`, `cursor`

### `GET /v1/playbooks/{id}/runs/{runId}`

获取单次运行详情，包含 step 执行日志。

```json
{
  "run_id": "run-abc123",
  "status": "waiting_hitl",
  "steps": [
    { "step": "check_alarm_severity", "status": "completed", "output": { "severity": "high" } },
    { "step": "human_approval", "status": "waiting", "hitl_token": "htl-xyz" }
  ]
}
```

### `POST /v1/playbooks/{id}/runs/{runId}/hitl`

向 HITL 节点提交人工决策（需 `step_id` 和 `decision`）。

```json
// request
{ "step_id": "confirm_step", "decision": "立即派人", "comment": "现场已确认" }
```

### `PUT /v1/playbooks/{id}/yaml`

热写入 Playbook YAML 到 custom pack 并自动重载（`rest.write` 权限）。

```json
// request
{ "yaml": "id: my_playbook\nname: ...\ntrigger:\n  kind: manual\nsteps: []" }
```

---

## 五、HITL（人工审批）

### `GET /v1/hitl/pending`

列出所有等待人工审批的 Playbook 运行。

```json
{
  "pending": [
    {
      "run_id": "run-abc123",
      "playbook_id": "on_alarm_received",
      "started_at": "2026-05-19T20:00:00Z",
      "waiting_step_id": "confirm_dispatch",
      "steps": [...]
    }
  ]
}
```

### `POST /v1/hitl/{runId}/resolve`

通过 run_id 提交 HITL 决策（自动找等待步骤，或显式提供 `step_id`）。

```json
// request
{ "decision": "立即派人处理", "comment": "工程师张三已到场", "step_id": "confirm_dispatch" }

// response — 更新后的完整 PlaybookRun
{ "id": "run-abc123", "status": "running", "steps": [...] }
```

---

## 六、EventKernel

### `POST /v1/events`

向 EventKernel 发布事件（外部系统推入事件）。

```json
// request
{
  "type": "alarm.created",
  "source": "opc-ua://plc-001",
  "payload": { "alarm_id": "alm-005", "tag": "PRESS-001", "value": 12.5, "limit": 10.0 }
}

// response
{ "event_id": "evt-qqq", "matched_playbooks": ["mro_alarm_to_workorder"] }
```

### `GET /v1/events`

查询事件日志。

**Query params**: `type`, `source`, `from`, `to`, `limit`

### `POST /v1/bridge/im`

IM 消息经 Ingress（默认 `intent_route`）进入分类 Playbook，不泛洪 EventBus。

```json
// request
{
  "channel": "feishu",
  "message_id": "om_xxx",
  "user_id": "ou_xxx",
  "text": "3号泵振动偏高"
}

// response (202)
{ "action": "intent_routed", "playbookId": "classify_im_to_business_event", "runId": "...", "status": "running" }
```

### `POST /v1/bridge/webhook`

外部 Webhook 载荷，与 IM 桥对称（默认 `classify_webhook_to_business_event`）。

```json
// request
{
  "source": "mes",
  "webhook_id": "evt-001",
  "body": { "alarm_code": "PUMP_VIB_HIGH", "equipment_id": "eq-3" }
}
```

### `POST /v1/rbac/reload`

从 ObjectStore 重新加载 `RbacPolicy` 与 `IngressPolicy`（需 `rest.write` + `rbac:*`）。

---

## 七、Connector（外部系统连接器）

### `GET /v1/connectors`

列出所有已注册的 Connector 及其运行状态。

```json
{
  "connectors": [
    { "id": "opc-ua-plc", "running": true, "pid": 12345, "ready": true, "lastError": null },
    { "id": "mes-bridge", "running": false, "ready": false, "lastError": "connection refused" }
  ]
}
```

### `POST /v1/connectors/{id}/invoke`

调用 Connector 的指定方法（写操作需 RBAC `rest.write`）。

```json
// request
{ "method": "get_status", "params": { "tag": "PUMP-001.VIB" } }

// response
{ "ok": true, "result": { "value": 12.5, "unit": "mm/s", "quality": "good" } }
```

---

## 八、扩展包（Pack）

### `GET /v1/packs`

列举已安装的 Pack。

```json
{
  "packs": [
    { "id": "base", "version": "1.0.0", "status": "active" },
    { "id": "process-industry", "version": "1.0.0", "status": "active", "depends": ["base"] }
  ]
}
```

### `POST /v1/packs/install`

安装一个 Pack（从本地路径或 Nexus）。

```json
// request
{ "source": "nexus://process-industry@1.1.0" }
// 或
{ "source": "file:///path/to/my-pack" }
```

### `DELETE /v1/packs/{id}`

卸载 Pack。

---

## 九、A2A（Robot-to-Robot）

ClaWorks 实现 [Google A2A 协议](https://google.github.io/A2A/)。

### `GET /.well-known/agent.json`

返回 A2A Agent Card（机器人身份和能力声明）。

```json
{
  "name": "my-robot",
  "description": "ClaWorks industrial robot for oil & gas plant A",
  "url": "http://robot-a.internal:8000",
  "version": "2026.5.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [
    {
      "id": "alarm_query",
      "name": "Query Alarms",
      "description": "Query active alarms from plant A"
    },
    { "id": "workorder_create", "name": "Create Work Order" }
  ]
}
```

### `POST /a2a/tasks/send`

接收来自其他机器人的 A2A Task。

### `GET /a2a/tasks/{taskId}`

查询 Task 状态（A2A 标准格式）。

---

## 十、诊断/可观测性

### `GET /v1/metrics`

Prometheus 格式 metrics（如果启用了 `diagnostics-prometheus`）。

### `GET /v1/decision-log`

LLM 决策日志（每次 LLM 参与的仲裁记录）。

### `GET /v1/observation-events`

传感器/设备观测事件流。

---

## 端口规范

| 入口                           | 端口         | 说明                               |
| ------------------------------ | ------------ | ---------------------------------- |
| `claworks.mjs` (产品 CLI)      | **18800**    | ClaWorks 全量 API，默认绑 loopback |
| `openclaw.mjs` (上游 OpenClaw) | **18789**    | 与 ClaWorks 并存时的独立端口       |
| robot 内部（monolith/twin）    | 8000         | `@claworks/runtime` 默认           |
| nexus Pack 服务                | 8080         | `createNexusServer()` 默认         |
| A2A                            | 同 main port | `/a2a/*` 共享端口路由              |

## 完整端点速查

| 方法   | 路径                                   | 分类        | 权限  |
| ------ | -------------------------------------- | ----------- | ----- |
| GET    | `/v1/health`                           | 系统        | 公开  |
| POST   | `/v1/doctor`                           | 系统        | write |
| GET    | `/v1/identity`                         | 系统        | 认证  |
| GET    | `/v1/metrics`                          | 可观测      | 认证  |
| GET    | `/v1/decision-log`                     | 可观测      | 认证  |
| GET    | `/v1/observation-events`               | 可观测      | 认证  |
| POST   | `/v1/rbac/reload`                      | 系统        | write |
| GET    | `/v1/objects/{type}`                   | ObjectStore | 认证  |
| GET    | `/v1/objects/{type}/{id}`              | ObjectStore | 认证  |
| POST   | `/v1/objects/{type}`                   | ObjectStore | write |
| PATCH  | `/v1/objects/{type}/{id}`              | ObjectStore | write |
| GET    | `/v1/kb/search`                        | KB          | 认证  |
| POST   | `/v1/kb/ingest`                        | KB          | write |
| POST   | `/v1/kb/ingest/folder`                 | KB          | write |
| GET    | `/v1/playbooks`                        | Playbook    | 认证  |
| POST   | `/v1/playbooks/{id}/runs`              | Playbook    | write |
| GET    | `/v1/playbooks/{id}/runs`              | Playbook    | 认证  |
| GET    | `/v1/playbooks/{id}/runs/{runId}`      | Playbook    | 认证  |
| POST   | `/v1/playbooks/{id}/runs/{runId}/hitl` | HITL        | write |
| PUT    | `/v1/playbooks/{id}/yaml`              | Playbook    | write |
| GET    | `/v1/hitl/pending`                     | HITL        | 认证  |
| POST   | `/v1/hitl/{runId}/resolve`             | HITL        | write |
| POST   | `/v1/events`                           | EventKernel | write |
| GET    | `/v1/events`                           | EventKernel | 认证  |
| POST   | `/v1/bridge/im`                        | IM 桥       | write |
| POST   | `/v1/bridge/webhook`                   | Webhook 桥  | write |
| GET    | `/v1/connectors`                       | Connector   | 认证  |
| POST   | `/v1/connectors/{id}/invoke`           | Connector   | write |
| GET    | `/v1/packs`                            | Pack        | 认证  |
| POST   | `/v1/packs/install`                    | Pack        | write |
| DELETE | `/v1/packs/{id}`                       | Pack        | write |
| POST   | `/v1/packs/reload`                     | Pack        | write |
| GET    | `/.well-known/agent.json`              | A2A         | 公开  |
| POST   | `/a2a/tasks/send`                      | A2A         | 认证  |
