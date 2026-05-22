# ClawTwin 架构全景：方法论与产品体系

**地位**：对外架构叙事 · 唯一完整版  
**版本**：v1.2.0（2026-05-13，新增「整体架构全景图」+ OpenClaw 必要性澄清）  
**读者**：客户高管、架构决策者、产品与售前、新加入工程师  
**原则**：先讲为什么，再讲是什么，最后讲怎么造；每层都交代输入/输出接口

---

## 整体架构全景图

> **如何读这张图**：从下往上读是「数据流向」——设备信号从最底层进来，经过 Platform 语义化和编排，最终到达人（Studio）和 AI（OpenClaw）。从上往下读是「行动链路」——人的操作或 AI 的决策，经 Platform 编排引擎执行，最终写回或外联到企业系统。

---

### 关键问题先回答：OpenClaw（AI Agent）是必须的吗？

**Platform 有两套 AI 能力，角色不同：**

```
① FunctionExecutor（Platform 内置）
   → 直接调用 LLM（OpenAI / Anthropic / Ollama 等，通过 ModelProvider 配置）
   → 单次结构化推理：诊断设备 / 推荐操作 / 分类告警
   → 无需 OpenClaw，SKU Intelligent 及以上激活此能力
   → 类比：带 AI 的 SQL 查询，确定性、快、可缓存

② AgentRuntime（Platform 委托给外部 Agent）
   → 调用 OpenClaw / Coze / Dify 等对话 AI Agent
   → 多轮推理 / 复杂规划 / 自然语言交互
   → 完全可选，不配置则此路径不启用
```

**结论**：

| 场景                                         | 是否需要 OpenClaw           |
| -------------------------------------------- | --------------------------- |
| 告警自动处理（Playbook + 规则触发）          | **否**                      |
| AI 诊断函数（FunctionExecutor）              | **否**（Platform 直连 LLM） |
| 飞书/Studio HITL 审批                        | **否**                      |
| 飞书/钉钉自然语言对话（"帮我查 C-001 状态"） | **是**                      |
| 复杂多步推理（跨设备、跨时段分析）           | **是**                      |
| Playbook 中标记需要复杂推理的步骤            | **是**                      |

**实际建议**：先部署 Platform + Studio，验证核心价值；再在第四阶段（+OpenClaw SKU）接入对话 AI。AI Agent 让运营更自然，但它不是其他能力的前提。

---

### 整体架构全景图（文字版）

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                           ClawTwin 企业运营 AI 体系                                       ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                          ║
║  ┌──────────────────────────────┐    ┌────────────────────────────────────────────────┐ ║
║  │  【可选】AI 对话层             │    │  【推荐】运营工作台层                            │ ║
║  │  OpenClaw / 外部 MCP Agent   │    │  ClawTwin Studio                               │ ║
║  │                              │    │                                                │ ║
║  │  ▷ 自然语言理解与多轮对话      │    │  ▷ 告警时间线 · 控制台                          │ ║
║  │  ▷ 复杂推理与跨工具规划        │    │  ▷ 设备对象浏览器 · 健康评分                    │ ║
║  │  ▷ 会话上下文与记忆管理        │    │  ▷ 工单管理（看板 · 详情 · 历史）               │ ║
║  │  ▷ IM Bot（飞书/钉钉/企微）   │    │  ▷ HITL 审批队列（AI摘要+一键批准）             │ ║
║  │  ▷ 主动推送交互卡片            │    │  ▷ Playbook 运行监控                           │ ║
║  │                              │    │  ▷ 知识库浏览 · 飞轮仪表盘                      │ ║
║  │  可替换：Coze / Dify /        │    │  ▷ 管理后台（Capability · Pack · Doctor）       │ ║
║  │    HiAgent / 自研 Agent       │    │                                                │ ║
║  └──────────────┬───────────────┘    └───────────────────────────┬────────────────────┘ ║
║                 │                                                 │                      ║
║          MCP 协议（工具调用）                                REST API / SSE              ║
║          + AgentRuntime（可选委托推理）                     （请求响应 + 实时推送）        ║
║                 │                                                 │                      ║
╠═════════════════╪═════════════════════════════════════════════════╪══════════════════════╣
║                 ▼                                                 ▼                      ║
║  ╔═════════════════════════════════════════════════════════════════════════════════════╗ ║
║  ║                        ClawTwin Platform（必选内核）                                ║ ║
║  ║                                                                                     ║ ║
║  ║  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄ 运维横切层（Apollo 等价）┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ ║ ║
║  ║  ┆  Doctor（自检修复）  Health（健康聚合）  Outbox（可靠投递）  Dedupe（去重）        ┆ ║ ║
║  ║  ┆  RateLimit（限流）   ReloadPlan（热重载）  Hooks（生命周期）  AI Usage（用量追踪）  ┆ ║ ║
║  ║  ┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ ║ ║
║  ║     │                                                                               ║ ║
║  ║  ┌──▼──────────────────────────────────────┐  ◀──── EventDispatcher（统一事件总线）  ║ ║
║  ║  │  AI 行动层（AIP 工程等价）                │                    ▲                  ║ ║
║  ║  │                                          │                    │ 状态变更事件       ║ ║
║  ║  │  PlaybookEngine   事件触发自动化编排       │                    │                  ║ ║
║  ║  │    ├─ 步骤序列 / 条件分支                │  ┌─────────────────────────────────┐  ║ ║
║  ║  │    └─ HITL门控（挂起→审批→恢复）         │  │  语义层（Foundry 等价）           │  ║ ║
║  ║  │                                          │  │                                 │  ║ ║
║  ║  │  FunctionExecutor 单次确定性AI函数         │  │  Ontology Engine                │  ║ ║
║  ║  │    ├─ 直连 LLM（ModelProvider）          │  │    YAML声明 ObjectType /        │  ║ ║
║  ║  │    ├─ 上下文组装（对象+历史+案例+KB）     │  │    ActionType / FunctionType /  │  ║ ║
║  ║  │    ├─ LRU缓存（60s TTL）                │  │    LinkType / Playbook          │  ║ ║
║  ║  │    └─ fast / smart 模型分级路由          │  │                                 │  ║ ║
║  ║  │                                          │  │  ObjectStore（单一事实来源）      │  ║ ║
║  ║  │  ActionExecutor  有副作用操作执行          │  │    对象创建/变更/查询/历史        │  ║ ║
║  ║  │    ├─ 写回 ObjectStore                   │  │                                 │  ║ ║
║  ║  │    └─ 触发新事件 → EventDispatcher       │  │  Connector Framework            │  ║ ║
║  ║  │                                          │  │    OPC-UA / MQTT / REST / SQL   │  ║ ║
║  ║  │  MCP Server  向外部Agent暴露工具          │  │    只读接入OT / 双向接IT         │  ║ ║
║  ║  │    工具集：查询/执行/检索/平台状态         │  │                                 │  ║ ║
║  ║  │                                          │  │  Pipeline（数据规整+特征提取）   │  ║ ║
║  ║  │  AgentRuntime  复杂推理委托（可选）        │  │    换算 / 健康评分 / CBR特征    │  ║ ║
║  ║  │    可替换：OpenClaw/Coze/Dify/HiAgent    │  │                                 │  ║ ║
║  ║  │                                          │  │  知识飞轮                       │  ║ ║
║  ║  │         ◀─────────────────────────────── │  │    OutcomeEvent → CBR更新       │  ║ ║
║  ║  │         读取对象状态 + 写回操作结果        │  │    案例推荐准确率持续提升         │  ║ ║
║  ║  └──────────────────────────────────────────┘  └─────────────────────────────────┘  ║ ║
║  ║                                                                                     ║ ║
║  ║  ┄┄┄┄┄┄┄┄ 接触层与后台进程 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ ║ ║
║  ║  apps/  REST路由 · SSE端点 · MCP端点 · Webhook接收 · CLI                           ║ ║
║  ║  workers/  opcua_collector · scheduler · outbox_dispatcher · outcome_collector     ║ ║
║  ║  packs/  oilgas/ · manufacturing/ · healthcare/ · itops/ · <自定义行业>/            ║ ║
║  ╚═════════════════════════════════════════════════════════════════════════════════════╝ ║
║                 │                                                                        ║
║     OPC-UA / MQTT（只读）    Webhook / REST（双向，管理系统写回须人审）                      ║
║                 │                                                                        ║
╠═════════════════╪════════════════════════════════════════════════════════════════════════╣
║                 ▼                                                                        ║
║  ┌──────────────────────────────────────────────────────────────────────────────────┐   ║
║  │  企业现有 IT / OT 系统（全部保留，按层接入）                                        │   ║
║  │                                                                                   │   ║
║  │  L5 战略   ERP · BI · 财务 · 人力（ClawTwin 推送 KPI 摘要）                       │   ║
║  │  L4 管理   OA · 审批 · 项目管理（ClawTwin 触发审批流 · 接收结果）                  │   ║
║  │  L3 运营   MES · CMMS · WMS（工单双向同步 · 完工反馈）                             │   ║
║  │  ─────────────── ⚠ 工业安全红线：L1/L2 只读接入，不写回控制系统 ──────────────── │   ║
║  │  L2 集成   OPC-UA Server · MQTT Broker · Historian · Modbus                       │   ║
║  │  L1 感知   传感器 · PLC · DCS · SCADA · 工控机                                    │   ║
║  └──────────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                          ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

---

### 整体架构关键关系说明

**纵向数据流（从下到上，感知→语义→行动）**

```
L1/L2 传感器信号
   │  OPC-UA / MQTT 协议，由 opcua_collector Worker 周期采集
   ▼
Connector → ObjectStore（数字孪生：设备当前读数成为对象属性）
   │  Pipeline 同步丰富（换算/特征/健康评分）
   ▼
EventDispatcher 广播「对象状态变更」事件
   │  PlaybookTriggerSink 订阅，阈值匹配触发 Playbook
   ▼
PlaybookEngine 执行编排
   ├─ 调用 FunctionExecutor（诊断函数，直连 LLM，< 8 秒返回）
   ├─ 触发 HITL → Outbox 投递飞书/钉钉审批卡片
   └─ 调用 ActionExecutor（创建工单 / 外联 ERP）
```

**横向协作流（Platform ↔ Agent / Studio）**

```
Studio              调用 REST 读取对象；POST 提交 HITL 决策
   ←────SSE────     Platform 主动推送告警创建、状态变更

OpenClaw            调用 MCP 工具查询设备/创建工单/请求诊断
   ←──AgentRuntime──Platform 委托复杂推理任务（Playbook 可选步骤）
   ────callback────→ 推理完成后回调，Playbook 继续

Outbox Worker       扫描 outbox 表 → HTTP POST 飞书/钉钉/Webhook
                    at-least-once + 指数退避重试 + Dedupe 去重
```

**LLM 调用路径（两条，互相独立）**

```
路径 A  Platform 内置（FunctionExecutor）
   Platform → ModelProvider（OpenAI/Anthropic/Ollama）
   用途：单次结构化诊断/分类，确定性高，可缓存，无需 Agent

路径 B  Agent 委托（AgentRuntime）
   Platform → AgentRuntime → OpenClaw → ModelProvider
   用途：多步推理、对话生成、复杂规划，需要 Agent 在场
```

**依赖方向（有向无环图，不可违反）**

```
Studio   ──单向──→  Platform（Studio 不持有业务逻辑，只通过 API 消费）
Agent    ──单向──→  Platform（Agent 通过 MCP 使用 Platform 工具）
Platform ──可选──→  Agent（AgentRuntime 委托，配置开关，非强依赖）
Platform ──单向──→  企业系统（Connector 接入，OT 只读，IT 双向有限）
```

---

## 总览·层次框架（先读这一章，再读后面的细节）

本章用纯文字层次树把整个体系的**产品、层次、模块、接口**一次呈现。树中每个节点后面标注了：它属于哪个产品/层次、对外暴露的主要接口、以及与下一层的连接协议。

---

### 框架一：产品家族层次（外部视角）

从最外层的用户/客户视角看，ClawTwin 是三件可独立交付、互相协作的产品：

```
ClawTwin 产品体系
│
├── [A] ClawTwin Studio          角色：运营人员的业务工作台（人机界面层）
│     接口进：用户点击 / 表单提交 → REST 请求 到 Platform
│     接口出：Platform SSE 推送 → 页面实时刷新
│     独占职责：可视化、告警时间线、工单审批、HITL 操作
│     不做：不存业务数据、不跑 AI 推理、不管 IM 通道
│
├── [B] ClawTwin Platform        角色：语义内核 + 编排引擎 + 可靠运维（必选中枢）
│     接口进：REST（Studio/外部） / MCP（Agent） / Webhook（OT/IM）
│     接口出：SSE（Studio实时） / MCP 工具响应 / Outbox 投递（飞书/钉钉）
│     独占职责：对象持久化、Playbook 编排、AI 函数执行、MCP 工具暴露
│     内部分三层 → 见框架二
│
└── [C] OpenClaw / 外部 MCP Agent  角色：可替换的对话大脑（可选）
      接口进：用户自然语言 → Agent 内部推理
      接口出：MCP 工具调用 → Platform / 人工审批结果 → Platform REST
      独占职责：多轮对话、复杂推理规划、IM 卡片投递
      不做：不存业务对象、不是 Playbook 执行引擎
```

**三件产品的依赖方向（有向无环，不可逆）**：

```
Studio   ──────────────────────────→  Platform
                                           ↑
OpenClaw ──────────────────────────→  Platform
                                           │  可选回调（委托推理）
Platform ──────────────────────────→  OpenClaw（AgentRuntime 配置开关）
                                           ↓
Platform ──────────────────────────→  企业 IT/OT（Connector，主动采集或接收推送）
```

---

### 框架二：Platform 内部三层（核心架构）

Platform 内部不是简单上下堆叠，而是**两垛垂直能力 + 一层横切运维壳**：

```
ClawTwin Platform
│
├──[运维横切层]  Apollo 等价 ─────────────────────────────────────────────
│    │  作用：包裹下面两层；不参与业务逻辑；保障可靠运行
│    │
│    ├── Doctor          自检与修复        接口：POST /v1/doctor/run
│    ├── Health          健康维度聚合       接口：GET  /v1/health/dimensions
│    ├── Outbox          可靠消息投递       接口：（内部）OutboxSink 入库 + Worker 投递
│    ├── Dedupe          入站事件去重       接口：（透明）所有 Webhook 入口前置过滤
│    ├── RateLimit       双维限流          接口：（透明）API 层前置，超限返 429
│    ├── ReloadPlan      热重载            接口：POST /v1/admin/reload-config
│    │                                         POST /v1/packs/reload
│    ├── Hooks           生命周期钩子       接口：（内部）Pack python_module.on_startup
│    └── AI Token Usage  用量追踪          接口：GET  /v1/usage/ai-tokens
│
├──[AI 行动层]  AIP 工程等价 ──────────────────────────────────────────────
│    │  作用：订阅语义层事件 → 编排流程 → 执行 AI 函数 → 驱动操作
│    │  接收：EventDispatcher 广播的业务事件（PlaybookTriggerSink 订阅）
│    │  写回：通过 ActionExecutor → ObjectStore（对象状态变更）
│    │
│    ├── PlaybookEngine   事件驱动编排
│    │     输入：business event（alarm.created 等）
│    │     输出：PlaybookRun 状态 / 调用 FunctionExecutor / ActionExecutor
│    │     关键：HITL 门控（挂起 → 等审批 → 恢复）
│    │
│    ├── FunctionExecutor  单次确定性 AI 函数
│    │     输入：function_type_id + { equipment_id, alarm_id, … }
│    │     上下文组装：ObjectStore当前状态 + 历史趋势 + CBR案例 + KB条目
│    │     输出：{ summary, confidence, recommended_actions }
│    │     性能：LRU缓存(60s TTL) / fast↔smart 模型路由
│    │
│    ├── ActionExecutor    有副作用操作执行
│    │     输入：action_type_id + params
│    │     副作用：ObjectStore写入 / 外部API调用
│    │     输出：新业务事件 → EventDispatcher
│    │
│    ├── MCP Server        向外部 Agent 暴露工具
│    │     输入：MCP 工具调用请求（来自 OpenClaw 等）
│    │     工具集：对象查询 / 操作执行 / 知识检索 / 平台状态
│    │     输出：结构化 JSON 工具响应
│    │
│    └── AgentRuntime      复杂推理委托
│          输入：Playbook 委托任务（含业务上下文）
│          输出：Agent 推理结论（异步回调 → PlaybookEngine 继续）
│          可替换：OpenClaw / Coze / Dify / HiAgent / Stub
│
└──[语义层]  Foundry 等价 ───────────────────────────────────────────────
      │  作用：定义世界 / 接入世界 / 记录世界 / 广播变化
      │  是整个系统的「单一事实来源（Single Source of Truth）」
      │
      ├── Ontology Engine   类型系统声明
      │     输入：YAML 文件（ObjectType / LinkType / ActionType / FunctionType / Playbook）
      │     输出：运行时类型注册表（供各引擎校验和发现）
      │
      ├── ObjectStore       对象持久化
      │     输入：ActionExecutor 写入 / Connector 数据写入
      │     输出：REST 查询响应（Studio读） / AI上下文构建 / 变更事件触发
      │
      ├── Connector Framework  外部数据接入
      │     输入：OPC-UA拉取 / Webhook推送 / REST轮询 / MQTT订阅
      │     输出：规整后属性写入 ObjectStore（只读接入OT，不写回L1/L2控制层）
      │
      ├── Pipeline          数据规整与特征提取
      │     输入：ObjectStore 变更事件（EventDispatcher 广播）
      │     输出：丰富后属性写回 ObjectStore（健康评分/工程单位换算等）
      │
      ├── EventDispatcher   统一事件总线（单一出口）
      │     输入：任何模块调用 dispatch(event_type, payload)
      │     输出：广播给所有注册 Sink
      │           ├─ PlaybookTriggerSink → 触发 PlaybookEngine
      │           ├─ SSEFanoutSink       → 推送 Studio 前端
      │           ├─ OutboxSink          → 入库可靠投递队列
      │           └─ FeishuDirectSink    → 高优通知直发
      │
      └── 知识飞轮（CBR + KnowledgeBase + OutcomeEvent）
            输入：工单关闭 → OutcomeCollector 写 OutcomeEvent
            CBR：向量相似度检索历史案例（供 FunctionExecutor 上下文组装）
            输出：AI 推荐准确率随运营时长持续提升
```

---

### 框架三：接触层与进程层（运行时视角）

Platform 对外暴露的真实进程与服务结构：

```
Platform 运行时进程
│
├── apps/（HTTP 进程，对外接触层）
│     ├── REST API 路由     所有 /v1/* 端点挂载
│     ├── SSE 端点          Studio 实时推送通道
│     ├── MCP 端点          Agent 工具调用入口
│     ├── Webhook 接收      飞书事件 / OT 推送 / 外部回调
│     └── CLI 入口          运维命令（doctor/reload/health）
│
├── workers/（独立后台进程）
│     ├── opcua_collector   OPC-UA 周期采集 → ObjectStore
│     ├── scheduler         定时规则扫描 / Playbook 超时检查
│     ├── outbox_dispatcher Outbox 表扫描 → 飞书/Webhook 投递
│     └── outcome_collector 工单关闭后写 OutcomeEvent → CBR 更新
│
└── packs/（运行时热加载，零修改内核）
      oilgas/               油气行业：压缩机诊断、振动分析、场站规程
      manufacturing/        制造业：机床/AGV、质量告警、生产工单
      healthcare/           医疗：设备告警、护理任务
      itops/                IT运营：服务器、SRE工单
      <自定义行业>/          任何行业：YAML + Python handler
```

---

### 框架四：企业 IT/OT 集成层次（外部视角）

ClawTwin 在企业技术栈中的位置：

```
L5  战略层       ERP / BI / 财务 / 人力
                 ↑  ClawTwin 推送运营 KPI / 异常汇总摘要
L4  管理层       OA / 审批系统 / 项目管理
                 ↕  ClawTwin 触发审批流 / 接收审批结果
L3  运营层       MES / CMMS / WMS
                 ↕  ClawTwin Webhook 推送工单 / 接收完工反馈
─────────────────────────────────────────────────────────────────
L2.5 ★          ClawTwin Platform（运营语义内核）← 当前层
                 ↑  感知数据流入（只读）
                 ↓  告警/工单/洞察流出
─────────────────────────────────────────────────────────────────
L2  数据集成层   OPC-UA / MQTT / Modbus / Historian
L1  感知控制层   传感器 / PLC / DCS / SCADA / 工控机

AI 智能体（横向）
                 OpenClaw ──MCP→ ClawTwin（工具调用，读写业务对象）
                 ClawTwin ──AgentRuntime→ OpenClaw（委托复杂推理，异步）
```

**工业安全红线**：OT 控制层（L1/L2）**只读接入**，ClawTwin 不向工控系统发出指令。写回操作只发生在 L3/L4 管理系统，且需要人工审批门控。

---

### 框架五：扩展机制层次（面向开发者与集成商）

如何在不修改平台内核的情况下扩展 ClawTwin 的能力：

```
扩展点                    扩展方式                 作用
─────────────────────────────────────────────────────────
ObjectType               packs/<id>/ontology/     新增业务实体类型
LinkType                 object_types/*.yaml       定义实体关联关系
ActionType               action_types/*.yaml       定义可执行操作
                         + handlers/<action>.py    操作的 Python 实现
FunctionType             function_types/*.yaml     定义 AI 推理函数
                         + handlers/<func>.py      函数的 Python 实现
Connector                connectors/<system>.py    接入新的外部数据源
Pipeline                 pipelines/*.yaml          定义数据转换步骤
Playbook                 playbooks/*.yaml          定义业务编排流程
IndustryPack（打包上述）  packs/<id>/manifest.yaml  行业包整体声明
  可选扩展点               python_module            自定义路由 / 服务 /
                                                   Doctor检查 / 生命周期钩
AI Agent 实现             aip/agent_runtimes/       替换 OpenClaw（新 AgentRuntime）
Channel Sink              infra/event_dispatcher.py 新增通知渠道（钉钉/企微等）
```

**内核从不修改。** 所有差异化在扩展点中实现，热重载生效（`POST /v1/packs/reload`，3-5 秒）。

---

以上五个框架是本文档所有章节的「地图」。后续章节是对各框架节点的逐一展开，建议结合本框架对照阅读。

---

## 第一章　为什么要建这样一套系统

### 1.1 企业 AI 化面临的真实困境

大多数企业今天的 IT/OT 格局是这样的：

    SCADA / DCS / PLC          ← 产出实时工况数据，但封闭、无语义
    ERP / MES / CMMS           ← 有流程记录，但响应慢、靠人填单
    BI / 报表系统              ← 有历史数据，但是"昨天的数据看今天的问题"
    AI 工具（ChatGPT 等）       ← 会聊天，但不知道你的设备叫什么、状态是什么

这四层系统各自独立，互不连通。结果是：

- **告警淹没人**：一台压缩机报警，工程师要跨三个系统才能决定该不该停机。
- **经验无法沉淀**：老工程师退休，处理问题的经验跟着消失，无法让 AI 学到。
- **自动化脆而窄**：靠 PLC 逻辑或 RPA 脚本做的自动化，一旦情况变化就失效。
- **AI 没有根基**：大模型不知道你的「设备 C-001」是什么，也不知道它今天压力是多少，无法真正帮到运营。

**一句话总结企业的痛点**：数据有了，系统有了，AI 也买了，但三者之间没有"语义粘合剂"——没有一层把物理世界、业务流程和 AI 行动统一在一起。

### 1.2 传统解法为什么不够

**方案 A：在 SCADA 旁边架一套 AI 平台**  
问题：AI 调用的是原始时序数据，不知道业务背景（这台泵是否在维护期？关联告警是否已确认？），结论可靠性低，工程师不敢信任。

**方案 B：用 RPA 打通各系统**  
问题：RPA 是流程驱动，遇到非标情况就卡住；AI 时代需要的是"对场景理解后再决定怎么走"，而不是"按固定路径点击"。

**方案 C：直接买 Palantir / 大型 MES 升级**  
问题：成本极高（百万美元起）、实施周期长（18-36 个月）、最终还是把企业锁死在一个平台上；AI Assist 也是绑定的，无法替换。

**方案 D：自研**  
问题：企业核心竞争力不在此；自研需要同时搞定本体建模、事件驱动、LLM 接入、可靠性工程——通常低估了难度，最终形成新的数据孤岛。

### 1.3 真正需要的：一层"运营语义平台"

企业真正缺的不是更多数据，也不是更强的 AI，而是一层**把物理实体、业务对象和 AI 行动粘合在一起的中间层**。这层的核心任务是：

1. **让企业对象有"语义"**：设备不再是 OPC-UA 里的一串标签，而是有类型、有状态、有关系的业务对象。
2. **让事件有"行动能力"**：当告警发生时，不是发一条消息了事，而是触发一个编排好的响应流程。
3. **让 AI 有"业务上下文"**：AI 调用的不是原始数据流，而是当前对象状态 + 历史案例 + 可执行动作。
4. **让系统有"记忆与演进"**：每次干预的结果被记录下来，形成知识飞轮，让下一次更准。

这就是 ClawTwin Platform 存在的根本原因。

---

## 第二章　ClawTwin 是什么：方法论级别的定义

### 2.1 一句话定位

> ClawTwin 是一套**运营 AI 中台方法论及其工程实现**：把企业的物理实体和业务流程"语义化"，在此之上让 AI 能可靠地感知、推理和行动。

"方法论"意味着：它不依赖特定行业、特定 AI 模型、特定 IT 系统；任何行业的运营场景，只要有"设备/事件/工单/处理流程"这个基本结构，都可以用这套方法落地。

### 2.2 方法论的三个核心主张

**主张一：语义先行（Semantic First）**

传统 IT 集成是数据对接（字段映射、接口打通）。ClawTwin 的起点是**先对业务对象建立语义模型**——设备是什么、告警是什么、工单是什么、它们之间什么关系——再接入数据。这样做的好处是：AI 调用的是"C-001 压缩机当前振动 12.4mm/s，关联活跃告警 2 条，历史相似案例 5 条"，而不是一串 OPC-UA 标签值。

**主张二：编排可靠（Orchestration Reliable）**

AI 的输出不等于"行动完成"。从 AI 诊断结论到创建工单、从工单创建到飞书通知、从通知到人工审批、从审批到操作执行——这条链路的每一个环节都可能失败、丢失或重复。ClawTwin 的编排层（Playbook）和可靠投递层（Outbox）保证这条链路是事务性的、可恢复的、可审计的。

**主张三：飞轮演进（Flywheel Learning）**

每一次人工干预的结果都被记录为 OutcomeEvent，反向更新案例推荐引擎（CBR）。随着时间推移，系统的推荐越来越准，可以自动执行的比例越来越高，需要人工介入的情况越来越少。这是 AI 与运营系统真正融合的标志。

### 2.3 产品家族：三件事，三个产品

ClawTwin 体系由三件互补的产品组成，**各有独占职责，无重叠**：

```
ClawTwin Platform     ← 语义内核 + 编排引擎 + 可靠性保障（必选）
ClawTwin Studio       ← 运营人员的业务工作台（推荐，人机协作入口）
OpenClaw / AI Agent   ← 对话型 AI 助手，通过 MCP 协议接入（可选）
```

为什么要分成三个而不是一个？

- **Platform 必须能独立运行**：API-only 模式下对接自有前端，或作为其他系统的后端；这要求它不依赖 Studio。
- **Studio 必须可以单独升级**：前端改版不影响后端编排逻辑，这要求它与 Platform 之间只有网络契约（REST/SSE）。
- **AI Agent 必须可以替换**：今天用 OpenClaw，明天客户可以换成 Coze 或自研 Agent，Platform 的工具暴露（MCP Server）不需要改变。

**这三件产品，恰好对应 Palantir 话术中四条叙事线的完整覆盖**（见附录 A）。

---

## 第三章　产品层：三条产品线的精确定位

### 3.1 ClawTwin Studio ——"Gotham 等价：运营人员的驾驶舱"

**它是什么**  
Studio 是运营工程师、班长、管理员每天打开的主工作界面。它的设计哲学来自 Palantir Gotham 的"对象中心 + 时间轴 + 调查→行动"闭环：一切都从对象出发（设备、告警、工单），围绕时间轴展开，最终落到可执行的操作上。

**核心页面与功能**

| 页面             | 功能                                           | 输入来源            | 输出动作                          |
| ---------------- | ---------------------------------------------- | ------------------- | --------------------------------- |
| 运营控制台       | 告警实时时间线、优先级列表                     | Platform SSE 推送   | 确认告警、触发 Playbook           |
| 设备对象浏览器   | 设备状态卡片、24 小时趋势、健康评分、关联图谱  | Platform REST       | 创建工单、下达操作                |
| 工单管理         | 看板视图（待处理/进行中/完成）、详情 + 历史    | Platform REST       | 状态更新、关闭工单                |
| 审批队列（HITL） | AI 诊断摘要 + 推荐操作 + 置信度，一键批准/拒绝 | Platform REST + SSE | 审批决策 → Platform Playbook 恢复 |
| 知识库           | 故障案例浏览、AI 生成草稿审核                  | Platform REST       | 人工审核确认                      |
| Playbook 监控    | 自动化流程运行状态                             | Platform REST + SSE | 手动触发、中止                    |
| 飞轮仪表盘       | AI 推荐准确率趋势、干预效果统计                | Platform REST       | 配置优化策略                      |
| 管理后台         | Capability 开关、Pack 管理、Doctor/Health      | Platform REST       | 系统配置                          |

**Studio 与 Platform 的接口**

- Studio → Platform：HTTP REST（CRUD 操作、查询、指令下达）
- Platform → Studio：HTTP SSE（告警创建、状态变更、审批请求的实时推送）
- Studio **不持有**任何业务真相源；所有持久化在 Platform

**Studio 不做什么**  
不做多轮对话；不内嵌 Playbook 引擎；不直连数据库；不执行 AI 推理——这些全在 Platform。

---

### 3.2 ClawTwin Platform ——"Foundry + AIP + Apollo 等价：运营语义与编排内核"

这是整个体系的发动机。Platform 的内部结构分三个逻辑层，这三层**不是上下堆叠的**，而是：两个垂直能力栈（语义层 + AI 行动层）被一个横切运维壳（运维层）包裹。

Platform 的详细分层在第四章完整展开；这里先说定位。

**Platform 做什么**（独占职责）

- 企业运营实体的语义建模与持久化（Ontology + ObjectStore）
- 外部 IT/OT 数据的接入、规整与特征化（Connector + Pipeline）
- 事件驱动的业务编排与自动化（Playbook + ActionExecutor）
- 单次确定性 AI 函数调用（FunctionExecutor）
- 向外部 Agent 暴露工具与上下文（MCP Server）
- 可选地把复杂推理任务委托给外部 Agent（AgentRuntime）
- 可靠消息投递（Outbox）、系统自检（Doctor/Health）、热重载（ReloadPlan）

**Platform 不做什么**  
不是聊天机器人；不管理对话历史；不做多轮推理规划；不绘制前端 UI。

---

### 3.3 OpenClaw / 外部 AI Agent ——"AIP Assist 等价：可替换的对话大脑"

**它是什么**  
OpenClaw 是一个独立的对话 AI 智能体产品，通过 MCP 协议接入 Platform。用户通过飞书、钉钉、企业微信或 Web 界面与之对话，OpenClaw 调用 Platform 提供的工具获取实时业务上下文，再生成自然语言回答或触发操作。

**OpenClaw 做什么**（独占职责）

- 自然语言理解与多轮对话
- 跨工具调用的复杂推理（"帮我分析最近一周最容易出问题的设备类型"）
- 主动推送（告警创建时 Hook 触发 → 向对应频道发送交互卡片）
- 飞书/钉钉一键审批（作为 IM Bot 宿主，接收用户点击 → 转发给 Platform）
- 会话上下文记忆

**OpenClaw 不做什么**  
不存储业务对象；不直连 SCADA/ERP；不是 Playbook 的执行引擎（它通过 MCP 调用 Platform 来完成动作）。

**可替换性**  
只要实现 MCP 协议，Coze、Dify、HiAgent 或自研 Agent 都可以接入；Platform 的 MCP Server 不变。**这是相对 Palantir 捆绑 AIP Assist 的核心差异化**。

---

## 第四章　Platform 内部架构：三层模型与完整模块

这一章是工程架构的核心。所有模块的逻辑位置、职责边界和接口（输入/输出）在这里完整交代。

### 4.0 架构总述

Platform 的三层结构可以用一个比喻来理解：

```
语义层     ← 世界的镜子（What exists, what changed）
AI 行动层  ← 世界的大脑（What to do, how to do it with AI）
运维层     ← 世界的外壳（Keep it running, reliable, observable）
```

语义层是被动的：数据来了就存，状态变了就发事件，不决定"该做什么"。  
AI 行动层是主动的：订阅事件、执行推理、编排流程、触发操作。  
运维层是横切的：不参与业务逻辑，但包裹并保障语义层和 AI 行动层的每一个动作。

**单向数据流原则**：语义层通过 EventDispatcher 向 AI 行动层发送事件；AI 行动层通过 ActionExecutor 写回语义层的 ObjectStore；运维层横切两者但不产生业务事件。

---

### 4.1 语义层（Foundry 等价）

**层的职责：定义世界、接入世界、记录世界、广播变化**

语义层回答三个问题：

1. 世界上有哪些类型的东西？（Ontology）
2. 这些东西现在是什么状态？（ObjectStore）
3. 外部世界发生了什么新的事？（Connector + Pipeline + EventDispatcher）

---

#### 模块：Ontology Engine（本体引擎）

**职责**：定义企业运营世界的"类型系统"。

类比：数据库有 Schema，Ontology 是 ClawTwin 业务对象的 Schema，但比关系型 Schema 更丰富——它还定义了对象之间的关系类型（LinkType）、允许执行的操作类型（ActionType）和可调用的 AI 函数类型（FunctionType）。

**输入**：YAML 格式的声明文件（ObjectType、LinkType、ActionType、FunctionType、Playbook 定义）  
**输出**：运行时可查询的类型注册表，供 ObjectStore / ActionExecutor / FunctionExecutor 校验和发现

**核心概念**：

- ObjectType：业务实体类型，如 Equipment（设备）、Alarm（告警）、WorkOrder（工单）、Station（站点）
- LinkType：对象间关系，如 Equipment `triggered` Alarm（设备触发告警）
- ActionType：有副作用的操作，如 CreateWorkOrder、AcknowledgeAlarm；声明了风险级别、是否需要审批
- FunctionType：纯计算型 AI 函数，如 DiagnoseEquipment；声明了输入 schema、输出 schema、使用的模型策略

---

#### 模块：ObjectStore（对象存储）

**职责**：存储所有业务对象的当前状态，是整个系统的"事实单一来源"（Single Source of Truth）。

类比：它不是传统关系型数据库（尽管底层用 PostgreSQL），而是一个"业务对象数据库"——每个对象有自己的类型（来自 Ontology）、属性（当前值）、历史版本（变更追踪）和关联（到其他对象）。

**输入**：

- ActionExecutor 的写入（对象创建、状态变更）
- Connector 采集数据的写入（传感器读数更新到对应 Equipment 对象）

**输出**：

- REST API 查询（Studio 读取对象列表和详情）
- 提供给 FunctionExecutor 的结构化上下文（AI 推理需要的"设备当前状态 + 历史"）
- 触发 EventDispatcher（每次对象状态变更自动发布变更事件）

---

#### 模块：Connector Framework（连接器框架）

**职责**：把企业现有 IT/OT 系统的数据拉进来，或接收外部推送事件，统一写入 ObjectStore。

这是 ClawTwin 与现有系统"不替换、只叠加"原则的实现点。连接器只是数据的入口，**不改变**源系统的结构和所有权。

**支持的连接方向与协议**：

| 方向             | 协议/方式                     | 典型来源                    |
| ---------------- | ----------------------------- | --------------------------- |
| 主动拉取（Pull） | OPC-UA、Modbus、REST API 轮询 | SCADA、DCS、工控机          |
| 被动接收（Push） | Webhook、MQTT、HTTP 回调      | ERP 工单状态、MES 生产事件  |
| 批量导入         | SQL 查询、CSV 导入            | Historian、遗留系统历史数据 |

**输入**：外部系统的原始数据（传感器值、事件通知、工单状态）  
**输出**：规整后的对象属性更新，写入 ObjectStore；由 ObjectStore 触发变更事件

**工业安全边界**：OT 控制系统（SCADA/DCS）**仅以只读接入**；ClawTwin 不向 L1-L2 控制层写回指令——这是工业安全红线。写回只发生在 L3 管理系统（ERP/MES）且经过人工审批门控。

---

#### 模块：Pipeline（数据管道）

**职责**：对进入 ObjectStore 的原始数据做规整、聚合、特征提取，使其对 AI 和业务逻辑更有用。

类比：ETL，但不是批量离线处理，而是事件驱动的流式转换。

**典型 Pipeline 操作**：

- 传感器原始读数 → 工程单位换算 → 滑动平均 → 告警阈值评估
- 多个传感器读数 → Mahalanobis 距离计算 → 设备健康评分（HealthScore）
- 原始告警事件 → 关联因果图查询 → 上下游影响设备列表附加

**输入**：ObjectStore 变更事件（由 EventDispatcher 发布）  
**输出**：丰富后的对象属性更新，写回 ObjectStore

---

#### 模块：EventDispatcher（事件总线）

**职责**：作为系统内部所有业务事件的**统一出口**和**分发枢纽**。

这是整个架构最重要的设计决策之一：所有业务事件（对象创建/变更、告警触发、Playbook 状态变化、HITL 结果）都必须经过 EventDispatcher，不允许模块之间直接调用。这样做的好处是：

1. **解耦**：语义层不知道 AI 行动层的存在；事件接收者可以随时增减而不影响发布者
2. **可审计**：所有事件有统一的日志入口
3. **可靠性**：与 Outbox 集成，保证事件送达；事件去重保证幂等

**输入**：任何模块调用 `EventDispatcher.dispatch(event_type, payload)`  
**输出**：把事件广播给所有注册的 Sink（PlaybookTriggerSink、FeishuSink、SSEFanoutSink、OutboxSink 等）

**注册的典型 Sink**：

| Sink                | 作用                                                       |
| ------------------- | ---------------------------------------------------------- |
| PlaybookTriggerSink | 收到业务事件 → 匹配 Playbook 触发条件 → 启动 Playbook 执行 |
| SSEFanoutSink       | 把事件实时推送给已连接的 Studio 前端（Server-Sent Events） |
| OutboxSink          | 把需要可靠投递的事件（飞书通知、Webhook 回调）入库 Outbox  |
| FeishuDirectSink    | 高优先级告警的即时飞书推送（走 OutboxDispatcher）          |

---

### 4.2 AI 行动层（AIP 工程等价）

**层的职责：订阅事件、编排流程、执行 AI 函数、驱动操作、向 Agent 暴露能力**

AI 行动层是"决策与执行"的发生地。它订阅语义层发出的事件，根据 Playbook 定义决定下一步做什么，调用 AI 函数获取诊断结论，驱动操作（创建工单、发送通知），并在需要时与外部 Agent 协作。

---

#### 模块：PlaybookEngine（Playbook 引擎）

**职责**：根据业务事件自动触发并编排预定义的工作流（Playbook）。

这是 ClawTwin 自动化能力的核心。一个 Playbook 是一段 YAML 声明的业务流程，包含：触发条件、步骤序列（可有条件分支）、HITL 门控（需要人工确认时挂起）、失败处理。

**工作流程**（以"告警到工单"为例）：

```
第1步  EventDispatcher 发布 alarm.created 事件
第2步  PlaybookTriggerSink 匹配到 Playbook "alarm_to_workorder"
第3步  PlaybookEngine 创建 PlaybookRun，进入执行状态
第4步  步骤 step_1：调用 FunctionExecutor.execute("DiagnoseEquipment")
          输入：{ equipment_id, alarm_id, lookback_hours: 24 }
          输出：{ summary, confidence, recommended_actions }
第5步  PlaybookEngine 判断 confidence < 0.9 → 触发 HITL 门控
          → 挂起 PlaybookRun，state = "waiting_for_human"
          → EventDispatcher 发布 playbook_run.waiting_for_human 事件
          → Outbox 投递飞书卡片（含 AI 诊断摘要 + 批准/拒绝按钮）
第6步  工程师在飞书点击"批准"
          → POST /v1/playbook-runs/{run_id}/resume {decision: "approve"}
          → PlaybookEngine 恢复执行
第7步  步骤 step_2：调用 ActionExecutor.execute("CreateWorkOrder")
          输入：{ alarm_id, diagnosis, assignee }
          输出：{ workorder_id, state: "pending" }
第8步  步骤 step_3：发送完成通知（经 Outbox）
第9步  PlaybookRun 完成，OutcomeCollector 写入 OutcomeEvent（供飞轮学习）
```

**输入**：事件（来自 EventDispatcher Sink）；HITL 决策（来自 REST API）  
**输出**：调用 FunctionExecutor / ActionExecutor；触发新的 EventDispatcher 事件；PlaybookRun 状态更新（写 ObjectStore）

**HITL 设计要点**：Playbook 挂起时不消耗任何资源，状态持久化在 ObjectStore；进程重启后可恢复；挂起超时可配置告警。

---

#### 模块：FunctionExecutor（AI 函数执行器）

**职责**：执行 FunctionType 定义的单次结构化 AI 推理。

这是一个关键概念澄清：**FunctionExecutor 不是聊天机器人**。它的每次调用都是：结构化输入 → 单次 LLM 调用 → 结构化输出，耗时 < 8 秒，结果完全可重复、可审计。类比是"带 AI 的 SQL 查询"——像查数据库一样调用 AI，而不是开启一段对话。

**调用前 FunctionExecutor 自动组装的上下文**（这是语义层价值的体现）：

```
输入到 AI 的 Prompt 包含：
  - 设备当前读数（来自 ObjectStore）
  - 过去 24 小时的历史趋势（来自 ObjectStore，经 Pipeline 特征化）
  - 历史相似案例 Top-5（来自 CBR 案例推荐引擎，向量相似度检索）
  - 相关知识库条目（来自 KnowledgeBase，关键词 + 语义检索）
  - 设备上下游关系（来自 Ontology LinkType + ObjectStore）
```

**输入**：function_type_id + 参数（equipment_id 等）  
**输出**：结构化 JSON（summary、confidence、recommended_actions、evidence 等）

**性能优化机制**：

- LRU 缓存（TTL 60 秒）：相同输入 60 秒内不重复调用 LLM，命中时 < 50ms 返回
- 模型分级路由：fast 模型（gpt-4o-mini 级别）用于初筛，smart 模型（gpt-4o 级别）用于深度分析；置信度低于阈值时自动升级
- Shadow Mode（Phase B）：新函数先静默运行不触发动作，验证输出质量后再激活

---

#### 模块：ActionExecutor（操作执行器）

**职责**：执行 ActionType 定义的有副作用操作——改变 ObjectStore 状态、调用外部系统、触发后续事件。

与 FunctionExecutor 的本质区别：Function 是"查"（只读计算），Action 是"做"（有副作用）。

**典型 ActionType 及其 I/O**：

| ActionType        | 输入                                | 副作用                          | 输出事件             |
| ----------------- | ----------------------------------- | ------------------------------- | -------------------- |
| CreateAlarm       | equipment_id, priority, description | ObjectStore 新增 Alarm 对象     | alarm.created        |
| AcknowledgeAlarm  | alarm_id, operator                  | Alarm.state → "acknowledged"    | alarm.acknowledged   |
| CreateWorkOrder   | alarm_id, type, assignee            | ObjectStore 新增 WorkOrder      | workorder.created    |
| DispatchWorkOrder | workorder_id                        | WorkOrder.state → "in_progress" | workorder.dispatched |
| CloseWorkOrder    | workorder_id, outcome               | WorkOrder.state → "completed"   | workorder.closed     |
| EscalateToERP     | workorder_id                        | 调用 ERP Webhook API            | erp.workorder.synced |

**输入**：action_type_id + 参数（来自 PlaybookEngine 或 REST API 直接调用）  
**输出**：对象状态更新（写 ObjectStore）；副作用执行（外部 API 调用）；发布对应事件（经 EventDispatcher）

---

#### 模块：MCP Server（Model Context Protocol 服务端）

**职责**：把 Platform 的能力和数据，以标准 MCP 工具协议暴露给外部 AI Agent（OpenClaw 等）。

MCP（Model Context Protocol）是 AI Agent 调用外部工具的标准协议。Platform 作为 MCP Server，让 Agent 可以"发现并调用"一组结构化工具，而不是直接访问数据库。

**暴露的工具类别**：

| 工具类别     | 示例工具名                               | Agent 调用用途       |
| ------------ | ---------------------------------------- | -------------------- |
| 对象查询     | get_equipment_status, list_alarms        | 查设备状态、告警列表 |
| 知识检索     | search_knowledge_base, get_similar_cases | 找相关规程、历史案例 |
| 操作执行     | create_work_order, acknowledge_alarm     | 创建工单、确认告警   |
| 平台状态     | get_station_health, list_pending_hitl    | 查站点健康、待审批项 |
| FunctionType | diagnose_equipment（封装调用）           | 请求 AI 诊断分析     |

**输入**：MCP 工具调用请求（来自 OpenClaw 或任何 MCP 客户端）  
**输出**：结构化 JSON 响应（工具执行结果）

**安全**：MCP 工具调用经过 Auth 模块校验（Service Token 或 JWT），所有操作写 Audit 日志。

---

#### 模块：AgentRuntime（Agent 运行时）

**职责**：当 Playbook 遇到需要"复杂多步推理"的场景时，把任务委托给外部 Agent，等待结果后继续流程。

这解决了 FunctionExecutor"单次结构化推理"无法覆盖的场景：需要多轮工具调用、需要对话上下文、需要处理不确定性高的开放问题。

**工作方式**：

```
Playbook step 标记 requires_agent_reasoning: true
  ↓
AgentRuntime.send_task(AgentTask(
    kind="reasoning",
    context={ alarm_context, equipment_history, available_actions },
    callback_url=...
))
  ↓
OpenClaw 接收任务 → 多步 MCP 工具调用 → 生成结论
  ↓
回调 Platform → PlaybookEngine 继续执行
```

**输入**：来自 PlaybookEngine 的任务委托（含业务上下文）  
**输出**：接收 Agent 推理结论（异步回调），继续 Playbook 执行

**可替换性设计**：AgentRuntime 是协议抽象，当前支持 OpenClaw、Coze、Dify、HiAgent、Stub（测试用）。切换 Agent 实现不需要改 Playbook 定义。

---

### 4.3 运维横切层（Apollo 等价）

**层的职责：让系统始终可信、可观测、可修复、可演进**

运维层不参与业务逻辑。它包裹在语义层和 AI 行动层外，确保整个 Platform 在生产环境下稳定运行。以下七件套构成工业级可靠性保障：

---

#### ① Outbox（可靠消息投递）

**为什么需要**：直接 HTTP 推送飞书/钉钉通知，进程重启时消息永久丢失。工业场景下告警通知丢失可能导致安全事故。

**机制**：所有需要可靠投递的消息先写入数据库（Outbox 表，事务性写入），再由独立的 OutboxDispatcher Worker 异步投递；失败后指数退避重试；成功后标记 delivered。

**保证**：At-least-once 语义（不丢）；配合去重保证（Dedupe）实现幂等（不重复打扰）。

**输入**：来自 EventDispatcher OutboxSink 的投递任务入库  
**输出**：向飞书/钉钉/Webhook 端点发送 HTTP 请求；更新投递状态

---

#### ② Dedupe（入站事件去重）

**为什么需要**：飞书/Webhook 在网络重试时会重复发送同一个事件。不去重会导致重复工单、双重通知、AI 重复计费。

**机制**：TTL-LRU 内存缓存（键为事件幂等 ID，TTL 10 分钟）；平台接收入站事件时先查缓存，命中则返回 200 但不处理。

**输入**：所有入站 Webhook 事件  
**输出**：去重后的事件（透明，调用方无感知）

---

#### ③ RateLimit（限流保护）

**为什么需要**：一个告警风暴（100 台设备同时报警）如果每次都触发 FunctionExecutor 的 LLM 调用，成本和响应时间都会崩溃。

**机制**：双维限流（接入层 = 按 IP + station_id；AI 层 = 按 IP + actor），令牌桶算法，超限返回 429 + Retry-After。

**输入**：所有 API 请求  
**输出**：通过的请求继续处理；超限的请求返回 429

---

#### ④ Doctor（系统自检）

**职责**：对 Platform 自身做全面健康检查，发现配置错误、依赖不可达、组件僵死等问题，并提供修复建议。

**内置检查项（与代码 `infra/doctor/builtin.py` 对齐）**：

| 检查 ID                 | 严重度   | 检查内容                    |
| ----------------------- | -------- | --------------------------- |
| db.connectivity         | CRITICAL | 数据库可达（SELECT 1 延迟） |
| clock.skew              | CRITICAL | 系统时钟在合理区间          |
| scheduler.alive         | WARN     | Scheduler 进程内最后心跳    |
| outbox_dispatcher.alive | WARN     | Outbox Worker 最后心跳      |
| outbox.backlog          | WARN     | 积压待投递消息数量          |
| capabilities.consistent | INFO     | Capability 依赖关系一致性   |

IndustryPack 可通过 `python_module.doctor_checks` 注册自定义检查（如 OPC-UA 连接握手）。

**接口**：`POST /v1/doctor/run` → 返回每项检查结果 + fix_hint；`POST /v1/doctor/run?fix=true` 自动修复可修项

---

#### ⑤ Health（健康维度聚合）

**职责**：把系统各维度健康状态（数据库、AI provider、Outbox、各 Worker、各 Capability）聚合为结构化的健康报告，供 Studio 管理后台和外部监控系统消费。

**接口**：`GET /v1/health/dimensions` → 返回 JSON 格式多维健康状态

---

#### ⑥ ReloadPlan（热重载）

**职责**：在不重启进程的情况下，安全地重载配置（环境变量）或 IndustryPack（本体/Playbook/handlers）。

类比：OpenClaw 的 `GatewayReloadPlan`；ClawTwin 的 ReloadPlan 是同等机制的工业版实现。

**"外科手术式"热重载的意义**：对于 24 小时不间断运行的工厂场站，每次改一个 Playbook 规则都需要停服重启是不可接受的。热重载使本体演进和规则更新对运营连续性透明。

**last-known-good 保护**：若重载后配置验证失败，自动回退到上一个工作状态，不会因为配置错误导致平台宕机。

**接口**：`POST /v1/admin/reload-config`（配置热重载）；`POST /v1/packs/reload`（Pack 热重载）

---

#### ⑦ AI Token 用量追踪

**职责**：每次 FunctionExecutor 调用 LLM 的用量（输入 tokens、输出 tokens、模型名、调用耗时、关联的 equipment_id / alarm_id）持久化写入数据库，可查询、可按维度汇总、可计费分摊。

**意义**：AI 成本透明化是企业采购 AI 系统的核心关切之一；黑盒计费是大型 AI 平台的常见痛点。ClawTwin 的用量表让 IT 管理员能说清楚"每月花了多少 AI token、哪台设备用了最多"。

---

### 4.4 接触层：apps / workers / packs

这三个目录是 Platform 的"外壳"，不含核心业务逻辑，但是系统对外暴露的实体入口。

**apps/（HTTP 接触层）**：FastAPI 路由挂载、飞书 Webhook 接收端点、CLI 入口。薄层——把 HTTP 请求转交给 core/aip/infra，不堆积领域规则。

**workers/（后台进程层）**：长生命周期独立进程，与主 HTTP 进程分离。包含：

- `opcua_collector`：OPC-UA 数据周期采集，写入 ObjectStore
- `scheduler`：定时任务（巡检 Playbook、阈值扫描、Playbook 超时检查）
- `outbox_dispatcher`：扫描 Outbox 表，驱动异步消息投递
- `outcome_collector`：工单关闭后收集 OutcomeEvent，更新 CBR 知识库权重

**packs/（行业场景包）**：把所有行业差异封装成可热加载的包。Pack 包含：行业本体 YAML、Python handlers、连接器参数、Playbook、可选 FastAPI router（挂载在 `/v1/packs/{pack_id}/`）、生命周期钩子。核心不含任何行业逻辑——换 Pack 就换行业。

---

## 第五章　三产品的接口关系总表

下表完整描述所有产品/模块间的跨边界接口：

| 调用方                | 被调用方              | 协议         | 方向              | 典型用途                                     |
| --------------------- | --------------------- | ------------ | ----------------- | -------------------------------------------- |
| Studio 前端           | Platform REST API     | HTTP/JSON    | 请求/响应         | 对象查询、操作下达、Playbook 触发/恢复       |
| Studio 前端           | Platform SSE          | HTTP/SSE     | 服务端推送        | 告警实时更新、Playbook 状态变化、HITL 请求   |
| OpenClaw              | Platform MCP Server   | MCP 协议     | 工具调用          | 查设备状态、检索案例、创建工单、请求 AI 诊断 |
| Platform AgentRuntime | OpenClaw              | HTTP/REST    | 委托任务          | 发送复杂推理任务（异步，带 callback）        |
| OpenClaw              | Platform REST         | HTTP/JSON    | 请求/响应         | Feishu 审批卡片点击后转发的 HITL 决策        |
| Platform Outbox       | 飞书/钉钉/Webhook     | HTTP/POST    | 主动投递          | 告警通知、HITL 审批卡片、工单状态更新        |
| Platform Connector    | OT 系统（OPC-UA 等）  | OPC-UA/MQTT  | 主动拉取          | 传感器读数采集（只读）                       |
| Platform Connector    | IT 系统（ERP/MES 等） | REST Webhook | 被动接收/主动推送 | 工单状态回写、生产事件接收                   |
| 外部 API 客户端       | Platform REST API     | HTTP/JSON    | 请求/响应         | 第三方系统集成（自动化流水线、BI 系统等）    |
| 运维工程师            | Platform CLI / Doctor | CLI / HTTP   | 请求/响应         | 自检、热重载、配置查看                       |

**依赖方向公理（不可违反）**：

1. Studio 和 OpenClaw **单向依赖** Platform；Platform **不依赖** Studio 和 OpenClaw（Platform 可独立运行）
2. Platform **可选地调用** OpenClaw（通过 AgentRuntime，配置开关控制）——这是配置依赖，不是代码依赖
3. 任何业务事件不得绕过 EventDispatcher 直接触发行动

---

## 第六章　知识飞轮：AI 与运营系统真正融合的机制

这一章解释为什么 ClawTwin 的 AI 会越用越准，而不是永远停在"部署时的水平"。

**飞轮的五个环节**：

```
① 传感器 → ObjectStore：感知，设备状态实时更新
② ObjectStore → FunctionExecutor：认知，AI 基于当前状态做诊断，给出推荐操作
③ FunctionExecutor → PlaybookEngine → HITL：行动，人工确认后执行
④ 工单关闭 → OutcomeCollector：反馈，记录 OutcomeEvent（"C-001 振动告警 → 更换轴承 → 14 天未复发"）
⑤ OutcomeEvent → CBR 引擎：学习，更新案例权重；下次相似情况，推荐准确率提升
```

**CBR（Case-Based Reasoning，案例推理）**：每次新的告警诊断请求，系统会在历史案例库中检索最相似的 5 个案例（基于设备类型、告警特征、工况参数的向量相似度），把这些案例作为 AI 推理的上下文，使模型的输出更贴合本企业的实际运营经验，而不是通用知识。

**飞轮的商业意义**：系统运行 6 个月后，AI 诊断的置信度会从初期的 60-70% 逐步提升到 80-90%，可自动执行（无需人工审批）的比例从 20% 提升到 60%。这是一个复利效应，越用越有价值。

---

## 第七章　业务价值与采购路径

### 7.1 为什么要买这个系统（ROI 叙事）

**减少告警响应时间**：从当前"接到告警 → 跨系统查询 → 决定处置 → 4-8 分钟"，优化到"飞书卡片 → 看 AI 诊断 + 置信度 → 一键审批 → 30 秒"。单个运营班每天可能处理 20-50 条告警，累积节约时间显著。

**降低 AI 使用门槛**：不需要让工程师学会"写提示词"——他们只是使用 Studio 或飞书里的标准工作流。AI 的能力对他们透明化为"工单里多了一个 AI 诊断摘要和推荐操作"。

**告警事件不丢失**：Outbox 机制保证高优先级告警通知的可靠投递，消除"飞书消息发出去但没人看到"的盲区。

**可审计的 AI 行动**：每次 AI 推理、每次操作执行、每次人工审批都有完整记录，满足工业合规要求（ISO、HSE 等）。

**渐进式上云与增量价值**：不替换现有系统，按阶段交付；每个阶段都有独立可验证的 ROI（见下方 SKU 路径）。

### 7.2 分阶段交付路径（SKU 价值阶梯）

| 阶段                     | SKU                  | 核心能力激活                                           | 典型 ROI                                   | 建议周期 |
| ------------------------ | -------------------- | ------------------------------------------------------ | ------------------------------------------ | -------- |
| **第一阶段：数字化底座** | ClawTwin Core        | 设备/告警/工单/审计全数字化；OPC-UA 接入；飞书告警推送 | 消除纸质/Excel 工单，告警有记录            | 2-4 周   |
| **第二阶段：AI 辅助**    | ClawTwin Intelligent | +AI 诊断函数；+CBR 知识库推荐；+因果图分析             | 工程师决策时间缩短 50%，经验开始沉淀       | 1-2 月   |
| **第三阶段：自治运营**   | ClawTwin Autonomous  | +Playbook 自动流程；+飞轮学习；+数字孪生健康评分       | 高置信度告警自动处置，人工干预减少 60%     | 3-6 月   |
| **第四阶段：对话驱动**   | +OpenClaw            | +MCP 工具暴露；+飞书对话问数；+跨系统推理              | 任何人通过 IM 访问运营智能；专家知识民主化 | 6-12 月  |

**关键销售要点**：第一阶段不需要 AI 预算，门槛极低；每个阶段结束时客户都已经获得可见价值，不是"大而全但迟迟见效"的大项目。

---

## 附录 A：与 Palantir 四条叙事线的完整对照

| Palantir 叙述          | 核心承诺                          | ClawTwin 对应                                                                       | 覆盖度与差异                                                               |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Gotham**             | 对象中心的工作台与协同决策        | ClawTwin Studio                                                                     | ✅ 运营工作台；差异：不做情报/安全，聚焦工业运营                           |
| **Foundry**            | 企业数据与语义的操作系统          | Platform **语义层**（Ontology + ObjectStore + Connector + Pipeline）                | ✅ 高度覆盖；差异：YAML 声明式本体，Python Protocol 连接器，更易扩展       |
| **AIP（工程能力）**    | 把 LLM 与业务数据接通，编排自动化 | Platform **AI 行动层**（Playbook + FunctionExecutor + ActionExecutor + MCP Server） | ✅ 高度覆盖；差异：强调"确定性 AI 函数"，区分单次推理与对话                |
| **AIP Assist（对话）** | 面向用户的自然语言 AI 助手        | **OpenClaw**（独立产品，可替换）                                                    | ✅ 功能对等；差异：**供应商可选**（MCP 开放），不绑定单一 AI 厂商          |
| **Apollo**             | 多环境部署、健康监控与治理        | Platform **运维横切层**（Doctor + Health + Outbox + ReloadPlan）                    | ⚠ 覆盖运营自愈核心；差异：不做多云控制面，强项在**边缘/单机/工业现场友好** |

**ClawTwin 相对 Palantir 的差异化优势**：

| 维度      | Palantir              | ClawTwin                                    |
| --------- | --------------------- | ------------------------------------------- |
| 部署      | 云优先，实施复杂      | 单机 Docker，5 分钟启动，断网工厂可用       |
| AI Assist | 绑定 AIP Assist，闭源 | MCP 开放，可接 OpenClaw / Coze / 自研 Agent |
| 扩展      | 专有 SDK，资质要求    | Python + YAML + Pack，任何开发者可扩展      |
| 飞轮      | 无闭环学习机制        | OutcomeEvent → CBR → 推荐准确率持续提升     |
| 成本      | 百万美元年合同        | 按站点/月，分阶段 SKU，低门槛进入           |

---

## 附录 B：本文档与其它架构文档的职责分工

| 文档                                   | 与本文的关系                                           |
| -------------------------------------- | ------------------------------------------------------ |
| `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`   | 协议字段级权威（API 参数、对象 Schema），实现时对齐它  |
| `DESIGN-FINAL-LOCK.md`                 | 全部 HTTP 端点路径锁（路径、方法、输入、输出、错误码） |
| `CLAWTWIN-RELIABILITY-ARCHITECTURE.md` | 七件套每一件的实现细节（代码路径、配置参数）           |
| `CLAWTWIN-SYSTEM-FRAMEWORK.md`         | 端到端事件流逐步详解（10 步传感器→工单完整链路）       |
| `CLAWTWIN-RESOURCE-ARCHITECTURE.md`    | 八类扩展轴的 ResourceManifest 规范与 Registry 运行时   |
| `CLAWTWIN-DEFINITIVE-REFERENCE.md`     | 模块拆分决策记录与已知边界违规项                       |
| `CLAWTWIN-PRODUCT-PACKAGING.md`        | SKU 能力对照表、行业 Pack × SKU 矩阵、定价锚点         |

---

_本文是 ClawTwin 架构叙事的**完整版主文档**，适合对外展示与对内对齐。技术契约变更时优先更新 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` 和 `DESIGN-FINAL-LOCK.md`，再同步本文相关章节。_
