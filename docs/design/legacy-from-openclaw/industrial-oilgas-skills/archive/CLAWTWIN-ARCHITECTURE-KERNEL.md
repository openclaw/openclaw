# CLAWTWIN ARCHITECTURE KERNEL — 深度架构重思

**地位**: 🟢 核心 / Architecture / Authoritative  
**版本**: v1.0.0 (2026-05-13)  
**替换**: 本文档整合并取代 `CRITICAL-ARCHITECTURE-REVIEW.md`、`ARCHITECTURE-FINAL-REVIEW.md` 中的架构讨论  
**目标读者**: 技术架构师、核心开发者

---

## 一、结论先行（给忙碌的读者）

| 问题                     | 答案                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| L2.5 层叫什么？          | **运营语义层（Operational Semantic Layer）**，不是"运营AI协作层"                |
| 对标 Palantir 哪个产品？ | **Foundry + AIP 的合体**，但面向单站点/SME 规模，单进程可部署                   |
| 架构几层？               | **三层**：语义基座（Foundation）/ 智能引擎（Intelligence）/ 行动界面（Surface） |
| 最大架构空洞是什么？     | **AI 模型提供商抽象缺失**（`ai_runner.py` 是空壳），本文档同步修复              |
| 和 OpenClaw 的关系？     | ClawTwin 是 **OpenClaw 的业务基础设施层** 的工业实例                            |

---

## 二、L2.5 命名的精确性分析

### 2.1 为什么不叫"运营AI协作层"？

"协作"暗示被动、辅助，像"帮助AI工作"。这个层次实际做的是：

> **给企业运营数据赋予语义结构**，让 AI 和人类都能在同一套本体上操作。

这是 Palantir 对 Foundry 最精确的描述：  
"An ontological layer that gives meaning to raw operational data."

### 2.2 为什么叫"运营语义层"？

**语义**（Semantic）是精确词汇：

```
原始数据（Raw Data）
  工业传感器读到: 87.3℃                  ← 没有语义，只是数字

语义化之后（Semantic Layer）：
  这是 ST-001 站的 PUMP-A 型泵 #3 的
  轴承温度（bearing_temperature_c）
  超过预警阈值（75℃），触发 WARN 级告警
  当前设备健康分 0.62（下降趋势）         ← 有语义，可行动
```

"运营语义层"精确描述这个转化：**从像素/信号到可行动知识的语义提升**。

### 2.3 完整的企业 IT 层次图

```
┌─────────────────────────────────────────────────────────────────┐
│  战略层 L5   ERP / BI / 财务报表 / 治理                          │  ← 不碰
├─────────────────────────────────────────────────────────────────┤
│  管理层 L4   OA / 审批流 / 人力 / 采购                           │  ← 对接/回写
├─────────────────────────────────────────────────────────────────┤
│  运营层 L3   MES / CMMS / WMS / CRM                             │  ← 双向对接
├─────────────────────────────────────────────────────────────────┤
│  ★ 运营语义层 L2.5  ← ClawTwin 在这里                           │
│    · Ontology（ObjectType/LinkType/ActionType/FunctionType）     │
│    · Object Store（实体 CRUD + 审计 + Marking）                  │
│    · AI 函数（诊断/推荐/预测 — 语义化 AI 推断）                  │
│    · Playbook（业务编排 — 从告警到行动的语义化工作流）             │
│    · 知识库（L0-L3 分层知识 — 语义化记忆）                        │
│    · 学习飞轮（OutcomeEvent — 从人类干预中持续获取语义标签）       │
├─────────────────────────────────────────────────────────────────┤
│  数据集成层 L2  ESB / API Gateway / ETL                         │  ← Connector 对接
├─────────────────────────────────────────────────────────────────┤
│  感知层 L1   SCADA / OPC-UA / PLC / DCS / IoT                   │  ← ingest API 接入
└─────────────────────────────────────────────────────────────────┘

横向服务（不在层次中，跨层可用）：
  AI 智能体（OpenClaw 等）   → MCP/HTTP 调用 ClawTwin 作为工具
  飞书/钉钉/企业微信/邮件    → Channel 接收通知和操作
  ClawTwin Studio（UI）     → 读取 L2.5 层数据可视化
```

---

## 三、Palantir 映射：Foundry vs AIP vs ClawTwin

### 3.1 Palantir 产品线的精确分工

| 产品        | 核心功能                                         | 技术隐喻       |
| ----------- | ------------------------------------------------ | -------------- |
| **Foundry** | 数据集成 + 本体 + 管道 + 权限治理                | "数据操作系统" |
| **AIP**     | 将 LLM 连接到 Foundry 本体，执行 AI 驱动的工作流 | "AI 操作系统"  |
| **Gotham**  | 情报分析、目标识别（军政）                       | "分析操作系统" |
| **Apollo**  | 部署、升级、运维（多云/边缘）                    | "部署操作系统" |

Palantir 的深刻洞察：**把每一类"操作"都抽象成一个 OS**，以 OS 思维构建企业软件。

### 3.2 ClawTwin = 迷你 Foundry + 迷你 AIP

```
Palantir:
  Foundry (数据OS) + AIP (AI OS) = 独立产品，大企业/政府规模
                                   需要 10+ 人团队 6 个月实施

ClawTwin:
  Foundation (本体+连接器) + Intelligence (AI+Playbook) = 单一可部署单元
                                                           1人1天可部署
                                                           SME/站点规模
```

**ClawTwin 是 Foundry+AIP 的"现场版"**：去掉了 Palantir 的分布式基础设施和
数据治理复杂度，保留了本质的本体 + AI 操作这两层抽象，让它能在单机甚至 Raspberry Pi
上运行。

### 3.3 为什么单体设计比两产品叠加更合适？

| 维度     | Palantir（分产品）          | ClawTwin（合体）              |
| -------- | --------------------------- | ----------------------------- |
| 目标客户 | 政府/大企业，数据工程师团队 | 工厂/医院/物流站，现场工程师  |
| 部署时间 | 6-18 个月实施               | 1 天 Docker Compose           |
| 数据规模 | PB 级                       | GB-TB 级                      |
| 开发团队 | 100+ 人                     | 1-3 人                        |
| 定制能力 | 极高（需要 Foundry 专家）   | 中等（IndustryPack 即插即用） |

---

## 四、ClawTwin 三层架构（重新清晰定义）

### 4.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                     ClawTwin Runtime                             │
│                                                                  │
│  ┌─────────────────── Surface Layer（行动界面层）──────────────┐  │
│  │  HTTP API (FastAPI)  │  MCP Server  │  Channel Notifications │  │
│  │  Studio UI bridge    │  SSE/WS      │  飞书/钉钉/email/SMS  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                ↕ (事件/请求/响应)                  │
│  ┌────────────── Intelligence Layer（智能引擎层）────────────────┐  │
│  │  AI Functions        │  Playbook Engine    │  HITL            │  │
│  │  · DiagnoseEquipment │  · Trigger rules    │  · ApprovalFlow  │  │
│  │  · RecommendAction   │  · Step execution   │  · Decision node │  │
│  │  · PredictTrend      │  · HITL gate        │  · Audit trail   │  │
│  │                      │                     │                  │  │
│  │  Knowledge Base (L0-L3)    Agent Runtime (OpenClaw/MCP)       │  │
│  │  · pgvector KB             · MCP tool server                  │  │
│  │  · CBR recommendation      · OpenClaw agent calls             │  │
│  │  · LLM Trace + Eval        · Model Provider (本次新增) ←      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                ↕ (查询/写入)                       │
│  ┌──────────── Foundation Layer（语义基座层）────────────────────┐  │
│  │  Ontology Engine     │  Object Store       │  Event Bus       │  │
│  │  · ObjectType        │  · CRUD + marking   │  · EventDispatch │  │
│  │  · LinkType          │  · audit trail      │  · Outbox        │  │
│  │  · ActionType        │  · lineage track    │  · SSE push      │  │
│  │  · FunctionType      │                     │                  │  │
│  │                      │                     │                  │  │
│  │  Connector Framework │  Pipeline Runner    │  Storage         │  │
│  │  · OPC-UA            │  · ETL              │  · PostgreSQL    │  │
│  │  · ERP adapters      │  · transforms       │  · TimescaleDB   │  │
│  │  · REST/JDBC/SFTP    │  · validation       │  · Redis         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──── Infra Cross-Cuts（基础设施横切面）────────────────────────┐  │
│  │  Capabilities │ Doctor/Health │ Outbox │ Auth/Marking │ Rate  │  │
│  │  Registry     │ self-check    │ retry  │ multi-tenant  │ Limit │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 每层的职责边界（关键：层间不越界）

**Foundation Layer（语义基座）**

- 负责：本体定义、实体存储、数据连接、事件总线
- 不负责：任何 AI 推断、业务判断、人机交互
- 对外接口：`GET/POST /v1/equipment`, `/v1/ontology`, `/v1/ingest`
- 类比：Palantir Foundry 的核心（本体 + 数据集成）

**Intelligence Layer（智能引擎）**

- 负责：AI 函数执行、Playbook 编排、知识检索、CBR 推荐、HITL
- 不负责：数据存储实现、网络协议、UI 渲染
- 对外接口：`POST /v1/functions/invoke`, `/v1/playbooks`, `/v1/recommendations`
- 类比：Palantir AIP（AI 连接到本体执行行动）

**Surface Layer（行动界面）**

- 负责：HTTP API、MCP 工具、通知路由、SSE 事件流
- 不负责：业务逻辑、AI 推断
- 对外接口：整个 `apps/http/routes/` + MCP server
- 类比：Palantir 的"应用层"（Quests、Slate、Workshop）

---

## 五、OpenClaw 关系深度分析

### 5.1 与 OS 的关系（进程层面）

OpenClaw 的 OS 关系设计：

```
信号处理:  SIGTERM → graceful shutdown（保存会话、关闭 channel、刷新 queue）
文件系统:  config file watch → config hot reload（chokidar）
进程管理:  child process spawn for tools that need isolation
环境变量:  所有配置通过 env；无"配置文件格式"争议
```

ClawTwin 等价设计：

```
信号处理:  SIGTERM → graceful shutdown（本轮新增，workers/scheduler.py）
文件系统:  无 file watch（配置通过 env + DB），但 capability hot reload
进程管理:  单进程 + worker threads（asyncio）
环境变量:  CLAWTWIN_* 环境变量体系（已实现）
```

**差异**：OpenClaw 需要监听文件是因为用户通过文件编辑配置；ClawTwin 的"配置"
通过本体和 DB 表管理，不需要文件 watch。

### 5.2 与硬件的关系

OpenClaw 的硬件感知：

- 检测 Mac 型号（M1/M2/M3）用于 SystemPresence 显示
- 检测键盘空闲时间（lastInputSeconds）用于用户存在感知
- 检测本机 IP 用于 gateway 地址显示

ClawTwin 的硬件需求（工业更强）：

- 检测可用内存 → 决定是否启用向量索引（`pgvector` 需要内存）
- 检测 GPU 可用性 → 决定是否启用本地 LLM（Ollama）
- 检测磁盘空间 → Doctor check 预防 TimescaleDB 超限
- 边缘部署（ClawTwin Edge）→ 检测 CPU 核数决定 worker 并发数

**设计原则**：资源感知应该通过 **Doctor check** 暴露，不直接影响启动——即资源不足
时降级而不是拒绝启动。

### 5.3 与 AI 模型的关系（最重要）

OpenClaw 的模型抽象（经过 ~3 年迭代的最佳实践）：

```typescript
// OpenClaw provider plugin 接口核心
interface ProviderPlugin {
  id: string;
  createStreamFn(ctx): (messages, tools) => AsyncGenerator<Chunk>;
  normalizeToolSchemas(ctx): ToolSchema[]; // 各模型 schema 格式不同
  normalizeModelId(ctx): string;
  applyConfigDefaults(ctx): ModelConfig;
  // ... 20+ hooks
}
```

OpenClaw 学到的痛苦经验：

1. **工具 schema 格式各不相同**：Gemini 不支持 `minLength`；xAI 不支持 `anyOf`
2. **模型 ID 命名混乱**：`gpt-4o` vs `gpt-4-omni` 等，需要标准化层
3. **认证方式不同**：API key vs OAuth vs service account
4. **推理模式不同**：有些模型返回 reasoning trace，有些不返回
5. **token 计量不同**：需要统一的 usage 结构

ClawTwin 的简化版本（不需要 20+ hooks，但需要核心 3 个）：

```python
class ModelProvider(Protocol):
    async def complete(messages: list[Message], *, system: str, max_tokens: int) -> Completion: ...
    async def embed(text: str) -> list[float]: ...  # 向量化
    @property
    def model_id(self) -> str: ...
```

**关键决策**：ClawTwin 不需要 tool calling 抽象（工具调用通过 Playbook + MCP
实现，不通过 function calling）。这大大简化了提供商接口。

### 5.4 与库（Libraries）的关系

OpenClaw 的库策略：

- **核心无重型依赖**：TypeScript + Node 原生 + 少量精选库
- **提供商 SDK 是可选对等依赖**：`@anthropic-ai/sdk` 只在 anthropic 插件里
- **类型安全**：TypeBox（运行时 schema）+ TypeScript strict mode
- **扩展隔离**：每个 extension 有自己的 node_modules

ClawTwin 的对应策略：

- **核心：FastAPI + SQLAlchemy + Alembic + Pydantic**（已实现）
- **AI 提供商 SDK 是可选依赖**：`anthropic`/`openai` 在 `infra/ai_provider/` 里，
  有无安装均可运行（降级到 stub）
- **扩展：IndustryPack**（通过 extension_registry 注册，不需要独立进程）
- **边界校验：Pydantic**（已实现）

---

## 六、产品定位精炼（取代"智能中枢"）

### 6.1 "智能中枢"的问题（再次明确）

"中枢"（Hub）= 数据路由中心，暗示：

- 无状态路由（实际 ClawTwin 高度有状态）
- 高吞吐消息转发（实际 ClawTwin 是语义理解，不是消息转发）
- 像 ESB/Kafka（实际完全不同）

### 6.2 更好的产品定位比喻

| 比喻                         | 描述                                     | 是否准确        |
| ---------------------------- | ---------------------------------------- | --------------- |
| 🏭 **生产控制室的大脑**      | 汇集所有传感器信息，为人类提供理解和建议 | ✅ 好，但太工业 |
| 🧠 **运营智能内核**          | 嵌入企业运营流程中的 AI 大脑，可插拔     | ✅ 准确且通用   |
| 📚 **运营知识库 + 行动引擎** | 记住历史，理解现在，建议行动             | ✅ 精确但啰嗦   |
| 🔬 **运营 AI 平台**          | AI 驱动的运营系统                        | ✅ 最通用       |

**推荐定位表述**（根据受众调整）：

- 技术受众：**"面向运营实体的 AI 函数平台，提供本体、行动和学习飞轮"**
- 业务受众：**"让 AI 理解你的业务，记住历史，建议最佳行动"**
- 投资人受众：**"工业/运营场景的 Palantir，单站点可部署，开源可扩展"**

---

## 七、当前最大架构空洞及修复计划

### 7.1 空洞清单（本次审计发现）

| 空洞                         | 位置                                       | 风险                             | 修复方案                  |
| ---------------------------- | ------------------------------------------ | -------------------------------- | ------------------------- |
| **AI Provider 抽象缺失**     | `core/function_executor/ai_runner.py` 空壳 | 🔴 所有 AI Function 只是规则引擎 | `infra/ai_provider/` 本轮 |
| **SIGTERM 未处理**           | `workers/scheduler.py` 等                  | 🟡 强杀进程导致 DB 脏数据        | 本轮                      |
| **Outbox dispatcher 未实现** | `infra/outbox/` 有持久层无调度             | 🟡 事件积压                      | v1.2                      |
| **Playbook 引擎是占位符**    | `apps/http/routes/playbooks.py`            | 🟡 核心业务价值受限              | v1.3                      |
| **Studio UI 缺少行动界面**   | `clawtwin-studio/`                         | 🟡 用户无法可视化操作            | v2.0                      |

### 7.2 本轮修复：AI Provider 抽象

设计对标 OpenClaw provider-runtime，但大幅简化：

```
infra/ai_provider/
├── __init__.py          # 公共接口：Message, Completion, ModelProvider Protocol
├── registry.py          # 提供商注册表 + get_provider() 工厂
├── openai_compat.py     # OpenAI 兼容适配器（支持 Ollama/vLLM/local）
├── anthropic_compat.py  # Anthropic Claude 适配器
└── stub.py              # 无配置时的 stub（保证 fail-open）
```

---

## 八、ClawTwin 与 OpenClaw 的协作模式（澄清定位关系）

ClawTwin 和 OpenClaw **不是竞争关系**，是**协作关系**：

```
用户 → 飞书/Slack/Terminal
  ↓
OpenClaw（对话层）
  ↓  [调用 MCP 工具]
ClawTwin MCP Server（工具接口）
  ↓  [查询/写入 ontology]
ClawTwin Foundation（语义基座）
  ↓
SCADA/ERP/IoT 实际数据
```

**OpenClaw 做什么**：理解用户意图，管理对话上下文，调用工具
**ClawTwin 做什么**：提供业务语义工具，维护运营知识，学习反馈

两者组合形成完整的 Human-AI-Operations 闭环：

- 人类通过 OpenClaw（自然语言）与 ClawTwin（结构化业务）交互
- ClawTwin 通过 MCP 给 OpenClaw 提供业务工具
- OpenClaw 通过 HITL 让人类确认 ClawTwin 的建议

这是比"智能中枢"更清晰的定位：**ClawTwin 是 OpenClaw 的工业/运营业务插件**。

---

## 九、技术债清理优先级

| 优先级      | 项目                             | 理由                            |
| ----------- | -------------------------------- | ------------------------------- |
| **P0 本轮** | AI Provider 抽象                 | 没有这个，AI Functions 全是假的 |
| **P0 本轮** | SIGTERM graceful shutdown        | 工业环境重启必须干净            |
| **P1 v1.2** | Outbox dispatcher worker         | outbox 持久层不接调度就是死代码 |
| **P1 v1.2** | Playbook 引擎骨架                | 核心业务价值                    |
| **P2 v1.3** | SystemPresence 等价（heartbeat） | 多实例运维可见性                |
| **P2 v1.3** | 文档归档                         | 认知负担                        |
