# ClawTwin Phase A 并行开发任务规范

**版本**：1.0，2026-05-11  
**目标读者**：Cursor 多任务并行开发者  
**使用方式**：每个 Task 是独立的 Cursor 会话，在消息开头 @ 对应文档

---

## 一、总体原则：并行开发的前提

```
并行开发的核心约束：

1. 接口契约先行
   · API 接口定义（URL/请求体/响应体）必须在实现前锁定
   · 数据库表结构必须在实现前确认
   · 任何人不得单方面修改接口——需要在文档中更新后通知所有人

2. Mock 优先开发
   · 前端不等后端：用 Mock API（MSW）先实现 UI
   · 后端不等外部服务：用 MOCK_MODE=true 跳过 **pgvector 扩展检测**/OpenClaw/vLLM 等

3. 明确文件所有权
   · 每个 Task 有"主权文件"——只有该 Task 可以修改这些文件
   · 共享文件（models/base.py, config.py, main.py）通过 PR 合并

4. Done 标准统一
   · 所有 Task 完成标准：① 单元测试通过 ② API 响应符合契约 ③ 无 linter 错误
```

---

## 二、任务依赖图

```
Track A（基础设施，无依赖，最先启动）
┌──────────────────────────────────────────────────────────────────┐
│  A1: Auth + DB 初始化   A2: Equipment CRUD   A3: OT 数据摄入     │
│  A4: 知识库 RAG         A5: Alarm 基础        A6: Studio Shell    │
└──────────────────────────────────────────────────────────────────┘
                 │
Track B（业务逻辑，依赖 A1+A2）
┌──────────────────────────────────────────────────────────────────┐
│  B1: 工单 FSM           B2: Pulse Engine      B3: AI Jobs 异步   │
│  B4: Scheduler          B5: Admin API                             │
└──────────────────────────────────────────────────────────────────┘
                 │
Track C（集成，依赖 B1+B2+B3）
┌──────────────────────────────────────────────────────────────────┐
│  C1: 飞书 Webhook       C2: OpenClaw Skills   C3: SSE 实时推流   │
└──────────────────────────────────────────────────────────────────┘

Track UI（前端，和 Track B 并行，依赖 Mock API）
┌──────────────────────────────────────────────────────────────────┐
│  U1: 设备智能面板       U2: 工单 UI           U3: 告警面板        │
│  U4: 3D 孪生            U5: 知识库 + AI       U6: Admin UI       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 三、Track A：基础设施任务

### Task A1：Auth + 数据库初始化

**并行条件**：无依赖，立即启动  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §四 §十三 §十四 §十五

**主权文件（只有 A1 可修改）**：

```
platform/
├── auth/
│   ├── jwt_utils.py         ← Token 创建/验证
│   ├── password.py          ← bcrypt hash
│   ├── depends.py           ← get_current_user, require_station, require_role
│   └── feishu_bind.py       ← 飞书账号绑定
├── models/
│   ├── base.py              ← Base, TimestampMixin
│   ├── user.py              ← User, UserStation
│   └── audit_log.py        ← AuditLog
├── routers/
│   └── auth.py              ← /v1/auth/login, /v1/auth/me, /v1/auth/feishu-bind
├── db/
│   └── session.py           ← async_session_maker
└── alembic/                 ← 迁移文件
```

**API 契约（锁定，不可改）**：

```
POST /v1/auth/login
  Request:  { "emp_id": "string", "password": "string" }
  Response: { "ok": true, "data": { "token": "jwt_string", "user": UserSchema } }

GET /v1/auth/me
  Header:   Authorization: Bearer <token>
  Response: { "ok": true, "data": UserSchema }

POST /v1/auth/feishu-bind
  Header:   Authorization: Bearer <token>
  Request:  { "feishu_open_id": "string" }
  Response: { "ok": true, "data": { "bound": true } }
```

**UserSchema（共享类型，所有 Task 依赖）**：

```python
class UserSchema(BaseModel):
    id: int
    emp_id: str
    name: str
    role: Literal["operator", "supervisor", "engineer", "sys_admin"]
    station_ids: list[int]   # 有权限的场站 ID 列表
    feishu_open_id: str | None
```

**Done 标准**：

- [ ] `POST /v1/auth/login` 返回 JWT，密码错误返回 401
- [ ] `GET /v1/auth/me` 带 token 返回用户信息，无 token 返回 401
- [ ] `require_station(station_id, user)` 正确拦截无权限访问（返回 403）
- [ ] 审计日志写入 auth.login / auth.deny 事件
- [ ] `pnpm test platform/auth` 通过

---

### Task A2：设备与场站 CRUD

**并行条件**：需要 A1 的 `UserSchema` 和 `get_current_user`，可在 A1 完成后立即启动  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §十九 §二

**主权文件**：

```
platform/
├── models/
│   ├── station.py           ← Station
│   └── equipment.py         ← Equipment, EquipmentType
├── routers/
│   ├── stations.py          ← /v1/stations/*
│   └── equipment.py         ← /v1/equipment/*
└── services/
    └── ontology.py          ← 设备类型 + 指标定义查询
```

**API 契约（锁定）**：

```
GET /v1/stations
  Response: paginate([StationSchema])

GET /v1/stations/{id}
  Response: ok(StationSchema)

GET /v1/equipment?station_id={id}&area={area}
  Response: paginate([EquipmentSummarySchema])

GET /v1/equipment/{id}
  Response: ok(EquipmentDetailSchema)  ← 含 current_state、last_reading

GET /v1/equipment/{id}/decision-package
  Response: ok(DecisionPackageSchema)   ← Pulse Engine 缓存，见 B2
```

**EquipmentSummarySchema**（共享，UI Track 依赖）：

```python
class EquipmentSummarySchema(BaseModel):
    id: int
    tag: str                 # 设备位号 "C-101"
    name: str
    equipment_type: str      # "centrifugal_compressor"
    area: str                # 区域，用于热力图分组
    health_score: float | None  # 0-100，由 Pulse Engine 更新
    health_status: str       # "excellent"|"good"|"warning"|"critical"|"unknown"
    active_alarm_count: int
    station_id: int
```

**Done 标准**：

- [ ] 有权限用户可以获取场站列表；无权限返回 403
- [ ] 设备列表支持 station_id 过滤和分页
- [ ] `GET /v1/equipment/{id}` 返回设备详情含最新读数（可为空）
- [ ] `pnpm test platform/equipment` 通过

---

### Task A3：OT 数据摄入管道

**并行条件**：无依赖，立即启动  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §二十二.2 §二十五.5

**主权文件**：

```
platform/
├── models/
│   └── equipment_reading.py ← EquipmentReading (TimescaleDB hypertable)
├── ingest/
│   ├── pipeline.py          ← IngestPipeline（流水线主体）
│   ├── consumer.py          ← Kafka Consumer（生产）/ Fake Ingest（开发）
│   └── validators.py        ← 数据质量检查
├── routers/
│   └── data.py              ← /v1/equipment/{id}/readings/latest
│                               /v1/equipment/{id}/history
└── services/
    └── realtime_cache.py    ← Redis Hash 最新读数缓存
```

**API 契约**：

```
GET /v1/equipment/{id}/readings/latest
  Response: ok({ readings: { [metric]: ReadingSchema } })
  ReadingSchema: { value: float, unit: str, ts: str (ISO8601 UTC), quality: str }

GET /v1/equipment/{id}/history
  Query:    ?start=ISO8601&end=ISO8601&metrics=p_in,t_out&interval=5m
  Response: ok({ series: { [metric]: [[ts, value], ...] } })
            ← TimescaleDB time_bucket() Continuous Aggregate
```

**摄入流程**：

```python
class IngestPipeline:
    """
    Phase A: Kafka Consumer → validate → write TimescaleDB → update Redis
    Phase B: 换 aiokafka，接口不变
    开发模式: MOCK_INGEST=true → 随机生成读数（每 5 秒）
    """
    async def emit(self, tag: str, metric: str, value: float, ts: datetime, quality: str):
        await self._validate(tag, metric, value)
        await self._write_timescale(tag, metric, value, ts, quality)
        await self._update_redis_latest(tag, metric, value, ts)
        # 不直接触发 Pulse Engine（由 Pulse Engine 自己按 30s 轮询）
```

**Done 标准**：

- [ ] `MOCK_INGEST=true` 时自动每 5 秒生成模拟读数
- [ ] `GET /v1/equipment/{id}/readings/latest` 返回最新值（< 10ms，Redis）
- [ ] `GET /v1/equipment/{id}/history?interval=1h` 返回聚合数据（< 200ms）
- [ ] 数据质量标记：固定值 / 跳变值 / 缺失值

---

### Task A4：知识库 RAG

**并行条件**：无依赖，立即启动  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §八 §十 §二十四.2

**主权文件**：

```
platform/
├── models/
│   └── kb_document.py       ← KBDocument, KBChunk
├── services/
│   ├── embed_client.py      ← bge-m3 向量化（768维）
│   ├── pgvector_kb.py       ← **pgvector** / `kb_chunks` 写入 + 相似度检索（铁律 20）
│   └── kb.py                ← 三层融合搜索（BM25 + 向量 + 元数据过滤）
├── routers/
│   └── kb.py                ← /v1/kb/search, /v1/kb/upload, /v1/kb/documents
└── scripts/
    └── seed_kb.py           ← 冷启动：导入 L0 行业文档
```

**API 契约**：

```
GET /v1/kb/search
  Query:    ?q=文本&equipment_type=centrifugal_compressor&layer=L0,L1&limit=5
  Response: ok({ results: [KBChunkSchema] })
  KBChunkSchema: { chunk_id, doc_title, content, score, layer, source_url }

POST /v1/kb/upload (仅 engineer/sys_admin)
  Multipart: file (PDF/Word/TXT) + metadata JSON
  Response:  ok({ doc_id, chunks_count })

POST /v1/kb/write-l3 (内部接口，仅服务端调用)
  Request:  { work_order_id, summary, tags, equipment_type }
  Response: ok({ doc_id })
```

**Done 标准**：

- [ ] 知识库使用 LlamaIndex + pgvector（开发时 postgres 本身就含 pgvector，无需额外服务）
- [ ] `GET /v1/kb/search?q=压缩机振动&equipment_type=centrifugal_compressor` 返回相关结果
- [ ] 上传 PDF 后，3 分钟内可被检索（异步摄入）
- [ ] L0 种子数据（≥ 10 篇行业文档）可通过 `python scripts/seed_kb.py` 导入

---

### Task A5：告警基础

**并行条件**：依赖 A2（Equipment 模型）和 A3（读数数据）  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §二 + CRITICAL-REVIEW-WAVE2.md §告警

**主权文件**：

```
platform/
├── models/
│   └── alarm.py             ← Alarm（ISA-18.2 字段）
├── routers/
│   └── alarms.py            ← /v1/alarms/*
└── services/
    └── alarm_manager.py     ← 去重 + 搁置 + 状态机
```

**API 契约**：

```
GET /v1/alarms?station_id=1&active=true
  Response: paginate([AlarmSchema])
  AlarmSchema: { id, level (P1-P4), equipment_tag, metric, message,
                 triggered_at, state (active/acked/shelved/resolved),
                 shelved_until (nullable) }

POST /v1/alarms/{id}/acknowledge
  Response: ok({ state: "acked" })

POST /v1/alarms/{id}/shelve
  Request:  { duration_min: 30|60|480 }
  Response: ok({ state: "shelved", shelved_until: ISO8601 })
```

**Done 标准**：

- [ ] 同设备同类型告警 5 分钟内不重复触发（去重）
- [ ] P1 告警 acknowledge 写审计日志
- [ ] 搁置告警在 `shelved_until` 后自动恢复 active

---

### Task A6：Studio Shell + 基础路由

**并行条件**：无依赖，立即启动  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §一 §二 §三 §六

**主权文件**：

```
studio/src/
├── App.tsx                  ← 路由表
├── components/
│   ├── RequireAuth.tsx       ← 权限守卫
│   └── MobileGuard.tsx      ← < 1024px 拦截
├── stores/
│   ├── auth.store.ts         ← 用户状态（JWT 持久化）
│   └── ui.store.ts           ← 全局 UI 状态（选中设备/侧边栏）
├── lib/
│   ├── api-client.ts         ← apiFetch<T>（统一错误处理）
│   └── mock/                 ← MSW handlers（开发 Mock）
└── pages/
    ├── LoginPage.tsx
    └── StudioShell.tsx       ← 主布局（NavRail + CenterView + IntelPanel）
```

**路由表（锁定，所有 UI Task 依赖）**：

```typescript
const routes = [
  { path: "/login", element: <LoginPage /> },
  {
    path: "/studio",
    element: <RequireAuth><StudioShell /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/studio/twin" /> },
      { path: "twin", element: <TwinView /> },      // A6 骨架
      { path: "graph", element: <GraphView /> },     // 后续
      { path: "trend", element: <TrendView /> },     // 后续
      { path: "kanban", element: <KanbanView /> },   // U2
      { path: "pid", element: <PIDView /> },         // 后续
    ]
  },
  { path: "/admin", element: <RequireAuth roles={["sys_admin"]}><AdminLayout /></RequireAuth> },
  { path: "*", element: <Navigate to="/login" /> },
];
```

**Done 标准**：

- [ ] 未登录访问 `/studio` → 重定向到 `/login`
- [ ] 登录后 token 存 localStorage，刷新不丢失
- [ ] `< 1024px` 显示 MobileGuard（引导去飞书）
- [ ] `apiFetch<T>` 统一处理 401（清除 token + 跳登录页）
- [ ] MSW mock 返回 `GET /v1/auth/me` 和 `GET /v1/stations`

---

## 四、Track B：业务逻辑任务

### Task B1：工单 FSM + HITL

**并行条件**：依赖 A1+A2  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §十九 §18.6 NEXUS-BUSINESS-LOGIC.md §状态机

**主权文件**：

```
platform/
├── models/
│   └── work_order.py        ← WorkOrder（wo_id, state, 字段完整）
├── routers/
│   ├── workorders.py        ← /v1/workorders/*
│   └── hitl.py              ← /v1/hitl/workorders/{id}/*
└── services/
    └── workorder_fsm.py     ← 状态机实现（VALID_TRANSITIONS）
```

**状态机（权威定义，不可修改）**：

```python
VALID_TRANSITIONS = {
    "draft":              ["pending_approval", "cancelled"],
    "pending_approval":   ["approved", "rejected", "draft"],
    "approved":           ["in_progress"],
    "in_progress":        ["done"],
    "rejected":           ["draft"],
    "cancelled":          [],
    "done":               [],
}
```

**API 契约（权威）**：

```
POST /v1/workorders/ai-draft          ← 不建工单，返回预填草稿
  Request:  { "equipment_id": int, "symptom": str }
  Response: ok(WorkOrderDraftSchema)

POST /v1/workorders/                  ← 建工单，state 服务端强制 "draft"
  Request:  WorkOrderCreateSchema
  Response: ok(WorkOrderSchema)

GET /v1/workorders?state=draft&station_id=1
  Response: paginate([WorkOrderSchema])

GET /v1/workorders/{wo_id}
  Response: ok(WorkOrderSchema)

POST /v1/hitl/workorders/{wo_id}/pending   ← 提交审批
POST /v1/hitl/workorders/{wo_id}/approve   ← 审批通过（supervisor）
POST /v1/hitl/workorders/{wo_id}/reject    ← 驳回
POST /v1/hitl/workorders/{wo_id}/start     ← 开始执行
POST /v1/hitl/workorders/{wo_id}/done      ← 标记完成（触发 L3 知识沉淀）
```

**Done 标准**：

- [ ] 状态转换不合法时返回 400（如 draft → done 直接跳）
- [ ] approve 必须验证 role=supervisor AND station 权限
- [ ] done 后异步调用 `kb.write_l3_knowledge()`
- [ ] 飞书卡片通知在 pending / approve / reject 时发送（见 C1）

---

### Task B2：Pulse Engine + Decision Package

**并行条件**：依赖 A1+A2+A3，依赖 A5（告警数据）  
**Cursor 会话 @ 文档**：NEXUS-BUSINESS-LOGIC.md §Pulse Engine COMMERCIAL-ARCHITECTURE.md §三

**主权文件**：

```
platform/
├── engines/
│   └── pulse_engine.py      ← PulseEngine（30s 心跳）
├── schemas/
│   └── decision_package.py  ← DecisionPackageSchema（共享类型）
└── routers/
    └── decision.py          ← /v1/equipment/{id}/decision-package
```

**DecisionPackageSchema（共享，所有 Track 依赖）**：

```python
class DecisionPackageSchema(BaseModel):
    equipment_id: int
    computed_at: str          # ISO8601 UTC
    health_score: float       # 0-100
    health_status: str        # excellent|good|warning|critical
    health_trend: str         # improving|stable|declining|rapid_decline
    active_alarm_count: int
    highest_alarm_level: str | None   # P1|P2|P3|P4|None
    primary_action: PrimaryActionSchema
    data_quality: str         # high|medium|low|stale
    proactive_insight: str | None     # AI 预备分析文本
    ai_confidence: str | None         # high|medium|low
    relevant_kb_ids: list[int]        # 预检索 KB 文档 ID
```

**PrimaryActionSchema（纯规则，不调 LLM）**：

```python
class PrimaryActionSchema(BaseModel):
    action_id: str
    label: str
    urgency: str        # immediate|high|medium|low
    estimated_min: int  # 预计处理时间（分钟）
    action_type: str    # emergency_stop|create_workorder|request_ai|acknowledge_alarm|monitor

# 决策规则（优先级从高到低）：
# 1. P1 告警 → immediate + emergency_stop
# 2. MOIRAI 异常分 > 0.85 → high + create_workorder
# 3. 存在未确认 P2 告警 → high + create_workorder
# 4. health_score < 60 → medium + request_ai
# 5. 无异常 → low + monitor
```

**Done 标准**：

- [ ] `GET /v1/equipment/{id}/decision-package` 从 Redis 返回（< 10ms）
- [ ] Redis miss 时降级到实时计算（< 500ms）
- [ ] Pulse Engine 每 30s 后台刷新所有设备的 Decision Package
- [ ] `MOCK_PULSE=true` 时每次请求随机生成（开发用）

---

### Task B3：AI Jobs 异步

**并行条件**：依赖 A1+A4  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §二十二.3 §二十七.5

**主权文件**：

```
platform/
├── models/
│   └── ai_job.py            ← AIJob（task_id, status, result）
├── routers/
│   └── ai_jobs.py           ← /v1/ai/jobs/*
└── workers/
    └── ai_job_worker.py     ← 后台 Worker（异步触发 OpenClaw）
```

**API 契约**：

```
POST /v1/ai/jobs              ← Studio 触发 AI 分析的唯一入口
  Request:  { "job_type": "diagnose"|"pid_analyze"|"kb_query",
              "equipment_id": int, "params": {...} }
  Response: ok({ "task_id": "uuid", "status": "queued" })

GET /v1/ai/jobs/{task_id}     ← Studio 轮询结果
  Response: ok({ "task_id", "status": "queued"|"running"|"done"|"failed",
                 "result": {...} | null, "error": str | null })
```

**Done 标准**：

- [ ] 创建 Job 立即返回 task_id（< 100ms）
- [ ] Worker 后台处理（asyncio.create_task，Phase B 换 ARQ）
- [ ] `MOCK_AI=true` 时 3 秒后返回 Mock 诊断结果
- [ ] 失败时 status=failed + error 字段（不崩溃）

---

### Task B4：Scheduler 定时任务

**并行条件**：依赖 A1+A2+A3+A4  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §九

**主权文件**：

```
platform/
└── scheduler/
    ├── jobs.py              ← 所有定时任务定义
    ├── helpers.py           ← 辅助函数（发送晨报、异常轮询）
    └── runner.py            ← APScheduler 配置
```

**定时任务清单**：

```python
# 每日 07:30 → 晨报（站场状态汇总发飞书）
async def morning_report_job():

# 每 30s → Pulse Engine 刷新所有活跃设备
async def pulse_engine_refresh_job():

# 每 60s → MOIRAI 异常预测（如有设备 Enabled）
async def anomaly_poll_job():

# 每 5min → 过期告警搁置状态检查（重新激活）
async def alarm_shelve_check_job():
```

**Done 标准**：

- [ ] `DISABLE_SCHEDULER=true` 时完全跳过（CI 环境）
- [ ] 各任务独立错误处理（一个任务失败不影响其他）
- [ ] 晨报内容：场站健康概况 + 活跃告警数 + 未完成工单数

---

## 五、Track C：集成任务

### Task C1：飞书 Webhook + Bot

**并行条件**：依赖 B1（工单状态变更触发通知）  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §十三.3 §二十五.3 ADR-5

**主权文件**：

```
platform/
├── routers/
│   └── feishu.py            ← /v1/feishu/webhook（卡片回调）
└── services/
    └── feishu.py            ← FeishuClient（发消息/卡片）
```

**触发点（监听这些事件）**：

```python
# 工单 pending_approval → 发审批卡片给 supervisor
# 工单 approved/rejected → 发结果通知给工单创建人
# P1 告警触发 → 发紧急告警卡片给 supervisor
# 晨报定时 → 发汇总卡片给所有人

# 卡片回调处理（/v1/feishu/webhook）：
# · approve_button → POST /v1/hitl/workorders/{id}/approve
# · reject_button  → POST /v1/hitl/workorders/{id}/reject
```

**Done 标准**：

- [ ] Webhook 签名验证（`FEISHU_VERIFY_TOKEN` 配置时强制）
- [ ] `MOCK_FEISHU=true` 时打印卡片 JSON 到 stdout（不发真实消息）
- [ ] 审批卡片点击后工单状态正确变更 + 审计日志

---

### Task C2：Nexus MCP Server + Sage Skills 接入

**并行条件**：依赖 A4（KB）、B2（Decision Package）、B3（AI Jobs）  
**Cursor 会话 @ 文档**：ARCHITECTURE-PROTOCOL-ANALYSIS.md ADR-8-AGENT-INTEGRATION.md ARCHITECTURE-FINAL-REVIEW.md

**重要架构决策（2026-05-11 更新）**：

```
Nexus 在 Phase A 就实现 MCP Server（不等 Phase B）
原因：OpenClaw 和 Hermes 都支持 MCP，MCP 是 AI 行业标准
优先级调整：MCP Server 是本 Task 的核心输出

OpenClaw / Hermes / Dify 通过 MCP 访问 Nexus 工具（统一接口）
不再需要手写 function schema，MCP 自动生成工具描述
```

**主权文件**（Platform 侧）：

```
platform/
└── routers/
    └── mcp.py               ← MCP Server 端点（/mcp）
                                实现 4 个核心 MCP Tools

sage/                         ← Sage Skills 目录（可移植到 OpenClaw/Hermes）
├── industrial-twin/
│   └── SKILL.md              ← 系统提示词 + MCP 配置（非 OpenClaw-specific）
├── industrial-kb/
│   └── SKILL.md
├── industrial-workorder/
│   └── SKILL.md
└── industrial-analytics/
    └── SKILL.md
```

**MCP Tools 定义（platform/routers/mcp.py）**：

```python
from mcp.server import MCPServer
from mcp.server.fastapi import create_mcp_router

mcp_server = MCPServer("clawtwin-nexus", version="1.0.0")

@mcp_server.tool()
async def get_equipment_context(equipment_id: int) -> dict:
    """获取设备当前状态、健康评分、历史趋势和AI分析上下文"""
    return await equipment_service.get_decision_package(equipment_id)

@mcp_server.tool()
async def search_knowledge_base(query: str, equipment_type: str = "") -> list:
    """在工业知识库中搜索相关文档和标准"""
    return await kb_service.semantic_search(query, filter_type=equipment_type)

@mcp_server.tool()
async def create_work_order(equipment_id: int, problem_description: str,
                             priority: str = "P3") -> dict:
    """创建设备维修工单（返回工单 ID 和状态）"""
    return await workorder_service.create_ai_draft(equipment_id, problem_description, priority)

@mcp_server.tool()
async def list_active_alarms(station_id: int) -> list:
    """获取站场当前活跃告警列表"""
    return await alarm_service.list_active(station_id)

# 注册到 /mcp 端点（带 Service Token 认证）
mcp_router = create_mcp_router(mcp_server, path="/mcp", middleware=[service_token_auth])
```

**REST Tool API（向下兼容，同 MCP 工具）**：

```
GET /v1/tools/equipment/context?equipment_id={id}
GET /v1/tools/kb/search?q={query}&equipment_type={type}
POST /v1/tools/workorder/create
GET /v1/tools/alarms/active?station_id={id}
```

**AI 运行时配置（选择其一）**：

```yaml
# OpenClaw 配置（openclaw.yaml）
plugins:
  acpx:
    mcpServers:
      nexus:
        command: npx
        args:
          [
            "@clawtwin/nexus-mcp-proxy",
            "--url",
            "http://nexus:8000/mcp",
            "--token",
            "${NEXUS_SERVICE_TOKEN}",
          ]

# Hermes 配置（config.yaml）
mcp:
  nexus:
    url: http://nexus:8000/mcp
    auth:
      type: bearer
      token: ${NEXUS_SERVICE_TOKEN}

# Dify 工作流 HTTP 工具（REST 模式，Phase A 兼容）
http_tool:
  url: http://nexus:8000/v1/tools/equipment/context
  headers:
    X-Nexus-Service-Token: ${NEXUS_SERVICE_TOKEN}
```

**Done 标准**：

- [ ] `GET /mcp` 返回标准 MCP Server 能力描述
- [ ] MCP Tool `get_equipment_context` 返回完整决策包（含 health_score + primary_action）
- [ ] Service Token 认证：无 Token 返回 401
- [ ] REST Tool API 与 MCP 工具行为一致（向下兼容）
- [ ] SKILL.md 中包含 MCP 配置，可在 OpenClaw 和 Hermes 中直接使用

---

### Task C3：SSE 实时推流

**并行条件**：依赖 A3（读数数据）、B2（Pulse Engine）  
**Cursor 会话 @ 文档**：MODULE-DESIGN-PLATFORM.md §二十一.3

**主权文件**：

```
platform/
└── routers/
    └── sse.py               ← /v1/sse/equipment/{id}
                                /v1/sse/station/{id}/alarms
```

**SSE 事件类型**：

```
event: reading_update
data: { "metric": "p_in", "value": 6.8, "unit": "MPa", "ts": "..." }

event: health_update
data: { "health_score": 73, "health_status": "warning" }

event: alarm_triggered
data: { "alarm_id": 123, "level": "P2", "message": "..." }

event: ai_job_done
data: { "task_id": "uuid", "result": {...} }
```

**Done 标准**：

- [ ] SSE 连接断开后客户端自动重连（`EventSource` 标准行为）
- [ ] 心跳每 30s 发送一次（防 Nginx 超时断连）
- [ ] 单个 SSE 连接不超过 60 秒无数据时发送 keep-alive

---

## 六、Track UI：前端任务

### Task U1：设备智能面板（DeviceIntelPanel）

**并行条件**：需要 A6（Shell），可与 B2 并行（用 MSW Mock DecisionPackage）  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §二十七 §二十八 UI-UX-DESIGN.md §二十一 §二十二

**主权文件**：

```
studio/src/
├── components/intel/
│   ├── DeviceIntelPanel.tsx    ← 主容器（布局：倒计时→Action→AI→指标→健康→工单）
│   ├── UrgencyCountdown.tsx    ← 倒计时组件
│   ├── OneActionButton.tsx     ← 主行动按钮（由 primary_action 驱动）
│   ├── AIInsightCard.tsx       ← AI 洞察（含置信度颜色+Citations）
│   ├── MetricGrid.tsx          ← 指标网格（折叠/展开）
│   └── HealthScoreCard.tsx     ← 健康评分卡（环形进度+趋势箭头）
└── hooks/
    └── useEquipmentIntel.ts    ← 数据获取 Hook（decision-package + SSE 订阅）
```

**Mock API（MSW handler）**：

```typescript
// GET /v1/equipment/:id/decision-package
// 返回 DecisionPackageSchema 的 Mock 数据
// 包括三种状态：normal / warning / critical
```

**UI 铁律（来自 SKILL.md §11）**：

- DeviceIntelPanel 布局顺序固定：倒计时 → Action → AI → 指标 → 健康 → 工单
- OneActionButton 内容由后端 primary_action 决定，前端只渲染
- AI 置信度 ≥ 0.8 绿、0.6-0.8 黄、< 0.6 红

**Done 标准**：

- [ ] 从 MSW Mock 获取 Decision Package 并渲染
- [ ] SSE 读数更新时，指标网格实时刷新（无需刷页面）
- [ ] 点击 OneActionButton（工单类型）→ 展开 WorkOrderDraftInline
- [ ] Citations 可点击（跳到 KB 文档）
- [ ] Storybook stories: normal / warning / critical / loading / offline 五个状态

---

### Task U2：工单 UI

**并行条件**：依赖 A6（Shell），需要 B1 Mock API  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §十 §十七 §二十七

**主权文件**：

```
studio/src/
├── components/workorder/
│   ├── WorkOrderDraftInline.tsx  ← 内嵌草稿（在 IntelPanel 内，不跳页面）
│   ├── WorkOrderCard.tsx         ← 工单卡片（看板中的单个工单）
│   ├── WorkOrderDetail.tsx       ← 工单详情面板
│   └── StatusBadge.tsx           ← 状态色标（draft:灰/pending:黄/approved:绿/...）
├── pages/
│   └── KanbanView.tsx            ← 工单看板（按 state 分列）
└── hooks/
    └── useWorkOrders.ts          ← 列表+分页+状态变更
```

**铁律**：工单草稿必须内嵌在 IntelPanel，不跳页面

**Done 标准**：

- [ ] 看板按 draft/pending_approval/approved/in_progress 四列显示
- [ ] 工单状态变更后看板实时更新（乐观更新 + 后端确认）
- [ ] WorkOrderDraftInline 表单：症状/描述/建议操作可编辑，submit 调 `POST /v1/workorders/`

---

### Task U3：告警面板（AlarmQueuePanel）

**并行条件**：依赖 A6（Shell），需要 A5 Mock API  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §二十五 UI-UX-DESIGN.md §22.2

**主权文件**：

```
studio/src/
├── components/alarm/
│   ├── AlarmQueuePanel.tsx    ← 告警队列（无选中设备时显示）
│   ├── AlarmRow.tsx           ← 单条告警（含 Ack/Shelve 按钮）
│   └── InvestigationBanner.tsx ← P1 告警时全宽顶部横幅
└── hooks/
    └── useAlarms.ts           ← 告警列表 + SSE 订阅
```

**Done 标准**：

- [ ] P1 告警触发时 InvestigationBanner 自动展示（全宽紫色横幅）
- [ ] 告警按 P1→P4 + 时间排序
- [ ] Ack/Shelve 操作后告警列表实时更新

---

### Task U4：3D 数字孪生

**并行条件**：依赖 A6（Shell），需要 A2 + A3 Mock API  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §五

**主权文件**：

```
studio/src/
├── surfaces/
│   ├── TwinSurface.tsx        ← Babylon.js 主容器
│   ├── EquipmentMesh.tsx      ← 设备 3D 网格（+ 状态颜色）
│   └── HealthOverlay.tsx      ← 设备上方健康分悬浮标签
└── hooks/
    └── useTwinScene.ts        ← Babylon.js 场景管理
```

**Done 标准**：

- [ ] 场景加载时间 < 3 秒（使用占位几何体，不依赖真实 3D 模型）
- [ ] 点击设备 → 触发 `ui.store.selectEquipment(id)`
- [ ] 设备颜色随健康状态变化（绿/黄/橙/红）
- [ ] WebGPU 不支持时自动降级到 WebGL

---

### Task U5：知识库 + AI 查询 UI

**并行条件**：依赖 A6、B3，需要 A4 + B3 Mock API  
**Cursor 会话 @ 文档**：MODULE-DESIGN-STUDIO.md §十三

**主权文件**：

```
studio/src/
├── pages/
│   ├── KnowledgePage.tsx      ← KB 列表（仅 engineer 可上传）
│   └── AIQueryPage.tsx        ← 自然语言 AI 查询界面（飞书 Bot 快速入口）
└── components/ai/
    ├── AIJobStatus.tsx         ← 轮询 AI Job 状态（进度条）
    └── CitationBadge.tsx       ← 可点击 Citations 徽章（全局共享）
```

**Done 标准**：

- [ ] KB 上传：进度条显示（drag-drop）
- [ ] AI 查询：提交后显示 AIJobStatus → 完成后展示结果 + CitationBadge

---

### Task D4：Context API + Webhook（OA/ERP 集成）

**并行条件**：依赖 B1（工单）、B2（Decision Package）、B3（AI Jobs）  
**Cursor 会话 @ 文档**：NEXUS-HEADLESS-INTEGRATION.md §三 §四 §九

**主权文件**：

```
platform/
├── routers/
│   ├── context.py           ← /v1/ctx/* 路由
│   └── webhooks.py          ← /v1/webhooks/subscriptions
├── models/
│   └── webhook_subscription.py ← WebhookSubscription
├── services/
│   └── webhook_dispatcher.py   ← 事件 → 外部 HTTP 推送
└── auth/
    └── service_token.py        ← 扩展：ServiceTokenScope 细粒度权限
```

**API 契约**：

```
GET /v1/ctx/workorder/{wo_id}
  鉴权：X-Nexus-Service-Token（scope: context:read）
  Response: 聚合响应（工单+设备状态+AI分析+历史维护）

GET /v1/ctx/equipment/{equipment_id}
  鉴权：X-Nexus-Service-Token（scope: context:read）
  Response: 设备当前状态 + AI 分析摘要

GET /v1/ctx/station/{station_id}/summary
  鉴权：X-Nexus-Service-Token（scope: context:read）
  Response: 站场概况（设备总数/告警/工单/整体健康）

POST /v1/ctx/ai-draft-form
  鉴权：X-Nexus-Service-Token（scope: context:read）
  Request:  { "equipment_id": int, "user_description": str }
  Response: AI 预填的表单内容（标题/症状/建议操作/紧急程度）

POST /v1/webhooks/subscriptions
  鉴权：X-Nexus-Service-Token（scope: webhook:subscribe）
  Request:  { "target_url": str, "events": list[str], "secret": str, "station_ids": list[int] }
  Response: ok({ "subscription_id": "uuid" })

DELETE /v1/webhooks/subscriptions/{id}
  Response: ok()
```

**Done 标准**：

- [ ] `GET /v1/ctx/workorder/{id}` 返回聚合决策上下文（< 300ms）
- [ ] Context API 只接受 Service Token，拒绝 User JWT（403）
- [ ] Webhook 在工单 pending_approval 时触发（含 HMAC 签名）
- [ ] Webhook 失败重试 3 次（指数退避：5s / 15s / 45s）
- [ ] `MOCK_WEBHOOK=true` 时打印到 stdout 不发真实 HTTP

---

## 七、接口契约冲突解决规则

```
当不同任务对同一接口有不同理解时：

1. 以 MODULE-DESIGN-PLATFORM.md 最新 §编号为准
2. 以本文档 Task 规范为准（比 MODULE-DESIGN-PLATFORM 更新）
3. 修改时必须同时更新：
   · 本文档的 API 契约表
   · MODULE-DESIGN-PLATFORM.md 的对应章节
   · 对应 Task 的 MSW mock handler
4. 通知所有依赖该接口的 Task

绝对不允许：
  · 前端自行修改 API 路径（必须告知后端）
  · 后端修改响应结构但不通知前端（会导致 UI 崩溃）
  · 静默修改 DecisionPackageSchema / UserSchema 等共享类型
```

---

## 八、开发环境快速启动（所有 Task 适用）

```bash
# 1. 启动 Phase A 4个核心服务（PostgreSQL+pgvector + Redis + vLLM + OpenClaw）
# 不再需要 Milvus / MinIO / Kafka / etcd / Ditto
docker compose up -d postgres redis vllm openclaw

# 2. 启动 Platform（开发模式，所有外部依赖都有 Mock）
cd platform
MOCK_INGEST=true MOCK_AI=true MOCK_FEISHU=true \
  uvicorn main:app --reload --port 8000
# 注：MOCK_MILVUS 已废弃（pgvector 内置在 postgres，无需单独 mock）

# 3. 启动 Studio（开发模式，用 MSW Mock API）
cd studio
pnpm dev   # 开发时先走 MSW Mock，后端就绪后改 .env VITE_API_BASE

# 4. 查看 OpenAPI 文档
open http://localhost:8000/docs

# 5. 运行测试
cd platform && pnpm test src/tests/test_auth.py  # 单 Task 测试
cd studio && pnpm test src/components/intel/      # 单组件测试
```

---

## 九、Phase A 完成标准（全部 Task 合并后）

```
功能验收（M6 Week 12 前完成）：
  □ 操作员可以登录 Studio，查看自己场站的设备列表
  □ 每台设备打开后 < 1 秒内显示健康分 + 推荐行动
  □ P1 告警出现时 InvestigationBanner 自动弹出
  □ 点击"建工单"→ 内嵌草稿 → 提交 → 飞书推送审批卡片
  □ 主管点飞书卡片按钮 → 工单状态更新 → 通知操作员
  □ 工单完成 → 自动沉淀为 L3 知识 → 下次 KB 可检索
  □ 早上 07:30 站场运营日报推送到飞书群
  □ Admin 可以创建用户/场站/设备、上传 KB 文档

非功能验收：
  □ Studio 首屏加载 < 3 秒（LCP）
  □ Decision Package API 响应 < 50ms（P95）
  □ 24 小时运行无内存泄漏（RSS 增长 < 100MB）
  □ 0 个 P1 安全漏洞（auth/station 权限校验全覆盖）
```

---

_本文档是 Cursor 多任务并行开发的主规范，每个 Task 独立可执行。_  
_接口契约一旦锁定，修改必须知会所有相关 Task。_
