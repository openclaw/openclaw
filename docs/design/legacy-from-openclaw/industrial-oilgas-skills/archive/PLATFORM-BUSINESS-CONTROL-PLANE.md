# ClawTwin 业务控制面与编排层（Platform Business Control Plane）

> **版本**：v0.1 · 2026-05-12  
> **地位**：对 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` 的**定向补充**（非替代）。冲突时仍以 Foundry 主文档与 `DESIGN-FINAL-LOCK.md` HTTP 真值为准。  
> **目的**：把「智能体 = 通用能力」写进架构：**企业业务平台**由 **控制面（编排/策略）+ 数据面（Pipeline/Object）+ 能力面（Agent/模型/检索）** 组成；**按需、可审计、可回滚**地调用智能体，而不是以对话为中心的 Agent 应用。

---

## 一、设计命题（与 Palantir 思路对齐）

| 命题                   | Foundry / AIP 常见做法         | ClawTwin 落地要点                                                                                         |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **本体优先**           | Ontology 是集成与权限的真理    | Object / Link / Action / Function 已为一级抽象；**业务编排不得绕过** ObjectStore / ActionExecutor         |
| **AI 附着在本体上**    | AIP Function 注册到类型系统    | **Function Type** 是唯一对外「要智能」的契约；实现可为 `ai_function` / `python_function` / `sql_function` |
| **数据先治理再消费**   | Pipeline → Dataset / Object    | **Pipeline YAML** 把 OT/IT/IMS 物化为 Object；Apps 与人类只看见「已治理对象」                             |
| **编排可版本、可审计** | Workshop / 工作流与 Edition    | **Business Flow / Playbook** 显式版本化；每次运行 `run_id` + lineage + audit                              |
| **策略与能力解耦**     | 权限、审批、数据策略独立于模型 | **Policy**（谁能触发、何时尚可自动调用 LLM、预算）与 **AgentRuntime** 适配器分离                          |

**Gotham 类比（取一层意思即可）**：跨对象分析、强标记、强审计——在工业侧对应 **Marking + 审计 + 场站隔离**，不复制情报产品形态。

---

## 二、三维平面模型（推荐作为模块划分的顶层）

```
                    ┌─────────────────────────────────────────┐
                    │  Apps Layer（人机协同界面）               │
                    │  Studio / 飞书卡片 / Grafana / CLI      │
                    └────────────────────┬────────────────────┘
                                         │ 用户意图 / 审批 / 可视化
                    ┌────────────────────▼────────────────────┐
                    │  ① 业务控制面 Control Plane             │
                    │  · Business Flow / Playbook（场景编排）  │
                    │  · Triggers（定时 / 事件 / 阈值）        │
                    │  · ApprovalQueue / HITL 网关             │
                    │  · Policy（预算、自动/半自动、敏感字段）  │
                    │  · InvocationContext（租户/场站/角色/追踪）│
                    └────────────────────┬────────────────────┘
                                         │ 只允许调用「已注册」的 Action / Function
                    ┌────────────────────▼────────────────────┐
                    │  ② 本体与执行内核 Ontology + Core       │
                    │  （与 INDUSTRIAL-FOUNDRY §三～§四 一致）  │
                    │  ObjectStore │ ActionExecutor │         │
                    │  FunctionExecutor │ PipelineRunner       │
                    └─────────┬──────────────────┬─────────────┘
                              │                  │
         ┌────────────────────▼──┐    ┌─────────▼──────────────┐
         │ ③a 数据面 Data Plane   │    │ ③b 能力面 Capability   │
         │ Pipeline / Connector   │    │ AgentRuntime 适配器     │
         │ Lineage / Catalog      │    │ LLM / Embed / RAG       │
         │ 时序 / 向量 / 文档      │    │ （无业务语义，只执行）  │
         └────────────────────────┘    └────────────────────────┘
```

**关键边界**

- **控制面**决定「**何时**、**在满足何策略时**、**为哪条业务线**」去调用 **Action**（写）或 **Function**（读/算/AI）。
- **能力面**不直接理解「工单审批」；它只实现 **Function Type** 合约（输入/输出 schema、超时、成本类元数据）。
- **数据面**保证进入本体的数据**可溯源、可对账**（与 SoT、Connector、Pipeline 一致）。

---

## 三、智能体定位：**Capability Provider，不是系统心脏**

| 角色                                | 职责                                                                         | 非职责                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| **AgentRuntime（OpenClaw 等）**     | 会话管理、多步推理、工具协议（MCP）、流式输出                                | 不持有业务真相、不替代工单 FSM、不私自写库 |
| **FunctionExecutor（ai_function）** | 把「一次受控的推理请求」映射到 Runtime；写入 **llm_traces**、遵守 **Policy** | 不绕过 Ontology schema                     |
| **Platform**                        | 注册何种 Function 可调、预算、审批、与哪条 **Playbook** 绑定                 | 不绑定单一厂商 Agent                       |

**推论（产品叙事）**  
对客户：**「ClawTwin 是企业工业业务平台；智能辅助是可插拔能力。」**  
对研发：**先有 Object + Action + Pipeline，再挂 ai_function；禁止「聊天驱动写库」。**

---

## 四、业务编排层：建议引入的抽象（逐步实现）

以下名称可与实现类名渐进对齐；**先 YAML/DB 契约，后代码**。

### 4.1 Business Flow / Playbook（业务场景）

- **定义**：一组**有序或带分支**的步骤，每步绑定 **Action Type** 或 **Function Type**，含输入映射（从 Object 字段 / 上一步输出取值）。
- **版本**：`playbook_id + semver`；运行实例引用**冻结版本**，避免线上漂移。
- **与 Palantir 类比**：Workshop 上拼装的对象操作 + 后端受控链（非无代码玩具，需审计）。

### 4.2 Trigger Binding（触发与会话）

| 类型                | 示例                       | 落在平台行为                                 |
| ------------------- | -------------------------- | -------------------------------------------- |
| **Schedule**        | 晨报、巡检窗口             | Scheduler → 启动 Playbook `run`              |
| **Event**           | 新告警、规则 evaluate 命中 | EventIngest → 条件 Policy → Playbook         |
| **User**            | Studio 按钮、飞书卡片      | Apps → Control Plane → Action/Function       |
| **Threshold / SLO** | KPI 跌破阈值               | 同 Event，建议独立 **Signal** Object（可选） |

### 4.3 InvocationContext（每次调用的上下文）

建议**强制字段**（可映射 JWT + 运行时注入）：

- `tenant_id` / `station_ids` / `user_id` / `roles`
- `trace_id` / `parent_run_id`（编排运行树）
- `playbook_id` + `playbook_version`（若由编排触发）
- `policy_snapshot_id`（可选，用于回放「当时策略」）

所有 **Action.execute** / **Function.invoke** 入口**首个参数或 Request 头**携带可序列化上下文，供 Audit / Lineage / Trace 一致关联。

### 4.4 Policy（策略包）

declarative 建议维度：

- **automation.max**：某 Playbook 是否允许自动调用 `ai_function`
- **budget**：单次/日 LLM token、成本上限（与 Provider 抽象对齐）
- **data**：哪些 Object 字段**禁止**进入 prompt（脱敏规则引用 marking）
- **approval**：已有 Action `risk_level`；编排层可强制「本场景一律 HITL」

**实现落点**：与 Casbin/Marking 并列的「运行前 Policy 引擎」，在 ActionExecutor / FunctionExecutor **最外层**统一执行（见 `DEVELOPMENT-CONTRACT` 禁止「跳过 invoke」）。

---

## 五、数据面加强（与「好系统」环环相扣）

1. **Logical Catalog（逻辑目录）**
   - 每个 Connector、Pipeline、核心表/Object Type 有**登记项**：所有者、刷新 SLAs、SoT 标签、敏感等级。
   - 与 **OpenLineage** 事件对齐（run id、dataset facet）。

2. **Data Contract**
   - Pipeline 输出到 Object 前：schema 校验（LinkML/Pydantic）、**行级**质量规则（可失败入 quarantine Object 或 DLQ）。

3. **Materialization 策略**
   - 明确 **online**（API 直读外部）vs **materialized**（Foundry 内表为准）与 **hybrid** 字段级（铁律 32 已定义方向）。

4. **知识分层与闭包**
   - L0–L3 与 **Function `SearchKnowledge`**、pgvector 一致；编排层应能表达「本步骤仅允许 L2+L3」等**检索策略**（减少胡编与越权）。

---

## 六、事件与集成（Enterprise BUS 最小集）

不需要一上来 Kafka 全家桶；**阶段化**：

| Phase | 建议                                   | 说明                                        |
| ----- | -------------------------------------- | ------------------------------------------- |
| A     | 进程内 **EventBus** + DB **outbox** 表 | 保证 Webhook / 飞书推送 **至少一次** 可追踪 |
| B     | Redis Streams / 单主题 Kafka           | OT 大数据量、多消费组                       |
| C     | 多租户分区 + Schema Registry           | 与 Connector 规模匹配                       |

**事件 envelope**（建议统一）：`event_id`, `event_type`, `occurred_at`, `producer`, `station_id`, `payload_ref`（大负载进 Object Store），与 **InvocationContext** 可关联。

---

## 七、`platform-api/` 模块映射（演进建议）

与现有树**增量**对齐，避免大爆炸重构：

| 概念                     | 建议物理落点（示例）                            |
| ------------------------ | ----------------------------------------------- |
| Playbook 定义与运行      | `core/playbooks/` + `ontology/playbooks/*.yaml` |
| Trigger / Scheduler 绑定 | `workers/` 扩展 + `core/triggers/`              |
| Policy                   | `core/policy/` 或 `infra/policy/`               |
| InvocationContext        | `core/invocation/`（中间件注入）                |
| Catalog / Lineage        | `infra/lineage/` + 与 PipelineRunner 挂钩       |
| AgentRuntime             | 已有 `aip/agent_runtimes/`                      |

**HTTP**：控制面可先暴露 **只读**「列出 Playbook / 运行历史」；**写入**走 admin 或 CI 部署 YAML，避免未治理的随意编排。

---

## 八、与现有铁律的关系（25–34）

不重复条文；本文件**显式依赖**：

- **25–29**：本体与声明式 Action/Function/Pipeline/Studio。
- **30–33**：Runtime 抽象、Connector、SoT、飞书边界。
- **34**：私有化与安全分区。

**拟议扩展（若团队采纳，再写入 `DEVELOPMENT-CONTRACT.md` / `SKILL.md`）：**

- **铁律 35**：任何**多步业务自动化**必须注册为 **Playbook**（或等价 metadata），禁止長脚本散落在 `workers` 而无声明与版本。
- **铁律 36**：**Function.invoke**（含 `ai_function`）必须携带可序列化 **InvocationContext**；缺失则拒绝（dev 可豁免需显式 flag）。
- **铁律 37**：**Policy** 检查必须在 **ActionExecutor/FunctionExecutor 外壳**统一执行，handler 内不复写权限/预算逻辑。
- **铁律 38**：对外 **Webhook / 集成** 的消费与投递须有 **outbox 或 idempotent 订阅** 模型，与 `DESIGN-FINAL-LOCK` Webhook 节最终对齐。

---

## 九、里程碑（与 Phase A 审计衔接）

1. **P0**：`InvocationContext` 契约 + executor 外壳挂点（与已有 audit 对齐）。
2. **P0**：选定 1–2 条端到端 **Playbook**（如：告警确认建议 → 工单草稿 → HITL），YAML 驱动 + `run` 表。
3. **P1**：Policy 最小集（自动调用 ai_function 开关 + token 预算 stub）。
4. **P1**：Catalog 清单 API（读）+ Pipeline run 与 lineage 事件。
5. **P2**：事件 outbox + 外部 Webhook 真实投递（替换 LOCK 中 dispatch 桩）。
6. **P2**：Studio「场景」页只读展示 Playbook 状态与最近运行（不卖低代码全家桶，先可观测）。

---

## 十、一句话对外定位（可与产品部对齐）

**ClawTwin = 以工业本体为核心的企业业务与数据平台；智能体与 LLM 是平台按需调用的受控能力，业务编排与数据治理与权限同等重要。**

---

_本文件应随 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` major 版本评审同步更新。_
