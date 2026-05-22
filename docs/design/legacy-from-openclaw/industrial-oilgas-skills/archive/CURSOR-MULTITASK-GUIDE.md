# ClawTwin Cursor 多任务并行开发完整指南

> **版本**：v1.3.4 · 2026-05-12（§七 cwd 铁律 §八 Review；与 DEV/TESTING/LOCK/NEXUS 头注对齐）
> **目的**：告诉你在 Cursor 每个任务窗口里，输入哪些 `@` 文件 + 哪段提示词，让 AI 正确高效地完成开发  
> **前提**：设计文档全部在 `contrib/industrial-oilgas-skills/`，代码仓库在 `clawtwin-platform/`（后端）和 `clawtwin-studio/`（前端）；日常建议 Cursor **多根工作区**同时打开 `openclaw`、`clawtwin-platform`、`clawtwin-studio`。

> ★ **总入口**：`DESIGN-FINAL-MASTER-INDEX.md`（5 分钟找到所有信息 + 17 周路线图 + 44 条铁律映射）  
> ★ **三大权威**：`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（架构）+ `USER-ENVIRONMENT-DELIVERY-VALIDATION.md`（交付）+ `TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md`（选型）  
> ★ **本文件作用**：把上述设计文档"翻译"成可执行的 Cursor 任务窗口配置

---

## 一、先理解本系统的定位

```
传统模式（AI之前）：
  现场设备 → SCADA/DCS → 操作员盯屏 → 人工判断 → 电话/纸质工单

ClawTwin 增加的内容：
  现场设备 → SCADA/DCS ─── [OPC-UA Bridge]──→ Nexus Platform（语义层+AI调度）
                                                          │
  ERP/CMMS ─────────────── [API Adapters]──→              │
                                                          ↓
  Feishu Bot ←──── [OpenClaw AI Runtime] ←── [MCP Server] ← Nexus
  Studio UI ←───────────────────────────────────────────── Nexus

核心本质：
  ✅ 不替换 SCADA/ERP/CMMS（它们继续运行）
  ✅ 增加了"语义层"（设备本体/知识库，让AI能理解工业数据）
  ✅ 增加了"智能层"（AI分析、诊断、决策建议）
  ✅ 增加了"体验层"（Studio UI + Feishu Bot，更智能的人机交互）
```

---

## 二、文档有效性说明

### 文档分类（共 ~60 份）

```
【P0 权威文档】开发直接依据，有冲突以此为准：
  DESIGN-FINAL-LOCK.md          ← API路径+枚举+表名终态，开发前必读
  NEXUS-API-REFERENCE.md        ← 31个端点完整Request/Response，联调必读
  DEVELOPMENT-CONTRACT.md       ← 全局契约+铁律+Demo场景+文档索引
  MODULE-DESIGN-PLATFORM.md     ← 后端文件结构/DB/API/ORM
  MODULE-DESIGN-STUDIO.md       ← 前端组件树/状态管理/页面设计
  TESTING-GUIDE.md              ← 测试策略+代码示例+CI配置
  INDUSTRIAL-SCENARIOS-COMPLETE.md  ← 工业场景覆盖度审计+枚举终态

【P0 技术选型约束文档】开发前必读，防止选错技术：
  ARCHITECTURE-SIMPLIFICATION-AUDIT.md ← Phase A 精简栈决策（4服务：postgres+redis+vllm+openclaw）
  ARCHITECTURE-FINAL-CRITICAL-AUDIT.md ← LlamaIndex替代自研RAG/成熟库清单/开源数据资源（最终审查）
  CORE-ARCHITECTURE-AUDIT-2026.md      ← LLM Trace/统一Approval/业界对标（§3 已被 ARCHITECTURE-PRUNING-2026 §三 取代）
  ARCHITECTURE-PRUNING-2026.md         ← @tool/Provider/Stream/Industry Pack 原则（仍有效，但服从 FOUNDRY）
  INDUSTRIAL-FOUNDRY-ARCHITECTURE.md   ← ★最高架构权威·v1.1：ClawTwin = Industrial Foundry。Ontology+ObjectType+ActionType+FunctionType+Pipeline+Markings+AgentRuntime+Connector+SoT
  USER-ENVIRONMENT-DELIVERY-VALIDATION.md ← ★最高交付权威：用户真实环境（飞书+OpenClaw/HiAgent+IMS）反推架构。AgentRuntime抽象/Connector抽象/SoT策略/部署形态/4场景验证
  TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md ← ★最高选型权威：buy/borrow/build三问 + 强制借力（LinkML/Airbyte/Refine/Casbin/OSDU/ISO标准）+ ROI审计 ★所有"造轮子"决定先看此文档

【P1 架构参考文档】理解架构决策用，不直接写代码：
  CLAWTWIN-MASTER-V2.md         ← 整体架构图（API路径以LOCK为准）
  ARCHITECTURE-FINAL-REVIEW.md  ← OpenClaw/飞书/Hermes集成纠正
  NEXUS-OS-ARCHITECTURE.md      ← Nexus作为工业OS的MCP工具设计+CLI设计（★重要）
  NEXUS-BUSINESS-LOGIC.md       ← Nexus内部业务逻辑
  STUDIO-UI-ARCHITECTURE.md     ← Studio UI架构专项
  ADR-2 ~ ADR-8                 ← 架构决策记录（为什么这么设计）

【P2 特定场景文档】按需阅读：
  OPCUA-BRIDGE-DESIGN.md        ← OT数据接入（接OPC-UA的同事看）
  OPENCLAW-SETUP-GUIDE.md       ← OpenClaw安装配置（AI集成同事看）
  KB-SEED-CONTENT.md            ← 知识库种子内容（知识管理同事看）
  DEV-QUICKSTART.md             ← 新成员30分钟上手
  COMMERCIAL-ARCHITECTURE.md    ← 商业模式（PM看）
  PHASE-A-SCAFFOLD.md           ← 项目脚手架（初始化一次用完）
  DEVELOPMENT-MILESTONES.md     ← 里程碑CheckList（项目管理用）
  PARALLEL-DEV-TASKSPEC.md      ← 并行任务分解（本文档更详细替代）

【归档参考文档】历史记录，不需要开发时阅读：
  FINAL_*.md                    ← 早期草稿，被 V2/V3 文档替代
  ARCH_DECISION_RECORD.md       ← 被 ADR-2~8 替代
  INDUSTRIAL_BRAIN_MASTER.md    ← 被 CLAWTWIN-MASTER-V2 替代
  VISION_METAVERSE_INDUSTRY40.md← 愿景草稿，被 ECOSYSTEM-AND-EXPERIENCE-VISION 替代
  ENTERPRISE_ARCHITECTURE_COMPLETE.md ← 早期架构，被 V2 替代
```

> ✅ **结论：绝大多数文档都有效，描述不同侧面，不互相替代。**  
> ⚠️ 只有 `FINAL_*.md`、`ARCH_DECISION_RECORD.md`、`INDUSTRIAL_BRAIN_MASTER.md` 等早期草稿  
> 在**数据/API定义上**被新版本替代，但仍可作历史背景参考。

---

## 三、Cursor 多任务使用方法

### 如何打开多任务

1. Cursor 左上角 → `New Tab`（或 Cmd+T）→ 开新的 Agent 对话
2. 每个标签页是独立的 Agent 上下文，互不干扰
3. 建议同时开 4-6 个，对应 4-6 个独立任务轨道
4. 使用 Cursor 的 Background Tasks（后台任务）功能让任务并行执行

### 任务独立性原则

```
任务 A 正在写 Platform 鉴权模块（models/user.py）
任务 B 正在写 Studio 设备组件（TwinPage.tsx）
→ 两者不冲突，可真正并行

任务 A 正在写 WorkOrder ORM
任务 B 正在写 WorkOrder API（依赖 A 的 ORM）
→ B 必须等 A 的 ORM PR 合并后才启动
```

### 防止 AI 走偏的核心技巧

```
① 每次新任务，第一句话必须 @DEVELOPMENT-CONTRACT.md
② 要求 AI 读完相关章节后再动手（不要让它凭记忆写）
③ 明确告诉 AI："不要修改 @文件列表 以外的模块"
④ 让 AI 先输出"我的理解：..."再写代码，确认理解正确
⑤ 每个任务结束时，让 AI 输出"变更文件列表"以便 Code Review
```

---

## 四、Phase A 完整任务清单（按依赖顺序）

```
Week 1-2（可全部并行）：
  [T0.5] Ontology Loader（从 YAML 加载 Object/Action/Function 定义）★最高优先
  [T1]  数据库 Schema + Alembic 迁移（含 llm_traces / approval_requests / object_lineage 表）
  [T2]  Auth + JWT + ABAC + Marking Enforcement 中间件
  [T2.5] ActionExecutor + FunctionExecutor + ObjectStore（声明式 Ontology 框架，★所有读写基础）
  [T2.6] Auto-Generator：HTTP Router / MCP Server / CLI 自动从 Ontology 生成
  [T3]  Equipment + Station Object Type YAML + 自动生成验证
  [T4]  Studio Shell + 路由 + MSW Mock 框架

Week 3-4（依赖 T1+T2）：
  [T5]  告警管理（ISA-18.2）
  [T6]  工单 FSM + HITL
  [T7]  知识库 RAG
  [T8]  AI Jobs + Scheduler

Week 5-6（依赖 T1+T2）：
  [T7.5] IMS Connector 抽象 + 至少 2 个标准 Connector 包（SAP PM + 用友 NC 或 generic/rest_api）
  [T9]  生产数据 + 班次 + 巡检 Object Type + Action Type
  [T10] OPC-UA Bridge + Pulse Engine（用 connectors/scada_dcs/opcua_generic/）
  [T11] MCP Server 定制扩展（基础已由 T2.6 自动生成）
  [T11b] clawtwin CLI 定制扩展（基础已由 T2.6 自动生成）
  [T11c] AgentRuntime 抽象 + OpenAPI Exporter + HiAgent/Dify 适配器

Week 7-9（依赖 T3+T5+T6，可并行）：
  [T12] Studio 设备孪生视图 + DeviceIntelPanel
  [T13] Studio 告警队列面板（ISA-18.2 UI）
  [T14] Studio 工单看板 + 表单

Week 9-10（依赖 T9+T12）：
  [T15] Studio 生产/班次/巡检页面

Week 10-11：
  [T16] Studio Admin 管理页面
  [T17] OpenClaw + Feishu 集成调试

Week 12：
  [T18] Demo 数据 + E2E 验收
```

### 四.1 当前可并行波次（与 T 号映射）

> **增量排期**以 `clawtwin-project/PHASE-A-PROGRESS-AUDIT.md` **§10** 为准（任务号 **PA-P1**…**PA-P9**：Studio Refine、ObjectStore、pgvector/KB、MCP、Connector **运行时**、飞书+HITL、LinkML CI、**SSE** 多事件、**traces/approval/lineage** 迁移）。多窗口并行时：**每个 Agent 首条 @ `DEVELOPMENT-CONTRACT.md` + 本 §**四.1.1** 对应行 + 审计 §10**；改代码后把 **§8/§9** 中的 pytest/build 一行更新进审计（若你维护该文件）。

| 审计 §10  | 主要对应 `§四` 任务                                     |
| :-------- | :------------------------------------------------------ |
| **PA-P1** | [T4]、[T12]–[T14]（Refine `resources` + NavRail）       |
| **PA-P2** | [T2.5] ObjectStore                                      |
| **PA-P3** | [T7] RAG / 铁律 20                                      |
| **PA-P4** | [T11] MCP                                               |
| **PA-P5** | [T7.5] Connector **运行时**                             |
| **PA-P6** | [T17] 飞书 / [T6] HITL                                  |
| **PA-P7** | [T0.5] LinkML 收口                                      |
| **PA-P8** | [T8] AI Jobs + Scheduler（SSE 可与 jobs 同窗协调）      |
| **PA-P9** | [T1] 数据库 Schema + Alembic（traces/approval/lineage） |

#### 四.1.1 多窗口「可复制」首发句（每条放进 Cursor 首条消息，再展开对应 [T*] 全文提示词）

> 统一前缀（建议原样粘贴）：`@contrib/industrial-oilgas-skills/DEVELOPMENT-CONTRACT.md @contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md @contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md @contrib/industrial-oilgas-skills/clawtwin-project/PHASE-A-PROGRESS-AUDIT.md` —— 只改 **§10** 指派给你的 **PA-P\***，不要改无关模块；做完更新审计 **§8/§9** 的 pytest/build 一行。

| 窗口      | 首发句（续写 `CURSOR-MULTITASK-GUIDE.md §五` 对应节）                                                                                                                                                                                   |
| :-------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PA-P1** | 我做 **§10 PA-P1 / P1-a+P1-b**：在 `clawtwin-studio/refine-clawtwin` 落地 ≥2 个 Refine **`resources`** + NavRail 导航；对齐 `DESIGN-FINAL-LOCK.md` 与 `MODULE-DESIGN-STUDIO.md`。然后展开 **§五 [T4]**（及 **[T12]–[T14]** 设计约束）。 |
| **PA-P2** | 我做 **§10 PA-P2**：在 `clawtwin-platform/platform-api` 实现 **`PostgresObjectStore` `load`/`save`** 非占位；对齐 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` §八 ObjectStore；展开 **§五 [T2.5]**。                                           |
| **PA-P3** | 我做 **§10 PA-P3 / P3-a+P3-b**：pgvector 迁移 + **`GET /v1/kb/search`** 向量分支与回退；遵守 **铁律 20**；展开 **§五 [T7]**。                                                                                                           |
| **PA-P4** | 我做 **§10 PA-P4 / P4-a+P4-b**：MCP 向 **LOCK §1.7** 靠拢（ADR 或 **`tools/call`** 真透传）；展开 **§五 [T11]**。                                                                                                                       |
| **PA-P5** | 我做 **§10 PA-P5 / P5-a+P5-b**：IMS Connector **运行时 probe**（SAP PM 或用友 NC 其一）；展开 **§五 [T7.5]**。                                                                                                                          |
| **PA-P6** | 我做 **§10 PA-P6**：飞书卡片与 **HITL** 最小闭环（可审计/可落库）；展开 **§五 [T17]** + **[T6]**。                                                                                                                                      |
| **PA-P7** | 我做 **§10 PA-P7**：LinkML **gen-pydantic 或 gen-sqla** CI 可跑；展开 **§五 [T0.5]**。                                                                                                                                                  |
| **PA-P8** | 我做 **§10 PA-P8**：`sse.py` 多事件类型占位 + 测试；不引入 Kafka；展开 **§五 [T8]**。                                                                                                                                                   |
| **PA-P9** | 我做 **§10 PA-P9**：**Alembic** traces/approval/lineage 其一落地；展开 **§五 [T1]**。                                                                                                                                                   |

#### 四.1.2 PA-P* → §五 详细提示词索引（复制 §五 对应 `[T*]` 全文块）

> 多窗口开发：窗口 A 用下表「首发句」+ 本行「展开」；将 **`CURSOR-MULTITASK-GUIDE.md` §五** 中该 **`### [T*]`** 节整段（含【要@的文件】与【提示词】）粘到第二条消息。路径与枚举以 **`DESIGN-FINAL-LOCK.md`** 为准；工单 **`state`**、**`require_station_access`** 等见 **`clawtwin-project/SKILL.md`**。

| 审计 §10  | 对应 [T]（§四.1 表）        | §五 锚点（搜索标题）                                                                            | 建议额外 @（除统一前缀外）                                               |
| :-------- | :-------------------------- | :---------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| **PA-P1** | [T4] + 设计约束 [T12]–[T14] | `### [T4]`；孪生/告警/工单 UI 分别 `### [T12]` `### [T13]` `### [T14]`                          | `MODULE-DESIGN-STUDIO.md`、`STUDIO-UI-ARCHITECTURE.md`                   |
| **PA-P2** | [T2.5]（ObjectStore 子集）  | `### [T2.5]`（重点 **ObjectStore** / postgres）                                                 | `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` §八                                 |
| **PA-P3** | [T7]                        | `### [T7]`                                                                                      | `NEXUS-API-REFERENCE.md` §六、`MODULE-DESIGN-PLATFORM.md` §八            |
| **PA-P4** | [T11]                       | `### [T11]`                                                                                     | `NEXUS-OS-ARCHITECTURE.md`、`DESIGN-FINAL-LOCK.md` §1.7                  |
| **PA-P5** | [T7.5]                      | `### [T7.5]`                                                                                    | `USER-ENVIRONMENT-DELIVERY-VALIDATION.md` §四                            |
| **PA-P6** | [T17] + [T6]                | `### [T17]`、`### [T6]`                                                                         | `USER-ENVIRONMENT-DELIVERY-VALIDATION.md` §五、`DEVELOPMENT-CONTRACT.md` |
| **PA-P7** | [T0.5]                      | `### [T0.5]`                                                                                    | `TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md` §2.1                     |
| **PA-P8** | [T8]（SSE / Jobs 子集）     | `### [T8]`（**sse.py**、多事件与 **LOCK** §1.6 类型对齐）                                       | `NEXUS-API-REFERENCE.md` §五、`DESIGN-FINAL-LOCK.md` §1.6                |
| **PA-P9** | [T1]（迁移子集）            | `### [T1]`（**llm_traces** / **approval_requests** / **object_lineage** 与现有 Alembic 链协调） | `MODULE-DESIGN-PLATFORM.md` §十九                                        |

**§10.1 子步与 [T] 对应**：P1-a/P1-b → [T4] + NavRail/资源矩阵（同窗口序贯）；P3-a/P3-b → [T7] 拆迁移与 search 分支；P4-a → 文档/ADR（无单独 [T]，可自建 `ADR-*-MCP-STREAMABLEHTTP.md`）；P4-b → [T11] + [T2.6] 自动化前提；P5-a/P5-b → [T7.5]。

---

## 五、每个任务的完整操作指南

> **格式说明**：每个任务给出【要@的文件】和【粘贴给 Cursor 的提示词】，直接复制粘贴。

---

### [T1] 数据库 Schema + Alembic 迁移

**要@的文件**：

```
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
@contrib/industrial-oilgas-skills/MODULE-DESIGN-PLATFORM.md
```

**提示词**：

```
请帮我实现 ClawTwin Platform 的数据库层。

任务范围：
1. 读 @DESIGN-FINAL-LOCK.md §二（数据库表名列表）和 §二a（关键枚举定义）
2. 读 @MODULE-DESIGN-PLATFORM.md §十九（数据模型权威定稿）和 §二十九.1（新增 ORM）

需要实现的文件：
- platform/models/__init__.py（导出所有 Model）
- platform/models/station.py（Station 模型）
- platform/models/user.py（User + UserStationAssignment 模型）
- platform/models/equipment.py（Equipment + EquipmentReading 模型，状态枚举8种）
- platform/models/alarm.py（Alarm 模型，ISA-18.2 完整字段）
- platform/models/work_order.py（WorkOrder 模型，work_type枚举7种，含PTW预留字段）
- platform/models/ai_job.py（AIJob 模型）
- platform/models/production.py（ProductionRecord + ShiftRecord + InspectionSchedule）
- platform/models/knowledge.py（KBDocument + KBChunk）
- platform/models/audit.py（AuditLog）
- alembic/versions/0001_initial_schema.py（所有表的迁移）

铁律：
- 设备状态枚举：running|standby|warn|alarm|fault|maintenance|commissioned|offline
- 工单类型枚举：corrective|preventive|inspection|shutdown|emergency|calibration|improvement
- 工单字段名：state（不是 status），初始值 "draft"
- 停输时长 > 60分钟时 outage_reason 不能为空（在 ORM 级别用 @validates）

完成后输出：变更文件列表 + 运行 `alembic upgrade head` 的预期输出
```

---

### [T2] Auth + JWT + ABAC 中间件

**要@的文件**：

```
@contrib/industrial-oilgas-skills/DEVELOPMENT-CONTRACT.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
```

**提示词**：

```
请帮我实现 ClawTwin Platform 的认证鉴权系统。

任务范围：读 @DEVELOPMENT-CONTRACT.md §二（安全铁律）和 §四（安全铁律清单），
读 @NEXUS-API-REFERENCE.md §一（认证接口）。

需要实现的文件（**以 `clawtwin-platform/platform-api` 实际树为准**；若与早期 `platform/` 脚手架文档不一致，**以磁盘仓为准**）：
- `apps/http/routes/auth_http.py`（POST `/v1/auth/login`、GET `/v1/auth/me` 等；Phase A **dev** 门控见 README）
- `infra/auth/jwt_validate.py`、`infra/auth/deps.py`（**`require_station_access`**、`get_current_user`）
- `infra/auth/station_merge.py`（JWT ∪ `user_station_assignments`）

（历史文档中的 `platform/routers/auth.py`、`platform/services/auth.py`、`require_station()` 命名：**请映射为** 上列 **`require_station_access`** 与 `auth_http` 路由。）

铁律（违反即错）：
- station_id 永远从 JWT/用户权限中取，绝不从请求体取
- **`require_station_access(user, station_id)`**（或对资源隐式场站）验证：**该资源所属站场** ∈ `user.station_ids`（含 **station_merge**）
- supervisor 角色 AND 同站场，两个条件缺一不可
- 所有 API 端点必须调用 require_auth，无公开端点
- Service Token（Bearer ct-svc-xxx-...）走独立验证路径，不走 JWT

API 格式：参照 NEXUS-API-REFERENCE.md §零.1（统一响应格式）

完成后输出：
1. 三个依赖函数的签名和逻辑说明
2. 测试命令（curl 获取 token + 用 token 访问保护端点）
```

---

### [T0.5] Ontology Loader（最高优先：基于 LinkML 实现）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md
@contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md
```

**提示词**：

```
请实现 ClawTwin Industrial Foundry 的 Ontology Loader（依赖 T2.5/T2.6/T3/T5/T6 全部任务）。

⚠️ 强制约束（铁律 35/36）：
- Object Type 用 LinkML（linkml.io）作为底层 schema 语言，不要自创 YAML 关键字
- 自动生成 Pydantic + SQLAlchemy 模型，不要手写
- ClawTwin 通过 LinkML annotations 扩展工业语义：
  · computed_properties / markings / source_of_truth_strategy / ui_hints / safety / lifecycle
- 必读 @TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §2.1（LinkML 示例）
- 必读 @INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四（Action/Function/Marking schema）

依赖：
  pip install linkml linkml-runtime  # ~50MB, 包含 schema engine + Pydantic generator
  pip install gen-pydantic gen-sqla  # LinkML 提供的代码生成器

需要实现的目录与文件：
  platform-api/ontology/
    object_types/         （Object Type LinkML YAML）
      _ontology_meta.yaml ← LinkML schema 头部（含 ClawTwin annotation 定义）
      base.linkml.yaml    ← NamedThing / Markable 等基类
    action_types/         （ClawTwin 自定义 schema YAML，独立于 LinkML）
    function_types/
    markings/
    pipelines/
    schemas/              ← Pydantic 模型（ClawTwin 自定义类型）
      action_type_schema.py
      function_type_schema.py
      marking_schema.py
      pipeline_schema.py
      annotations.py            ← ClawTwin 对 LinkML 的扩展定义
    generated/                  ← LinkML 自动生成（gitignored）
      pydantic_models.py        ← gen-pydantic 输出
      sqla_models.py            ← gen-sqla 输出
    loader.py
      class Ontology:
        def load_all() -> None        # 加载所有 LinkML + Action/Function/Pipeline YAML
        def get_object_type(name) -> LinkmlClass
        def get_action_type(name) -> ActionTypeDef
        def get_function_type(name) -> FunctionTypeDef
        def list_actions_for_object(obj_name) -> list[ActionTypeDef]
        def get_pydantic_model(obj_name) -> type[BaseModel]
        def get_sqla_model(obj_name) -> type
    registry.py           ← 全局单例 ONTOLOGY
    codegen.py            ← 包装 gen-pydantic / gen-sqla CLI

  scripts/
    ontology_codegen.sh   ← Make 脚本：触发 LinkML 代码生成

  tests/ontology/
    test_loader.py
    test_linkml_parsing.py
    test_annotations.py   ← 验证 ClawTwin annotations 解析正确
    fixtures/
      sample_equipment.linkml.yaml
      sample_acknowledge_alarm.action.yaml

参考实现示例（必看）：
  - LinkML 官方文档：https://linkml.io/linkml/
  - OSDU Data Definitions（基于 LinkML）：https://community.opengroup.org/osdu/data/data-definitions
  - NMDC Schema（参考结构）：https://github.com/microbiomedata/nmdc-schema

完成标志：
- ONTOLOGY.load_all() 解析所有 yaml，schema 错误 fail-fast
- ONTOLOGY.get_pydantic_model("Equipment") 返回自动生成的 Pydantic class
- ONTOLOGY.get_sqla_model("Equipment") 返回自动生成的 SQLAlchemy class
- ClawTwin annotations（computed_properties / markings / source_of_truth_strategy）正确解析
- 测试覆盖率 ≥ 85%
```

---

### [T2.5] ActionExecutor + FunctionExecutor + ObjectStore（Foundry 声明式框架）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/ARCHITECTURE-PRUNING-2026.md
@contrib/industrial-oilgas-skills/CORE-ARCHITECTURE-AUDIT-2026.md
@contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md
```

**提示词**：

```
请实现 ClawTwin Industrial Foundry 的核心执行层（依赖 T0.5 Ontology Loader）。

⚠️ 范式约束（违反即拒绝合并）：
1. ClawTwin 是 Industrial Foundry 不是 Agent。Object Type / Action Type / Function Type 是一等公民
2. 业务通过 YAML 声明（@INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四），框架运行时执行
3. @tool 装饰器（PRUNING §三）作为 Action 实现的语法糖保留：@implements_action("AcknowledgeAlarm")
4. 必读铁律 25-29 + 19/20/22/23/24

需要实现的目录与文件：
  platform-api/core/
    object_store/
      base.py             ← ObjectStore.get / search / save / delete（按 type 路由到 PostgreSQL）
      postgres.py         ← SQLAlchemy 实现
      query_builder.py    ← Marking 自动注入 WHERE 子句
    action_executor/
      executor.py         ← ActionExecutor.execute(action_name, params, actor, transport)
                            内部按顺序：解析 ObjectReference → validators → approval 检查
                            → effects 应用（事务） → side_effects 异步发出 → audit + trace + lineage 落库
      validators.py       ← 把 YAML rule 字符串编译为 Python 校验函数（用 simpleeval）
      effects.py          ← 把 YAML effect 编译为 SQL 变更
      side_effects.py     ← emit_event / notify 实现
      handlers/           ← Python 自定义实现（@implements_action）放这里
        _registry.py
    function_executor/
      executor.py         ← FunctionExecutor.call(fn_name, params)；内置 cache（按 cache.ttl）
      ai_runner.py        ← ai_function 委派给 OpenClaw（agent_connector）
      python_runner.py    ← python_function 调本地模块
      sql_runner.py       ← sql_function 渲染 SQL
    domain_logic/
      alarm_fsm.py        ← 复杂状态机（Action 调用）
      workorder_fsm.py
  platform-api/infra/
    approval.py           ← ApprovalQueue（Action.approval.required=true 时拦截）
    audit.py              ← AuditLog 写入
    tracing.py            ← llm_traces + action_traces 写入
    lineage.py            ← Object Lineage 记录

设计要点：
- ActionExecutor.execute 是唯一写入入口，所有 Audit/Trace/Lineage 在这里统一处理
- ObjectStore 内置 Marking 过滤（用户不能查到他没权限的 Object）
- FunctionExecutor 必须支持 cache_key 计算 + Redis 后端
- 所有 effects 在单一 SQL 事务里完成；side_effects 通过 Redis Stream 异步

完成标志：
- ActionExecutor.execute("AcknowledgeAlarm", {alarm: "ALM-1"}, actor, "http") 端到端工作
- audit_logs / action_traces / object_lineage 自动写入
- 测试覆盖率 ≥ 85%
```

---

### [T2.6] Auto-Generator：HTTP/MCP/CLI 自动从 Ontology 生成入口

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/ARCHITECTURE-PRUNING-2026.md
```

**提示词**：

```
请实现 ClawTwin Industrial Foundry 的入口自动生成层（依赖 T0.5 + T2.5）。

⚠️ 核心要求（INDUSTRIAL-FOUNDRY §六.1）：
不再手写每个 endpoint。Ontology 加载完成后，框架遍历 Object/Action/Function 自动生成：
- HTTP：每个 Object Type 自动生成 4 个端点（list/get/links/computed_properties）
        每个 Action Type 自动生成 1 个 POST 端点
        每个 Function Type 自动生成 1 个 POST 端点
- MCP：完全相同的覆盖度，但走 fastmcp 注册（LLM 视角的 tool）
- CLI：clawtwin object list <Type> / clawtwin action call <Name> --params=...
       同样从 Ontology 自动生成

需要实现的目录与文件：
  platform-api/apps/
    http/
      ontology_router.py  ← FastAPI router 工厂；遍历 ONTOLOGY 生成所有端点
      studio_router.py    ← Studio-specific 自定义端点（layouts / dashboards）
      auth_router.py      ← /v1/auth/* 由 T2 实现，这里只挂载
    feishu/               ← T17 实现
    cli/
      main.py             ← Typer + Rich
      object.py           ← clawtwin object {list/get/search/show-links}
      action.py           ← clawtwin action {list/call} <ActionName>
      function.py         ← clawtwin function {list/call} <FunctionName>
      ontology.py         ← clawtwin ontology {validate/list}
  platform-api/aip/
    mcp_server.py         ← FastMCP 实例 + build_from_ontology() 工厂
    agent_connector.py    ← OpenClaw 调用抽象（被 ai_function 用）

设计要点：
- HTTP/MCP/CLI 都走同一 ActionExecutor / FunctionExecutor / ObjectStore
- LLM Trace 在 ActionExecutor 自动写，不需要 channel 层关心
- Auth 适配器：HTTP=JWT, MCP=Service Token, CLI=用户身份

完成标志：
- 启动后 GET /v1/openapi.json 包含所有 Object/Action/Function 端点
- MCP Server list_tools 返回所有 Action+Function+Query
- clawtwin --help 列出所有可用命令
      cli.py              ← build_cli()：8 行循环遍历 TOOLS
    providers/            ← 可插拔基础能力（先空着，框架先就位）
    infra/                ← 横切基础设施
      tracing.py          ← async with trace() 上下文管理器
      approval.py         ← ApprovalQueue + maybe_request_approval
      audit.py            ← audit_log 函数
      auth.py             ← Actor / enforce_role / enforce_station
      settings.py         ← pydantic-settings
    workers/              ← 后台（暂留空，T8 任务实现）

需要实现的代码：
1. core/tools/_framework.py（< 100 行）
   照抄 @ARCHITECTURE-PRUNING-2026.md §3.2 的 ToolDef + tool 装饰器 + invoke

2. infra/tracing.py
   async with trace(tool_name, input, actor, transport) as tr:
       result = await handler(...)
       tr.set_result(result)
   字段按 @CORE-ARCHITECTURE-AUDIT-2026.md §4.2

3. infra/approval.py
   ApprovalQueue.request() + .decide()
   approved 时重新走 invoke（skip_approval=True）

4. infra/audit.py
   audit_log(tool_name, input_dict, result, actor, transport) → audit_logs 表

5. channels/http.py + mcp.py + cli.py（每个 < 30 行）
   照抄 @ARCHITECTURE-PRUNING-2026.md §3.4

6. core/tools/_hello_world.py（验证框架）
   @tool(name="hello_world", description="...", input_schema=HelloIn)
   async def hello_world(input, actor) -> HelloOut: ...

7. tests/test_tool_framework.py
   覆盖：成功 / 权限拒绝 / 限流 / 审批挂起 / 异常 / 三处入口

数据库迁移（含 T1 协调）：
- llm_traces 表（按 CORE-ARCHITECTURE-AUDIT-2026 §4.2）
- approval_requests 表（按 CORE-ARCHITECTURE-AUDIT-2026 §5.2）
- audit_logs 表（已有 schema）

⚠️ 这是所有 P0 写操作（acknowledge_alarm / approve_workorder / record_production / shelve_alarm / create_workorder）的统一基础。本任务完成前，T5/T6/T9/T11 不能开始写 tool 业务逻辑。

完成后输出：
- hello_world tool 通过 HTTP / MCP / CLI 三处调用都成功
- llm_traces 表里出现 3 条记录（每个 transport 一条）
- 测试全部通过
- 框架代码总量 < 400 行（如果 > 600 行说明走偏了，参考 @ARCHITECTURE-PRUNING-2026.md 重新审视）
```

---

### [T3] Equipment + Station Object Type YAML（Foundry 风格）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
```

**提示词**：

```
请帮我实现 ClawTwin Industrial Foundry 的设备和场站 Object Type（依赖 T0.5 Ontology Loader + T2.5 Executor + T2.6 Auto-Generator）。

⚠️ 范式约束（违反即拒绝）：
- 不要直接写 platform/routers/equipment.py 业务逻辑
- 不要在 router 里写 SQL / 业务校验
- Equipment / Station 必须先有 Object Type YAML（@INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四.1）
- 框架（T2.6）会自动生成 HTTP / MCP / CLI 端点

需要实现的文件：
1. ontology/object_types/station.yaml
   - properties: id / name / region / commissioned_at / contact_info
   - markings: station_marking

2. ontology/object_types/equipment.yaml
   - 完整 8 种 status enum（DESIGN-FINAL-LOCK §二a）
   - 完整 properties（id/name/type/status/station_id/manufacturer/model/...）
   - computed_properties: health_score / predicted_breach_minutes / primary_action
   - links: station / alarms / workorders / latest_reading / knowledge_docs
   - markings: station_marking + zone_marking

3. ontology/object_types/equipment_reading.yaml
   - 时序对象（TimescaleDB 超表）
   - properties: equipment_id / ts / vibration / temperature / pressure / ...

4. ontology/function_types/compute_health_score.yaml
   - implementation: python_function（暂时返回 0-100 mock）
   - cache_ttl: 60s

5. ontology/function_types/build_decision_package.yaml
   - implementation: python_function
   - cache_ttl: 30s
   - 输出 schema：primary_action / risk_summary / next_actions

6. core/object_store/postgres_models/
   - station.py / equipment.py / equipment_reading.py SQLAlchemy 模型
   - 必须与 Object Type YAML 字段一一对应（T2.5 ObjectStore 据此映射）

7. tests/object_types/test_equipment.py
   - 验证 Object Type YAML 解析正确
   - 验证 ObjectStore.get(Equipment, "C-001") 返回结构正确
   - 验证 Marking 拦截：用户无该 station_id 时返回空

完成后自动获得：
- GET /v1/objects/Equipment（列表）/ /v1/objects/Equipment/{id}（详情）/ /v1/objects/Equipment/{id}/links/alarms
- MCP tools: get_equipment / search_equipment / ComputeHealthScore / BuildDecisionPackage
- CLI: clawtwin object list Equipment / clawtwin object get Equipment C-001
- 不需要写任何 router 文件（auto-generator 处理）

完成标志：
- 启动后 GET /v1/objects/Equipment 返回 ObjectStore 查询结果
- 测试覆盖率 ≥ 85%
- ontology validate 通过（clawtwin ontology validate）
```

---

### [T4] Studio Shell + 路由 + MSW Mock 框架

**要@的文件**：

```
@contrib/industrial-oilgas-skills/MODULE-DESIGN-STUDIO.md
@contrib/industrial-oilgas-skills/STUDIO-UI-ARCHITECTURE.md
```

**提示词**：

```
请帮我搭建 ClawTwin Studio 的前端基础框架。

代码仓与根目录（Phase A  scaffold）：`clawtwin-studio/refine-clawtwin/`。以下路径除额外说明外均相对于 `src/`。
已存在（不要推倒重来，在其上扩展）：`App.tsx`、`StudioShell.tsx`、`Dashboard.tsx`、`main.tsx`、`clawtwinApiBase.ts`、`mocks/browser.ts`、`mocks/handlers.ts`、`env.ts`。

读 @MODULE-DESIGN-STUDIO.md §一（整体架构）、§二（路由结构）、§三（StudioShell 布局）。
读 @STUDIO-UI-ARCHITECTURE.md §状态分层（了解 Zustand store 的分工；若项目尚未引入 Zustand，可先最小实现再补）。

需要实现或调整的文件：
- `App.tsx`：React Router v6 +（与 **PA-P1** 一致）Refine `resources` 注册 ≥2 条（如 equipment / workorders），`list`/`show` 先可占位页面
- `StudioShell.tsx`：四区布局（NavRail + TopBar + CenterView + RightPanel）；NavRail 项与 `resource.name` 或可导航路由对齐
- `components/NavRail.tsx`（可从 `StudioShell` 抽取）+ `components/StationSwitcher.tsx`（场站切换）
- `stores/twin.ts`、`stores/auth.ts`（Zustand：`selectedStationId`/`selectedEquipmentId`；`user`/`token`/`login`/`logout`）
- API：扩展现有 `clawtwinApiBase.ts` + 各 Section 已用的鉴权模式；或新增 `lib/api/client.ts` 作 axios 单例（须与 `VITE_CLAWTWIN_API_*` / `withApiAuth` 一致）
- MSW：`mocks/handlers.ts` 增补 LOCK 路径 mock（非 `lib/mock/*`）
- （可选）`styles/tokens.ts`：语义色 alarm/warn（MODULE 要求 tokens 时新增；当前可直接对照 SKILL UI 铁律 5）

路由结构（与 Refine `resources` 并行时，URL 以你实现的 `App.tsx` 为准，示意为工业专页深链）：
/                   → 重定向到 /stations
/login              → LoginPage
/stations           → StationListPage（所有场站概览）
/stations/:id       → StationPage（包含设备列表 + Twin视图）
/stations/:id/alarms → AlarmPage
/stations/:id/workorders → WorkOrderPage
/stations/:id/production → ProductionPage
/stations/:id/shifts → ShiftHandoverPage
/stations/:id/inspection → InspectionPage
/admin              → AdminPage（sys_admin 角色）

铁律：
- selectedStationId 只从 JWT payload 的 station_ids[0] 初始化，不从 URL 读
- MSW：`VITE_CLAWTWIN_MSW=1` 时启动（与现有 `main.tsx` 模式一致），production 跳过
- 样式：Ant Design（Refine 默认）为主；若用 Tailwind，alarm=#EF4444、warn=#F59E0B 与 tokens 对齐

完成后输出：`pnpm dev` / `pnpm build` 通过；`/login` 或现有入口可访问；列出变更文件列表
```

---

### [T5] 告警管理（ISA-18.2，Foundry 风格）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/INDUSTRIAL-SCENARIOS-COMPLETE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Industrial Foundry 的告警 Object Type + 全套 Action Type（ISA-18.2 合规）。
依赖：T0.5 Loader + T2.5 Executor + T2.6 Auto-Generator + T3 Equipment

⚠️ 范式约束（违反即拒绝）：
- 不要写 routers/alarms.py 业务逻辑
- 不要在 service 里直接 commit；写操作必须经 ActionExecutor
- Alarm Object 和告警相关的 5 个写操作必须先有 YAML 声明

需要实现的文件：
1. ontology/object_types/alarm.yaml
   - 完整 ISA-18.2 字段（priority/status/standing_since/chat_count/...）
   - links: equipment / workorder / acknowledged_by_user
   - markings: station_marking
   - lifecycle 字段：status

2. ontology/action_types/acknowledge_alarm.yaml
   - 参考 @INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四.2 完整示例
   - safety.risk_level: low

3. ontology/action_types/shelve_alarm.yaml
   - parameters: alarm / reason (required) / shelved_until
   - validators: reason 非空（ISA-18.2 强制）/ supervisor 角色
   - safety.risk_level: medium
   - approval.required: true if shelve duration > 1h

4. ontology/action_types/unshelve_alarm.yaml
5. ontology/action_types/escalate_alarm.yaml（系统调用，不暴露给 LLM）

6. ontology/function_types/compute_alarm_kpi.yaml
   - implementation: sql_function
   - parameters: station_id / period
   - 输出 alarm_rate_per_10min / standing_count / chattering_count

7. core/object_store/postgres_models/alarm.py
8. core/action_executor/handlers/alarm.py（@implements_action）
   - 复杂校验和副作用的 Python 实现
   - 调用 alarm_fsm 完成状态机转移

9. core/domain_logic/alarm_fsm.py（用 transitions 库）

10. workers/scheduler.py 增加：
    - alarm_restore_job（每5分钟，检查 shelved_until 到期 → 调 ActionExecutor.execute("UnshelveAlarm")）
    - alarm_escalation_job（每5分钟，检查 P1/P2 超时 → 调 ActionExecutor.execute("EscalateAlarm")）

铁律（ISA-18.2 要求）：
- shelve 必须有 reason，框架在 validator 拦截（不需要在 router 写）
- standing_since：首次触发时间，> 24h 的算 standing_alarm（在 Function 计算）
- chat_count：30分钟内重复触发 > 3 次算 chattering_alarm
- P1 超 5 分钟未确认 → escalation job 自动触发 EscalateAlarm Action
- MAINTENANCE 状态的设备不触发 P3/P4 飞书通知（在 Action.side_effects.notify 条件控制）

完成后自动获得：
- HTTP: POST /v1/actions/AcknowledgeAlarm / POST /v1/actions/ShelveAlarm / ...
- MCP: AcknowledgeAlarm / ShelveAlarm / SearchAlarm / GetAlarm
- CLI: clawtwin action call AcknowledgeAlarm --params={alarm: ALM-1}
- 飞书 Bot 自动可用这些 Action（通过 OpenClaw + MCP）

完成标志：
- ISA-18.2 5 个核心场景测试通过
- 所有写操作 audit_logs / action_traces 落库
- 测试覆盖率 ≥ 85%
```

---

### [T6] 工单 Object Type + FSM + HITL（Foundry 风格）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/DEVELOPMENT-CONTRACT.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Industrial Foundry 的工单 Object Type + 全套 Action Type + 状态机。
依赖：T0.5 + T2.5 + T2.6 + T3 + T5

⚠️ 范式约束：
- 不要写 routers/workorders.py 业务逻辑
- 7 个 HITL 转移每个都是一个 Action Type YAML
- approval 由框架的 ApprovalQueue 自动处理（在 Action.approval.required=true 时）

需要实现的文件：
1. ontology/object_types/work_order.yaml
   - 工单类型 7 种 enum（DESIGN-FINAL-LOCK §二a）
   - work_subtype 自由文本
   - 完整 PTW 字段（permit_required / permit_number / outage_reason）
   - state 枚举：draft|pending|approved|rejected|in_progress|done|cancelled
   - links: equipment / source_alarm / approver / executor

2. ontology/action_types/create_work_order.yaml
   - safety.risk_level: low

3. ontology/action_types/submit_work_order.yaml（draft → pending）
   - 此处统一用 approval.required: false（用户自己提交）

4. ontology/action_types/approve_work_order.yaml（pending → approved）
   - validators: actor.role == "supervisor" AND actor.station_ids contains workorder.station_id
   - safety.risk_level: medium
   - side_effects: 飞书卡片通知工单创建人

5. ontology/action_types/reject_work_order.yaml
6. ontology/action_types/start_work_order.yaml（approved → in_progress）
   - validators:
     - workorder.permit_required == false OR workorder.permit_number != null
       (未拿许可证不能开始)
   - safety.risk_level: medium

7. ontology/action_types/complete_work_order.yaml（in_progress → done）
   - validators: execution_notes 非空 / evidence_urls 非空
   - 触发 Knowledge Flywheel Pipeline（异步）

8. ontology/action_types/cancel_work_order.yaml

9. ontology/function_types/draft_work_order.yaml（AI 草稿）
   - implementation: ai_function
   - delegation: openclaw industrial-assistant

10. core/domain_logic/workorder_fsm.py（用 transitions 库）
11. core/action_executor/handlers/workorder.py
12. providers/notifier 增加飞书卡片模板（feishu_cards.py 移至 providers/notifier/feishu_templates.py）

铁律：
- 工单类型7种 enum（在 Object Type 内强制）
- permit_required + permit_number 校验在 Action.validators 内（不是在 router）
- state 字段全小写（Object Type schema 强制）
- approve 校验自动来自 Action.validators，无需手写
- 飞书卡片在 Action.side_effects.notify 触发

完成后自动获得：
- POST /v1/actions/CreateWorkOrder / SubmitWorkOrder / ApproveWorkOrder / ...
- MCP / CLI 同样可用
- ApprovalQueue 自动拦截 high-risk Action（如 approve_work_order）

完成标志：
- 完整状态流测试（draft → pending → approved → in_progress → done）通过
- 拒批工单也能写入审批日志
- ApprovalQueue 中能看到所有 pending 审批
```

---

### [T7] 知识库 RAG

**要@的文件**：

```
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/KB-SEED-CONTENT.md
@contrib/industrial-oilgas-skills/MODULE-DESIGN-PLATFORM.md
```

**提示词**：

```
请帮我实现 ClawTwin Platform 的知识库 RAG 模块。

读 @NEXUS-API-REFERENCE.md §六（知识库接口）了解 API 格式。
读 @KB-SEED-CONTENT.md 了解 L0/L1 种子知识内容的分层定义。
读 @MODULE-DESIGN-PLATFORM.md §八（知识摄入 Pipeline）了解 LlamaIndex 实现方式。

⚠️ 重要架构约束：
- 必须使用 LlamaIndex 做分块和向量存储，不要自建 chunker 或向量写入逻辑
- 向量数据库是 PostgreSQL pgvector（表名 kb_embeddings），不是 Milvus
- 使用 llama-index-core + llama-index-vector-stores-postgres + llama-index-embeddings-huggingface
- embedding 模型：BAAI/bge-m3（1024维）

需要实现：
- platform/kb/ingest_pipeline.py（文档摄入：参考 §八 的 LlamaIndex 实现）
- platform/routers/kb.py（知识库端点）
- platform/services/kb_service.py（调用 ingest_pipeline + search_knowledge）

端点：
- GET /v1/kb/search?query=&station_id=&layer=（LlamaIndex 语义检索，支持 metadata 过滤）
  L0: 行业标准（全局共享）
  L1: 设备手册（按 equipment_type 过滤）
  L2: 站场案例（按 station_id 过滤）
  L3: 本次工单经验（自动从已关闭工单提炼）
- POST /v1/kb/documents（上传文档，限 sys_admin/engineer）
- GET /v1/kb/documents?station_id=&layer=
- DELETE /v1/kb/documents/{id}

requirements.txt 必须包含：
  llama-index-core>=0.11
  llama-index-vector-stores-postgres>=0.2
  llama-index-embeddings-huggingface>=0.3
  pymupdf>=1.24
（不要加 pymilvus，pgvector 已内置在 PostgreSQL）

完成后输出：
curl 上传一个测试文档 + 搜索"压缩机轴承故障处理"的示例
```

---

### [T8] AI Jobs + Scheduler

**要@的文件**：

```
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/DEVELOPMENT-CONTRACT.md
```

**提示词**：

```
请帮我实现 ClawTwin Platform 的 AI 异步任务系统和调度器。

读 @NEXUS-API-REFERENCE.md §五（AI任务接口）了解端点格式。
读 @DEVELOPMENT-CONTRACT.md §五（AI诊断流）了解完整的异步调用链。

需要实现：
- platform/routers/ai_jobs.py（AI任务端点）
- platform/services/agent_connector.py（AgentConnector 抽象层，适配 OpenClaw/HiAgent）
- platform/routers/sse.py（SSE 实时推流）
- platform/scheduler/jobs.py（APScheduler 任务）

端点：
- POST /v1/ai/jobs（创建AI任务，返回 job_id，异步处理）
- GET /v1/sse/ai-jobs/{job_id}（SSE 监听任务进度）
- POST /v1/ai/jobs/{job_id}/result（AI Runtime 回调写入结果，需 Service Token）
- GET /v1/sse/station/{station_id}（场站级别 SSE：告警/设备状态变化推送）

Scheduler 任务：
- alarm_restore_job：每 5 分钟（检查搁置到期告警）
- alarm_escalation_job：每 5 分钟（P1超时未确认→通知supervisor）
- daily_report_job：每天 08:00（生成晨报推飞书）
- anomaly_poll_job：每 30 秒（从 TimescaleDB 查新读数，与告警规则对比）
- inspection_trigger_job：每天 06:00（触发当日巡检工单，来自 inspection_schedules）

AI 诊断流（必须是异步，不能 blocking）：
  Studio → POST /v1/ai/jobs（job_type="diagnose"）
  → Nexus 写 ai_jobs 表（status="pending"）→ 返回 job_id
  → Studio 建立 SSE 连接（GET /v1/sse/ai-jobs/{job_id}）
  → AgentConnector.trigger_session(job) → 通知 OpenClaw
  → OpenClaw 用 MCP 工具获取设备上下文 → 调 vLLM 推理
  → OpenClaw POST /v1/ai/jobs/{id}/result（需 Service Token）
  → Nexus 更新 ai_jobs 表（status="done"） → SSE 推送结果

完成后输出：
完整的异步诊断流 curl 测试序列（创建任务→监听SSE→等待回调→读取结果）
```

---

### [T9] 生产数据 + 班次 + 巡检 API

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-SCENARIOS-COMPLETE.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Platform 的工业运营场景 API（生产数据+班次+巡检）。

读 @INDUSTRIAL-SCENARIOS-COMPLETE.md §三（Phase A必须补充的架构缺口）了解业务规则。
读 @NEXUS-API-REFERENCE.md §十二（生产数据）、§十三（班次管理）、§十四（巡检管理）了解完整端点格式。
读 @DESIGN-FINAL-LOCK.md §二a 中的三张新表 DDL（production_records/shift_records/inspection_schedules）。

需要实现：
- platform/routers/production.py（4个生产数据端点）
- platform/routers/shifts.py（5个班次管理端点）
- platform/routers/inspection.py（3个巡检管理端点）
- platform/services/shift_service.py（AI生成交接摘要的逻辑）
- platform/services/inspection_service.py（巡检计划触发工单创建的逻辑）

铁律（必须实现）：
1. 生产数据：outage_minutes > 60 且 outage_reason 为空 → 400 VALIDATION_ERROR
2. 生产数据：同一 station_id+record_date+shift_type 幂等更新（UPSERT）
3. 班次交接确认：POST /v1/shifts/{id}/confirm 验证 current_user.id == shift.handover_to_id，否则 403
4. 班次 handover：AI 生成摘要（异步调 OpenClaw 或本地模板），飞书推送接班人
5. 巡检触发：POST trigger 创建 work_type="inspection" 工单，state 直接设为 "approved"
6. 巡检逾期：next_due_at < NOW() 且无未完成的对应工单

完成后输出：
三类 API 的 curl 测试命令各一条 + 铁律验证测试（停输原因为空应报错）
```

---

### [T10] OPC-UA Bridge + Pulse Engine

**要@的文件**：

```
@contrib/industrial-oilgas-skills/OPCUA-BRIDGE-DESIGN.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin 的 OT 数据接入层。

读 @OPCUA-BRIDGE-DESIGN.md 了解 opcua-bridge 的完整设计（OPC-UA 连接、Tag 映射、Kafka 发布）。
读 @DESIGN-FINAL-LOCK.md §三（Kafka Topic 权威列表）确认消息格式。

需要实现两个独立服务：

1. opcua-bridge（独立进程）：
   - services/bridge/opc_ua_client.py（连接 OPC-UA Server，读取 Tag 值）
   - services/bridge/kafka_producer.py（发布到 ot.telemetry 和 ot.events topics）
   - 开发模式：MOCK_MODE=true 时生成随机传感器数据（15秒周期）
   - 消息格式：{"equipment_id": "C-001", "readings": {"vibration": 4.5, "temp": 82.3}, "ts": "ISO8601"}

2. Nexus Pulse Engine（Platform内部）：
   - platform/engines/pulse_engine.py（Kafka Consumer，消费 ot.telemetry/ot.events）
   - 处理逻辑：
     a. 写 equipment_readings（TimescaleDB hypertable）
     b. 更新 Redis Hash（key: readings:{equipment_id}）
     c. 评估告警规则（对照 alarm_rules 表）
     d. 如果触发告警，写 alarms 表并发布到 platform.alarms topic
     e. 更新设备 status（基于当前 P1/P2 告警数量）

OT/IT 边界铁律：
- opcua-bridge 只推 Kafka，不连 PostgreSQL，不连 Milvus，不暴露 HTTP API
- opcua-bridge 和 Platform 在不同 Docker 网络（DMZ vs 内网）

完成后输出：
docker compose up 启动 bridge + 30秒后确认 TimescaleDB 有数据的 SQL 查询
```

---

### [T11] MCP Server 定制扩展（Foundry 范式后大幅简化）

> ⚠️ **重要更新**：[T2.6] Auto-Generator 已经从 Ontology 自动生成所有 Object/Action/Function 的 MCP tools。
> [T11] 不再需要手写 30 个 tool。本任务只需要：
>
> 1.  调试 Auto-Generator 输出的 MCP tool（验证 schema 正确）
> 2.  实现少数几个不适合作为 Action/Function 的"系统调用"工具（如 `notify_user` 通用通知）
> 3.  写 MCP Server 的启动脚本和 Service Token 鉴权
>     主要工作量在 [T2.6] 而不是 [T11]。

> 架构范式（参见 INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §六）：
> MCP 是 AIP Layer 暴露 Ontology 的桥梁。
> 不需要在 Nexus 里写 intent 路由——LLM 自己决定调用哪些 Action/Function、以什么顺序。

**要@的文件**：

```
@contrib/industrial-oilgas-skills/NEXUS-OS-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/ARCHITECTURE-PROTOCOL-ANALYSIS.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
```

**提示词**：

```
请帮我实现 ClawTwin Nexus 的完整 MCP Server（工业 AI OS 系统调用层）。

先读 @NEXUS-OS-ARCHITECTURE.md §四 理解完整工具集设计（30+工具，含写操作）。
再读 @NEXUS-API-REFERENCE.md §八 了解协议格式。

核心设计原则（必须遵守）：
- Nexus MCP 是工业 OS 的"系统调用"：LLM 通过工具链完成复杂业务，无需 Nexus 预置 intent 路由
- 既有读取工具，也有写操作工具（Phase A 必须实现关键写操作）
- 所有工具共用 platform/services/*.py 业务层，不重复逻辑

需要实现：
- platform/routers/mcp.py（MCP Server 端点：POST /mcp）
- 支持 MCP 协议的两种方法：tools/list 和 tools/call

Phase A 必须实现的工具（15个）：

【读取工具（9个，无副作用）】
1. get_equipment_context(equipment_id)       → 设备完整上下文+决策包
2. get_station_overview(station_id)          → 场站概览（所有设备状态）
3. search_knowledge_base(query, layer?)      → 知识库语义搜索
4. get_active_alarms(station_id, priority?)  → 活跃告警列表
5. get_equipment_readings(equipment_id, metric?, hours?)  → 历史时序数据
6. get_work_order(work_order_id)             → 工单详情
7. list_equipment(station_id, status?)       → 设备列表
8. get_production_kpi(station_id, period?)   → 生产 KPI（输量/可用率/能耗）
9. get_shift_status(station_id)             → 当前班次+交接状态

【写操作工具（6个，HITL保护高风险）】
10. create_work_order(equipment_id, work_type, title, description, priority?, checklist_items?)
    → 创建工单（state=draft，自动通知 supervisor 审批）
11. acknowledge_alarm(alarm_id, reason?)
    → 确认告警（ISA-18.2 合规，记录操作人+时间）
12. shelve_alarm(alarm_id, duration_minutes, reason)
    → 搁置告警（reason 必填，记录 shelved_until）
13. record_production_data(station_id, date, data)
    → 录入日产量（outage_minutes>60 时 reason 必填）
14. submit_shift_handover(station_id, handover_to_id, notes?)
    → 提交交接班申请（需要接班人确认）
15. notify_user(user_id_or_role, message, urgency?)
    → 发送飞书通知（支持指定用户或角色）

认证：MCP 端点使用 Service Token 认证（Bearer ct-svc-openclaw-xxx），不用 JWT
安全：工具内部调用必须检查 token 对应的 station 权限

完成后输出：
1. tools/list 的 curl 命令
2. LLM 调用链示例：get_equipment_context → get_active_alarms → create_work_order 的端到端测试
```

---

### [T11b] clawtwin CLI 定制扩展（Foundry 范式后大幅简化）

> ⚠️ **重要更新**：[T2.6] Auto-Generator 已经从 Ontology 自动生成基础 CLI 命令：
>
> - `clawtwin object {list/get/search/show-links} <Type>`
> - `clawtwin action {list/call} <ActionName>`
> - `clawtwin function {list/call} <FunctionName>`
> - `clawtwin ontology {validate/list/diff}`
>   [T11b] 仅需实现：
>
> 1.  `clawtwin doctor` 系统健康检查
> 2.  友好别名（如 `clawtwin alarm ack <id>` → `clawtwin action call AcknowledgeAlarm`）
> 3.  输出格式化（rich/json/ids）
>     主要工作量在 [T2.6]。

> 设计原则：CLI 与 MCP 共用 ActionExecutor / FunctionExecutor / ObjectStore，不重复业务逻辑。

**要@的文件**：

```
@contrib/industrial-oilgas-skills/NEXUS-OS-ARCHITECTURE.md
@contrib/industrial-oilgas-skills/MASTER-ARCHITECTURE-AND-DEV-GUIDE.md
```

**提示词**：

```
请帮我实现 ClawTwin 的 clawtwin CLI 命令行工具（工业 OS 命令行）。

先读 @NEXUS-OS-ARCHITECTURE.md §五 了解 CLI 设计原则和命令规范。
架构要求：CLI 与 MCP Server 共用同一套 platform/services/*.py 业务层，不重复逻辑。

使用 Typer 实现，文件路径：platform/cli.py

必须实现的命令组（与 MCP 工具一一对应）：

【alarm 命令组】
clawtwin alarm list --station=<id> [--priority=P1|P2|P3] [--status=active]
clawtwin alarm acknowledge <alarm_id> [--reason="备注"]
clawtwin alarm shelve <alarm_id> --duration=<分钟> --reason="必填原因"

【workorder 命令组】
clawtwin workorder create --equipment=<id> --type=corrective|preventive|... \
  --title="标题" [--priority=urgent] [--dry-run]
clawtwin workorder list --station=<id> [--state=draft|pending_approval|...]
clawtwin workorder approve <wo_id>
clawtwin workorder done <wo_id> --notes="完工备注"

【equipment 命令组】
clawtwin equipment status <equipment_id>
clawtwin equipment list --station=<id> [--status=fault|warn]

【production 命令组】
clawtwin production record --station=<id> --date=today \
  --gas=21.36 --runtime=23.5 --energy=4820
clawtwin production kpi --station=<id> [--period=week|month]

【shift 命令组】
clawtwin shift status --station=<id>
clawtwin shift handover --to=<user_id> [--notes="备注"]

【kb 命令组】
clawtwin kb search "查询关键词" [--layer=L0|L1|L2|L3]

【system 命令组】
clawtwin doctor           # 系统健康检查（检查各服务连通性）
clawtwin doctor --verbose # 详细健康报告

输出格式：
- 默认：人类可读的彩色表格（使用 rich 库）
- --format=json：机器可读的 JSON（供 LLM 脚本化使用）
- --format=ids：只输出 ID 列表（供管道操作 xargs 使用）

实现铁律：
- CLI 不包含业务逻辑，只调用 services/*.py
- 认证：优先读 ~/.clawtwin/credentials（token），其次 CLAWTWIN_API_TOKEN 环境变量
- 错误：CLI 返回适当的 exit code（0=成功，1=业务错误，2=认证错误，3=系统错误）

完成后输出：
clawtwin alarm list --station=1 --priority=P1 的示例输出
clawtwin doctor 的示例输出
```

---

### [T11c] AgentRuntime 抽象 + OpenAPI Exporter + HiAgent/Dify 适配器

**要@的文件**：

```
@contrib/industrial-oilgas-skills/USER-ENVIRONMENT-DELIVERY-VALIDATION.md
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
```

**提示词**：

```
请实现 ClawTwin Foundry 的 AgentRuntime 抽象层（让 OpenClaw / HiAgent / Dify / Coze 可切换）。
依赖：T2.5 ActionExecutor + T2.6 Auto-Generator (MCP/HTTP)

⚠️ 范式约束（违反即拒绝）：
- 不要在 ActionExecutor / FunctionExecutor 内部 if 区分 Agent 平台
- 适配差异都收敛到 aip/agent_runtimes/<name>.py
- 同一个 Ontology 同时通过 MCP 和 OpenAPI 暴露，零差异

需要实现的目录与文件：
  platform-api/aip/
    openapi_exporter.py        ← FastAPI 自动生成 OpenAPI 3.0 + 各平台扩展
                                  · 支持 ?runtime=hiagent 返回火山引擎插件 JSON
                                  · 支持 ?runtime=dify 返回 Dify Plugin Manifest
                                  · 默认返回标准 OpenAPI 3.0
    agent_runtimes/
      _base.py                 ← AgentRuntime Protocol：
                                  - export_tool_descriptors(tools) -> dict
                                  - authenticate_request(headers) -> AgentActor
                                  - stream_response(result) -> AsyncIterator[bytes]
                                  - exception_to_response(exc) -> dict
      openclaw.py              ← Service Token + MCP / SSE
      hiagent.py               ← API Key + 火山引擎插件 schema + SSE
      dify.py                  ← Plugin Manifest YAML + Dify SSE 格式
      coze.py                  ← OAuth + Coze 插件
      registry.py              ← 全局注册表，按 settings.AGENT_RUNTIMES 加载

  platform-api/cli/
    agent.py                   ← clawtwin agent 命令组：
                                  · clawtwin agent list-runtimes
                                  · clawtwin agent export --runtime=hiagent > plugin.json
                                  · clawtwin agent export --runtime=dify > manifest.yaml
                                  · clawtwin agent test --runtime=openclaw --tool=AcknowledgeAlarm

  tests/aip/
    test_runtime_openclaw.py
    test_runtime_hiagent.py    ← Mock 火山引擎调用流，验证 OpenAPI 生成正确
    test_runtime_dify.py
    test_export_round_trip.py  ← 导出 → 导入第三方平台 → 调用回 Foundry 全链路

设计要点：
- AgentRuntime 实例不持有业务逻辑，只做 transport 适配
- 鉴权统一映射到 AgentActor（含 organization, station_ids, role, source_runtime）
- Action/Function 执行时 transport 字段写入 source_runtime（用于审计与限流）
- OpenAPI 自动包含 Action/Function 的 risk_level / approval_required 元数据，便于平台展示

完成标志：
- /v1/openapi 返回完整 OpenAPI 3.0 包含所有 Action/Function
- /v1/openapi?runtime=hiagent 返回火山引擎可直接导入的插件 JSON
- HiAgent 实测：导入插件 → 创建 Bot → 调 Foundry Action 全流程通
- 切换 settings.AGENT_RUNTIMES 不需要改任何业务代码
```

---

### [T7.5] IMS Connector 抽象 + 标准 Connector 包

**要@的文件**：

```
@contrib/industrial-oilgas-skills/USER-ENVIRONMENT-DELIVERY-VALIDATION.md
@contrib/industrial-oilgas-skills/INDUSTRIAL-FOUNDRY-ARCHITECTURE.md
```

**提示词**：

```
请实现 ClawTwin Foundry 的 IMS Connector 抽象（客户已有 ERP/CMMS/Historian 接入）。
依赖：T0.5 + T2.5 + Pipeline Runner

⚠️ 范式约束（违反即拒绝）：
- 不要为某客户 IMS 写一次性脚本（必须沉淀为 Connector 包）
- 不要在 Foundry 业务代码里 import sap_sdk / oracle_sdk
- Object Type YAML 必须声明 source_of_truth_strategy（铁律 32）

需要实现的目录与文件：
  platform-api/connectors/
    _framework/
      base.py                  ← BaseConnector：load_config / pull / push / on_action
      schema.py                ← ConnectorConfig Pydantic schema
      field_mapper.py          ← 通用字段映射 + enum_mapping 引擎
      conflict_resolver.py     ← SoT 策略实现（external_wins / merge_remote_wins / ...）
      probe.py                 ← clawtwin connector probe 实现
    erp/
      sap_pm/                  ← Phase A 必做（最常见客户场景）
        connector.yaml
        field_mapping_template.yaml
        transformer.py         ← SAP OData 特殊处理
        README.md
        tests/
      yonyou_nc/               ← Phase A 第二个真实客户场景
        ...
    historian/
      opcua_generic/           ← 复用 [T10] OPC-UA Bridge 实现，包装为 Connector
    generic/
      rest_api/                ← 兜底通用 REST 模板
        connector.yaml
        transformer.py.example

  platform-api/cli/
    connector.py               ← clawtwin connector 命令组：
                                  · clawtwin connector list
                                  · clawtwin connector probe --vendor=sap_pm --url=<...>
                                  · clawtwin connector init <vendor>  (从模板创建客户实例)
                                  · clawtwin connector run <name> [--dry-run]
                                  · clawtwin connector status <name>
                                  · clawtwin connector validate <yaml-path>

  ontology/object_types/work_order.yaml
    增加 source_of_truth_strategy:
      default: external
      external_system: sap_pm
      conflict_resolution: { strategy: external_wins, audit: required }

  ontology/action_types/create_work_order.yaml
    框架自动行为：source_of_truth=external 时先调 IMS 创建拿 external_id，再写 Foundry
    write_back 由 Connector.on_action(action_name, payload) 实现

  tests/connectors/
    test_sap_pm_pull.py        ← Mock SAP REST，验证拉取并映射为 WorkOrder Object
    test_sap_pm_push.py        ← Mock SAP REST，验证 CompleteWorkOrder 反向写
    test_yonyou_nc.py
    test_field_mapper.py
    test_conflict_resolver.py
    test_probe.py
    test_generic_rest.py

设计要点：
- BaseConnector 是 Pipeline Source 的特殊实现，与现有 Pipeline 框架无缝衔接
- Connector 配置 = 客户实例（不是 Connector 包本身），存在 platform-api/instances/<name>.yaml
- on_action() 由 ActionExecutor 在 effects 完成后调用（不阻塞主事务）
- on_action() 失败入死信队列（dead_letter_queue 表），不阻塞业务
- field_mapper 支持简单的 jq-like 路径表达式（不引入 jq 依赖，用纯 Python 实现）

完成标志：
- clawtwin connector probe 可识别 SAP PM OData 服务
- clawtwin connector run sap_pm_workorder_sync --dry-run 输出对账报告
- 真实模拟：SAP 创建工单 → ClawTwin 自动拉取 → AI 分析 → CompleteWorkOrder → 反向写 SAP
- 4 个连接器场景测试全部通过（SAP / 用友 / OPC-UA / generic REST）
- 测试覆盖率 ≥ 85%
```

---

### [T12] Studio 设备孪生视图 + DeviceIntelPanel

**要@的文件**：

```
@contrib/industrial-oilgas-skills/MODULE-DESIGN-STUDIO.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Studio 的设备孪生视图和 AI 智能面板。

代码仓：`clawtwin-studio/refine-clawtwin/`。实现路径相对于 `src/`；与 **PA-P1** 一致时，将本页挂到 Refine **`resources`** 的 `equipment`（或 `stations`）之 `show`/`list` 路由下，而不是只塞进 `Dashboard` Tabs。

读 @MODULE-DESIGN-STUDIO.md §二十七（DeviceIntelPanel V2）和 §二十八（useEquipmentIntel V2）。
读 @NEXUS-API-REFERENCE.md §二了解 Equipment API；**决策包**以 @DESIGN-FINAL-LOCK.md **GET /v1/equipment/{id}/decision-package** 为准（禁止引用已废弃 `/v1/tools/diagnose_equipment`）。

建议新建目录（与现有扁平 `*Section.tsx` 并存，便于 T12 后维护）：
- `pages/StationPage.tsx`（场站主页：左设备列表 + 右 TwinView；或 `pages/equipment/` 下分文件）
- `components/twin/EquipmentList.tsx`
- `components/twin/TwinPage.tsx`
- `components/twin/DeviceIntelPanel.tsx`（三栏布局）
- `hooks/useEquipmentIntel.ts`（**primary_action** 等来自 decision-package；AbortController 取消上次请求）
- `components/twin/UrgencyCountdown.tsx`
- `components/twin/AIInsightCard.tsx`
- `components/twin/WorkOrderDraftInline.tsx`
- `components/shared/CitationBadge.tsx`

铁律：
- DeviceIntelPanel 三栏：左=设备读数，中=AI洞察+主行动，右=工单草稿（tab切换）
- 主行动按钮颜色：emergency=红, warning=橙, info=蓝
- 点击"建工单"→ setTab("draft_wo")，不跳转页面
- 切换设备时取消上一个 fetch（AbortController）
- citations[] 必须渲染为 <CitationBadge>

MSW Mock（`mocks/handlers.ts`）：
  GET /v1/equipment → 返回 C-001（alarm状态，振动4.5mm/s）
  GET /v1/equipment/C-001/decision-package → 预设 AI 诊断结果与 citations

完成后输出：简述 DeviceIntelPanel 正常/告警/故障三态；变更文件列表；`pnpm build` 通过
```

---

### [T13] Studio 告警队列面板

**要@的文件**：

```
@contrib/industrial-oilgas-skills/MODULE-DESIGN-STUDIO.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/INDUSTRIAL-SCENARIOS-COMPLETE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Studio 的告警管理 UI（ISA-18.2 合规）。

代码仓：`clawtwin-studio/refine-clawtwin/`；路径相对于 `src/`。可与现有 `AlarmsListPanel.tsx` / `useAlarmsList.ts` **复用列表与 limit 门控逻辑**，再升为专页 + KPI。Refine **`resources.alarms`** 的 `list` 建议指向本页。

读 @MODULE-DESIGN-STUDIO.md §二十五（AlarmManager ISA-18.2）。
读 @NEXUS-API-REFERENCE.md §三、§十五。
读 @INDUSTRIAL-SCENARIOS-COMPLETE.md §四。

需要实现（新建建议放在 `components/alarm/`、`pages/`、`hooks/`）：
- `pages/AlarmPage.tsx`（KPI Dashboard + 队列）
- `components/alarm/AlarmQueuePanel.tsx`
- `components/alarm/AlarmRow.tsx`
- `components/alarm/ShelveModal.tsx`
- `components/alarm/AlarmKPIPanel.tsx`
- `hooks/useAlarms.ts`（列表 + 订阅 **GET /v1/sse/station/{station_id}** 中与告警相关事件，占位亦可）

UI 规则（ISA-18.2）：
- P1=红色，P2=橙色，P3=黄色，P4=灰色
- 搁置弹窗：时长选项（30/60/480分钟）+ 必填原因文本框（空则禁用确认）
- shelve/ack API 以 @DESIGN-FINAL-LOCK.md **§一.2** 为准（**POST .../shelve** 等）
- KPI：alarm_rate_per_10min（>1 标红）、standing_alarms、p1_response_compliance
- 告警率红线文案："当前告警率超出 ISA-18.2 建议（<1个/10min）"

完成后输出：组件树简述 + ShelveModal 的 reason 校验说明 + `pnpm build` 通过
```

---

### [T14] Studio 工单看板 + 表单

**要@的文件**：

```
@contrib/industrial-oilgas-skills/MODULE-DESIGN-STUDIO.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请帮我实现 ClawTwin Studio 的工单管理 UI。

代码仓：`clawtwin-studio/refine-clawtwin/`。可与 `CreateWorkorderSection.tsx`、`WorkordersListPanel.tsx`、`useWorkordersList.ts` 的 API 调用方式对齐；专页落地后可将 Dashboard 工单 Tab 链到本页或逐步瘦身。

读 @MODULE-DESIGN-STUDIO.md 工单相关章节了解看板设计。
读 @NEXUS-API-REFERENCE.md §四（工单接口）了解 API 格式。
读 @DESIGN-FINAL-LOCK.md §二a 中的 WorkOrderType 7种枚举和 WorkOrder ORM 字段。

需要实现（`clawtwin-studio/refine-clawtwin/src/`，建议 `components/workorder/` + `pages/`）：
- `pages/WorkOrderPage.tsx`（看板主页；Refine **`resources.workorders`** 的 `list` 可指向此页或内嵌 Kanban）
- `components/workorder/KanbanBoard.tsx`（列：待审批 / 已审批 / 进行中 / 已完成；映射 **state** 为小写：`pending_approval`|`approved`|`in_progress`|`done` 等，与 LOCK 一致）
- `components/workorder/WorkOrderCard.tsx`
- `components/workorder/WorkOrderForm.tsx`
- `components/workorder/WorkOrderDetail.tsx`（审批操作走 **POST /v1/hitl/workorders/{id}/***，非 PATCH 迁状态）
- `components/workorder/PTWBadge.tsx`

工单表单字段（根据 work_type 动态显示）：
  公共字段：title, work_type(下拉), priority, description, assignee
  inspection 类型额外显示：inspection_route, checklist_items（可编辑列表）
  corrective/emergency 类型：显示关联的告警 ID
  任何类型：permit_required 开关（开启后显示 permit_type 选择 + permit_number 输入框）

work_type 中文显示：
  corrective=故障处理, preventive=预防维护, inspection=例行巡检,
  shutdown=停机大修, emergency=紧急处置, calibration=仪表校准, improvement=技改

完成后输出：inspection 类型创建表单 UI 要点 + 变更文件列表 + `pnpm build` 通过
```

---

### [T15] Studio 生产/班次/巡检页面

**要@的文件**：

```
@contrib/industrial-oilgas-skills/INDUSTRIAL-SCENARIOS-COMPLETE.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
```

**提示词**：

```
请帮我实现 ClawTwin Studio 的三个工业运营页面。

代码仓：`clawtwin-studio/refine-clawtwin/`。路径相对于 `src/`。当前 `ProductionRecordsSection.tsx`、`ShiftsSection.tsx`、`InspectionOpsSection.tsx` 已实现 Dashboard 级能力：本任务将其 **提升为独立 `pages/*` +（可选）Refine `resources`**，或抽取共享 hook 避免重复。

读 @INDUSTRIAL-SCENARIOS-COMPLETE.md §七.1（Studio UI补充需求）了解页面设计要求。
读 @NEXUS-API-REFERENCE.md §十二（生产数据）、§十三（班次）、§十四（巡检）了解 API 格式。

需要实现：

1. 生产数据页面：
   - `pages/ProductionPage.tsx`
   - 功能：月历视图 + 今日数据录入表单 + 月度 KPI 图表
   - 录入表单：输量/运行时长/耗电量/停输时长（>60min强制填原因）

2. 班次交接页面：
   - `pages/ShiftHandoverPage.tsx`
   - 功能：当前班次信息 + 发起交接表单 + 历史班次列表
   - 发起交接：选择接班人 → 显示 AI 生成摘要预览 → 确认发送
   - 接班人视图：收到摘要 → 确认接班按钮（POST /v1/shifts/{id}/confirm）

3. 巡检管理页面：
   - `pages/InspectionPage.tsx`
   - 功能：巡检计划列表 + 今日到期提醒 + 逾期告警（红色高亮）
   - 操作：点击计划 → 触发创建巡检工单 → 跳转到工单详情

铁律：
- 接班确认按钮只对 handover_to_id 对应的用户显示（从 JWT 解析当前用户）
- 生产数据停输原因：outage_minutes > 60 时，表单验证在前端也做（不等后端报错）

完成后输出：三个页面的主要组件树 + `pnpm build` 通过
```

---

### [T16] Studio Admin 管理页面

**要@的文件**：

```
@contrib/industrial-oilgas-skills/MODULE-DESIGN-STUDIO.md
@contrib/industrial-oilgas-skills/NEXUS-API-REFERENCE.md
```

**提示词**：

```
请帮我实现 ClawTwin Studio 的 Admin 管理后台。

代码仓：`clawtwin-studio/refine-clawtwin/`。路径相对于 `src/`。

读 @MODULE-DESIGN-STUDIO.md §三十三（Admin 后台页面）了解页面结构。
读 @NEXUS-API-REFERENCE.md §十一（Admin接口）了解 API 格式。

需要实现（sys_admin 角色专用）：
- `pages/admin/AdminLayout.tsx`（Admin 二级布局，左侧 AdminNav）
- `pages/admin/AdminHome.tsx`（系统总览：设备数/告警数/工单数/AI准确率）
- `pages/admin/UsersPage.tsx`（用户管理：创建/编辑/场站权限分配/飞书绑定邀请）
- `pages/admin/StationsPage.tsx`（场站管理：创建/编辑/设备管理）
- `pages/admin/KnowledgePage.tsx`（知识库管理：按L0/L1/L2/L3分层展示，支持上传）
- `pages/admin/SystemPage.tsx`（系统健康：各组件状态 + clawtwin doctor 输出）
- `components/admin/HealthIndicator.tsx`（健康状态指示器：绿/黄/红）

权限保护：
- AdminLayout 包裹路由时检查 user.role === 'sys_admin'，否则 403 页面
- 危险操作（删除用户/设备）需要二次确认 Dialog

完成后输出：AdminHome 布局描述 + `pnpm build` 通过
```

---

### [T17] AgentRuntime + Feishu 集成调试（OpenClaw 主线 + HiAgent 验证）

**要@的文件**：

```
@contrib/industrial-oilgas-skills/USER-ENVIRONMENT-DELIVERY-VALIDATION.md
@contrib/industrial-oilgas-skills/ARCHITECTURE-FINAL-REVIEW.md
@contrib/industrial-oilgas-skills/OPENCLAW-SETUP-GUIDE.md
@contrib/industrial-oilgas-skills/DESIGN-FINAL-LOCK.md
```

**提示词**：

```
请完成 ClawTwin 的多 Agent 平台 + Feishu 端到端集成。
依赖：T11c AgentRuntime 抽象 + T17 之前的所有任务

代码仓版图（按需打开多根工作区）：
  - **OpenClaw**：本仓库 openclaw（或独立安装的 OpenClaw Gateway）；Skills 见 `contrib/industrial-oilgas-skills/industrial-*/SKILL.md` 与 **`OPENCLAW-SETUP-GUIDE.md`**。
  - **Nexus / Foundry HTTP**：**`clawtwin-platform/platform-api/`**（FastAPI：`feishu_webhook`、`mcp_http`、`hitl_workorders`、`ai_jobs` 等）。
  - **Studio（Phase A UI）**：**`clawtwin-studio/refine-clawtwin/`**（Refine；“导出 HiAgent 插件”若未做 UI，可先用 **`aip/`** OpenAPI exporter 或手工从 **`GET /v1/openapi.json`** 截取）。
设计/MCP/SSE/API 路径以 **`DESIGN-FINAL-LOCK.md`** 为最高权威。

⚠️ 验收必须覆盖（铁律 30/33）：
1. OpenClaw 路径全功能可用（主交付）
2. HiAgent 路径基本可用（验证 AgentRuntime 抽象正确）
3. 飞书消息直进 AgentRuntime（不经 Foundry）
4. 飞书卡片回调进 Foundry（处理 Action）
5. 飞书 OAuth + 部门映射 → Foundry Marking

任务清单：

【主线：OpenClaw + Feishu】
1. 配置 OpenClaw：
   - 安装 Sage Skills（industrial-assistant/analytics/admin/shift/production/inspection）
   - 配置 MCP Server 指向 Foundry：优先 **`http://platform-api:8000/v1/mcp`**（**DESIGN-FINAL-LOCK §1.7**；兼容 **`/mcp`** 别名时在网关/反代层与 OpenClaw `mcpServers` 配置保持一致）
   - 配置 Feishu Channel Plugin（Bot Token + Webhook Secret）
   - 配置 Service Token（写入 Foundry agent_runtimes 表，标记 source_runtime=openclaw）

2. 验证飞书集成（铁律 33 验收）：
   - 飞书对话 → 直接进 OpenClaw Feishu Plugin（不经过 Foundry）
   - Foundry 仅 **POST /v1/feishu/events**（**DESIGN-FINAL-LOCK §1.9**：challenge、`card.action.trigger` 等）；勿使用已废弃别名路径作为权威
   - 测试：飞书 @bot "C-001 振动高怎么处理"
     → 60s 内收到带 citations 的飞书卡片
     → llm_traces 表有完整 trace（Phase A **若该表迁移未合并**，则验收改为：审计 **`log_audit_event` / audit sink** + 可追溯 request id）
     → **action_traces** 或对应用 **Action** 路由无写入（若为只读工具链）（Phase A 以 **audit_logs**/审计 sink 可追溯为准亦可）

【验证：HiAgent + Feishu】
3. 在火山引擎 HiAgent 配置 Bot：
   - 在 ClawTwin Studio 点 [导出 HiAgent 插件] → 下载 OpenAPI JSON
   - 上传到 HiAgent 控制台 → 创建插件
   - 配置 API Key（Foundry 生成的 Service Token，标记 source_runtime=hiagent）
   - 创建 Bot，绑定插件 + 飞书企业版
   - 测试：在飞书企业版问相同问题 → 应得到同样答案
   - **llm_traces** 或其它统一 trace 存储中可区分 **source_runtime**（表未迁移则用审计/日志等价证明）

【飞书 OAuth + Marking】
4. 配置飞书 OAuth → Foundry SSO（infra/auth/feishu_bridge.py）：
   - 用户首次登录 Studio：OAuth 跳转飞书 → 拉取 user.id + departments
   - department_to_station_ids 配置表：飞书部门 → station_ids 映射
   - 自动生成 ClawTwin JWT，含 station_marking
   - 验证：A 部门用户登录后只能看到 A 部门 station 的 Object

【飞书审批卡片回调】
5. 验证 ApproveWorkOrder 飞书回调：
   - 用户在飞书审批卡片点 [同意]
   - 飞书 → **POST /v1/feishu/events** → 验签 → 解析卡片 payload
   - 调用工单批准等价路径：**POST /v1/hitl/workorders/{id}/approve**（**DESIGN-FINAL-LOCK §1.3**；若已实现 ActionExecutor/OpenClaw 工具链映射，写明衔接点并保持唯一写入口）
   - audit_logs（及已迁移时的 llm_traces / action_traces）可追踪
   - 反向写 SAP（如配了 SAP PM Connector）

【主动推送】
6. 验证晨报推送：
   - APScheduler 每天 8:00 触发 daily_briefing_job
   - FunctionExecutor.call("BuildMorningBriefing", station_id=...)
   - providers/notifier/feishu.py 推卡片到对应群
   - 卡片含上一日告警/工单/生产关键指标

完成标志（验收 CheckList，至少 12 项）：
- [ ] OpenClaw 飞书对话端到端通
- [ ] HiAgent 飞书对话端到端通
- [ ] llm_traces 区分 source_runtime
- [ ] 飞书卡片审批端到端通（含反向写 IMS）
- [ ] 飞书 OAuth + 部门映射 → Marking 隔离正确
- [ ] 晨报飞书主动推送
- [ ] 切换 Agent 平台不需要改 Foundry 业务代码
- [ ] connector probe 真实识别 SAP PM 端点
- [ ] 工单 SoT=external 全流程（拉/写回/冲突解决）
- [ ] OT 数据不出客户域（验网络分区）
- [ ] Approval Queue 拦截 high-risk Action
- [ ] CLI / MCP / OpenAPI 三种入口结果一致
```

---

### [T18] Demo 数据 + E2E 验收

**要@的文件**：

```
@contrib/industrial-oilgas-skills/DEVELOPMENT-CONTRACT.md
@contrib/industrial-oilgas-skills/TESTING-GUIDE.md
```

**提示词**：

```
请帮我准备 ClawTwin Phase A 的 Demo 数据和 E2E 验收场景。

代码仓：**`clawtwin-platform/platform-api/`**（pytest、脚本、Alembic、compose 均相对此仓或其上级 **`clawtwin-platform/`**；勿混用 **openclaw** 源码根）。若 monorepo 外独立克隆，则在 **`platform-api`** 内执行 **`python -m pytest`**。

读 @DEVELOPMENT-CONTRACT.md §九（Phase A Demo必须跑通的场景）了解7个验收场景。
读 @TESTING-GUIDE.md 了解测试策略和 pytest/Vitest 配置。
HTTP 断言路径以 **`DESIGN-FINAL-LOCK.md`** 为准。

任务：
1. Demo 数据脚本：**`scripts/seed_demo_data.py`**（相对 **`platform-api/`**；若没有 `scripts/` 目录则新建并记入 README）：
   - 场站：高坪站（station_id=1）
   - 设备：C-001（压缩机，status=warn，振动4.5mm/s，predicted_breach_minutes=83）
   - 设备：C-002（备用压缩机，status=standby）
   - 告警：C-001 P2振动告警（active，未确认）
   - 工单：WO-001（in_progress，corrective，分配给操作员）
   - 班次：今日早班（active，张操作员）
   - 生产记录：今日21.36万方（已录入）
   - 巡检计划：每日早班巡检（今日已完成）
   - 用户：admin（sys_admin）+ operator（operator）+ supervisor（supervisor）
   - 知识库：L0 SY/T 6320 标准摘要 + L1 C-001 设备手册关键章节

2. E2E 验收测试：**`tests/e2e/test_demo_scenarios.py`**（相对 **`platform-api/`**，与既有 pytest 惯例一致）
   场景1：设备异常发现（GET /v1/equipment/C-001/decision-package）
   场景2：工单全流程（draft→**pending_approval**→approved→in_progress→done；迁移名以 **DESIGN-FINAL-LOCK / HITL 路由** 为准）
   场景3：告警搁置（需要 reason，60分钟）
   场景4：班次交接（handover + confirm by 接班人）
   场景5：生产数据录入（含校验：停输>60min必须有原因）

3. **docker-compose.demo.yml**：放在 **`clawtwin-platform/`** 仓根（或与现有 compose 并排），沿用 **`platform-api`** 服务名与健康检查；compose 不包含 OpenClaw 权重/vLLM 时须在 README 写明外置拓扑。

完成后输出：`docker compose -f docker-compose.demo.yml up --build`（在正确目录执行）后的验收清单
```

---

## 六、任务并行安排建议

```
Day 1（今天开4个任务，全部可并行）：
  Cursor Tab 1: [T0.5] Ontology Loader（后端工程师A，最高优先）
  Cursor Tab 2: [T1] 数据库 Schema（后端工程师A，T0.5 同步进行）
  Cursor Tab 3: [T2] Auth + JWT（后端工程师B）
  Cursor Tab 4: [T2.5] ActionExecutor + FunctionExecutor + ObjectStore（后端工程师A，T0.5+T1 完成后）
  Cursor Tab 5: [T2.6] Auto-Generator HTTP/MCP/CLI（后端工程师B，T2.5 完成后）
  Cursor Tab 6: [T4] Studio Shell（前端工程师）

Day 3（T1+T2完成后）：
  Cursor Tab 1: [T5] 告警管理
  Cursor Tab 2: [T6] 工单FSM
  Cursor Tab 3: [T7] 知识库RAG
  Cursor Tab 4: [T12] Studio设备面板（依赖T4完成）

Day 7（T5+T6完成后）：
  Cursor Tab 1: [T7.5] IMS Connector 框架 + SAP PM 包（后端工程师B，关键交付能力）
  Cursor Tab 2: [T8]   AI Jobs + Scheduler
  Cursor Tab 3: [T9]   生产/班次/巡检 Object/Action
  Cursor Tab 4: [T13]  Studio告警UI
  Cursor Tab 5: [T14]  Studio工单UI

Day 12（大部分完成后）：
  Cursor Tab 1: [T10]  OPC-UA Bridge（连接 connectors/scada_dcs/opcua_generic/）
  Cursor Tab 2: [T11c] AgentRuntime 抽象 + OpenAPI Exporter + HiAgent 适配器
  Cursor Tab 3: [T15]  Studio运营页面
  Cursor Tab 4: [T16]  Admin页面（含 Connector 管理 / AgentRuntime 管理）
  Cursor Tab 5: [T17]  AgentRuntime+Feishu 端到端（OpenClaw 主线 + HiAgent 验证）

Day 18（最终阶段）：
  Cursor Tab 1: [T18] Demo数据+E2E验收（覆盖 4 个客户场景：央企+SAP / 大企+Maximo / 中企+用友 / 小企+SaaS）
  Cursor Tab 2: Bug修复（按E2E报告处理）
```

---

## 七、通用防错提示词前缀（每个任务都加在最前面）

```
我在开发 ClawTwin 工业场站智能操作系统的 [模块名] 模块。

必须遵守的铁律（违反任何一条都是错误）：
1. API 路径以 @DESIGN-FINAL-LOCK.md §一 为准，不使用旧路径
2. 工单字段名是 state（不是 status），初始值 "draft"（小写）
3. station_id 从 JWT 取，不从请求体取
4. 设备状态枚举：running|standby|warn|alarm|fault|maintenance|commissioned|offline
5. 工单类型枚举：corrective|preventive|inspection|shutdown|emergency|calibration|improvement
6. 工作在正确克隆目录：后端 **`clawtwin-platform/platform-api/`**、Phase A 前端 **`clawtwin-studio/refine-clawtwin/`**；目录图见 **`DEV-QUICKSTART.md` §〇**。**pytest / Alembic** 仅以 **`platform-api/`** 为 cwd（勿在 **`openclaw`** 根裸跑），见 **`TESTING-GUIDE.md` §二.0**

我提供的 @文件 是权威来源，请先读完再动手，不要凭记忆或训练数据假设 API 格式。
完成后请输出：变更文件列表 + 一个 curl/测试验证命令。

任务：
[粘贴上面各任务的提示词]
```

---

## 八、代码 Review 检查清单

每个 PR 合并前，确认：

```
□ API 路径与 NEXUS-API-REFERENCE.md 一致（无拼写差异，无版本混用）
□ 工单 state 字段全小写，没有 status/STATUS/DRAFT
□ 设备状态没有旧的 "normal"（改为 "running"）
□ **`require_station_access`**（或等价）对**隐式场站**校验了（没有裸 `station_id` 仅从 body 信）
□ 有 audit_log 调用（关键操作）
□ 飞书 Webhook 端点没有处理 im.message.receive_v1
□ 停输时长 > 60 分钟的验证有实现
□ 接班确认接口有 handover_to_id 验证
□ 测试文件存在（至少一个正常路径 + 一个 403 测试）
□ citations[] 字段在 AI 相关响应中有返回
□ pytest / alembic 相关说明或 CI 脚本默认 cwd = clawtwin-platform/platform-api/（与 TESTING-GUIDE.md §二.0、DEV-QUICKSTART.md §〇 一致）
```

---

_本文档是 ClawTwin Phase A 并行开发的操作手册。直接复制各任务的 @文件 + 提示词到 Cursor 对话框即可。_
