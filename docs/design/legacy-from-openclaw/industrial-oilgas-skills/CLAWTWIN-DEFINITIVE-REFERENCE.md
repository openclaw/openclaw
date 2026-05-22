# ClawTwin 决策性架构参考

**地位**: 🟢 核心 / 最终权威参考  
**版本**: v3.0.0 (2026-05-13)  
**关键升级**: 通用 AI 平台重新定位；Palantir 4 产品精确映射；模块拆分合理性论证  
**配套**: `CLAWTWIN-PRODUCT-VISION.md`（产品家族）· `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（API 协议）· `CLAWTWIN-ARCHITECTURE-SYSTEMATIC.md`（**纯文字**多产品与模块全集系统化读本）

---

## 一、产品本质（重新定位）

> **ClawTwin 是通用运营 AI 平台（General Operational AI Platform）**：提供 Ontology 驱动的语义层、AI 函数执行层和业务编排层，场景通过 Pack（扩展包）加载——核心与场景分离，天然支持多行业。

**核心与场景分离原则**：

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ClawTwin Platform (通用核心)                      │
│  Ontology Engine  ·  ObjectStore  ·  EventBus  ·  PlaybookEngine    │
│  FunctionExecutor ·  ConnectorFramework  ·  MCP Server              │
│  ReliabilityStack (Doctor/Health/Outbox/ReloadPlan)                  │
└─────────────────────────────────────────────────────────────────────┘
         ↑  Pack 加载（零修改核心）
┌──────────┬──────────────┬──────────────┬──────────────┐
│ oilgas/  │manufacturing/│ healthcare/  │   logistics/ │ … 任意行业
└──────────┴──────────────┴──────────────┴──────────────┘
```

**这意味着**：

- 没有加载任何 Pack → 平台可运行（headless 最小核）
- 加载 `oilgas/` Pack → 变成石油天然气运营平台
- 加载 `manufacturing/` Pack → 变成制造业智能平台
- 同时加载多个 Pack → 综合运营平台

---

## 二、Palantir 四产品精确映射

Palantir 的历史演进：Gotham（2010，政府情报）→ Foundry（2016，企业数据）→ AIP（2023，AI 层）→ Apollo（贯穿，部署运维）

### 2.1 映射矩阵

| Palantir 产品 | 核心概念                                   | ClawTwin 对应                                            | 覆盖度                  |
| ------------- | ------------------------------------------ | -------------------------------------------------------- | ----------------------- |
| **Gotham**    | 连接异构数据 + 知识图谱 + 模式发现（情报） | **Ontology + ObjectStore + causal_graph**（概念基因）    | 概念继承，不做情报/安全 |
| **Foundry**   | 语义数据层 + 管道 + 对象存储 + 应用构建    | **`core/` + `ontology/` + `infra/`**（平台核心）         | ✅ 高度覆盖             |
| **AIP**       | LLM + Foundry 数据 + AI 行动 + 编排工作流  | **`aip/` + FunctionExecutor + PlaybookEngine**（智能层） | ✅ 高度覆盖             |
| **Apollo**    | 多云/边缘部署管理 + 持续交付               | **Doctor + Health + CLI + Ops 端点**（轻量内嵌）         | ⚠️ 轻量版（M6 增强）    |

### 2.2 Palantir 内部模块 vs ClawTwin 精确对照

```
Palantir Foundry 模块                 ClawTwin 对应
─────────────────────────────────────────────────────────────────
Ontology（本体定义）         ↔   ontology/*.yaml（YAML 声明式本体）
Object Store（对象持久化）   ↔   core/object_store/ (Postgres)
Pipeline Builder（数据管道） ↔   core/pipeline_runner.py
Data Connection（数据源连接）↔   core/connector_declarative.py + workers/opcua_collector.py
Code Repository（代码函数）  ↔   ontology/function_types/*.yaml + handlers/
Permissions/Marking（权限）  ↔   infra/marking.py + infra/auth/
Lineage/Audit（血缘追溯）    ↔   infra/lineage.py + infra/audit.py
Workshop（无代码 App）        ↔   ClawTwin Studio（简化版）
Slate（仪表盘）               ↔   ClawTwin Studio Dashboard

Palantir AIP 模块                     ClawTwin 对应
─────────────────────────────────────────────────────────────────
AIP Logic（LLM 工作流引擎）  ↔   core/playbook_engine/ (YAML 声明式)
AIP Assist（对话 AI）        ↔   OpenClaw（独立产品，通过 MCP 集成）
Quests（引导式工作流）        ↔   Playbook + HITL approve/reject
AIP Studio（AI App 构建）    ↔   aip/ + ClawTwin Studio

Palantir Apollo 模块                  ClawTwin 对应
─────────────────────────────────────────────────────────────────
健康监控                     ↔   infra/health/ + /v1/health/dimensions
自检修复                     ↔   infra/doctor/ + /v1/doctor/run
配置热重载                   ↔   infra/settings.ReloadPlan + /v1/admin/reload-config
多环境部署                   ↔   Docker Compose + Helm（M6 完善）
```

### 2.3 ClawTwin 超越 Palantir 的维度

| 维度                | Palantir         | ClawTwin                                    |
| ------------------- | ---------------- | ------------------------------------------- |
| **知识飞轮**        | 无闭环学习回路   | ✅ OutcomeEvent → CBR → 推荐 → 干预 → 标签  |
| **AI 函数一等公民** | AIP 是 2023 后加 | ✅ FunctionType Day 1 设计进本体            |
| **边缘/单机部署**   | 依赖数据中心     | ✅ 单机 Docker，断网工厂可用                |
| **入站事件去重**    | 依赖外部幂等     | ✅ TTL-LRU 内建                             |
| **Pack 模块化**     | 专有 SDK，不开放 | ✅ Python Protocol + YAML，任何开发者可扩展 |
| **AI 用量审计**     | 内部黑箱         | ✅ DB 持久化，可查可计费                    |

---

## 三、三产品家族（Product Family）

```
┌─────────────────────────────────────────────────────────────────────┐
│  OpenClaw                                                           │
│  对话 AI 智能体（= Palantir AIP Assist）                             │
│  · 自然语言理解 · 长对话 · 任务规划                                   │
│  · 调用 ClawTwin MCP Server 获取业务上下文                           │
└──────────────────────────┬──────────────────────────────────────────┘
                     MCP / AgentRuntime（双向）
┌──────────────────────────▼──────────────────────────────────────────┐
│  ClawTwin Platform        (= Palantir Foundry + AIP 合并)           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Foundry 层（core/）                                          │   │
│  │  Ontology · ObjectStore · ActionExecutor · FunctionExecutor │   │
│  │  ConnectorFramework · PipelineRunner · PackLoader           │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │  AIP 层（aip/）                                               │   │
│  │  PlaybookEngine · AgentRuntime · MCPServer                  │   │
│  │  PromptRegistry · EvalRunner · OpenAPIExporter              │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │  Platform Infra（infra/）                                    │   │
│  │  EventDispatcher · Outbox · Settings · Doctor · Health      │   │
│  │  Auth · Audit · Lineage · Hooks · RateLimit                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  面向开发者：REST API / MCP / SSE / CLI                              │
└──────────────────────────┬──────────────────────────────────────────┘
                     REST / SSE / WebSocket
┌──────────────────────────▼──────────────────────────────────────────┐
│  ClawTwin Studio          (= Palantir Workshop + Slate)             │
│  · Object Browser · Playbook Editor · HITL Approval                │
│  · Alarm Timeline · OutcomeEvent Dashboard                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、模块拆分合理性论证

### 4.1 当前结构评分

```
platform-api/
  apps/      ← 接触层（HTTP / CLI / Feishu）              ✅ 独立部署单元，无业务逻辑
  aip/       ← AI 智能层（= Palantir AIP 模块）            ✅ 清晰边界
  core/      ← 平台核心（= Palantir Foundry Core）         ✅ 清晰边界
  infra/     ← 横切关注点（DB/Events/Ops）                ✅ 不对外暴露
  workers/   ← 后台处理（Scheduler/Outbox/OpcUA）         ✅ 独立进程单元
  ontology/  ← Schema 声明（YAML）                        ✅ 纯静态声明
  packs/     ← 场景扩展包                                 ✅ 完全隔离
```

### 4.2 通用性审计结论

**`ontology/object_types/` 中的 4 个默认类型是"运营领域通用原语"**，不是工业特有的：

| 默认类型    | 工业用途  | 制造业    | 医疗      | IT运营   | 物流      |
| ----------- | --------- | --------- | --------- | -------- | --------- |
| `Equipment` | 泵/压缩机 | 机床/AGV  | 医疗设备  | 服务器   | 车辆      |
| `Alarm`     | 工艺告警  | 质量异常  | 临床告警  | 系统告警 | 延误告警  |
| `WorkOrder` | 维护工单  | 生产工单  | 护理任务  | IT 工单  | 调度单    |
| `Station`   | 场站      | 产线/工厂 | 科室/病区 | 机房     | 仓库/站点 |

**结论**：这 4 个类型足够通用，作为核心默认类型是合理的。其 `description` 字段中的工业语言是示例，不是约束。

**`core/domain_logic/` 模块的通用性分类**：

| 模块                       | 是否通用    | 说明                                        |
| -------------------------- | ----------- | ------------------------------------------- |
| `recommendation_engine.py` | ✅ 完全通用 | 纯 CBR 算法，无行业假设                     |
| `causal_graph.py`          | ✅ 完全通用 | 纯有向图遍历算法                            |
| `alarm_fsm.py`             | ⚠️ 轻度行业 | ISA-18.2 状态机，但"告警生命周期"是通用概念 |
| `alarm_rule_eval.py`       | ⚠️ 轻度行业 | 规则引擎，但可被 Pack override              |
| `workorder_fsm.py`         | ✅ 通用     | 工单状态机，任何运营系统通用                |
| `twin_correspondence.py`   | ⚠️ 轻度行业 | 数字孪生对应，实例→物理实体映射，可泛化     |

**处理方式**：`alarm_fsm.py` 中的 ISA-18.2 注释应改为"通用告警生命周期（可被 Pack 实现 override）"；算法本身不需要移动。

### 4.3 唯一需要修正的边界问题

`ontology/function_types/diagnose_equipment.yaml` 是**工业特有的** FunctionType，应该在 `packs/oilgas/` 里，而不是核心 `ontology/`。这是当前唯一违反"核心通用"原则的地方。

---

## 五、核心 vs Pack 的完整边界定义

```
核心（core + ontology + aip + infra）应该包含：
  ✅ 通用算法：CBR / 因果图 / FSM 框架
  ✅ 通用协议：ObjectStore Protocol / ActionType Protocol / FunctionType Protocol
  ✅ 通用原语：Equipment / Alarm / WorkOrder / Station（运营领域最小集）
  ✅ 通用机制：Playbook YAML / Connector Protocol / Pack 加载 / EventBus
  ✅ 通用运维：Doctor / Health / Outbox / Reload / CLI

Pack（packs/<id>/）应该包含：
  ✅ 行业特有 ObjectType：泵、压缩机、管线、病床、AGV...
  ✅ 行业特有 ActionType：紧急关阀、启备泵、发起审批...
  ✅ 行业特有 FunctionType：油气振动诊断、质量缺陷分析...
  ✅ 行业特有 Playbook：气液分离器异常处理、设备计划性维护...
  ✅ 行业特有 Connector：OPC-UA 标签映射、SAP-PM REST 适配...
  ✅ 行业特有算法：工艺参数范围校验、ISO 标准预测模型...

当前违反此边界的唯一文件：
  ❌ ontology/function_types/diagnose_equipment.yaml → 应移至 packs/oilgas/
```

---

## 六、OpenClaw ↔ ClawTwin 资源边界（定稿）

### 6.1 资源所有权矩阵

```
OpenClaw 拥有                      ClawTwin 拥有
─────────────────────────────────────────────────────
Channel（Feishu/DingTalk/Slack）   ObjectType（设备/告警/工单）
Agent（会话智能体）                  ActionType（创建工单/确认告警）
Provider（LLM 供应商）              FunctionType（AI 诊断/预测函数）
Skill（对话技能）                    Connector（OPC-UA/ERP/CMMS 数据源）
MCP Client（调用外部 MCP）          Pipeline（数据转换/聚合）
Plugin（OpenClaw 扩展）              Playbook（业务编排/自动化）
Hook（消息前/后处理）                IndustryPack（行业包打包上述资源）
Tool（OpenClaw 工具）               MCP Server（把 FunctionType/ActionType 暴露）
                                   Knowledge Base（故障案例/操作规程）
                                   OutcomeEvent（干预结果·飞轮标签）
```

### 6.2 协作关系（双向，非主从）

```
OpenClaw（AIP Assist）                      ClawTwin（Foundry + AIP）
      │                                            │
      │  ←── ClawTwin MCP Server ───  工具调用  ──│  提供：业务上下文/ActionType/FunctionType
      │  ───→ ClawTwin AgentRuntime →  任务委托 ──│  发起：复杂推理/长对话委托
      │                                            │
ClawTwin IS an MCP server FOR OpenClaw
OpenClaw IS an AgentRuntime FOR ClawTwin（可替换：Coze / Dify / HiAgent）
```

---

## 七、企业 IT 位置（定稿）

```
L5 战略层    ERP / BI / 财务 / 人力
              ↑ ClawTwin 推送运营摘要 / KPI / 异常汇总
L4 管理层    OA / 审批 / 项目管理
              ↕ ClawTwin 触发审批 / 接收审批结果
L3 运营层    MES / CMMS / WMS / CRM
              ↕ ClawTwin Webhook 推送工单 / 接收完工结果
L2.5 ★      ClawTwin（运营语义内核）← 当前层
              ↑ 感知数据 + 运营事件流入
              ↓ 告警 / 工单 / 洞察流出
L2 数据集成  OPC-UA / Modbus / MQTT / Historian
L1 感知层    传感器 / PLC / 工控机

AI 智能体（横向）：
  OpenClaw → ClawTwin MCP Server（工具调用）
  ClawTwin → OpenClaw AgentRuntime（复杂推理委托）
```

---

## 八、扩展能力全景（v2.4 实现状态）

| 扩展轴              | 扩展方式                        | 实现状态                               |
| ------------------- | ------------------------------- | -------------------------------------- |
| **ObjectType**      | YAML + IndustryPack             | ✅ 完整                                |
| **ActionType**      | YAML + Python handler           | ✅ 完整                                |
| **FunctionType**    | YAML + Python handler + LLM     | ✅ 完整                                |
| **Playbook**        | YAML                            | ✅ 完整（P0 实现）                     |
| **Connector**       | Python Protocol + manifest      | ✅ 骨架，M2 实体化                     |
| **ModelProvider**   | Python Protocol                 | ✅ OpenAI/Anthropic/Ollama/Stub        |
| **AgentRuntime**    | Python Protocol                 | ✅ OpenClaw/Coze/Dify/HiAgent/Stub     |
| **Channel/Sink**    | EventDispatcher.register_sink() | ✅ Feishu/Webhook/SSE                  |
| **IndustryPack**    | manifest.yaml + python_module   | ✅ 完整（含 router/service/lifecycle） |
| **Hook（前/后置）** | infra/hooks.py                  | ✅ 完整                                |
| **NL Query**        | ModelProvider + Query API       | ⚠️ P2                                  |
| **Marketplace**     | Pack 注册表 + 版本管理          | ⚠️ M6                                  |

---

## 九、文档地图（最终版）

| 文档                                    | 定位                                             | 读者                  |
| --------------------------------------- | ------------------------------------------------ | --------------------- |
| `CLAWTWIN-DEFINITIVE-REFERENCE.md`      | **本文** · 决策性参考                            | 所有开发者            |
| `CLAWTWIN-ARCHITECTURE-SYSTEMATIC.md`   | 多产品组合·依赖公理·目录模块全集（纯文字系统化） | 架构评审 / onboarding |
| `CLAWTWIN-PRODUCT-VISION.md`            | 产品家族 · Palantir 对齐 · 战略                  | 产品/架构师           |
| `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`    | API 协议权威                                     | 后端开发              |
| `DESIGN-FINAL-LOCK.md`                  | 端点路径表                                       | 后端/前端             |
| `CLAWTWIN-EXTENSION-MANIFESTO.md`       | 扩展机制详解                                     | 扩展开发者            |
| `CLAWTWIN-RELIABILITY-ARCHITECTURE.md`  | 可靠性七件套                                     | 运维工程师            |
| `CLAWTWIN-ARCHITECTURE-REVIEW-FINAL.md` | 架构全面审视                                     | 架构评审              |
| `CLAWTWIN-SYSTEM-AUDIT-V1.md`           | 项目状态/TODO                                    | 所有贡献者            |
| `CLAWTWIN-MILESTONE-PLAN.md`            | 交付计划 M0-M6                                   | 产品/工程负责人       |
| `DEV-QUICKSTART.md`                     | 开发环境搭建                                     | 新开发者              |
| `DESIGN-FINAL-MASTER-INDEX.md`          | 总索引                                           | 任何人                |
