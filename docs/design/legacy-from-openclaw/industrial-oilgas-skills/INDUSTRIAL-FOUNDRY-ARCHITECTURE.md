# ClawTwin Industrial Foundry 架构（最终决定性架构）

> **版本**：v1.2 · 2026-05-11  
> **范式纠正**：ClawTwin **不是 Agent 系统**（OpenClaw / Claude Code），而是 **Palantir Foundry 风格的工业本体平台**  
> **本文档地位**：架构层最高权威。之前的 ARCHITECTURE-PRUNING-2026 / CORE-ARCHITECTURE-AUDIT-2026 中关于 Tool / @tool / Channel 的设计**仍然有效**，但**必须从属于本文档定义的 Ontology Layer**。

> ★ **配套权威文档（三层最高权威）**：
>
> - **架构层**（本文）：`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`
> - **交付层**：`USER-ENVIRONMENT-DELIVERY-VALIDATION.md`（飞书 + OpenClaw/HiAgent + IMS 反推架构）
> - **选型层**：`TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md`（buy/borrow/build + 价值审计）
> - **总入口**：`DESIGN-FINAL-MASTER-INDEX.md`（5 分钟找到所有信息）

> ★ **v1.1 更新**：基于"用户真实环境（飞书 + OpenClaw/HiAgent + IMS）"反推架构，新增三大抽象：
>
> - **AgentRuntime 抽象**（§六.4）：让 OpenClaw / HiAgent / Dify / Coze 可切换；MCP + OpenAPI 双协议暴露同一 Ontology
> - **IMS Connector 抽象**（§七.3）：客户已有 ERP/CMMS/Historian 接入的标准包结构；标准包 80% + generic+transformer 20%
> - **Source-of-Truth 策略**（§四.1.5）：每个 Object Type 必须明确数据真理来源；Action 自动处理双向同步

> ★ **v1.2 更新（与选型层对齐）**：
>
> - **强制借力**：LinkML（Object Type schema）/ Airbyte（IMS Connector）/ Refine（Studio 70%）/ Casbin（ABAC/Marking）/ LlamaIndex（KB）/ OpenLineage（数据血缘）/ OSDU + ISO 14224/15926 + ISA-18.2 + OPC-UA Companion Spec（开放工业知识/本体）
> - **禁止造**：Object schema 校验框架 / ETL 框架 / Admin Panel 框架 / 权限引擎 / RAG chunker / 通用工业知识

---

## 一、范式纠正：ClawTwin 是 Foundry，不是 Agent

### 1.1 三种 AI 时代架构范式对比

| 维度         | Agent 系统（OpenClaw / Claude Code） | RAG 应用（LangChain Apps） | **Ontology 平台（Palantir Foundry / ClawTwin）**        |
| ------------ | ------------------------------------ | -------------------------- | ------------------------------------------------------- |
| **核心公民** | Agent + 对话                         | LLM + 文档                 | **业务对象（Object Type）**                             |
| **核心抽象** | Tool 函数                            | Chain                      | **Ontology = Object + Link + Action + Function**        |
| **数据视角** | 临时检索                             | 检索增强                   | **数据是中心，AI 是数据上的能力之一**                   |
| **写操作**   | Agent 调 tool                        | 一般不写                   | **Action Type（带 schema/validators/effects/lineage）** |
| **协作模型** | 单用户单会话                         | 单用户问答                 | **多用户多项目多组织（Marking 隔离）**                  |
| **应用层**   | Chat UI                              | 检索 UI                    | **Workshop（从 Ontology 自动生成 + 自定义）**           |
| **演进路径** | 加更多 tool                          | 加更多 retriever           | **扩展 Ontology**                                       |
| **典型用户** | 开发者、个人                         | 知识工作者                 | **企业、组织、跨部门协作**                              |

### 1.2 工业场景为什么必须是 Foundry 而不是 Agent

```
工业场景的本质：
  · 30 台设备的 7 种状态、2000 个传感器读数、150 个告警、80 个待办工单 ← 数据为王
  · 操作员、工程师、主管、HSE、班长 ← 多角色协作
  · 上游 SCADA / 下游 ERP / 旁路 CMMS / 飞书 ← 多系统集成
  · OT 区 / IT 区 / DMZ ← 强权限分区
  · 5 年数据、10 年知识沉淀 ← 数据资产积累

Agent 系统能解决：「请帮我看 C-001 状态」← 单点对话
Foundry 能解决：
  · 持久化 Equipment / Alarm / WorkOrder Object（不是临时返回）
  · 任意维度的关联查询和分析（设备-告警-工单-操作员-知识 全图遍历）
  · 多用户协同（A 工程师确认告警 → B 主管审批工单 → C 操作员执行）
  · 数据血缘（这个告警来自哪个传感器，这个工单源于哪个告警）
  · 知识资产（不是消息，而是 Ontology 上沉淀的对象 + 关系）
```

**结论：ClawTwin 是工业 Foundry。Agent（OpenClaw）只是 Foundry 之上的一层 AI 能力。**

---

## 二、Palantir Foundry 的核心架构（参考）

```
┌────────────────────────────────────────────────────────────────────┐
│ Apps Layer                                                         │
│   Workshop（自定义业务 App）   Slate（仪表盘）   Notepad（分析）   │
│   Quiver（移动端）             Marketplace（应用市场）             │
├────────────────────────────────────────────────────────────────────┤
│ AIP (AI Platform)                                                  │
│   AIP Logic（LLM 推理）       AIP Agents                          │
│   AIP Functions（注册到 Ontology）                                 │
├────────────────────────────────────────────────────────────────────┤
│ ★ Ontology（最核心层）                                            │
│   Object Types │ Link Types │ Action Types │ Function Types       │
│   Markings（权限）│ Branches（多版本）│ Editions                  │
├────────────────────────────────────────────────────────────────────┤
│ Pipeline Layer                                                     │
│   Pipeline Builder（无代码）  Code Repositories（Python/Spark/SQL）│
│   Schedule + Triggers + Lineage                                   │
├────────────────────────────────────────────────────────────────────┤
│ Foundation (Storage)                                               │
│   Datasets（Parquet/Delta）   Streams   Code Workspaces           │
└────────────────────────────────────────────────────────────────────┘
```

**关键理念：**

1. **Ontology 是平台核心**——其他所有层都围绕它服务
2. **Apps 是 Ontology 的视图**——Workshop 从 Ontology 自动生成
3. **AIP 是 Ontology 上的 AI 能力**——AI 调用 Action/Function，不绕过 Ontology
4. **Pipeline 把数据变成 Ontology Object**——不是简单 ETL
5. **Foundation 支撑 Ontology**——Object 持久化在这里

---

## 三、ClawTwin Industrial Foundry 架构（对应映射）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Apps Layer                                                              │
│                                                                         │
│   ClawTwin Studio（Workshop 风格 Web App）                               │
│      · Equipment 详情页（自动从 Object Type 生成）                       │
│      · Alarm 队列页 / WorkOrder 看板（自动 + 自定义混合）                 │
│      · Mission Control（运营仪表盘，类 Slate）                           │
│      · Reports（嵌入 Grafana）                                           │
│   ClawTwin Mobile（飞书 Bot 卡片应用）                                   │
│   Custom Apps（客户用 Studio Builder 自建）                              │
│   Industry Dashboards（Grafana embedded）                                │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────────────┐
│ AIP (Industrial AI Platform)                                            │
│                                                                         │
│   OpenClaw Agent Runtime（聊天 / 多轮推理）                              │
│   MCP Server                                                            │
│      · 自动暴露 Ontology Action Type → MCP Tool                          │
│      · 自动暴露 Ontology Function Type → MCP Tool                        │
│      · 自动暴露 Ontology Object 查询 → MCP Tool                          │
│   Sage Skills（industrial-assistant / -analytics / -admin）             │
│   LLM Trace + Eval（每次 AI 推理可追溯可评估）                            │
│   Provider 抽象（vLLM / 通义 / 文心 / Claude）                           │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────────────┐
│ ★ Industrial Ontology（最核心层，所有业务定义在此）                      │
│                                                                         │
│  Object Types（业务实体）                                                │
│   ├── Station（场站）                                                    │
│   ├── Equipment（设备）                                                  │
│   ├── EquipmentReading（设备读数，时序）                                  │
│   ├── Alarm（告警）                                                      │
│   ├── WorkOrder（工单）                                                  │
│   ├── ProductionRecord（生产数据）                                       │
│   ├── ShiftHandover（交接班）                                            │
│   ├── InspectionRoute（巡检路线）                                        │
│   ├── KBDocument（知识文档）                                             │
│   ├── User（用户）                                                       │
│   └── ApprovalRequest（审批请求）                                        │
│                                                                         │
│  Link Types（对象关系，AI 可遍历）                                       │
│   ├── Equipment.station ← Station.equipment（多对一）                    │
│   ├── Equipment.alarms → Alarm.equipment（一对多）                       │
│   ├── Equipment.workorders → WorkOrder.equipment（一对多）               │
│   ├── Alarm.workorder → WorkOrder.source_alarm（一对一可选）             │
│   ├── WorkOrder.approver → User                                         │
│   ├── KBDocument.equipment_type → Equipment.type（按类型关联）            │
│   └── ...                                                                │
│                                                                         │
│  Action Types（写操作，统一 schema/审批/审计/血缘）                       │
│   ├── AcknowledgeAlarm（low risk）                                       │
│   ├── ShelveAlarm（medium，需主管审批）                                  │
│   ├── CreateWorkOrder（low）                                             │
│   ├── ApproveWorkOrder（medium，本站主管）                               │
│   ├── CompleteWorkOrder（low + 必须有证据）                              │
│   ├── RecordProduction（low + 异常值需复核）                             │
│   ├── SubmitShiftHandover（low）                                         │
│   ├── ConfirmShiftHandover（low）                                        │
│   ├── IngestKBDocument（low）                                            │
│   ├── PublishKBL3Knowledge（medium，KB Admin）                           │
│   └── ApproveAction（meta-action，处理审批）                             │
│                                                                         │
│  Function Types（计算/AI 推理，只读）                                    │
│   ├── ComputeHealthScore(Equipment) → number                            │
│   ├── PredictBreach(Equipment, hours=2) → BreachPrediction              │
│   ├── DiagnoseEquipment(Equipment) → DiagnoseResult                     │
│   ├── SearchKnowledge(query, filters) → KBHit[]                         │
│   ├── BuildDecisionPackage(Equipment) → DecisionPackage                 │
│   ├── BuildMorningBriefing(Station) → BriefingDoc                       │
│   ├── DetectAnomaly(Equipment, window=7d) → AnomalyResult               │
│   └── AnalyzePIDDrawing(image) → PIDAnalysis（Phase B）                  │
│                                                                         │
│  Markings（权限分区，跨 Object 应用）                                    │
│   ├── StationMarking（按场站 ID 隔离）                                   │
│   ├── DepartmentMarking（运维 / 生产 / 安全 / KB）                       │
│   ├── SensitivityMarking（公开 / 内部 / 机密）                           │
│   └── ZoneMarking（OT / IT / DMZ）                                       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────────────┐
│ Pipeline Layer（数据 → Object 转换）                                     │
│                                                                         │
│   OPC-UA Pipeline                                                       │
│      asyncua bridge → Redis Streams → EquipmentReading Object           │
│   IMS Pipeline                                                          │
│      ERP/CMMS REST → 数据清洗 → WorkOrder Object（外部源）               │
│   Knowledge Pipeline                                                    │
│      PDF Upload → LlamaIndex → KBDocument Object + pgvector             │
│   Alarm Pipeline                                                        │
│      EquipmentReading → 阈值规则 → Alarm Object                          │
│   Knowledge Flywheel Pipeline                                           │
│      已完成 WorkOrder → KBDocument(L3) Object                           │
│   ML Pipeline（Phase B）                                                 │
│      历史时序 → MOIRAI 训练 → 预测 Function 后端                         │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────────────────┐
│ Foundation (Storage)                                                    │
│                                                                         │
│   PostgreSQL                                                            │
│      · Object Tables（按 Object Type 一表一类型）                        │
│      · TimescaleDB（EquipmentReading 时序超表）                          │
│      · pgvector（KB embeddings）                                         │
│   Redis                                                                 │
│      · 设备影子状态（替代 Eclipse Ditto）                                 │
│      · Object Cache                                                      │
│      · Streams（OPC-UA 事件队列）                                        │
│   Object Storage（Phase B：MinIO）                                       │
│      · 文档原文 / 图片 / 模型权重                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 四、核心抽象：Industrial Ontology

### 4.1 Object Type 的声明式定义

```yaml
# ontology/object-types/equipment.yaml
object_type:
  api_name: Equipment
  display_name: 设备
  plural_name: 设备
  description: 工业设备的统一表示（压缩机、泵、阀门等）
  primary_key: id

  properties:
    id: # 必填
      type: string
      max_length: 50
      pattern: "^[A-Z]-[0-9]{3,}$" # C-001, P-001, V-007
    name:
      type: string
      display_name: 设备名称
    type:
      type: enum
      values:
        - centrifugal_compressor
        - reciprocating_compressor
        - centrifugal_pump
        - reciprocating_pump
        - ball_valve
        - gate_valve
        - pressure_vessel
        - heat_exchanger
        - storage_tank
    status:
      type: enum
      values: [running, standby, warn, alarm, fault, maintenance, commissioned, offline]
      default: offline
      lifecycle: true # ← 状态字段，触发 FSM
    station_id:
      type: string
      foreign_key: Station.id
      indexed: true
    location:
      type: string # GPS 或建筑物坐标
    commissioned_at:
      type: timestamp
    manufacturer:
      type: string
    model:
      type: string
    serial_number:
      type: string
      pii: false # 非个人信息

  # 来自 Pipeline 的衍生属性（不存储，按需计算）
  computed_properties:
    health_score:
      type: number
      function: ComputeHealthScore
      cache_ttl: 60s
    predicted_breach_minutes:
      type: number
      function: PredictBreach
      cache_ttl: 300s
    primary_action:
      type: string
      function: BuildDecisionPackage.primary_action
      cache_ttl: 30s

  # Link Types（对象关系）
  links:
    station:
      to: Station
      type: many_to_one
      reverse: equipment
      required: true
    alarms:
      to: Alarm
      type: one_to_many
      reverse: equipment
    workorders:
      to: WorkOrder
      type: one_to_many
      reverse: equipment
    latest_reading:
      to: EquipmentReading
      type: many_to_one
      query: "ORDER BY ts DESC LIMIT 1"
    knowledge_docs:
      to: KBDocument
      type: many_to_many
      via: equipment_type # 通过 type 字段关联

  # 索引（自动生成）
  searchable_properties: [id, name, type, status]

  # Markings（权限）
  applied_markings:
    - station_marking # 按 station_id 隔离
    - zone_marking # OT 设备数据有访问限制

  # Studio UI 自动生成提示
  ui_hints:
    icon: industrial-equipment
    color_by: status
    list_columns: [id, name, type, status, health_score]
    detail_layout: equipment_layout # ← 引用 Studio Layout 文件
```

### 4.1.5 Object Type 的 Source-of-Truth 策略（v1.1 新增）

**问题背景**：客户已有 IMS（SAP/Oracle/用友/Maximo），同一个 Equipment / WorkOrder 在 IMS 和 ClawTwin 两地有副本，谁是真理？写入冲突如何处理？

**解决方案**：每个 Object Type 必须声明 SoT 策略：

```yaml
# ontology/object_types/work_order.yaml 增加：
source_of_truth_strategy:
  default: external # foundry | external | hybrid

  # external 模式：客户 IMS 是真理；Connector 拉取为主，Action 双向写
  # foundry 模式：ClawTwin 是真理；可选导出到 IMS
  # hybrid 模式：按字段所有权区分

  external_system: sap_pm # 仅 external/hybrid 时填

  field_ownership: # 仅 hybrid 时填
    title: external # IMS 改→Foundry 跟随
    state: hybrid_workflow # FSM 在 Foundry，但完成后写回 IMS
    ai_diagnose_summary: foundry # AI 增强字段，永远归 Foundry
    ai_recommended_actions: foundry
    citations: foundry

  conflict_resolution: # 当 IMS 和 Foundry 同时变更时
    strategy: external_wins | foundry_wins | last_write_wins | manual_review
    audit: required # 冲突自动写 conflict_logs
```

**框架自动行为（业务代码不感知）**：

- `CreateWorkOrder` Action：先调 IMS 创建拿 external_id，再写 Foundry，失败回滚
- `CompleteWorkOrder` Action：写 Foundry 后异步反向写 IMS（按 connector.write_back 配置）
- IMS Connector 拉取时：external 字段覆盖 Foundry，foundry 字段不动，hybrid 按 ownership

详见 `USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四.4`。

---

### 4.2 Action Type 的声明式定义

```yaml
# ontology/action-types/acknowledge_alarm.yaml
action_type:
  api_name: AcknowledgeAlarm
  display_name: 确认告警
  description: ISA-18.2 告警确认（仅标记知晓，不抑制告警本身）

  parameters:
    alarm:
      type: ObjectReference
      object_type: Alarm
      required: true
    reason:
      type: string
      max_length: 500
      required: false
      display_name: 确认原因（可选）

  # Validators（执行前校验，失败抛业务异常）
  validators:
    - rule: alarm.status in ["active", "suppressed"]
      message: "告警必须处于 active 或 suppressed 状态"
    - rule: actor.role in ["operator", "supervisor", "engineer"]
      message: "需要 operator/supervisor/engineer 角色"
    - rule: actor.station_ids contains alarm.station_id
      message: "无该场站权限"

  # Effects（变更对象状态，由框架原子执行）
  effects:
    - update: alarm
      set:
        status: acknowledged
        acknowledged_at: now()
        acknowledged_by: actor.id
        ack_reason: parameters.reason

  # Side Effects（异步触发，不影响事务）
  side_effects:
    - emit_event: AlarmAcknowledged
      payload: { alarm_id: alarm.id, actor: actor.id }
    - notify:
        target: alarm.equipment.responsible_engineer
        template: alarm_acknowledged_card

  # 安全合约
  safety:
    risk_level: low
    idempotent: true
    rate_limit: 30/minute_per_actor

  approval:
    required: false # high risk 自动 true

  audit: required # 写 audit_logs（自动）
  trace: required # 写 llm_traces（自动）

  # Lineage（数据血缘自动建立）
  lineage:
    reads_from: [alarm]
    writes_to: [alarm]
```

### 4.3 Function Type 的声明式定义

```yaml
# ontology/function-types/diagnose_equipment.yaml
function_type:
  api_name: DiagnoseEquipment
  display_name: 诊断设备
  description: 综合实时数据 + 知识库 + 历史工单生成诊断报告

  parameters:
    equipment:
      type: ObjectReference
      object_type: Equipment
      required: true
    context_window_hours:
      type: integer
      default: 24

  output:
    type: object
    schema:
      summary: { type: string }
      root_cause_candidates: { type: array, items: string }
      confidence: { type: number, range: [0, 1] }
      citations: { type: array, items: KBCitation }
      recommended_actions: { type: array, items: ActionRecommendation }

  implementation:
    type: ai_function # 三种之一：ai_function | python_function | sql_function
    delegation:
      backend: openclaw
      skill: industrial-assistant
      tool_chain: [get_equipment_context, search_kb, diagnose]

  # 缓存（同一输入 5 分钟内复用）
  cache:
    ttl: 300s
    key: [equipment.id, context_window_hours]

  # 成本（用于 budget 控制）
  cost:
    estimated_usd: 0.012

  audit: optional
  trace: required # AI 推理必须追溯
```

### 4.4 Markings（权限分区）

```yaml
# ontology/markings/station_marking.yaml
marking:
  api_name: station_marking
  display_name: 场站权限
  description: 用户只能访问 station_ids 中的对象

  applies_to:
    - object_property: station_id
    - implicit_via_link: equipment.station

  enforcement:
    on_query: filter
    on_mutation: deny_if_mismatch
    on_link_traversal: enforce
```

---

## 五、Studio = Foundry Workshop

### 5.1 Studio 自动从 Ontology 生成 UI（70%）

```
不再为每个 Object 写一个 React 页面，而是：

Studio 路由：
  /studio/objects/Equipment              ← 列表页（自动从 Equipment.searchable_properties 生成搜索栏）
  /studio/objects/Equipment/C-001        ← 详情页（自动从 properties + links 生成 Tab）
  /studio/objects/Alarm                  ← Alarm 列表
  /studio/objects/WorkOrder              ← WorkOrder 列表

Studio 自动渲染：
  · Object 列表（含搜索/筛选/排序，从 Object Type 元数据生成）
  · Object 详情（Properties Section + Links Section + Actions Section）
  · Action 表单（从 Action Type parameters 生成 form schema）
  · Function 调用面板（从 Function Type 生成）
  · 关联图谱（一个 Equipment 的所有 Alarm/WorkOrder/KB）
```

### 5.2 自定义 Workshop 应用（30%）

业务专属的复杂页面（不能自动生成）：

```
/studio/twin                  ← 3D 数字孪生视图（Babylon.js）
/studio/mission-control       ← Fleet Mission Control
/studio/morning-briefing      ← 晨报视图
/studio/shift-handover        ← 交接班看板
/studio/admin/traces          ← LLM Trace 评估
/studio/admin/approvals       ← 审批中心
```

这些页面**仍然调用 Ontology Action / Function**，只是 UI 是定制的。

### 5.3 Studio Layout 文件（让自动生成可定制）

```yaml
# studio/layouts/equipment_layout.yaml
layout:
  for_object: Equipment

  hero_section:
    title: "{{ name }} ({{ id }})"
    subtitle: "{{ type | label }} · {{ station.name }}"
    status_badge: status
    primary_action: BuildDecisionPackage.primary_action

  tabs:
    - name: 概览
      content:
        - widget: properties_table
          properties: [id, name, type, status, manufacturer, commissioned_at]
        - widget: trend_chart
          property: latest_reading.vibration
          window: 24h
        - widget: ai_insight_card
          function: DiagnoseEquipment
    - name: 告警
      content:
        - widget: link_table
          link: alarms
          filter: status in ["active", "suppressed"]
    - name: 工单
      content:
        - widget: link_table
          link: workorders
    - name: 知识
      content:
        - widget: link_table
          link: knowledge_docs
```

**Studio Layout 是 Workshop 风格的 UI 配置**，不写 React 代码就能调整布局。

---

## 六、AIP = OpenClaw + MCP（自动从 Ontology 生成）

### 6.1 MCP Tools 自动生成

不再手写 30+ 个 MCP tool。**MCP Server 启动时遍历 Ontology**：

```python
# infra/aip/mcp_generator.py
def build_mcp_from_ontology() -> FastMCP:
    mcp = FastMCP("clawtwin-industrial-ontology")

    # 1. 每个 Object Type 自动生成查询工具
    for ot in ontology.object_types:
        @mcp.tool(name=f"get_{ot.api_name.lower()}", description=f"按 ID 获取 {ot.display_name}")
        async def _get(object_id: str, _ot=ot):
            return await ObjectStore.get(_ot.api_name, object_id)

        @mcp.tool(name=f"search_{ot.api_name.lower()}", description=f"搜索 {ot.display_name}")
        async def _search(query: str = "", filters: dict = {}, limit: int = 20, _ot=ot):
            return await ObjectStore.search(_ot.api_name, query, filters, limit)

    # 2. 每个 Action Type 自动生成执行工具
    for at in ontology.action_types:
        @mcp.tool(name=at.api_name, description=at.description)
        async def _exec(_at=at, **params):
            actor = get_mcp_actor()
            return await ActionExecutor.execute(_at.api_name, params, actor, transport="mcp")

    # 3. 每个 Function Type 自动生成调用工具
    for ft in ontology.function_types:
        @mcp.tool(name=ft.api_name, description=ft.description)
        async def _call(_ft=ft, **params):
            return await FunctionExecutor.call(_ft.api_name, params)

    return mcp
```

**LLM 自动看到所有 Object Type / Action Type / Function Type**，无需为每个能力单独注册。新增 Object Type → MCP 自动多 2 个 tool。

### 6.2 Sage Skills（行业经验沉淀）

OpenClaw Skills 仍然存在，但定位变了：

- **不是工具集合**——工具来自 Ontology
- **是 prompt + 经验**——告诉 LLM 如何用 Ontology 解决工业问题

```markdown
# industrial-assistant/SKILL.md（修正版）

---

name: industrial-assistant
description: 工业场站日常运营 AI 助手

---

# 工业场站运营助手

## 你能调用的能力（来自 Industrial Ontology，自动暴露为 MCP Tools）

### Object 查询

- get_equipment, search_equipment, get_alarm, search_alarm, get_workorder, ...

### Action 执行（写操作）

- AcknowledgeAlarm, ShelveAlarm, CreateWorkOrder, ApproveWorkOrder, ...

### Function 调用（推理）

- ComputeHealthScore, PredictBreach, DiagnoseEquipment, SearchKnowledge, ...

## 工作流模式

### 模式 1：用户询问设备状态

1. get_equipment(id) 拿到对象
2. 看 Object 的 computed_properties.primary_action 提示当前优先动作
3. 按需调 DiagnoseEquipment 给详细分析
4. 返回结构化诊断（含 citations）

### 模式 2：告警处理

1. search_alarm(filters={status: "active"}) 拿到活跃告警列表
2. 按 priority 排序展示
3. 用户选择告警后：根据告警类型推荐 AcknowledgeAlarm / ShelveAlarm / CreateWorkOrder
4. 高风险动作（如 ShelveAlarm > 1h）自动走审批流

### 模式 3：知识检索

1. SearchKnowledge(query, filters={layer: ["L0", "L1", "L2"], equipment_type: ...})
2. 返回 top 5 命中
3. 每条带 citation（doc_id + section）

## 安全约束

- 不要绕过 Action Type 直接修改数据
- 不要假设权限——Action Executor 会校验
- 引用必须真实——citations 字段不能编造
```

### 6.3 OpenClaw 调用 MCP 的执行链

```
用户在飞书问："C-001 振动异常吗？"
  ↓
OpenClaw Agent Loop
  ↓
LLM 看到所有 MCP tools（含 get_equipment / DiagnoseEquipment / SearchKnowledge ...）
  ↓
LLM 决定调用：get_equipment(id="C-001")
  ↓
MCP Server → ObjectStore.get(Equipment, "C-001")
  ↓
返回 Equipment Object（含 computed health_score）
  ↓
LLM 决定调用：DiagnoseEquipment(equipment={id: "C-001"})
  ↓
MCP Server → FunctionExecutor.call("DiagnoseEquipment", ...)
  ↓
ai_function 委派回 OpenClaw industrial-assistant Skill（递归式 sub-agent）
  ↓
最终 LLM 综合返回结构化结果给用户
```

### 6.4 AgentRuntime 抽象（v1.1 新增 · 让任意 Agent 平台都可对接）

**问题**：客户已有 OpenClaw 或 HiAgent 或 Dify。Foundry 不能绑死任何一个。

**方案**：AIP Layer 增加 AgentRuntime 抽象 + 双协议暴露（MCP + OpenAPI）。

```
                  ┌─────────────────────────────────────┐
                  │  ClawTwin AIP Layer                  │
                  │                                      │
   OpenClaw ────► │  /mcp (FastMCP，stdio/HTTP/SSE)     │
   Cursor   ────► │                                      │
   Claude   ────► │                                      │
                  │                                      │
   HiAgent  ────► │  /v1/openapi (FastAPI 自动+扩展)     │
   Dify     ────► │                                      │
   Coze     ────► │                                      │
                  │                                      │
                  │  AgentRuntime Adapters：             │
                  │  · 鉴权解析 → Foundry Actor          │
                  │  · 工具描述 → 平台所需 schema        │
                  │  · 流式响应 → 平台所需格式            │
                  └────────────┬─────────────────────────┘
                               ▼
                   同一个 Industrial Ontology
```

**目录**：

```
aip/
├── mcp_server.py              ← FastMCP，遍历 ONTOLOGY 注册所有工具
├── openapi_exporter.py        ← FastAPI 自动 OpenAPI + HiAgent/Dify 扩展字段
└── agent_runtimes/
    ├── _base.py               ← AgentRuntime Protocol
    ├── openclaw.py            ← Service Token + MCP
    ├── hiagent.py             ← API Key + 火山引擎插件 schema
    ├── dify.py                ← Plugin Manifest YAML
    ├── coze.py
    └── custom.py              ← 客户定制
```

**支持多 Agent 并存**：一线员工用 OpenClaw、高管用 HiAgent、开发用 Cursor MCP，**全部调同一套 Foundry**。

**切换成本**：客户从 OpenClaw 换到 HiAgent，仅需在 Studio 点 "导出 HiAgent 插件" → HiAgent 导入 → 切换飞书 Bot 后端，**业务无感知，Ontology 不变**。

详见 `USER-ENVIRONMENT-DELIVERY-VALIDATION.md §三`。

---

## 七、Pipeline = 数据 → Object 转换

### 7.1 Pipeline 的统一定义

```yaml
# pipelines/opcua_to_readings.yaml
pipeline:
  name: opcua_to_equipment_readings
  description: OPC-UA 实时数据流转为 EquipmentReading Object

  source:
    type: redis_stream
    stream_key: "opcua:S001:*"

  transformations:
    - normalize_timestamps: ts → utc_iso
    - filter_invalid_readings: drop if value is null or out of range
    - enrich:
        equipment_id: from_node_map
        unit: from_metadata
    - emit_events:
        if vibration > Equipment.threshold_alarm:
          create: Alarm Object

  destination:
    object_type: EquipmentReading
    insert_strategy: append # 时序追加

  schedule: realtime

  lineage:
    upstream: [opcua-bridge]
    downstream: [Equipment.computed.health_score, Alarm Pipeline]
```

```yaml
# pipelines/knowledge_ingest.yaml
pipeline:
  name: kb_document_ingest
  description: PDF 文档 → KBDocument Object（向量化）

  source:
    type: action
    triggered_by: IngestKBDocument Action

  transformations:
    - extract_text: pymupdf
    - chunk: llamaindex.SentenceSplitter
    - embed: bge-m3
    - persist:
        - KBDocument Object（meta）
        - kb_embeddings 表（vectors）

  destination:
    object_type: KBDocument

  lineage:
    upstream: [user_upload]
    downstream: [SearchKnowledge Function]
```

```yaml
# pipelines/workorder_to_l3_knowledge.yaml
pipeline:
  name: knowledge_flywheel
  description: 已完成工单沉淀为 L3 知识（Phase A：模板渲染，Phase B：LLM 增强）

  source:
    type: scheduled
    cron: "0 3 * * *"
    query: SELECT * FROM workorders WHERE status='done' AND completed_at > now() - 1d

  transformations:
    - validate: execution_notes IS NOT NULL AND len > 80
    - validate: evidence_urls IS NOT NULL
    - render: workorder_to_l3_template.j2
    - embed: bge-m3

  destination:
    object_type: KBDocument
    create_with:
      layer: L3
      status: pending_review
      source_workorder_id: from_input

  lineage:
    upstream: [WorkOrder]
    downstream: [SearchKnowledge Function]
```

### 7.2 Pipeline 的核心特征

```
1. 声明式：写 YAML，不写 ETL 代码
2. 自动 Lineage：每个 Object 知道自己来自哪个 Pipeline
3. Schedule + Trigger：realtime / scheduled / event-triggered / action-triggered
4. 可观测：每次 run 都有 run_id，可查看历史
5. 失败重试：内置策略
```

### 7.3 IMS Connector Suite（v1.1 新增 · 客户已有系统接入工程化）

**问题**：客户 IMS 多种多样（SAP / Oracle / 用友 / Maximo / OSIsoft PI / 自研 REST / Excel）。每个客户写一次性脚本会爆炸。

**方案**：标准 Connector 包结构 + 配置驱动 + 写回支持。

```
connectors/
├── erp/
│   ├── sap_s4hana/             # SAP S/4HANA
│   ├── sap_pm/                 # SAP PM 模块
│   ├── oracle_eam/             # Oracle EAM
│   ├── yonyou_u8/              # 用友 U8
│   └── kingdee_cloud/          # 金蝶云
├── cmms/
│   ├── ibm_maximo/
│   ├── infor_eam/
│   └── mainsaver/
├── historian/
│   ├── osisoft_pi/
│   ├── inmation/
│   └── honeywell_phd/
├── scada_dcs/
│   ├── opcua_generic/          # asyncua 标准
│   ├── modbus_tcp/
│   └── iec104/
├── hse/
└── generic/
    ├── rest_api/               # 通用 REST 拉/推
    ├── soap/
    ├── csv_sftp/               # 定时拉 Excel/CSV
    ├── webhook_inbound/
    └── jdbc_query/
```

**每个 Connector 包**：

- `connector.yaml`（声明式配置 + field_mapping + write_back）
- `field_mapping_template.yaml`（客户调整模板）
- `transformer.py`（特殊转换逻辑，可选）
- `README.md`（部署指南、字段对照表）
- `tests/`（mock 数据 + 集成测试）

**Connector YAML 完整示例**：见 `USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四.2`。

**核心特性**：

- **声明式**：`connector.yaml` 描述 source/auth/schedule/field_mapping/destination/write_back
- **写回支持**：`write_back.on_actions` 列出哪些 Action 触发反向写 IMS
- **冲突解决**：与 Object Type 的 `source_of_truth_strategy` 联动
- **探针工具**：`clawtwin connector probe --target=<url>` 售前用，自动识别客户 IMS 拓扑
- **可视化映射**：Studio Workshop App "Field Mapping Editor"（左 IMS 字段，右 Foundry 属性）

**实施流程（4 阶段，5-7 天）**：

1. 探针 Discovery（1 天）
2. 选 Connector + 配置映射（2-3 天）
3. 试运行 + 数据校验（2 天）
4. 上线 + 启用 write_back（1 天）

**奇葩 IMS 兜底**：用 `generic/rest_api` + 自定义 `transformer.py`，1 周内为客户写完，**仍按 Connector 包格式提交，沉淀为新模板**。

---

## 八、目录结构（最终版）

```
platform-api/
├── ontology/                  # ★ 平台核心：本体定义（YAML/Python）
│   ├── object_types/          # Equipment.yaml / Alarm.yaml / WorkOrder.yaml ...
│   ├── action_types/          # AcknowledgeAlarm.yaml / CreateWorkOrder.yaml ...
│   ├── function_types/        # DiagnoseEquipment.yaml / ComputeHealthScore.yaml ...
│   ├── link_types/            # （在 object_type 里内联，独立目录可选）
│   ├── markings/              # station_marking.yaml ...
│   └── loader.py              # 启动时加载所有 YAML → 构建 Ontology 实例
│
├── core/                      # 业务核心实现（Ontology 驱动）
│   ├── object_store/          # Object 持久化抽象（按 type 路由到 SQLAlchemy）
│   │   ├── base.py            # ObjectStore.get/search/save/delete
│   │   └── postgres.py        # SQLAlchemy 实现
│   ├── action_executor/       # ★ Action Type 执行器（替代 @tool 装饰器）
│   │   ├── executor.py        # ActionExecutor.execute(action_name, params, actor, transport)
│   │   ├── validators.py      # YAML rule → Python 校验
│   │   ├── effects.py         # YAML effect → SQL 变更
│   │   └── side_effects.py    # 事件 / 通知
│   ├── function_executor/     # ★ Function Type 执行器
│   │   ├── executor.py        # FunctionExecutor.call(fn_name, params)
│   │   ├── ai_runner.py       # 委派给 OpenClaw
│   │   ├── python_runner.py   # 调本地 Python
│   │   └── sql_runner.py      # 调 SQL
│   ├── pipeline_runner/       # ★ Pipeline 执行
│   │   ├── runner.py          # 统一执行器
│   │   ├── transformations/   # 各种 transformation 实现
│   │   └── triggers.py        # cron / event / action
│   └── domain_logic/          # 跨 Action 的复杂业务规则（FSM 实现等）
│       ├── alarm_fsm.py
│       └── workorder_fsm.py
│
├── apps/                      # ★ Apps Layer（之前叫 channels，更名）
│   ├── http/                  # FastAPI HTTP Server（自动从 Ontology 生成路由）
│   │   ├── ontology_router.py # /v1/objects/* / /v1/actions/* / /v1/functions/*
│   │   └── studio_router.py   # /v1/studio/layouts/* 等 Studio-specific 端点
│   ├── feishu/                # 飞书卡片回调
│   └── cli/                   # clawtwin CLI（自动从 Ontology 生成命令）
│
├── aip/                       # ★ AI Platform（多 Agent 平台支持）
│   ├── mcp_server.py          # 自动从 Ontology 生成 MCP tools
│   ├── openapi_exporter.py    # 自动生成 OpenAPI Spec（HiAgent/Dify 等）
│   ├── agent_connector.py     # OpenClaw 调用抽象（用于 ai_function 委派）
│   ├── agent_runtimes/        # ★ v1.1：多 Agent 平台适配
│   │   ├── _base.py           # AgentRuntime Protocol
│   │   ├── openclaw.py        # MCP + Service Token
│   │   ├── hiagent.py         # OpenAPI + API Key + 火山扩展
│   │   ├── dify.py            # Plugin Manifest
│   │   └── coze.py
│   ├── llm_trace.py           # 推理追溯
│   ├── eval_runner.py         # 准确率评估
│   └── prompt_registry.py     # System prompts 管理
│
├── connectors/                # ★ v1.1：IMS Connector 包
│   ├── erp/{sap_pm, sap_s4hana, oracle_eam, yonyou_nc, kingdee_cloud}/
│   ├── cmms/{ibm_maximo, infor_eam, mainsaver}/
│   ├── historian/{osisoft_pi, inmation, honeywell_phd}/
│   ├── scada_dcs/{opcua_generic, modbus_tcp, iec104}/
│   ├── hse/
│   └── generic/{rest_api, soap, csv_sftp, webhook_inbound, jdbc_query}/
│   每个包含：connector.yaml / field_mapping.yaml / transformer.py? / README / tests
│
├── providers/                 # 可插拔基础能力
│   ├── llm.py                 # vLLM / 通义 / 文心 / Claude / DeepSeek
│   ├── embedder.py            # bge-m3 / OpenAI 兼容
│   └── notifier.py            # lark-oapi / 钉钉 / 邮件
│
├── infra/                     # 横切基础设施
│   ├── auth/
│   │   ├── jwt.py             # JWT 生成与验证
│   │   ├── marking.py         # Marking Enforcement
│   │   ├── feishu_bridge.py   # ★ v1.1：飞书 OAuth + 部门→station_ids 映射
│   │   └── ad_bridge.py       # ★ v1.1：客户 AD/LDAP 集成（可选）
│   ├── approval.py            # ApprovalQueue（统一审批）
│   ├── audit.py               # audit_logs 写入
│   ├── tracing.py             # llm_traces 写入
│   ├── lineage.py             # 数据血缘记录
│   ├── conflict_resolver.py   # ★ v1.1：SoT 冲突自动解决
│   └── settings.py            # 环境配置（含部署形态：private | vpc | saas）
│
└── workers/                   # 后台
    ├── scheduler.py           # APScheduler 定时任务
    ├── pipeline_worker.py     # Pipeline 执行 worker
    └── streams.py             # Redis Streams 消费

# 一级目录从 5 个变为 7 个，但每个职责清晰：
# ontology / core / apps / aip / providers / infra / workers
```

---

## 九、与之前设计的对应关系（不要全部重写）

> **重要**：之前 4 轮审查的设计**大部分仍然有效**，只是要正确"上位"到 Ontology Layer。

### 9.1 我之前的 @tool 装饰器 → 现在是什么

**之前（ARCHITECTURE-PRUNING-2026 §3）**：

```python
@tool(name="acknowledge_alarm", risk="low", requires_role=[...])
async def acknowledge_alarm(input, actor): ...
```

**现在**：可以保留作为**实现 Action Type 的语法糖**：

```python
# ontology/action_types/acknowledge_alarm.yaml 是声明
# core/action_executor/handlers/acknowledge_alarm.py 是实现：

@implements_action("AcknowledgeAlarm")
async def handle_acknowledge_alarm(ctx: ActionContext) -> ActionResult:
    # ctx 包含 parameters / actor / target_objects
    alarm = ctx.parameters.alarm                  # 已自动解析为 Alarm Object
    alarm.acknowledged_at = ctx.now
    alarm.acknowledged_by = ctx.actor.id
    if ctx.parameters.reason:
        alarm.ack_reason = ctx.parameters.reason
    return ActionResult.ok(updated=[alarm])
```

**Action Type YAML 提供的好处**：

- Validators / Effects / Side Effects 是**声明式**的（不是 Python 代码）
- 框架自动校验、执行、写 audit/trace/lineage
- Studio 可以自动生成审批表单（从 parameters）
- MCP 自动暴露
- 数据血缘自动建立

### 9.2 之前的 5 层目录 → 现在是 7 层

```
之前（ARCHITECTURE-PRUNING-2026）：
  core / channels / providers / infra / workers

现在（INDUSTRIAL-FOUNDRY）：
  ontology / core / apps / aip / providers / infra / workers
                    ▲ channels → apps（Foundry 术语）
                    ▲ 新增 ontology（最重要的核心层）
                    ▲ 新增 aip（AI Platform 独立成层）
```

**理由**：Ontology 是核心抽象，必须独立成层。AIP 是 Ontology 之上的能力层，也应独立。

### 9.3 之前的 Channel → 现在是 Apps

Foundry 术语：**Apps** 是用户界面/接入层。HTTPChannel = HTTP Channel App = Studio 后端 + 任意 HTTP 客户端。

### 9.4 之前的 Tool 框架 → 现在是 Ontology Generator

```
之前：手写 30+ 个 @tool
现在：写 30+ 个 Action Type YAML + Function Type YAML
       MCP Server / HTTP Router / CLI 自动从 Ontology 生成
       Studio 也自动从 Ontology 生成 UI（70%）
```

**收益**：声明式 > 命令式，新增 Object Type 不用改任何代码生成器。

---

## 十、未来工业场景的扩展性证明

### 10.1 新增设备类型（30 秒）

```yaml
# 客户来了：要管理"高压阀门 V-100"
# 步骤 1：在 Equipment Object Type 的 enum 加值
type:
  values: [..., high_pressure_valve_dn250]    # 新增

# 步骤 2：导入设备数据
clawtwin object import V-100.csv

# 完成。Studio / MCP / CLI / 飞书 全部自动支持新设备。
```

### 10.2 新增工单类型（5 分钟）

```yaml
# 客户要：紧急停车工单
# 步骤 1：在 WorkOrder Object Type 的 type enum 加值
type:
  values: [..., emergency_shutdown]

# 步骤 2：增加专用 Action Type
# ontology/action_types/initiate_emergency_shutdown.yaml
action_type:
  api_name: InitiateEmergencyShutdown
  parameters:
    equipment: ObjectReference[Equipment]
    reason: string
  validators:
    - actor.role == "shift_manager"
  effects:
    - update equipment: status="emergency_shutdown_pending"
    - create WorkOrder:
        type: emergency_shutdown
        priority: P1
        equipment_id: equipment.id
  safety:
    risk_level: high
  approval:
    required: true
    approver_roles: [station_manager]

# 完成。Studio / MCP / Sage 全部自动支持。
```

### 10.3 新增 AI 能力（10 分钟）

```yaml
# 客户要：腐蚀速率预测
# ontology/function_types/predict_corrosion_rate.yaml
function_type:
  api_name: PredictCorrosionRate
  parameters:
    pipe: ObjectReference[Pipe]
    horizon_days: integer
  output:
    type: object
    schema: { rate_mmpy: number, eol_estimate: timestamp, confidence: number }
  implementation:
    type: python_function
    module: aip.functions.corrosion
    function: predict
  cache:
    ttl: 24h

# 完成。LLM / Studio 自动可调用。
```

### 10.4 新增数据源（1 天）

```yaml
# 客户要：从 SAP PM 模块抽工单
# pipelines/sap_pm_to_workorder.yaml
pipeline:
  name: sap_pm_workorder_sync
  source:
    type: sap_rest
    endpoint: ${SAP_PM_API}
    auth: ${SAP_AUTH}
  schedule: "*/15 * * * *"
  transformations:
    - map_fields: sap_workorder → WorkOrder schema
    - dedupe: by sap_id
  destination:
    object_type: WorkOrder
    upsert_key: external_sap_id

# 完成。SAP 工单自动同步到 Ontology。
```

### 10.5 新增 Channel / App（1-2 天）

```python
# 客户要：手持终端 App
# apps/handheld/main.py 实现 HandheldApp
# 它通过 ObjectStore + ActionExecutor + FunctionExecutor 工作
# 不需要改 Ontology，不需要改 core
```

---

## 十一、关键铁律（v1.1 增至 34 条）

```
【铁律 25】所有业务实体必须先定义为 Object Type（ontology/object_types/*.yaml）
  禁止：在 SQLAlchemy 模型里直接加业务实体（必须先有 Object Type 定义）
  禁止：在 router 里直接处理业务逻辑（必须经 ObjectStore / ActionExecutor）

【铁律 26】所有写操作必须定义为 Action Type
  Action Type 是声明式：YAML 定义 parameters/validators/effects/side_effects/safety/approval
  框架自动处理：MCP 暴露 / HTTP 端点 / CLI 命令 / Studio 表单 / Audit / Trace / Lineage
  禁止：直接写 SQLAlchemy session.commit() 修改业务对象（必须经 ActionExecutor）

【铁律 27】所有 AI 推理 / 复杂查询定义为 Function Type
  Function Type 三种实现：ai_function (调 OpenClaw) | python_function | sql_function
  AI 推理结果自动 cache（按 ttl）
  禁止：业务代码直接调 LLM（必须经 Function Executor）

【铁律 28】所有外部数据接入必须定义为 Pipeline
  Pipeline 是声明式：source / transformations / destination / schedule / lineage
  Pipeline 自动建立数据血缘
  禁止：在 worker 里写 ad-hoc 数据导入脚本（必须为 Pipeline）

【铁律 29】Studio 优先用 Ontology 自动生成 UI
  自动生成：Object 列表 / Object 详情 / Action 表单 / Function 调用面板
  自定义页面（Mission Control / Twin View / Morning Briefing）只用于复杂场景
  自定义页面仍然调用 Ontology API（不绕过）

【铁律 30】AgentRuntime 必须抽象，不写死任何 Agent 平台
  支持 OpenClaw / HiAgent / Dify / Coze 等任意平台
  Foundry 暴露 MCP + OpenAPI 双协议；AgentRuntime 适配器各自处理鉴权与流式
  禁止：在 ActionExecutor / FunctionExecutor 里区分 Agent 平台
  禁止：硬编码 OpenClaw / HiAgent 的特殊行为
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §三 + INDUSTRIAL-FOUNDRY §六.4

【铁律 31】IMS 接入必须用 Connector 抽象（声明式 YAML + 标准包结构）
  禁止：为某客户 IMS 写一次性脚本（必须沉淀为 Connector 包）
  禁止：在 Foundry 业务代码里 import sap_sdk / oracle_sdk
  奇葩 IMS 用 generic/rest_api + 自定义 transformer.py，仍按 Connector 包格式提交
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四 + INDUSTRIAL-FOUNDRY §七.3

【铁律 32】每个 Object Type 必须明确 Source-of-Truth 策略
  options: foundry | external | hybrid
  external 时 Action 自动双向同步（先写 IMS 再写 Foundry，失败回滚）
  hybrid 时按 field_ownership 字段级控制
  Action.execute() 框架自动处理，业务 handler 不感知 SoT 复杂度
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四.4 + INDUSTRIAL-FOUNDRY §四.1.5

【铁律 33】飞书是出网通道，不是数据源
  飞书消息直进 AgentRuntime（不进 Foundry）
  飞书卡片回调进 Foundry Apps Layer（处理 Action）
  飞书企业身份通过 SSO + Feishu Bridge → Foundry Marking
  禁止：在 Foundry 维护独立的飞书消息历史（飞书自己已存）
  禁止：开发 ClawTwin Mobile 独立 App（用飞书小程序+卡片替代）
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §五

【铁律 34】客户内网私有化是默认部署形态
  飞书是唯一允许出网的服务（wss + 签名验证）
  OT 区单向输出到 IT（OPC-UA Bridge 在 DMZ）
  IMS 与 Foundry 同网络段，加密直连
  SaaS 形态仅适用于 PoC 或低敏感数据客户
  禁止：未经客户书面同意时把 OT/工艺数据上公网
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §六
```

---

## 十二、核心架构图（终版）

```
                       ┌──────────────────────────────────────┐
                       │  Apps Layer（Foundry Workshop 风格）  │
                       │                                      │
   Studio Web ────────►│  · 70% Object 视图自动生成           │
   Feishu Bot ────────►│  · 30% 自定义页面（Mission Control）  │
   clawtwin CLI ──────►│  · Industry Dashboards（Grafana）    │
   Mobile (B+) ───────►│  · Future: Kiosk / Handheld          │
                       └────────────────┬─────────────────────┘
                                        │
                       ┌────────────────┴─────────────────────┐
                       │       AIP（Industrial AI Layer）      │
                       │                                      │
   LLM 用户对话 ───────►│  OpenClaw Agent Runtime               │
                       │  ↓                                    │
                       │  MCP Server                          │
                       │  · 自动暴露 Object/Action/Function    │
                       │  ↓                                    │
                       │  Sage Skills（prompt + 行业经验）     │
                       │  LLM Trace + Eval                    │
                       │  Provider 抽象（vLLM/通义/文心）      │
                       └────────────────┬─────────────────────┘
                                        │
                                        ▼ ★ 调用一切都经过 Ontology
                       ┌──────────────────────────────────────┐
                       │  ★ Industrial Ontology（核心）        │
                       │                                      │
                       │  Object Types  · Link Types          │
                       │  Action Types  · Function Types      │
                       │  Markings（权限）                     │
                       │                                      │
                       │  Loader / Schema Validator           │
                       └────────────────┬─────────────────────┘
                                        │
                                        ▼
                       ┌──────────────────────────────────────┐
                       │  Core 实现层（Ontology 驱动）         │
                       │                                      │
                       │  ObjectStore（CRUD / 查询）           │
                       │  ActionExecutor（声明式执行写操作）   │
                       │  FunctionExecutor（计算/AI 推理）     │
                       │  PipelineRunner（数据 → Object）      │
                       │  DomainLogic（FSM / 复杂规则）        │
                       └────────────────┬─────────────────────┘
                                        │
                                        ▼
                       ┌──────────────────────────────────────┐
                       │  Pipeline Layer（数据 → Object）      │
                       │                                      │
   OPC-UA Bridge ─────►│  opcua_to_readings.yaml              │
   IMS REST ──────────►│  ims_workorder_sync.yaml             │
   PDF Upload ────────►│  knowledge_ingest.yaml               │
   Already-Done WO ───►│  workorder_to_l3_knowledge.yaml      │
                       │  ML Pipeline (B+)                    │
                       └────────────────┬─────────────────────┘
                                        │
                                        ▼
                       ┌──────────────────────────────────────┐
                       │  Foundation（Storage）                │
                       │                                      │
                       │  PostgreSQL（含 TimescaleDB+pgvector）│
                       │  Redis（Shadow + Cache + Streams）    │
                       │  Object Storage (B+)                  │
                       └──────────────────────────────────────┘

★ 横切关注（infra/）：
   Auth + Marking Enforcement | Approval Queue | Audit | LLM Trace | Lineage
```

---

## 十三、与既有文档的关系

| 文档                                             | 状态                               | 调整                                                                                                    |
| ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **INDUSTRIAL-FOUNDRY-ARCHITECTURE.md（本文档）** | **最高权威**，所有架构疑问以此为准 | —                                                                                                       |
| ARCHITECTURE-PRUNING-2026.md                     | 仍然有效                           | @tool 装饰器现在是 Action Type 的实现语法之一；Channel 改称 App                                         |
| CORE-ARCHITECTURE-AUDIT-2026.md                  | 仍然有效                           | LLM Trace + Approval Queue 不变                                                                         |
| ARCHITECTURE-FINAL-CRITICAL-AUDIT.md             | 不变                               | LlamaIndex / Grafana 嵌入 / 成熟库清单                                                                  |
| ARCHITECTURE-SIMPLIFICATION-AUDIT.md             | 不变                               | 4 服务技术栈                                                                                            |
| MODULE-DESIGN-PLATFORM.md                        | **需修正**                         | §一 项目结构改为本文档 §八；新增 ontology 章节                                                          |
| DEVELOPMENT-CONTRACT.md                          | **需修正**                         | 新增铁律 25-29                                                                                          |
| CURSOR-MULTITASK-GUIDE.md                        | **需修正**                         | 新增 [T0.5] Ontology Loader / [T2.5] 改为 Action/Function Executor / 新增 [T2.6] MCP/HTTP/CLI Generator |
| clawtwin-project/SKILL.md                        | **需修正**                         | 加铁律 25-29                                                                                            |

---

## 十四、Phase A 修正后的关键里程碑

```
Week 1（基础）
  M0.5  Ontology Loader：能从 YAML 加载 Object/Action/Function 定义
  M1    数据库 Schema（Equipment / Alarm / WorkOrder 等 ObjectStore 后端表）

Week 2（核心执行器）
  M1.5  ActionExecutor + FunctionExecutor + 自动 audit/trace/lineage
        (这是之前 [T2.5] Tool 框架的升级版)

Week 3（自动暴露）
  M1.7  HTTP / MCP / CLI 自动从 Ontology 生成入口

Week 4-5（Pipeline + 数据接入）
  M2    OPC-UA Pipeline（Mock）+ Knowledge Ingest Pipeline

Week 5-6（Object 业务）
  M3    Equipment + Alarm + WorkOrder Object + 各自 Action Types
  M3.5  KB Function（SearchKnowledge / DiagnoseEquipment）

Week 7-9（Studio）
  M4    Studio Auto-generated UI（70% 页面）
  M5    Studio Custom Pages（Twin View / Mission Control）

Week 10（AIP）
  M5.5  Sage Skills + Feishu Bot 联调

Week 11-12（验收）
  M6    完整 Demo + Phase A 交付
```

---

## 十五、决议

> **从今天起，ClawTwin 的设计哲学是 Industrial Foundry：**
>
> 1. **Ontology 是核心**——Object / Link / Action / Function 是 platform 一等公民
> 2. **声明式 > 命令式**——业务通过 YAML 定义，框架运行时执行
> 3. **AI 是 Ontology 之上的层**——AIP 暴露 Ontology，不绕过
> 4. **Apps 是 Ontology 的视图**——70% 自动生成，30% 自定义
> 5. **Pipeline 把数据变成 Object**——所有外部数据接入统一抽象
> 6. **Markings 控制权限**——多租户 / 多场站 / 多部门 / 多分区
> 7. **Lineage 追溯一切**——数据血缘 + LLM Trace + Audit Log
>
> **以下被废弃：**
>
> - ❌ "ClawTwin 是 Agent 系统"的定位
> - ❌ "Studio 是独立产品"（Studio 是 Workshop 风格的 Foundry App）
> - ❌ "用 OpenClaw 风格写 30 个 @tool"（除非作为 Action 实现的语法糖）
>
> **以下保留：**
>
> - ✅ 铁律 19（Platform 不直调 vLLM chat）
> - ✅ 铁律 20（RAG 用 LlamaIndex）
> - ✅ 铁律 22（必写 Trace）
> - ✅ Provider 抽象（LLM/Embed/Notifier 可插拔）
> - ✅ 4 服务 Phase A 技术栈

---

## 十六、业务控制面与编排（补充权威）

> **Playbook / Trigger / Policy / InvocationContext** 及「智能体 = 能力平面」的细化模型见 **`PLATFORM-BUSINESS-CONTROL-PLANE.md`**（与本文同仓 `contrib/industrial-oilgas-skills/`）。  
> 本文 §十二 总图不变；补充文档用于模块化落地与 Palantir 式**企业业务平台**叙事对齐。

---

_这是 ClawTwin 项目的最终核心架构文档。后续所有设计/开发/审查必须以此为基准。_  
_工业孪生不是工业 Agent——它是工业 Foundry。让数据先说话，让对象先存在，让 AI 来增强。_
