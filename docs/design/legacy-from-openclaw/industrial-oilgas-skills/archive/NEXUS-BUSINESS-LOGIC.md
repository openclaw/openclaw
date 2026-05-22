# ClawTwin Nexus 内部架构与业务逻辑深度设计

**版本**：1.1，2026-05-11（新增 Pulse Engine 和 Action Policy Engine）  
**性质**：开发者级别架构文档，描述 Nexus 的运转逻辑  
**目标**：开发者读完本文档后，能在脑中形成完整的系统运行图像

**Nexus 八大引擎（最新版）**：

```
本体引擎（Ontology）     设备类型/指标/行动定义，进程内缓存
孪生运行时（Twin）       实时状态快照，Redis + TimescaleDB
知识引擎（Knowledge）    L0-L3 RAG检索，bge-m3 向量化
行动引擎（Action）       工单 FSM，HITL 审批，CMMS 同步
★脉搏引擎（Pulse）      站场健康计算，主动预警，预备分析   ← v1.1 新增
★策略引擎（Policy）     AI 自主度策略，行动自动化规则      ← v1.1 新增
智能调度（Intelligence） AI 任务队列，Skill 触发，结果回调
安全控制（Security）     JWT+ABAC，审计日志，权限边界
```

---

## 一、核心认知：Nexus 的三类操作

所有进入 Nexus 的操作，本质上只有三种类型。理解这三种类型是理解整个系统的钥匙。

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Type 1：传感操作（Sensor Operations）                                    │
│                                                                         │
│  特征：高频（每秒数百条）/ 无事务 / 允许少量丢失 / 不需要强一致性           │
│  来源：OPC-UA Bridge → Kafka → IngestPipeline                           │
│  去向：TimescaleDB（持久化）+ Redis（实时缓存）+ SSE（推送 Studio）        │
│                                                                         │
│  例子：压力读数、温度读数、振动值的实时写入                                 │
│  处理模式：流水线（Pipeline），满则丢弃（背压保护），不阻塞业务线程           │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Type 2：业务操作（Business Operations）                                   │
│                                                                         │
│  特征：中频（每分钟数十次）/ 有事务 / 不允许丢失 / 强一致性 / 有状态机      │
│  来源：Studio（User JWT）/ 飞书 HITL 回调 / Connect 连接器回调            │
│  去向：PostgreSQL（主数据）+ 事件总线（副作用）                             │
│                                                                         │
│  例子：工单审批、告警确认、班次交接、用户权限变更                           │
│  处理模式：事务（Transaction）+ 领域事件（Domain Event）                   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Type 3：智能操作（Intelligence Operations）                               │
│                                                                         │
│  特征：低频（每小时数次）/ 异步 / 可重试 / 最终一致性 / 高价值             │
│  来源：Studio /v1/ai/jobs / Scheduler 定时任务                           │
│  去向：Redis 队列 → Sage/Skill 处理 → 工单/知识库                         │
│                                                                         │
│  例子：AI 诊断、知识文档向量化、MOIRAI 异常检测、晨报生成                  │
│  处理模式：任务队列（Queue）+ 异步 Worker + 结果回调                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键原则**：三类操作使用不同的处理路径，互不阻塞。  
传感操作的量大，但不能影响业务操作的响应时间。  
智能操作的时延高，但不能让用户等在那里。

---

## 二、事件驱动核心（Internal Event Bus）

Nexus 内部采用轻量事件总线。所有业务状态变更都**先写数据库，再发事件**，事件的订阅者负责副作用（通知、同步、学习）。

### 2.1 为什么需要事件总线

```python
# ❌ 错误模式：副作用内联（紧耦合，难测试，故障级联）
async def approve_workorder(wo_id: str):
    wo.state = "approved"
    await db.commit()
    await feishu_push.send_card(...)    # 飞书挂了 → 审批失败？
    await cmms_connector.push(...)      # CMMS 挂了 → 审批失败？
    await sse_publisher.emit(...)       # 如果有 10 个订阅者都要加在这里

# ✅ 正确模式：事件总线（松耦合，易测试，副作用独立降级）
async def approve_workorder(wo_id: str):
    wo.state = "approved"
    await db.commit()
    await event_bus.emit(WorkOrderStateChanged(
        wo_id=wo_id, old_state="pending", new_state="approved"
    ))
    # 飞书通知、CMMS 同步、SSE 推送都是独立订阅者，任何一个失败不影响审批
```

### 2.2 Nexus 事件目录（完整）

```python
# core/events.py — 领域事件定义

from dataclasses import dataclass
from datetime import datetime

# ── 传感器域事件 ──────────────────────────────────────────────────
@dataclass
class ThresholdBreached:
    """传感器值突破阈值"""
    equipment_id: str
    metric: str
    value: float
    threshold: float
    level: str          # "warn" | "alarm"
    timestamp: str

@dataclass
class AnomalyPredicted:
    """MOIRAI 预测到异常趋势"""
    equipment_id: str
    anomaly_score: float
    predicted_at: str
    forecast_horizon_h: int

# ── 告警域事件 ──────────────────────────────────────────────────
@dataclass
class AlarmCreated:
    alarm_id: str
    equipment_id: str
    station_id: str
    level: str          # "P1" | "P2" | "P3"
    metric: str
    message: str

@dataclass
class AlarmStateChanged:
    alarm_id: str
    old_state: str      # "active" | "acknowledged" | "shelved" | "resolved"
    new_state: str
    changed_by: str

# ── 工单域事件 ──────────────────────────────────────────────────
@dataclass
class WorkOrderCreated:
    wo_id: str
    equipment_id: str
    station_id: str
    created_by: str
    is_ai_generated: bool

@dataclass
class WorkOrderStateChanged:
    wo_id: str
    old_state: str
    new_state: str
    changed_by: str
    comment: str = ""

@dataclass
class WorkOrderCompleted:
    """工单完成 → 触发知识回流"""
    wo_id: str
    equipment_id: str
    station_id: str
    repair_notes: str
    actual_cause: str

# ── 知识域事件 ──────────────────────────────────────────────────
@dataclass
class KBDocumentIngested:
    document_id: str
    title: str
    layer: str          # "L0" | "L1" | "L2" | "L3"
    chunk_count: int
    station_id: str | None

# ── AI 任务域事件 ──────────────────────────────────────────────
@dataclass
class AIJobQueued:
    job_id: str
    job_type: str       # "diagnose" | "analyze_pid" | "shift_summary"
    station_id: str
    equipment_id: str | None
    requested_by: str

@dataclass
class AIJobCompleted:
    job_id: str
    job_type: str
    result_summary: str
    wo_id: str | None   # 如果 AI 创建了工单
```

### 2.3 事件订阅映射

```
事件                      订阅者（副作用处理者）
──────────────────────────────────────────────────────────────────────
ThresholdBreached       → alarm_manager（创建告警）
AnomalyPredicted        → alarm_manager（创建预测告警）

AlarmCreated (P1)       → feishu_push（推送值班群紧急卡片）
                         → sse_publisher（推送 Studio InvestigationBanner）
AlarmCreated (P2/P3)    → feishu_push（推送值班群普通卡片）
                         → sse_publisher（更新 Studio AlarmBadge）

WorkOrderCreated        → sse_publisher（Studio 工单列表刷新）
                         → feishu_push（通知相关人员）
WorkOrderStateChanged   → sse_publisher（Studio 工单状态更新）
→ new_state=="approved"  → cmms_connector（推送到 CMMS 系统）
                         → feishu_push（通知审批结果）
→ new_state=="pending"   → feishu_oa（发起飞书 OA 审批）

WorkOrderCompleted      → kb_l3_writer（提取经验写入 L3 知识库）
                         → analytics_updater（更新设备 MTBF/MTTR 统计）
                         → feishu_push（通知完成）

AIJobQueued             → ai_job_worker（触发 Sage Skill）
AIJobCompleted          → sse_publisher（推送 Studio AI_JOB_DONE 事件）
                         → feishu_push（如果有工单草稿，推飞书卡片）
```

### 2.4 轻量事件总线实现（Phase A）

```python
# core/event_bus.py
import asyncio
from collections import defaultdict
from typing import Callable, Any
import structlog

log = structlog.get_logger()

class EventBus:
    """
    内存事件总线（Phase A）。
    Phase B 可替换为 Redis Pub/Sub 或 Kafka，接口不变。
    """
    def __init__(self):
        self._subscribers: dict[type, list[Callable]] = defaultdict(list)

    def subscribe(self, event_type: type, handler: Callable):
        self._subscribers[event_type].append(handler)

    async def emit(self, event: Any):
        event_type = type(event)
        handlers = self._subscribers.get(event_type, [])
        if not handlers:
            return
        # 并发执行所有订阅者，单个失败不影响其他
        results = await asyncio.gather(
            *[handler(event) for handler in handlers],
            return_exceptions=True
        )
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                log.error("event_bus.handler_failed",
                          event=event_type.__name__,
                          handler=handlers[i].__name__,
                          error=str(result))

event_bus = EventBus()  # 全局单例
```

---

## 三、六大业务流程（完整泳道图）

### Flow 1：OT 数据 → 实时孪生 → Studio 显示

```
OPC-UA       Bridge       Kafka        Nexus IngestPipeline    Redis    Studio
  │             │            │                 │                 │         │
  │──订阅节点──►│            │                 │                 │         │
  │             │──push msg─►│                 │                 │         │
  │             │            │──consume(100ms)─►│                 │         │
  │             │            │                 │──batch_insert──►DB        │
  │             │            │                 │──update cache──►│         │
  │             │            │                 │                 │──SSE──►│
  │             │            │                 │                 │    读数更新│
  │             │            │                 │                 │         │
  │             │            │  [阈值检查]      │                 │         │
  │             │            │                 │──emit(ThresholdBreached)  │
  │             │            │                 │         │                 │
  │             │            │                 │      alarm_manager        │
  │             │            │                 │         │──create alarm──►DB
  │             │            │                 │         │──emit(AlarmCreated)
  │             │            │                 │                 │──SSE──►│
  │             │            │                 │                 │   告警弹出│

关键：整个 OT 数据流在独立线程（asyncio 任务），不阻塞 HTTP 请求处理
```

### Flow 2：用户飞书消息 → AI 诊断 → 工单草稿 → 飞书审批

```
操作员(飞书)  OpenClaw    Sage Skill   Nexus(Tool API)  GPU Server  飞书OA
   │            │             │              │               │          │
   │─"C-001振动大"─►│         │              │               │          │
   │            │─路由到Skill─►│             │               │          │
   │            │             │─GET /context─►│              │          │
   │            │             │◄─设备数据─────│              │          │
   │            │             │─POST /kb/srch►│              │          │
   │            │             │◄─知识块───────│              │          │
   │            │             │─构建Prompt────────────────►  │          │
   │            │             │◄─诊断结论─────────────────── │          │
   │            │             │─POST /workorders/ai-draft──►  │          │
   │            │             │              │──创建工单(draft)          │
   │            │             │              │──emit(WorkOrderCreated)   │
   │            │             │◄─{wo_id}─────│              │          │
   │            │◄─诊断摘要───│              │              │          │
   │◄─飞书回复──│             │              │              │          │
   │ (AI诊断结论+工单链接)     │              │              │          │
   │            │             │              │              │          │
   │─"确认提交"─►│            │              │              │          │
   │            │─POST /submit────────────►  │              │          │
   │            │             │              │──state→pending            │
   │            │             │              │──emit(WorkOrderStateChanged)
   │            │             │              │              │──发起审批─►│
   │            │             │              │              │          │
   管理员(飞书)  │             │              │              │          │
   │◄─────────────────────────────────────────────────────审批卡片─────│
   │─"批准"─────────────────────────────────────────────────────────►  │
   │            │             │              │◄─OA回调──────────────────│
   │            │             │              │──state→approved           │
   │            │             │              │──emit(WorkOrderStateChanged)
   │            │             │              │──push to CMMS             │
   │            │             │              │──SSE→Studio               │
```

### Flow 3：Studio 用户触发 AI 分析

```
Studio       Nexus            Redis Queue    AIJobWorker    OpenClaw/Sage
  │              │                 │              │              │
  │─POST /ai/jobs►│               │              │              │
  │              │─验证权限         │              │              │
  │              │─创建 AIJob(queued)              │              │
  │              │─LPUSH ai_jobs──►│              │              │
  │◄─{job_id}───│                 │              │              │
  │             [用户继续工作，不等待]│              │              │
  │              │                 │─BRPOP────────►│             │
  │              │                 │              │─触发Skill────►│
  │              │                 │              │              │
  │              │                 │              │[同 Flow 2 推理过程]
  │              │                 │              │              │
  │              │                 │              │◄─结果─────── │
  │              │                 │              │─POST /ai-draft►│(Nexus)
  │              │◄──────────────────────── 工单创建│              │
  │              │─emit(AIJobCompleted)            │              │
  │◄─SSE: AI_JOB_DONE─│           │              │              │
  │─GET /ai/jobs/xxx─►│            │              │              │
  │◄─{结果+wo_id}───   │           │              │              │
  │─显示 WorkOrderDraftInline      │              │              │
```

### Flow 4：工单完整生命周期（HITL FSM）

```
状态机转换路径：

  [创建]
    · 手动创建：操作员 POST /workorders → draft
    · AI 创建：Sage Skill POST /tools/workorders/ai-draft → draft

  draft ──submit──► pending_approval
    · 触发：POST /workorders/{id}/submit
    · 副作用：飞书 OA 发起审批 + SSE 推送

  pending_approval ──approve──► approved
    · 触发：飞书 OA 回调 → POST /feishu/oa/callback → approve
    · 副作用：推送 CMMS + SSE + 飞书通知审批结果

  pending_approval ──reject──► draft
    · 触发：飞书 OA 回调 → reject
    · 副作用：SSE 推送 + 飞书通知（含驳回原因）

  approved ──start──► executing
    · 触发：维修人员 POST /workorders/{id}/start
    · 副作用：CMMS 更新状态 + SSE

  executing ──complete──► done
    · 触发：POST /workorders/{id}/complete（含完工备注）
    · 副作用：
        1. CMMS 关闭工单
        2. emit(WorkOrderCompleted)
        3. L3 知识提炼（异步）：完工备注 → 向量化 → Milvus
        4. MTBF/MTTR 统计更新

  任意状态 ──cancel──► cancelled
    · 需要 admin 或 manager 角色

  [非法转换直接返回 400]
```

### Flow 5：MOIRAI 时序异常检测（后台定时任务）

```
APScheduler(30s)   Nexus Scheduler   MOIRAI Service   AlarmEngine   飞书
      │                  │                 │               │           │
      │─触发anomaly_job──►│                 │               │           │
      │                  │─读活跃设备列表    │               │           │
      │                  │─FOR each equipment:              │           │
      │                  │─读最近2h读数──────►（无需AI）       │           │
      │                  │─POST /predict──────►│            │           │
      │                  │◄─{score, forecast}─ │            │           │
      │                  │                     │            │           │
      │                  │  [score > 0.85]      │            │           │
      │                  │─emit(AnomalyPredicted)           │           │
      │                  │                     │──处理事件──►│           │
      │                  │                     │            │─创建预测告警│
      │                  │                     │            │─P2 级别    │
      │                  │                     │            │─emit(AlarmCreated)
      │                  │                     │            │           │
      │                  │                     │◄─SSE→Studio(AlarmBadge更新)
      │                  │                     │────推送飞书告警卡片───────►│
      │                  │                     │            │           │
      │                  │  [score <= 0.85]     │            │           │
      │                  │─更新设备健康分（无告警）│            │           │
```

### Flow 6：知识文档摄入（Admin 上传 → RAG 可用）

```
Admin(Studio)    Nexus API     IngestWorker      bge-m3       Milvus
    │               │               │              │              │
    │─POST /kb/docs─►│              │              │              │
    │               │─存 KBDocument(pending)        │              │
    │               │─存文件到 MinIO/磁盘            │              │
    │               │─LPUSH ingest_tasks───────────►│             │
    │◄─{doc_id,pending}─│           │              │              │
    │               │               │─BRPOP────────►│             │
    │               │               │─读文件         │              │
    │               │               │─LlamaIndex 分块│              │
    │               │               │─FOR each chunk:│              │
    │               │               │─embed(chunk)──►│              │
    │               │               │◄─vector(1024d)─│              │
    │               │               │─insert(vec,meta)────────────►│
    │               │               │─更新进度(20/100 chunks)        │
    │               │               │                              │
    │               │◄─SSE: doc_progress(%)─────────────────────── │
    │◄─进度更新───── │               │              │              │
    │               │               │─完成→emit(KBDocumentIngested)│
    │               │─UPDATE status=indexed          │              │
    │◄─SSE: doc_done─│               │              │              │
    │               │               │              │              │
    [此后 POST /v1/kb/search 可检索到新文档]
```

---

## 四、状态机正式定义

### 4.1 WorkOrder 状态机

```python
# engines/action/workorder_fsm.py

WORKORDER_TRANSITIONS = {
    # (current_state, action) → (new_state, allowed_roles)
    ("draft",              "submit"):   ("pending_approval", ["operator", "engineer", "manager"]),
    ("draft",              "cancel"):   ("cancelled",        ["manager", "admin"]),
    ("pending_approval",   "approve"):  ("approved",         ["manager", "admin"]),
    ("pending_approval",   "reject"):   ("draft",            ["manager", "admin"]),
    ("pending_approval",   "cancel"):   ("cancelled",        ["manager", "admin"]),
    ("approved",           "start"):    ("executing",        ["operator", "engineer", "manager"]),
    ("approved",           "cancel"):   ("cancelled",        ["manager", "admin"]),
    ("executing",          "complete"): ("done",             ["operator", "engineer", "manager"]),
    ("executing",          "cancel"):   ("cancelled",        ["manager", "admin"]),
}

# 终止状态（不可再转换）
TERMINAL_STATES = {"done", "cancelled"}

# 触发副作用的转换
SIDE_EFFECT_TRANSITIONS = {
    "pending_approval": "feishu_oa_approval",  # 发起飞书审批
    "approved":         "cmms_push",           # 推送到 CMMS
    "done":             "l3_knowledge",        # 经验回流知识库
}
```

### 4.2 Alarm 状态机

```python
ALARM_TRANSITIONS = {
    ("active",       "acknowledge"): ("acknowledged", ["operator", "engineer", "manager"]),
    ("active",       "shelve"):      ("shelved",      ["operator", "engineer", "manager"]),
    ("active",       "resolve"):     ("resolved",     ["engineer", "manager"]),
    ("acknowledged", "shelve"):      ("shelved",      ["operator", "engineer", "manager"]),
    ("acknowledged", "resolve"):     ("resolved",     ["engineer", "manager"]),
    ("shelved",      "activate"):    ("active",       ["system"]),  # 屏蔽期过后自动激活
    ("shelved",      "resolve"):     ("resolved",     ["engineer", "manager"]),
}

# P1 告警不能被 shelve（ISA-18.2 要求）
P1_FORBIDDEN_ACTIONS = {"shelve"}
```

### 4.3 AIJob 状态机

```python
AIJOB_TRANSITIONS = {
    ("queued",  "start"):  "running",
    ("running", "done"):   "done",
    ("running", "fail"):   "failed",
    ("queued",  "cancel"): "cancelled",
}

# 失败重试策略
MAX_RETRIES = 2
RETRY_DELAY_S = 30
```

---

## 五、六个领域边界（Bounded Contexts）

Nexus 内部有六个职责清晰的领域。每个领域拥有自己的数据，不跨域直接访问数据库。

```
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 1：Equipment（设备域）                                           │
│    拥有：equipment 表 / equipment_readings 超表 / pid_layouts           │
│    对外：提供设备状态快照 API / 读数查询 / 本体定义                        │
│    只做：设备元数据管理 / 读数存储 / 状态缓存                               │
│    不做：告警判断（告警域）/ AI 诊断（Sage）/ 工单（操作域）               │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 2：Operation（操作域）                                           │
│    拥有：work_orders 表 / work_order_history 表 / shifts 表             │
│    对外：工单 CRUD / FSM 状态转换 / 班次管理                              │
│    只做：工单生命周期 / 审批流驱动 / 班次记录                               │
│    不做：设备读数（设备域）/ AI 推理（Sage）                               │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 3：Alarm（告警域）                                               │
│    拥有：alarms 表                                                       │
│    对外：告警 CRUD / 状态管理 / ISA-18.2 分级                            │
│    只做：告警创建/确认/屏蔽/解除                                           │
│    依赖：设备域（获取设备信息）/ 事件总线（接收 ThresholdBreached）         │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 4：Knowledge（知识域）                                           │
│    拥有：kb_documents 表 / ingest_tasks 表 / Milvus collection          │
│    对外：知识搜索 / 文档上传 / 摄入进度                                   │
│    只做：文档管理 / 向量化 / RAG 检索                                     │
│    依赖：embed_client（bge-m3）/ Milvus                                  │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 5：Intelligence（智能域）                                        │
│    拥有：ai_jobs 表                                                      │
│    对外：AI 任务提交 / 状态查询                                           │
│    只做：任务队列 / Worker 调度 / 结果存储                                 │
│    不做：AI 推理本身（在 Sage）                                            │
└────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────┐
│  Domain 6：Identity（身份域）                                            │
│    拥有：users 表 / user_stations 表 / audit_logs 表                    │
│    对外：认证 / 权限检查 / 审计日志                                       │
│    只做：JWT 管理 / ABAC 策略 / 飞书绑定 / 审计写入                       │
│    特殊：所有其他域的操作都必须经过本域的权限检查                            │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1 领域间通信规则

```
Domain A → Domain B 的合法通信方式：

  方式 1：事件总线（异步，推荐）
    A 发事件 → B 订阅并处理
    适用：副作用、通知、跨域协调

  方式 2：领域服务调用（同步，谨慎）
    A 直接调用 B 的 Service 方法（不是直接查 B 的数据库）
    适用：查询 B 的当前状态以做 A 的业务决策

  方式 3：HTTP API（分布式场景，Phase B）
    A 调用 B 的 REST API
    适用：未来拆微服务时

  ❌ 绝不允许：A 直接查询 B 的数据库表
    例如：操作域禁止直接 SELECT FROM equipment_readings
    应该：调用 equipment_service.get_current_readings(equipment_id)
```

---

## 六、关键设计模式

### 6.1 Repository 模式（数据访问标准化）

```python
# 每个领域都有自己的 Repository，封装所有数据库访问
# 测试时只需 Mock Repository，不需要真实数据库

class WorkOrderRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(self, wo_id: str) -> WorkOrder | None:
        return await self.db.get(WorkOrder, wo_id)

    async def list(self, station_id: str, state: str | None = None,
                   page: int = 1, per_page: int = 20) -> tuple[list[WorkOrder], int]:
        q = select(WorkOrder).where(WorkOrder.station_id == station_id)
        if state:
            q = q.where(WorkOrder.state == state)
        total = await self.db.scalar(select(func.count()).select_from(q.subquery()))
        items = await self.db.scalars(q.offset((page-1)*per_page).limit(per_page))
        return list(items), total

    async def save(self, wo: WorkOrder) -> WorkOrder:
        self.db.add(wo)
        await self.db.flush()
        return wo
```

### 6.2 Unit of Work 模式（事务边界）

```python
# 一个业务操作 = 一个事务单元
# 事务提交后才发事件（确保数据库已落盘）

class WorkOrderService:
    def __init__(self, repo: WorkOrderRepository, event_bus: EventBus):
        self.repo = repo
        self.event_bus = event_bus

    async def submit_for_approval(self, wo_id: str, user: User) -> WorkOrder:
        wo = await self.repo.get(wo_id)
        if not wo:
            raise NotFoundError(f"工单 {wo_id} 不存在")

        # 权限检查
        if wo.station_id not in user.station_ids:
            raise PermissionError("无权操作此工单")

        # 状态机检查
        if (wo.state, "submit") not in WORKORDER_TRANSITIONS:
            raise InvalidStateError(f"工单状态 {wo.state} 不允许提交审批")

        # 执行状态转换
        old_state = wo.state
        wo.state = "pending_approval"
        wo.submitted_at = utcnow()
        wo.submitted_by = user.user_id
        wo = await self.repo.save(wo)

        # 写审计日志（同一事务内）
        await self.audit_log(wo_id, "submit", user.user_id)

        # 事务提交后发事件（副作用独立）
        await self.event_bus.emit(WorkOrderStateChanged(
            wo_id=wo_id, old_state=old_state,
            new_state="pending_approval", changed_by=user.user_id
        ))

        return wo
```

### 6.3 三层缓存策略

```
层次          数据类型                    存储          TTL
────────────────────────────────────────────────────────────
L1 进程缓存   本体定义（设备类型/阈值）    Python dict   重启失效（从 DB 加载）
L2 Redis 缓存 设备实时状态/最新读数       Redis Hash    60秒（IngestPipeline 刷新）
L3 DB 持久化  历史读数/工单/知识/审计      PostgreSQL    永久

查询优先级：
  GET /v1/readings/{id}/latest：L2 → L3
  GET /v1/equipment/{id}/primary-action：L1（本体阈值）+ L2（当前读数）→ 纯内存计算
  GET /v1/ontology/equipment-types：L1（内存）→ 返回（毫秒级）
  POST /v1/kb/search：无缓存（每次 embed + Milvus 检索，约 200ms）
```

---

## 七、性能与可靠性设计

### 7.1 "热路径"优化（响应时间目标）

```
接口                              目标响应时间    优化手段
──────────────────────────────────────────────────────────────────
GET /v1/readings/{id}/latest      < 10ms          Redis Hash 直接读
GET /v1/equipment/{id}/primary-action < 5ms       纯内存规则计算，无 DB 查询
GET /v1/ontology/equipment-types  < 5ms           进程内缓存
GET /v1/alarms（活跃）            < 50ms           Redis 缓存活跃告警列表
GET /v1/workorders（列表）        < 100ms          DB 索引优化（station_id, state）
POST /v1/kb/search                < 300ms          Milvus HNSW 索引
SSE /v1/sse/station/{id}          < 50ms（首帧）   Redis 读最新状态立即推送

POST /v1/ai/jobs                  < 100ms          只写队列，立即返回
GET /v1/ai/jobs/{id}（等结果）    30-120s         轮询或 SSE 等待
```

### 7.2 降级策略（各组件故障时的行为）

```
故障组件        影响                    降级行为
──────────────────────────────────────────────────────────────────
GPU Server      AI 诊断不可用           AI 任务标记为 failed，返回"AI 服务暂不可用"
                                        阈值告警和 MOIRAI 正常（不依赖 GPU）

Milvus          KB 检索不可用           AI 诊断跳过知识库步骤，标注"无知识库支持"

Feishu          通知不可达              日志记录 + 重试队列，Studio SSE 仍然可用

CMMS            工单同步失败            Nexus 内保存失败记录，人工重试，主流程不中断

MOIRAI          时序预测不可用          只保留阈值告警（规则触发），预测告警暂停

Redis           缓存不可用              回退到 DB 查询（性能降级但功能正常）

Kafka           OT 数据流中断           Studio 显示最后一次读数，加"数据可能过时"标记
```

### 7.3 关键指标监控（Prometheus）

```python
# 暴露在 GET /v1/metrics

工业数据指标：
  nexus_ingest_readings_total               # 累计摄入读数数量
  nexus_ingest_queue_size                   # IngestPipeline 当前队列深度
  nexus_ingest_drop_rate                    # 背压丢弃率（应 < 1%）
  nexus_active_alarms_total{level}          # 各级别活跃告警数

业务操作指标：
  nexus_workorders_total{state}             # 各状态工单总数
  nexus_workorder_approval_duration_seconds # 审批平均时长
  nexus_ai_jobs_total{status}               # AI 任务完成/失败数
  nexus_ai_job_duration_seconds             # AI 任务处理时长

系统健康指标：
  nexus_http_request_duration_seconds{path} # API 响应时间
  nexus_db_pool_size                        # DB 连接池使用情况
  nexus_event_bus_lag                       # 事件总线积压
```

---

## 八、扩展点设计（如何在不改核心的情况下扩展）

### 8.1 新增设备类型（无需改代码）

```
Step 1：Admin UI 配置本体
  POST /v1/ontology/equipment-types
  { "type_id": "gas_turbine", "name_zh": "燃气轮机", ... }
  POST /v1/ontology/equipment-types/gas_turbine/metrics
  POST /v1/ontology/equipment-types/gas_turbine/actions

Step 2：上传设备手册到 KB
  POST /v1/kb/documents
  { "file": "gas_turbine_manual.pdf", "layer": "L1" }

Step 3：配置 Sage Prompt 模板
  在 prompts/diagnosis/gas_turbine_v1.txt 添加设备专属诊断提示词

Step 4：验证
  触发一次诊断，检查 AI 是否引用了新的知识库内容

结果：新设备类型完全可用，Studio 自动显示正确的指标和行动按钮
```

### 8.2 新增企业连接器（插件化）

```python
# 任何团队可以按以下接口开发连接器，无需修改 Nexus 核心

# Step 1：继承 ITConnector
class SAPConnector(ITConnector):
    connector_id = "sap_erp"
    connector_type = "it"

    async def push_work_order(self, workorder: dict) -> str:
        # 调用 SAP PM 模块 API
        ...

    async def pull_user_org(self) -> list[dict]:
        # 从 SAP HR 模块拉取组织架构
        ...

# Step 2：注册到 Nexus
# connectors/registry.py
register_connector("sap_erp", SAPConnector)

# Step 3：Admin 配置连接器参数
# PUT /v1/admin/connectors/sap_erp/config
# { "sap_host": "...", "username": "...", "password": "..." }

# Step 4：事件订阅（连接器自动响应工单状态变更）
# 无需修改任何业务代码，WorkOrderStateChanged 事件自动触发
```

### 8.3 新增 AI 技能（Sage 扩展）

```
对 Nexus 完全透明：
  Skill 开发者只需要：
    1. 调用 /v1/tools/* API 获取数据（Service Token）
    2. 调用 GPU Server vLLM 进行推理
    3. 调用 /v1/tools/workorders/ai-draft 存结果（可选）

  Nexus 不知道也不需要知道有哪些 Skill 存在
  Skill 的扩展不影响 Nexus 的任何代码
```

---

## 九、Nexus 启动顺序与依赖检查

```python
# main.py lifespan 启动顺序（顺序不可打乱）

async def lifespan(app: FastAPI):
    # 1. 配置加载（最先，其他模块依赖）
    settings = get_settings()

    # 2. 数据库连接（其他都依赖）
    await db_engine.connect()
    await run_migrations()

    # 3. Redis（缓存、队列都依赖）
    await redis_client.ping()

    # 4. Milvus（知识库依赖）
    await ensure_milvus_collection()

    # 5. 本体加载（进程内缓存，其他模块依赖）
    await ontology_registry.load_from_db()

    # 6. 连接器初始化（OT + IT）
    await connector_registry.initialize_all()

    # 7. 事件总线订阅注册（业务逻辑依赖）
    register_all_event_handlers(event_bus)

    # 8. SSE 发布者启动
    await sse_publisher.start()

    # 9. Kafka 消费者启动（OT 数据流）
    await kafka_consumer.start()

    # 10. AI Job Worker 启动（后台异步）
    asyncio.create_task(ai_job_worker.run())

    # 11. Scheduler 启动（最后，避免任务在依赖未就绪时运行）
    await scheduler.start()

    log.info("nexus.ready", version=settings.app_version)
    yield  # 运行中

    # 关闭顺序（反向）
    await scheduler.shutdown()
    await kafka_consumer.stop()
    await sse_publisher.stop()
    await connector_registry.shutdown_all()
    await db_engine.dispose()
```

---

## 十、Pulse Engine 详细实现（v1.1 新增）

### 10.1 Pulse Engine 的职责边界

```
Pulse Engine 做什么：
  ✓ 每 30 秒计算全站所有设备的健康分
  ✓ 计算站场综合脉搏指数（Station Pulse Score）
  ✓ 识别"变化中的信号"（与上次心跳对比）
  ✓ 按重要性排序，发出事件
  ✓ 当异常评分足够高时，主动触发 Sage 预备分析（不等用户）

Pulse Engine 不做什么：
  ✗ 不做 AI 推理（那是 Sage）
  ✗ 不创建工单（那是 Action Engine）
  ✗ 不直接推送飞书（通过事件总线）
  ✗ 不做复杂规则（告警阈值规则在 Alarm Engine）
```

### 10.2 Pulse Engine 与 Scheduler 的区别

```
APScheduler（定时器）    →  驱动 Pulse Engine 每30秒运行
Pulse Engine（引擎）    →  计算 + 发出事件
Event Bus（事件总线）   →  分发到各个订阅者
Alarm Engine            →  处理 ThresholdBreached 事件（创建告警）
Proactive Intelligence  →  处理 AnomalyPredicted 事件（触发 Sage）
SSE Publisher           →  处理 PulseUpdated 事件（推送 Studio）
```

### 10.3 新增事件类型

```python
# core/events.py 新增

@dataclass
class PulseUpdated:
    """每30秒全站健康刷新"""
    station_id: str
    pulse_score: float
    pulse_status: str    # "excellent" | "good" | "warning" | "critical"
    top_attention: list  # 最多3个需要关注的设备
    timestamp: str

@dataclass
class EquipmentHealthChanged:
    """设备健康状态发生显著变化（>5分）"""
    equipment_id: str
    old_score: float
    new_score: float
    direction: str       # "improving" | "declining"

@dataclass
class ProactiveAnalysisTriggered:
    """系统主动触发 AI 分析（不是用户请求）"""
    equipment_id: str
    trigger_reason: str  # "anomaly_score" | "trend_declining" | "pattern_match"
    anomaly_score: float
    ai_job_id: str
```

---

## 十一、Action Policy Engine 详细实现（v1.1 新增）

### 11.1 Phase A 的策略引擎（简化版）

Phase A 的策略引擎很简单：只定义"哪些事情可以自动做"。
不做复杂的条件评估，只做白名单式配置。

```python
# engines/action/policy_engine.py

PHASE_A_AUTO_POLICIES = [
    # 文档摄入：Admin 上传后自动向量化（100% 安全，无需人工审批）
    "auto_document_ingest",

    # 知识回流：工单完成后自动提炼 L3 经验（100% 安全）
    "auto_l3_knowledge_capture",

    # 告警确认：Pulse Engine 认为不需要人工关注的 P3 告警（可选，Phase A 默认关闭）
    # "auto_p3_alarm_ack",  # Phase B 再开启
]

def should_auto_execute(action_type: str) -> bool:
    """当前阶段是否允许自动执行此类行动"""
    return action_type in PHASE_A_AUTO_POLICIES
```

### 11.2 Phase B 的策略引擎（数据库配置版）

```python
# 策略存储在数据库，Admin 可配置
# POST /v1/admin/action-policies

class ActionPolicy(Base):
    __tablename__ = "action_policies"

    policy_id: str          # 主键
    station_id: str | None  # None = 全站适用
    action_type: str        # "acknowledge_alarm" | "close_workorder" | ...
    conditions: dict        # JSON：触发条件
    auto_execute: bool      # 是否自动执行
    notify_roles: list      # 执行后通知哪些角色
    max_daily: int          # 每日最大自动执行次数（防止失控）
    enabled: bool
    created_by: str
    approved_by: str        # 策略本身需要 manager 审批
```

---

## 十二、开发者心智模型：五个循环

```
1. 物理数据循环：
   OPC-UA → Bridge → Kafka → IngestPipeline → TimescaleDB + Redis → SSE → Studio

2. 感知循环（新增，v1.1）：
   Pulse Engine（30s） → 健康计算 → PulseUpdated 事件 → Studio 排序更新
                      → 异常检测 → AnomalyPredicted 事件 → Sage 主动分析

3. 决策循环：
   用户/系统触发 → Sage 推理（Nexus 数据 + GPU） → 工单草稿 → HITL 审批 → 执行

4. 知识循环：
   文档上传 → bge-m3 → Milvus → Sage 检索时使用
   工单完成 → 经验提炼 → L3 知识 → 下次诊断更准确

5. 自动化循环（Phase B，v1.1 规划）：
   Policy Engine → 识别可自动执行行动 → 直接执行 → 通知人 → 记录审计
```

这五个循环共同构成 ClawTwin 的**工业 AI 飞轮**：  
每个循环都在不断自我增强——感知越来越敏锐，决策越来越准确，执行越来越高效，知识越来越丰富。

---

_本文档 v1.1 更新于 2026-05-11，新增 Pulse Engine（§十）和 Action Policy Engine（§十一）。_  
_开发者在开始任何模块开发前，应先读懂三类操作（§一）、事件总线（§二）、领域边界（§五）。_
