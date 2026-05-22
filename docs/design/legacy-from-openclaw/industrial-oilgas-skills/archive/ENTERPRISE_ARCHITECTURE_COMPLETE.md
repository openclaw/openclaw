# ClawTwin 完整企业架构

## 项目评估 · 产品族 · 多级集成 · 技能目录 · 开发路线

**版本**：ARCH-1.0 · 2026-05-08  
**状态**：可开始开发  
**核心原则**：以模型为核心——所有业务逻辑优先用模型实现，代码只做模型的脚手架

---

## 一、现有项目评估（哪些可以直接复用）

### 1.1 maibot-ui → ClawTwin Studio ✅ 直接复用

```
评估结论：maibot-ui 就是 ClawTwin Studio 的完美基础，立即开始在此基础上构建

已有能力（无需重建）：
  ✅ 三栏工作台（侧栏会话 + 中间对话 + 右侧面板）
  ✅ OpenClaw Gateway WebSocket 对接（完整适配层）
  ✅ 飞书/IM 深链落地（deeplink → 会话）
  ✅ 审批面板（ApprovalPanel - 工单 HITL 的 UI 层）
  ✅ Canvas/A2UI 系统（可扩展为 3D Twin 展示面）
  ✅ 响应式：桌面三栏 + 手机底部 Tab（MobileShell）
  ✅ Tauri 桌面应用（可交付为本地安装包）
  ✅ Admin Web（治理后台，ClawTwin Admin）
  ✅ 技能市场基础结构（ClawTwin App Store 基础）
  ✅ 任务面板（TasksPanel - 工单看板基础）
  ✅ 活动流（ActivityFeed - AI 大脑运行日志基础）

需要在此基础上添加的（新 surface 类型）：
  ➕ TwinSurface（Babylon.js 8 WebGPU 3D 孪生视口）
  ➕ EquipmentDetailPanel（设备数字护照 + 实时测点）
  ➕ KPIDashboard（场站实时 KPI 条 + 趋势图）
  ➕ WorkOrderBoard（工单看板，扩展现有 TasksPanel）
  ➕ PIDViewer（P&ID 2D 图纸联动视口）
  ➕ TimelinePanel（历史状态时间轴回放）
  ➕ SimPanel（What-if 物理仿真控制面板，Phase 2）

工程做法：
  · 在 src/surfaces/ 增加工业场景 surface 组件
  · 在 packages/contracts/ 中增加工业业务事件类型
  · 新增 right panel tab：Twin / Equipment / KPI / WorkOrder
  · 其余布局、会话管理、审批流、Gateway 接入零改动
```

### 1.2 predictive-maintenance-knowledge-graph → ClawTwin Platform 模块 ⭐ 部分复用

```
评估：该项目提供了生存分析 + 知识图谱的核心算法实现

可复用：
  ✅ Weibull 生存分析公式（设备 RUL 计算）
  ✅ 三层架构思路（数学 v1.0 → 语义 v2.0 → 向量 v2.1）
  ✅ MIMOSA OSA-EAI / ISA-95 标准对齐设计
  ✅ 知识图谱 + 向量混合检索设计

不复用：
  ❌ Neo4j（已决定用 GraphRAG + Milvus，不引入 Neo4j）
  ❌ 半导体场景的具体领域知识（改为油气/化工知识）
  ❌ OpenAI Embeddings（改为 Qwen3.6 本地 Embeddings）

移植方案：
  · 将 Weibull RUL 计算移植为 moirai-service 的后处理层
  · 知识图谱 Ontology 设计思路直接复用（已有 site-a-valves.ttl）
```

### 1.3 clawhub → 工业技能发布渠道 ✅ 生态利用

```
评估：clawhub 是 OpenClaw 技能的公共注册表

我们的技能包（industrial-oilgas-skills/*.md）可以：
  · 发布为 ClawHub 上的技能包（公开版）
  · 建立私有 ClawHub 镜像（企业版，仅内网访问）
  · 按行业垂直（oil-gas / chemical / power）分类发布

这意味着：
  · 客户的 OpenClaw 可以从我们的私有市场安装技能包
  · 版本管理、权限、付费解锁通过 ClawHub 机制实现
  · 无需另建技能分发系统
```

### 1.4 openclaw-enterprise-design → 现有 Demo 资产 ✅ 已有基础

```
samples/twin3d/         ← 现有 Babylon.js 3D Demo（作为 TwinSurface 原型）
samples/ontology/       ← LinkML Schema + SHACL 约束（已完成）
samples/knowledge/      ← L0-L3 知识库原型（已完成）
samples/rag/            ← Mock RAG 服务（已完成）
```

---

## 二、以模型为核心的架构原则

### 2.1 核心原则：代码是模型的脚手架

```
传统做法：
  业务规则 → if-else 代码 → 维护成本高，迭代慢

模型驱动做法：
  业务语义 → 模型（LLM/专用模型）→ 代码只做输入输出适配

效果：
  模型能力提升 → 系统能力自动提升，无需修改业务逻辑代码
```

### 2.2 每类能力对应的模型（不写 if-else）

| 业务能力     | 传统做法     | 模型驱动做法    | 模型                     |
| ------------ | ------------ | --------------- | ------------------------ |
| 设备异常检测 | 阈值告警规则 | 时序模式识别    | **MOIRAI 2.0**           |
| 根因分析     | 决策树       | RAG + 推理链    | **Qwen3.6 + GraphRAG**   |
| 规程查询     | 全文搜索     | 语义检索 + 引用 | **LlamaIndex + Milvus**  |
| 工单生成     | 模板填写     | 上下文推理生成  | **Qwen3.6 CoT**          |
| P&ID 解析    | OCR + 规则   | 视觉理解        | **Qwen3.6-VL**           |
| 铭牌识别     | 模板匹配     | 多模态视觉      | **Qwen3.6-VL**           |
| 物理仿真     | 数值求解器   | 神经代理模型    | **FNO (neuraloperator)** |
| 设备 RUL     | 工程公式     | 生存分析神经    | **MOIRAI + Weibull NN**  |
| 文档摘取     | 正则 + 规则  | 文档理解        | **Qwen3.6 + LlamaIndex** |
| 跨文档推理   | 人工梳理     | 知识图谱        | **GraphRAG v3**          |
| 语音查询     | ASR + NLU    | 端到端语音      | **飞书原生 ASR**         |
| 报告生成     | 模板 + 填充  | 结构化生成      | **Qwen3.6-27B**          |

### 2.3 模型驱动的工具注册模式

```typescript
// 每个工具调用都是：模型驱动 + 可观测 + citations 强制
// 不写业务规则，只写工具接口

const industrialTools = {
  // 工具 1：时序异常检测（MOIRAI 驱动）
  detect_anomaly: {
    description: "检测设备时序数据中的异常模式，返回异常分数和特征",
    schema: z.object({ equipment_id: z.string(), window_hours: z.number() }),
    execute: async ({ equipment_id, window_hours }) => {
      // 从 Ditto 获取时序快照 → MOIRAI 推理 → 返回分数
      const timeseries = await ditto.getFeatureHistory(equipment_id, window_hours);
      return await moirai.score(timeseries); // 模型做判断，不写阈值规则
    },
  },

  // 工具 2：知识检索（LLM 路由 + Milvus + GraphRAG）
  kb_search: {
    description: "在分层知识库中语义检索，返回带层级citations的结果",
    schema: z.object({ query: z.string(), equipment_context: z.string().optional() }),
    execute: async ({ query, equipment_context }) => {
      // 模型决定搜索策略：向量检索 or 图谱推理 or 两者
      const strategy = await qwen.classify(`搜索策略判断: ${query}`);
      const results =
        strategy === "graph"
          ? await graphrag.query(query)
          : await milvus.search(query, { filter: `layer in ['L0','L1','L2','L3']` });
      return { results, citations: results.map((r) => r.metadata) };
    },
  },

  // 工具 3：物理仿真（FNO 代理驱动）
  simulate_whatif: {
    description: "物理仿真预演操作后果（毫秒级响应）",
    schema: z.object({ operation: z.string(), equipment_id: z.string() }),
    execute: async ({ operation, equipment_id }) => {
      const currentState = await ditto.getSnapshot(equipment_id);
      return await fnoSurrogate.predict({ state: currentState, action: operation });
    },
  },
};

// OpenClaw 技能中注册工具：
// 工具注册 → LLM 自主选择调用时机 → 不写 if-else 调度逻辑
```

---

## 三、完整产品族（带数字样机位置）

### 3.1 产品族全景

```
ClawTwin 产品族
│
├── 【数据资产层 · 数字样机】← 不是独立产品，是所有产品的数据底座
│   数字样机 = 设备台账 + 3D 几何 + 本体语义 + 知识图谱 + AAS 数字护照
│   · station-data.json（设备台账）
│   · Babylon.js 场景（3D 几何 + 材质）
│   · site-a-valves.ttl（OWL 本体语义）
│   · Milvus L0-L3（知识图谱）
│   · Eclipse Ditto Things（实时状态）
│   → Studio 和 Command 负责展示
│   → Platform 负责存储和管理
│   → AI（Qwen3.6）通过 GraphRAG 调用推理
│
├── 【Platform Core】← 后端基础设施（11 个 Docker 服务）
│   ClawTwin Platform = 数字孪生运行时 + AI 推理 + 知识库 + 数据库
│   · Eclipse Ditto（孪生运行时）
│   · Qwen3.6-35B-A3B vLLM（AI 推理）
│   · Milvus 2.5（向量知识库）
│   · GraphRAG v3（知识图谱）
│   · PostgreSQL + TimescaleDB（结构化数据）
│   · Kafka（消息总线）
│   · MinIO（文档存储）
│   · MOIRAI 2.0（时序检测服务）
│   · OpenClaw Gateway（AI 编排）
│
├── 【ClawTwin Studio】← PC 端运维控制台（基于 maibot-ui）
│   = maibot-ui 基础 + 工业 Surface 扩展
│   · 三栏工作台（AI 对话 + 3D 孪生视口 + 数据面板）
│   · TwinSurface（新增：Babylon.js 8 WebGPU）
│   · EquipmentDetailPanel（新增：设备数字护照）
│   · WorkOrderBoard（扩展 TasksPanel）
│   · 时间轴回放（新增）
│   · P&ID 视图（新增）
│   · Tauri 桌面应用（已有）
│
├── 【ClawTwin Command】← 指挥大屏（全屏 3D）
│   = 独立 Web 应用（复用 TwinSurface 组件）
│   · 全屏 Babylon.js 8 路径追踪渲染
│   · 粒子流 + 热场 + 状态光晕
│   · 告警自动飞行
│   · AI 大脑运行日志（右侧）
│   · KPI 条（底部）
│
├── 【ClawTwin Mobile】← 飞书端（AI 助手）
│   = OpenClaw 飞书 Channel + 技能包
│   · AI 晨报卡片（06:00 Cron）
│   · 异常推送卡片（含 3D 截图深链）
│   · 工单审批卡片（TaskFlow HITL）
│   · 语音查询（飞书原生 ASR）
│   · 铭牌拍照识别（Qwen3.6-VL）
│
├── 【ClawTwin Sim】← 物理仿真引擎（Phase 2，附加模块）
│   = pandapipes + FNO + FastAPI 服务
│   · 管网压力瞬变预测
│   · What-if 操作后果演示
│   · 压缩机性能图可视化
│   · 设备 RUL 概率分布
│
├── 【ClawTwin Edge】← 边缘离网版（Phase 3）
│   = 7B 领域小模型 + 轻量版 Platform
│   · NVIDIA Jetson Orin NX 或 RTX 4090
│   · 完全离网运行
│   · 定期与 Platform 同步
│
├── 【ClawTwin API】← 数据接口平台
│   = OpenClaw + 工业 API Gateway
│   · REST + WebSocket 接口
│   · SAP PM / Maximo 对接
│   · SCADA 对接
│   · 第三方开发
│
└── 【ClawTwin Admin】← 治理后台（基于 maibot-ui/packages/admin-web）
    = 企业级管理后台
    · 用户 / 角色 / 场站权限管理
    · 知识库管理（文档上传/索引/验证）
    · 工单审计日志
    · AI 推理日志（citations 追溯）
    · 系统健康监控
```

---

## 四、石油管道运输企业多级集成架构

### 4.1 企业层级结构

```
大型石油管道运输企业（如国家管网、省级管网公司）通常有四级：

集团总部（HQ）
  └─ 区域分公司 / 调控中心（Region）
       └─ 管道段 / 干线（Pipeline）
            └─ 场站（Station）：压气站 / 输气站 / 阀室 / 计量站
```

### 4.2 完整集成架构图

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  用户访问层
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

飞书手机App  飞书PC App    ClawTwin       ClawTwin
  (主用)      (主用)       Studio         Command
    │           │          (Web/Tauri)     (大屏)
    └─────┬─────┘              │              │
          │ 飞书 OAuth          │ HTTPS        │ HTTPS
          ▼                    ▼              ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  接入与认证层
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────────────────────────┐
│              API Gateway / Nginx（接入层）                │
│  · TLS 终止 + 证书管理                                    │
│  · 飞书 Webhook 验证（X-Lark-Signature）                  │
│  · JWT 鉴权（用户 Token + 场站权限声明）                   │
│  · 路由：/feishu/* → Feishu Bot Server                   │
│          /api/*    → 工业 API Gateway                    │
│          /ws/*     → OpenClaw Gateway                    │
│          /twin/*   → ClawTwin Web App                    │
└────────────────────┬────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────┐    ┌─────────────────────────────┐
│  Feishu Bot Server  │    │     OpenClaw Gateway 集群    │
│  （私有飞书服务器）  │    │                              │
│  · Webhook 接收     │    │  每用户/每会话一个 Agent     │
│  · 卡片渲染         │    │  · 工业技能包已加载          │
│  · 消息路由         │    │  · Cron 调度器（晨报/巡检）  │
│  · 事件推送         │    │  · TaskFlow（工单 HITL）     │
│                     │    │  · 工具白名单注册            │
│  ⟵── 调用 ──────►  │    │  · 飞书 Channel 桥接         │
│  OpenClaw API       │    │                              │
└─────────────────────┘    └────────────────┬────────────┘
                                            │
                                            ▼ 调用工业工具
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  工业 API 网关层（最关键的中间层）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────────────────────────┐
│                   Industrial API Gateway                 │
│                                                         │
│  功能：                                                  │
│  ① 数据权限控制                                          │
│     用户 A（值班员）→ 只能访问本站设备                    │
│     用户 B（区域主管）→ 可访问区域内所有场站               │
│     用户 C（集团调度）→ 全网只读                          │
│                                                         │
│  ② Ditto 联邦（多场站孪生聚合）                          │
│     GET /twins/station-szp-a:SDV-001 → 路由到 A 站 Ditto│
│     GET /twins/all/summary → 聚合所有场站快照             │
│                                                         │
│  ③ 知识库权限路由                                        │
│     L0/L1/L2：所有用户可查                               │
│     L3（本站）：只有本站用户可查                          │
│                                                         │
│  ④ IMS（工业信息管理系统）对接                            │
│     将 IMS 的实时数据适配为 Ditto Feature 格式            │
│     IMS API → (适配器) → POST /ditto/things/{id}         │
│                                                         │
│  ⑤ 速率限制 + 审计日志 + API 版本管理                     │
│                                                         │
│  技术栈：                                                │
│    Kong Gateway 或 自建 Node.js（Fastify）               │
│    ABAC 权限模型（casbin.js，Apache 2.0）                │
└──────────────────┬──────────────────────────────────────┘
                   │
      ┌────────────┼────────────┬─────────────────┐
      ▼            ▼            ▼                 ▼
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  平台服务层（ClawTwin Platform Core）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AI 推理              知识库              数字孪生           数据存储
──────────          ──────────          ──────────         ──────────
Qwen3.6-35B-A3B     Milvus 2.5          Eclipse Ditto      PostgreSQL
(vLLM INT4)         (向量检索)           (孪生运行时)        +TimescaleDB
1×H100 80G          ·L0-L3分层          ·Thing/Feature      ·工单历史
                    ·按场站命名空间       ·WebSocket推送      ·设备台账
MOIRAI 2.0          ·混合检索           ·REST API          ·时序数据
(异常检测)           (向量+图谱)                             MinIO
                                        Apache Kafka        ·PDF手册
GraphRAG v3         pandapipes+FNO      (消息总线)          ·3D资产
(知识图谱)           (物理仿真)                              ·模型权重

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  场站层（每座场站）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌────────────────────────────────────────────────────────┐
│  场站 A（压气站，无人值守）                              │
│                                                        │
│  OPC UA 服务器（现有 SCADA/DCS 数据）                   │
│       ↓ asyncua Python 桥接                            │
│  本地 Kafka（scene: station-szp-a）                    │
│       ↓ Kafka Connect                                  │
│  ← 上报 → 区域 Kafka（或直连中央 Kafka）                │
│                                                        │
│  IMS 接口（工业信息管理系统）                           │
│       · 生产调度数据（日计划/月计划）                   │
│       · 设备台账（工单历史）                            │
│       · 通过 REST API 或数据库直连提供                  │
│       ↓ Industrial API Gateway 适配                    │
│  Ditto Thing 更新                                      │
│                                                        │
│  ClawTwin Edge（Phase 3，可选）                         │
│       · 本地 7B 模型                                   │
│       · 离网运行                                        │
│       · 定期同步中央平台                               │
└────────────────────────────────────────────────────────┘
```

### 4.3 数据流详解（从传感器到飞书卡片）

```
Step 1: 数据采集（场站侧）
  传感器/仪表 → SCADA/DCS → OPC UA 服务器
                                    ↓
                          asyncua Python 桥接（场站本地运行）
                                    ↓
                          Apache Kafka（Topic: sensors.raw）

Step 2: 孪生同步
  Kafka consumer → Ditto HTTP API → Thing Feature 更新
  格式：{ "thingId": "station-szp-a:SDV-001",
          "features": { "pressure": { "properties": { "value": 6.82, "unit": "MPa" }}}}

  IMS 系统 → Industrial API Gateway 适配 → Ditto Feature（工单/台账数据）

Step 3: 实时分析
  MOIRAI Service（Kafka Consumer）
    · 消费 sensors.raw Topic
    · 对每个设备的时序特征运行异常检测
    · 产出：anomaly_score（0-1）+ anomaly_features
    · 写入 Kafka：alerts.raw

  感知 Agent（OpenClaw Cron，每 30 分钟）
    · 调用 twin_read(all) 获取全站快照
    · 拉取 MOIRAI 分数
    · 分数 > 0.7 → 触发分析 Agent

Step 4: AI 推理（OpenClaw + Qwen3.6）
  分析 Agent 被触发：
    · 调用 kb_search(query, equipment_id) → Milvus + GraphRAG
    · 调用 history_read(equipment_id, 90d) → PostgreSQL
    · 调用 twin_read(related_equipment) → Ditto
    · Qwen3.6 综合推理 → 根因链 + 风险量化
    · 输出：analysis_result（含 citations[]）

Step 5: 工单 HITL（TaskFlow）
  工单 Agent（被分析 Agent 触发）：
    · wo_draft(analysis_result) → 标准工单 JSON
    · TaskFlow.createManaged() → 创建有状态工作流
    · 发送飞书审批卡片 → setWaiting()
    · 用户点「批准」→ 飞书 Webhook → OpenClaw → resume()
    · write_to_db(wo) + notify_team()
    · 写入 L3 知识库（标注数据积累）

Step 6: 展示同步（Studio / Command）
  Studio 通过 OpenClaw Gateway WebSocket 接收：
    · 设备状态变更事件 → TwinSurface 颜色更新
    · 告警事件 → 自动飞行到异常设备
    · AI 分析结果 → 右侧 AI 分析面板更新
    · 工单状态变更 → WorkOrderBoard 更新
```

### 4.4 用户权限模型（ABAC）

```
资源对象：
  Station（场站）：station-szp-a, station-szp-b, ...
  Equipment（设备）：station-szp-a:SDV-001, ...
  KnowledgeLayer（知识层）：L0, L1, L2, L3:{station_id}
  WorkOrder（工单）：wo:*, wo:{station_id}:*

角色定义：
  station_operator（值班员）：
    - 读取：本站设备状态 + L0/L1/L2 + 本站 L3 + 本站工单
    - 写入：工单状态更新（批准/拒绝）

  station_engineer（工程师）：
    - 继承 operator
    - 额外读取：物理仿真 API
    - 写入：设备台账更新、L3 知识新增

  region_supervisor（区域主管）：
    - 读取：所辖区域所有场站（只读）
    - 写入：跨站工单协调

  admin（系统管理员）：
    - 全部读写
    - 知识库管理（文档上传/删除）
    - 用户/角色管理

权限实现（casbin.js ABAC）：
  p, role:station_operator, resource:station:szp-a:*, action:read
  p, role:station_operator, resource:workorder:szp-a:*, action:write
  p, role:region_supervisor, resource:station:region-a:*, action:read
```

---

## 五、OpenClaw 技能开发目录（完整清单）

### 5.1 核心技能包（industrial-oilgas-skills）

```
已有（需完善）：
  industrial-core/SKILL.md      ← AI 安全边界 + 引用强制（已完善）
  industrial-mdm/SKILL.md       ← 设备主数据管理（Tag/ID 规范）
  industrial-procedures/SKILL.md ← 规程查询（规程引用规范）
  industrial-readonly-live/SKILL.md ← 只读工况查询（Ditto 工具）
  industrial-work-order/SKILL.md ← 工单草案（HITL 规范）
  industrial-graph-read/SKILL.md ← 知识图谱只读（GraphRAG）
  industrial-twin/SKILL.md      ← 3D 孪生链接（已完善）
  industrial-simulation/SKILL.md ← 物理仿真（Phase 2 补充）

需要新增的技能：
  industrial-morning-report/SKILL.md    ← AI 晨报生成规范
  industrial-anomaly-analysis/SKILL.md  ← 根因分析规范（含 citations 格式）
  industrial-compliance/SKILL.md        ← GB 32167 合规检查
  industrial-handover/SKILL.md          ← 班组交接记录生成
  industrial-energy/SKILL.md            ← 能耗分析（电耗/气耗）
  industrial-inventory/SKILL.md         ← 备件库存查询
  industrial-inspection/SKILL.md        ← 巡检计划生成
```

### 5.2 工作流文件（TaskFlow .lobster 格式）

```
需要开发的工作流文件：

workflows/
  ├── work-order-hitl.lobster          ← 工单 HITL 审批主流程
  │   States: draft → waiting_approval → approved/rejected → archived
  │
  ├── morning-report.lobster           ← 晨报生成（Cron 触发）
  │   Flow: data_gather → analyze → generate → deliver_feishu
  │
  ├── emergency-response.lobster       ← 紧急响应（告警触发）
  │   Flow: alert → notify → assess → coordinate → record
  │
  ├── shift-handover.lobster           ← 班组交接
  │   Flow: outgoing_fill → ai_complete → incoming_review → sign
  │
  ├── inspection-plan.lobster          ← 周期巡检计划
  │   Flow: plan_generate → assign → execute → report
  │
  └── knowledge-feedback.lobster       ← 知识反馈（工单采纳后）
      Flow: wo_approved → extract_knowledge → review → index_L3

每个 .lobster 文件的结构：
  {
    "name": "work-order-hitl",
    "version": "1.0",
    "trigger": { "type": "agent-call" },
    "states": [...],
    "transitions": [...],
    "on_complete": { "archive": true, "extract_knowledge": true }
  }
```

### 5.3 Cron 调度配置（场站级）

```json
[
  {
    "name": "morning-report",
    "kind": "cron",
    "expr": "0 6 * * *",
    "tz": "Asia/Shanghai",
    "delivery": { "channel": "feishu", "to": "{{station.feishu_group_id}}" },
    "session": "isolated",
    "skills": ["industrial-core", "industrial-morning-report", "industrial-readonly-live"],
    "prompt": "生成今日场站 AI 晨报。必须包含：① 当前设备健康状态 ② 待处理工单 ③ 今日值班安排 ④ AI 预警事项。每条必须有 citations。"
  },
  {
    "name": "station-scan",
    "kind": "cron",
    "expr": "*/30 * * * *",
    "session": "isolated",
    "skills": ["industrial-core", "industrial-anomaly-analysis"],
    "prompt": "执行全站设备状态扫描。调用 detect_anomaly 检查所有设备。若发现异常分数 > 0.7，立即触发根因分析工作流并推送飞书告警。"
  },
  {
    "name": "weekly-health-report",
    "kind": "cron",
    "expr": "0 8 * * 1",
    "delivery": { "channel": "feishu", "to": "{{region.manager_id}}" },
    "skills": ["industrial-compliance"],
    "prompt": "生成本周设备健康周报。包含：① 本周告警统计 ② 维修工单完成率 ③ 预测维护建议 ④ GB 32167 合规状态。"
  }
]
```

### 5.4 工具函数实现优先级

```
Week 1-4 实现（Phase A 核心）：
  ① twin_read(thingId)      → Ditto REST GET /api/2/things/{id}
  ② kb_search(query)        → Milvus 向量搜索 + layer 过滤
  ③ asset_read(equipId)     → station-data.json REST API
  ④ history_read(equipId)   → PostgreSQL TimescaleDB 查询
  ⑤ wo_draft(context)       → Qwen3.6 生成工单 JSON

Week 5-8 实现（Phase A 完善）：
  ⑥ detect_anomaly(equipId) → MOIRAI 2.0 FastAPI
  ⑦ anomaly_explain(event)  → GraphRAG + Qwen3.6 根因链
  ⑧ graphrag_query(entity)  → GraphRAG REST API
  ⑨ send_feishu_card(card)  → 飞书 OpenAPI webhook
  ⑩ notify_user(userId, msg)→ OpenClaw Feishu Channel

Phase 2 实现：
  ⑪ simulate_whatif(op)     → pandapipes + FNO FastAPI
  ⑫ scan_image_vl(img)      → Qwen3.6-VL 铭牌识别
  ⑬ rul_predict(equipId)    → MOIRAI + Weibull NN
  ⑭ compliance_check(scope) → GraphRAG + GB 32167 规则
```

---

## 六、IMS 对接（工业信息管理系统）

### 6.1 IMS 是什么

```
IMS（Industrial Management System）在油气企业通常指：
  · SCADA 历史数据库（PI System / InfluxDB / 自研）
  · EAM（Enterprise Asset Management，如 SAP PM / IBM Maximo）
  · MES（Manufacturing Execution System）
  · 生产调度系统（日计划/月计划管理）
  · 安全管理系统（PTW 许可证系统）

用户确认：飞书手机/PC App + IMS 作为实时数据接口是确定的
```

### 6.2 IMS 对接方案

```
对接层次 1：历史数据（批量导入，最简单）
  IMS → CSV/Excel 导出 → 脚本导入 PostgreSQL
  触发：每日一次 ETL（Phase A 够用）

对接层次 2：实时数据流（生产级）
  方案 A（OPC UA 标准路径）：
    IMS OPC UA 服务器 → asyncua → Kafka → Ditto

  方案 B（REST API 轮询）：
    IMS REST API → Python 定时拉取（30s/次）→ Kafka → Ditto

  方案 C（数据库订阅）：
    IMS 数据库 → Debezium（CDC 变更数据捕获）→ Kafka → Ditto

对接层次 3：业务数据（工单/台账）
  IMS 工单 API → Industrial API Gateway → 写入 PostgreSQL
  · 工单状态双向同步（ClawTwin 批准 → 推送到 IMS）
  · 台账数据单向同步（IMS → ClawTwin，IMS 为主数据）

适配器代码位置（新建服务）：
  services/ims-adapter/        ← Python FastAPI 服务
    ims_connector.py           ← 连接 IMS（支持 REST/OPC UA/DB）
    ditto_writer.py            ← 写入 Ditto
    kafka_producer.py          ← 发布 Kafka
    main.py                    ← FastAPI + 定时任务
```

---

## 七、完整 Docker Compose 服务清单（含新增服务）

```yaml
# docker-compose.yml（最终版）

version: "3.9"

services:
  # ─── AI 推理 ───────────────────────────────────────
  qwen36-vllm: # Qwen3.6-35B-A3B INT4，vLLM
  openclaw: # OpenClaw Gateway + Cron + TaskFlow

  # ─── 知识库 ────────────────────────────────────────
  milvus: # 向量数据库
  etcd: # Milvus 元数据
  minio: # 对象存储（文档 + 模型）
  graphrag: # GraphRAG 知识图谱服务

  # ─── 孪生与数据 ────────────────────────────────────
  ditto: # Eclipse Ditto 孪生运行时
  kafka: # Apache Kafka 消息总线
  postgres: # PostgreSQL + TimescaleDB

  # ─── AI 模型服务 ────────────────────────────────────
  moirai: # MOIRAI 2.0 时序检测（Phase A）
  sim-engine: # pandapipes + FNO 仿真（Phase B）

  # ─── Web 应用 ────────────────────────────────────────
  web-app: # ClawTwin Studio + Command（Nginx）

  # ─── 数据接入 ────────────────────────────────────────
  opc-ua-bridge: # asyncua OPC UA 桥接（profiles: production）
  mock-producer: # Mock OPC UA 数据生产者（profiles: mock）
  ims-adapter: # IMS 系统对接适配器（新增）

  # ─── 接入层 ─────────────────────────────────────────
  api-gateway: # Industrial API Gateway（Nginx + casbin）
  feishu-bot: # 飞书 Bot Server（新增）


# Phase A 启动命令：
# docker compose --profile mock up -d

# Phase B（真实 OPC UA）：
# docker compose --profile production up -d
```

---

## 八、Studio 开发工程实施（基于 maibot-ui）

### 8.1 新增 TwinSurface 组件

```typescript
// src/surfaces/TwinSurface.tsx（新文件）
import { useEffect, useRef } from "react";
import * as BABYLON from "@babylonjs/core";

interface TwinSurfaceProps {
  stationId: string;
  focusEquipmentId?: string;  // deep link 自动飞行
  onEquipmentSelect?: (equipId: string) => void;
}

export function TwinSurface({ stationId, focusEquipmentId, onEquipmentSelect }: TwinSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BABYLON.WebGPUEngine | null>(null);

  useEffect(() => {
    const initBabylon = async () => {
      if (!canvasRef.current) return;

      // WebGPU 引擎（fallback to WebGL2）
      const engine = new BABYLON.WebGPUEngine(canvasRef.current);
      await engine.initAsync();
      engineRef.current = engine;

      const scene = new BABYLON.Scene(engine);

      // HDRI 环境光（polyhaven CC0）
      const env = BABYLON.CubeTexture.CreateFromPrefilteredData(
        "/assets/hdri/industrial_workshop_foundry_4k.env", scene
      );
      scene.environmentTexture = env;
      scene.environmentIntensity = 0.8;

      // 加载场站数据 → 生成设备几何
      const stationData = await fetch(`/api/v1/assets/${stationId}`).then(r => r.json());
      await loadStationMeshes(scene, stationData);

      // 订阅 Ditto WebSocket → 实时状态更新
      subscribeToTwinUpdates(stationId, (thingId, features) => {
        updateEquipmentState(scene, thingId, features);
      });

      // 处理 deep link 飞行
      if (focusEquipmentId) {
        flyToEquipment(scene, focusEquipmentId);
      }

      engine.runRenderLoop(() => scene.render());
    };

    initBabylon();
    return () => engineRef.current?.dispose();
  }, [stationId]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      <canvas ref={canvasRef} className="w-full h-full" />
      {/* 顶部工具栏：LOD 切换、视角、时间轴 */}
      <TwinToolbar />
    </div>
  );
}
```

### 8.2 在 maibot-ui 中注册新 Surface

```typescript
// src/surfaces/WorkspaceSurface.tsx 扩展（修改现有文件）
// 在现有 surface 类型列表中增加工业类型

type SurfaceType =
  | "canvas" | "browser" | "code" | "terminal"  // 已有
  | "twin"          // 新增：3D 数字孪生
  | "equipment"     // 新增：设备详情
  | "kpi"           // 新增：KPI 仪表盘
  | "workorder"     // 新增：工单看板
  | "pid"           // 新增：P&ID 视图
  | "timeline";     // 新增：时间轴回放

// 在右侧面板 Tab 行中增加工业 Tab（修改 RightPanelPrimaryTabRow.tsx）
const industrialTabs = [
  { id: "twin",       icon: <Globe2 />,     label: "3D 孪生" },
  { id: "equipment",  icon: <Cpu />,        label: "设备详情" },
  { id: "kpi",        icon: <BarChart2 />,  label: "KPI" },
  { id: "workorder",  icon: <ClipboardList/>, label: "工单" },
];
```

### 8.3 AI 大脑可见性（扩展 ActivityFeed）

```typescript
// src/surfaces/ActivityFeed.tsx 扩展
// 显示 AI 工具调用链（让用户看见 AI 在思考）

interface AIThoughtEvent {
  timestamp: string;
  type: "tool_call" | "tool_result" | "reasoning" | "completion";
  tool?: string;
  description: string;
  citations?: Citation[];
}

export function AIThoughtStream({ events }: { events: AIThoughtEvent[] }) {
  return (
    <div className="space-y-1 p-2 font-mono text-xs">
      {events.map((e) => (
        <div key={e.timestamp} className={cn(
          "flex gap-2 items-start",
          e.type === "tool_call" && "text-blue-400",
          e.type === "tool_result" && "text-green-400",
          e.type === "reasoning" && "text-slate-400",
          e.type === "completion" && "text-amber-400"
        )}>
          <span className="shrink-0 text-slate-600">
            {format(e.timestamp, "HH:mm:ss")}
          </span>
          <span>{e.description}</span>
          {e.citations?.map(c => (
            <CitationBadge key={c.id} citation={c} />
          ))}
        </div>
      ))}
    </div>
  );
}
```

---

## 九、开发优先级（可以开始的第一周任务）

```
第 1 天（环境搭建）：
  □ 克隆 maibot-ui 为 clawtwin-studio 仓库
  □ 启动 Docker Compose 11 服务（mock profile）
  □ 验证 OpenClaw Gateway 运行
  □ 配置 Qwen3.6-35B-A3B vLLM（modelscope 下载）

第 2-3 天（3D 场景原型）：
  □ 创建 TwinSurface.tsx 组件
  □ 集成 Babylon.js 8 + WebGPU + polyhaven HDRI
  □ 加载 station-data.json 生成设备几何
  □ 实现 LOD 2 PBR 材质（ambientCG Metal047）
  □ 实现粒子流动（天然气管道）

第 4-5 天（OpenClaw 技能配置）：
  □ 配置工业工具（twin_read / kb_search / asset_read）
  □ 部署 MOIRAI 2.0 FastAPI 服务
  □ 配置感知 Agent Cron（*/30min）
  □ 测试端到端工具调用链

第 6-7 天（飞书集成）：
  □ 配置飞书 Bot（OpenClaw Feishu Channel）
  □ 晨报 Cron 配置（06:00）
  □ 工单 HITL 飞书卡片模板
  □ 端到端测试：异常 → 告警 → 飞书 → 审批 → 归档

关键里程碑（第 2 周末）：
  ✅ 3D 场站在 Studio 中可交互
  ✅ AI 可以回答「SDV-001 现在什么状态？」
  ✅ 飞书收到第一份 AI 晨报
  ✅ 一张工单走完完整 HITL 闭环
```

---

## 十、这个方案是否理想的最终确认

```
✅ 架构清晰：用户访问 → API 网关 → OpenClaw → 工业网关 → 孪生/知识/AI
✅ 产品完整：Studio/Command/Mobile/Edge/API/Admin + Industry Packs
✅ 数字样机定位清楚：数据底座，Studio/Command 展示，Platform 存储
✅ 复用充分：maibot-ui 直接扩展，predictive-maintenance RUL 移植
✅ 模型驱动：所有业务逻辑优先用模型而非 if-else
✅ IMS 对接清楚：4 种对接路径，适配器服务独立可选
✅ 权限模型清楚：ABAC，按场站隔离，多级角色
✅ 技能开发有目录：8 个现有 + 5 个新增 + TaskFlow 工作流清单
✅ 第一周任务清晰：可以明天开始
```

---

_整合：INDUSTRIAL_BRAIN_MASTER · FINAL_ARCHITECTURE · TECH_DECISIONS · FINAL_DEVELOPMENT_PLAN · maibot-ui 架构合约 · predictive-maintenance-knowledge-graph 设计_
