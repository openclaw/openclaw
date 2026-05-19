# ClaWorks REST API Specification

> 这是 ClaWorks robot 进程对外暴露的 HTTP API。
> OpenClaw `claworks` 插件通过这些端点操作机器人。
> 所有路径以 `/{version}` 开头，当前版本 `v1`。

---

## 基础约定

```
Base URL:   http://{host}:{port}
Port:       8000 (monolith/twin), 8001 (ops-only split)
Auth:       Bearer token via Authorization header (可选，由 claworks.apiKey 配置)
Format:     JSON, Content-Type: application/json
Errors:     { "error": "...", "code": "SNAKE_CASE_CODE" }
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

### `POST /v1/playbooks/runs/{runId}/hitl`

向 HITL 节点提交人工决策。

```json
// request
{ "decision": "approve", "comment": "确认需要立即处理", "operator": "zhang-san" }
```

---

## 五、EventKernel

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

---

## 六、扩展包（Pack）

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

## 七、A2A（Robot-to-Robot）

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

## 八、诊断/可观测性

### `GET /v1/metrics`

Prometheus 格式 metrics（如果启用了 `diagnostics-prometheus`）。

### `GET /v1/decision-log`

LLM 决策日志（每次 LLM 参与的仲裁记录）。

### `GET /v1/observation-events`

传感器/设备观测事件流。

---

## 端口规范

| 角色         | 端口         | 说明                                    |
| ------------ | ------------ | --------------------------------------- |
| monolith     | 8000         | 所有 API                                |
| twin (split) | 8000         | 数据面 API（/v1/objects, /v1/kb）       |
| ops (split)  | 8001         | 编排面 API（/v1/playbooks, /v1/events） |
| nexus        | 8080         | Pack 目录服务                           |
| A2A          | 同 main port | 共享端口，路由区分                      |
