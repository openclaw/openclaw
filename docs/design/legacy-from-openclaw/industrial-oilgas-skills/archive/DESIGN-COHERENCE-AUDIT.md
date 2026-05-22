# ClawTwin 设计自洽性审计与系统化增补

> **版本**：v1.0 · 2026-05-12  
> **地位**：横向审计文档，对照「AI 发展趋势 + 业务自洽完整性」检验已有设计的合理性与完备性，并提出补全方向。  
> **不替代**：`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（架构权威）、`DESIGN-FINAL-LOCK.md`（API 权威）、`PLATFORM-BUSINESS-CONTROL-PLANE.md`（编排权威）。

---

## 一、审计框架：七个维度

```
维度 A  本体完整性      Ontology Coverage
维度 B  数据闭环        Data Loop Closure
维度 C  AI 能力层       AI Capability Design
维度 D  业务编排        Business Orchestration
维度 E  可观测与评估    Observability & Evaluation
维度 F  平台扩展性      Platform Extensibility
维度 G  安全与合规      Security & Compliance
```

每个维度评分：**✅ 已系统化** / **⚠ 已提及但碎片化** / **❌ 结构性缺失**

---

## 二、逐维审计

### 维度 A：本体完整性 ⚠

**已有（扎实）**

- Object / Link / Action / Function / Pipeline / Marking 六类一级抽象
- LinkML schema + SoT 策略 + 8 态 EquipmentStatus 等
- ObjectStore / ActionExecutor / FunctionExecutor 执行内核原则

**缺口**

| 缺失点                                                      | 影响                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Ontology Version & Branch**（类 Palantir Edition/Branch） | 无法安全地演进 Object schema 而不影响生产；联调中 schema 变了，旧 Agent 调用崩溃                                         |
| **Object Type 继承 / Trait 组合**                           | 目前每类 Object 各自写字段；`SensorEquipment` 和 `MechanicalEquipment` 有大量公共字段无法复用                            |
| **Computed Property（衍生字段）**                           | `health_score` 等计算结果应当是 Object 的一等属性而非每次查询时调 Function；缺少「字段 = 函数结果且可缓存/异步更新」声明 |
| **Relation 方向 vs 双向导航**                               | Link 当前单向声明较多；图遍历（从 Alarm 反推 Station → Equipment → 最近 WorkOrder）在代码侧需要手工拼                    |

**建议**

- 在 `ontology/object_types/base.yaml` 定义 **BaseEquipment、BaseAsset** Trait，子类 `include_traits:` 复用
- `ontology/schema_version.yaml` 声明当前版本；HTTP 响应带 `schema_version` 字段（`DESIGN-FINAL-LOCK` 已部分实现），LinkML 变更走 `alembic` 迁移对齐

---

### 维度 B：数据闭环 ⚠

**已有**

- OPC-UA → Pipeline → Object（单向采集）
- IMS Connector（声明级）
- Knowledge Flywheel（WorkOrder → L3 KB）
- OpenLineage 已列为强制借力

**结构性缺口：反向闭环（Outcome Feedback Loop）**

```
当前：
  OT 数据 → 本体 → AI 建议 → HITL → 执行 WorkOrder
                                              │
                                              ✗ 结果测量缺失

理想：
  OT 数据 → 本体 → AI 建议 → HITL → 执行 WorkOrder
                  ▲                         │
                  └─── OutcomeEvent ←───────┘
                       (设备是否恢复正常？KPI 是否改善？)
```

**OutcomeEvent 应成为一级 Object**

```yaml
# ontology/object_types/outcome_event.yaml（建议新增）
api_name: OutcomeEvent
description: 记录一次 Action/Playbook 执行后的可测量结果
properties:
  trigger_run_id: string # 关联的 playbook run 或 workorder id
  outcome_type: enum # recovered | degraded | unchanged | unknown
  measured_at: datetime
  metric_snapshot: object # 执行前 N 分钟 vs 执行后 N 分钟的 KPI diff
  evaluated_by: enum # auto_rule | human | llm_eval
source_of_truth_strategy:
  default: foundry
links:
  - target: WorkOrder
  - target: Alarm
  - target: Equipment
```

这是 **Knowledge Flywheel** 的真正闭合：`WorkOrder.done → OutcomeEvent → 反馈给 DiagnoseFunction 的评估 → prompt/few-shot 改善`。

**其他数据面补全**

| 缺失点                        | 建议                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **数据质量信号（DQ Signal）** | Pipeline 输出带 `data_quality_score`；读数异常（超量程/全零/跳变）入 `quarantine_readings` 而非直接入 Object |
| **时序连续性保证**            | TimescaleDB gap-fill 策略、dead-band 过滤要在 Pipeline YAML 声明（而非隐含在 bridge 里）                     |
| **L0–L3 知识的失效/版本**     | KB Document 应有 `valid_until`、`superseded_by`；否则 AI 会引用过期规程                                      |

---

### 维度 C：AI 能力层 ⚠

**已有（设计方向正确）**

- Function Type（`ai_function` / `python_function` / `sql_function`）三实现
- AgentRuntime 抽象（可切 OpenClaw/HiAgent/Dify 等）
- LLM Trace + Policy（控制面文档已提及）
- L0–L3 分层知识 + pgvector + LlamaIndex

**系统性缺口**

#### C1. AI Evaluation Pipeline（缺失）

当前没有系统化的「AI 输出质量评估」路径。

```
建议引入：EvalRun Object + offline eval Pipeline

┌─────────────────────────────────────────────────────┐
│ EvalPipeline（Phase B，可先 stub）                   │
│                                                     │
│  Source: llm_traces（已完成的 ai_function 调用）    │
│  Transform: 与 OutcomeEvent 关联 → 生成 (input,    │
│             output, ground_truth_outcome) 三元组    │
│  Eval: LLM-as-judge / rule-based / human label      │
│  Destination: EvalRun Object（分 Function Type）   │
│  Schedule: weekly or on-demand                      │
└─────────────────────────────────────────────────────┘
```

#### C2. 推理置信度与不确定性（缺失）

`DiagnoseEquipment` / `PredictBreach` 等 Function 目前没有**置信度契约**。

建议 Function Type 输出 schema 统一包含：

```python
class AIFunctionResult:
    value: Any                    # 主要输出
    confidence: float | None      # 0-1，None = 未实现
    reasoning_trace: str | None   # 摘要推理链（可入 llm_traces）
    data_freshness_seconds: int   # 所引用数据距现在多久
    citations: list[Citation]     # 引用的 KB chunks / Object ids
```

这让 Studio 和飞书卡片可以渲染「AI 建议（置信度 78%，基于 3 条知识）」而非黑盒输出。

#### C3. 复合事件推理（Compound Event Pattern）

单传感器阈值规则（`alarm_rules`）已有。但工业场景常见**多信号同发的复合告警**：

```
压缩机：振动↑ AND 排气温度↑ AND 电流↑ → 可能轴承失效
管道：入口压力↓ AND 出口流量↓（且非正常关阀） → 可能泄漏
```

建议引入 **CompositeAlarmRule Object**：

```yaml
api_name: CompositeAlarmRule
properties:
  pattern_type: enum # all_of | any_of | sequence_within
  window_seconds: int
  sub_rules: list[AlarmRuleRef]
  requires_function: string # 可选：触发后立即调用此 Function 深诊
```

这是 Palantir Gotham 里「多对象关联分析」在工业侧的最小有效形式。

#### C4. 本地与云的推理路由（Inference Router）

当前：vLLM（私网 GPU）是唯一推理目标。  
实际：某些 Function（实时诊断）必须走本地保密；某些（报表摘要）可选云端更快更便宜。

建议 Function Type 声明 `inference.locality: local_only | cloud_ok | hybrid`，由 **Provider 抽象**路由，而非业务代码 if/else。

---

### 维度 D：业务编排 ⚠→✅（控制面文档已建立，需落地）

`PLATFORM-BUSINESS-CONTROL-PLANE.md` 建立了 Playbook / Trigger / Policy / InvocationContext。以下是还需补全的细节。

#### D1. Playbook 中的补偿（Compensation）与回滚

工业场景：

- Playbook step3（发飞书通知）成功，step4（写 OA 审批）失败
- 需要撤销已发通知或标记「部分完成」

建议 Playbook 步骤支持 `on_failure: compensate | abort | skip`，并与 `ActionExecutor` 的幂等标志（`idempotency_key`）对齐。

#### D2. 异步协调（Async Coordination）

当前 HITL：提交审批 → 等人 → 人点按钮 → 回调。  
当前缺少：**Playbook 暂停等待** 的建模（不能用轮询，要用事件唤醒）。

```
Playbook run 状态机建议：
  running → waiting_for_human
           ↓ (飞书卡片 callback → /v1/feishu/events)
           → resume → running → done
```

这与 `DESIGN-FINAL-LOCK.md` HITL FSM **可以**对齐为：一个 WorkOrder 就是一个 `waiting_for_human` 的 Playbook checkpoint。

#### D3. 跨场站 Playbook（Federation）

当前 Playbook 设计是单场站内的。多站场景（HQ 下发应急响应预案）需要：

- `scope: station | multi_station | organization`
- 执行时 `InvocationContext.station_ids` 支持列表

---

### 维度 E：可观测性与评估 ❌（结构性缺失）

这是当前设计**最大的系统性空洞**。各地散落了 `audit_log`、`llm_traces`、`scheduler tick`，但**没有统一的 Observability Model**。

建议引入三层可观测架构：

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 3: Business Observability                              │
│  · KPI Dashboard（生产效率、告警响应时长、工单完成率）         │
│  · Playbook Health（运行成功率、p99 延迟、人工介入率）         │
│  · AI Quality（Function 置信度趋势、EvalRun 评分、幻觉率）    │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: Platform Observability                              │
│  · Run Ledger（每个 Playbook run 的 DAG + 各步骤状态/耗时）   │
│  · Lineage Graph（Object → Pipeline → Object 血缘可视化）     │
│  · Audit Trail（合规要求；append-only；已有 audit_logs）      │
├──────────────────────────────────────────────────────────────┤
│ Layer 1: Technical Observability                             │
│  · OpenTelemetry traces（HTTP/Function/DB 调用链）            │
│  · Prometheus metrics（FastAPI + Kafka + PostgreSQL）         │
│  · Structured logs（与 InvocationContext.trace_id 关联）      │
└──────────────────────────────────────────────────────────────┘
```

**实现建议（增量）**

| 层级 | Phase A 最小可行                  | Phase B 完整                          |
| ---- | --------------------------------- | ------------------------------------- |
| L1   | structlog + `trace_id` 贯穿       | OpenTelemetry SDK + Grafana Tempo     |
| L2   | `playbook_runs` + `run_steps` 表  | Lineage API + Studio「运行历史」页    |
| L3   | KPI stub 已有（`/v1/alarms/kpi`） | Business Dashboard + AI Quality Panel |

---

### 维度 F：平台扩展性 ❌（结构性缺失）

ClawTwin 要成为**面向多客户、多行业的平台**，而非每次交付都重新开发，需要一个明确的扩展模型。

#### F1. Industry Pack（行业包）作为交付单元

Industry Pack 是 ClawTwin 的「可部署扩展」，类比 Palantir Marketplace 上的应用、Salesforce AppExchange、或工业软件中的「行业模板」。

```
一个 Industry Pack 包含：
┌──────────────────────────────────────────────┐
│ industry-pack-oilgas-pipeline-v1/            │
│  manifest.yaml           # 包元数据与依赖     │
│  ontology/               # Object/Action/Function Types │
│  pipelines/              # Pipeline YAMLs    │
│  playbooks/              # Playbook YAMLs    │
│  connectors/             # Connector 模板    │
│  knowledge/              # L0/L1 KBDocuments │
│  studio/                 # 自定义 React 组件 │
│  tests/                  # 验收冒烟测试       │
└──────────────────────────────────────────────┘
```

**关键设计约束**

- Pack 只能通过「已声明的 Object Type 扩展点」注入新类型；不允许修改 BaseEquipment 等 Platform Core 类型
- Pack 之间通过 Link 跨引用（不能直接 import 对方 Object Type 的字段）
- 安装/卸载有对应 `alembic revision` 和 `lineage_event`

这直接解决了「每次油气→化工→电力换行业要推倒重来」的问题。

#### F2. 扩展点（Extension Point）目录

Platform Core 需要声明哪些地方是**开放扩展的**（SDK 语义），而不是全部封闭：

| 扩展点                      | 类型       | 说明                       |
| --------------------------- | ---------- | -------------------------- |
| `AgentRuntime`              | 接口       | 已有 `aip/agent_runtimes/` |
| `Connector`                 | 声明式包   | 已有 `connectors/`         |
| `FunctionHandler`           | 函数注册   | 已有，需文档化             |
| `Pipeline Source/Transform` | YAML 插件  | 需形式化                   |
| `Studio Page`               | React 组件 | Refine Resource + 类型约束 |
| `Playbook StepType`         | 枚举扩展   | 新增                       |
| `Event Consumer`            | 订阅注册   | outbox 模型后可扩展        |

#### F3. Pack Registry（可选，Phase C+）

本地私有：Platform Admin 管理 Pack 安装历史。  
SaaS/云端：ClawTwin Marketplace（与 Palantir Marketplace 类比，长期路线图）。

---

### 维度 G：安全与合规 ⚠

**已有（基础扎实）**

- OT/IT/DMZ 分区（铁律 34）
- Casbin ABAC + Marking（场站/部门/敏感度/Zone）
- JWT + station_ids 鉴权
- 审计日志（`audit_logs`，append-only 目标）
- 飞书唯一出网（铁律 34）

**缺口**

| 缺失点                                   | 重要性        | 建议                                                                                                                                 |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **数据入口校验（Ingestion Validation）** | 高            | 异常读数（超出设备量程 3σ、全零持续、时间戳回跳）需被 Pipeline 捕获并入 `quarantine` 而非直接入 Object；防止「数据投毒」影响 AI 决策 |
| **Prompt 注入防护**                      | 高            | `ai_function` 调用时，用户/设备提供的字符串字段进入 prompt 前需经 sanitize；对应 `DEVELOPMENT-CONTRACT` 「数据脱敏」策略的实现       |
| **LLM 输出边界（Output Guard）**         | 中            | AI 不允许在回答里生成操作指令（如「关闭 V-002 阀门」）；应只输出「建议」字段，由 Action Type 在 HITL 下执行                          |
| **密钥与 Service Token 轮转**            | 中            | `bridge-service-token`、`oa-service-token` 等目前静态；需有轮转 + 审计策略                                                           |
| **合规报告自动生成**                     | 低（Phase C） | ISA-18.2 告警管理报告、ISO 14224 设备历史报告可从 Ontology Object 自动生成；是「本体价值」的重要商业化点                             |

---

## 三、AI 发展趋势对照

| 趋势                             | 趋势描述                                                 | ClawTwin 现状                                | 建议                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------- |
| **Agent 调度层**                 | 多 Agent 协作；Agent 不再是单体，而是组合                | AgentRuntime 抽象已建立，单运行时为主        | Playbook 的每个 step 可声明调用「专门化 Agent」（诊断 Agent / 报表 Agent），通过 `aip/agent_runtimes/` 路由                            |
| **结构化输出**                   | LLM 输出 JSON schema 而非自由文本                        | Function Type 有 output schema，但实现未强制 | `FunctionExecutor` 调用 LLM 时强制 `response_format=json_schema`；验证失败则重试/降级                                                  |
| **长上下文 + RAG 共存**          | 大模型支持超长 context，但 RAG 仍是「精准 + 省钱」的选择 | pgvector + LlamaIndex 路径已定               | 引入 **Retrieval Strategy**（对应 KnowQL 思路）：Playbook step 可声明 `retrieval: semantic_k5                                          | graph_expand | full_context`，由 FunctionExecutor 选择 |
| **Tool Use 标准化（MCP）**       | MCP 成为 Agent-Tool 协议标准                             | MCP stub 已有，tools/call 未真实执行         | MCP tools/call 真实执行是 Phase B 核心；与 HTTP Tool API 同源 handler（已是铁律）                                                      |
| **可解释 AI / Trustworthy AI**   | 监管要求 AI 决策可解释                                   | `reasoning_trace` 字段未系统化               | `AIFunctionResult.reasoning_trace` + `citations` 成为合规标准；Studio 「AI 推理详情」侧边栏                                            |
| **AI Evaluation as Engineering** | Eval 不再是事后测试，而是持续工程                        | 无 EvalPipeline                              | OutcomeEvent → EvalRun 闭环（维度 E/C1）                                                                                               |
| **私有化部署 + 数据主权**        | 工业客户强调数据不出网                                   | 铁律 34 已定，私有化为默认                   | Industry Pack 的 L0/L1 知识可离线分发；LLM 在客户 GPU 推理（已有 vLLM 路径）；需要明确「哪些知识可 SaaS 更新，哪些必须客户审核后推送」 |

---

## 四、完整性检查矩阵（自洽性验证）

对一个「业务自洽」的工业平台，以下 12 个问题应有明确答案：

| #   | 问题                             | 当前状态                                       | 文档位置                              |
| --- | -------------------------------- | ---------------------------------------------- | ------------------------------------- |
| 1   | **数据怎么进来？**               | ✅ OPC-UA Pipeline + IMS Connector + KB Upload | `INDUSTRIAL-FOUNDRY-ARCHITECTURE §七` |
| 2   | **数据质量怎么保证？**           | ⚠ Pipeline 原则已有，行级质量规则未系统化      | 本文维度 B                            |
| 3   | **数据怎么成为业务对象？**       | ✅ Pipeline → Object via ObjectStore           | `FOUNDRY §四/§七`                     |
| 4   | **业务规则怎么声明和执行？**     | ✅ Action Type + ActionExecutor                | `FOUNDRY §四.2`                       |
| 5   | **何时调用 AI？谁有权限调？**    | ⚠ Policy 框架在控制面文档，执行未实现          | `CONTROL-PLANE §四.4`                 |
| 6   | **AI 输出是什么格式？可信吗？**  | ⚠ Function Type 有 schema，置信度/推理链未强制 | 本文维度 C2                           |
| 7   | **人什么时候介入？流程是什么？** | ✅ HITL + ApprovalQueue + Playbook checkpoint  | `FOUNDRY §四.2 + CONTROL-PLANE §D2`   |
| 8   | **执行结果反馈给谁？怎么改进？** | ❌ OutcomeEvent 未建立                         | 本文维度 B                            |
| 9   | **多步业务怎么编排、怎么追踪？** | ⚠ Playbook 已设计，run 表 / 可观测未实现       | `CONTROL-PLANE §四 + 本文维度 E`      |
| 10  | **权限和数据隔离怎么保证？**     | ✅ Marking + Casbin + JWT station_ids          | `FOUNDRY §十一 + ADR-6`               |
| 11  | **系统出了问题怎么排查？**       | ⚠ audit_log 已有，全链路 trace 未建立          | 本文维度 E                            |
| 12  | **新业务、新行业怎么扩展？**     | ❌ Industry Pack 模型未形式化                  | 本文维度 F                            |

**当前自洽度：8/12 ✅ 或 ⚠，2 项 ❌（OutcomeEvent 反馈闭环 + Industry Pack 扩展模型）**

---

## 五、优化后的完整架构叙事（一张图）

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  APPS LAYER（人机协同）                                                       ║
║  Studio（Web/本地）· 飞书 Bot + 卡片 · CLI · Grafana · Handheld（B+）         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  CONTROL PLANE（业务编排与策略）                                               ║
║  Playbook Engine   Trigger Binding   ApprovalQueue / HITL                    ║
║  Policy Engine     InvocationContext     OutcomeEvent Collector              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  ★ ONTOLOGY CORE（工业本体，平台心脏）                                        ║
║  Object Types  Link Types  Action Types  Function Types  Markings            ║
║  ObjectStore   ActionExecutor   FunctionExecutor   PipelineRunner            ║
╠══════════════╦═══════════════════════════╦═══════════════════════════════════╣
║ DATA PLANE   ║  AI CAPABILITY PLANE      ║  OBSERVABILITY PLANE             ║
║              ║                           ║                                   ║
║ Pipeline     ║  AgentRuntime 适配器      ║  Run Ledger（Playbook runs）       ║
║ Connector    ║  LLM Provider（vLLM/云端）║  Lineage Graph                    ║
║ Catalog      ║  Embed + RAG（LlamaIndex）║  LLM Trace + EvalRun              ║
║ Lineage      ║  MOIRAI（时序）           ║  Audit Trail                      ║
║ DataContract ║  Inference Router         ║  OTel Traces + Metrics            ║
║ OutcomeFeed  ║  Output Guard             ║  Business KPI Panel               ║
╠══════════════╩═══════════════════════════╩═══════════════════════════════════╣
║  INTEGRATION LAYER                                                            ║
║  OPC-UA Bridge（DMZ，只采集）   IMS Connect（ERP/CMMS/OA，双向）              ║
║  Event Bus（进程内→Streams→Kafka）   Webhook outbox                           ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  FOUNDATION（存储）                                                            ║
║  PostgreSQL + TimescaleDB + pgvector   Redis   MinIO（B+）                    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  EXTENSIBILITY（平台扩展）                                                     ║
║  Industry Pack（本体 + 流水线 + Playbook + 知识 + 组件）                       ║
║  Extension Points SDK（AgentRuntime / Connector / FunctionHandler / ...）     ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

与原架构相比，新增了三个横切面：**Control Plane**（从 Ontology Core 分出）、**Observability Plane**（独立第三轴）、**Extensibility**（底层独立层）。

---

## 六、补全路线图（与 Phase A/B/C 对齐）

### Phase A 需补入（小增量，高价值）

1. **`AIFunctionResult` 结构**（`confidence` + `citations` + `reasoning_trace`）  
   → 改 `core/function_executor/` + 已有 `llm_traces` schema
2. **`OutcomeEvent` Object Type YAML**  
   → 新文件 + Alembic migration；Link 到 WorkOrder / Alarm
3. **`InvocationContext` 中间件注入**  
   → `core/invocation/context.py`；从 JWT middleware 透传 `trace_id`
4. **`playbook_runs` + `run_steps` 表**（最小可用，仅 Scheduler 晨报 + 告警告警诊断两条）  
   → Alembic + 只读 HTTP `GET /v1/playbook-runs`
5. **Ingestion Validation Hook**  
   → Pipeline YAML 增加 `quality_rules:` 字段；失败行进 `quarantine_readings`

### Phase B 新增

6. **EvalPipeline**（基于 `llm_traces` + `OutcomeEvent` 的离线评估）
7. **CompositeAlarmRule**（多信号复合告警 Object + evaluate）
8. **Playbook compensation / async checkpoint**（Playbook 暂停等待飞书卡片回调）
9. **Observability Layer 2**（`Run Ledger` API + Studio 运行历史页面）
10. **Inference Router**（Function Type `inference.locality` 声明 + Provider 路由）

### Phase C 形式化

11. **Industry Pack 规范**（`manifest.yaml` schema + 安装/卸载 CLI）
12. **Extension Points SDK 文档化**（面向合作伙伴 / 集成商）
13. **EvalRun Business Dashboard**（AI 质量面板 + Playbook 健康）
14. **Compliance Report Generator**（ISA-18.2 / ISO 14224 自动报告）

---

## 七、对「业务自洽整体」的最终判断

**现有设计的核心方向完全正确**，可以归纳为：

> **数据从 OT/IT 世界进入本体，本体是业务真相，控制面按策略编排业务，AI 是在本体约束下调用的能力，所有发生的事情可观测、可追溯、可改进。**

这个叙事是自洽的。现在缺的不是重新设计，而是**三个闭环**没有被显式建立：

1. **结果反馈闭环**：OutcomeEvent → EvalPipeline → Function 改善
2. **可观测闭环**：Run Ledger + OTel → Business KPI → 平台本身的持续改进
3. **扩展交付闭环**：Industry Pack → 新行业部署 → 知识反哺 → Pack 版本迭代

把这三个闭环和本文 Phase A/B/C 的 14 项补全放入现有路线图，ClawTwin 就是一个**架构完整、业务自洽、与 AI 趋势同向**的工业数字孪生平台。

---

_本文件应在每次重大架构评审（Phase 切换、主要 Object Type 新增、AgentRuntime 变更）时重新过一遍自洽性检查矩阵（§四），确认 12 项均为 ✅ 或有意识的 ⚠。_
