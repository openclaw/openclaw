# ClawTwin Nexus 框架架构深度审视

# —— 对标 OpenClaw，从应用走向框架

**版本**：1.0，2026-05-11  
**性质**：架构批判 + 框架设计 + 商业模式对齐  
**核心命题**：Nexus 现在是"工业应用"，需要演进为"工业 AI 数据框架"

---

## 一、直接对比：OpenClaw 架构 vs 当前 Nexus 架构

### 1.1 OpenClaw 的精髓（从源码提炼）

读完 `src/plugin-sdk/AGENTS.md` 的核心原则，这是 OpenClaw 架构的智慧结晶：

```
原则 1："Host loads plugins; plugins should not reach through the SDK into
         arbitrary host internals"
         → 宿主单向加载插件，插件不能反向访问宿主内部

原则 2："Prefer a small versioned host/kernel seam plus narrow documented
         SDK entrypoints"
         → 小而稳定的版本化内核契约，胜过大而宽泛的便利桶

原则 3："Keep public SDK entrypoints cheap at module load"
         → 启动热路径只加载轻量合约，重逻辑推迟到 *.runtime.ts 按需加载

原则 4："If a proposed SDK export mainly exists to let setup/config/control-plane
         code execute plugin runtime, that is usually a boundary smell"
         → 控制面（配置）和执行面（运行时）必须分离

原则 5："Prefer metadata or descriptor-driven control-plane seams first"
         → 描述符驱动优于代码驱动（manifest.json 先于 if-else）
```

### 1.2 OpenClaw 的完整层次模型

```
OpenClaw 架构：

  ┌─────────────────────────────────────────────────────────────┐
  │  Channel 层（输入抽象）                                       │
  │  Telegram / Discord / iMessage / SMS / HTTP Webhook ...     │
  │  统一接口：receive(message) → envelope                       │
  ├─────────────────────────────────────────────────────────────┤
  │  Agent 层（处理核心）                                         │
  │  Session 管理 / 上下文 / 工具调用 / 审批流 / 记忆检索          │
  ├─────────────────────────────────────────────────────────────┤
  │  Provider 层（AI 模型抽象）                                   │
  │  Anthropic / OpenAI / Qwen / Gemini ...                     │
  │  统一接口：stream(prompt, tools) → token_stream             │
  ├─────────────────────────────────────────────────────────────┤
  │  Plugin SDK（插件开发契约）                                   │
  │  api.ts（轻量合约）/ runtime-api.ts（重量运行时）              │
  │  manifest.json（描述符驱动）/ contract.test.ts（契约验证）    │
  ├─────────────────────────────────────────────────────────────┤
  │  Memory / Knowledge（跨会话记忆）                             │
  │  memory-wiki CLI / *.md 文件 / 向量检索                      │
  └─────────────────────────────────────────────────────────────┘

  核心设计范式：
    · 对话驱动（Conversation-centric）：消息进，消息出
    · 插件优先（Plugin-first）：所有能力都是插件
    · 描述符驱动（Manifest-driven）：能力声明先于代码实现
    · 契约测试（Contract-tested）：每个公开接口都有合约测试
```

### 1.3 当前 Nexus 架构（如实描述）

```
当前 Nexus 架构（工业应用，非框架）：

  ┌─────────────────────────────────────────────────────────────┐
  │  路由层（HTTP API）                                           │
  │  FastAPI Routers：/v1/equipment / /v1/workorders / ...      │
  │  业务逻辑写死在 routers/ 和 services/ 中                      │
  ├─────────────────────────────────────────────────────────────┤
  │  领域服务层（Domain Services）                                │
  │  ORM 模型硬编码：Equipment / WorkOrder / Alarm / Station     │
  │  状态机硬编码：WORKORDER_TRANSITIONS / ISA-18.2             │
  │  工业概念硬编码：P&ID / OPC-UA / 设备类型 / 场站             │
  ├─────────────────────────────────────────────────────────────┤
  │  数据层                                                       │
  │  PostgreSQL（含工业专有表）/ TimescaleDB / Redis / Milvus    │
  └─────────────────────────────────────────────────────────────┘

  当前的问题：
    · 应用驱动（Application-centric）：为石油站场写的，不可复用
    · 无插件系统（No Plugin System）：扩展 = 改源代码
    · 无描述符（No Manifest）：能力散落在 if-else 和 dict 中
    · 无契约测试（No Contract Tests）：API 变更没有自动守护
    · 业务混入核心（Business in Core）：ISA-18.2 / P&ID / 工单流程都在核心里
```

---

## 二、批判性分析：五个核心问题

### 问题 1：Nexus 是"工业应用"伪装成"框架"

```
当前代码里的工业硬编码：

  db/models/equipment.py:
    equipment_type: str    # "compressor" | "pump" | "heat_exchanger"
    station_id: str        # 石油行业的"场站"概念

  db/models/alarm.py:
    level: str             # ISA-18.2 的 "P1" | "P2" | "P3"（工业标准）

  db/models/workorder.py:
    state: str             # 工单状态机（工业运维概念）

  engines/ontology/registry.py:
    EQUIPMENT_TYPE_REGISTRY  # 硬编码的设备类型 Python 字典

  routers/pid.py:
    # P&ID = 管道仪表图，纯工业概念，其他行业没有

这意味着：
  · 把 Nexus 用于制造业（工厂车间）= 需要重写 equipment/station/alarm 模型
  · 把 Nexus 用于电力行业（智能电网）= 需要重写所有领域模型
  · 把 Nexus 用于建筑行业（楼宇自动化）= 需要重写所有领域模型

结论：当前 Nexus 不是框架，是工业应用。这不是错误，但需要清醒认知。
```

### 问题 2：Sage 的定义太模糊

```
问题：
  "Sage = OpenClaw 里安装的 Skills" 这个描述缺少关键细节：

  ❓ Skills 怎么打包？npm 包？Git 仓库？ZIP 文件？
  ❓ Skills 怎么更新？自动更新？手动更新？
  ❓ Skills 的版本如何与 OpenClaw 版本保持兼容？
  ❓ 知识包如何安装？脚本？Admin API？
  ❓ 如果 OpenClaw 改了 Tool Calling 的接口，我们的 Skills 怎么跟进？
  ❓ 多个客户的 Sage 是同一份代码还是定制化的？

解决方案（见 §四 Sage 产品化方案）
```

### 问题 3：Nexus-OpenClaw 接口未形式化

```
当前状态：
  · OpenClaw Skills 调用 Nexus Tool API（有文档，有实现）✓
  · Nexus 触发 OpenClaw Skill（通过 Redis 队列 + ai_job_worker）✓
  · 但没有版本化的 API 合约文档
  · 没有合约测试（如果 Nexus 改了 /v1/tools/equipment/context 的返回格式，Skills 静默崩溃）

这类似于 OpenClaw 插件不遵守 plugin-sdk 合约——任何一方改动都会炸掉另一方。
```

### 问题 4：Pulse Engine 的业务逻辑混入了框架

```
当前设计的 Pulse Engine 里有：
  · 工业健康评分算法（传感器基线40分+趋势30分-告警扣分）← 工业业务逻辑
  · ISA-18.2 告警权重（P1扣30/P2扣15/P3扣5）← 工业标准
  · 设备类型映射（压缩机/泵/换热器）← 工业概念

一个通用框架里不应该有 ISA-18.2 引用。
健康评分应该是可插拔的策略，而不是写死的算法。
```

### 问题 5：竞争护城河不够深

```
当前护城河：
  · Sage Skill 代码（可以被模仿）
  · 知识包（可以被复制）

缺失的深层护城河：
  · 跨客户的匿名运营数据（目前没有设计数据飞轮的技术路径）
  · Nexus 作为框架的生态（目前没有 SDK，无法形成开发者社区）
  · 行业标准参与（目前没有计划参与制定行业数字孪生标准）
```

---

## 三、Nexus vs OpenClaw 能力对比（精确版）

```
维度              OpenClaw                      Nexus（工业数据平台）
────────────────────────────────────────────────────────────────────────────────────
核心职责         AI 对话代理编排               工业数据存储 + 行动执行
输入模式         对话消息（文本/图片/语音）     传感器数据流 + HTTP 请求
输出模式         对话消息（文本/图片）          状态变更 + 通知 + API 响应
时序特性         对话型（请求-响应）            流式（持续数据流 + 长连接 SSE）
状态管理         会话上下文（短时）             持久业务状态（工单/告警/历史读数）
知识系统         memory-wiki（文件 + CLI）      Milvus RAG（向量 + 元数据）
插件系统         ✅ 完整（plugin-sdk + manifest）❌ 无（扩展 = 改源代码）
AI 模型          Provider 抽象（多模型切换）    使用 vLLM（固定模型）
安全模型         用户级会话隔离                JWT + ABAC + 站场权限
部署形态         单用户 or 组织共享 gateway    多租户服务（多站场共用一个 Nexus）
编程语言         TypeScript/Node.js            Python/FastAPI
商业模式         开源 + 插件生态              目标：框架 + 工业包 + AI 订阅

两者的关系：互补，不竞争
  OpenClaw = 对话推理层（负责"想什么、怎么说"）
  Nexus = 数据执行层（负责"存什么、怎么做"）
  Sage = 胶水层（OpenClaw Skills 调用 Nexus Tool API）
```

---

## 四、Sage 产品化方案（精确定义）

### 4.1 Sage 的真实形态

```
Sage 不是一个独立的软件产品。
Sage 是：
  1. OpenClaw Skills 代码包（Python 代码，安装到 OpenClaw）
  2. Prompt 模板库（.txt 文件，版本化管理）
  3. 知识包（PDF/Markdown 文档集合，批量导入 Nexus KB）
  4. 部署配置文件（openclaw.config.json，告诉 OpenClaw 启用哪些 Skills）

类比：
  OpenClaw = Node.js 运行时
  Sage = npm 包（我们发布的，用户安装）
  Sage Skills = package.json 中的依赖 + 我们写的代码
  知识包 = seed 数据（安装后导入）
```

### 4.2 Sage 的部署模型

```
Phase A（当前）：手动安装模式
  1. 客户安装 OpenClaw
  2. 我们提供 clawtwin-sage-oilgas/ 目录（Skills 代码）
  3. 客户执行：openclaw skill install ./clawtwin-sage-oilgas
  4. 我们提供脚本：python scripts/seed_sage_knowledge.py（导入知识包）
  5. 完成，OpenClaw 可以执行 Sage Skills

Phase B（目标）：包化安装模式
  1. 发布到私有 npm 注册中心：@clawtwin/sage-oilgas
  2. 客户执行：openclaw skill install @clawtwin/sage-oilgas
  3. 知识包自动通过 Nexus Admin API 导入
  4. 版本更新：openclaw skill update @clawtwin/sage-oilgas

Phase C（愿景）：Skill Marketplace
  1. ClawTwin 官方 Marketplace（类似 OpenClaw 的插件市场）
  2. 其他第三方也可以发布 Sage 兼容的 Skills（我们 20% 分成）
```

### 4.3 Sage 与 OpenClaw 的版本依赖管理

```yaml
# clawtwin-sage-oilgas/package.json（Phase B）
{ "name": "@clawtwin/sage-oilgas", "version": "1.2.0", "peerDependencies": {
      "openclaw": ">=2024.11.0", # 最低 OpenClaw 版本要求
    }, "clawtwin": {
      "nexus-api-version": "v1", # 依赖的 Nexus Tool API 版本
      "skills": ["equipment-twin", "knowledge-base", "workorder-hitl", "shift-handover"],
    } }
```

---

## 五、Nexus-OpenClaw 接口契约（形式化定义）

这是两个系统之间的 API 边界，必须版本化管理。

### 5.1 Sage → Nexus（Tool API 契约）

```yaml
# contracts/sage-nexus-tool-api-v1.yaml
# 类比：OpenClaw plugin-sdk 的 api-baseline.ts

tool_api_version: "v1"
base_url: "/v1/tools"
auth: "service_token"

tools:
  # 设备上下文工具
  get_equipment_context:
    method: GET
    path: /equipment/{equipment_id}/context
    returns:
      - equipment_meta # 设备基本信息
      - current_readings # 当前读数（来自 Redis）
      - active_alarms # 活跃告警
      - health_score # 当前健康分
      - recent_workorders # 最近3个工单
    breaking_change_policy: minor version bump required

  # 知识检索工具
  search_knowledge:
    method: POST
    path: /kb/search
    params:
      - query: string
      - layer: "L0|L1|L2|L3|all"
      - station_id: string (optional)
      - top_k: int (default 5)
    returns:
      - chunks: [{ text, source, layer, score }]
    breaking_change_policy: minor version bump required

  # 工单草稿创建
  create_ai_workorder_draft:
    method: POST
    path: /workorders/ai-draft
    params:
      - equipment_id: string
      - diagnosis: string
      - root_cause: string
      - recommended_action: string
      - citations: [{ source, text }]
      - confidence: "high|medium|low"
    returns:
      - wo_id: string
      - state: "draft"
    breaking_change_policy: major version bump required

  # 站场分析数据
  get_station_analytics:
    method: GET
    path: /analytics/station/{station_id}
    params:
      - period: "1d|7d|30d"
      - metrics: ["alarm_stats", "kpi", "workorder_stats"]
    breaking_change_policy: minor version bump required
```

### 5.2 Nexus → Sage（AI Job 触发契约）

```python
# 当 Studio 用户提交 AI 任务，Nexus 需要触发 OpenClaw Skill
# 这是 Nexus → OpenClaw 的接口契约

class NexusToSageWebhook:
    """
    Nexus 通知 OpenClaw 执行 Skill 的 HTTP 接口
    OpenClaw 配置：clawtwin.inbound_webhook_url = http://openclaw-gateway/v1/skill/trigger
    """

    endpoint: str = "POST /v1/skill/trigger"  # OpenClaw 暴露的接口
    auth: str = "service_token"               # 双向认证

    payload: dict = {
        "skill_name": str,          # "equipment-twin" | "knowledge-base" | ...
        "job_id": str,              # Nexus 的 AIJob.job_id，结果回调用
        "context": {
            "station_id": str,
            "equipment_id": str | None,
            "user_request": str | None,  # 用户原始请求（如有）
        },
        "callback_url": str,        # Nexus 接收结果的 URL
        "callback_token": str,      # 用于验证回调的 Token
    }

class SageToNexusCallback:
    """
    Skill 完成后回调 Nexus 的接口
    Nexus 暴露：POST /v1/ai/jobs/{job_id}/result
    """
    payload: dict = {
        "job_id": str,
        "status": "done | failed",
        "result": {
            "summary": str,
            "wo_id": str | None,        # 如果创建了工单
            "citations": list,
            "confidence": str,
        },
        "error": str | None,
    }
```

---

## 六、从应用到框架：架构分层重构方案

这是本文档最核心的内容。

### 6.1 三层分离架构（类比 OpenClaw 的 SDK + Core + Plugin 分离）

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Layer 3: Domain Pack（工业领域包）· 商业产品                              │
│                                                                          │
│  domains/industrial/                                                     │
│    equipment.schema.yaml     # 设备对象类型定义                           │
│    station.schema.yaml       # 场站对象类型定义                           │
│    workorder.fsm.yaml        # 工单状态机定义                             │
│    alarm_policy.yaml         # ISA-18.2 告警策略                         │
│    pid_overlay.yaml          # P&ID 图层配置                              │
│    health_score.yaml         # 健康评分策略（可被替换！）                   │
│                                                                          │
│  这一层：工业领域专家写，不需要懂 Nexus 内部。改这里 = 改业务，不改框架。    │
├──────────────────────────────────────────────────────────────────────────┤
│  Layer 2: Nexus Framework SDK（框架 SDK）· 开源                           │
│                                                                          │
│  nexus-sdk/                                                              │
│    object_type.py            # ObjectType 基类（任何实体的抽象）           │
│    fsm_definition.py         # StateMachine 定义接口                     │
│    connector.py              # BaseConnector（任何数据源的抽象）           │
│    health_strategy.py        # HealthScoreStrategy 接口                  │
│    alarm_policy.py           # AlarmPolicy 接口                          │
│    event_handler.py          # EventHandler 接口                         │
│                                                                          │
│  这一层：框架维护者维护，第三方用来扩展 Nexus。                             │
├──────────────────────────────────────────────────────────────────────────┤
│  Layer 1: Nexus Core（框架核心）· 开源                                    │
│                                                                          │
│  core/                                                                   │
│    object_registry/          # 通用对象注册（不关心是设备还是合同）         │
│    timeseries_engine/        # 通用时序存储（不关心是压力还是温度）          │
│    state_machine_engine/     # 通用 FSM 执行器（不关心是工单还是订单）      │
│    knowledge_engine/         # 通用 RAG（不关心是工业知识还是医学知识）     │
│    event_bus/                # 通用事件总线                               │
│    ai_dispatcher/            # 通用 AI 任务队列                           │
│    pulse_engine/             # 通用健康计算框架（策略可注入）               │
│    security/                 # 通用 ABAC                                 │
│    connector_sdk/            # 通用连接器框架                             │
│                                                                          │
│  这一层：Nexus 核心团队维护，极少改动，ABI 稳定。                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.2 描述符驱动设计（向 OpenClaw manifest-first 学习）

核心思想：能力用 YAML 描述，框架负责加载和执行。

```yaml
# domains/industrial/equipment.schema.yaml
# 类比：OpenClaw 的 extension.yaml manifest

schema_version: "1.0"
object_type: "equipment"
display_name_zh: "工业设备"

fields:
  equipment_id:
    type: string
    primary_key: true
  equipment_type:
    type: enum
    values_from: equipment_types # 引用另一个注册表
  station_id:
    type: reference
    ref_type: station
  name_tag:
    type: string
  manufacturer:
    type: string

timeseries:
  enabled: true
  default_metrics:
    pressure_in: { unit: MPa, alarm_enabled: true }
    temperature: { unit: "°C", alarm_enabled: true }
    vibration: { unit: "mm/s", alarm_enabled: true }

health_score:
  strategy: industrial_isa18_2 # 引用策略名，可替换

state_machine:
  entity: none # equipment 本身无状态机（workorder 有）

actions:
  - create_workorder
  - acknowledge_alarm
  - request_ai_diagnosis
```

```yaml
# domains/industrial/workorder.fsm.yaml
# 状态机定义文件，框架读取并执行

fsm_version: "1.0"
entity: workorder
initial_state: draft

states:
  draft:
    display_zh: 草稿
    terminal: false
  pending_approval:
    display_zh: 待审批
    terminal: false
  approved:
    display_zh: 已批准
    terminal: false
  executing:
    display_zh: 执行中
    terminal: false
  done:
    display_zh: 完成
    terminal: true
    triggers:
      - event: WorkOrderCompleted
        side_effects: [l3_knowledge_capture, analytics_update]
  cancelled:
    display_zh: 已取消
    terminal: true

transitions:
  - from: draft
    action: submit
    to: pending_approval
    allowed_roles: [operator, engineer, manager]
    side_effects: [feishu_oa_trigger]

  - from: pending_approval
    action: approve
    to: approved
    allowed_roles: [manager, admin]
    side_effects: [cmms_push, feishu_notify]

  - from: pending_approval
    action: reject
    to: draft
    allowed_roles: [manager, admin]
    side_effects: [feishu_notify]

  # ... 其他转换
```

### 6.3 核心框架的通用化实现

```python
# core/state_machine_engine/executor.py
# 通用 FSM 执行器，读取 YAML 定义，不关心具体业务

class StateMachineExecutor:
    """
    通用状态机执行器。
    从 YAML 加载 FSM 定义，验证转换合法性，执行副作用。
    工单 FSM 只是一个配置文件，不是硬编码逻辑。
    """

    def __init__(self, fsm_def: FsmDefinition, side_effect_registry: SideEffectRegistry):
        self.fsm = fsm_def
        self.effects = side_effect_registry

    async def transition(self, entity_id: str, current_state: str,
                         action: str, actor: User) -> TransitionResult:
        # 查找合法转换
        transition = self.fsm.find_transition(current_state, action)
        if not transition:
            raise InvalidTransitionError(f"状态 {current_state} 不允许操作 {action}")

        # 角色检查（通用）
        if actor.role not in transition.allowed_roles:
            raise PermissionError(f"角色 {actor.role} 不允许执行 {action}")

        new_state = transition.to

        # 执行副作用（从注册表查找具体实现）
        for effect_name in transition.side_effects:
            effect = self.effects.get(effect_name)
            await event_bus.emit(SideEffectRequested(effect_name, entity_id, new_state))

        return TransitionResult(new_state=new_state)


# core/object_registry/registry.py
# 通用对象注册表，加载 schema.yaml 定义的对象类型

class ObjectRegistry:
    """
    通用对象注册表。
    不知道"设备"是什么，只知道"对象有类型、有字段、有关联"。
    """

    def load_schema(self, schema_yaml_path: str) -> ObjectType:
        """从 YAML 加载对象类型定义"""
        ...

    def get_object_type(self, type_id: str) -> ObjectType:
        """获取已注册的对象类型"""
        ...

    def validate_object(self, obj: dict, type_id: str) -> ValidationResult:
        """按 schema 定义验证对象数据"""
        ...
```

### 6.4 插件 SDK（类比 OpenClaw plugin-sdk）

```python
# nexus_sdk/connector.py
# Connector 基类，任何第三方都可以按此接口开发连接器

from abc import ABC, abstractmethod
from typing import AsyncIterator

class BaseConnector(ABC):
    """
    Nexus 数据源连接器基类。
    实现此接口 = 可以接入 Nexus 的任何数据源。
    """

    @property
    @abstractmethod
    def connector_id(self) -> str:
        """唯一连接器 ID，如 'opcua' | 'modbus' | 'rest_api'"""

    @abstractmethod
    async def connect(self, config: dict) -> None:
        """建立连接"""

    @abstractmethod
    async def stream(self) -> AsyncIterator[DataPoint]:
        """持续输出数据点"""

    @abstractmethod
    async def health_check(self) -> bool:
        """连接健康检查"""


# nexus_sdk/health_strategy.py
# 健康评分策略接口（对比：当前把 ISA-18.2 权重硬写在代码里）

class HealthScoreStrategy(ABC):
    """
    可替换的健康评分策略。
    oil_gas 版用 ISA-18.2，医疗版用 ISO 13485，自定义版用客户定义。
    """

    @abstractmethod
    def compute(self, readings: dict, anomaly_score: float,
                alarms: list) -> HealthScore:
        """计算设备健康分（0-100）"""


# nexus_sdk/event_handler.py
class EventHandler(ABC):
    """
    领域事件处理器基类。
    实现此接口 = 可以响应 Nexus 内部事件。
    """

    @property
    @abstractmethod
    def handles(self) -> type:
        """处理哪种事件"""

    @abstractmethod
    async def handle(self, event: Any) -> None:
        """处理事件"""
```

---

## 七、商业模式的正确类比

### 7.1 OpenClaw 的商业模式

```
OpenClaw：
  · 核心：开源（MIT 或类似许可）→ 吸引开发者
  · 收入：企业托管服务 / 商业插件 / 专业支持
  · 护城河：开发者生态 + 插件市场 + 企业部署积累

学习要点：
  开源核心 → 降低门槛 → 积累用户 → 数据护城河 → 商业变现
```

### 7.2 ClawTwin 的正确商业模式（对齐后）

```
层次 1：Nexus Framework Core（开源）
  · 许可：Apache 2.0（商业友好）
  · 价值：建立工业 AI 数据平台的开发者社区
  · 目标用户：工业软件开发者、系统集成商
  · 收入：0（战略投资，建生态）

层次 2：Industrial Domain Pack（商业）
  · 定价：¥3-10万/项目（一次性，含实施）
  · 内容：equipment.schema.yaml + workorder.fsm.yaml + ISA-18.2 策略 + P&ID 配置 + OPC-UA 连接器 + CMMS 适配器
  · 价值：30-90天的行业专家工作
  · 保护：源码可见但有商业协议（不可转售）

层次 3：Sage Intelligence Pack（商业订阅）
  · 定价：¥5-20万/年（按站场数量）
  · 内容：OpenClaw Skills + 行业 Prompt 库 + 知识包 + 持续更新
  · 价值：AI 推理质量 + 行业经验积累 + 持续变聪明
  · 保护：订阅制（停止续费 = 停止更新）

层次 4：Enterprise Connect（商业）
  · 定价：¥2-5万/连接器/年
  · 内容：ERP/CMMS/GIS 具体连接器
  · 价值：免开发，即插即用

层次 5：数据飞轮（长期护城河）
  · 客户授权脱敏数据贡献到 Sage 中央库
  · 中央库质量随客户数线性增长
  · 新客户获得即有的行业经验包
  · 这才是最终的不可复制护城河
```

### 7.3 框架商业模式的先决条件

```
要把 Nexus Core 开源，必须先完成：

  1. 清晰的 SDK 定义（nexus-sdk/）
     否则开源了也没人知道怎么扩展

  2. 完整的文档
     SDK Overview / Connector Guide / Schema Guide / FSM Guide

  3. 第一个非工业使用案例（证明通用性）
     例：楼宇自动化（HVAC 设备监控）用同一个 Nexus Core
     证明：Nexus 不是"石油软件"，是"工业 AI 数据平台"

  4. Phase B 才开源（Phase A 先商业验证）
     Phase A：工业应用（快速交付客户价值）
     Phase B：提取框架层，开源 Core，商业化 Domain Pack + Sage
```

---

## 八、针对当前设计的具体优化清单

按照优先级排序：

### 立即可做（Phase A 内，不影响交付）

```
P0：形式化 Nexus-Sage 接口契约
  · 创建 contracts/sage-nexus-tool-api-v1.yaml
  · 编写对应的 Python contract test
  · 这是防止两侧改代码互相炸掉的最低成本保险

P0：Sage 打包化
  · 创建 clawtwin-sage-oilgas/ 目录结构
  · README: 如何在 OpenClaw 上安装 Sage
  · 版本文件 package.json（即使现在手动安装）

P1：把工业硬编码提取为配置文件
  · 把 WORKORDER_TRANSITIONS 提取为 workorder.fsm.yaml
  · 把 ALARM_WEIGHTS 提取为 alarm_policy.yaml
  · 把 EQUIPMENT_TYPE_REGISTRY 提取为 YAML 文件（或 DB，已规划）
  · 代码读配置文件，不再 if-else 判断工业概念
  · 成本：1周工作量，价值：为 Phase B 框架化打基础

P1：引入契约测试（最小版本）
  · 每个 /v1/tools/* 端点增加一个 contract test
  · 断言：返回字段不变、状态码含义不变
  · 参考 OpenClaw 的 *.contract.test.ts 模式
```

### Phase B 核心工作

```
P0：提取 Nexus Framework Core
  · 分离 core/（框架代码）和 domains/industrial/（工业代码）
  · 实现 ObjectRegistry 通用化
  · 实现 StateMachineExecutor 通用化（读 YAML FSM 定义）
  · 实现 ConnectorSDK 正式化

P0：发布 nexus-sdk（Python 包）
  · 正式发布 pip install nexus-sdk
  · 文档：如何开发自定义 Connector
  · 第一个社区贡献案例

P1：Sage 版本化发布
  · 私有 npm 注册中心：@clawtwin/sage-oilgas
  · 语义化版本：1.0.0 = 油气 Phase B
  · OpenClaw 自动更新 Skill
```

---

## 九、最终架构图（演进目标）

```
Phase A（当前）：工业应用
  ┌───────────────┐  Service Token  ┌────────────────┐
  │  OpenClaw +   │ ──────────────► │  Nexus（工业   │
  │  Sage Skills  │ ◄────────────── │  应用，包含业   │
  └───────────────┘   Tool API      │  务逻辑）      │
                                    └────────────────┘

Phase B（目标）：框架 + 工业包
  ┌───────────────┐  versioned      ┌─────────────────────────┐
  │  OpenClaw +   │ ──────────────► │  Nexus Core（框架）      │
  │  @clawtwin/   │ ◄────────────── │  + Industrial Pack（商业）│
  │  sage-oilgas  │   v1 API        │  + nexus-sdk（开源 SDK） │
  └───────────────┘                 └─────────────────────────┘

Phase C（愿景）：工业 AI 操作系统生态
  ┌───────────────┐                 ┌──────────────────────────┐
  │  OpenClaw     │                 │  Nexus Core（开源框架）    │
  │  + 官方 Sage  │                 │  ┌──────────────────────┐ │
  │  + 第三方Skill│                 │  │ Industrial Pack（商业）│ │
  └───────────────┘                 │  ├──────────────────────┤ │
  ┌───────────────┐  nexus-sdk      │  │ Smart Building Pack  │ │
  │  HiAgent      │ ──────────────► │  ├──────────────────────┤ │
  │  + 企业自研   │                 │  │ Healthcare Pack      │ │
  │  Skill        │                 │  ├──────────────────────┤ │
  └───────────────┘                 │  │ 第三方 Domain Pack   │ │
                                    │  └──────────────────────┘ │
                                    └──────────────────────────┘
```

---

## 十、一句话结论

```
当前 Nexus = 很好的工业应用（Phase A 交付价值没问题）
目标 Nexus = 工业 AI 数据框架（Phase B 建立框架层，Phase C 开源生态）

Sage = 我们在 OpenClaw 上发布的工业 AI 技能包（不是独立产品）
       与 OpenClaw 的关系：使用，而非竞争

OpenClaw 学到的最重要一课：
  "Host loads plugins; plugins should not reach into host internals"
  翻译到 Nexus：工业业务逻辑不应该写死在 Nexus Core 里
              工业业务逻辑应该是可插拔的 Domain Pack

护城河的真相：
  不是 Skill 代码（可复制）
  不是知识包（可复制）
  是"跨 N 个客户积累的脱敏运营经验"（不可复制）
  是"基于真实工业数据微调的工业 LLM"（不可复制，Phase C）
  是"工业 AI 平台开发者生态"（慢，但最终最强护城河）
```

---

## 十一、Agent 运行时的可替换性（HiAgent / OpenHermes / 任意 Agent）

### 11.1 核心命题：Nexus 是 Agent 的"工具箱"，不是 OpenClaw 的专属客户

```
当前认知（错误的紧耦合）：
  Nexus ←──── 专属依赖 ────→ OpenClaw

正确认知（工具箱模式）：
                    Nexus Tool API（标准 HTTP + JSON）
                           ▲
          ┌────────────────┼────────────────┐
          │                │                │
   OpenClaw（默认）    HiAgent         OpenHermes
   （个人AI助手型）   （工作流引擎型）  （开源框架型）
          │                │                │
     Sage Skills      工作流 + 工具   自定义 Agent
```

**Nexus 对 Agent 的唯一要求**：

1. 能调用 HTTP REST 端点作为工具（Tool Call / Function Call）
2. 能接受 System Prompt（注入 Sage 的提示词模板）
3. 结果写回 Nexus（通过 POST /v1/ai/jobs/{id}/result）

这是工业界标准能力，任何现代 Agent 框架都满足。

```

### 11.2 三种 Agent 的能力对比与适配

```

                  OpenClaw      HiAgent        Dify（开源私有化）

────────────────────────────────────────────────────────────────────
HTTP 工具调用 ✅ ✅ ✅
System Prompt ✅ ✅ ✅
多轮对话 ✅ ✅（工作流节点） ✅
HITL 中断 ✅ ✅（内置审批节点） ✅（工作流审批）
Feishu 渠道 ✅（插件） ✅（内置） ✅（官方渠道）
多用户会话隔离 ✅ ✅ ✅
本地部署 ✅ ✅ ✅（完全私有化）
MCP 协议支持 ✅ ⚠️（部分） ✅
定价 开源免费 商业产品 开源（MIT + 企业版）

特别优势：
OpenClaw ：个人 AI 助手体验最佳；最适合 Sage 作为 Skill 发布
HiAgent ：工作流可视化编排；最适合 OA 集成和复杂 BPMN 流程
Dify ：国产开源，代码可审计，适合有私有化要求的央企/国企客户

注：之前版本中提到"OpenHermes"是描述不准确，OpenHermes 是一个 LLM 模型
不是 Agent 框架。详见 ADR-8-AGENT-INTEGRATION.md §一 的完整澄清。

````

### 11.3 Agent 抽象连接器设计（架构解耦）

```python
# platform/connectors/agent_connector.py

from abc import ABC, abstractmethod
from typing import Any

class AgentJobRequest:
    """标准化的 Agent 任务请求（与具体 Agent 无关）"""
    task_id: str          # Nexus 生成的任务 ID
    job_type: str         # "diagnose" | "kb_query" | "pid_analyze"
    system_prompt: str    # Sage 提示词（Nexus 注入）
    tools: list[dict]     # OpenAI function calling schema（Nexus 提供）
    tool_base_url: str    # Nexus Tool API 基地址
    service_token: str    # 工具调用鉴权 Token
    user_message: str     # 用户的原始请求
    context: dict         # 额外上下文（equipment_id, station_id 等）


class AgentConnector(ABC):
    """
    Agent 运行时抽象层：任何 Agent 实现此接口即可驱动 Sage。
    Nexus 不依赖任何具体 Agent SDK。
    """

    @abstractmethod
    async def dispatch(self, request: AgentJobRequest) -> str:
        """发送任务到 Agent，返回 agent_task_id（Agent 内部 ID）"""

    @abstractmethod
    async def get_status(self, agent_task_id: str) -> dict:
        """查询 Agent 任务状态"""

    @property
    @abstractmethod
    def connector_name(self) -> str:
        """连接器名称（用于日志/审计）"""


# ── 具体实现 ──────────────────────────────────────────────────────

class OpenClawConnector(AgentConnector):
    """
    OpenClaw 连接器：通过 OpenClaw REST API 发送任务。
    适用场景：标准 Sage Skill 发布模式。
    """
    connector_name = "openclaw"

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key

    async def dispatch(self, request: AgentJobRequest) -> str:
        # 调用 OpenClaw /v1/sessions（或 Skill 触发端点）
        response = await httpx.post(
            f"{self.base_url}/v1/agent/run",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "skill": f"industrial-{request.job_type}",
                "message": request.user_message,
                "context": request.context,
                "nexus_task_id": request.task_id,
            }
        )
        return response.json()["run_id"]

    async def get_status(self, agent_task_id: str) -> dict:
        response = await httpx.get(f"{self.base_url}/v1/runs/{agent_task_id}")
        return response.json()


class HiAgentConnector(AgentConnector):
    """
    HiAgent 连接器：通过 HiAgent 工作流 API 触发工作流节点。
    适用场景：有 BPM/OA 集成需求，需要可视化工作流编排。
    """
    connector_name = "hiagent"

    def __init__(self, base_url: str, workflow_id: str, api_key: str):
        self.base_url = base_url
        self.workflow_id = workflow_id  # Sage 对应的 HiAgent 工作流 ID
        self.api_key = api_key

    async def dispatch(self, request: AgentJobRequest) -> str:
        response = await httpx.post(
            f"{self.base_url}/v1/workflows/{self.workflow_id}/run",
            headers={"X-Api-Key": self.api_key},
            json={
                "inputs": {
                    "user_message": request.user_message,
                    "equipment_context": request.context,
                    "nexus_task_id": request.task_id,
                    "nexus_tool_base_url": request.tool_base_url,
                    "nexus_service_token": request.service_token,
                }
            }
        )
        return response.json()["workflow_run_id"]

    async def get_status(self, agent_task_id: str) -> dict:
        response = await httpx.get(f"{self.base_url}/v1/workflow-runs/{agent_task_id}")
        return response.json()


class GenericMCPConnector(AgentConnector):
    """
    通用 MCP 连接器：适用于任何支持 MCP 协议的 Agent（OpenHermes 等）。
    Nexus 以 MCP Server 形式暴露 Tool API。
    """
    connector_name = "mcp_generic"

    async def dispatch(self, request: AgentJobRequest) -> str:
        # 通过 MCP 协议调用 Agent
        # Agent 通过 MCP 发现 Nexus 提供的 Tools
        # Nexus 作为 MCP Server，Agent 作为 MCP Client
        ...


# ── 连接器工厂 ─────────────────────────────────────────────────────

class AgentConnectorFactory:
    """根据配置创建对应的 Agent 连接器"""

    @staticmethod
    def create(settings: Settings) -> AgentConnector:
        match settings.agent_runtime:
            case "openclaw":
                return OpenClawConnector(settings.openclaw_url, settings.openclaw_api_key)
            case "hiagent":
                return HiAgentConnector(
                    settings.hiagent_url,
                    settings.hiagent_workflow_id,
                    settings.hiagent_api_key
                )
            case "mcp":
                return GenericMCPConnector(settings.mcp_agent_url)
            case _:
                raise ValueError(f"未知的 Agent 运行时: {settings.agent_runtime}")
````

### 11.4 配置切换（环境变量级别）

```bash
# .env - 选择 Agent 运行时

# 方案 A：使用 OpenClaw（默认）
AGENT_RUNTIME=openclaw
OPENCLAW_URL=http://localhost:9001
OPENCLAW_API_KEY=sk-...

# 方案 B：使用 HiAgent（飞书深度集成场景）
AGENT_RUNTIME=hiagent
HIAGENT_URL=https://hiagent.company.com
HIAGENT_WORKFLOW_ID=wf_industrial_diagnosis
HIAGENT_API_KEY=ha-...

# 方案 C：使用通用 MCP Agent（完全自控场景）
AGENT_RUNTIME=mcp
MCP_AGENT_URL=http://localhost:9002

# Nexus 核心配置（与 Agent 无关，始终需要）
NEXUS_GPU_SERVER_URL=http://192.168.10.50:8001  # vLLM 直连
NEXUS_EMBED_MODEL=BAAI/bge-m3
```

### 11.5 Nexus 作为 MCP Server（未来方向）

```
MCP（Model Context Protocol）是当前 AI 工具集成的事实标准。
OpenClaw 支持 MCP，大多数主流 Agent 框架也在快速跟进。

Nexus Tool API → MCP Server 的映射：

Nexus Tool API 端点              MCP Tool 名称
──────────────────────────────────────────────────────────
GET /v1/tools/equipment/context  nexus_get_equipment_context
GET /v1/tools/kb/search          nexus_search_knowledge
POST /v1/tools/workorder/create  nexus_create_workorder
GET /v1/tools/station/summary    nexus_get_station_summary
GET /v1/ctx/workorder/{id}       nexus_get_workorder_context（Context API）

实现方式（Phase B）：
  · 在 Platform 中添加 /mcp 路由（实现 MCP Server 协议）
  · 任何 MCP Client（Claude Desktop、OpenHermes、自研 Agent）
    可以自动发现 Nexus 的所有工具，无需手写 function schema

这意味着：
  "只要告诉 Agent：连接到 http://nexus.company.com/mcp"
  Agent 自动知道有哪些工具可用，自动生成调用参数
  完全无需手写集成代码
```

### 11.6 一句话结论

```
换 Agent 运行时（OpenHermes / HiAgent / 任何 Agent）：

影响：
  · 只需修改 AGENT_RUNTIME 环境变量 + 对应连接器配置
  · Sage 提示词模板可以原样复用（只是运行在不同的 Agent 上）
  · Tool API 完全不变（Agent 调用同样的 HTTP 端点）
  · HITL 工单流程不变（Nexus 管理状态，Agent 只是触发者）

不影响：
  · Nexus 核心功能（Pulse Engine / KB / WorkOrder FSM）
  · Studio UI（Studio 调用 User API，与 Agent 无关）
  · 飞书集成（飞书 → Nexus 的 Webhook 路径不变）
  · 数据层（DB / Milvus / Redis 完全不变）

唯一的潜在差异：
  · HiAgent 有内置 OA 工作流，HITL 体验更好（可视化流程图）
  · OpenClaw 有内置 Feishu 渠道，Feishu Bot 体验更好
  · 通用 MCP Agent 需要自己实现渠道适配（更多工作）

结论：架构完全适用，换 Agent 只需改配置，不改代码。
```

---

_本文档创建于 2026-05-11，是 ClawTwin Nexus 从应用走向框架的架构路线图。_  
_Phase A 团队：重点交付应用价值，同时按 §八 P0/P1 项做框架基础准备。_  
_Phase B 团队：以本文档 §六 为蓝图，完成框架层提取和 SDK 发布。_  
_§十一 于 2026-05-11 补充：明确 Agent 运行时的可替换性，支持 OpenClaw/HiAgent/OpenHermes/任意 MCP Agent。_
