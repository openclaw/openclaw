# ClawTwin 设计终态锁定 (DESIGN-FINAL-LOCK)

> **状态：LOCKED · 2026-05-14（v1.5，§十六 **M4** `conflict_resolver` 脚手架）**
> **用途：消除所有文档冲突的唯一权威来源。开发时凡与本文档冲突，以本文档为准。**
> **审计依据：全量文档扫描 + 源码核实**
> **运行代码与联调 cwd（非 API 路径）：** **`DEV-QUICKSTART.md` §〇** · **`clawtwin-platform/platform-api/README.md`** · **`NEXUS-API-REFERENCE.md`** 文首 · **`TESTING-GUIDE.md` §二.0**

---

## ⚠️ 已废弃文档（不得用于开发参考）

以下文档包含**已废弃的 API 路径设计**，仅保留作历史存档：

| 文档                                | 废弃原因                                                  | 替代文档                     |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------- |
| `CLAWTWIN-MASTER-V2.md`             | `/v1/objects/*` 和 `/v1/tools/*` 旧路径；Phase 分配已调整 | `MODULE-DESIGN-PLATFORM.md`  |
| `ADR-2-PLATFORM-BOUNDARY.md`        | 同上，旧工具路径体系                                      | `ADR-8-AGENT-INTEGRATION.md` |
| `PRODUCT-PLAN-V2.md`                | 旧路径 `/v1/objects/equipment`, `/v1/tools/kb/search`     | `PARALLEL-DEV-TASKSPEC.md`   |
| `ARCHITECTURE-UPGRADE-V2.md §API表` | `PUT /v1/tools/ai-jobs/{id}/result` 路径已废弃            | 本文档 §3                    |

**上述文档中的架构思想仍有参考价值，但任何 URL/路径定义以本文档为准。**

---

## 一、Nexus Platform API 权威路径表（终态）

### 1.1 设备与实时数据（Equipment）

```
GET  /v1/equipment                          设备列表（?station_id=&status=&page=&size=）
GET  /v1/equipment/{id}                     设备详情（含 OT 实时数据快照）
GET  /v1/equipment/{id}/readings            历史时序数据（?metric=&from=&to=）
GET  /v1/equipment/{id}/decision-package    决策包（**on-read** 组装：读数/阈值/因果图 + CBR 摘要等；**可选** 未来 Redis 缓存 — 当前实现见 ``equipment.py``，勿假设 <10ms SLA）
```

> ❌ 废弃: `/v1/objects/equipment/{id}`（旧路径，勿用）

### 1.2 告警（Alarms）

```
GET  /v1/alarms                             告警列表（?station_id=&priority=&status=&limit=）
GET  /v1/alarms/{id}                        告警详情
POST /v1/alarms/{id}/acknowledge            确认告警
POST /v1/alarms/{id}/resolve               关闭告警
POST /v1/alarms/{id}/shelve                搁置告警（须原因；ISA-18.2 shelved）
```

### 1.3 工单（Work Orders）

```
GET  /v1/workorders                         工单列表（?station_id=&equipment_id=&state=&limit=）
POST /v1/workorders/ai-draft               AI 预填草稿内容（不创建工单，返回预填字段）
POST /v1/workorders/                       创建工单（服务端强制 state="draft"，字段名 state）
GET  /v1/workorders/{id}                   工单详情
PATCH /v1/workorders/{id}                  编辑工单（仅 draft 状态可编辑）
```

**HITL 状态机端点（角色限制，见铁律 5）：**

```
POST /v1/hitl/workorders/{id}/pending      提交审批（draft → pending_approval）
POST /v1/hitl/workorders/{id}/approve      主管审批通过（pending_approval → approved）
POST /v1/hitl/workorders/{id}/reject       主管驳回（pending_approval → draft）
POST /v1/hitl/workorders/{id}/start        开始执行（approved → in_progress）
POST /v1/hitl/workorders/{id}/done         完成（in_progress → done，上传证据）
POST /v1/hitl/workorders/{id}/oa-callback  OA/BPM 回调（需 OA ServiceToken）
```

> ❌ 废弃: `/v1/tools/workorder/draft`, `/v1/tools/workorder/create`（旧路径）

### 1.4 知识库（Knowledge Base）

```
GET  /v1/kb/documents                      文档列表（?station_id=&layer=&page=&limit=；条目含 **revision**）
POST /v1/kb/documents                      上传文档（multipart/form-data）
GET  /v1/kb/documents/{id}                 文档详情（含 **revision**）
DELETE /v1/kb/documents/{id}               删除文档（admin）
PATCH /v1/kb/documents/{id}               部分更新（成功后 **revision** 自增）
GET  /v1/kb/search?q=&equipment_type=&layer=&limit=  检索（Phase A：子串命中 + matched_snippet；目标语义/pgvector 见 SKILL 铁律 20）
```

> ❌ 废弃: `/v1/tools/kb/search`（旧路径）

### 1.5 AI 任务（AI Jobs）

```
POST /v1/ai/jobs                           提交 AI 任务（Studio 触发诊断/分析）
GET  /v1/ai/jobs/{job_id}                  查询 AI 任务状态和结果
DELETE /v1/ai/jobs/{job_id}               取消 AI 任务
POST /v1/ai/jobs/{job_id}/result          AI Agent 回写结果（需 ServiceToken）
```

> ❌ 废弃: `PUT /v1/tools/ai-jobs/{job_id}/result`（ARCHITECTURE-UPGRADE-V2 旧设计）

### 1.6 实时推送（SSE）

**两个 SSE 端点，职责明确：**

```
GET  /v1/sse/station/{station_id}          场站综合 SSE 流（设备读数+健康+告警）
GET  /v1/sse/ai-jobs/{job_id}             AI 任务进度流（Studio AI 诊断结果流式输出）
```

> ❌ 废弃: `/v1/sse/equipment/{id}`（合并进场站流）
> ❌ 废弃: `/v1/sse/station/{id}/alarms`（合并进场站流）

**SSE 事件格式：**

```typescript
// /v1/sse/station/{id} 发送的事件类型
type StationSSEEvent =
  | { type: "equipment_reading"; equipment_id: string; readings: Record<string, number> }
  | { type: "alarm_created"; alarm: AlarmSummary }
  | { type: "alarm_resolved"; alarm_id: string }
  | { type: "equipment_status"; equipment_id: string; status: EquipmentStatus }
  | { type: "heartbeat"; ts: string };

// /v1/sse/ai-jobs/{id} 发送的事件类型
type AIJobSSEEvent =
  | { type: "progress"; percent: number; message: string }
  | { type: "chunk"; content: string } // 流式 AI 输出
  | { type: "completed"; result: AIJobResult; citations: Citation[] }
  | { type: "failed"; error: string };
```

### 1.7 MCP 工具服务器

```
GET/POST /v1/mcp                          MCP over HTTP（应用统一挂 `/v1` 前缀）
GET/POST /mcp                             兼容别名（与 `/v1/mcp` 同处理器；便于旧文档/curl）
```

**目标传输**：Streamable HTTP 会话与流式 `tools/call`（见 `ARCHITECTURE-PROTOCOL-ANALYSIS.md`）。

**Phase A 现状**：JSON 发现 + JSON-RPC 形桩（`tools/list` 等）；**非**完整 StreamableHTTP；`tools/call` 仍返回 stub 错误，真工具走 HTTP Tool API。

→ AI Agent Runtime 通过此端点做发现/联调；**认证**：Service Token（Bearer）（与路由门控一致处启用）。

**MCP 暴露的工具列表（权威）：**

**A) 本体/业务工具（动态加载自 ontology ActionType + FunctionType，经 ActionExecutor / FunctionExecutor）：**

```
get_equipment_context(equipment_id)        → 设备完整上下文（含决策包）
get_station_overview(station_id)           → 场站概览（所有设备状态）
search_knowledge_base(query, layer?)       → 知识库语义搜索
create_work_order(equipment_id, ...)       → 创建工单（返回 work_order_id）
get_active_alarms(station_id)              → 活跃告警列表
get_equipment_readings(equipment_id, ...)  → 历史时序数据
get_work_order(work_order_id)              → 工单详情
list_equipment(station_id)                 → 设备列表
```

**B) 平台只读运营查询（硬编码；Phase A 起 ≥3，Phase B / M3 扩展至下列 5 个）：**

```
list_pending_hitl()                        → 待人工审批 Playbook 列表与上下文摘要
get_alarm_summary(station_id?)             → 活跃告警按优先级统计
get_station_health(station_id)             → 单站场健康概览
get_flywheel_summary(period?, station_id?)→ 与 GET /v1/reports/outcomes 一致的飞轮聚合（M3）
get_kb_document(document_id, include_chunks?) → 读 KB 文档元数据与 chunk（M3 飞轮审核）
```

### 1.8 Context API（OA/ERP 集成）

```
GET  /v1/ctx/equipment/{id}               设备上下文快照（供 OA 系统嵌入）
GET  /v1/ctx/workorder/{wo_id}            工单上下文快照（供 OA 审批附件）
GET  /v1/ctx/station/{id}/summary         场站运行摘要（供 ERP 报表）
```

**Phase A**：三个端点均已挂载（`ctx_api.py`）。响应带 `schema_version` / `kind`；**设备** 为详情 + decision-package 桩；**工单** 与 `GET /v1/workorders/{id}` 同源数据；**场站摘要** 含 mock catalog 行 + **aggregates** 占位（待 Pulse/SQL 汇总）。

### 1.8a 可选能力发现（Law 5）

```
GET /v1/capabilities                      只读：当前进程启用的可选能力集合（ingest/export/playbook/recommendations/outcome_tracking 等）；UI 与集成方依此隐藏未挂载路由
```

> 未列出项视为常驻能力（alarm/workorder/equipment…）。实现见 `apps/http/main.py` + `infra/capabilities.py`。

### 1.9 飞书 Webhook

```
POST /v1/feishu/events                    飞书事件回调（challenge；card.action.trigger 桩；审计可选）
```

> `im.message.receive_v1` **显式忽略**（返回 ignored，对话走 OpenClaw，不经过平台推理链）。其它 `event_type` 或返回 `unhandled_event_type` / 占位 ack，以运行时代码为准。

### 1.10 Webhook 订阅（外部系统订阅推送）

```
POST /v1/webhooks/subscriptions           注册 Webhook（外部系统订阅告警/工单事件；支持 Idempotency-Key）
GET  /v1/webhooks/subscriptions           列出已注册的 Webhook
DELETE /v1/webhooks/subscriptions/{id}    删除 Webhook
POST /v1/webhooks/dispatch                占位分发（Phase A 202；无真实出站 HTTP）
```

**连接器（`platform-api/apps/http/routes/connectors.py`）：**

- **声明式目录（Phase A，YAML/元数据）**：`GET /v1/connectors`、`POST /v1/connectors/{connector_id}/dry-run`、`POST /v1/connectors/{connector_id}/probe`
- **M4 出站 REST（脚手架）**：`POST /v1/connectors/{connector_id}/invoke` — 读取包内 `rest_profile` / `rest_operations`（仅 **GET/HEAD**）；需 `CLAWTWIN_REST_CONNECTOR_INVOKE=1`、**sys_admin**（`CLAWTWIN_AUTH_DEV` 关闭时）。实现见 `infra/rest_connector.py`。**SSRF 风险** — 仅受信 YAML + 网络策略下启用。
- **运行时快照（Phase B / M2）**：`GET /v1/connectors/runtime` — 进程内 **OPC-UA / Modbus** 等采集器 enabled/running 状态（非 IMS YAML；切环境变量+重启生效）

**CMMS / EAM 入站（Phase B / M2）**：`POST /v1/integrations/cmms/failures` — Header `X-ClawTwin-CMMS-Token` 匹配 `CLAWTWIN_CMMS_WEBHOOK_SECRET`；写入 `alarms` 并派发 `alarm.created`（见 `cmms_webhook.py`）。

**M4 工单关单 → ERP（可选，脚手架）**：环境变量 `CLAWTWIN_ERP_WORKORDER_WEBHOOK_URL` / `CLAWTWIN_ERP_WORKORDER_WEBHOOK_SECRET`；HITL **in_progress → done** 时派发 `workorder.completed`，载荷合并工单公开字段（**`title` / `equipment_id` / 时间戳** 等，不含 `baseline_snapshot`）。`infra/event_dispatcher.py` 经 `try_enqueue_erp_workorder_webhook` 写入 `outbox_events`（`target_kind=erp_workorder`），`workers/outbox_dispatcher` 调用 `post_erp_workorder_webhook` 异步 POST（退避重试）。**另**：通过 `/v1/webhooks/subscriptions` 订阅 `workorder.completed` 的订阅方仍走 **webhook outbox** 投递，与 ERP 环境变量路径可并存。

**M4 ERP → ClawTwin 回写（可选，脚手架）**：`CLAWTWIN_ERP_CALLBACK_SECRET`；**`POST /v1/integrations/erp/workorders/{workorder_id}/transition`**，JSON body **`action`**（与 `workorder_fsm` / HITL 一致，如 `approve` / `start` / `complete`），头 **`X-ClawTwin-ERP-Callback-Token`**；可选 **`Idempotency-Key`** / **`X-Idempotency-Key`** — 成功体在进程内按 **`(workorder_id, key, action, erp_reference)`** 指纹缓存（`infra/integration_idempotency.py`），重放返回 **`idempotent_replay`** 而不重复派生事件。成功时与 HITL 相同派发平台事件。实现：**`apps/http/routes/erp_workorder_callback.py`**。

**M4 物料 / 备料申请出站（可选，脚手架）**：`CLAWTWIN_ERP_MATERIAL_WEBHOOK_URL` / `CLAWTWIN_ERP_MATERIAL_WEBHOOK_SECRET`；**`POST /v1/integrations/erp/material-requests`**（body：`workorder_id`、`station_id`、`lines[]`、可选 `pm_reference`），需 **sys_admin**（与 BI 探测一致）；事件 **`clawtwin.integration.material_request`**。默认 **Outbox**（`target_kind=erp_material`，`event_type=material.request`，`CLAWTWIN_ERP_MATERIAL_OUTBOX` 非 0）；**`CLAWTWIN_ERP_MATERIAL_OUTBOX=0`** 则同步 HTTP（**200**）。实现：**`apps/http/routes/erp_material_requests.py`**、**`infra/erp_material_webhook.py`**、**`workers/outbox_dispatcher._deliver_erp_material`**。

**M4 MES 生产指令下达（可选，脚手架）**：`CLAWTWIN_MES_PRODUCTION_WEBHOOK_URL` / `CLAWTWIN_MES_PRODUCTION_WEBHOOK_SECRET`（HMAC 头 **`X-ClawTwin-MES-Signature`**）；**`POST /v1/integrations/mes/production-dispatch`**（body：`station_id`、可选 `workorder_id` / `production_order_ref` / `recipe_or_routing_id` / `quantity` / `uom` / `priority` / `notes`），需 **sys_admin**（与物料出站一致）；事件 **`clawtwin.integration.mes_production_dispatch`**。默认 **Outbox**（`target_kind=mes_production`，`event_type=mes.production_dispatch`，`CLAWTWIN_MES_PRODUCTION_OUTBOX` 非 0）；**`CLAWTWIN_MES_PRODUCTION_OUTBOX=0`** 则同步 HTTP（**200**）。实现：**`apps/http/routes/mes_production_dispatch.py`**、**`infra/mes_production_webhook.py`**（含 **`mes_production_dispatch_core`** 供 HTTP 与 Action 共用）、**`workers/outbox_dispatcher._deliver_mes_production`**。**Ontology ActionType** **`mes_production_dispatch`**（`ontology/action_types/mes_production_dispatch.yaml`）供 Playbook **`action_api_name: mes_production_dispatch`** 调用（与 HTTP 同载荷；Action 路径不设 JWT **sys_admin**，由 Playbook HITL / 编排信任域约束）。**示例 Playbook**：**`ontology/playbooks/dispatch_mes_on_workorder_created.yaml`**（**`workorder.created`** 且含 **`source_alarm_id`** 时下达；可与 **`diagnose_on_alarm`** 链式衔接）。

**M4 BI 出站探测（脚手架）**：`POST /v1/integrations/bi/ping` — 需 **sys_admin**（`CLAWTWIN_AUTH_DEV=1` 时放行演示用户）；环境变量 `CLAWTWIN_BI_WEBHOOK_URL` / `CLAWTWIN_BI_WEBHOOK_SECRET`（HMAC 头 `X-ClawTwin-BI-Signature`）；实现见 `platform-api/infra/bi_webhook.py`、`platform-api/apps/http/routes/bi_integration.py`。**`POST /v1/integrations/bi/outcomes`** — 复用 **`GET /v1/reports/outcomes`** 聚合，投递事件 `clawtwin.bi.outcomes_snapshot`（需 **outcome_tracking** 能力）。**定时推送**：`CLAWTWIN_BI_OUTCOMES_PUSH_INTERVAL_SECONDS` + `workers/scheduler.py` 内 **`schedule_bi_outcomes_push`**（需 `CLAWTWIN_BI_PUSH_STATION_ID` 或 `CLAWTWIN_BI_PUSH_GLOBAL=1`；全站聚合须显式开启后者）。**OutcomeEvent 驱动推送（可选）**：`CLAWTWIN_BI_PUSH_ON_OUTCOME_EVENT` + `infra/bi_outcomes_snapshot_push.py`（新建/人工标注后按 **该条 station_id** 推送聚合；若配置 `CLAWTWIN_BI_PUSH_STATION_ID` 则仅匹配场站才出站）。

### 1.11 认证与用户

```
POST /v1/auth/login                       登录（返回 JWT）
POST /v1/auth/refresh                     刷新 JWT
POST /v1/auth/logout                      登出
GET  /v1/auth/me                          当前用户信息
```

**Phase A**：**login** 仅在 `CLAWTWIN_AUTH_DEV=1` 时可用：签发 **HS256** JWT（须配置 `CLAWTWIN_JWT_SECRET`）；请求体 `username`/`password` 中 **password 忽略**。非 dev 环境 **501**（`AUTH_LOGIN_NOT_IMPLEMENTED`），待接入真实 IdP。**refresh** → **501**。**logout** → **204**（无状态 JWT，客户端丢弃 token）。**me** → `get_current_user_dev` 解析后的主体。

### 1.11.5 审计导出（M4 脚手架）

```
GET  /v1/audit                            导出持久化审计（``audit_logs``；需 ``CLAWTWIN_AUDIT_DB=1``）
```

查询参数：`from` / `to`（ISO-8601，作用于 `ts`）、`station_id`、`event_type_prefix`、`limit`、`format=json|csv`。JWT 场站范围与 `require_station_access` 一致（`CLAWTWIN_AUTH_DEV=1` 时放宽）。实现：`platform-api/apps/http/routes/audit_export.py`。

### 1.11.6 可靠性与 Outbox / Doctor（常驻观测）

```
GET  /v1/outbox/stats                     Outbox 队列统计（pending / delivering / failed_permanent / 最老 pending 年龄）
GET  /v1/health/dimensions                各维度健康快照（**outbox** 维度 metadata 含按 ``target_kind`` 拆分）
GET  /v1/doctor/checks                   列出已注册 Doctor 检查
POST /v1/doctor/run                     执行 Doctor 自检（``category=reliability`` 含 **``erp_workorder.outbox``** 等）
```

**M4 补充**：`GET /v1/outbox/stats` 在全局计数外返回 **`pending_by_target_kind`**、**`failed_permanent_by_target_kind`**，用于区分 **`erp_workorder`**（ERP 出站）与 **`webhook`** / **`channel`**（订阅 Webhook、飞书）积压。统计实现为 ORM，**SQLite 与 Postgres 共用**。路由：`platform-api/apps/http/routes/doctor.py`；逻辑：`infra/outbox/__init__.py`（`get_pending_stats`）。

### 1.12 Admin API（sys_admin 专用）

```
GET  /v1/admin/users                      用户列表
POST /v1/admin/users                      创建用户
PATCH /v1/admin/users/{id}               编辑用户
DELETE /v1/admin/users/{id}              删除用户
POST /v1/admin/users/{id}/stations       分配场站权限

GET  /v1/admin/stations                   场站列表
POST /v1/admin/stations                   创建场站
PATCH /v1/admin/stations/{id}            编辑场站配置

GET  /v1/admin/health                     系统健康状态（所有组件）
GET  /v1/admin/health/detail             详细健康报告（用于 clawtwin doctor）
GET  /v1/admin/metrics                    系统指标（DB/Kafka/**pgvector** 等；与 SKILL 铁律 10/20 一致，**无**独立 Milvus）
GET  /v1/admin/audit-logs                【规划】审计检索（替代：M4 已落地 **``GET /v1/audit``** §1.11.5）

POST /v1/admin/kb/seed                   触发知识库种子内容导入
POST /v1/admin/cache/invalidate          清除 Redis 缓存（?scope=decision_package|all）
```

---

## 二、数据库表名权威列表

### Phase A 表（必须）

| 表名                       | 说明                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `stations`                 | 场站                                                                                    |
| `users`                    | 用户                                                                                    |
| `user_station_assignments` | 用户-场站权限关联表                                                                     |
| `equipment_types`          | 设备类型本体                                                                            |
| `equipment_type_metrics`   | 设备类型指标定义                                                                        |
| `equipment_type_actions`   | 设备类型可执行动作定义                                                                  |
| `equipment`                | 设备实例（status 枚举见下方）                                                           |
| `equipment_readings`       | 设备时序读数（TimescaleDB hypertable）                                                  |
| `alarm_rules`              | 告警规则                                                                                |
| `alarms`                   | 告警实例（ISA-18.2 完整字段见下方）                                                     |
| `work_orders`              | 工单（state 字段 + work_type 枚举见下方）                                               |
| `work_order_evidence`      | 完工证据（图片/报告）                                                                   |
| `kb_documents`             | 知识库文档元数据（**`revision`**：单调递增版本号，PATCH 成功后 +1；迁移 **016**）       |
| `kb_chunks`                | 文档切片（**pgvector** 存嵌入；与 SKILL 铁律 20、精简栈一致；**非** Milvus collection） |
| `ai_jobs`                  | AI 异步任务队列                                                                         |
| `audit_logs`               | 审计日志（只写不改）                                                                    |
| `webhook_subscriptions`    | 外部 Webhook 注册                                                                       |
| `production_records`       | **【新增】** 生产日报（日产量）                                                         |
| `shift_records`            | **【新增】** 班次记录（交接班）                                                         |
| `inspection_schedules`     | **【新增】** 巡检计划                                                                   |

### Phase B 表（预规划）

| 表名             | 说明              |
| ---------------- | ----------------- |
| `pm_schedules`   | 预防性维护计划    |
| `work_permits`   | 作业许可证（PTW） |
| `spare_parts`    | 备件台账          |
| `energy_records` | 能耗记录          |
| `hse_incidents`  | HSE 事件记录      |

---

## 二a、关键枚举权威定义

### 设备状态（EquipmentStatus）—— 终态

```python
class EquipmentStatus(str, Enum):
    RUNNING      = "running"       # 运行中（正常）
    STANDBY      = "standby"       # 备用（冷备/热备）
    WARN         = "warn"          # 告警（达到警告阈值）
    ALARM        = "alarm"         # 告警（达到告警阈值，需处理）
    FAULT        = "fault"         # 故障停机（已停运，需抢修）
    MAINTENANCE  = "maintenance"   # 检修中（工单关联）
    COMMISSIONED = "commissioned"  # 调试中（新设备）
    OFFLINE      = "offline"       # 停用/退役

# 业务规则：
# - MAINTENANCE 状态设备：P3/P4 告警不触发飞书通知（检修中预期）
# - FAULT 状态设备：自动创建 EMERGENCY 工单（如果没有进行中的工单）
# - status 颜色映射见 Studio tokens.ts
```

> ❌ 废弃 `normal`（旧状态，用 `running` 替代）

### 工单类型（WorkOrderType）—— 终态

```python
class WorkOrderType(str, Enum):
    CORRECTIVE   = "corrective"    # 故障处理（计划外，因告警触发）
    PREVENTIVE   = "preventive"    # 预防性维护（计划内）
    INSPECTION   = "inspection"    # 例行点检/巡检
    SHUTDOWN     = "shutdown"      # 停机大修（需停产）
    EMERGENCY    = "emergency"     # 紧急处置（P1 告警触发）
    CALIBRATION  = "calibration"   # 仪表校准
    IMPROVEMENT  = "improvement"   # 技改优化
```

> ❌ 废弃旧白名单字符串（`vibration_analysis|lubrication|seal_check|filter_replace` 等）  
> 这些细项移入 `work_subtype` 字段（VARCHAR，自由文本）

### 工单 state 枚举（权威）

```
draft → pending_approval → approved → in_progress → done
                         ↘ rejected（→ draft 可重新提交）
```

### 告警 alarms 表完整字段（ISA-18.2 合规）

```python
class Alarm(Base):
    id                  = Column(Integer, primary_key=True)
    equipment_id        = Column(String(50), ForeignKey("equipment.id"))
    station_id          = Column(Integer, ForeignKey("stations.id"))
    rule_id             = Column(String(100))
    priority            = Column(String(5))    # P1 / P2 / P3 / P4
    message             = Column(Text)
    status              = Column(String(20), default="active")  # active|acknowledged|shelved|resolved

    # ISA-18.2 必要字段
    triggered_at        = Column(TIMESTAMPTZ, default=func.now())
    last_triggered_at   = Column(TIMESTAMPTZ, default=func.now())  # 最新触发时间
    standing_since      = Column(TIMESTAMPTZ)    # 持续告警：首次触发时间
    chat_count          = Column(Integer, default=1)  # 闪烁次数

    acknowledged_at     = Column(TIMESTAMPTZ)
    acknowledged_by     = Column(Integer, ForeignKey("users.id"))

    shelved_until       = Column(TIMESTAMPTZ)
    shelved_by          = Column(Integer, ForeignKey("users.id"))
    shelved_reason      = Column(Text)           # 搁置必须填原因（ISA-18.2）

    resolved_at         = Column(TIMESTAMPTZ)
    resolved_by         = Column(Integer, ForeignKey("users.id"))
```

### 工单 work_orders 表完整字段

```python
class WorkOrder(Base):
    id                  = Column(Integer, primary_key=True)
    station_id          = Column(Integer, ForeignKey("stations.id"))
    equipment_id        = Column(String(50), ForeignKey("equipment.id"))

    # 基础字段
    title               = Column(String(300), nullable=False)
    work_type           = Column(String(50), nullable=False)    # WorkOrderType 枚举
    work_subtype        = Column(String(100))                   # 细分类型（自由文本）
    priority            = Column(String(20), default="normal")  # emergency|urgent|normal|low
    state               = Column(String(50), default="draft")   # WorkOrderState 枚举
    description         = Column(Text)

    # 人员
    created_by          = Column(Integer, ForeignKey("users.id"))
    assignee_id         = Column(Integer, ForeignKey("users.id"))
    approved_by         = Column(Integer, ForeignKey("users.id"))

    # 时间
    created_at          = Column(TIMESTAMPTZ, default=func.now())
    due_at              = Column(TIMESTAMPTZ)
    started_at          = Column(TIMESTAMPTZ)
    completed_at        = Column(TIMESTAMPTZ)

    # 关联
    trigger_alarm_id    = Column(Integer, ForeignKey("alarms.id"))
    pm_schedule_id      = Column(Integer)       # 关联 PM 计划（Phase B）
    shift_record_id     = Column(Integer, ForeignKey("shift_records.id"))  # 关联班次

    # 作业许可证（Phase A 预留）
    permit_required     = Column(Boolean, default=False)
    permit_type         = Column(String(50))    # hot_work|cold_work|confined_space
    permit_number       = Column(String(100))
    permit_status       = Column(String(50))    # pending|approved|active|closed

    # 巡检字段（inspection 类型时使用）
    inspection_route    = Column(String(200))
    checklist_items     = Column(JSONB)         # [{item, required, method}]
    checklist_results   = Column(JSONB)         # [{item, result, note}]

    # AI 生成内容
    ai_suggestions      = Column(JSONB)
    ai_citations        = Column(JSONB)

    # OA 集成
    oa_callback_url     = Column(String(500))
    oa_approval_id      = Column(String(200))
```

### 新增 production_records 表

```sql
CREATE TABLE production_records (
    id              SERIAL PRIMARY KEY,
    station_id      INT NOT NULL REFERENCES stations(id),
    record_date     DATE NOT NULL,
    shift_type      VARCHAR(20) DEFAULT 'daily',  -- daily|morning|afternoon|night

    oil_volume_m3   DECIMAL(12,3),   -- 原油（m³）
    gas_volume_m3   DECIMAL(12,3),   -- 天然气（万 m³）
    water_volume_m3 DECIMAL(12,3),   -- 含水（m³）
    throughput_m3   DECIMAL(12,3),   -- 综合输量

    runtime_hours   DECIMAL(5,2),    -- 主设备运行时长
    energy_kwh      DECIMAL(10,2),   -- 耗电量
    outage_minutes  INT DEFAULT 0,   -- 停输时长
    outage_reason   TEXT,

    notes           TEXT,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(station_id, record_date, shift_type)
);
```

### 新增 shift_records 表

```sql
CREATE TABLE shift_records (
    id                   SERIAL PRIMARY KEY,
    station_id           INT NOT NULL REFERENCES stations(id),
    shift_date           DATE NOT NULL,
    shift_type           VARCHAR(20) NOT NULL,  -- morning|afternoon|night
    start_time           TIMESTAMPTZ NOT NULL,
    end_time             TIMESTAMPTZ,

    on_duty_operator_id  INT REFERENCES users(id),
    handover_to_id       INT REFERENCES users(id),

    status               VARCHAR(20) DEFAULT 'active',  -- active|pending_handover|completed
    handover_summary     TEXT,           -- AI 生成的交接摘要
    key_events           JSONB DEFAULT '[]',
    outstanding_issues   JSONB DEFAULT '[]',
    active_work_order_ids JSONB DEFAULT '[]',

    confirmed_at         TIMESTAMPTZ,
    confirmed_by         INT REFERENCES users(id),
    created_at           TIMESTAMPTZ DEFAULT NOW()
);
```

### 新增 inspection_schedules 表

```sql
CREATE TABLE inspection_schedules (
    id              SERIAL PRIMARY KEY,
    station_id      INT NOT NULL REFERENCES stations(id),
    name            VARCHAR(200) NOT NULL,      -- 如"每日早班例行巡检"
    frequency       VARCHAR(50) NOT NULL,       -- daily|weekly|monthly
    route           TEXT,                       -- 巡检路线描述
    checklist       JSONB NOT NULL,             -- 点检项目列表
    assignee_role   VARCHAR(50),               -- operator|technician
    is_active       BOOLEAN DEFAULT TRUE,
    next_due_at     TIMESTAMPTZ,
    last_done_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 二b、Phase A 新增 API（工业场景补全）

### 生产数据

```
GET  /v1/production/records?station_id=&date_from=&date_to=&shift_type=
POST /v1/production/records                                （创建/更新日报）
GET  /v1/production/summary?station_id=&period=month|week  月/周汇总
GET  /v1/production/kpi?station_id=                        关键指标
```

### 班次管理

```
GET  /v1/shifts/current?station_id=               当前活跃班次
POST /v1/shifts/                                  开始新班次
POST /v1/shifts/{id}/handover                     发起交接（AI 生成摘要）
POST /v1/shifts/{id}/confirm                      接班人确认签收
GET  /v1/shifts?station_id=&date=&limit=         班次历史（**limit**：1–500，默认 **100**；超限 **422**）
```

### 巡检管理

```
GET  /v1/inspection/schedules?station_id=&limit= 巡检计划列表（**limit**：1–500，默认 **100**；超限 **422**）
POST /v1/inspection/schedules/{id}/trigger        触发创建巡检工单
GET  /v1/inspection/overdue?station_id=&limit=    逾期巡检列表（**limit**：1–500，默认 **100**；超限 **422**）
```

### 告警 KPI（ISA-18.2）

```
GET  /v1/alarms/kpi?station_id=&period=24h|7d     告警 KPI 指标
  → alarm_rate_per_10min, standing_alarms, chattering_alarms, p1_response_time_avg
```

**工单 state 枚举（权威）：** `draft` → `pending_approval` → `approved` → `in_progress` → `done` / `rejected`

---

## 三、Kafka Topic 权威列表

| Topic                | 生产者               | 消费者                       | 消息格式                                        |
| -------------------- | -------------------- | ---------------------------- | ----------------------------------------------- |
| `ot.telemetry`       | OPC-UA Bridge        | Nexus Pulse Engine           | `{equipment_id, readings: {metric: value}, ts}` |
| `ot.events`          | OPC-UA Bridge        | Nexus Pulse Engine           | `{equipment_id, event_type, severity, ts}`      |
| `platform.alarms`    | Nexus Pulse Engine   | Nexus SSE / Notification Svc | `{alarm_id, equipment_id, priority, ts}`        |
| `platform.workorder` | Nexus Work Order Svc | Notification Svc / KB Svc    | `{wo_id, state, equipment_id, ts}`              |
| `platform.ai-jobs`   | Nexus AI Job Svc     | AI Job Worker                | `{job_id, job_type, context_snapshot, ts}`      |

---

## 四、ServiceToken 权威列表

| Token 名称               | 使用者              | 访问范围                                  |
| ------------------------ | ------------------- | ----------------------------------------- | --------------------- |
| `openclaw-service-token` | OpenClaw AI Runtime | 所有 MCP 工具 + `/v1/ai/jobs/{id}/result` |
| `hermes-service-token`   | Hermes AI Runtime   | 同上（可替代）                            |
| `oa-service-token`       | OA/BPM 系统         | `/v1/hitl/workorders/{id}/approve         | reject` + Context API |
| `bridge-service-token`   | OPC-UA Bridge 内部  | 无（Bridge 直接发 Kafka，不调 Nexus API） |
| `monitoring-token`       | Grafana/Prometheus  | `/v1/admin/metrics`                       |

---

## 五、Phase 分配最终确认（修正 CLAWTWIN-MASTER-V2）

| 功能                    | 旧 Phase | 新 Phase（最终） | 依据                              |
| ----------------------- | -------- | ---------------- | --------------------------------- |
| MCP Server (`/mcp`)     | B        | **A（必须）**    | ARCHITECTURE-PROTOCOL-ANALYSIS.md |
| Kafka 统一事件总线      | A        | A（保持）        | —                                 |
| TimescaleDB 连续聚合    | B        | B（保持）        | 复杂度较高，Phase A 简单聚合即可  |
| Studio 对话面板（追问） | —        | **B**            | Phase A AI Job 为无状态           |
| MOIRAI 时序预测         | B        | B（保持）        | —                                 |
| 多租户 SaaS             | C        | C（保持）        | —                                 |

---

## 六、文档权威级别排序（冲突时以高优先级为准）

```
P0（开发直接依据，不可冲突）：
  本文档 DESIGN-FINAL-LOCK.md
  MODULE-DESIGN-PLATFORM.md（§18 API路由 + §19 ORM + §20扩展）
  DEVELOPMENT-CONTRACT.md（工单FSM + 安全铁律）

P1（功能设计参考，路径遵从 P0）：
  PARALLEL-DEV-TASKSPEC.md（任务分解 + Done标准）
  STUDIO-UI-ARCHITECTURE.md（前端架构）
  MODULE-DESIGN-STUDIO.md（组件设计）

P2（架构思想参考，具体路径遵从 P0）：
  ARCHITECTURE-PROTOCOL-ANALYSIS.md（协议选型理由）
  ARCHITECTURE-FINAL-REVIEW.md（飞书流程纠错）
  MASTER-ARCHITECTURE-AND-DEV-GUIDE.md（整体架构综述）
  NEXUS-FRAMEWORK-ARCHITECTURE.md（框架化路线）

P3（已废弃路径，架构思想仍可参考）：
  CLAWTWIN-MASTER-V2.md
  ADR-2-PLATFORM-BOUNDARY.md
  PRODUCT-PLAN-V2.md
  ARCHITECTURE-UPGRADE-V2.md §API表部分
```

---

## 七、OpenClaw 自管理能力借鉴分析

### 7.1 OpenClaw 的管理能力（参考）

| 能力             | OpenClaw 实现                          | ClawTwin 对应方案                                 |
| ---------------- | -------------------------------------- | ------------------------------------------------- |
| 系统健康检查     | `openclaw doctor` CLI                  | `clawtwin doctor` 脚本（见 §7.3）                 |
| 服务启停         | `openclaw gateway restart/stop`        | Docker Compose (`docker compose up/down/restart`) |
| 状态查看         | `openclaw status`                      | Studio Admin Panel + `GET /v1/admin/health`       |
| 会话/记忆管理    | `openclaw sessions`, `openclaw memory` | Studio KB 管理页 + Admin API                      |
| 配置管理         | `openclaw config`                      | `.env` 文件 + Studio Admin System Page            |
| **自然语言管理** | 通过 Skills 与 AI 对话                 | **AdminSage Skill**（本文档 §7.4）★ 最大借鉴      |
| TUI 界面         | 终端 UI                                | **不实现**（Studio Web Admin 已覆盖）             |
| 升级管理         | npm 包更新                             | Docker image 版本控制                             |

### 7.2 核心借鉴：自然语言运维（最有价值）

OpenClaw 的核心哲学：**"一切皆可通过自然语言完成"**。

这对 ClawTwin 最大价值是：**运维人员可以通过 Feishu 对话管理整个系统**，而不需要登录 Admin Panel。

```
[运维场景 1] 管理员问："知识库里有多少关于离心泵的文档？"
  → AdminSage 调用 GET /v1/kb/documents?q=离心泵
  → 返回："L0层3篇标准（API 610等），L1层17篇手册，L2层8篇SOP"

[运维场景 2] 管理员问："今天有哪些P1级告警被处理了？"
  → AdminSage 调用 GET /v1/alarms?priority=P1&status=resolved&from=today
  → 格式化返回告警处理报告

[运维场景 3] 管理员问："系统各组件运行状态如何？"
  → AdminSage 调用 GET /v1/admin/health/detail
  → 返回："DB正常 ✅ Kafka正常 ✅ pgvector 正常 ✅ OPC-UA Bridge正常 ✅"

[运维场景 4] 管理员说："给张三分配泵站一和二的访问权限"
  → AdminSage 确认 → 调用 PATCH /v1/admin/users/{张三id}/stations
  → 返回操作结果，并写飞书卡片让管理员确认
```

### 7.3 clawtwin doctor 脚本设计

```bash
#!/bin/bash
# scripts/clawtwin-doctor.sh
# 快速健康检查，对应 openclaw doctor 的理念

set -euo pipefail

NEXUS_URL="${NEXUS_URL:-http://localhost:8000}"
GREEN='\033[0;32m' RED='\033[0;31m' YELLOW='\033[1;33m' NC='\033[0m'

echo "🔧 ClawTwin Doctor — 系统健康检查"
echo "=================================="

check() {
  local name="$1" cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo -e "  ${GREEN}✅${NC} $name"
  else
    echo -e "  ${RED}❌${NC} $name (失败)"
    FAILED=true
  fi
}

FAILED=false

echo ""
echo "[ 基础服务 ]"
check "PostgreSQL"    "docker compose exec -T db pg_isready -U nexus"
check "Redis"         "docker compose exec -T redis redis-cli ping"
check "Kafka"         "docker compose exec -T kafka kafka-topics.sh --bootstrap-server localhost:9092 --list"
# 向量栈：Phase A 为 PostgreSQL pgvector（无独立 Milvus；见 SKILL 铁律 10/20）。需在库内 CREATE EXTENSION vector 后方有向量检索。
check "Nexus API"     "curl -sf ${NEXUS_URL}/health"

echo ""
echo "[ Nexus 服务检查 ]"
TOKEN=$(curl -sf -X POST ${NEXUS_URL}/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"'${NEXUS_ADMIN_PASSWORD:-admin}'"}' | jq -r .access_token 2>/dev/null || echo "")

if [ -n "$TOKEN" ]; then
  HEALTH=$(curl -sf ${NEXUS_URL}/v1/admin/health/detail \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo "{}")
  echo "  $(echo $HEALTH | jq -r '.components | to_entries[] | "  \(.key): \(.value.status)"' 2>/dev/null || echo "  无法解析健康详情")"
else
  echo -e "  ${YELLOW}⚠️${NC}  无法登录 Nexus，跳过详细检查"
fi

echo ""
echo "[ OPC-UA Bridge ]"
check "Bridge 进程"   "docker compose ps opcua-bridge | grep -q running"

echo ""
echo "[ MCP Server ]"
check "MCP 端点"      "curl -sf ${NEXUS_URL}/mcp -H 'Accept: application/json'"

echo ""
if [ "$FAILED" = true ]; then
  echo -e "${RED}❌ 发现问题，请检查 docker compose logs${NC}"
  exit 1
else
  echo -e "${GREEN}✅ 所有检查通过${NC}"
fi
```

### 7.4 AdminSage Skill 设计（自然语言运维核心）

AdminSage 是一个**仅限 sys_admin 角色**的 Sage Skill，通过 MCP 访问 Nexus Admin API，实现自然语言运维。

**文件：** `contrib/industrial-oilgas-skills/industrial-admin/SKILL.md`

```markdown
---
name: industrial-admin
description: >
  ClawTwin 系统运维管理 Skill。仅限 sys_admin 角色使用。
  支持通过自然语言查询系统状态、管理用户权限、管理知识库、查看审计日志。
triggers:
  - 系统运行状态
  - 用户管理
  - 知识库管理
  - 审计日志
  - 健康检查
---

# ClawTwin 运维管理员

你是 ClawTwin 工业平台的系统运维助手。你只服务于 sys_admin 角色的用户。

## 核心原则

- 所有破坏性操作（删除用户、删除文档）必须先请用户确认，再执行
- 分配权限操作必须显示当前权限 → 变更后权限 → 请求确认
- 返回审计日志时脱敏敏感字段

## 可用工具（Nexus MCP）

- `get_system_health` → 查询所有组件健康状态
- `list_users` → 用户列表（含权限）
- `update_user_stations` → 更新用户场站权限（需确认）
- `list_kb_documents` → 知识库文档统计
- `trigger_kb_seed` → 触发知识库种子导入
- `get_audit_logs` → 查询审计日志
- `get_active_alarms_summary` → 全系统告警统计
- `invalidate_cache` → 清除缓存（需确认）
```

**对应的 Nexus MCP 工具扩展（需在 `platform/routers/mcp.py` 中添加）：**

```python
@mcp_server.tool(description="查询系统所有组件健康状态")
async def get_system_health(ctx: MCPContext) -> dict:
    require_sys_admin(ctx)  # 只有 sys_admin 可调用
    return await health_service.get_detail()

@mcp_server.tool(description="获取用户列表及其场站权限")
async def list_users(
    ctx: MCPContext,
    page: int = 1,
    size: int = 20,
) -> dict:
    require_sys_admin(ctx)
    return await user_service.list_with_stations(page, size)

@mcp_server.tool(description="更新用户的场站访问权限")
async def update_user_stations(
    ctx: MCPContext,
    user_id: int,
    station_ids: list[int],
) -> dict:
    require_sys_admin(ctx)
    await user_service.update_stations(user_id, station_ids)
    await audit_service.log("user.stations_updated", ctx.caller_id, {"user_id": user_id})
    return {"success": True, "user_id": user_id, "station_ids": station_ids}

@mcp_server.tool(description="触发知识库种子内容导入")
async def trigger_kb_seed(ctx: MCPContext) -> dict:
    require_sys_admin(ctx)
    job = await kb_service.trigger_seed_import()
    return {"job_id": job.id, "status": "started"}

@mcp_server.tool(description="查询审计日志")
async def get_audit_logs(
    ctx: MCPContext,
    action: str | None = None,
    user_id: int | None = None,
    from_ts: str | None = None,
    to_ts: str | None = None,
    size: int = 50,
) -> dict:
    require_sys_admin(ctx)
    return await audit_service.query(action, user_id, from_ts, to_ts, size)
```

---

## 九、业务编排 API（Playbook / OutcomeEvent）

> 状态：**Phase A 最小集（playbook_runs 只读）；Phase B 全量**
> 依据：`CRITICAL-ARCHITECTURE-REVIEW.md §六.2–6.3` + `PLATFORM-BUSINESS-CONTROL-PLANE.md`

### 9.1 Playbook 定义（只读，由 Industry Pack 导入）

```
GET  /v1/playbooks                    Playbook 定义列表（?station_id=&enabled=）
GET  /v1/playbooks/{id}               Playbook 定义详情（含 YAML 步骤树）
```

### 9.2 PlaybookRun（运行记录）

```
GET  /v1/playbook-runs                运行历史（?playbook_id=&status=&from=&to=&limit=）
GET  /v1/playbook-runs/{run_id}       运行详情（含每步状态 + input/output snapshot）
POST /v1/playbook-runs/{run_id}/resume  人工确认后唤醒等待中的步骤（HITL callback）
```

**PlaybookRun.status 枚举**：`created | running | waiting_for_human | done | failed | cancelled`

**run_steps.step_type 枚举**：`function | action | hitl_checkpoint | notification | condition`

### 9.3 OutcomeEvent（执行结果反馈）

```
GET  /v1/outcome-events               结果事件列表（?workorder_id=&equipment_id=&station_id=）
GET  /v1/outcome-events/{id}          结果事件详情（含 baseline vs post 指标对比）
PATCH /v1/outcome-events/{id}         人工标记 outcome_type（当 auto_evaluate=unknown 时）
```

**OutcomeEvent.outcome_type 枚举**：`recovered | degraded | unchanged | unknown`

**OutcomeEvent.evaluated_by 枚举**：`auto_rule | human | llm_eval`

---

## 十、机器人任务 API（RobotMission）

> 状态：**Phase B**（Edge Agent 集成时实现）
> 依据：`CRITICAL-ARCHITECTURE-REVIEW.md §六.1` + `CLAWTWIN-MULTI-INTELLIGENCE-BLUEPRINT.md §三`

### 10.1 Robot 注册与状态

```
GET  /v1/robots                       机器人列表（?station_id=&status=）
GET  /v1/robots/{id}                  机器人详情（含位置/状态/电量/当前任务）
POST /v1/robots/{id}/telemetry        Edge Agent 上报心跳/状态（需 Robot Certificate）
```

**RobotUnit.status 枚举**：`idle | on_mission | charging | offline | error`

### 10.2 任务调度

```
POST /v1/robot-missions               创建机器人任务（由 Playbook 或人工触发）
GET  /v1/robot-missions               任务队列（?robot_id=&station_id=&status=）
GET  /v1/robot-missions/{id}          任务详情
```

### 10.3 任务执行（Edge Agent 调用，需 Robot Certificate）

```
POST /v1/robot-missions/{id}/accept   机器人确认接受任务
POST /v1/robot-missions/{id}/result   提交任务结果（含 findings + 传感器摘要）
POST /v1/robot-missions/{id}/abort    上报任务中断（机器人故障/障碍）
```

**RobotMission.status 枚举**：`scheduled | dispatched | accepted | in_progress | completed | aborted | failed`

**安全要求**：`/accept`、`/result`、`/abort` 三个接口必须验证 Robot Certificate，且 robot_id 必须与 mission 的分配 robot 一致。

---

## 十一、OperationalEnvelope API

> 状态：**Phase B**
> 依据：`CRITICAL-ARCHITECTURE-REVIEW.md §六.4` + `CLAWTWIN-AUTONOMY-PHILOSOPHY.md §四`

```
GET  /v1/operational-envelopes        当前包络状态列表（?station_id=&equipment_id=）
GET  /v1/operational-envelopes/{id}   包络详情（含参数范围 + 当前值）
PATCH /v1/operational-envelopes/{id}  临时挂起/恢复包络（运维窗口期，需写权限）
```

**OperationalEnvelope.status 枚举**：`normal | warning | breached | suspended`

---

## 十二、数据写入 API（Ingest）

> 状态：**Phase A（已实现，`apps/http/routes/ingest.py`）**
> 依据：OPC-UA/Historian 数据管道入口；OutcomeEvent baseline_snapshot 依赖

```
POST /v1/equipment-readings           单读数写入（传感器 Webhook 推送）
POST /v1/equipment-readings/batch     批量读数写入（OPC-UA 连接器，max 500 行/请求）
POST /v1/operating-contexts           记录设备工况窗口（confound 控制）
GET  /v1/operating-contexts           查询工况窗口列表（?equipment_id=&station_id=）
```

**认证**：生产环境需 `X-Ingest-Token` Header（`CLAWTWIN_INGEST_TOKEN` 环境变量）；
`CLAWTWIN_AUTH_DEV=1` 时跳过。

**EquipmentReading.quality_flag 枚举**：`good | stale | estimated | out_of_range | sensor_fault`

**OperatingContext.operating_mode 枚举**：
`startup | running_loaded | running_idle | shutdown | maintenance | standby | unknown`

---

## 十三、结果反馈 API（OutcomeEvent）

> 状态：**Phase A（已实现，`apps/http/routes/outcome_events.py`）**
> 依据：知识飞轮人工标注入口；ML 训练标签质量门控

**能力门控（Law 5）**：本节的 HTTP 路由与 **`GET /v1/reports/outcomes`** 仅在 **`outcome_tracking`** 能力开启时挂载（缺省时见 **`GET /v1/capabilities`**）。生产/最小化安装可关闭。

```
GET  /v1/outcome-events               结果列表（?station_id=&outcome_type=&evaluated_by=）
GET  /v1/outcome-events/{id}          结果详情（含 metric_delta / baseline_metrics）
PATCH /v1/outcome-events/{id}         人工修正标签（outcome_type + human_notes）
GET  /v1/reports/outcomes              飞轮报表：按窗口聚合 outcome_events + KB flywheel 草案计数（?station_id=&period=24h|7d|30d|all；`apps/http/routes/reports.py`；与 MCP **get_flywheel_summary** 语义对齐）
```

**OutcomeEvent.outcome_type 枚举**：`recovered | degraded | unchanged | unknown`

**OutcomeEvent.evaluated_by 枚举**：`auto_rule | human | llm_eval`

> ⚠️ `evaluated_by=human` 是最高质量训练标签，KB 飞轮优先使用此类样本。

---

## 十五、AI 推荐 API（Recommendations）

> 状态：**Phase A（已实现，`apps/http/routes/recommendations.py`）**
> 依据：基于历史 OutcomeEvent 的 Case-Based Reasoning（NASA/Caterpillar 工业 AI 标准方法）

**能力门控**：**`GET /v1/equipment/{id}/recommended-actions`** 仅在 **`recommendations`** 能力开启时挂载（缺省时见 **`GET /v1/capabilities`**）。

```
GET /v1/equipment/{id}/recommended-actions   AI 推荐操作（含证据 + 置信度 + 自主性等级）
                                              ?alarm_type=&top_n=
```

**Recommendation.autonomy_level 枚举**：`auto_execute | hitl_required | display_only | no_recommendation`

**冷启动行为**：当无历史 OutcomeEvent 时返回 `items: []`，永不报错。

> ⚠️ `decision-package` 端点也包含 `top_recommendation` 字段（top-1 推荐摘要）。

---

## 十四、训练数据导出 API（Export）

> 状态：**Phase A（已实现，`apps/http/routes/export.py`）**
> 依据：为未来更好的 AI 模型准备的标签数据管道

```
GET /v1/export/training-samples       故障-干预-结果三元组（?station_id=&outcome_type=）
GET /v1/export/equipment-readings     时序数据含质量标记（?equipment_id=&quality_flag=）
GET /v1/export/operating-contexts     工况特征窗口（ML 特征工程用）
```

**数据量保护**：每次请求最多 10,000 行，超出需分页（`offset` 参数）。

---

## 十六、M4 企业同步 — 冲突策略（脚手架）

> 状态：**scaffold** · `platform-api/infra/conflict_resolver.py`（**无** I/O；**无** ERP 厂商硬编码）
> 依据：`CLAWTWIN-MILESTONE-PLAN` M4「双向同步冲突解决」— 适配器 / IndustryPack 在拉取或推送工单状态时调用 **纯函数** `resolve_last_write_wins` / `resolve_fixed_strategy`，避免在 core 里散落 if-ERP 分支。

---

## 八、已解决冲突备忘录

| 冲突编号 | 冲突内容                                                                             | 裁定结果                                                            | 依据                                            |
| -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- |
| C-01     | Decision Package 路径 (`/v1/equipment/{id}/decision-package` vs 旧 `/context`)       | ✅ `/v1/equipment/{id}/decision-package`                            | PARALLEL-DEV-TASKSPEC + DEV-QUICKSTART          |
| C-02     | SSE 端点（`/station/{id}` vs `/equipment/{id}`）                                     | ✅ `/v1/sse/station/{id}` 综合流 + `/v1/sse/ai-jobs/{id}` 任务流    | STUDIO-UI-ARCHITECTURE + MODULE-DESIGN-PLATFORM |
| C-03     | AI Job 回调（`PUT /v1/tools/ai-jobs/{id}/result` vs `POST /v1/ai/jobs/{id}/result`） | ✅ `POST /v1/ai/jobs/{id}/result`                                   | 多数文档 + 语义正确（POST 创建结果）            |
| C-04     | 工单路径（`/v1/tools/workorder/*` vs `/v1/workorders/`）                             | ✅ `/v1/workorders/`                                                | MODULE-DESIGN-PLATFORM + DEVELOPMENT-CONTRACT   |
| C-05     | 知识库路径（`/v1/tools/kb/search` vs `/v1/kb/search`）                               | ✅ `/v1/kb/search`                                                  | MODULE-DESIGN-PLATFORM §18                      |
| C-06     | 设备路径（`/v1/objects/equipment/{id}` vs `/v1/equipment/{id}`）                     | ✅ `/v1/equipment/{id}`                                             | MODULE-DESIGN-PLATFORM §18                      |
| C-07     | MCP Phase（Phase B vs Phase A）                                                      | ✅ Phase A（必做）                                                  | ARCHITECTURE-PROTOCOL-ANALYSIS                  |
| C-08     | 飞书 Webhook 是否接收 `im.message.receive_v1`                                        | ✅ 不接收（路由给 OpenClaw）                                        | ARCHITECTURE-FINAL-REVIEW + 源码                |
| C-09     | Agent 回调路径（`ServiceToken POST /v1/ai/jobs/{id}/result` vs MCP）                 | ✅ MCP 是工具调用主路径；`/v1/ai/jobs/{id}/result` 用于异步任务回写 | ADR-8 + ARCHITECTURE-FINAL-REVIEW               |

---

_本文档由 2026-05-11 全量文档扫描生成，需在每次架构变更后更新。_
_任何开发人员发现新的冲突，请在本文档 §八 追加，并在 PR 描述中注明。_
