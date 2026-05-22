# ClawTwin 架构关系系统化说明（纯文字）

**地位**: L1 架构层 · **系统化读本**（不写画图脚本；用条目与表格把层次、模块、多产品组合一次说清楚）  
**版本**: v1.0.0（2026-05-13）  
**代码真源**: `clawtwin-platform/platform-api/` · UI：`clawtwin-studio/`  
**配套**: `CLAWTWIN-DEFINITIVE-REFERENCE.md`（决策裁断）· `CLAWTWIN-SYSTEM-FRAMEWORK.md`（事件流与接口矩阵）· `CLAWTWIN-RESOURCE-ARCHITECTURE.md`（扩展 Registry）· `CLAWTWIN-PRODUCT-PACKAGING.md`（SKU 与 Capability）

---

## 阅读路径（按本节编号顺序阅读即可完成系统化理解）

1. 先读 **第一节术语**：对齐「产品 / SKU / 模块 / 扩展轴 / 契约面」的定义，否则后面名词会漂。
2. 再读 **第二节**：体系中五项顶层对象（Platform / Studio / Agent / Pack / 核心 `ontology/` 资产）的完整枚举。
3. 读 **第三节**：多产品逐项定位（是什么 / 不是什么 / 独占职责）。
4. 读 **第四节**：组合矩阵与 SKU 和三产品的正交关系。
5. 读 **第五节**：依赖与调用方向的五条公理（评审硬检查项）。
6. 读 **第六节**：Platform 目录级模块全集（模块完整性主收口）。
7. 读 **第七节**：八类扩展轴与 Pack 的分工。
8. 读 **第八节**：OpenClaw 资源边界与协作陈述。
9. **第九节**为企业 IT/OT 占位；**附录 A** 为 Palantir 一句对照（不占主线）。

---

## 一、术语（全文统一用法）

**产品（Product）**：可单独对外命名、有清晰边界与界面的一件事物。本文认定的独立产品有：**ClawTwin Platform**、**ClawTwin Studio**、以及生态位的 **OpenClaw（或其它 MCP Agent）**。IndustryPack **不是**并列的第四种「产品」，而是 **挂在 Platform 上的场景扩展载体**（见第二节）。

**SKU**：在同一套 Platform 代码上，通过 **Capability 开关**与 **Pack** 组合出来的商业套餐（细则见 `CLAWTWIN-PRODUCT-PACKAGING.md`）。SKU 改变的是「激活哪些平台能力」，不改变「产品解剖结构」。

**模块（Module）**：本文指 **`platform-api` 仓库内的目录级职责单元**（如 `core/object_store`、`infra/event_dispatcher`）。模块归属某一 **逻辑层**：语义层、AI 行动层、运维横切层，或接触层（`apps/`）、后台进程（`workers/`）、声明资产（`ontology/`）、场景包（`packs/`）。

**扩展轴（Resource Axis）**：可在 Registry 注册的 **八类本体相关扩展**（ObjectType、LinkType、ActionType、FunctionType、Connector、Pipeline、Playbook、IndustryPack），详见 `CLAWTWIN-RESOURCE-ARCHITECTURE.md`。

**契约面（Contract Surface）**：跨系统或跨产品边界上稳定的交互方式：REST、SSE、MCP、Webhook、CLI 等（细化分配见 `CLAWTWIN-SYSTEM-FRAMEWORK.md` 第五节）。

---

## 二、体系中可被交付或命名的对象（完整枚举）

下列五项共同构成客户环境里「ClawTwin 相关」的全部顶层对象；其中三项是 **独立产品或一等部署关切**，两项是 **Platform 的组成部分或资产形态**。

**（1）ClawTwin Platform（必选内核）**  
可 **脱离 Studio 与 OpenClaw 独立运行**（headless / API-only）。承载语义、编排、确定性 AI 函数、运维横切与对企业 IT/OT 的接入。**业务真相源（ObjectStore）与自动化编排（Playbook）只能存在于 Platform**，不得复制到 Studio 或 Agent。

**（2）ClawTwin Studio（人机界面产品）**  
独立前端应用仓库 **`clawtwin-studio`**，只通过 **REST / SSE（及约定的实时通道）** 使用 Platform。**不包含**不应重复的编排引擎与持久化业务内核。

**（3）OpenClaw 或其它 MCP Agent（可选外部智能体）**  
承担 **对话、多步推理、工具调用循环、会话记忆**。通过 **MCP** 调用 Platform 暴露的工具与上下文；Platform 可通过 **AgentRuntime** **可选地**把复杂推理任务 **委托**给登记过的 Agent。**Agent 不是 Platform 子模块**，也不是 Studio 的一部分。

**（4）IndustryPack（场景扩展载体）**  
以 `packs/<id>/` 形态挂载到 Platform：打包本体 YAML、handlers、连接器声明、可选 FastAPI router、生命周期钩子等。**不与前三者并列成「第四产品」**；它是 Platform **运行时加载的配置与代码集合**，销售上常与 SKU、行业方案绑定叙述。

**（5）默认本体声明与核心扩展目录（`ontology/` 仓库资产）**  
核心仓库内的 **声明式 Schema**（默认运营原语等）。与 Pack 的关系：**核心只保留通用原语与通用机制**；行业特有类型与函数应下沉到 Pack（已知例外与修正结论见 `CLAWTWIN-DEFINITIVE-REFERENCE.md` 第四节）。

---

## 三、多产品正确定位（逐项：是什么 / 不是什么 / 独占职责）

### 3.1 ClawTwin Platform

**是什么**：企业运营对象的 **语义内核** + **自动化行动内核** + **稳定性与运维外壳**；对企业 IT/OT 的 **接入、规整、编排、审计、可靠外联** 均在此完成。

**不是什么**：不是面向终端用户的聊天应用；不是 BI 报表替代品；**不应**在 UI 层重复实现 Playbook 引擎或对象持久化的第二真相源。

**独占职责（其它产品不得抢占）**：  
Ontology 驱动的类型系统；ObjectStore 持久化；Connector/Pipeline 数据路径；EventDispatcher 作为业务事件的统一出口；PlaybookEngine 编排；ActionExecutor / FunctionExecutor；MCP Server（对外工具契约）；Outbox 可靠投递链；Doctor/Health/ReloadPlan；Capability 门控；IndustryPack 加载。

### 3.2 ClawTwin Studio

**是什么**：运营人员的 **工作台**：告警视图、工单与审批、对象浏览、知识库与仪表盘、管理配置界面等（具体页面演进见 `CLAWTWIN-SYSTEM-FRAMEWORK.md`）。

**不是什么**：不是 Agent；不承担自然语言多轮推理；不直连替换 MCP 的工具实现细节（由 Platform 提供）。

**独占职责**：人机交互与可视化；将 Platform 的能力以操作与可读形式呈现；通过 REST/SSE **订阅**状态变化。

### 3.3 OpenClaw（或其它 Agent）

**是什么**：以 **自然语言** 为入口的推理与任务执行器；通过 MCP **读取** Platform 提供的结构化能力与上下文。

**不是什么**：不是告警与工单的权威存储；不是 Playbook 的唯一执行器（Playbook 始终在 Platform）。

**独占职责**：对话理解、规划、多轮工具循环、长上下文生成；可选用 OpenClaw 生态中的 channel/provider/skill（与 ClawTwin 扩展轴 **正交**，见第九节）。

### 3.4 IndustryPack 与核心仓库的关系（定位澄清）

Pack **扩展** Platform，**不平行于** Platform。多 Pack 可同时加载，形成「同一内核、多行业并行」的交付形态。Capability 与 Pack 共同决定 **运行时行为**，但不改变 **Platform / Studio / 外部 Agent** 三条产品边界（第三节）。

---

## 四、多产品组合与销售套餐（SKU）的逻辑关系

### 4.1 组合的最小公理

**公理 A**：任何对客户有意义的 ClawTwin 交付 **至少包含** Platform（否则没有语义与编排真相源）。  
**公理 B**：Studio **可选于 POC**，但不改变 Platform 必须存在；长期人机运营 **推荐** Platform + Studio。  
**公理 C**：OpenClaw **始终可选**；SKU 上对应「+OpenClaw」阶段（见产品包装文档），启用 MCP 与 AgentRuntime 配置后才形成完整「对话驱动运营」闭环。

### 4.2 组合矩阵（产品 × 是否 typical）

| 交付组合                   | Platform | Studio | OpenClaw | 典型用途                                 |
| -------------------------- | :------: | :----: | :------: | ---------------------------------------- |
| API-only / headless        |   必选   |   否   |    否    | 集成测试、仅对接自有前端、自动化流水线   |
| 标准人机运营               |   必选   |  必选  |    否    | 告警、工单、审批、仪表盘                 |
| 标准 + 对话入口            |   必选   |  必选  |   可选   | IM 里问数、复杂推理、飞书里协助填上下文  |
| 对话先行试点（不推荐长期） |   必选   |   否   |   可选   | 极窄 POC；缺少 Studio 时审批与可视化薄弱 |

### 4.3 SKU 与三产品的关系（概念对齐）

SKU（Core / Intelligent / Autonomous / +OpenClaw 等）在 **Platform 进程内** 切换 Capability 与模型策略（详见 `CLAWTWIN-PRODUCT-PACKAGING.md`）。**SKU 不替代 Studio 或 OpenClaw 的产品边界**：例如关闭 `ai` Capability 并不删除 Platform 中的连接器能力；只是禁用一类 AI 相关路径。**Studio 是否部署**、**是否接入 Agent** 是 **部署与集成决策**，与 SKU 正交但通常在商务套餐里捆绑叙述。

---

## 五、依赖关系与调用方向（全文最关键的骨架）

下列五条建议当作架构评审的 **硬性检查项**。

**（1）源代码依赖方向**：`clawtwin-studio` **不得**把 `platform-api` 当作嵌入库反向耦合核心业务逻辑；双方仅有 **网络契约**。OpenClaw 仓库同理：**独立**，仅 MCP 契约对接。

**（2）运行时依赖方向**：Studio → Platform（REST/SSE）；OpenClaw → Platform（MCP）；Platform → 企业系统（Connector/Webhook/SQL 等，按集成设计）。

**（3）可选反向调用**：Platform → OpenClaw（或其它 Agent）仅通过 **AgentRuntime** **配置启用**，语义为「委托复杂推理」，不是循环依赖：DAG 仍成立（集成文档模块依赖矩阵：`CLAWTWIN-INTEGRATION-ARCHITECTURE.md`）。

**（4）真相源唯一性**：运营对象状态与编排运行记录以 **Platform 持久化**为准；Studio 与 Agent 仅为客户端。

**（5）事件出口单一性**：面向自动化与投递的业务事件应经 **EventDispatcher** 统一出口，再进入 sinks / Outbox 链（稳定性论证见 `CLAWTWIN-RELIABILITY-ARCHITECTURE.md`）。

---

## 六、Platform 内部逻辑分层与目录级模块全集

Platform 内部采用 **两个垂直栈 + 一个横切运维壳** 的模型（与 `CLAWTWIN-SYSTEM-FRAMEWORK.md` 一致）。本节按 **`platform-api/` 顶层目录** 穷尽列出职责，并标明归属层。**下列表格是「模块完整性」的主收口处**。

### 6.1 接触层与入口（面向 HTTP / CLI / Webhook）

| 路径    | 归属                                                     | 职责摘要                                                                                            |
| ------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/` | 接触层（不属于语义/行动/运维三角的业务内核，但承载入口） | HTTP 路由挂载、Webhook（如飞书）、CLI 入口；**薄层**：把请求转交 core/aip/infra，不在此堆积领域规则 |

### 6.2 语义层（Foundry 等价：世界模型与数据路径）

| 路径                                              | 归属               | 职责摘要                                            |
| ------------------------------------------------- | ------------------ | --------------------------------------------------- |
| `ontology/`（仓库内声明资产）                     | 语义声明           | 默认 ObjectType 等 YAML；行业特有应主要由 Pack 承载 |
| `core/object_store/`                              | 语义层             | 对象持久化与查询真相源                              |
| `core/connector_declarative.py` 及连接器实现目录  | 语义层             | 外部系统数据接入契约与实现                          |
| `core/pipeline_runner.py`（及 Pipeline 相关实现） | 语义层             | 数据变换、规整、特征路径                            |
| `core/extension_registry/`                        | 语义层（元机制）   | 八类扩展资源的注册与发现统一入口                    |
| `core/domain_logic/`                              | 语义层（通用算法） | CBR、因果图、FSM 等通用逻辑（行业化应保持可替换）   |

### 6.3 AI 行动层（AIP 工程等价：编排与执行）

| 路径                      | 归属      | 职责摘要                                                                                             |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `core/playbook_engine/`   | AI 行动层 | Playbook 解析、触发、步骤执行、HITL 挂起与恢复                                                       |
| `core/action_executor/`   | AI 行动层 | ActionType 执行与副作用                                                                              |
| `core/function_executor/` | AI 行动层 | FunctionType：含单次结构化 LLM 调用路径                                                              |
| `aip/`                    | AI 行动层 | AgentRuntime、MCP Server、PromptRegistry、EvalRunner、OpenAPIExporter 等与「对外 AI 契约」相关的模块 |

**边界陈述**：**对话型**推理不在 `core/function_executor` 内无限展开；多轮逻辑在 Agent。

### 6.4 运维横切层（Apollo 等价：可靠、可观测、可演进）

| 路径                                                                                          | 归属            | 职责摘要                                             |
| --------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| `infra/event_dispatcher.py` 及相关 sinks                                                      | 运维 + 语义交界 | 统一事件出口；注册渠道 sink                          |
| `infra/` 下 Outbox、RateLimit、Hooks、Settings、ReloadPlan、`capabilities`（Capability 门控） | 运维横切        | 可靠投递、滥用防护、生命周期钩、热重载、SKU 能力开关 |
| `infra/doctor/`、`infra/health/`                                                              | 运维横切        | 自检与健康维度                                       |
| `infra/auth/`、`infra/marking.py`、`infra/audit.py`、`infra/lineage.py`                       | 运维横切        | 安全、标记、审计、血缘                               |

### 6.5 后台进程与定时任务

| 路径       | 归属                           | 职责摘要                                                                  |
| ---------- | ------------------------------ | ------------------------------------------------------------------------- |
| `workers/` | 运维与语义交界（独立进程单元） | OPC-UA 采集、调度器、Outbox 派发、Outcome 收集等 **长生命周期或周期任务** |

### 6.6 场景扩展

| 路径          | 归属                   | 职责摘要                                                                 |
| ------------- | ---------------------- | ------------------------------------------------------------------------ |
| `packs/<id>/` | 场景扩展（运行时挂载） | 行业本体、handlers、连接器参数、Playbook、manifest、可选 router/services |

**说明**：`aip/` 与 `core/playbook_engine` 的分工在工程上均以代码为准；架构叙述上二者同属 **AI 行动层**，对外统一说成「Platform 编排与 AI 工程能力」即可，避免听众误以为有两个并行编排内核。

---

## 七、扩展轴（八类）与「谁在扩展谁」

下列八类资源定义 **工业侧如何长在 Platform 上**（统一 manifest 思想见 `CLAWTWIN-RESOURCE-ARCHITECTURE.md`）：

ObjectType，LinkType，ActionType，FunctionType，Connector，Pipeline，Playbook，IndustryPack。

**系统化结论**：  
核心仓库提供 **引擎与 Registry**；行业差异 **主要通过 Pack 写入上述轴**；Capability 决定 **哪些引擎路径在运行时启用**。这与 OpenClaw 侧的 channel/agent/provider 等扩展轴 **互补、不重复**（所有权表见第八节）。

---

## 八、OpenClaw 与 ClawTwin 的资源边界（文字版）

下列左侧归 OpenClaw 生态演进；右侧归 ClawTwin Platform：

OpenClaw 拥有：Channel，Agent，Provider，Skill，MCP Client，Plugin，Hook，Tool（对话侧装配）。

ClawTwin 拥有：ObjectType，ActionType，FunctionType，Connector，Pipeline，Playbook，IndustryPack，Knowledge Base（领域知识沉淀路径），OutcomeEvent（飞轮标签），MCP Server（向 Agent **提供**工具）。

**协作陈述**：OpenClaw **作为** AgentRuntime 的实现之一时，Platform **向**其暴露 MCP；Platform **可向**其发送委托任务。**替换 Agent 实现不改变 Platform 模块表**。

---

## 九、与企业 IT/OT 的对接层级（叙述占位）

Platform 贴在企业分层之间：**对上**对接 ERP/MES/OA 等（L3-L5）；**对下**对接 OPC-UA、Historian、PLC 生态（L1-L2）。工业安全边界：**OT 侧以只读接入为主**；写回走管理与审批门控（细化见 `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`）。

---

## 附录 A：Palantir Gotham / Foundry / AIP / Apollo 对照（仅占位，不占主线）

Studio 叙事对齐 Gotham（工作台）；Platform 同时承载 Foundry（语义）、AIP（工程化 AI 与编排）、Apollo（轻量运维）三类能力；Assist 对齐外部 Agent。主线推理无需依赖本附录；展开叙述见 `CLAWTWIN-PALANTIR-POSITIONING.md`。

---

## 附录 B：与其它文档的职责分工

| 文档                                   | 本文与之分工                                    |
| -------------------------------------- | ----------------------------------------------- |
| `CLAWTWIN-DEFINITIVE-REFERENCE.md`     | 决策裁断、Palantir 细映射、已知边界违规项       |
| `CLAWTWIN-SYSTEM-FRAMEWORK.md`         | 端到端事件流逐步示例、Studio 页面架构、接口矩阵 |
| `CLAWTWIN-INTEGRATION-ARCHITECTURE.md` | 用户旅程、集成纵深、性能与飞轮叙事              |
| `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`   | HTTP 与本体协议字段级权威                       |
| `DESIGN-FINAL-LOCK.md`                 | 路径级 HTTP 锁                                  |

**本文**：在多产品定位、组合逻辑、Platform 目录模块全集、依赖公理四条线上做 **单一系统化收口**，便于评审与 onboarding **不靠画图**也能对齐。

---

_维护约定：若 `platform-api/` 顶层目录增减，优先更新 **第六节表格** 与 `DESIGN-FINAL-MASTER-INDEX.md` 指向。_
