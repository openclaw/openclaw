# ClawTwin 架构决策记录（ADR）

## 架构师审视 · 最终定稿 · 不再更改

**版本**：ADR-1.0 FINAL · 2026-05-08  
**角色**：系统架构师最终决策  
**原则**：只做刚需，不造轮子，模型驱动，边界清晰  
**警告**：本文档是架构基线，后续开发不得在无 ADR 的情况下更改核心决策

> **⚠️ 勘误（2026-05）— L3 存储修正**：
> 本文档部分内容引用了 `OpenClaw memory-wiki` 作为 L3 存储，已证实错误。
> `memory-wiki` 是 OpenClaw 的 CLI 工具，**没有 REST API**，Platform 无法外部调用。
> **最终决策：L3 知识存储在 Platform 自有 PostgreSQL（`kb_documents` layer='L3'）+ Milvus
> 向量索引，与 L0-L2 共用同一检索架构，按 `station_id` 隔离。**
> 权威实现见 `MODULE-DESIGN-PLATFORM.md §12.4`（`kb/l3_writer.py`）。

---

## 一、知识库技术栈——最终决议（不再变更）

### 1.1 混乱的根源和彻底澄清

```
历史混乱原因：
  · 先提 Milvus + pgvector → 后加 GraphRAG → 又提 Neo4j → 又提 LlamaIndex
  · 不同场景的知识需求被混在一起讨论

彻底分离三种截然不同的知识需求：

  需求 A：工业领域知识检索（L0-L2，静态，大量文档）
    "GB 50251 第 7.3 节对压缩机轴封的要求是什么？"
    → 需要：向量语义搜索 + 文档分块 + 相关性排序

  需求 B：跨文档关系推理（故障-原因-措施网络）
    "C-001 轴封振动与哪些上下游设备有关联影响？"
    → 需要：实体-关系图谱 + 图遍历推理

  需求 C：场站专属记忆（L3，动态增长，工单/经验）
    "这个场站上次类似问题是怎么处理的？"
    → 需要：可写入、随工单积累、与 Agent 深度集成
```

### 1.2 三个需求对应三个技术方案（各司其职）

```
需求 A → Milvus 2.5（向量检索）
  · 存储：L0/L1/L2 文档分块（chunk + embedding）
  · 工具：LlamaIndex 0.12（文档加载/分块/向量化）
  · 搜索：语义相似度搜索 + metadata 过滤（layer/station/equipment）
  · 命名空间：collection="industrial_kb"，namespace per station for L3

需求 B → Microsoft GraphRAG v3.0.9（关系图谱）
  · 原理：从文档中自动提取实体-关系，生成社区摘要
  · 存储：JSON/Parquet 文件（存在 MinIO），无需单独图数据库
  · 搜索：GraphRAG local/global 搜索 API（Python FastAPI 封装）
  · 数据：在 L0/L1/L2 文档集上运行一次，定期增量更新
  · 重要：GraphRAG 不是图数据库，不需要 Neo4j！

需求 C → OpenClaw memory-wiki（场站专属记忆）
  · 原理：利用 OpenClaw 已有的 memory-wiki 基础设施
  · 每个场站 Agent 有独立的 wiki vault（vault.path 隔离）
  · 写入：工单被验证后 → 自动写入场站 Agent wiki → L3 知识
  · 搜索：通过 OpenClaw Gateway 的 wiki search 工具（已有！）
  · 优势：不需要额外维护 Milvus L3 collection，零成本复用
```

### 1.3 各技术的明确职责和边界

| 技术                     | 职责                                        | 不做什么                     |
| ------------------------ | ------------------------------------------- | ---------------------------- |
| **Milvus 2.5**           | L0/L1/L2 工业文档向量检索                   | 不存结构化数据，不做关系推理 |
| **LlamaIndex**           | 文档加载/分块/向量化流水线                  | 不是搜索引擎，不存数据       |
| **GraphRAG v3**          | 跨文档知识图谱 + 社区摘要                   | 不是图数据库，不存全量数据   |
| **OpenClaw memory-wiki** | L3 场站专属记忆（工单/经验）                | 不存结构化数据，不做向量检索 |
| **PostgreSQL**           | 结构化业务数据（工单记录/台账/时序）        | 不做全文搜索，不做向量检索   |
| **MinIO**                | 对象存储（PDF/glTF/模型权重/GraphRAG 文件） | 不做搜索，不做处理           |
| **Neo4j**                | ❌ **不引入**，GraphRAG 已覆盖关系推理需求  | —                            |

### 1.4 知识摄入流水线（一次理解，永久执行）

```
新文档上线流程：
  PDF / DOCX 上传
       ↓
  MinIO（对象存储）
       ↓
  文档处理服务（Python，LlamaIndex）：
    ① pymupdf → 提取文本
    ② 分块（512 tokens，20% 重叠）
    ③ Qwen3.6 Embeddings → 向量化
    ④ 写入 Milvus（layer=L0/L1/L2，source=文件名，equipment_ids=[...]）
       ↓
  GraphRAG 摄入（定期，批量）：
    ① 读取 MinIO 上所有 L0/L1/L2 文档
    ② graphrag index → 提取实体/关系/社区
    ③ 结果写回 MinIO（graph.parquet, communities.json）

工单验证后流程（L3 增长）：
  工单被工程师批准
       ↓
  knowledge-feedback.lobster 触发
       ↓
  Qwen3.6 提取关键知识（设备/症状/原因/措施）
       ↓
  写入场站 Agent memory-wiki vault（markdown 格式）
       ↓
  自动进入 L3，下次同类问题召回
```

---

## 二、产品族收榕——最终定义

### 2.1 问题：之前的产品过多，边界模糊

```
错误的产品思维：
  ClawTwin Studio / Command / Mobile / Edge / API / Sim / Admin
  = 7 个产品，每个都要单独开发维护

正确的产品思维（参考 Palantir AIP、Samsara 的产品策略）：
  = 1 个平台 + 1 个界面 + N 个知识包
```

### 2.2 三个真正的产品（有独立商业价值的）

```
产品 1：ClawTwin Platform
────────────────────────────────────────────────────
定义：后端服务集合，工业 AI 大脑的基础设施
价值：客户自己的数据不出厂区，AI 在本地运行
技术：11 个 Docker 服务（详见 FINAL_ARCHITECTURE.md）
计费：¥ 12-20 万/年/场站（按接入设备数定价）
交付：Docker Compose + 安装脚本 + 配置向导

包含模块（不是独立产品，是 Platform 的组成部分）：
  · AI 推理层（Qwen3.6 vLLM + OpenClaw Gateway）
  · 数字孪生运行时（Eclipse Ditto）
  · 知识库（Milvus + GraphRAG + memory-wiki）
  · 数据总线（Kafka + OPC UA Bridge + IMS Adapter）
  · 物理仿真（pandapipes + FNO，Phase 2 激活）
  · 工业 API 网关（Nginx + casbin，权限控制）
  · 飞书集成（OpenClaw Feishu Channel + 晨报/工单 Cron/TaskFlow）

产品 2：ClawTwin Studio
────────────────────────────────────────────────────
定义：工程师的 AI 工作台（Web + Tauri 桌面）
价值：3D 可视化 + AI 对话 + 工单审批的统一入口
技术：基于 maibot-ui，增加工业 Surface 组件
计费：¥ 3 万/用户/年，或 ¥ 15 万/场站/年（不限用户）
交付：Web 部署 + Tauri 安装包

包含模式（一个应用，两个路由，不是两个产品）：
  · Studio 模式（/studio）：三列布局，AI 对话为主
  · Command 模式（/command）：全屏 3D，大屏展示
  · Admin 模式（/admin）：治理后台（maibot-ui admin-web）
  → 同一个应用，不同路由，共享组件和状态

产品 3：Industry Knowledge Pack
────────────────────────────────────────────────────
定义：行业预置知识包（标准 + 手册 + 本体 + 3D 资产）
价值：客户无需自己建知识库，开箱即用
技术：LlamaIndex 处理好的 Milvus 数据包 + GraphRAG 图文件
计费：¥ 5-8 万/行业垂直/年（许可证），或一次性购买
交付：数据包（可导入现有 Platform）

行业包清单：
  · Pack-OilGas：天然气管道场站（GB 50251/50253/SY/T + 主流设备）
  · Pack-Chemical：化工流程（GB 50016/50085 + 反应器/精馏塔）
  · Pack-Power：热电/燃气电厂（DL 标准集 + 汽轮机/锅炉）
  · Pack-LNG：LNG 接收站（GB 51156 + 低温设备）
```

### 2.3 不是产品的东西（配置/模式/Phase）

```
❌ ClawTwin Mobile  → 不是产品，是 Platform 的飞书 Channel 配置
   → 交付方式：一份 skills.json + cron.json + workflow.lobster

❌ ClawTwin Command → 不是产品，是 Studio 的 /command 路由
   → 工程量：在 Studio 中增加一个全屏路由，共享 TwinSurface 组件

❌ ClawTwin API    → 不是产品，是 Platform 的接口层（Nginx + casbin）
   → 文档是产品（OpenAPI 文档），代码是 Platform 的组成部分

❌ ClawTwin Sim    → 不是产品，是 Platform 的 Phase 2 激活模块
   → Docker Compose profile 激活，无需单独交付

❌ ClawTwin Edge   → 不是产品，是 Platform 的轻量化部署模式
   → Phase 3，同一套代码，不同 Docker profile

❌ ClawTwin Admin  → 不是产品，是 Studio 的 /admin 路由
   → 基于 maibot-ui 现有 packages/admin-web，微改造
```

### 2.4 产品-功能-技术对应表（最终版）

```
用户动作 → 界面入口 → 触发机制 → 技术实现

看 3D 场站全景
  → Studio /command 路由（Command 模式）
  → 浏览器打开 URL
  → Babylon.js 8 WebGPU + Ditto WebSocket 实时数据

问「SDV-001 现在状态」（飞书）
  → 飞书手机 App
  → OpenClaw Feishu Channel → 感知 Agent → twin_read 工具
  → Ditto REST API → Qwen3.6 回答 + citations

接收 AI 预警推送（飞书）
  → 飞书手机 App
  → OpenClaw Cron（每 30 分钟）→ MOIRAI → 分析 Agent → 飞书推送
  → Kafka → MOIRAI 2.0 → OpenClaw → 飞书 Bot Server → 用户

审批工单（飞书）
  → 飞书审批卡片（一键批准）
  → Feishu Webhook → OpenClaw → TaskFlow.resume() → PostgreSQL
  → 写入 memory-wiki L3 → 数据飞轮

查询历史规程（Studio AI 对话）
  → Studio 中间栏 AI 对话框
  → OpenClaw → kb_search 工具 → Milvus L0-L2 + memory-wiki L3
  → Qwen3.6 综合回答（含 citations 卡片展示）

查看设备数字护照（Studio）
  → Studio 右栏 EquipmentDetailPanel
  → asset_read 工具 → station-data.json API + Ditto + PostgreSQL
  → 展示：规格/3D/测点/工单历史/AAS Shell

物理仿真预演（Studio Phase 2）
  → Studio 右栏 SimPanel
  → simulate_whatif 工具 → pandapipes + FNO FastAPI
  → 实时更新 3D 色谱（<200ms）

接收 06:00 晨报（飞书）
  → 飞书群消息
  → OpenClaw Cron（06:00 CST）→ 晨报 Agent
  → 综合 Ditto + PostgreSQL + Milvus → Qwen3.6-27B 生成 → 飞书卡片
```

---

## 三、ClawTwin Studio UI 概要设计

### 3.1 整体布局结构

```
┌──────────────────────────────────────────────────────────────┐
│  TopBar：[Logo][场站选择器] ─── ─── ─── [Gateway状态][设置]  │
├────────┬───────────────────────┬───────────────────────────  │
│        │                       │                             │
│  Left  │    Middle             │    Right Panel              │
│  Panel │    AI Conversation    │    (Workspace Surface)      │
│  240px │    flex-1             │    360-560px                │
│        │                       │                             │
│ 会话   │ 对话线程               │ [Twin][设备][KPI][工单]Tab  │
│ 列表   │  · UserMessage        │                             │
│        │  · AssistantMessage   │  切换到当前 Surface 组件    │
│ 场站   │    + ToolResults      │                             │
│ 导航   │    + CitationCards    │                             │
│        │    + WorkOrderCards   │                             │
│ 快速   │  · ApprovalCard       │                             │
│ 告警   │                       │                             │
│        │ Composer              │                             │
│        │  · TextInput          │                             │
│        │  · Voice/Image        │                             │
└────────┴───────────────────────┴─────────────────────────────┘

Command 模式（/command 路由，同一应用）：
┌──────────────────────────────────────────────────────────────┐
│  [场站名] [时间] [AI状态] ─── ─── ─── ─── ─── [返回Studio]   │ TopBar（极简）
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                                                              │
│              TwinSurface 全屏（Babylon.js 8）                 │
│              · HDRI 全真实感渲染                              │
│              · 粒子流 + 热场 + 状态光晕                       │
│              · 告警自动飞行                                   │
│                                                 ┌──────────┐ │
│                                                 │ AI 大脑  │ │
│                                                 │ 活动日志 │ │
│                                                 │ 告警列表 │ │
│                                                 └──────────┘ │
├──────────────────────────────────────────────────────────────┤
│  进站压力: 6.8 MPa  │ 流量: 823 Mm³/d  │ 差压: 0.3 MPa  KPI │ 底栏
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Left Panel 模块规范

```
模块：StationSelector
  · 显示：当前场站名称 + 连接状态
  · 交互：下拉选择（按权限过滤，只显示有权限的场站）
  · 切换场站：清空当前会话，重新加载 Ditto 订阅
  · 状态：在线/离线/告警（绿/灰/橙圆点）
  · 数据源：Industrial API Gateway /v1/stations（按用户权限）

模块：SessionList（直接复用 maibot-ui）
  · 显示：历史对话列表，按时间分组
  · 交互：点击切换会话
  · 改造：会话标题自动命名（工单号/设备号/日期）

模块：AlertsQuickView（新增）
  · 显示：当前活跃告警（最多 5 条）
  · 格式：[设备位号] [告警描述] [时间] [严重度]
  · 交互：点击 → 右栏 Twin 飞行到该设备
  · 数据源：Kafka alerts.raw Topic → WebSocket 实时推送

模块：EquipmentNavigator（新增）
  · 显示：场站设备树（按区域/类型分组）
  · 格式：树形结构，带状态颜色
  · 交互：点击 → 右栏 Twin 飞行到该设备
  · 数据源：asset_read(station_id) → station-data.json
```

### 3.3 Middle Panel 模块规范

```
模块：ConversationThread（直接复用 assistant-ui + maibot-ui）
  · 核心：assistant-ui ExternalStoreRuntime（无需改动）
  · 消息类型（仅扩展工业类型）：

  ToolResultRenderer 扩展（新增工业渲染器）：
    CitationCard：
      props: { layer: "L0"|"L1"|"L2"|"L3", source: string, section: string, excerpt: string }
      UI: 层级标签（颜色区分）+ 来源文件 + 章节 + 摘要 + "查看原文"链接

    EquipmentStatusCard：
      props: { equipment_id: string, ditto_features: DittoFeatures }
      UI: 设备位号 + 测点值 + 状态颜色 + "在3D中查看"按钮

    WorkOrderDraftCard：
      props: { draft: WorkOrderDraft, citations: Citation[] }
      UI: 工单摘要 + 设备 + 步骤列表 + 引用来源 + [批准][修改][拒绝]按钮
      交互：批准 → TaskFlow HITL → PostgreSQL

    SimulationResultCard（Phase 2）：
      props: { result: SimResult, chart_data: PressureTimeSeries }
      UI: 结论摘要 + recharts 压力曲线 + 风险等级

模块：AIThoughtIndicator（扩展 ActivityFeed）
  · 位置：对话窗顶部，可折叠
  · 显示：AI 正在调用的工具名称（"正在检索知识库..."）
  · 完成后：折叠，保留 citations 统计

模块：Composer（直接复用 maibot-ui）
  · 文字输入（已有）
  · 图片附件（已有）→ 铭牌拍照
  · 语音按钮（新增）→ 调用飞书 ASR（飞书 App 内）/ Web Speech API（浏览器）
```

### 3.4 Right Panel - TwinSurface 规范（最重要的新组件）

```
组件：TwinSurface
文件：src/surfaces/TwinSurface/
  index.tsx              ← 主组件（挂载 Babylon 引擎）
  useTwinScene.ts        ← 场景初始化 hook（引擎/材质/光照）
  useDittoSync.ts        ← Ditto WebSocket 订阅 → 3D 状态更新
  useEquipmentMeshes.ts  ← 设备几何加载（station-data.json）
  useParticleFlows.ts    ← 天然气流动粒子
  useGlowLayer.ts        ← 设备状态光晕
  TwinToolbar.tsx        ← 顶部工具栏
  AssemblyExplode.tsx    ← 爆炸视图控制器

数据依赖：
  输入：{ stationId, focusEquipmentId?, viewMode: "lod0"|"lod1"|"lod2"|"lod3" }
  API：
    GET /api/v1/assets/{stationId} → station-data.json（设备位置+类型）
    WS  wss://ditto/ws/2 → 实时 Feature 更新（状态颜色）
    GET /api/v1/assets/{stationId}/graph → 管道拓扑（粒子路径）

渲染层级（LOD）：
  LOD 0（全站，鸟瞰 > 100m）：
    · 设备：发光图标（Sprite，按状态颜色）
    · 管道：粗线（LineSystem）
    · 性能：< 5ms per frame，任何设备都能运行

  LOD 1（区域，20-100m）：
    · 设备：程序化几何（圆柱/球体，单色 PBR）
    · 管道：Tube Mesh（直径可见）
    · 性能：< 8ms per frame

  LOD 2（设备，< 20m，选中或手动）：
    · 设备：OpenPBR 材质（metalness/roughness/normalMap）
    · 材质：ambientCG Metal047（管道）/ Metal030（阀体）/ Plastic020（仪表）
    · 环境：polyhaven industrial_workshop_foundry_4k HDRI
    · 后处理：SSAO + Bloom + FXAA + ToneMapping
    · 性能：< 16ms per frame（60fps 目标）

  LOD 3（装配，< 5m，主动触发）：
    · 参数化螺栓阵列（默认 8×M16）
    · 法兰面+垫片
    · 爆炸视图动画（1.5 秒 tween）
    · 测量标注浮层（DN/PN/材质）

工具栏功能：
  [LOD 锁定] [2D P&ID 切换] [时间轴] [截图] [VR 模式（Phase 3）]

事件输出：
  onEquipmentSelect(equipId)   → 同步更新 EquipmentDetailPanel
  onEquipmentHover(equipId)    → 显示 tooltip（位号+当前测点）
  onViewportChange(camera)     → 保存视角（session storage）
```

### 3.5 Right Panel - EquipmentDetailPanel 规范

```
组件：EquipmentDetailPanel
标签页结构（Tabs）：
  [概览] [测点] [工单历史] [文档] [数字护照]

Tab 1：概览
  · 设备位号 + 中文名称 + 类型图标
  · 当前健康分（MOIRAI 分数 0-100，绿/橙/红）
  · 关键参数（最重要 3-5 个测点，大字展示）
  · AI 简评（最近一次分析的一句话摘要）
  · [向 AI 提问] 按钮（预填充设备上下文到 Composer）

Tab 2：实时测点
  · 全部 Ditto Features 表格（测点名/当前值/单位/更新时间）
  · 每行：颜色状态（绿/橙/红）+ 24h 迷你趋势图（recharts Sparkline）
  · 数据源：WS ditto 实时推送

Tab 3：工单历史
  · 工单列表（时间倒序）
  · 每条：日期/类型/描述/状态/处理时长
  · 点击展开：完整工单详情 + citations
  · 数据源：GET /api/v1/workorders?equipment_id={id}

Tab 4：文档
  · L2 OEM 手册列表（从 Milvus 元数据获取）
  · 点击：在 MinIO 中打开 PDF（新窗口）

Tab 5：数字护照（AAS Shell）
  · 序列号/型号/出厂日期/制造商
  · 认证信息（压力等级/温度等级/防爆等级）
  · 安装位置（P&ID 位号 + 区域）
  · 数据源：station-data.json aas_shell 字段
```

### 3.6 Right Panel - WorkOrderBoard 规范

```
组件：WorkOrderBoard（扩展 maibot-ui TasksPanel）
布局：Kanban 四列
  [AI 草案] → [待审批] → [执行中] → [已完成]

WorkOrderCard：
  · 标题：设备位号 + 问题描述（一行）
  · 置信度：MOIRAI 分数（进度条）
  · citations 数量：[L0 × N] [L2 × N] [L3 × N]
  · 时间：创建时间
  · 操作（待审批时）：[批准] [修改] [拒绝]
  · 展开：完整工单步骤 + 引用来源

全局操作：
  · 过滤：按场站/设备/时间范围/状态
  · [新建工单]：打开 AI 对话预填充工单模板
```

### 3.7 Right Panel - KPIDashboard 规范

```
组件：KPIDashboard
布局：上下结构
  Top Row（3-6 个大数字 KPI）：
    · 进站压力（MPa）
    · 出站流量（Mm³/d）
    · 差压（MPa）
    · 压缩机负荷率（%）
    · 今日告警数（橙/红分开）
    · AI 大脑状态（24h 内分析次数/预警次数）

  Middle（趋势图，recharts）：
    · 选择任意测点 → 24h/7d/30d 趋势
    · 多测点对比

  Bottom（AI 活动日志）：
    · 最近 10 条 AI 活动（时间/类型/结果）
    · 数据源：PostgreSQL ai_activity_log 表
```

---

## 四、不需要开发的东西（架构师明确划线）

```
❌ 不开发自定义 API 网关
   → 用 Nginx + casbin.js（开源 ABAC 权限库）
   → 工程量：写 casbin 权限规则文件，约 1-2 天

❌ 不开发自定义 OCR 引擎
   → 用 Qwen3.6-VL（已有，直接调用）
   → P&ID 解析 / 铭牌识别 / 仪表读数识别全部走 Qwen3.6-VL

❌ 不开发自定义图数据库
   → GraphRAG 用 Parquet/JSON，存 MinIO，无需 Neo4j

❌ 不开发自定义时序数据库
   → TimescaleDB 扩展 on PostgreSQL 完全足够

❌ 不开发自定义移动 App
   → 飞书原生（OpenClaw Feishu Channel + 卡片）
   → Studio 的响应式移动视图（maibot-ui MobileShell 已有）

❌ 不开发自定义工作流引擎
   → OpenClaw TaskFlow（已有 .lobster 工作流）

❌ 不开发自定义语音识别
   → 飞书原生 ASR（飞书 App 内）
   → Web Speech API（浏览器 Studio）

❌ 不开发自定义用户认证
   → OpenClaw 自带认证 + 飞书 OAuth
   → Industrial API Gateway 只做鉴权（验证 Token，不发 Token）

❌ 不开发自定义 LLM
   → Qwen3.6-35B-A3B（直接部署）
   → LoRA 微调（Phase 2，数据积累后）

❌ 不开发 P&ID 绘图工具
   → 消费 P&ID（客户提供 SVG/PDF）
   → Qwen3.6-VL 解析 → station-data.json 生成
```

---

## 五、技术方案逐项确认（业界最佳实践对齐）

| 决策项     | 选定方案                    | 为什么是最佳                         | 替代方案和拒绝原因                      |
| ---------- | --------------------------- | ------------------------------------ | --------------------------------------- |
| LLM 推理   | Qwen3.6-35B-A3B + vLLM      | 中文最强，Apache 2.0，本地部署       | GPT-4：不能本地；Llama：中文差          |
| 向量数据库 | Milvus 2.5                  | 生产级，Linux Foundation，最优性价比 | pgvector：不够扩展；Weaviate：复杂      |
| 知识图谱   | GraphRAG v3                 | 文档驱动，MIT，无需图DB，微软背书    | Neo4j：运营复杂，许可证有争议           |
| L3 记忆    | OpenClaw memory-wiki        | 已有基础设施，零额外成本             | Milvus L3 collection：多余              |
| 时序异常   | MOIRAI 2.0                  | 零样本，Apache 2.0，Salesforce       | Prophet：需标注；自研：太贵             |
| 3D 渲染    | Babylon.js 8 WebGPU         | Apache 2.0，WebGPU，行业最佳 Web     | Three.js：WebGPU 不成熟；UE5：无法 Web  |
| 数字孪生   | Eclipse Ditto 3.7           | IEC 标准，EPL，生产级                | 自研：太贵；AWS IoT TwinMaker：不能本地 |
| 消息总线   | Apache Kafka 3.7            | 工业标准，Apache 2.0                 | RabbitMQ：不适合高吞吐时序              |
| 管网仿真   | pandapipes                  | Python，Apache 2.0，专为管网设计     | OpenFOAM：3D CFD，大材小用              |
| 物理代理   | FNO（neuraloperator）       | MIT，NVIDIA + MIT 联合开发           | 自研 PINN：太复杂                       |
| 工作流     | OpenClaw TaskFlow           | 已有，无额外依赖                     | LangGraph：外部依赖，不必要             |
| UI 基础    | maibot-ui（React + Tauri）  | 已有，OpenClaw 生态，完整            | 从零开始：浪费                          |
| 关系数据库 | PostgreSQL 16 + TimescaleDB | 开源最强，时序扩展天然合一           | MySQL：时序弱；InfluxDB：太专           |
| 权限控制   | casbin.js（ABAC）           | Apache 2.0，灵活，Node.js 原生       | OPA：复杂；自研：不必要                 |

---

## 六、项目指导结构（不再迷失方向的机制）

### 6.1 技能文件体系（ADR-4.0 最终版）

> Skill 设计原则和完整列表以 `ADR-4-SKILL-DESIGN-AND-REVIEW.md` 为权威。

```
contrib/industrial-oilgas-skills/
  industrial-twin/SKILL.md        ← 能力：读实时设备状态（Ditto）
  industrial-kb/SKILL.md          ← 能力：工业知识搜索 + 严肃推理（citations 强制）
  industrial-workorder/SKILL.md   ← 能力：工单草拟 + HITL 审批
  industrial-analytics/SKILL.md   ← 能力：趋势/异常/KPI 分析（MOIRAI）
  industrial-simulation/SKILL.md  ← 能力：What-If 仿真（Phase B，占位）

  clawtwin-project/SKILL.md       ← 项目开发指导（非运行时 Skill）
```

### 6.2 文档体系（已建立）

```
AGENTS.md（根）→ 通用规则
contrib/industrial-oilgas-skills/
  INDUSTRIAL_BRAIN_MASTER.md      ← 系统总体设计（✅ 已写）
  ARCH_DECISION_RECORD.md         ← 本文件，架构决策记录（✅ 当前）
  ENTERPRISE_ARCHITECTURE_COMPLETE.md ← 企业集成架构（✅ 已写）
  FINAL_ARCHITECTURE.md           ← Docker 服务清单（✅ 已写）
  TECH_DECISIONS.md               ← 技术选型决策（✅ 已写）
  FINAL_DEVELOPMENT_PLAN.md       ← 开发计划（✅ 已写）
  STRATEGIC_REVIEW_INVESTOR_USER.md ← 投资人/用户视角（✅ 已写）
  VISION_METAVERSE_INDUSTRY40.md  ← 远景愿景（✅ 已写）
```

### 6.3 开发中不再变更的核心决策

```
以下决策不再讨论，直接执行：
  1. 知识库：Milvus（L0-L2）+ memory-wiki（L3）+ GraphRAG（关系）
  2. 不引入 Neo4j
  3. 3D：Babylon.js 8 WebGPU，不用 Three.js 或 UE5
  4. LLM：Qwen3.6 家族，不用 GPT-4
  5. 工作流：OpenClaw TaskFlow，不用 LangGraph
  6. Command = Studio /command 路由，不是独立产品
  7. Mobile = Feishu 技能配置，不是独立 App
  8. L3 = memory-wiki，不是 Milvus 单独 collection
  9. 物理仿真：pandapipes + FNO，不用 OpenFOAM
  10. 认证：OpenClaw + 飞书 OAuth，不另建

如需变更以上任一决策，必须：
  · 创建新 ADR 文档（ARCH_DECISION_RECORD_v2.md）
  · 说明变更原因 + 影响分析
  · 不得在对话中临时改变并执行
```

---

_本文档是 ClawTwin 项目的架构基线文档。所有开发工作以本文档为准。_
