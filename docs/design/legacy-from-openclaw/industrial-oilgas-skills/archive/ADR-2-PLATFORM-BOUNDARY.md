# ClawTwin 架构决策记录 ADR-2.0

## Platform 边界重划 · Palantir 本体对标 · 严肃推理 · 接口解耦

**版本**：ADR-2.0 FINAL · 2026-05-08  
**前置**：本文是 ADR-1.0 的**修订**，以下结论**覆盖** ADR-1.0 中关于 Platform 边界的描述  
**动因**：用户指出 Platform 不应包含 OpenClaw 和大模型，边界须更清晰  
**原则**：Platform = 我们写的代码；OpenClaw/vLLM/Milvus = 外部服务，通过接口调用

---

## 一、回答五个核心问题

### Q1：我们的设计与 Palantir Ontology 一致吗？

**结论：理念一致，实现路径对齐，但必须补充一个形式化的 Industrial Ontology Layer。**

**Palantir Foundry/AIP 本体的本质：**

```
Palantir Ontology =
  对象类型（Object Types）× 属性（Properties）× 关系（Links）× 动作（Actions）× 数据源绑定

  ↓ 作用

  AI 通过"本体 API"直接推理业务对象，而不是裸推理自由文本

示例：
  GET /objects/equipment/C-001 →
  {
    "type": "Compressor",
    "properties": { "pressure": 6.2, "vibration": 2.1, ... },
    "links": { "upstreamPipe": ["P-001"], "downstreamValve": ["V-003"] },
    "actions": ["inspect", "isolate", "workorder_draft"]
  }
```

**我们当前的问题：**

- `equipment_id` 已经是主线 ✅
- OWL/TTL + LinkML 定义了语义 ✅
- Eclipse Ditto 管理运行时状态 ✅
- **缺失：没有一个形式化的"本体查询 API"层，AI 工具直接调各个后端（碎片化）** ❌

**解决方案：增加 Industrial Ontology Layer（本体层）作为 Platform Core 的核心服务**

```
Industrial Ontology Layer（我们实现）：
  GET  /v1/objects/equipment/{id}     → 聚合对象（静态定义 + Ditto 实时状态）
  GET  /v1/objects/equipment/{id}/links → 上下游设备关系
  GET  /v1/objects/workorder/{id}     → 工单对象
  POST /v1/objects/workorder          → 创建/更新工单（DONE 时异步写 L3 kb）
  GET  /v1/actions/equipment/{id}     → 该设备可执行的操作列表

  · 数据来源：PostgreSQL（静态）+ Ditto（实时）+ GraphRAG（关系）
  · 这一层是 AI 推理的"地基"，而不是各自为政的碎片 API
```

**与 Palantir AIP 的对应关系：**

| Palantir AIP                | ClawTwin 对应实现                                                 |
| --------------------------- | ----------------------------------------------------------------- |
| Ontology Object Types       | Industrial Ontology Layer 对象定义（Equipment/WorkOrder/Station） |
| Object Properties（静态）   | LinkML 模型定义 + PostgreSQL                                      |
| Object Properties（实时）   | Eclipse Ditto + Kafka                                             |
| Object Links（关系）        | GraphRAG 实体-关系图                                              |
| Actions                     | Platform 工具 API（inspect/isolate/draft_workorder）              |
| AIP Logic（AI on Ontology） | OpenClaw 调用 Platform 工具 API，通过本体层推理                   |
| Pipeline（数据摄入）        | LlamaIndex + Kafka Bridge                                         |

**结论：和 Palantir 的本质对齐，只要补上 Industrial Ontology Layer 作为统一入口即可。**

---

### Q2：和 OpenClaw 现有知识库系统是否一致？

**结论：一致，且已正确分工。**

> **⚠️ ADR-2 勘误（已于 2026-05 修正）**：
> 原设计将 L3 存于 OpenClaw memory-wiki，经验证 memory-wiki 是 CLI 工具（无 REST API），
> 无法被 Platform 外部调用。**L3 架构已修正为：Platform 自有 PostgreSQL（kb_documents
> layer='L3'）+ Milvus 向量索引**，与 L0-L2 共用同一检索架构，按 station_id 隔离。
> 详见 MODULE-DESIGN-PLATFORM.md §12.4 和 §十二.7。

**知识分层与存储（最终确定版）：**

```
Layer  内容                    存储                     OpenClaw 接口
────────────────────────────────────────────────────────────────────
L0     工业标准（GB/API/ISO）  Milvus（layer='L0'）    Platform /v1/tools/kb/search
L1     OEM 设备手册            Milvus（layer='L1'）    Platform /v1/tools/kb/search
L2     内部规程/SOP            Milvus（layer='L2'）    Platform /v1/tools/kb/search
L3     场站工单经验（已验证）  Milvus（layer='L3'，     Platform /v1/tools/kb/search
                               station_id 过滤）       （同一接口，layer='L3' 自动加）
────────────────────────────────────────────────────────────────────

跨层关系推理：GraphRAG（MinIO Parquet → Platform /v1/tools/graphrag/query）
```

**工单 DONE 后 L3 写入流程（数据飞轮）：**

```
WorkOrder DONE
  → workorder_fsm.py 调用 kb.l3_writer.write_l3_knowledge(wo)（自己建 session）
  → 写 kb_documents（layer=L3, station_id）
  → asyncio.create_task(_embed_and_index_l3())（后台，不阻塞响应）
  → 向量化 → 写 Milvus（与 L0-L2 同一集合，layer 字段区分）
  → 下次查询时自动可用（data flywheel）
```

**实际工单经验格式（存为 kb_documents.content_text）：**

```markdown
设备：C-001（天然气压缩机）
问题描述：振动超标，轴向振动 4.2 mm/s，超过阈值 3.5
处置措施：更换 6203 轴承，润滑后检查振动恢复正常
实际操作：停机 6 小时，拆解检查，更换轴封和轴承
完成时间：2026-05-08T14:32:00+08:00
工单号：WO-2026-0508-001
执行结果：已完成，主管 张工 审批，振动恢复 1.8 mm/s，正常

citations: [SY/T 5724-2020 §5.3, 设备手册_C001_p47]
equipment_id: C-001
verified_by: 王工 (2026-05-08 17:00)
```

---

### Q3：当前方案可以实现"严肃推理"吗？

**结论：可以，但需要明确"严肃推理"的四个必要条件，并逐一满足。**

**严肃推理（Serious Reasoning）的工业场景定义：**

```
"C-001 的振动从 1.8 升至 4.2 mm/s，根据 SY/T 5724 标准，
 结合历史工单 WO-2025-1102-003 的处置经验，
 判断：轴承磨损概率 87%，建议在 48 小时内安排计划停机检修，
 预计影响：下游 P-003 流量下降 15%，需启动旁路阀 V-005。"
```

**四个必要条件和我们的实现：**

| 条件            | 描述                          | 我们的实现                                                  |
| --------------- | ----------------------------- | ----------------------------------------------------------- |
| **①结构化知识** | AI 推理的是对象，不是自由文本 | Industrial Ontology Layer → 设备/工单/关系对象 API          |
| **②可验证引用** | 每个结论有来源，可追溯        | citations 强制字段（L0-L3），工单写 KB 前验证               |
| **③多跳推理**   | 从 A 推 B 推 C，有因果链      | GraphRAG 社区摘要 + Qwen3.6-35B-A3B（推理链输出）           |
| **④置信度量化** | 不确定时明确说不确定          | MOIRAI 输出置信区间，LLM 要求结构化 JSON 带 confidence 字段 |

**严肃推理的 Prompt 框架（固化在 industrial-core SKILL.md 中）：**

```
你是 ClawTwin 工业 AI，必须遵守以下推理规范：

1. 推理链格式：
   前提 [citation:L0/GB50251-§7.3] → 推理步骤 → 结论 [confidence:0.87]

2. 知识来源优先级：
   L3 场站经验 > L2 内部规程 > L1 OEM 手册 > L0 行业标准

3. 不确定性处理：
   confidence < 0.6 → 明确说"建议人工确认"
   涉及停产决策 → 强制 HITL（人工确认）

4. 禁止：
   · 无 citation 的故障诊断结论
   · 未验证的维修建议
   · 超出 equipment_id 范围的推断
```

**Qwen3.6-35B-A3B 为何可以做严肃推理：**

- 支持长上下文（128K），可完整读入本体定义 + 相关知识 + 历史工单
- MoE 架构（A3B 活跃参数），推理质量接近 70B dense，速度更快
- 结构化 JSON 输出（strict JSON mode），推理链格式可强制执行
- Qwen3.6 extended thinking（思维链模式），适合复杂多跳推理

---

### Q4：Platform 不应该包含 OpenClaw 和大模型，边界应该更清晰——正确吗？

**结论：完全正确，这是 ADR-1.0 最大的错误，现在正式纠正。**

**ADR-1.0 的错误描述（已废弃）：**

```
❌ 错误：
"ClawTwin Platform = 11 个 Docker 服务（vLLM/Ditto/Kafka/Milvus/GraphRAG/OpenClaw/等）"

这把 OpenClaw（独立开源项目）和 vLLM（独立推理服务）都划入了 Platform
这是严重的边界错误
```

**ADR-2.0 正确边界（以下为最终定义）：**

```
┌─────────────────────────────────────────────────────────────────┐
│           外部产品（我们不拥有，通过 API 接口调用）               │
│                                                                 │
│  [OpenClaw]  ← 独立开源项目，用户自行部署，调用我们的 Tool API  │
│  [Qwen3.6 vLLM]  ← 独立推理服务，用户自行部署，OpenClaw 调用   │
│  [Feishu]  ← 企业协作平台，OpenClaw 通过 Feishu Channel 接入   │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP/WebSocket 接口调用
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│           ClawTwin Platform（我们开发，我们交付）                │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Industrial Ontology Layer（核心价值层，我们实现）        │   │
│  │  GET /v1/objects/equipment/{id}                          │   │
│  │  GET /v1/objects/station/{id}                            │   │
│  │  POST /v1/objects/workorder                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Industrial Tool API（供 OpenClaw Skills 调用）           │   │
│  │  POST /v1/tools/kb/search      → Milvus 知识检索         │   │
│  │  POST /v1/tools/graph/query    → GraphRAG 关系推理       │   │
│  │  POST /v1/tools/twin/read      → Ditto 实时数据          │   │
│  │  POST /v1/tools/anomaly/detect → MOIRAI 异常检测         │   │
│  │  POST /v1/tools/sim/whatif     → pandapipes What-If      │   │
│  │  POST /v1/tools/workorder/draft → 结构化工单生成         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Industrial API Gateway（鉴权 / 权限 / 多租户）           │   │
│  │  · Nginx + Casbin ABAC（不自己写网关，复用开源）          │   │
│  │  · JWT 验证 OpenClaw 请求合法性                           │   │
│  │  · 站点 × 用户 × 操作三维权限矩阵                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Data Ingestion Services（数据摄入服务）                  │   │
│  │  · Document Service: PDF → LlamaIndex → Milvus           │   │
│  │  · OPC UA Bridge: asyncua → Kafka → Ditto               │   │
│  │  · GraphRAG Indexer: MinIO → GraphRAG → Parquet          │   │
│  │  · L3 Writer: 已验工单 → kb_documents(L3) + Milvus 向量化│   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                     │ 调用开源基础设施（接口关系）
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              开源基础设施（接口解耦，可替换）                    │
│  Eclipse Ditto │ Apache Kafka │ Milvus 2.5 │ PostgreSQL 16      │
│  MinIO         │ Redis        │ GraphRAG   │ LlamaIndex          │
│  MOIRAI 2.0   │ pandapipes   │ Nginx+Casbin                     │
└─────────────────────────────────────────────────────────────────┘
```

---

### Q5：Platform 是飞书接入网关 + OpenClaw 对接知识库和实时数据的网关，对吗？

**结论：部分正确，需要精确描述。**

**精确描述：**

```
Platform 是什么：

1. OpenClaw 的"工业能力后端"
   · OpenClaw 是 AI 编排层（大脑）
   · Platform 是工业专有工具库（手脚和感官）
   · 关系：OpenClaw Skills → 调用 → Platform Industrial Tool API

2. 企业数据的摄入和管理层
   · OPC-UA / IMS 数据 → Kafka → Ditto（实时孪生）
   · PDF 文档 → LlamaIndex → Milvus（知识库）
   · 工单经验 → kb_documents(layer=L3) + Milvus（L3 站级知识）

3. 企业权限和数据治理层
   · 多站点、多角色、多租户权限管理
   · 数据访问审计和合规

Platform 不是什么：
   · ❌ 不是飞书集成层（飞书集成在 OpenClaw 的 Feishu Channel 里）
   · ❌ 不是 LLM 推理层（在 vLLM 服务里）
   · ❌ 不是 AI 编排层（在 OpenClaw 里）
```

**飞书接入的正确数据流：**

```
用户（飞书 App）
  ↓ 飞书消息 API
OpenClaw Gateway（独立运行的开源产品）
  ↓ OpenClaw Feishu Channel（飞书接入，在 OpenClaw 内）
OpenClaw Agent + Skills（AI 推理 + 工具调用）
  ↓ HTTP 调用（industrial-core, industrial-twin, industrial-kb 等 Skills）
ClawTwin Platform Industrial Tool API（我们的代码）
  ↓ 调用
Milvus / Ditto / GraphRAG / pandapipes（开源基础设施）
  ↓
返回结构化结果 + citations → OpenClaw 组装回复 → 飞书消息卡片
```

---

## 二、Platform 服务拆分——最终版（Docker Compose）

**修订后的 Platform Docker Compose（我们开发的服务 vs 接口调用的开源服务）：**

```yaml
# docker-compose.yml（Platform 部署）
services:
  # ── 我们开发的服务（Platform Core）─────────────────────────────

  platform-api: # Industrial Ontology Layer + Tool API
    image: clawtwin/platform-api # 我们写的 FastAPI 服务
    ports: ["8080:8080"]
    depends_on: [postgres, ditto, milvus, redis]
    environment:
      DITTO_URL: http://ditto:8080
      MILVUS_HOST: milvus
      POSTGRES_URL: postgresql://...
      GRAPHRAG_URL: http://graphrag-api:7474
      MOIRAI_URL: http://moirai-service:8888

  ingestion-service: # 文档摄入 + GraphRAG 索引
    image: clawtwin/ingestion # 我们写的 Python 服务
    depends_on: [milvus, minio]

  opcua-bridge: # OPC-UA → Kafka → Ditto
    image: clawtwin/opcua-bridge # 我们写的 Python asyncua 服务
    depends_on: [kafka, ditto]
    profiles: ["real-data"] # mock 模式下不启动

  graphrag-api: # GraphRAG HTTP 封装
    image: clawtwin/graphrag-api # 我们写的 FastAPI 包装 GraphRAG
    depends_on: [minio]

  moirai-service: # MOIRAI 2.0 时序模型服务
    image: clawtwin/moirai # 我们写的模型推理封装

  sim-service: # pandapipes What-If 仿真服务
    image: clawtwin/sim-service # 我们写的仿真封装

  # ── 开源基础设施（通过接口调用）────────────────────────────────

  postgres: # 结构化数据 + TimescaleDB
    image: timescale/timescaledb:latest-pg16

  ditto: # Eclipse Ditto 数字孪生运行时
    image: eclipse/ditto:3.7.0

  kafka: # Apache Kafka 消息总线
    image: confluentinc/cp-kafka:7.6.0

  milvus: # Milvus 2.5 向量数据库
    image: milvusdb/milvus:v2.5.0

  minio: # MinIO 对象存储
    image: minio/minio:latest

  redis: # 缓存
    image: redis:7-alpine

# ── 独立部署，不在 Platform Compose 里 ──────────────────────────
# OpenClaw：用户自行部署（开源产品）
# Qwen3.6 vLLM：用户自行部署（GPU 服务器）
# Nginx + Casbin：可选，用 platform-api 内置网关也可以
```

**服务数量修订：**

- ADR-1.0（错误）：11 服务（含 OpenClaw + vLLM）
- ADR-2.0（正确）：**6 个我们开发的服务** + **6 个开源基础设施** = 12 个容器，但所有权清晰

---

## 三、OpenClaw Skills 如何调用 Platform API

**工业技能（Skills）的正确实现模式：**

```typescript
// contrib/industrial-oilgas-skills/industrial-twin/tool.ts
// 这是一个 OpenClaw Tool，运行在 OpenClaw Gateway 里
// 调用 ClawTwin Platform 的 Industrial Tool API

export const twinReadTool = defineTool({
  name: "twin_read",
  description: "读取工业设备的实时数字孪生状态",
  parameters: z.object({
    equipment_id: z.string(),
    features: z.array(z.string()).optional(),
  }),
  execute: async ({ equipment_id, features }) => {
    // 调用 Platform API（接口关系，不是直接调 Ditto）
    const response = await fetch(
      `${process.env.CLAWTWIN_PLATFORM_URL}/v1/objects/equipment/${equipment_id}`,
      {
        headers: { Authorization: `Bearer ${process.env.CLAWTWIN_API_KEY}` },
      },
    );
    const equipment = await response.json();
    return {
      equipment_id,
      name: equipment.name,
      status: equipment.ditto_state,
      citations: [`Ditto:${equipment_id}`, `OPC-UA:${equipment.opcua_node}`],
      confidence: 0.99, // 实时数据置信度高
    };
  },
});
```

**Skills 目录与调用关系：**

```
contrib/industrial-oilgas-skills/
  industrial-core/SKILL.md         ← 核心推理规范（Prompt 框架）
  industrial-twin/SKILL.md         ← 调用 /v1/objects/equipment/*
  industrial-kb/SKILL.md           ← 调用 /v1/tools/kb/search
  industrial-graph-read/SKILL.md   ← 调用 /v1/tools/graph/query
  industrial-mdm/SKILL.md          ← 调用 /v1/objects/workorder/*
  industrial-simulation/SKILL.md   ← 调用 /v1/tools/sim/whatif
  industrial-readonly-live/SKILL.md ← 调用 /v1/tools/anomaly/detect
  industrial-procedures/SKILL.md   ← 调用 /v1/tools/twin/procedures
  industrial-work-order/SKILL.md   ← 调用 /v1/objects/workorder (POST)
  clawtwin-project/SKILL.md        ← 开发指导 Skill（不是运行时）
```

---

## 四、接口解耦矩阵——所有外部组件的接口契约

| 组件              | 接口类型                        | 版本锁定       | 替换成本 | 替换为              |
| ----------------- | ------------------------------- | -------------- | -------- | ------------------- |
| **Eclipse Ditto** | REST/WebSocket API              | Ditto 3.7      | 中       | AWS IoT TwinMaker   |
| **Milvus 2.5**    | gRPC/HTTP API（PyMilvus SDK）   | v2.5           | 低       | Qdrant / Weaviate   |
| **Apache Kafka**  | Kafka Protocol                  | 3.6+           | 中       | Redpanda / RabbitMQ |
| **GraphRAG**      | Python CLI + 自封装 HTTP        | v3.0.9         | 低       | LlamaIndex KG       |
| **PostgreSQL**    | SQL（SQLAlchemy）               | PG 16+         | 极低     | MySQL（不推荐）     |
| **MOIRAI 2.0**    | HuggingFace Model API           | uni2ts-moirai2 | 低       | TimesFM / Chronos   |
| **pandapipes**    | Python Library                  | 0.11+          | 中       | PIPEQ / 自研 FNO    |
| **Nginx+Casbin**  | HTTP 代理 + Policy API          | —              | 低       | Kong / AWS API GW   |
| **OpenClaw**      | HTTP/WS（OpenClaw Gateway API） | v1 stable      | 低       | 无直接替代          |
| **Qwen3.6 vLLM**  | OpenAI-compatible API           | v0.5+          | 极低     | GPT-4o / Gemini     |

**接口解耦原则（以下为代码约束，不允许违反）：**

```
✅ 允许：
  platform-api 通过 HTTP 调用 ditto:8080
  platform-api 通过 PyMilvus 调用 milvus:19530
  platform-api 通过 psycopg2/asyncpg 调用 postgres:5432

❌ 禁止：
  platform-api 直接 import OpenClaw 内部模块
  platform-api 依赖 Qwen3.6 vLLM 的特定模型响应格式（用 OpenAI 兼容接口）
  ingestion-service 直接调用 Ditto（只能通过 Kafka）
  opcua-bridge 直接写 Milvus（只能写 Kafka，由其他服务消费）
```

---

## 五、严肃推理能力的端到端实现路径

**场景：C-001 压缩机振动异常的严肃推理流程**

```
用户（飞书）："C-001 这两天振动有点大，是什么问题？"

Step 1 [OpenClaw Agent → Platform 本体层]
  调用：GET /v1/objects/equipment/C-001
  返回：{
    name: "C-001 天然气压缩机",
    type: "reciprocating_compressor",
    current: { vibration: 4.2, pressure: 6.1, temp: 78 },
    thresholds: { vibration_warn: 3.5, vibration_alarm: 5.0 },
    status: "WARNING"
  }

Step 2 [OpenClaw Agent → Platform 异常检测]
  调用：POST /v1/tools/anomaly/detect
  Body：{ equipment_id: "C-001", metrics: ["vibration"], window: "7d" }
  返回：{
    anomaly: true,
    trend: "monotonic_increase",
    prediction_72h: { vibration: 5.8, confidence: 0.83 },
    citation: "MOIRAI-2.0:C-001:2026-05-08"
  }

Step 3 [OpenClaw Agent → Platform 关系图谱查询]
  调用：POST /v1/tools/graph/query
  Body：{ entity: "C-001", rel_type: "fault_impact", depth: 2 }
  返回：{
    impacts: [
      { entity: "P-003", impact: "流量下降15%", confidence: 0.76 },
      { entity: "V-005", impact: "旁路阀需开启", confidence: 0.71 }
    ],
    citation: "GraphRAG:community-4:fault-propagation-C001"
  }

Step 4 [OpenClaw Agent → L3 知识查询（Platform 接口）]
  调用：POST /v1/tools/kb/search（layer="L3" 自动按 station_id 过滤）
  Query："C-001 振动 轴承 历史处置"
  返回：{
    found: [
      { title: "WO-2025-1102-003", summary: "轴承磨损→更换轴封→恢复正常",
        citation: "L3:station-A:WO-2025-1102-003" }
    ]
  }
  # ⚠️ 不调用 OpenClaw wiki search，L3 在 Platform Milvus，通过 kb/search 统一接口

Step 5 [OpenClaw Agent → Platform 知识库查询]
  调用：POST /v1/tools/kb/search
  Body：{ query: "往复式压缩机轴承振动诊断", layer: "L1", equipment_type: "compressor" }
  返回：{
    chunks: [{ content: "轴向振动>3.5mm/s 持续24小时，建议停机检查轴承...",
               citation: "SY/T-5724-2020:§5.3" }]
  }

Step 6 [Qwen3.6-35B-A3B 综合严肃推理]
  Prompt 包含：本体对象 + 异常预测 + 影响关系 + 历史工单 + 知识条款
  Output（结构化 JSON）：{
    diagnosis: "轴承磨损（概率 87%）",
    evidence: [
      "振动 4.2 mm/s 超警告阈值，趋势单调上升 [MOIRAI-2.0:C-001]",
      "72h 预测达 5.8 mm/s 接近报警值 [confidence:0.83]",
      "历史工单 WO-2025-1102-003 同类故障确认轴承磨损 [L3:station-A:WO-2025-1102-003]",
      "SY/T 5724-2020 §5.3 规定振动>3.5持续24h需停机检查 [L1:SY/T-5724]"
    ],
    recommendation: "建议 48 小时内计划停机，更换轴封",
    impact_if_delayed: "P-003 流量下降 15%，V-005 需切换旁路",
    hitl_required: true,
    confidence: 0.87
  }

Step 7 [TaskFlow HITL]
  工单草稿发送飞书消息卡片 → 王工审核确认
  → 确认后：POST /v1/objects/workorder（写 PostgreSQL）
  → 触发器：异步写 L3（kb_documents + Milvus，"WO-2026-0508-001 轴承磨损已验证"）
  → L3 知识增长，下次推理更准确（数据飞轮）
```

**这就是"严肃推理"**：每个结论有来源、有置信度、有多跳证据链、有人工确认环、知识动态累积。

---

## 六、多维度验证

### 6.1 工业视角

- ✅ IEC 61511 SIL 安全仪表系统：Platform API 支持安全等级标注
- ✅ ISO 55000 资产管理：全资产生命周期通过 Ontology Layer 管理
- ✅ IEC 62541 OPC-UA：OPC-UA Bridge 标准接入
- ✅ Asset Administration Shell（AAS）：Ditto Thing = AAS Shell 等价

### 6.2 AI 原生视角

- ✅ 知识结构化：Ontology Layer 不是自由文本，AI 推理结构化对象
- ✅ 引用强制：所有 Tool API 返回 citations 字段（强制 schema）
- ✅ 不确定性量化：MOIRAI confidence + LLM confidence 字段标准化
- ✅ 数据飞轮：工单 DONE → 异步写 L3（Milvus layer=L3）→ 下次推理更准

### 6.3 竞争视角（对标分析）

| 竞品         | 我们的对应优势                                       |
| ------------ | ---------------------------------------------------- |
| Palantir AIP | 同等 Ontology 理念，但我们专注工业垂直，成本低 10 倍 |
| Cognite CDF  | 同等数字孪生，但我们集成 LLM 推理，不只是数据平台    |
| 圆晖科技     | 同等 3D 孪生，但我们 AI-native，会"说话"会"推理"     |
| Samsara      | 同等传感器接入，但我们有深度知识推理能力             |

### 6.4 工程视角

- ✅ 所有外部组件通过标准 API 接口，替换不影响 Platform 核心代码
- ✅ Docker Compose 明确区分"我们的服务"和"开源基础设施"
- ✅ OpenClaw Skills 与 Platform API 的版本契约（/v1/ 稳定）

### 6.5 用户体验视角

- ✅ 飞书消息卡片：无需学习新工具，飞书即工业 AI 入口
- ✅ ClawTwin Studio：可视化 3D + AI 对话，双模式（Studio/Command）
- ✅ HITL 不打断工作流：确认/拒绝在飞书卡片内完成，5 秒操作

---

## 七、Phase A 开发优先级调整（基于 ADR-2.0）

**Week 1-2：本体层 API 先行**（先把基础打好）

```
① 定义 Industrial Ontology 数据契约（JSON Schema，先用 mock 数据）
   GET /v1/objects/equipment/{id}  → 固定 mock 返回
   GET /v1/objects/station/{id}    → 固定 mock 返回

② Babylon.js 3D 场景 + 点击设备 → 调用本体 API 展示面板

③ Docker Compose 基础栈：PostgreSQL + Ditto + Milvus（占位启动）
```

**Week 3-4：OpenClaw Skills 接入**（打通 AI 编排）

```
④ industrial-twin skill 调用 Platform /v1/objects/equipment（实时数据）
⑤ industrial-kb skill 调用 Platform /v1/tools/kb/search（mock Milvus）
⑥ industrial-core skill Prompt 框架（citations 强制，置信度输出）
⑦ 飞书消息卡片 + HITL 工单确认 Demo
```

**Week 5-8：数据管道上线**

```
⑧ LlamaIndex 文档摄入 → Milvus（第一批 GB 标准 PDF）
⑨ GraphRAG 索引（C-001 设备手册 + SY/T 5724）
⑩ OPC-UA Bridge Mock（使用 FreeOpcUa 模拟器）
⑪ MOIRAI 异常检测服务（用历史 CSV 数据）
```

---

## 八、更新后的核心文档索引

```
contrib/industrial-oilgas-skills/
  ├── ADR-2-PLATFORM-BOUNDARY.md    ← 本文（覆盖 ADR-1.0 中的 Platform 边界描述）
  ├── ARCH_DECISION_RECORD.md       ← ADR-1.0（知识库决策仍有效，Platform 边界以本文为准）
  ├── INDUSTRIAL_BRAIN_MASTER.md    ← 系统全貌（愿景层）
  ├── FINAL_ARCHITECTURE.md         ← 技术栈选型（仍有效）
  ├── ENTERPRISE_ARCHITECTURE_COMPLETE.md ← 企业级集成架构（仍有效）
  └── clawtwin-project/SKILL.md     ← 开发指导 Skill（须更新 Platform 边界描述）
```

**ADR 优先级：ADR-2.0 > ADR-1.0（Platform 边界）；ADR-1.0 知识库章节仍有效**
