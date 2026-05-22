# ClawTwin 系统框架全景（架构师手册）

**地位**: 🟢 核心 / System Framework  
**版本**: v1.0.0 (2026-05-13)  
**目标读者**: 架构师、高级工程师、产品负责人  
**核心问题**: 三层之间的关系是什么？系统如何运作？

---

## 一、一句话理解

> ClawTwin Platform = **状态机（语义层）** + **行为引擎（AI行动层）** + **稳定性外壳（运维层）**  
> 三层不是简单的上下叠加，而是"数据/事件双向绑定 + 横切稳定保障"的协作体。

---

## 二、完整系统层次图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 用户侧                                                                       │
│                                                                             │
│  [工程师]     [管理员]      [IT 运维]      [自然语言用户]                      │
│     │            │             │               │                            │
│     ▼            ▼             ▼               ▼                            │
│  Studio UI   Studio Admin   CLI / Doctor    OpenClaw（飞书/钉钉）             │
│  (= Gotham)  (= Workshop)   (= Apollo)     （外部 AI 智能体）                 │
└──────┬───────────┬─────────────┬───────────────┬──────────────────────────────┘
       │ REST/SSE  │ REST        │ CLI/HTTP       │ MCP Protocol
       ▼           ▼             ▼               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ ClawTwin Platform                                                           │
│                                                                             │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │           运维层（Ops Shell） — 横切关注，非上层                          │  │
│  │  Doctor · Health · Outbox · ReloadPlan · Hooks · RateLimit · CLI       │  │
│  │  作用：监控一切、保证可靠性、支撑热重载、拦截滥用                          │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  AI 行动层（Behavior Engine）                                         │   │
│  │                                                                     │   │
│  │  PlaybookEngine    ← 事件触发自动化编排                                │   │
│  │  FunctionExecutor  ← 单次 AI 函数调用（结构化查询型）                  │   │
│  │  ActionExecutor    ← 执行操作、更新状态、触发效果                       │   │
│  │  MCP Server        ← 向 OpenClaw 暴露工具                             │   │
│  │  AgentRuntime      ← 委托复杂推理给 OpenClaw                          │   │
│  │                                                                     │   │
│  │  ↕ 读取 + 写回               ↕ 触发（事件订阅）                       │   │
│  └───────────────────────────────────────────────────────────────────── ┘   │
│                    ↑ EventDispatcher（单一事件总线）                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  语义层（State Machine）                                              │   │
│  │                                                                     │   │
│  │  Ontology        ← 定义实体类型（What CAN exist）                    │   │
│  │  ObjectStore     ← 存储实体状态（What DOES exist）                   │   │
│  │  Connectors      ← 接入外部数据（What HAPPENS in the world）         │   │
│  │  Pipelines       ← 数据转换聚合（How to enrich raw data）            │   │
│  │  EventDispatcher ← 发布状态变更（Notify what CHANGED）               │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ OPC-UA / REST Webhook / MQTT / SQL
┌──────────────────────────────▼──────────────────────────────────────────────┐
│ 现有 IT / OT 系统（全部保留，只读接入为主）                                    │
│ SCADA · DCS · OPC-UA · ERP · MES · CMMS · BI · Historian                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、三层之间的关系（精确定义）

### 3.1 语义层：状态机（What）

语义层回答"**系统知道什么**"：

| 组件              | 职责                         | 类比          |
| ----------------- | ---------------------------- | ------------- |
| `Ontology`        | 定义实体类型和字段规则       | 数据库 Schema |
| `ObjectStore`     | 存储实体的当前状态           | 数据库 Data   |
| `Connectors`      | 从外部系统持续拉取/接收数据  | ETL 入口      |
| `Pipelines`       | 数据清洗、聚合、特征提取     | ETL 转换      |
| `EventDispatcher` | 发布状态变更事件（单一出口） | 消息总线      |

**特点**：

- 被动响应（数据来了就存，状态变了就发事件）
- 无业务逻辑（不决定"该做什么"，只记录"发生了什么"）
- 是其他所有层的数据基础

### 3.2 AI 行动层：行为引擎（How + Do）

AI 行动层回答"**系统应该做什么、怎么做**"：

| 组件               | 职责                               | 触发方式                        |
| ------------------ | ---------------------------------- | ------------------------------- |
| `PlaybookEngine`   | 自动化工作流编排（条件/序列/HITL） | 订阅 EventDispatcher 事件       |
| `FunctionExecutor` | 执行 AI 推理函数（单次、结构化）   | Playbook 步骤 / API 调用        |
| `ActionExecutor`   | 执行状态变更操作（有副作用）       | Playbook 步骤 / API 调用        |
| `MCP Server`       | 把语义层数据和行动暴露给 Agent     | OpenClaw MCP 调用               |
| `AgentRuntime`     | 委托复杂推理给外部 Agent           | Playbook 步骤（高不确定性场景） |

**与语义层的关系**：

```
语义层 ──[事件触发]──→ PlaybookEngine（开始执行）
语义层 ──[数据查询]──→ FunctionExecutor（构建 AI 上下文）
ActionExecutor ──[写回]──→ 语义层（更新对象状态）
ActionExecutor ──[触发]──→ EventDispatcher（新事件继续传播）
```

### 3.3 运维层：稳定性外壳（Keep It Running）

运维层**不在语义层和 AI 行动层的上方或下方**，它是**横切包裹两者的外壳**：

```
         ┌──────────────────────────────────┐
         │         运维层（横切）             │
         │  ┌──────────────────────────┐   │
         │  │    语义层 + AI 行动层     │   │
         │  └──────────────────────────┘   │
         │                                  │
         │  Doctor：自检语义层(db)+行动层(ai) │
         │  Health：聚合两层的健康维度        │
         │  Outbox：可靠投递（两层共用）      │
         │  Hooks：两层执行前后注入逻辑       │
         │  ReloadPlan：手术式重载两层组件    │
         └──────────────────────────────────┘
```

**运维层不参与业务逻辑**——它只关心"系统还活着吗"、"消息有没有送到"、"配置改了怎么处理"。

---

## 四、完整运行流：从传感器到行动（具体到每一步）

以"压缩机振动超限 → 自动工单"为例，走完整个 System 的数据流：

```
① 数据接入（语义层 - Connector）
   OPC-UA Server → workers/opcua_collector.py
   → 写入 ObjectStore: EquipmentReading(equipment_id="C-001", metric="vibration", value=12.4)

② 阈值检测（语义层 - Pipeline）
   workers/scheduler.py 每分钟扫描
   → 检测到 vibration > 10.0 (告警阈值)
   → ActionExecutor.execute("CreateAlarm", {equipment_id: "C-001", priority: "P2"})

③ 状态写入 + 事件发布（语义层 - ObjectStore + EventDispatcher）
   ObjectStore.save(Alarm(id="AL-001", equipment_id="C-001", status="active"))
   EventDispatcher.dispatch("alarm.created", payload={alarm_id: "AL-001", priority: "P2"})

④ 工作流触发（AI 行动层 - PlaybookEngine）
   PlaybookTriggerSink 收到 "alarm.created" 事件
   → 匹配 Playbook "alarm_to_workorder" (trigger.event_type = "alarm.created")
   → 创建 PlaybookRun(run_id="RUN-001")，开始执行 Step 1

⑤ AI 诊断（AI 行动层 - FunctionExecutor）
   Step 1: FunctionExecutor.execute("DiagnoseEquipment", {equipment_id: "C-001"})
   → 从 ObjectStore 获取：当前读数 + 24h 历史 + 相似案例（CBR）+ KB 片段
   → 单次 LLM 调用（< 8 秒）→ {summary: "轴承磨损信号...", confidence: 0.76, actions: ["检查轴承"]}

⑥ HITL 门控判断（AI 行动层 - PlaybookEngine）
   confidence < hitl_threshold(0.9) → HITL 触发
   → WorkOrder.state = "pending_approval"
   → EventDispatcher.dispatch("playbook_run.waiting_for_human", ...)

⑦ 实时推送（语义层 - EventDispatcher → Outbox → Channel）
   → SSE Fan: Studio 实时收到告警卡片更新
   → Outbox.enqueue(FeishuSink, "工程师张三，C-001 振动告警待审批…")
   → OutboxDispatcher 投递飞书消息（at-least-once, 退避重试）

⑧ 人工审批（Studio / 飞书）
   工程师在 Studio ApprovalsQueue 页面或飞书看到：
   - 告警详情 + AI 诊断结论 + 推荐操作（带置信度）
   - 点击"批准"→ POST /v1/playbook-runs/RUN-001/resume {decision: "approve"}

⑨ 操作执行（AI 行动层 - ActionExecutor）
   Step 2: ActionExecutor.execute("DispatchWorkOrder", {alarm_id: "AL-001", ...})
   → ObjectStore.save(WorkOrder(id="WO-001", type="corrective", alarm_id="AL-001"))
   → EventDispatcher.dispatch("workorder.created")

⑩ 飞轮记录（语义层 - OutcomeCollector）
   工单关闭后：workers/outcome_collector.py 记录 OutcomeEvent
   → {alarm_id, action_taken, outcome: "resolved", time_to_close: 2.3h}
   → CBR 推荐引擎权重更新（"振动告警 + 轴承信号" → 此类操作有效）
```

**关键设计保证**：每一步失败都有兜底——Outbox 保证通知不丢；HITL 保证高风险操作人工确认；last-known-good 保证配置错误不宕机。

---

## 五、接口层定位矩阵

```
接口        协议       方向            服务对象          特点
───────────────────────────────────────────────────────────────────────
REST API   HTTP/JSON  双向（请求/响应）Studio · 外部系统  人类可读；CRUD + 查询
SSE        HTTP/流    服务端→Studio    Studio UI         实时事件推送（告警/状态）
MCP        MCP协议    双向             OpenClaw 等 Agent  AI 可调用；工具/资源发现
CLI        本地命令   管理员→平台      运维工程师          Doctor/reload/pack 管理
Webhook    HTTP/POST  外部→平台        OT/ERP/CMMS       事件接入（去重+幂等保证）
───────────────────────────────────────────────────────────────────────
```

**不同消费者使用不同接口**：

- Studio ← REST (页面数据) + SSE (实时刷新)
- OpenClaw ← MCP (工具调用，不走 REST)
- 飞书机器人 ← Webhook Inbound + REST (状态查询)
- SCADA ← Webhook Inbound (事件推送) 或 OPC-UA Connector (主动拉取)
- 运维团队 ← CLI + REST Doctor 端点

---

## 六、Studio（对标 Palantir Gotham）界面架构

### 6.1 Gotham 设计哲学

Gotham 的核心是**对象中心 + 时间轴 + 调查→行动**：

- **一切皆对象**：点击任何告警/设备/工单都能进入对象详情页
- **时间轴驱动**：事件按时间轴展示，发现规律
- **从异常到行动**：告警 → 上下文调查 → 推荐操作 → 执行

### 6.2 Studio 页面架构（Gotham 对标）

```
Studio 导航结构
─────────────────────────────────────────────────────────────────
[1] 运营控制台（= Gotham 告警中心）           ← 主入口
    ├── 告警时间线（按时间排列，ISA-18.2 颜色）
    ├── 活跃告警列表（按优先级/设备/站点过滤）
    └── 快速操作（确认/创建工单/一键触发 Playbook）

[2] 设备对象浏览器（= Gotham 对象图谱）       ← 调查工具
    ├── 设备列表/地图视图
    ├── 设备详情页（= Gotham 对象卡片）
    │   ├── 基本信息 + 当前状态
    │   ├── 实时读数图表（最近 24h）
    │   ├── 健康评分（Mahalanobis）
    │   ├── 关联告警（活跃 + 历史）
    │   ├── 因果图（上下游设备关系）
    │   └── AI 推荐操作（CBR + 置信度）
    └── 对象关系图（LinkType 可视化）

[3] 工单管理（= Gotham 任务管理）             ← 执行跟踪
    ├── 工单看板（draft/pending/in_progress/completed）
    ├── 工单详情（告警来源 + AI 诊断 + 处理历史）
    └── 关联 Playbook 执行状态

[4] 审批队列（ApprovalsQueuePage 已实现）     ← HITL 核心
    ├── 待审批列表（告警优先级排序）
    ├── 审批卡片（诊断摘要 + 推荐操作 + 置信度 + 历史案例链接）
    └── 一键批准/拒绝/修改

[5] Playbook 监控                             ← 自动化可见性
    ├── 运行中 + 历史记录
    ├── 每步状态（completed/waiting/failed）
    └── 手动触发 + 中止

[6] 知识库（KnowledgeBasePage 已实现）        ← 经验沉淀
    ├── 知识条目浏览/搜索
    ├── 条目详情（来源 + 关联设备 + 相关案例）
    └── 草稿审核（AI 自动生成的知识等待人工确认）

[7] 飞轮仪表盘（= Gotham 分析视图）           ← 持续优化
    ├── OutcomeEvent 趋势图
    ├── AI 推荐准确率变化
    ├── 干预效果统计（MTTx）
    └── AI Token 用量（成本透明）

[8] 管理后台（Admin）                         ← IT 管理员
    ├── 能力开关（Capability on/off）
    ├── IndustryPack 管理
    ├── Connector 状态
    └── Doctor / Health 仪表盘
```

### 6.3 Studio 当前状态 vs Gotham 差距

| 页面                 | Studio 现状           | 优先级      |
| -------------------- | --------------------- | ----------- |
| 审批队列（HITL）     | ✅ ApprovalsQueuePage | 已有        |
| 知识库管理           | ✅ KnowledgeBasePage  | 已有        |
| 数字孪生视图         | ✅ TwinPage           | 已有        |
| 运行手册             | ✅ RunbookPage        | 已有        |
| AI 洞察卡片          | ✅ AIInsightCard      | 已有        |
| **告警时间线控制台** | ❌ 缺失               | **P1 补充** |
| **设备对象浏览器**   | ❌ 缺失               | **P1 补充** |
| **因果图可视化**     | ❌ 缺失               | P2          |
| **Playbook 监控**    | ❌ 缺失               | P2          |
| **飞轮仪表盘**       | ❌ 缺失               | P2          |

---

## 七、扩展机制：IndustryPack（OpenClaw Plugin 对标）

```
一个 IndustryPack 的结构：
packs/oilgas/
  manifest.yaml          ← 声明 id / 版本 / 依赖能力 / 扩展的本体
  ontology/
    object_types/        ← 新增 ObjectType YAML（泵/压缩机）
    action_types/        ← 新增 ActionType YAML（紧急关阀）
    function_types/      ← 新增 FunctionType YAML（振动诊断）
    playbooks/           ← 新增 Playbook YAML（异常处理流程）
  handlers/              ← Python 函数实现（handlers/*.py）
  connectors/            ← Connector 配置（标签映射等）
  python_module: "packs.oilgas.contrib"  ← 可选 Python 贡献点
    .fastapi_router      → 挂载于 /v1/packs/oilgas/
    .services            → 后台周期任务
    .doctor_checks       → 自定义自检项
    .on_startup/shutdown → 生命周期钩子
```

**扩展三步法**：

1. 新建 `packs/myindustry/manifest.yaml`（5 分钟）
2. 写 YAML 本体定义（1-2 天）
3. 写 Python handler 函数（按需）

**热重载**：`POST /v1/packs/reload` 无需重启进程，3-5 秒生效。

---

## 八、架构稳定性保证

稳定性来自**隔离与抽象**，核心永远不需要修改：

```
稳定点              保证机制              变化点被隔离在
─────────────────────────────────────────────────────────────────
业务本体定义        YAML 声明式           packs/<id>/ontology/*.yaml
AI 模型供应商       ModelProvider 协议    infra/ai_provider/<vendor>.py
AI 智能体           AgentRuntime 协议     aip/agent_runtimes/<vendor>.py
外部系统连接        Connector 协议        connectors/<system>.py
通知渠道            EventDispatcher sink  infra/event_dispatcher.py register_sink()
业务规则            FunctionType handler  handlers/<func>.py
工作流              Playbook YAML         ontology/playbooks/*.yaml
行业适配            IndustryPack          packs/<id>/
─────────────────────────────────────────────────────────────────
```

**核心（core/ + infra/ + aip/）从不需要修改**——所有变化都在协议实现、YAML 声明、Pack 目录里。

---

## 九、架构自洽性检验（5 条不应违反的规则）

| #   | 规则                                               | 违反后果                             |
| --- | -------------------------------------------------- | ------------------------------------ |
| 1   | 所有 PlatformEvent 经 EventDispatcher（单一出口）  | 通知丢失、无法审计、Outbox 失效      |
| 2   | 任何新 ObjectType 先在 YAML 声明                   | 核心代码与本体耦合，无法用 Pack 覆盖 |
| 3   | 所有外部可靠投递经 Outbox（不允许直接 HTTP 推送）  | 消息丢失（进程重启时）               |
| 4   | Pack 代码只通过 hooks/handlers/manifest 接触平台   | Pack 更新破坏平台核心                |
| 5   | AI 对话推理委托给 AgentRuntime，不在 Platform 内做 | 平台变成臃肿的 AI 引擎，职责混乱     |

---

## 十、用户认知友好性验证

**从用户角度，系统应该是"可以分阶段理解"的**：

| 认知层次 | 用户看到                               | 理解难度                     |
| -------- | -------------------------------------- | ---------------------------- |
| L0：使用 | Studio 工作台（告警/工单/审批）        | 零技术门槛                   |
| L1：了解 | "系统会自动处理告警，需要审批时通知我" | 很低                         |
| L2：配置 | 修改 Playbook YAML 调整触发逻辑        | 低（YAML 可读）              |
| L3：扩展 | 写 Python handler 实现新 FunctionType  | 中（标准 Python）            |
| L4：集成 | 对接 ERP/MES REST API，写 Connector    | 中（REST + YAML 配置）       |
| L5：定制 | 新建 IndustryPack，贡献行业本体        | 中高（需理解 Ontology 概念） |

**每个层次都有完整的工具支持**，不需要理解下一层就能在当前层工作。

---

_本文档是系统架构理解的入口文档。所有模块的详细规范见 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`。_
