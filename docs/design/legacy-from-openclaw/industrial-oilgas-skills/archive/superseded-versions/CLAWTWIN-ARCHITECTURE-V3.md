# ClawTwin Platform · 架构设计 V3.1

**单一权威来源 · 取代 V3 及此前所有版本**

> 版本：2026-05-14 · 包含多轮架构讨论全部结论

---

## 零、本文档的用途

回答五个根本性问题：

1. **ClawTwin 是什么**：定位、边界、商业模型、客户
2. **它由什么组成**：五类资源 + 两个执行机制的完整语义说明
3. **它如何运转**：最小核心、消息流、事件驱动
4. **它如何进化**：规则迭代、记忆积累、LLM 自驱动演化
5. **它如何被构建**：库选型、阶段规划、语言选择理由

---

## 一、系统定位与商业模型

### 1.1 一句话定位

**ClawTwin Platform = 企业的 AI 大脑。**

连接企业所有物理实体（设备、物料、人员、流程），持续感知状态，智能分析异常，自主或辅助执行决策，通过每次操作积累知识，越用越聪明。

### 1.2 商业变现模型

**原则：不以开源为卖点，不以开源为策略。这是一个商业产品。**

| 变现模式                 | 说明                                                | 适合阶段   |
| ------------------------ | --------------------------------------------------- | ---------- |
| **私有化部署许可证**     | 一次性或年费，客户自主部署在本地/私有云             | 立刻可用   |
| **按 IndustryPack 订阅** | 核心平台低价，行业 Pack（油气/电力/制造）按功能订阅 | 产品成熟后 |
| **SaaS 托管服务**        | 面向无 IT 能力的中小企业，云端托管                  | Phase B+   |
| **专业服务**             | 实施交付、定制开发、培训、优化                      | 立刻可用   |
| **IndustryPack 市场**    | 合作伙伴开发专属 Pack，平台抽成                     | Phase C    |
| **AI 洞察报告订阅**      | 基于平台数据生成行业基准报告                        | Phase C+   |

**中国市场最有效的组合**：私有化部署许可证 + 专业实施服务 + 行业 Pack 年费订阅。
客户数据不出本地（数据主权），软件功能持续升级（订阅价值），实施费用弥补早期现金流。

### 1.3 真实客户和刚需分析

**Palantir Foundry 的实际客户**：

Palantir Foundry **不是专门面向工业企业的**，它是通用企业数据平台：

- 主要客户：政府国防（Gotham）、制药（FDA、辉瑞）、金融（摩根士丹利）、工业（BP、空客、大众）
- 工业是 Foundry 的一个客户群，不是全部
- Palantir 的实际合同：$500 万~$5000 万/年，门槛极高

**ClawTwin 的刚需客户**（Palantir 无法覆盖的市场）：

| 客户类型                           | 刚需来源                                     | 市场规模            |
| ---------------------------------- | -------------------------------------------- | ------------------- |
| 中型制造企业（$5000 万~$5 亿营收） | 设备意外停机每小时损失巨大，无预测性维护能力 | 中国制造企业 40 万+ |
| 化工/石化中型企业                  | 安全事故风险极高，监管要求严格               | 数千家              |
| 电力/能源运营商                    | 碳中和目标倒逼能效优化，人力紧张             | 各省电网 + 民营     |
| 大型集团的子工厂                   | 集团推智能制造，子工厂没能力实施             | 极大市场            |
| 国内工业互联网推进                 | 国家战略级推动，有政策补贴                   | 政策市场            |

**刚需的核心**：

- 设备停机损失：中型工厂每次意外停机损失 10~~100 万，年发生 5~~20 次
- 安全合规：化工/电力的事故/罚款成本远超 IT 投入
- 人力替代：熟练工人短缺 + 人工成本上升，自动化是必然
- 数字化转型：工厂已有 PLC/DCS，但数据孤岛，没有智能层

**结论**：ClawTwin 的定位没有问题。Palantir 的工业客户是有钱的大企业，ClawTwin 的工业客户是有需求但没有解决方案的中型企业——这才是真正未被服务的刚需市场。

### 1.4 与 Palantir 的关系

| 维度     | Palantir                          | ClawTwin                         |
| -------- | --------------------------------- | -------------------------------- |
| 价格     | $500 万+/年                       | 私有化许可 + Pack 订阅           |
| 目标客户 | 大型跨国企业、政府                | 中型工业企业、工厂               |
| OT 接入  | 需要 PI System/MindSphere 中间件  | 原生 OPC-UA/Modbus               |
| 自主执行 | 仅决策支持                        | 自主执行 + 辅助决策              |
| 语言     | 英文为主，国际化                  | 中文原生，飞书/企业微信/国产 LLM |
| 部署方式 | 云优先（Palantir Cloud）          | 私有化优先（数据不出本地）       |
| 实施方式 | 驻场顾问团队（3~~10 人/6~~18 月） | LLM 辅助自配置（2~4 周）         |

---

## 二、五类资源 + 两个执行机制：完整语义说明

### 2.1 五类资源（Pack 可注册）

#### Connectors（连接器）— 企业的"感知层"

从外部系统**单向**采集数据，写入 EntityStore。**严禁写回 OT 层。**

```
OPC-UA Connector  → 从 PLC 读传感器数据（温度/压力/振动）
Modbus Connector  → 从老式控制系统读模拟量/数字量
MQTT Connector    → 订阅 IoT 边缘网关消息
REST Connector    → 轮询 ERP/MES 系统数据
SQL Connector     → 定时从业务数据库同步实体状态
ROS2 Connector    → 从工业机器人订阅状态/位置
File Connector    → 解析 CSV/Excel 离线数据文件
```

#### Functions（AI 函数）— 企业的"推理单元"

**原子性** AI 计算：输入结构化上下文 → 一次 LLM 调用（可带工具）→ 输出结构化结论。

**关键**：Function 是无状态的、可单独调用的、结果结构化的。它不管理流程，只做推理。

```
DiagnoseEquipment       → 输入设备ID+症状 → 输出根因+推荐方案
PredictMaintenance      → 输入历史数据    → 输出预计故障时间+置信度
GenerateReport          → 输入工单记录    → 输出结构化报告
AssignOptimalWorker     → 输入工单需求    → 输出推荐维修人员
SuggestPlaybookUpdate   → 输入历史事件    → 输出新Playbook草稿（规则进化！）
AnalyzeEnergyAnomaly    → 输入能耗数据    → 输出异常点+节能建议
```

#### Playbooks（工作流）— 企业的"操作规程"

**与 Function 的核心区别**：

```
Function = 一个推理步骤（原子）
Playbook = 多个步骤组成的流程（复合）

比喻：
  Function = 医生做一次诊断（单次行为）
  Playbook = 医院的急诊处理规程（包含：分诊→诊断→开药→手术审批→通知家属）
```

Playbook 包含：Functions、Actions、HITL 门控、Channel 通知、条件分支、循环、超时处理。

```yaml
# Playbook 示例：一个 YAML 文件描述完整的响应流程
id: compressor-alarm-response
trigger:
  event: "alarm.created"
  conditions: { entity_type: CompressorUnit, severity: HIGH }
steps:
  - { type: function, id: diagnose, function_id: diagnose_equipment }
  - {
      type: condition,
      on: "diagnose.risk_level == HIGH",
      if_true: [{ type: hitl, message: "{{ diagnose.summary }}" }],
      if_false: [{ type: action, action_id: create_workorder_auto }],
    }
  - { type: channel, channel_id: feishu_ops, message: "工单已创建" }
```

#### Channels（通知通道）— 企业的"执行输出"

**向外**发送通知/指令。通过 Outbox 保证可靠投递（下文详解）。

```
飞书/企业微信/钉钉  → 群通知、个人通知、审批消息
Email/SMS          → 日报、紧急告警升级
Webhook            → 集成 ERP/ITSM 等外部系统
MCP Push           → 推送消息给 OpenClaw（触发对话）
ROS2 Action        → 向机器人派发任务（高风险，强制 HITL）
PLC Write          → 写回控制层（最高风险，强制 HITL + 安全校验）
```

#### Hooks（钩子）— 企业的"横切神经"

30 个命名切点，Pack 在不修改核心代码的情况下注入逻辑。

（完整 30 个 Hook 见第七章）

---

### 2.2 两个执行机制（常被混淆）

#### ActionExecutor（动作执行器）— 写操作的统一出口

**负责一切"写"操作**：不仅是创建工单，还包括调用外部 API、发送机器人指令。

```
ActionExecutor 做什么：
  - 创建/更新 EntityStore 中的工单、告警等实体
  - 调用外部 REST API（ERP 创建工单、ITSM 创建工单）
  - 发送 ROS2 Action（机器人任务指令）
  - 执行 OPC-UA Write（PLC 参数调整）←最高风险
  - 调用第三方服务（短信、邮件）

ActionExecutor 不做什么：
  - 不读取数据（那是 Connector 和 EntityStore 的职责）
  - 不做 AI 推理（那是 FunctionExecutor 的职责）
  - 不管理流程顺序（那是 PlaybookEngine 的职责）

核心功能：
  1. 检查 requires_hitl 标志 → 高风险动作必须等待审批
  2. 检查 requires_safety_check → 安全敏感操作额外校验
  3. 执行前后触发 Hook
  4. 记录执行日志（审计）
  5. 执行失败时回滚（如果支持）
```

#### Outbox（可靠投递）— 解决"通知丢失"问题

**问题背景**：

```
不用 Outbox 时（有 bug 的架构）：
  1. EntityStore.write(WorkOrder, ...)  ← 成功
  2. FeishuChannel.send(message)        ← 网络超时，失败！
  → 工单创建了，但没人知道 → 设备继续损坏

用 Outbox 时（正确架构）：
  1. 同一个数据库事务内：
     EntityStore.write(WorkOrder, ...)  ← 写入工单表
     Outbox.insert(message, channel)   ← 写入待发送表
  2. 后台 Outbox Worker：
     - 读取未投递的 Outbox 条目
     - 尝试发送给飞书
     - 发送成功 → 标记为已投递
     - 发送失败 → 等 30 秒重试，最多重试 5 次
     - 超时升级 → 换通道（飞书 → 短信 → 邮件）
  → 保证：工单创建和通知要么都成功，要么都失败
```

Outbox 保证的技术性质：**At-least-once delivery**（至少投递一次，幂等 ID 防止重复处理）。

---

## 三、Studio 架构：借鉴同样的 Pack 模式

Studio 是独立的 React 前端应用，与 Platform 通过 REST + SSE 连接。
Studio 同样可以借鉴 Platform 的扩展架构：

```
Studio 架构层：

  ComponentRegistry（类比 PackRegistry）
    ↓ 注册
  StudioPlugin（类比 Pack）
    ├── registerPanel()     ← 注册新的侧边栏面板
    ├── registerWidget()    ← 注册看板 Widget
    ├── registerView()      ← 注册新的主视图（如数字孪生 3D 视图）
    └── registerCommand()  ← 注册 OpenClaw 式的 / 命令

  数据层（只读连接 Platform）：
    REST    → 初始状态（设备列表、工单等）
    SSE     → 实时推送（告警、状态变更、工单更新）

  数字孪生层：
    Three.js / React Three Fiber → 3D 设备模型
    Konva.js / D3                → 2D 工厂平面图
    deck.gl                     → 热力图/密度图层
    时间轴控件                   → 历史状态回放
```

**Studio 与 Platform 的关系**：Platform 是数据和智能（Model），Studio 是视图（View）。
数字孪生 = Studio 对 Platform EntityStore 数据的空间化呈现。

---

## 四、最小核心：第零阶段目标重定义

**Phase A（点火）= 最小核心可运行 + 一个完整场景跑通**

Phase A 结束时，整个平台可以处理：

```
模拟告警事件 → EventBus → PlaybookEngine → FunctionExecutor（LLM）→ ActionExecutor → WorkOrder → Outbox → 飞书通知
```

这一条链路全部跑通。不需要真实 OPC-UA 数据，不需要 CBR，不需要 Studio UI。

```
Phase A 交付物（~400 行代码）：

1. EntityStore         ← 存读 Equipment/Alarm/WorkOrder
2. EventBus            ← subscribe/publish，支持 wildcard
3. PackRegistry        ← register_*() 全部方法 + load_all()
4. HookSystem          ← fire()，顺序执行，支持 block
5. PlaybookEngine      ← trigger/resume，简单 YAML 解析
6. ContextAssembler    ← 基础版（EntityStore + TimeSeries，不含 CBR/KB）
7. FunctionExecutor    ← 调用 LiteLLM + 工具循环（50 行 asyncio loop）
8. ActionExecutor      ← create_workorder + requires_hitl 门控
9. Outbox              ← 写入待发送表 + 后台 Worker
10. oilgas Pack        ← register() 注册以上所有组件
11. CLI                ← doctor + status + --json flag

验收测试：pytest tests/test_phase_a.py（mock LLM，不需要真实网络）
估算：~400 行新代码（现有骨架大部分已有）
```

**Phase B** = 在 Phase A 基础上逐个添加 Pack：

- B-1: LlamaIndex KB + CBR（知识积累）
- B-2: OPC-UA 真实数据（asyncua）
- B-3: LangGraph HITL（高级工作流）
- B-4: Studio 2D 数字孪生

---

## 五、何时调用 OpenClaw，何时调用自己的 LLM

**决策规则（清晰且不重叠）**：

```
有人类实时参与？
  ├── 是 → 使用 OpenClaw（OpenClaw 管理对话上下文）
  │         场景：工程师查询、审批对话、对话式配置、报告讲解
  └── 否 → 使用 Platform 内置 LiteLLM（自治模式）
            场景：告警自动诊断、定时报告生成、后台批处理
```

**详细场景映射**：

| 场景                            | 调用方                            | 理由                             |
| ------------------------------- | --------------------------------- | -------------------------------- |
| 后台告警自动响应（无人值守）    | Platform LiteLLM                  | 全自动，无对话                   |
| 定时生成设备健康报告            | Platform LiteLLM                  | 批处理，无对话                   |
| 设备状态自动分析（夜班）        | Platform LiteLLM                  | 自治运营                         |
| 工程师对话查询设备状态          | OpenClaw → MCP → Platform         | 有人参与，需要对话               |
| HITL 审批（工程师决策）         | OpenClaw 处理对话 + Platform 执行 | 对话交互 + 结构化执行            |
| 工程师用自然语言添加新规则      | OpenClaw → CLI/MCP → Platform     | LLM 驱动配置                     |
| 技术人员排查问题、多轮追问      | OpenClaw                          | 多轮对话，需要会话历史           |
| Platform 主动发现问题通知工程师 | Outbox → 飞书 → 工程师 → OpenClaw | Platform 主动，OpenClaw 后续对话 |

**关键原则**：Platform 拥有自己完整的 AI 能力（LiteLLM + 工具循环），不依赖 OpenClaw 也能独立运行。OpenClaw 是为了给人类提供更好的交互体验，不是 Platform 的必要组件。

---

## 六、LLM 驱动的系统自进化

**ClawTwin 应该比 OpenClaw 更彻底地支持 LLM 自驱动演化。**

### 6.1 可被 LLM 调整的一切

```
配置层（clawtwin.json）：
  - LLM 模型切换（litellm model 字符串）
  - 连接器参数（OPC-UA 端点、轮询频率）
  - 告警阈值
  - HITL 开关

规则层（Playbook YAML）：
  - 新增/修改/删除 Playbook
  - 调整触发条件
  - 修改步骤顺序和参数

知识层：
  - 注入新文档到 KB（POST /v1/knowledge/ingest）
  - 更新 CBR 标注
  - 修改 Skill 提示词

扩展层：
  - 安装新 Pack（pnpm openclaw pack install）
  - 更新 Pack 配置
  - 添加新的定时任务
  - 注册新工具

本体层：
  - 添加新实体类型（触发 Pack 迁移）
  - 修改实体属性
```

### 6.2 CLI 是 LLM 自进化的主接口

所有管理操作都通过 CLI + `--json` flag 暴露，让 LLM 可以调用：

```bash
# LLM 通过 OpenClaw MCP 工具驱动这些命令：
clawtwin config set llm.model "qwen/qwen-max"
clawtwin config set connectors.opcua_main.polling_interval_sec 2
clawtwin playbook create --file /tmp/new-rule.yaml
clawtwin playbook update compressor-alarm --step diagnose --timeout 180
clawtwin knowledge ingest --url https://... --entity-type CompressorUnit
clawtwin pack install industry-power
clawtwin pack reload oilgas
clawtwin alarm rule add --entity-type P101 --condition "temperature > 90"
clawtwin schedule add --name hourly-check --cron "0 * * * *" --function analyze_energy
```

### 6.3 进化的四个维度

```
① 规则进化：Playbook 被 LLM 建议 + 人工审核 + hot reload
② 知识进化：每个关闭工单 → CBR 入库；新文档 → KB 索引
③ 模型进化：LLM 调用全记录 → 积累训练数据 → 定期微调
④ 结构进化：LLM 建议新 Ontology 类型 → 人工确认 → 迁移上线
```

每一层都有**人工确认门**——LLM 建议，人类决定。高风险变更永远需要人工审批。

---

## 七、OpenClaw 借鉴清单（不需要自己开发的部分）

### 7.1 可直接从 OpenClaw 移植的模式（不是代码，是设计）

| 模式                            | OpenClaw 文件               | ClawTwin 实现                                | 工作量        |
| ------------------------------- | --------------------------- | -------------------------------------------- | ------------- |
| Plugin Loader（manifest-first） | `src/plugins/loader.ts`     | `pack_loader.py`（拓扑排序 + register）      | ~100 行       |
| 35 个 Hook 类型定义             | `src/plugins/hook-types.ts` | `hook_types.py`（Python TypedDict 逐一移植） | ~150 行       |
| Hook 注册与顺序执行             | `src/plugins/types.ts`      | `hooks/__init__.py`（async 函数链）          | ~80 行        |
| 工具定义模式                    | `src/agents/tools/`         | AgentTool + Pydantic schema                  | 模式移植      |
| 上下文装配模式                  | `src/context-engine/`       | ContextAssembler（多源 gather）              | ~120 行       |
| 内存分层架构                    | `packages/memory-host-sdk/` | LlamaIndex + pgvector                        | 使用库        |
| Channel 适配器模式              | `extensions/feishu/`        | BaseChannel + 工厂                           | 每通道 ~80 行 |
| Cron 定时任务                   | `hook-types: cron_changed`  | APScheduler（相同 API 面）                   | ~60 行        |
| MCP Server 暴露                 | `src/mcp/`                  | mcp Python SDK                               | 协议共享      |
| Outbox 可靠投递                 | `src/channels/`             | Out配置                                      | ~100 行       |
| 配置驱动行为                    | `src/config/`               | pydantic-settings BaseSettings               | 每块 ~20 行   |

**总计需要自己写的移植代码：~900 行**（已包含在 Phase A ~400 行 + Phase B ~500 行内）

### 7.2 OpenClaw 生态中可以直接用的

| 资源                   | 如何使用                                | 无需自己开发         |
| ---------------------- | --------------------------------------- | -------------------- |
| 所有 LLM Providers     | LiteLLM 统一接入，配置共享              | 不用写 Provider 代码 |
| 飞书/企业微信通知      | OpenClaw 插件通过 MCP 调用 ClawTwin     | 借用 OpenClaw 通道   |
| OpenClaw Skill 系统    | SKILL.md 格式兼容，工业 Skill 写入 Pack | 格式复用             |
| MCP 协议               | 双向互通，Python + TS 都有 SDK          | 协议复用             |
| 所有 OpenClaw 对话插件 | 工程师通过 OpenClaw 操作 ClawTwin       | 不用做对话 UI        |

### 7.3 ClawTwin 30 个工业 Hook（对应 OpenClaw 35 个 Hook）

| 分组          | Hook 名称                                                       | 对应 OpenClaw Hook                           |
| ------------- | --------------------------------------------------------------- | -------------------------------------------- |
| 平台          | `platform_start / platform_stop`                                | `gateway_start / gateway_stop`               |
| Pack          | `pack_loaded / pack_failed`                                     | `before_install`                             |
| 实体写入      | `before_entity_write / after_entity_write`                      | `before_message_write`                       |
| LLM 路由      | `before_llm_route`                                              | `before_model_resolve`                       |
| 上下文        | `before_context_assemble / after_context_assemble`              | `agent_turn_prepare / before_prompt_build`   |
| LLM 调用      | `before_llm_call / after_llm_call`                              | `llm_input / llm_output`                     |
| LLM 监控      | `llm_call_started / llm_call_ended`                             | `model_call_started / model_call_ended`      |
| 工具          | `before_tool_call / after_tool_call / tool_result_persist`      | 直接复用同名                                 |
| Playbook      | `before_playbook_trigger / playbook_complete / playbook_failed` | `before_agent_run / agent_end`               |
| Playbook 步骤 | `before_playbook_step / after_playbook_step`                    | `before_agent_reply / before_agent_finalize` |
| HITL          | `before_hitl_gate / hitl_approved / hitl_rejected`              | （无直接对应，新增）                         |
| 动作          | `before_action_execute / after_action_execute`                  | `before_dispatch / reply_dispatch`           |
| 投递          | `before_outbox_send / after_outbox_send`                        | `message_sending / message_sent`             |
| 告警          | `alarm_created / alarm_escalated / alarm_resolved`              | （无直接对应，新增）                         |
| 工单          | `workorder_created / workorder_completed`                       | `session_start / session_end`                |
| 连接器        | `connector_connected / connector_disconnected`                  | （无直接对应，新增）                         |
| 调度          | `schedule_changed`                                              | `cron_changed`                               |

---

## 八、为什么 OpenClaw 选了 TypeScript，ClawTwin 为什么选 Python

### 8.1 OpenClaw 的选择逻辑

OpenClaw 是一个 **AI 对话助手 + 代码编辑工具**：

- 主要功能：文本对话、文件读写、Git 操作、Shell 执行
- 这些都是 **IO 密集型** 操作，Node.js 是天然的选择
- 前端（Electron 桌面 + Web UI）本来就是 TypeScript/React
- LLM 调用通过 API 完成，不需要本地 ML 计算
- OpenClaw 的 "AI" 能力来自外部 API，不是本地模型
- TypeScript 为复杂插件 API 提供强类型安全

**OpenClaw 不需要**：LangGraph、LlamaIndex、asyncua、pandas、PyTorch——因为这些都是本地 ML/数据处理库，而 OpenClaw 把这些工作全部外包给 LLM API。

### 8.2 ClawTwin 的选择逻辑

ClawTwin 是一个 **企业 AI 运营平台**：

| 不可缺少的能力    | 需要的库             | Python       | TypeScript           |
| ----------------- | -------------------- | ------------ | -------------------- |
| HITL Agent 工作流 | LangGraph            | ✅ 成熟      | ❌ 无对应            |
| 企业知识库/CBR    | LlamaIndex           | ✅ 领先 2 年 | ⚠️ 功能严重落后      |
| 模型微调（精华）  | transformers/PyTorch | ✅ 唯一选择  | ❌ 不支持            |
| OPC-UA 采集       | asyncua              | ✅ 生产可用  | ⚠️ node-opcua 不完整 |
| Modbus/MQTT 采集  | pymodbus/aiomqtt     | ✅ 成熟      | ⚠️ 质量参差不齐      |
| 时序/工业数据处理 | pandas/polars        | ✅ 工业标准  | ❌ 无对应            |
| 基线异常检测      | scikit-learn         | ✅ 工业标准  | ❌ 无对应            |
| 工业工程师生态    | Python 社区          | ✅ 主导      | ❌ 基本没有          |

**微调是决定性因素**：ClawTwin 的"越用越聪明"需要用积累的工单数据微调行业专用模型，这只能用 Python 实现。

### 8.3 Hermes 是什么

Hermes 有几种含义：

1. **Meta Hermes**：Facebook/Meta 开发的 JavaScript 引擎，专为 React Native 移动端优化（手机 App），不是框架
2. **NousResearch Hermes**：一系列开源 LLM 模型（如 Hermes-3-Llama-3.1），是可用于微调的基础模型，不是开发框架
3. 如果你指的是某个特定框架，请提供更多信息

**Hermes 对 ClawTwin 的意义**：

- Hermes LLM 模型：可以作为 ClawTwin 的本地部署 LLM 选项（通过 LiteLLM + Ollama 接入）
- Meta Hermes 引擎：与 ClawTwin 无关（那是移动端 JS 运行时）

---

## 九、库选型（不造轮子清单）

| 能力                   | 选用库                        | 版本  | 替代方案                  |
| ---------------------- | ----------------------------- | ----- | ------------------------- |
| LLM 统一调用           | **litellm**                   | ≥1.50 | 无需替代                  |
| Agent 工具循环（简单） | 50 行 asyncio loop            | -     | Phase A 使用，不需要框架  |
| Agent 工具循环（高级） | **langgraph**                 | ≥0.2  | Phase B-3 引入            |
| RAG / 知识检索         | **llama-index**               | ≥0.10 | Phase B-1 引入            |
| OPC-UA 采集            | **asyncua**                   | ≥1.0  | Phase B-2 引入            |
| Modbus 采集            | **pymodbus**                  | ≥3.6  | 已在 deps                 |
| MQTT 采集              | **aiomqtt**                   | ≥2.0  | Phase B-2 引入            |
| 工单状态机             | **transitions[asyncio]**      | ≥0.9  | Phase A 引入              |
| 定时调度               | **APScheduler**               | ≥3.10 | Phase A 引入              |
| 向量存储               | **pgvector**（已有）          | -     | Phase B-1 使用            |
| 时序存储               | TimescaleDB（已有）           | -     | Phase B-2 补充查询        |
| 数据处理               | **pandas + numpy**            | -     | Phase B-2 基线模型        |
| 异常检测               | **scikit-learn**              | -     | Phase B-2 IsolationForest |
| HTTP 框架              | FastAPI（已有）               | -     | 保持                      |
| ORM                    | SQLAlchemy（已有）            | -     | 保持                      |
| CLI                    | Typer（已有）                 | -     | 补充 --json flag          |
| MCP Server             | **mcp** Python SDK            | -     | Phase A 引入              |
| 配置管理               | **pydantic-settings**（已有） | -     | 保持                      |
| 本地 LLM               | **Ollama**（外部服务）        | -     | 可选，LiteLLM 接入        |

---

## 十、开发阶段规划（修正版）

### Phase A：点火（2 周）— 最小内核 + 一条完整链路

**目标**：5 个核心模块全部可运行，一个完整告警→诊断→工单→通知场景跑通

```
Week 1（核心模块）：
  □ HookSystem（~80 行）
  □ PackRegistry 补全所有 register_*() 方法
  □ FunctionExecutor + 50 行 LiteLLM 工具循环
  □ ContextAssembler 基础版（EntityStore + TimeSeries）
  □ ActionExecutor（create_workorder + requires_hitl）

Week 2（Pack + 端到端）：
  □ Outbox Worker（后台投递 + 重试）
  □ oilgas Pack 第一个版本（register() 调用上面所有组件）
  □ CLI --json flag + doctor + status
  □ 端到端测试：模拟告警 → 诊断 → 工单 → 飞书（mock）

验收：pytest tests/test_phase_a.py 全绿
估算：~400 行新代码
```

### Phase B：逐步扩展（10 周）

```
B-1（2周）: LlamaIndex KB + CBR（workorder_closed 触发入库）
B-2（2周）: OPC-UA 真实采集（asyncua，替换 mock 数据）
B-3（2周）: LangGraph HITL（interrupt() + PostgresSaver）
B-4（2周）: Studio 2D 数字孪生（Konva.js + SSE 实时）
B-5（2周）: OpenClaw MCP 集成（暴露 10 个核心工具）

每个 B-x 都是独立 Pack 扩展，不修改 Phase A 的核心代码
```

### Phase C+：进化生态

```
C-0: LLM 辅助 Playbook 生成（OpenClaw 安装向导）
C-1: 训练数据积累 + 模型微调管道
C-2: 3D 数字孪生（Three.js + GLTF 模型）
C-3: 机器人/ROS2 Pack
C-4: 世界模型（因果图 + 预测性维护）
C-5: 多站点联邦
```

---

## 十一、新代码量估算

| 阶段              | 新增代码     | 主要依赖                            | 备注                |
| ----------------- | ------------ | ----------------------------------- | ------------------- |
| Phase A（核心）   | ~400 行      | litellm + transitions + APScheduler | 最小内核            |
| Phase B-1（知识） | ~150 行      | llama-index                         | 胶水代码            |
| Phase B-2（OT）   | ~200 行      | asyncua                             | OPC-UA 连接器       |
| Phase B-3（高级） | ~100 行      | langgraph                           | 迁移 PlaybookEngine |
| Phase B-4（UI）   | ~100 行      | -                                   | Studio API endpoint |
| Phase B-5（MCP）  | ~80 行       | mcp Python SDK                      | 工具注册            |
| oilgas Pack       | ~200 行      | -                                   | 行业逻辑            |
| **总计**          | **~1230 行** |                                     | 成熟库承担 80% 工作 |

---

## 十二、设计原则（不可违反）

1. **EntityStore 是唯一真相源**：所有实体状态只能通过 EntityStore 读写
2. **EventBus 是唯一出口**：禁止绕过 EventBus 直接监听数据库
3. **OT 层只读**：Connector 只采集，写回必须经 ActionExecutor + HITL
4. **Provider 必须可替换**：LLM 模型字符串由配置控制，不硬编码
5. **Pack 边界清晰**：工业逻辑住在 Pack，核心不感知行业
6. **HITL 门控高风险**：`requires_hitl=True` 必须等待人工确认
7. **对话不进 Platform 核心**：自然语言 → OpenClaw；结构化操作 → Platform
8. **配置驱动行为**：全部行为可通过配置文件和 CLI 调整（LLM 可驱动）
9. **进化必须安全**：规则/配置更新通过 Pack reload，不直接修改生产数据库
10. **写回设备最高安全等级**：机器人/PLC 写入，必须 HITL + 安全校验 + 日志

---

## 十三、文档关系

本文档（V3.1）是唯一权威来源：

- 取代：V3、V2 及所有历史架构文档

以下继续有效（补充本文档）：

- `platform-api/STRUCTURE.md`：代码目录-职责映射
- `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`：客户对外叙事

---

_ClawTwin Platform Architecture V3.1 · 2026-05-14_
_基于多轮深度架构讨论整理完成_
