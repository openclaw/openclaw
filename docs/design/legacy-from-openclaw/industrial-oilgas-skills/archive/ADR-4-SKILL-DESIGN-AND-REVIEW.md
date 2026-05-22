# ClawTwin 架构决策记录 ADR-4.0

## Skill 设计原则正本清源 · 整体方案全面评审

**版本**：ADR-4.0 · 2026-05-08  
**纠正**：ADR-3.0 中 role-based Skill 设计错误，本文为最终定稿  
**原则**：Skill = AI 能力，不是用户角色

> **⚠️ 勘误（2026-05）— L3 存储修正**：
> 本文档引用 `OpenClaw memory-wiki` 作为 L3 存储已过时。
> **最终决策：L3 存于 Platform 自有 PostgreSQL（`kb_documents` layer='L3'）+ Milvus。**
> 详见 `MODULE-DESIGN-PLATFORM.md §12.4`。

---

## 一、Skill 设计原则——用户的判断完全正确

### 1.1 观察 OpenClaw 现有 Skills 的设计规律

```
openclaw-testing      → "Choose, run, rerun, or debug OpenClaw tests"
                         能力：测试运行/调试
openclaw-pr-maintainer → "Review, triage, close, label, or land PRs"
                          能力：PR 维护流程
karpathy-llm-wiki     → "Use when building/maintaining a knowledge base"
                          能力：知识库管理方法
blacksmith-testbox    → "Run Blacksmith Testbox for CI-parity checks"
                          能力：特定工具的运行方法
gitcrawl              → "OpenClaw issue and PR archive search"
                          能力：特定搜索方法
```

**规律：Skill = 一种 AI 能力/方法，与"谁在使用"无关**

每个 Skill 描述的是：

- AI 在什么情况下激活这个能力（`description` 中的触发场景）
- AI 用什么方法完成任务（tools + system prompt + workflow）
- 用户选择安装什么 Skill，取决于他们要做什么任务，而不是他们是谁

### 1.2 ADR-3.0 的错误

```
❌ 错误（role-based）：
  industrial-station-agent   → "场站值班员、运营工程师加载此技能"
  industrial-knowledge-admin → "知识管理员、安全工程师加载此技能"
  industrial-reporting       → "区域管理层、安全总监使用"

问题：
  · 角色捆绑能力，但用户的需求不按角色边界划分
  · 一个小公司工程师可能同时做运营 + 知识管理 + 看报表
  · 角色一变，就要换 Skill，配置成本高
  · Skills 之间能力重复（例如 kb_search 在 station-agent 和 knowledge-admin 都有）
```

### 1.3 正确的设计：能力/方法导向（Capability-based）

```
✅ 正确（capability-based）：
  industrial-twin      → "Use when reading/interpreting real-time equipment state"
  industrial-kb        → "Use when searching industrial knowledge, procedures, or standards"
  industrial-workorder → "Use when creating or tracking maintenance work orders"
  industrial-analytics → "Use when analyzing trends, reports, or anomaly detection"

优点：
  · 每个 Skill 是一个自包含能力，与使用者角色无关
  · 用户根据要做什么任务，安装对应能力
  · 能力可以自由组合，覆盖任意角色需求
  · 不同场景复用同一 Skill（manager 和 operator 都可以用 industrial-twin 查设备状态）
```

---

## 二、OpenClaw 部署模式澄清——每个用户 vs 每个场站

### 2.1 用户说"每个用户有自己的 OpenClaw"

这是关键前提。在 ClawTwin 场景下：

```
每个用户（工程师/管理员/值班员）有自己的 OpenClaw Gateway 实例
  ↓
用户在自己的 OpenClaw 安装适合自己任务的 Skills
  ↓
用户通过飞书或 Studio 与自己的 Agent 交互
  ↓
用户的 Agent 调用 ClawTwin Platform 的 Industrial Tool API
  （Platform 通过 ABAC 权限控制该用户能访问哪些场站/设备）
```

### 2.2 这意味着 Cron 和 TaskFlow 也是"按能力"配置

```
❓ 问题：晨报 Cron 放哪里？

旧想法（错误）：
  industrial-station-agent skill 包含 Cron → 每个装了这个 Skill 的用户都发晨报
  （结果：值班员、工程师、管理员每人收一份重复晨报，还是不同内容？）

正确做法（能力分离）：
  Cron 任务是场站级别的自动化，不是个人 Skill 的一部分

  方案 A（推荐，已选定）：Platform 内置 Scheduler + 直接推飞书
    Platform platform-api 内置 APScheduler
    Scheduler 直接调用 vLLM API 生成报告文本
    Scheduler 直接调用 Feishu Bot API 推送消息（不经 OpenClaw）
    好处：Cron 集中管理，不依赖用户 OpenClaw 在线状态

  方案 B（备选）：专门的"场站监控 Agent"（非用户 Agent）
    部署一个独立的 OpenClaw Agent（没有人类用户的 Agent）
    这个 Agent 专门做 Cron 自动化（晨报/告警轮询）
    加载 industrial-analytics + industrial-twin 两个 Skill
    向值班群推送消息
```

**选择方案 A**：Cron 放在 Platform 内（platform-api 的 Scheduler 模块），这样用户 Skills 干净，只定义能力，不包含站级自动化。

---

## 三、正确的 4 个工业 Skill 定义

### Skill 1：`industrial-twin`

```yaml
name: industrial-twin
description: >
  Use when reading real-time equipment state, interpreting sensor data,
  checking thresholds, or understanding what a piece of industrial equipment
  is currently doing. Covers Ditto digital twin queries and OPC-UA live data.
```

**AI 能力**：

- 读取设备实时状态（Ditto）
- 比较当前值与阈值
- 生成设备状态摘要
- 提供 Studio 3D 深链（点击跳转到设备）

**工具**：`twin_read(equipment_id)` → Platform `/v1/objects/equipment/{id}`

**System prompt 扩展**：

- 实时数据不等于物理真值，以现场仪表为准
- 状态描述必须注明时间戳（数据来自几点）

---

### Skill 2：`industrial-kb`

```yaml
name: industrial-kb
description: >
  Use when searching industrial procedures, standards, regulations, OEM manuals,
  or station-specific maintenance history. Always cite sources (L0-L3).
  Covers Milvus knowledge search, GraphRAG relationship queries, and wiki L3 memory.
```

**AI 能力**：

- L0-L2 文档语义搜索（Milvus）
- 跨文档关系推理（GraphRAG）
- L3 场站历史记忆查询（OpenClaw wiki search，原生工具，无需 Platform）
- 严肃推理：多跳证据链 + citations + 置信度

**工具**：

- `kb_search(query, layer?, equipment_type?)` → Platform `/v1/tools/kb/search`
- `graph_query(entity, depth?)` → Platform `/v1/tools/graph/query`
- `wiki_search(query)` → OpenClaw 原生 wiki search（L3，无需 Platform）

**System prompt 扩展（核心）**：

```
每条知识查询结果必须包含：
  · citations[]（来源：L0/L1/L2 文档章节 或 L3 工单编号）
  · confidence（0-1，< 0.6 时明确说"建议核实"）
  · 知识优先级：L3 场站经验 > L2 内部规程 > L1 OEM 手册 > L0 国标

禁止：
  · 无 citations 的故障诊断结论
  · 超出已知知识边界的推断
```

---

### Skill 3：`industrial-workorder`

```yaml
name: industrial-workorder
description: >
  Use when drafting maintenance work orders, creating inspection requests,
  or managing the HITL approval workflow for field operations.
  Never silently executes field actions — all outputs are drafts pending human approval.
```

**AI 能力**：

- 结合 industrial-kb 的推理结论生成工单草稿
- HITL 流程：草稿 → 飞书审批卡片 → 人工确认 → 写 PostgreSQL + L3 wiki

**工具**：`workorder_draft(equipment_id, symptom, steps?)` → Platform `/v1/tools/workorder/draft`

**TaskFlow 工作流**：

- `work-order-hitl.lobster`：草稿 → 飞书消息卡片 → 确认/拒绝 → 归档 + L3 写入

**System prompt 扩展**：

```
工单草稿必须包含：
  · 设备标签/ID、现象描述、建议步骤（编号）
  · 危险点/必要隔离（来自 kb_search）
  · "Draft — 需要人工审批，未提交"的明确标注
  · 引用知识来源

绝对禁止：
  · 声称已提交/已批准工单
  · 未经审批推荐执行任何现场操作
```

---

### Skill 4：`industrial-analytics`

```yaml
name: industrial-analytics
description: >
  Use when analyzing equipment trends, generating KPI reports, detecting anomalies
  with AI time-series models, or querying historical operational data.
  Covers MOIRAI anomaly detection, TimescaleDB historical queries, and trend analysis.
```

**AI 能力**：

- MOIRAI 2.0 时序异常检测（含 72h 预测 + 置信区间）
- 历史时序数据查询（TimescaleDB）
- KPI 聚合报告生成
- 设备健康趋势分析

**工具**：

- `anomaly_detect(equipment_id, metrics[], window?)` → Platform `/v1/tools/anomaly/detect`
- `historical_query(equipment_id, metrics[], start, end)` → Platform `/v1/data/history/{id}`
- `kpi_report(station_id, period?)` → Platform `/v1/analytics/kpi/{station_id}`
- `trend_analysis(equipment_id, metric)` → Platform `/v1/analytics/trend`

**System prompt 扩展**：

```
异常检测结论格式：
  · 异常标志（true/false）
  · 趋势描述（单调上升/周期性/突变）
  · 72h 预测值 + 置信区间
  · citation: "MOIRAI-2.0:{equipment_id}:{timestamp}"
  · confidence < 0.5：说明"数据不足，建议增加观测窗口"
```

---

## 四、用户安装 Skill 的实际场景

```
场站值班工程师（需要做什么）：
  · 查设备当前状态 → industrial-twin
  · 查 C-001 故障对应的处置方法 → industrial-kb
  · 写工单 → industrial-workorder
  安装：industrial-twin + industrial-kb + industrial-workorder

区域管理人员（需要做什么）：
  · 查本周多个场站的 KPI → industrial-analytics
  · 查某设备的长期健康趋势 → industrial-analytics
  · 偶尔查一个技术标准 → industrial-kb
  安装：industrial-analytics + industrial-kb

安全/知识管理员（需要做什么）：
  · 查标准文件 → industrial-kb
  · 审查工单历史 → industrial-workorder（历史查询）
  · 上传新文档（通过 Studio Admin，不通过 Skill）
  安装：industrial-kb + industrial-workorder

小公司全能工程师（需要做什么）：
  · 以上所有任务都要做
  安装：industrial-twin + industrial-kb + industrial-workorder + industrial-analytics
```

---

## 五、Cron 和 TaskFlow 的正确归属

### 5.1 Cron（站级自动化）→ 放在 Platform Scheduler

```python
# platform-api/scheduler.py（APScheduler）

@scheduler.scheduled_job("cron", hour=7, minute=0)
async def morning_briefing(station_id: str):
    """每天 07:00 生成晨报并通过 OpenClaw 推飞书"""
    # 1. 调用 kpi_report + anomaly_detect_batch（内部调用，无需走 Skill）
    # 2. 生成晨报 Markdown
    # 3. 调用 OpenClaw API → 触发场站 Agent → 推飞书
    pass

@scheduler.scheduled_job("cron", minute=0)
async def anomaly_poll(station_id: str):
    """每小时轮询异常"""
    # 1. MOIRAI batch 检测
    # 2. 如有 P1/P2 异常 → 触发 anomaly-escalation TaskFlow
    pass
```

### 5.2 TaskFlow（HITL 工作流）→ 放在 Platform（由 Skill 工具调用触发）

```
工单 HITL 流程：
  1. 用户 Agent 调用 workorder_draft → 生成草稿（Platform 存入 DB）
  2. Platform → 触发 TaskFlow work-order-hitl → 推飞书审批卡片
  3. 值班员在飞书确认/拒绝
  4. Platform → 写 PostgreSQL（工单记录）+ 触发 L3 wiki 写入
  （Platform 直接管理这个流程，OpenClaw 只是调用了 workorder_draft 工具）
```

**结论：Cron 和 TaskFlow 都属于 Platform，不属于 Skill。**  
Skills 只定义 AI 能力（工具 + 推理规范），不包含自动化调度。

---

## 六、整体方案全面评审

### 6.1 架构正确性检查

```
✅ Platform 边界清晰（ADR-2.0 已确认）：
  · 我们写的代码：Ontology API + 6 个 Tool 服务 + Scheduler + TaskFlow 引擎
  · 外部独立产品：OpenClaw / Qwen3.6 vLLM / Feishu（接口调用）
  · 开源基础设施：Ditto / Kafka / Milvus / PostgreSQL / MinIO / Redis

✅ 知识库分层清晰（ADR-1.0 已确认）：
  · L0-L2 → Milvus + LlamaIndex（向量检索）
  · L3 → OpenClaw memory-wiki（场站记忆）
  · 关系推理 → GraphRAG（Parquet in MinIO，不是图 DB）

✅ Skill 设计原则（本文 ADR-4.0 确认）：
  · 4 个能力导向 Skills（twin/kb/workorder/analytics）
  · Cron 和 TaskFlow 在 Platform，不在 Skill

❌ 发现新问题：Skill 与 Platform Scheduler 的触发关系需要明确
  → Platform Scheduler 如何"通过 OpenClaw"推送消息？
  → 解决：Platform 直接调用 Feishu Bot API（不经 OpenClaw）
           Platform Scheduler → 直接发 Feishu 消息 → 不依赖 OpenClaw 在线
```

### 6.2 用户流程完整性检查

```
流程 1：凌晨报警（无用户操作）
  Platform Scheduler（每小时）→ MOIRAI 检测 → P1 异常
  → Platform 直接发飞书告警卡片（不经 OpenClaw）
  → 用户点击"查看详情" → 打开 Studio 深链
  → 用户回复飞书"详细分析" → OpenClaw Agent → 调用 industrial-twin + industrial-kb
  ✅ 完整，无断点

流程 2：用户主动查询（工作时间）
  用户飞书："C-001 现在怎么了？"
  → OpenClaw Agent（加载了 industrial-twin） → twin_read
  → 状态摘要 + Studio 深链 → 飞书回复
  ✅ 完整

流程 3：生成工单
  用户飞书："帮我给 C-001 建个检修工单"
  → OpenClaw（加载了 industrial-kb + industrial-workorder）
  → kb_search（查处置规程）→ workorder_draft（生成草稿）
  → Platform 推飞书审批卡片 → 主管确认
  → Platform 写 PostgreSQL + 触发 L3 wiki 写入
  ✅ 完整

流程 4：查看 3D 孪生（PC 端）
  用户打开 ClawTwin Studio → 3D 场景渲染（Babylon.js WebGPU）
  → 点击 C-001 → 右侧面板调用 /v1/objects/equipment/C-001
  → 实时数据 + 历史图表 + 相关工单列表
  → 点击"AI 分析" → Studio 内的 AI 对话（OpenClaw 集成）
  ✅ 完整（需要 Studio 内嵌 OpenClaw 对话）

流程 5：上传新知识文档
  知识管理员打开 Studio Admin → 上传 PDF（新 OEM 手册）
  → Platform ingestion-service → LlamaIndex 分块 → Milvus
  → 触发 GraphRAG 增量重建（异步）
  ✅ 完整

流程 6：晨报
  Platform Scheduler 07:00 → kpi_report + anomaly_detect_batch
  → Qwen3.6 生成晨报 Markdown（Platform 内部调用 vLLM API）
  → 直接发飞书群消息
  ✅ 完整（平台内置，不经 OpenClaw）
```

### 6.3 发现并补充的缺失细节

**缺失 1：Platform 如何直接发飞书消息（不经 OpenClaw）？**

```python
# platform-api/feishu_client.py
class FeishuClient:
    """Platform 内置飞书 Bot 客户端（用于 Cron 告警和晨报）"""

    async def send_alert(self, chat_id: str, alert: AlertMessage):
        """P1/P2 告警 → 飞书消息卡片（interactive card）"""

    async def send_report(self, chat_id: str, report: ReportMessage):
        """晨报/周报 → 飞书文本消息"""

# Platform 配置（docker-compose.env）：
FEISHU_BOT_APP_ID=xxx
FEISHU_BOT_APP_SECRET=xxx
FEISHU_DUTY_CHAT_ID=xxx      # 值班群
FEISHU_MGMT_CHAT_ID=xxx      # 管理群
```

**缺失 2：Studio 内如何嵌入 AI 对话？**

```
Studio 的 AI 对话 Panel 不是独立的：
  · 基于 maibot-ui 的 AI 对话侧边栏（已有）
  · 用户在 Studio 点击设备 → 右侧 AI 对话预填提示语（"分析 C-001"）
  · AI 对话调用用户自己的 OpenClaw（通过 OpenClaw Gateway URL 配置）

  配置：Studio 需要 OPENCLAW_GATEWAY_URL 环境变量
  用户在 Studio 中使用自己的 OpenClaw 凭证（和飞书 App 共用同一个 Agent）
```

**缺失 3：Platform Scheduler 如何触发 OpenClaw TaskFlow？**

```
修正：Scheduler 不触发 OpenClaw TaskFlow
       Scheduler 直接管理业务流程（包括飞书卡片推送 + 等待回调）

工单 HITL 不是 OpenClaw TaskFlow，而是 Platform 的 TaskFlow 引擎：
  · Platform 维护工单状态机（DRAFT → PENDING_APPROVAL → APPROVED/REJECTED）
  · Platform 推送飞书审批卡片（包含 callback URL）
  · 用户点击飞书卡片 → 回调到 Platform → 状态转换 → L3 知识写入

  OpenClaw 的 TaskFlow（.lobster）是 OpenClaw 内部的工作流，
  适合 AI 编排（先做 A 再做 B），不适合等待人类响应的状态机。

  结论：HITL 工单状态机在 Platform，不在 OpenClaw TaskFlow。
```

### 6.4 Platform 服务列表最终修订

```
ClawTwin Platform 开发的服务（我们的代码）：

① platform-api（FastAPI）
   · Industrial Ontology Layer（/v1/objects/*）
   · Industrial Tool API（/v1/tools/*）
   · 工单状态机 + HITL 飞书卡片推送
   · APScheduler（晨报/告警轮询）
   · FeishuClient（直接发消息，不经 OpenClaw）

② ingestion-service（Python）
   · 文档 PDF → LlamaIndex → Milvus

③ opcua-bridge（Python asyncua）
   · OPC-UA → Kafka → Ditto
   · 仅 real-data profile 启动

④ graphrag-api（Python FastAPI + GraphRAG）
   · GraphRAG local/global search → REST

⑤ moirai-service（Python + PyTorch）
   · MOIRAI 2.0 → 时序异常检测 REST API

⑥ sim-service（Python + pandapipes）
   · What-If 仿真 → REST API

开源基础设施（接口调用，不是我们写的）：
  PostgreSQL 16 + TimescaleDB
  Eclipse Ditto 3.7（数字孪生运行时）
  Apache Kafka 3.6（消息总线）
  Milvus 2.5（向量数据库）
  MinIO（对象存储）
  Redis 7（缓存）
```

### 6.5 技术选型最终确认

| 组件     | 选型                          | 理由                        | ADR 状态 |
| -------- | ----------------------------- | --------------------------- | -------- |
| LLM 推理 | Qwen3.6-35B-A3B INT4 via vLLM | 中文最优，200B 以内         | 锁定     |
| 时序模型 | MOIRAI 2.0（Salesforce）      | 通用时序，无需微调          | 锁定     |
| 3D 引擎  | Babylon.js 8 + WebGPU         | 浏览器最佳，Mac Metal 加速  | 锁定     |
| 数字孪生 | Eclipse Ditto 3.7             | AAS 兼容，开源              | 锁定     |
| 向量 DB  | Milvus 2.5                    | 生产级，支持 metadata 过滤  | 锁定     |
| 知识图谱 | GraphRAG v3（Parquet）        | 无需图 DB，文件存 MinIO     | 锁定     |
| L3 记忆  | OpenClaw memory-wiki          | 零成本复用，per-agent vault | 锁定     |
| 物理仿真 | pandapipes（1D）              | 管网仿真，开源 Python       | 锁定     |
| UI 框架  | maibot-ui 扩展                | 不重写，按能力扩展          | 锁定     |
| 权限     | Nginx + Casbin ABAC           | 不自写网关                  | 锁定     |
| 飞书消息 | 直接 Feishu Bot API           | 简单可靠，不经 OpenClaw     | 修订     |

---

## 七、工业 Skills 最终文件目录（已落地）

```
contrib/industrial-oilgas-skills/
  ├── ADR-4-SKILL-DESIGN-AND-REVIEW.md ← 本文（最高优先级）
  ├── ADR-3-REALITY-CHECK.md         ← 竞争分析 + GPU 配置
  ├── ADR-2-PLATFORM-BOUNDARY.md     ← Platform 边界 + Palantir 对标
  ├── ARCH_DECISION_RECORD.md        ← 知识库决策 + UI 设计（ADR-1.0）
  │
  ├── industrial-twin/SKILL.md        ✅ 能力：读实时设备状态
  ├── industrial-kb/SKILL.md          ✅ 能力：工业知识搜索 + 严肃推理
  ├── industrial-workorder/SKILL.md   ✅ 能力：工单草拟 + HITL
  ├── industrial-analytics/SKILL.md   ✅ 能力：趋势/异常/KPI 分析
  ├── industrial-simulation/SKILL.md  🔜 Phase B 占位（sim_whatif）
  │
  └── clawtwin-project/SKILL.md      ✅ 开发指导 Skill（已更新）
```

---

## 八、一句话总结每个 ADR

```
ADR-1.0：知识库最终方案（Milvus L0-L2 / memory-wiki L3 / GraphRAG 关系）
ADR-2.0：Platform 边界（Platform = 我们的代码；OpenClaw/vLLM = 外部；接口解耦）
ADR-3.0：竞争分析 + GPU 资源分配 + 缺失模块识别
ADR-4.0：Skill 能力导向原则 + Cron/HITL 归属 Platform + 整体方案确认
```

**方案评审结论：整体架构正确，可以开始实施。Phase A 第一步：platform-api + Ontology API mock + Babylon.js 3D 原型（10 天）。**
