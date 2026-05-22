# ClawTwin 核心架构评审（对标 2026 业界顶级产品）

> **版本**：v1.0 · 2026-05-11  
> **范围**：核心架构（不是细节）。聚焦未来 3 年的可扩展性。  
> **对标**：Palantir Foundry/AIP · Anthropic Claude/Sonnet · OpenAI Operator · Cognition Devin · NVIDIA Omniverse · Databricks · Cursor · Tesla Autobidder

---

## 一、本次评审的立场

前三轮审查处理了：

- ✅ 技术栈精简（11→4 服务）
- ✅ 自研 RAG → LlamaIndex
- ✅ Nexus 不直调 vLLM chat（铁律 19/20）
- ✅ 文档一致性

**这一轮聚焦真正的"核心架构"——五年内不会改的骨架。**

---

## 二、对照 2026 业界顶级产品的关键趋势

### 2.1 七大核心趋势

| #   | 趋势                                                | 代表产品                                    | ClawTwin 现状                 | 优先级            |
| --- | --------------------------------------------------- | ------------------------------------------- | ----------------------------- | ----------------- |
| 1   | **Tool/Action 统一框架**（schema 一致、自动 audit） | Anthropic tool-use, OpenAI Function Calling | ❌ 散落在 routers / mcp / cli | **P0**            |
| 2   | **LLM Trace + Eval 体系**（每次推理可追溯、可评估） | Langfuse, OpenAI Trace, Anthropic Eval      | ❌ 完全缺失                   | **P0**            |
| 3   | **统一 Approval / HITL 框架**（不限于工单）         | OpenAI Operator approval, Devin policies    | ⚠️ 硬编码在工单上             | **P0**            |
| 4   | **三层清晰架构**（domain / interfaces / workers）   | Palantir Foundry 内核                       | ⚠️ 业务和 IO 混在 services/   | **P1**            |
| 5   | **Memory / 工作上下文**（不只是对话历史）           | Mem0, Letta, Anthropic Memory               | ❌ 只有对话历史，没有工作记忆 | **P2**（Phase B） |
| 6   | **Background Agent / 长任务**                       | Devin, Cursor Bg Agent, Manus               | ❌ 只有同步 AI Job            | **P2**（Phase B） |
| 7   | **Computer Use 兜底**（无 API 系统也能集成）        | OpenAI Operator, Anthropic Computer Use     | ❌ 完全缺失（Phase C 才需要） | **P3**            |

---

## 三、P0 问题：Tool / Action 统一框架（最重要）

### 3.1 现状的问题

ClawTwin 有三个 LLM/用户调用入口：

- **HTTP API**（routers/）：`POST /v1/hitl/workorders/{id}/approve`
- **MCP Tools**（routers/mcp.py）：`acknowledge_alarm(alarm_id, reason)`
- **CLI**（cli.py）：`clawtwin alarm ack ALM-001 --reason="已检查"`

**当前设计**：每个入口各自写参数验证、权限检查、审计日志、调用业务逻辑。

```
当前（重复 3 次）：
┌─────────────────────┐
│ routers/alarms.py   │ → 解析 JSON body → 校验权限 → audit_log → service
│ routers/mcp.py      │ → 解析 tool args → 校验权限 → audit_log → service
│ cli.py              │ → 解析 CLI args  → 校验权限 → audit_log → service
└─────────────────────┘
```

后果：

- 三处 schema 不一致（HTTP 用 Pydantic，MCP 用 fastmcp 装饰器，CLI 用 Typer）
- 三处审计日志可能漏写
- 三处权限规则可能不同
- 增加新 Action 要改 3 个文件

### 3.2 修正：Action 中心化

```python
# core/actions/base.py
from typing import Generic, TypeVar
from pydantic import BaseModel
from abc import ABC, abstractmethod

InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT", bound=BaseModel)

class SafetyContract(BaseModel):
    risk_level: Literal["LOW", "MEDIUM", "HIGH"]
    idempotent: bool                  # 重复调用是否安全
    rate_limit_per_min: int = 60
    requires_approval: bool = False   # HIGH 默认 True
    requires_role: list[str] = []     # ["supervisor", "engineer"]
    requires_station_match: bool = True

class Action(Generic[InputT, OutputT], ABC):
    """所有写操作必须继承 Action，统一 schema/审计/权限"""
    name: str                          # "acknowledge_alarm"
    description: str                   # 给 LLM 看的说明
    safety: SafetyContract
    input_model: type[InputT]
    output_model: type[OutputT]

    @abstractmethod
    async def execute(self, input: InputT, actor: Actor, ctx: ActionContext) -> OutputT:
        """子类只关心业务逻辑；权限/审计/限流由框架处理"""
        ...

# core/actions/acknowledge_alarm.py
class AckAlarmIn(BaseModel):
    alarm_id: str = Field(..., description="告警 ID（如 ALM-2026-0511-001）")
    reason: str | None = Field(None, description="确认原因（可选）")

class AckAlarmOut(BaseModel):
    alarm_id: str
    acknowledged_at: datetime
    acknowledged_by: str

class AcknowledgeAlarmAction(Action[AckAlarmIn, AckAlarmOut]):
    name = "acknowledge_alarm"
    description = "确认告警（ISA-18.2），不抑制告警，仅标记操作员已知晓"
    safety = SafetyContract(
        risk_level="LOW",
        idempotent=True,
        rate_limit_per_min=30,
        requires_role=["operator", "supervisor", "engineer"],
        requires_station_match=True,
    )
    input_model = AckAlarmIn
    output_model = AckAlarmOut

    async def execute(self, input: AckAlarmIn, actor: Actor, ctx: ActionContext) -> AckAlarmOut:
        alarm = await ctx.alarm_repo.get(input.alarm_id)
        alarm.acknowledge(by=actor.user_id, reason=input.reason)
        await ctx.alarm_repo.save(alarm)
        return AckAlarmOut(
            alarm_id=alarm.id,
            acknowledged_at=alarm.acknowledged_at,
            acknowledged_by=actor.user_id,
        )

# interfaces/router_factory.py - 自动从 Action 生成 HTTP/MCP/CLI 入口
def mount_action(app, mcp, cli, action: Action):
    # FastAPI HTTP
    @app.post(f"/v1/actions/{action.name}", response_model=action.output_model)
    async def http_endpoint(input: action.input_model, actor: Actor = Depends(get_actor)):
        return await invoke(action, input, actor, transport="http")

    # MCP Tool
    @mcp.tool(name=action.name, description=action.description)
    async def mcp_tool(**kwargs):
        return await invoke(action, action.input_model(**kwargs), get_mcp_actor(), transport="mcp")

    # Typer CLI
    @cli.command(name=action.name)
    def cli_cmd(**kwargs):
        return asyncio.run(invoke(action, action.input_model(**kwargs), get_cli_actor(), transport="cli"))

# core/actions/invoke.py - 统一调用通道
async def invoke(action: Action, input: BaseModel, actor: Actor, transport: str) -> BaseModel:
    # 1. 权限校验
    enforce_role(actor, action.safety.requires_role)
    if action.safety.requires_station_match:
        enforce_station(actor, input)

    # 2. 限流
    await rate_limit(action.name, actor, action.safety.rate_limit_per_min)

    # 3. 审批门禁（HIGH 风险走 HITL Approval Queue）
    if action.safety.requires_approval:
        approval = await ApprovalQueue.request(action, input, actor)
        if approval.status != "approved":
            raise ApprovalPending(approval.id)

    # 4. 写 LLM/Action Trace
    trace_id = await TraceStore.start(action.name, input, actor, transport)

    # 5. 执行
    try:
        ctx = build_context(actor)
        result = await action.execute(input, actor, ctx)
        await TraceStore.success(trace_id, result)
        await AuditLog.write(action.name, input, result, actor, transport)
        return result
    except Exception as e:
        await TraceStore.failure(trace_id, e)
        raise
```

**收益**：

- 新增 Action 只写 1 个文件，HTTP/MCP/CLI 三处自动可用
- 权限 / 限流 / 审批 / 审计 / Trace 强制统一
- Schema 单一来源（Pydantic 模型同时给 HTTP/MCP/CLI/前端类型生成）
- 测试只需测 `Action.execute`，框架部分单测一次复用

### 3.3 项目结构修正

```
platform-api/
├── core/
│   ├── actions/             # ★ 所有 Action 定义（写操作）
│   │   ├── base.py
│   │   ├── acknowledge_alarm.py
│   │   ├── shelve_alarm.py
│   │   ├── create_workorder.py
│   │   ├── approve_workorder.py
│   │   ├── record_production.py
│   │   └── ...
│   ├── queries/             # ★ 所有 Query 定义（读操作）
│   │   ├── get_equipment_context.py
│   │   ├── search_knowledge.py
│   │   └── ...
│   ├── domain/              # 实体 / 值对象 / FSM
│   │   ├── equipment.py
│   │   ├── alarm.py         # AlarmState FSM
│   │   ├── workorder.py     # WorkOrderState FSM (transitions 库)
│   │   └── knowledge.py
│   └── ports/               # 抽象接口（依赖反转）
│       ├── repositories.py  # AlarmRepo / WorkOrderRepo / ...
│       ├── notifier.py      # NotificationPort（飞书/邮件/SMS）
│       ├── agent_runtime.py # OpenClaw / Hermes / Dify 抽象
│       └── embedder.py      # bge-m3 / OpenAI 嵌入抽象
├── adapters/                # Port 实现（依赖具体技术）
│   ├── db/                  # SQLAlchemy 仓库实现
│   ├── feishu/              # lark-oapi 适配器
│   ├── openclaw/            # AgentConnector 实现
│   ├── llamaindex/          # RAG 适配器
│   └── redis_shadow/        # 设备影子状态
├── interfaces/              # 入口（一个 Action 三处暴露）
│   ├── http/                # FastAPI 路由 + auto_mount(action)
│   ├── mcp/                 # FastMCP server
│   └── cli/                 # Typer CLI
├── workers/                 # 后台
│   ├── scheduler.py         # APScheduler 任务
│   └── streams.py           # Redis Streams 消费
└── infra/                   # 启动 / DI / 日志 / Trace
    ├── tracing.py
    ├── audit.py
    ├── approval_queue.py
    └── settings.py
```

---

## 四、P0 问题：LLM Trace + Eval 体系

### 4.1 为什么必须做

工业 AI 决策**必须可追溯**——客户审计/合规检查时会问：

- "AI 当时为什么建议关闭 V-007？"
- "上周 100 个 AI 回答里多少是对的？"
- "这个月 LLM 调用花了多少钱？"

没有 Trace = 没有可解释性 = 工业客户不敢用。

### 4.2 数据库设计

```sql
-- LLM 调用 / Action 执行 trace（一行 = 一次推理或写操作）
CREATE TABLE llm_traces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,

    -- 上下文（强制写）
    transport       VARCHAR(20) NOT NULL,    -- http | mcp | cli | scheduler | webhook
    session_id      VARCHAR(50),             -- OpenClaw session id（来自 X-Session-Id）
    actor_user_id   VARCHAR(20),
    actor_role      VARCHAR(20),
    station_id      VARCHAR(20),

    -- 调用详情
    action_name     VARCHAR(80),             -- "acknowledge_alarm" 或 "agent_invoke"
    model           VARCHAR(100),            -- "Qwen3-35B-A3B-Int4"（仅 LLM 调用）
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        NUMERIC(10, 6),

    -- 输入 / 输出（脱敏后存储）
    input_redacted  JSONB,                   -- 脱敏后的输入
    output_redacted JSONB,                   -- 脱敏后的输出
    tool_calls      JSONB,                   -- LLM 触发的工具调用链
    citations       TEXT[],                  -- 引用的 KB 文档 doc_id 列表

    -- 评估字段（人工或自动标注）
    eval_status     VARCHAR(20) DEFAULT 'pending',
                                             -- pending|correct|incorrect|partial|na
    eval_label_by   VARCHAR(20),             -- 人工标注者
    eval_note       TEXT,

    -- 结果状态
    status          VARCHAR(20) DEFAULT 'success',  -- success|error|approval_pending
    error_msg       TEXT
);

CREATE INDEX idx_traces_session ON llm_traces(session_id);
CREATE INDEX idx_traces_action ON llm_traces(action_name, started_at DESC);
CREATE INDEX idx_traces_eval ON llm_traces(eval_status, action_name)
    WHERE eval_status = 'pending';
```

### 4.3 Studio 上的 Trace 视图

```
/studio/admin/traces
├── 时间筛选 / Action 筛选 / Session 筛选
├── 表格列：时间 | Action | 用户 | 站场 | 模型 | 延迟 | 成本 | 评估状态
├── 点击行 → 展开详情
│   ├── 完整输入 / 完整输出
│   ├── Tool 调用链可视化（树形）
│   ├── 引用的 KB citations
│   └── 评估按钮：✅ 正确 | ❌ 错误 | ⚠️ 部分正确 + 评论
└── 上方 KPI 看板
    ├── 24h 总调用数
    ├── 总成本（按模型）
    ├── 平均延迟
    └── 评估准确率（已标注样本）
```

### 4.4 实现复杂度

```
[ ] 数据库表 1 张：50 行 SQL
[ ] Trace 写入：在 invoke() 中 5 行代码
[ ] Studio Trace 页：1 个 React 表格 + 详情 Modal
预计：2 工程师天
```

**关键**：必须在 Phase A 就做。否则上线后才补，所有早期数据都没 trace。

---

## 五、P0 问题：统一 Approval Framework

### 5.1 现状问题

当前 HITL 工单审批硬编码在 `hitl/workorder_fsm.py`。

但是工业场景中很多 Action 都需要审批：

- `shelve_alarm`（搁置告警 > 1 小时）→ 需要主管审批
- `record_production`（录入超过历史均值 ±20% 的产量）→ 需要主管复核
- `create_workorder`（紧急工单）→ 需要主管授权
- `approve_kb_l3`（L3 知识发布）→ 需要 KB Admin

如果每种都硬编码，会成为代码灾难。

### 5.2 修正：统一 Approval Queue

```python
# infra/approval_queue.py
class ApprovalRequest(BaseModel):
    id: UUID
    action_name: str
    action_input: dict
    requester_user_id: str
    station_id: str
    risk_level: Literal["LOW", "MEDIUM", "HIGH"]
    requires_approver_roles: list[str]
    created_at: datetime
    expires_at: datetime
    status: Literal["pending", "approved", "rejected", "expired"]
    decided_by: str | None
    decided_at: datetime | None
    decision_reason: str | None

class ApprovalQueue:
    """所有需要审批的 Action 走同一个队列"""

    @staticmethod
    async def request(action: Action, input: BaseModel, requester: Actor) -> ApprovalRequest:
        req = ApprovalRequest(
            id=uuid4(),
            action_name=action.name,
            action_input=input.model_dump(),
            requester_user_id=requester.user_id,
            station_id=getattr(input, "station_id", requester.primary_station_id),
            risk_level=action.safety.risk_level,
            requires_approver_roles=action.safety.requires_approval_from or ["supervisor"],
            created_at=now(),
            expires_at=now() + timedelta(hours=24),
            status="pending",
        )
        await db.save(req)
        await NotifierPort.send_approval_card(req)   # 推飞书
        return req

    @staticmethod
    async def decide(req_id: UUID, decision: str, approver: Actor, reason: str | None) -> None:
        req = await db.get(ApprovalRequest, req_id)
        if approver.role not in req.requires_approver_roles:
            raise PermissionError("无审批权限")
        req.status = decision
        req.decided_by = approver.user_id
        req.decided_at = now()
        req.decision_reason = reason
        await db.save(req)

        if decision == "approved":
            # 重新走一次 invoke，但 skip approval check
            action = ActionRegistry.get(req.action_name)
            input = action.input_model(**req.action_input)
            await invoke(action, input, ApprovalGrantedActor(req), skip_approval=True)
```

**收益**：

- 任何 Action 加 `requires_approval=True` 即可获得审批能力
- 工单审批只是 Approval Queue 的一种特例
- Studio `/admin/approvals` 一个页面看所有待审

---

## 六、P1 问题：项目结构（Clean Architecture 化）

### 6.1 现状的混乱

```
platform-api/
├── routers/        # ✅ 入口
├── kafka/          # ⚠️ 入口（事件消费），但和 routers 不同名
├── services/       # ❌ 命名混淆：feishu.py 是 IO 客户端，但 kb_service.py 是业务
├── ims/            # ⚠️ IO 适配器，但单独命名
├── hitl/           # ⚠️ 业务逻辑，但单独命名
├── kb/             # ⚠️ 业务逻辑，但单独命名
├── scheduler/      # ✅ 后台
└── db/             # ✅ DB
```

### 6.2 修正后

见 §3.3 的目录结构。要点：

- `core/` 全是业务（Action / Query / Domain / Ports）
- `adapters/` 全是 IO 实现
- `interfaces/` 全是入口（HTTP / MCP / CLI）
- `workers/` 全是后台
- `infra/` 启动配置

**Phase A 改动量**：

- 改 ~20 个 import 路径（半天工作量）
- 但能避免之后 6 个月的混乱命名

---

## 七、P2 问题：Memory（Phase B 启动）

### 7.1 工业 Memory 的特殊性

不是 ChatGPT 那种"记得用户喜好"，而是**工程师工作上下文持久化**：

```
工程师 A 在周一发现：「P-002 漏点，待复检」
→ 系统记住，周三主动提醒："P-002 漏点 2 天前发现，需复检"
→ 与 WO-123 自动关联（如果该工单后续创建）

工程师 B 早会说："今天检修 C-001 主轴轴承"
→ 系统在工程师查看 C-001 时显示："今天计划检修主轴轴承"
```

### 7.2 数据库设计（Phase B）

```sql
CREATE TABLE work_memories (
    id              UUID PRIMARY KEY,
    user_id         VARCHAR(20) NOT NULL,
    station_id      VARCHAR(20) NOT NULL,
    equipment_id    VARCHAR(50),                       -- 关联设备（可空）
    memory_type     VARCHAR(30) NOT NULL,
                    -- pending_followup | observation | decision | shift_handover
    title           VARCHAR(200),
    content         TEXT NOT NULL,
    embedding       VECTOR(1024),                      -- pgvector，可被 AI 检索
    related_workorder_id  VARCHAR(20),
    related_alarm_id      VARCHAR(50),
    source_session_id     VARCHAR(50),                 -- OpenClaw session id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,                       -- 自动过期
    status          VARCHAR(20) DEFAULT 'active'       -- active | resolved | expired
);
```

通过 MCP 暴露：

```python
@mcp.tool()
async def remember(content: str, equipment_id: str = None, expires_days: int = 7): ...

@mcp.tool()
async def recall(query: str, equipment_id: str = None) -> list[Memory]: ...
```

LLM 自然就会用："我记一下这件事" / "C-001 上周说了什么？"

---

## 八、P2 问题：Background Agent（Phase B 启动）

### 8.1 用例

- 「过夜分析」：23:00 触发"分析全场站今日趋势，明早 7:00 给出报告"
- 「持续监控」：连续 4 小时跟踪 P-001 流量异常变化
- 「批量回填」：分析过去 30 天告警，找出共性根因

### 8.2 设计要点（Phase B 设计，不是 Phase A 实现）

```
后台 Agent 任务表（任务可以跑数小时）：
  bg_agent_jobs
    id, kind, params, status, agent_runtime,
    created_by, created_at, started_at, completed_at,
    progress_pct, result_url, error_msg

执行器：
  workers/bg_agent_runner.py
    - 从队列取任务
    - 通过 AgentConnector 启动 OpenClaw 长任务
    - 定期写 progress
    - 完成后通过 Notifier 推送

UI：
  /studio/admin/bg-jobs  实时进度 + 结果查看
```

不写 Phase A 代码，但 **Action 框架** 应该预留 `is_long_running: bool` 字段。

---

## 九、立即执行的修正清单

### P0（影响 Phase A 开发，必须做）

```
[ ] 1. 创建 Action 框架（core/actions/base.py + invoke.py）
        预计：1 工程师天
        影响：所有写操作（acknowledge_alarm / approve_workorder / ...）走统一框架

[ ] 2. 创建 LLM Trace 表 + 写入逻辑
        预计：1 工程师天
        影响：所有 Action 和 LLM 调用自动落 trace

[ ] 3. 创建 Approval Queue
        预计：1 工程师天
        影响：HITL 工单审批改为 Approval Queue 的一个 Action 类型

[ ] 4. 调整项目结构（core / adapters / interfaces / workers / infra）
        预计：0.5 工程师天（改 import）
        影响：所有后端代码模块命名重构（不影响业务）
```

### P1（Phase A 中后期补齐）

```
[ ] 5. Studio /admin/traces 页面（LLM 追溯 + 评估）
        预计：1 工程师天
        作为 M5 (Week 9-10) 任务

[ ] 6. Studio /admin/approvals 统一审批中心
        预计：1 工程师天
        作为 M5 (Week 9-10) 任务
```

### P2（Phase B）

```
[ ] 7. work_memories 表 + Memory MCP Tools
[ ] 8. Background Agent 框架
```

### P3（Phase C，远期）

```
[ ] 9. Computer-Use 兜底（用 Anthropic Computer Use API 操作客户没有 API 的旧 ERP）
```

---

## 十、修正后的核心架构图

```
┌────────────────────────────────────────────────────────────────────┐
│                         用户 / 智能体                                │
│  Studio UI    Feishu Bot    OpenClaw Agent (LLM)    clawtwin CLI    │
└────────────────────────────────────────────────────────────────────┘
            │              │                  │              │
            ▼              ▼                  ▼              ▼
┌────────────────────────────────────────────────────────────────────┐
│                  Nexus interfaces/（统一入口层）                     │
│   FastAPI HTTP    MCP Server (fastmcp)    Typer CLI    Webhooks     │
│        │              │                       │            │        │
│        └──────────────┴───────────┬───────────┴────────────┘        │
│                                   │                                  │
│                                   ▼                                  │
│              invoke(Action, Input, Actor, Transport)                 │
│                  │                                                   │
│         ┌────────┴────────────┬──────────────────┬──────────┐       │
│         │                     │                  │          │       │
│         ▼                     ▼                  ▼          ▼       │
│   ┌──────────┐         ┌────────────┐     ┌──────────┐ ┌────────┐  │
│   │ AuthZ    │         │ RateLimit  │     │ Approval │ │ Trace  │  │
│   │ ABAC+RBAC│         │            │     │ Queue    │ │ Audit  │  │
│   └────┬─────┘         └─────┬──────┘     └────┬─────┘ └───┬────┘  │
└────────┼────────────────────┼──────────────────┼───────────┼──────┘
         └────────────────────┴──────────────────┴───────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                         core/（领域逻辑）                            │
│                                                                      │
│   Actions（写）                Queries（读）             Domain      │
│   ─────────────                 ─────────────            ────────    │
│   AcknowledgeAlarm              GetEquipmentContext      Equipment   │
│   ShelveAlarm                   SearchKnowledge          Alarm FSM   │
│   CreateWorkOrder               GetDecisionPackage       WorkOrderFSM│
│   ApproveWorkOrder              GetMorningBriefing       Knowledge   │
│   RecordProduction              ListActiveAlarms                     │
│   ...                                                                │
│                                                                      │
│            通过 Ports（抽象接口）依赖外部                              │
│                              │                                       │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                       adapters/（IO 实现）                          │
│                                                                      │
│   SQLAlchemy Repos    LlamaIndex RAG    OpenClaw AgentConnector     │
│   Redis Shadow        lark-oapi Notifier   asyncua OPC-UA           │
│   bge-m3 Embedder     pgvector VectorStore   Prometheus Metrics     │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                  外部基础设施（Phase A：4 服务）                     │
│   PostgreSQL(TS+pgvector)    Redis    vLLM    OpenClaw             │
└────────────────────────────────────────────────────────────────────┘

★ workers/ 后台单独运行（同样调 invoke()）：
   APScheduler 定时任务    Redis Streams 事件消费    Background Agent (Phase B)
```

---

## 十一、对照评估：本架构 vs 业界顶级产品

| 能力维度         | Palantir AIP     | Anthropic Claude  | Cognition Devin     | **ClawTwin (修正后)**    |
| ---------------- | ---------------- | ----------------- | ------------------- | ------------------------ |
| Tool/Action 框架 | ★★★★★ ActionType | ★★★★★ tool_use    | ★★★★                | **★★★★ Action+Invoke**   |
| LLM Trace        | ★★★★★            | ★★★★              | ★★★★ Devin Sessions | **★★★★ llm_traces**      |
| Approval / HITL  | ★★★★★            | ★★★               | ★★★★                | **★★★★ ApprovalQueue**   |
| Memory 系统      | ★★★              | ★★★★ Memory       | ★★★★                | **★★ → Phase B ★★★★**    |
| 多 Agent         | ★★★★             | ★★★ subagents     | ★★★★                | **★★ OpenClaw subagent** |
| Computer Use     | ★★               | ★★★★ Computer Use | ★★★★                | **❌ → Phase C**         |
| 工业领域适配     | ★★★ Foundry      | ★                 | ★                   | **★★★★★（核心优势）**    |
| 私有化部署       | ★★★              | ★★                | ★★                  | **★★★★★（核心优势）**    |

**结论：修正后的 ClawTwin 在工业 + 私有化两条核心赛道上**具备业界顶级架构基础**，AI 通用能力维度紧跟 2026 年趋势。**

---

## 十二、与既有文档的关系

| 文档                        | 关系                                                    |
| --------------------------- | ------------------------------------------------------- |
| `DEVELOPMENT-CONTRACT.md`   | 加入 P0 修正（Action / Trace / Approval）作为新铁律     |
| `MODULE-DESIGN-PLATFORM.md` | 项目结构改为 §3.3 / §6.2 的 Clean Architecture 版本     |
| `CURSOR-MULTITASK-GUIDE.md` | 在 [T2] 之后插入新任务 [T2.5] Action 框架 + Trace       |
| `DEVELOPMENT-MILESTONES.md` | M1 增加 "Action 框架就绪"；M5 增加 "/admin/traces 页面" |
| `clawtwin-project/SKILL.md` | 增加铁律 21（Action 框架）+ 铁律 22（Trace 必写）       |

---

_本文档是 ClawTwin 核心架构的最后一次系统性升级建议。_  
_所有修正都聚焦"五年内不会改的骨架"，不再涉及枝叶。_  
_完成本文档建议的 P0 后即可进入开发，P1/P2 在对应阶段补齐。_
