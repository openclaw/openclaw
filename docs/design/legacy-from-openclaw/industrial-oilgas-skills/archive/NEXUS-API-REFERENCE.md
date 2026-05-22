# Nexus Platform API 完整参考手册

> **版本**：v1.0.1 · 2026-05-12  
> **路径权威**：本文档与 `DESIGN-FINAL-LOCK.md §一` 保持一致  
> **格式规范**：所有请求/响应均为 JSON，`Content-Type: application/json`  
> **认证**：除 `/v1/auth/login` 外，所有接口均需 `Authorization: Bearer <token>`  
> **本地联调 / cwd**：多仓与目录见 **`DEV-QUICKSTART.md` §〇**；启动与 `CLAWTWIN_*` 见 **`clawtwin-platform/platform-api/README.md`**；**pytest** 仅能在 **`platform-api/`** 下执行（**`TESTING-GUIDE.md` §二.0**）。下文 curl 示例默认 `http://127.0.0.1:8000`。

---

## 零、统一响应格式与错误码

### 0.1 成功响应

```json
// 单对象
{ "data": { ... }, "meta": { "request_id": "req-xxx" } }

// 列表
{
  "data": [ ... ],
  "meta": {
    "page": 1,
    "size": 20,
    "total": 156,
    "request_id": "req-xxx"
  }
}

// 操作成功（无返回体）
HTTP 204 No Content
```

### 0.2 错误响应（统一格式）

```json
{
  "error": {
    "code": "WORK_ORDER_INVALID_STATE",
    "message": "工单状态不允许此操作（当前: approved，操作: pending）",
    "detail": { "current_state": "approved", "action": "pending" },
    "request_id": "req-xxx"
  }
}
```

### 0.3 错误码表

| HTTP 状态 | error.code                  | 含义                                       |
| --------- | --------------------------- | ------------------------------------------ |
| 400       | `INVALID_INPUT`             | 请求参数格式错误                           |
| 400       | `VALIDATION_FAILED`         | 业务规则校验失败（附 detail）              |
| 401       | `UNAUTHORIZED`              | Token 未提供或已过期                       |
| 401       | `TOKEN_EXPIRED`             | JWT 已过期，需刷新                         |
| 403       | `FORBIDDEN`                 | 权限不足（角色或场站）                     |
| 403       | `STATION_ACCESS_DENIED`     | 无权访问该场站数据                         |
| 404       | `NOT_FOUND`                 | 资源不存在                                 |
| 409       | `WORK_ORDER_INVALID_STATE`  | 工单状态机非法转换                         |
| 409       | `DUPLICATE`                 | 重复创建（含 existing_id）                 |
| 422       | `DATA_QUALITY_INSUFFICIENT` | OT 数据质量不足，无法触发 AI 分析          |
| 429       | `RATE_LIMITED`              | 请求过快，含 Retry-After 头                |
| 500       | `INTERNAL_ERROR`            | 服务器内部错误                             |
| 503       | `SERVICE_UNAVAILABLE`       | 依赖服务（DB/**pgvector**/Redis 等）不可用 |

### 0.4 认证 Token 格式

```http
# Studio（用户 JWT）
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx...

# AI Agent / OA（Service Token）
Authorization: Bearer ct-svc-openclaw-xxxxxxxxxxxxx
```

---

## 一、认证接口

### POST /v1/auth/login

```http
POST /v1/auth/login
Content-Type: application/json

{
  "username": "zhangsan@company.com",  // 邮箱或工号
  "password": "Pass@1234"
}
```

**成功响应（200）：**

```json
{
  "data": {
    "access_token": "eyJhbGc...",
    "refresh_token": "eyJhbGc...",
    "token_type": "bearer",
    "expires_in": 28800,
    "user": {
      "id": 1,
      "username": "zhangsan",
      "email": "zhangsan@company.com",
      "role": "operator",
      "stations": [
        { "id": 1, "name": "泵站一", "status": "normal" },
        { "id": 2, "name": "压气站二", "status": "alarm" }
      ]
    }
  }
}
```

**失败（401）：**

```json
{ "error": { "code": "UNAUTHORIZED", "message": "用户名或密码错误" } }
```

---

### POST /v1/auth/refresh

```http
POST /v1/auth/refresh
Content-Type: application/json

{ "refresh_token": "eyJhbGc..." }
```

**成功（200）：**

```json
{ "data": { "access_token": "eyJhbGc...", "expires_in": 28800 } }
```

---

## 二、设备接口

### GET /v1/equipment

```http
GET /v1/equipment?station_id=1&status=alarm&page=1&size=20
Authorization: Bearer <jwt>
```

**成功（200）：**

```json
{
  "data": [
    {
      "id": "C-101",
      "name": "1# 输油泵",
      "equipment_type": "centrifugal_pump",
      "station_id": 1,
      "area": "泵房A",
      "status": "alarm",
      "primary_action": {
        "type": "diagnose",
        "label": "AI 诊断",
        "urgency": "high",
        "predicted_breach_minutes": 45
      },
      "readings": {
        "outlet_pressure": { "value": 4.2, "unit": "MPa", "ts": "2026-05-11T04:10:00Z" },
        "vibration": { "value": 8.7, "unit": "mm/s", "ts": "2026-05-11T04:10:00Z" },
        "temperature": { "value": 72.3, "unit": "°C", "ts": "2026-05-11T04:10:00Z" }
      },
      "health_score": 62,
      "active_alarm_count": 2
    }
  ],
  "meta": { "page": 1, "size": 20, "total": 8 }
}
```

---

### GET /v1/equipment/{id}

```http
GET /v1/equipment/C-101
Authorization: Bearer <jwt>
```

**成功（200）：**

```json
{
  "data": {
    "id": "C-101",
    "name": "1# 输油泵",
    "equipment_type": "centrifugal_pump",
    "model": "KSB RDLO 200-400",
    "manufacturer": "KSB",
    "install_date": "2019-03-15",
    "station_id": 1,
    "area": "泵房A",
    "status": "alarm",
    "readings": {
      "outlet_pressure": {
        "value": 4.2,
        "unit": "MPa",
        "ts": "2026-05-11T04:10:00Z",
        "quality": "good"
      },
      "inlet_pressure": {
        "value": 0.8,
        "unit": "MPa",
        "ts": "2026-05-11T04:10:00Z",
        "quality": "good"
      },
      "vibration": {
        "value": 8.7,
        "unit": "mm/s",
        "ts": "2026-05-11T04:10:00Z",
        "quality": "good"
      },
      "temperature": {
        "value": 72.3,
        "unit": "°C",
        "ts": "2026-05-11T04:10:00Z",
        "quality": "good"
      },
      "flow_rate": {
        "value": 320.5,
        "unit": "m³/h",
        "ts": "2026-05-11T04:10:00Z",
        "quality": "good"
      }
    },
    "thresholds": {
      "vibration": { "warn": 4.5, "alarm": 7.1, "unit": "mm/s" },
      "temperature": { "warn": 65.0, "alarm": 80.0, "unit": "°C" }
    },
    "primary_action": {
      "type": "diagnose",
      "label": "AI 诊断",
      "urgency": "high",
      "predicted_breach_minutes": 45
    },
    "health_score": 62,
    "active_alarm_count": 2,
    "open_work_order_count": 1
  }
}
```

---

### GET /v1/equipment/{id}/decision-package

```http
GET /v1/equipment/C-101/decision-package
Authorization: Bearer <jwt>
```

**成功（200，来自 Redis 缓存，< 10ms）：**

```json
{
  "data": {
    "equipment_id": "C-101",
    "generated_at": "2026-05-11T04:09:58Z",
    "cache_ttl_seconds": 30,
    "snapshot": {
      "readings": { "vibration": 8.7, "temperature": 72.3 },
      "active_alarms": [
        { "id": 1, "priority": "P2", "message": "振动超限", "duration_minutes": 23 }
      ],
      "recent_work_orders": [
        { "id": 5, "description": "更换机封", "state": "done", "completed_at": "2026-04-20" }
      ],
      "kb_excerpts": [
        {
          "layer": "L1",
          "source": "KSB RDLO 维护手册 §4.2",
          "content": "振动值超过 7.1mm/s 时应立即停机检查",
          "relevance_score": 0.94
        }
      ],
      "trend_24h": {
        "vibration_slope": "+0.18 mm/s/h",
        "trend_direction": "worsening"
      }
    }
  }
}
```

---

### GET /v1/equipment/{id}/readings

```http
GET /v1/equipment/C-101/readings?metric=vibration&from=2026-05-10T00:00:00Z&to=2026-05-11T00:00:00Z&interval=1h
Authorization: Bearer <jwt>
```

**成功（200）：**

```json
{
  "data": {
    "equipment_id": "C-101",
    "metric": "vibration",
    "unit": "mm/s",
    "interval": "1h",
    "points": [
      { "ts": "2026-05-10T00:00:00Z", "value": 4.1 },
      { "ts": "2026-05-10T01:00:00Z", "value": 4.3 },
      { "ts": "2026-05-10T23:00:00Z", "value": 8.7 }
    ]
  }
}
```

---

## 三、告警接口

### GET /v1/alarms

```http
GET /v1/alarms?station_id=1&priority=P1,P2&status=active&page=1&size=50
Authorization: Bearer <jwt>
```

**成功（200）：**

```json
{
  "data": [
    {
      "id": 1,
      "equipment_id": "C-101",
      "equipment_name": "1# 输油泵",
      "priority": "P2",
      "message": "振动值 8.7mm/s 超过告警阈值 7.1mm/s",
      "status": "active",
      "acknowledged": false,
      "acknowledged_by": null,
      "created_at": "2026-05-11T03:47:00Z",
      "duration_minutes": 23,
      "rule_id": "vibration_high_alarm",
      "station_id": 1
    }
  ],
  "meta": { "page": 1, "size": 50, "total": 3 }
}
```

---

## 四、工单接口

### POST /v1/workorders/ai-draft

```http
POST /v1/workorders/ai-draft
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "equipment_id": "C-101",
  "trigger_alarm_id": 1,
  "symptom_description": "振动持续增大，温度异常"
}
```

**成功（200，AI 预填草稿，不创建工单）：**

```json
{
  "data": {
    "suggested_title": "C-101 1#输油泵振动超限处理",
    "suggested_work_type": "inspection",
    "suggested_description": "机泵振动值达到 8.7mm/s，超过告警阈值 7.1mm/s，持续 23 分钟。根据 KSB 手册，建议检查轴承磨损状况和对中情况。",
    "suggested_priority": "urgent",
    "suggested_checklist": [
      "检查轴承温度和振动频谱",
      "检查联轴器对中",
      "检查底座螺栓紧固情况",
      "查看运行日志最近 24h 趋势"
    ],
    "citations": [{ "source": "KSB RDLO 维护手册 §4.2", "layer": "L1", "relevance": 0.94 }],
    "ai_confidence": 0.87
  }
}
```

---

### POST /v1/workorders/

```http
POST /v1/workorders/
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "equipment_id": "C-101",
  "title": "C-101 1#输油泵振动超限处理",
  "work_type": "inspection",
  "priority": "urgent",
  "description": "机泵振动值达到 8.7mm/s...",
  "checklist": ["检查轴承", "检查对中"],
  "trigger_alarm_id": 1,
  "assignee_id": 3
}
```

**成功（201）：**

```json
{
  "data": {
    "id": 42,
    "state": "draft",
    "equipment_id": "C-101",
    "title": "C-101 1#输油泵振动超限处理",
    "work_type": "inspection",
    "priority": "urgent",
    "created_by": { "id": 1, "name": "张三" },
    "assignee": { "id": 3, "name": "李四" },
    "created_at": "2026-05-11T04:12:00Z"
  }
}
```

**状态机转换（每个 HITL 端点）：**

```http
# 提交审批
POST /v1/hitl/workorders/42/pending
Authorization: Bearer <jwt>
# 无请求体

# 成功（200）
{ "data": { "id": 42, "state": "pending_approval", "updated_at": "..." } }
```

```http
# 审批通过（主管或 OA）
POST /v1/hitl/workorders/42/approve
Authorization: Bearer <jwt>
Content-Type: application/json

{ "comment": "同意，注意安全操作" }  // 可选

# 成功（200）
{ "data": { "id": 42, "state": "approved", "approved_by": { "id": 2, "name": "王五" } } }
```

```http
# 完成工单（上传证据）
POST /v1/hitl/workorders/42/done
Authorization: Bearer <jwt>
Content-Type: multipart/form-data

evidence_description=已检查轴承并更换润滑油，振动值降至3.2mm/s
evidence_files=@photo1.jpg
evidence_files=@report.pdf

# 成功（200）
{ "data": { "id": 42, "state": "done", "completed_at": "...", "l3_knowledge_written": true } }
```

**状态机错误（409）：**

```json
{
  "error": {
    "code": "WORK_ORDER_INVALID_STATE",
    "message": "工单状态不允许此操作",
    "detail": {
      "current_state": "approved",
      "requested_action": "pending",
      "allowed_actions": ["start", "reject"]
    }
  }
}
```

---

## 五、AI 任务接口

### POST /v1/ai/jobs

```http
POST /v1/ai/jobs
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "job_type": "diagnose",
  "equipment_id": "C-101",
  "context_hint": "vibration_spike",  // 可选，给 AI 的额外上下文
  "priority": "high"                   // 可选，high|normal
}
```

**成功（202 Accepted）：**

```json
{
  "data": {
    "job_id": "job-2026-xxx",
    "status": "pending",
    "created_at": "2026-05-11T04:12:00Z",
    "estimated_seconds": 45,
    "sse_url": "/v1/sse/ai-jobs/job-2026-xxx"
  }
}
```

**job_type 枚举：**

```
diagnose          设备诊断（最常用）
analyze_alarm     告警根因分析
shift_report      班次交接报告生成
kb_query          知识库问答
trend_analysis    趋势分析和预测
pid_analysis      P&ID 异常分析（需图像）
```

---

### GET /v1/sse/ai-jobs/{job_id}

```http
GET /v1/sse/ai-jobs/job-2026-xxx
Authorization: Bearer <jwt>
Accept: text/event-stream
```

**SSE 事件流（text/event-stream）：**

```
data: {"type":"progress","percent":10,"message":"正在读取设备上下文..."}

data: {"type":"progress","percent":35,"message":"检索相关知识库..."}

data: {"type":"chunk","content":"根据当前振动值 8.7mm/s..."}

data: {"type":"chunk","content":"，结合 KSB 手册建议..."}

data: {"type":"completed","result":{"summary":"振动值超过告警阈值，建议紧急检查轴承","confidence":0.87,"recommended_action":{"type":"inspect","label":"安排轴承检查","urgency":"high"},"citations":[{"source":"KSB RDLO 手册 §4.2","layer":"L1","excerpt":"振动超7.1mm/s立即停机检查"}]},"job_id":"job-2026-xxx"}
```

**任务失败事件：**

```
data: {"type":"failed","error":"AI服务暂时不可用，请稍后重试","job_id":"job-2026-xxx"}
```

---

### POST /v1/ai/jobs/{job_id}/result

> **调用方：AI Agent（OpenClaw/Hermes）**，需 ServiceToken

```http
POST /v1/ai/jobs/job-2026-xxx/result
Authorization: Bearer ct-svc-openclaw-xxxxx
Content-Type: application/json

{
  "status": "completed",
  "result": {
    "summary": "振动值超过告警阈值，建议紧急检查轴承",
    "confidence": 0.87,
    "recommended_action": {
      "type": "inspect",
      "label": "安排轴承检查",
      "urgency": "high"
    },
    "citations": [
      {
        "source": "KSB RDLO 手册 §4.2",
        "layer": "L1",
        "excerpt": "振动超 7.1mm/s 立即停机检查",
        "relevance_score": 0.94
      }
    ],
    "full_reasoning": "...",  // 可选，完整推理链
    "model_used": "Qwen3-35B-A3B-GPTQ-Int4"
  }
}
```

**成功（200）：**

```json
{ "data": { "job_id": "job-2026-xxx", "status": "completed" } }
```

**失败回调：**

```json
{
  "status": "failed",
  "error": { "code": "CONTEXT_INSUFFICIENT", "message": "设备数据质量不足" }
}
```

---

## 六、知识库接口

### GET /v1/kb/search

```http
GET /v1/kb/search?q=离心泵振动超限处理&equipment_type=centrifugal_pump&layer=L0,L1&limit=5
Authorization: Bearer <jwt>
```

**成功（200）：**

```json
{
  "data": {
    "query": "离心泵振动超限处理",
    "results": [
      {
        "id": "chunk-xxx",
        "document_id": "doc-123",
        "source": "KSB RDLO 维护手册",
        "layer": "L1",
        "content": "振动值超过 7.1mm/s 时，应立即停机检查轴承、联轴器和底座...",
        "relevance_score": 0.94,
        "metadata": {
          "page": 47,
          "section": "§4.2 振动管理",
          "equipment_type": "centrifugal_pump"
        }
      }
    ],
    "total_results": 5,
    "search_time_ms": 125
  }
}
```

---

## 七、实时推送（SSE）

### GET /v1/sse/station/{station_id}

```http
GET /v1/sse/station/1
Authorization: Bearer <jwt>
Accept: text/event-stream
```

**SSE 事件类型：**

```
# 设备读数更新（每 30s 推送一次有变化的设备）
data: {"type":"equipment_reading","equipment_id":"C-101","readings":{"vibration":{"value":8.9,"unit":"mm/s","ts":"2026-05-11T04:15:00Z"}}}

# 新告警
data: {"type":"alarm_created","alarm":{"id":3,"equipment_id":"C-101","priority":"P1","message":"振动超过紧急停机阈值","created_at":"2026-05-11T04:15:30Z"}}

# 告警关闭
data: {"type":"alarm_resolved","alarm_id":2,"resolved_by":{"id":1,"name":"张三"},"resolved_at":"2026-05-11T04:16:00Z"}

# 设备状态变更
data: {"type":"equipment_status","equipment_id":"C-101","status":"critical","previous_status":"alarm","updated_at":"2026-05-11T04:15:30Z"}

# 工单状态变更
data: {"type":"work_order_updated","work_order_id":42,"state":"approved","equipment_id":"C-101"}

# 心跳（每 30s）
data: {"type":"heartbeat","ts":"2026-05-11T04:16:00Z","station_id":1}
```

---

## 八、MCP 工具接口（AI Agent 专用）

> **认证**：Service Token  
> **协议**：MCP StreamableHTTP（POST /mcp + GET /mcp）

### 工具：get_equipment_context

```json
// 请求（MCP 工具调用格式）
{
  "method": "tools/call",
  "params": {
    "name": "get_equipment_context",
    "arguments": { "equipment_id": "C-101" }
  }
}

// 响应
{
  "content": [{
    "type": "text",
    "text": "{\"equipment_id\":\"C-101\",\"name\":\"1#输油泵\",\"status\":\"alarm\",\"readings\":{...},\"active_alarms\":[...],\"decision_package\":{...}}"
  }]
}
```

### 工具：create_work_order

```json
// 请求
{
  "method": "tools/call",
  "params": {
    "name": "create_work_order",
    "arguments": {
      "equipment_id": "C-101",
      "title": "紧急检查轴承",
      "work_type": "inspection",
      "priority": "urgent",
      "description": "振动超限，建议立即检查",
      "caller_user_id": 1
    }
  }
}

// 响应
{
  "content": [{ "type": "text", "text": "{\"work_order_id\":43,\"state\":\"draft\",\"url\":\"/workorders/43\"}" }]
}
```

---

## 九、飞书卡片回调

### POST /v1/feishu/events

> **仅处理** `card.action.trigger`（工单审批卡片按钮点击）

```http
POST /v1/feishu/events
Content-Type: application/json
X-Lark-Request-Timestamp: 1715392000
X-Lark-Request-Nonce: abc123
X-Lark-Signature: t=1715392000,v1=xxx

{
  "schema": "2.0",
  "header": {
    "event_type": "card.action.trigger",
    "token": "verify_token_xxx"
  },
  "event": {
    "operator": { "open_id": "ou_xxx", "union_id": "on_xxx" },
    "action": {
      "value": { "action": "approve", "work_order_id": "42" },
      "tag": "button"
    }
  }
}
```

**成功（200）：**

```json
{ "toast": { "type": "success", "content": "审批已提交" } }
```

**⚠️ 如果收到 `im.message.receive_v1`，直接返回 200 并记录警告日志（不处理）：**

```json
{ "code": 0 }
```

---

## 十、Context API（OA/ERP 集成）

### GET /v1/ctx/equipment/{id}

```http
GET /v1/ctx/equipment/C-101
Authorization: Bearer <oa-service-token>
```

**成功（200）：**

```json
{
  "data": {
    "equipment_id": "C-101",
    "name": "1# 输油泵",
    "current_status": "alarm",
    "ai_summary": "振动值持续上升，预计 45 分钟内触发停机阈值",
    "recommended_action": "安排轴承检查",
    "confidence": 0.87,
    "active_issues": 2,
    "open_work_orders": 1,
    "generated_at": "2026-05-11T04:10:00Z"
  }
}
```

---

## 十一、Admin 接口

### GET /v1/admin/health/detail

```http
GET /v1/admin/health/detail
Authorization: Bearer <sys_admin-jwt>
```

**成功（200）：**

```json
{
  "data": {
    "overall": "degraded",
    "components": {
      "postgresql": {
        "status": "ok",
        "response_ms": 2,
        "connections": { "active": 12, "max": 100 }
      },
      "redis": {
        "status": "ok",
        "response_ms": 1,
        "memory_used_mb": 234,
        "memory_max_mb": 8192
      },
      "kafka": {
        "status": "ok",
        "consumer_groups": [
          { "group": "pulse-engine", "lag": 0 },
          { "group": "ai-job-worker", "lag": 3 }
        ]
      },
      "milvus": {
        "status": "ok",
        "collections": 1,
        "total_vectors": 16241
      },
      "opcua_bridge": {
        "status": "ok",
        "last_heartbeat_ago_seconds": 12,
        "connected_tags": 156
      },
      "gpu_server": {
        "status": "degraded",
        "response_ms": 8200,
        "p99_latency_ms": 8200,
        "message": "响应较慢，建议检查显存使用"
      }
    },
    "checked_at": "2026-05-11T04:15:00Z"
  }
}
```

---

## 十二、生产数据接口

> 角色权限：`operator`、`supervisor`、`engineer`（录入需 operator+）

### GET /v1/production/records

```http
GET /v1/production/records?station_id=1&date_from=2026-05-01&date_to=2026-05-11
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 42,
        "station_id": 1,
        "record_date": "2026-05-11",
        "shift_type": "daily",
        "gas_volume_m3": 21.36,
        "throughput_m3": 21.36,
        "runtime_hours": 23.5,
        "energy_kwh": 4820.0,
        "outage_minutes": 30,
        "outage_reason": "计划切换备用压缩机",
        "created_by_name": "张操作员",
        "created_at": "2026-05-11T16:30:00Z"
      }
    ],
    "total": 11,
    "page": 1,
    "page_size": 20
  }
}
```

### POST /v1/production/records

**创建或更新生产日报**（同一 station+date+shift_type 幂等更新）

```http
POST /v1/production/records
Authorization: Bearer <token>
Content-Type: application/json

{
  "station_id": 1,
  "record_date": "2026-05-11",
  "shift_type": "daily",
  "gas_volume_m3": 21.36,
  "throughput_m3": 21.36,
  "runtime_hours": 23.5,
  "energy_kwh": 4820.0,
  "outage_minutes": 30,
  "outage_reason": "计划切换备用压缩机"
}
```

> **铁律**：`outage_minutes > 60` 时 `outage_reason` 必填，否则返回 `VALIDATION_ERROR`

**响应 200**

```json
{
  "ok": true,
  "data": { "id": 42, "record_date": "2026-05-11", "updated_at": "2026-05-11T16:35:00Z" }
}
```

### GET /v1/production/summary

```http
GET /v1/production/summary?station_id=1&period=month&year=2026&month=5
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "period": "2026-05",
    "total_gas_volume_m3": 234.5,
    "total_throughput_m3": 234.5,
    "availability_pct": 96.7,
    "total_outage_minutes": 480,
    "total_energy_kwh": 53020.0,
    "energy_per_unit": 226.1,
    "days_recorded": 11
  }
}
```

### GET /v1/production/kpi

```http
GET /v1/production/kpi?station_id=1
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "mtd": { "availability_pct": 96.7, "throughput_completion_pct": 103.2, "outage_events": 3 },
    "today": { "availability_pct": 97.9, "throughput_m3": 21.36, "runtime_hours": 23.5 },
    "benchmarks": { "availability_target_pct": 95.0 }
  }
}
```

---

## 十三、班次管理接口

> 班次状态：`active` → `pending_handover` → `completed`  
> **铁律**：只有 `handover_to_id` 指定的接班人本人才能调用 `/confirm`

### GET /v1/shifts/current

```http
GET /v1/shifts/current?station_id=1
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "id": 88,
    "shift_date": "2026-05-11",
    "shift_type": "morning",
    "start_time": "2026-05-11T00:00:00Z",
    "on_duty_operator_name": "张操作员",
    "status": "active",
    "active_work_order_ids": [23, 24],
    "key_events": [
      {
        "time": "2026-05-11T02:30:00Z",
        "type": "alarm",
        "description": "C-101 振动告警 P2，已确认"
      }
    ]
  }
}
```

### POST /v1/shifts/

**开始新班次**

```json
{ "station_id": 1, "shift_type": "morning", "shift_date": "2026-05-11" }
```

**响应** `{ "ok": true, "data": { "id": 89, "status": "active" } }`

### POST /v1/shifts/{shift_id}/handover

**发起交接（AI 生成摘要，飞书通知接班人）**

```json
{ "handover_to_id": 7, "notes": "注意 C-101 振动趋势" }
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "shift_id": 88,
    "status": "pending_handover",
    "handover_summary": "本班（05-11 早班）运行基本正常。P2 告警 1 次（C-101 振动，已确认）。在途工单 2 张。建议下班次持续关注 C-101 振动。",
    "outstanding_issues": [
      { "type": "work_order", "id": 24, "title": "C-101 轴承检查", "state": "pending_approval" }
    ],
    "feishu_notified": true
  }
}
```

### POST /v1/shifts/{shift_id}/confirm

**接班人签收**

```http
POST /v1/shifts/88/confirm
Authorization: Bearer <token>
```

**响应 200** `{ "ok": true, "data": { "status": "completed", "confirmed_at": "..." } }`

**无权确认时** `{ "ok": false, "error": { "code": "FORBIDDEN", "message": "只有指定接班人才能确认" } }`

### GET /v1/shifts

```http
GET /v1/shifts?station_id=1&date=2026-05-11
Authorization: Bearer <token>
```

返回当日所有班次记录（多个 shift_type）。

---

## 十四、巡检管理接口

### GET /v1/inspection/schedules

```http
GET /v1/inspection/schedules?station_id=1&is_active=true
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 3,
        "name": "每日早班例行巡检",
        "frequency": "daily",
        "route": "泵房 A → 压缩机组 → 计量间 → 分离器区",
        "checklist": [
          { "item": "泵体温度目视检查", "required": true, "method": "手持测温仪" },
          { "item": "压缩机机油液位", "required": true, "method": "目视油位计" },
          { "item": "计量间表头读数记录", "required": true, "method": "拍照存档" }
        ],
        "assignee_role": "operator",
        "next_due_at": "2026-05-12T00:00:00Z",
        "last_done_at": "2026-05-11T01:30:00Z"
      }
    ]
  }
}
```

### POST /v1/inspection/schedules/{schedule_id}/trigger

**触发创建巡检工单**

```json
{ "assignee_id": 5, "due_at": "2026-05-11T06:00:00Z" }
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "work_order_id": 31,
    "work_type": "inspection",
    "title": "每日早班例行巡检（2026-05-11）",
    "state": "approved",
    "checklist_items": [{ "item": "泵体温度目视检查", "required": true, "method": "手持测温仪" }]
  }
}
```

### GET /v1/inspection/overdue

```http
GET /v1/inspection/overdue?station_id=1
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "overdue_schedules": [
      {
        "schedule_id": 5,
        "name": "每周压缩机润滑检查",
        "next_due_at": "2026-05-10T00:00:00Z",
        "overdue_hours": 26.5
      }
    ],
    "total": 1
  }
}
```

---

## 十五、告警 KPI 接口（ISA-18.2）

### GET /v1/alarms/kpi

> ISA-18.2 目标：告警率 < 1/10min、持续告警 = 0、P1 响应率 100%

```http
GET /v1/alarms/kpi?station_id=1&period=24h
Authorization: Bearer <token>
```

**`period`**：`1h` | `8h` | `24h` | `7d` | `30d`

**响应 200**

```json
{
  "ok": true,
  "data": {
    "station_id": 1,
    "period": "24h",
    "alarm_rate_per_10min": 0.23,
    "isa_threshold": 1.0,
    "isa_compliant": true,
    "standing_alarms": 0,
    "chattering_alarms": 1,
    "unacknowledged_count": 2,
    "shelved_count": 1,
    "total_alarms": 33,
    "by_priority": {
      "P1": { "count": 1, "avg_response_minutes": 4.2 },
      "P2": { "count": 8, "avg_response_minutes": 18.7 },
      "P3": { "count": 19, "avg_response_minutes": null },
      "P4": { "count": 5, "avg_response_minutes": null }
    },
    "p1_response_compliance_pct": 100.0,
    "p2_response_compliance_pct": 87.5
  }
}
```

### POST /v1/alarms/{alarm_id}/shelve（补充 reason 字段）

> 搁置必须填写原因（ISA-18.2 合规要求，可审计）

```json
{
  "duration_minutes": 60,
  "reason": "当前计划检修，读数偏高属预期，检修完成后恢复"
}
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "alarm_id": 156,
    "status": "shelved",
    "shelved_until": "2026-05-11T13:30:00Z",
    "shelved_reason": "当前计划检修，读数偏高属预期，检修完成后恢复"
  }
}
```

---

## 附录：常用 curl 示例

```bash
# 1. 登录获取 Token
TOKEN=$(curl -s -X POST http://localhost:8000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@1234"}' | jq -r .data.access_token)

# 2. 查看设备列表（场站1）
curl -s "http://localhost:8000/v1/equipment?station_id=1" \
  -H "Authorization: Bearer $TOKEN" | jq .

# 3. 获取决策包（应 < 10ms）
curl -s "http://localhost:8000/v1/equipment/C-101/decision-package" \
  -H "Authorization: Bearer $TOKEN" | jq .data.snapshot.active_alarms

# 4. 触发 AI 诊断
JOB=$(curl -s -X POST http://localhost:8000/v1/ai/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"job_type":"diagnose","equipment_id":"C-101"}' | jq -r .data.job_id)

# 5. 监听 AI 任务进度（SSE）
curl -s "http://localhost:8000/v1/sse/ai-jobs/$JOB" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: text/event-stream'

# 6. 创建工单
curl -s -X POST http://localhost:8000/v1/workorders/ \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "equipment_id": "C-101",
    "title": "紧急检查轴承",
    "work_type": "inspection",
    "priority": "urgent",
    "description": "振动超限"
  }' | jq .data.id

# 7. 健康检查
curl -s "http://localhost:8000/v1/admin/health/detail" \
  -H "Authorization: Bearer $TOKEN" | jq .data.overall

# 8. 测试 MCP Server（列出可用工具）
curl -s -X POST http://localhost:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ct-svc-openclaw-xxx' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .result.tools[].name
```
