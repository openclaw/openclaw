# ClawTwin 架构简化审计报告

> **版本**：v1.0 · 2026-05-11  
> **性质**：独立批判性审查，结论具有约束力  
> **核心主张**：方向正确，但复杂度失控——Phase A 有 11 个服务但跑的是 Mock 数据，这是严重的过度设计

---

## 一、诊断：什么出了问题？

经过多轮迭代讨论，每次对话都在原有基础上"添加"功能和组件，没有"减法"。结果是：

```
Phase A 当前 docker-compose 启动服务：
  1. PostgreSQL 16          ← 必须
  2. TimescaleDB extension  ← 必须（时序数据）
  3. pgvector extension     ← 已有，可替代 Milvus
  4. Apache AGE extension   ← ❌ 用途不明，实验性
  5. Redis                  ← 必须（缓存+队列）
  6. MinIO                  ← ⚠️ Phase A 暂无文件上传
  7. Apache Kafka           ← ❌ Phase A 用 Mock，无真实数据流
  8. Milvus                 ← ❌ pgvector 已能胜任，重复
  9. Eclipse Ditto          ← ❌ 20台设备用 Redis Hash 足够
 10. vLLM                   ← 必须（LLM 推理）
 11. OpenClaw               ← 必须（AI Agent）

Phase A 还是 MOCK_MODE=true。Kafka 和 Ditto 一个字节的真实数据都没有。
11 个服务 → 至少 16GB 内存才能跑起来。这是 Production 级部署，不是 Phase A MVP。
```

```
Phase A 还有 10 个 Skill：
  industrial-twin / kb / workorder / analytics / inspection /
  production / shift / simulation / admin / clawtwin-project

  industrial-simulation：文件里明确写了"Phase 2 - Not yet available"
  但代码和配置里仍然存在。

10 个 Skill = 10 份 prompt = 10 种行为需要测试 = 10 个维护负担
Phase A 实际需要：3 个 Skill
```

---

## 二、技术选型逐项批判

### 2.1 Eclipse Ditto ❌ Phase A 移除

**是什么**：Eclipse 基金会的 IoT 数字孪生运行时（Java/Scala + Akka + 内置 MongoDB）

**问题**：

- 隐藏依赖：Ditto 内部依赖 MongoDB（又多一个数据库！）
- 对于 20-30 台设备，存储设备状态只需要 Redis Hash
- Ditto 的价值在 1000+ 设备 + 多租户 + W3C WoT 标准合规
- Phase A 的 industrial-twin Skill 写的是"Ditto digital twin snapshots"，这个耦合是错的

**正确方案**：

```python
# 设备影像状态：Redis Hash（不需要 Ditto）
# Key: device:shadow:{equipment_id}
# Value: {status, vibration, temperature, pressure, updated_at}

# Platform Pulse Engine 更新（Mock 或 OPC-UA 推送后）
await redis.hset(f"device:shadow:{equipment_id}", mapping={
    "status": "running",
    "vibration": "3.2",
    "temperature": "85.1",
    "updated_at": datetime.utcnow().isoformat()
})

# GET /v1/equipment/{id} 读取
shadow = await redis.hgetall(f"device:shadow:{equipment_id}")
```

**移除 Ditto 节省**：约 4GB 内存，1 个 Java 服务，MongoDB 依赖

---

### 2.2 Apache Kafka ⚠️ Phase A 替换为 Redis Streams

**是什么**：分布式消息队列，设计目标是每秒百万消息、多消费者、持久化重放

**问题**：

- Phase A 是 MOCK_MODE，根本没有数据流
- Phase B 真实 OPC-UA：30 台设备 × 1Hz = 30 条/秒，Redis Streams 绰绰有余
- Kafka 需要：ZooKeeper 或 KRaft（Kafka 内置共识）+ 大内存 JVM + 配置复杂

**决策**：

```
Phase A（MOCK）：无需消息队列
Phase B（真实 OPC-UA）：Redis Streams（已有 Redis，零新增服务）
  - xadd XSTREAM sensors.raw {equipment_id, metric, value, timestamp}
  - xread 消费
Phase C（100站场，高吞吐）：才真正需要 Kafka
```

**移除 Kafka 节省（Phase A）**：约 2GB 内存，JVM 服务

---

### 2.3 Apache AGE ❌ 移除

**是什么**：PostgreSQL 的 Apache Graph 扩展（基于 Cypher 查询语言）

**为什么加进来的**：某个版本的设计想做"因果图谱推理"（振动+温度→根因）

**问题**：

- 完全实验性：Apache AGE 2.x 仍有大量已知 bug，连 ACID 保证都是有限的
- 用例不清晰：设备因果关系可以用 PostgreSQL + 正则关联查询实现
- 历史告警相关性（振动+温度同升）= TimescaleDB 的窗口函数查询，不需要图数据库

**正确方案**：

```sql
-- 查找"振动高+温度高"的历史共现（TimescaleDB，无需 AGE）
SELECT time_bucket('1 hour', time) as hour,
       COUNT(*) FILTER (WHERE metric='vibration' AND value > 4.0) as vib_count,
       COUNT(*) FILTER (WHERE metric='temperature' AND value > 90) as temp_count
FROM equipment_readings
WHERE equipment_id = 'C-001' AND time > NOW() - INTERVAL '30 days'
GROUP BY hour
HAVING vib_count > 0 AND temp_count > 0;
```

**移除 AGE 节省**：降低 PostgreSQL 不稳定性风险，减少扩展冲突

---

### 2.4 Milvus ❌ Phase A 替换为 pgvector

**是什么**：专用向量数据库，设计用于十亿级向量

**问题**：

- Phase A 知识库预估：L0/L1 各几百篇文档 → 总向量数 < 50,000
- pgvector（已在 PostgreSQL 中）支持 HNSW 索引，10 万向量以下性能优秀
- Milvus 需要独立服务 + 约 2-4GB RAM
- pgvector 已经在栈里（CLAWTWIN-MASTER-V2 里就写了"pgvector"）

**正确方案**：

```sql
-- PostgreSQL + pgvector（已有，不需要额外服务）
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_embeddings (
    id BIGSERIAL PRIMARY KEY,
    document_id BIGINT REFERENCES kb_documents(id),
    chunk_index INT,
    content TEXT,
    embedding VECTOR(1024),   -- bge-m3 输出 1024 维
    metadata JSONB
);

CREATE INDEX ON kb_embeddings USING hnsw (embedding vector_cosine_ops);

-- 语义搜索
SELECT content, 1 - (embedding <=> $1::vector) AS score
FROM kb_embeddings
WHERE station_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

**替换 Milvus 节省**：约 3GB 内存，1 个独立服务，运维复杂度大降

---

### 2.5 10 个 Skill → Phase A 3 个

**当前状态**：

```
industrial-twin        ← 读设备状态
industrial-kb          ← 知识库检索
industrial-workorder   ← 工单管理
industrial-analytics   ← 趋势分析
industrial-inspection  ← 巡检（Phase A 基于工单）
industrial-production  ← 生产数据录入
industrial-shift       ← 班次交接
industrial-simulation  ← Phase 2，文件里写了"Not yet available"
industrial-admin       ← 系统管理
clawtwin-project       ← 开发辅助（不部署）
```

**问题**：10 个 Skill 意味着 OpenClaw 要在 trigger 时路由到正确的 Skill。Skills 越多，触发歧义越高，调试越难。

**Phase A 应该只有 3 个**：

```
industrial-assistant   ← 合并 twin + kb + workorder（主 Skill，处理 80% 场景）
industrial-analytics   ← 趋势分析（独立因为模型不同，需要 MOIRAI 数据）
industrial-admin       ← 系统管理（独立因为权限不同，只给 sys_admin）
```

**industrial-simulation 立即归档**：

```
industrial-simulation/SKILL.md → 重命名为 SKILL.md.phase2（不加载）
```

---

### 2.6 使用 fastmcp 替代自研 MCP Server

**当前设计**：自己写 `platform/routers/mcp.py`，实现 MCP JSON-RPC 2.0 协议

**问题**：MCP 协议有细节（批处理、错误码、schema 验证），自己实现容易出 bug

**正确方案**：使用 `fastmcp` 库（Python MCP 框架，积极维护）

```python
# pip install fastmcp
from fastmcp import FastMCP

mcp = FastMCP("clawtwin-nexus")

@mcp.tool()
async def get_equipment_context(equipment_id: str) -> dict:
    """Get complete equipment context including real-time data and decision package."""
    return await EquipmentService.get_context(equipment_id, current_token)

@mcp.tool()
async def create_work_order(
    equipment_id: str,
    work_type: str,
    title: str,
    description: str,
    priority: str = "normal"
) -> dict:
    """Create a maintenance work order (starts in draft state, requires supervisor approval)."""
    return await WorkOrderService.create_draft(
        equipment_id=equipment_id,
        work_type=work_type,
        title=title,
        description=description,
        priority=priority,
        created_by=current_token.user_id
    )

# 挂载到 FastAPI
app.mount("/mcp", mcp.get_asgi_app())
```

**使用 fastmcp 的收益**：

- 不需要实现 MCP 协议细节（JSON-RPC、error codes、schema）
- 工具注册是装饰器，清晰简洁
- 自动生成 tool schema（从 Python 类型注解）
- 官方测试覆盖

---

### 2.7 MinIO 延迟到 Phase B

**Phase A 中 MinIO 的用途**：工单完工证据上传（现场照片）

**问题**：Phase A 的 Demo 场景不需要真实图片上传。可以先用 URL 字符串占位。

**方案**：

```python
# Phase A：evidence_urls 存储外部 URL 或跳过（不需要 MinIO）
class WorkOrder(Base):
    evidence_urls: list[str] = []  # Phase A 可为空数组

# Phase B：接入 MinIO
# POST /v1/workorders/{id}/evidence → multipart upload → MinIO
```

---

## 三、修正后的 Phase A 技术栈（最小可行）

```
必须（4个服务）：
  ┌─────────────────────────────────────────────┐
  │  PostgreSQL 16                              │
  │    + TimescaleDB（时序）                    │
  │    + pgvector（向量，替代 Milvus）           │
  │    （移除 AGE）                             │
  ├─────────────────────────────────────────────┤
  │  Redis 7                                   │
  │    缓存 + 设备影子状态（替代 Ditto）         │
  │    会话管理 + 频率限制                      │
  ├─────────────────────────────────────────────┤
  │  vLLM                                      │
  │    Qwen3 标准 + Thinking + VL              │
  │    bge-m3（embed endpoint）                 │
  ├─────────────────────────────────────────────┤
  │  OpenClaw                                  │
  │    加载 3 个 Sage Skills                   │
  └─────────────────────────────────────────────┘

Phase B 新增：
  + opcua-bridge（真实 OT 数据，DMZ 隔离）
  + Redis Streams（替代 Kafka，30设备/1Hz）
  + MinIO（工单证据照片）

Phase C 新增（按需）：
  + Apache Kafka（100站场+高吞吐时）
  + Milvus（向量 > 100万时）
  + Eclipse Ditto（多租户数字孪生标准时）
  + MOIRAI 2.0 独立服务（时序预测）
```

**内存对比**：

```
当前 Phase A（11服务）：≥ 16GB RAM
修正 Phase A（4服务）：≥ 6GB RAM

开发者 MacBook M1/M2（16GB）即可完整运行修正版 Phase A
```

---

## 四、Phase A 范围重新校准（防止继续膨胀）

### 核心交付（Week 1-12，不可减少）

```
[T1]  数据库 Schema（设备/告警/工单/知识库/用户）
[T2]  认证 + JWT + ABAC + 审计日志
[T3]  设备状态 API（Redis Shadow + TimescaleDB 时序）
[T4]  告警管理（ISA-18.2 基础：确认/关闭/优先级）
[T5]  工单 FSM（7种类型，draft→done 状态机）
[T6]  知识库 RAG（pgvector，L0+L1 冷启动）
[T7]  MCP Server（fastmcp，8个只读工具 + 3个写操作）
[T8]  OpenClaw 集成（3个 Skill，Feishu Bot）
[T9]  Studio Shell + 设备列表 + 告警队列 + 工单看板
[T10] Mock 数据 Scheduler + 基础告警引擎
[T11] 飞书通知（告警推送 + 工单审批卡片）
[T12] Demo 数据 + E2E 验收
```

### 推迟到 Phase A+（+4-6周，独立里程碑）

```
[A+1] 生产数据 API（日报录入/KPI）
[A+2] 班次交接 API
[A+3] 巡检调度 API
[A+4] 5个写操作 MCP 工具 + Safety Contract
[A+5] clawtwin CLI（Typer）
[A+6] ISA-18.2 完整 KPI 告警指标
```

### 推迟到 Phase B（+6个月）

```
[B1]  真实 OPC-UA Bridge（opcua-bridge 微服务）
[B2]  Redis Streams 数据管道
[B3]  MOIRAI 2.0 时序预测集成
[B4]  MinIO 文件存储（工单证据）
[B5]  LLM 增强知识提炼（OpenClaw 触发）
[B6]  10 个额外 MCP 工具
[B7]  Studio 高级视图（P&ID 浏览器）
```

---

## 五、成熟库推荐（替代自研）

| 功能       | 当前方案               | 推荐成熟库                   | 理由                     |
| ---------- | ---------------------- | ---------------------------- | ------------------------ |
| MCP Server | 自研 JSON-RPC          | `fastmcp` (PyPI)             | 官方 MCP Python 实现     |
| 向量存储   | Milvus                 | `pgvector` (PostgreSQL 扩展) | 已在栈里，省一个服务     |
| 状态机     | 自研 VALID_TRANSITIONS | `transitions` (PyPI)         | 成熟 Python FSM 库       |
| Feishu API | 自研 FeishuClient      | `lark-oapi` (飞书官方 SDK)   | 官方 SDK，事件订阅覆盖全 |
| 定时任务   | APScheduler            | APScheduler 4.x ✅           | 已在设计中，保留         |
| 嵌入向量   | 自研调用               | `sentence-transformers`      | 本地 bge-m3 调用封装     |
| 数据库迁移 | Alembic ✅             | Alembic ✅                   | 保留                     |
| API 框架   | FastAPI ✅             | FastAPI ✅                   | 保留                     |
| ORM        | SQLAlchemy async ✅    | SQLAlchemy async ✅          | 保留                     |

---

## 六、Skill 设计优化

### 当前问题

```
10 个 Skill → OpenClaw 触发路由复杂 → 调试困难
industrial-twin 提到"Ditto digital twin snapshots" → 错误耦合（Ditto 要移除）
industrial-simulation 是 Phase 2，不应该存在于 Phase A 配置中
```

### 修正方案

**Phase A 只部署 3 个 Skill：**

```yaml
# industrial-assistant（主 Skill，合并 twin+kb+workorder）
name: industrial-assistant
description: |
  主要工业助手。处理设备状态查询、知识库检索、工单创建和告警处理。
  覆盖日常操作 80% 的场景。
triggers:
  - 设备状态 / 告警 / 工单 / 帮我 / 怎么 / 什么原因
tools:
  - get_equipment_context
  - get_active_alarms
  - search_knowledge_base
  - create_work_order
  - acknowledge_alarm
  - notify_user

# industrial-analytics（独立，触发词不同）
name: industrial-analytics
description: |
  趋势分析和 KPI 报告。用于历史数据查询、效率分析、生产统计。
triggers:
  - 趋势 / 分析 / 历史 / KPI / 报表 / 对比

# industrial-admin（独立，仅 sys_admin）
name: industrial-admin
description: |
  系统管理。仅限管理员使用。用户管理、知识库管理、系统健康检查。
triggers:
  - 系统状态 / 添加用户 / 管理知识库
roles:
  - sys_admin
```

**industrial-twin 中的错误耦合修正：**

```markdown
<!-- 删除这句 -->

Use when ... or reading Ditto digital twin snapshots.

<!-- 改为 -->

Use when reading real-time equipment state from Nexus Platform API.
Equipment state is served via /v1/equipment/{id} with Redis-cached shadow data.
```

---

## 七、模块边界清晰化（一张图）

```
┌──────────────────────────────────────────────────────────────────┐
│              用户（自然语言 / Studio Web UI）                      │
└───────────┬──────────────────────────┬───────────────────────────┘
            │ Feishu Bot               │ HTTPS
            ▼                          ▼
┌───────────────────┐    ┌─────────────────────────────────────────┐
│   OpenClaw        │    │       ClawTwin Studio（React）           │
│   AI Agent 运行时  │    │  TwinPage + AlarmQueue + WorkOrderBoard  │
│                   │    │  只读数据展示 + 工单创建 + HITL 审批       │
│  Sage Skills (3): │    │  ↑ JWT Bearer Token                     │
│  assistant        │    │  ↑ 不直接调 /v1/tools/*                  │
│  analytics        │    └──────────────┬──────────────────────────┘
│  admin            │                   │
│       │ MCP       │    ┌──────────────▼──────────────────────────┐
│       │ (fastmcp) │    │       ClawTwin Nexus（FastAPI）          │
│       ▼           │───►│                                         │
└───────────────────┘    │  认证/ABAC  工单FSM  告警引擎  Scheduler │
                         │  MCP Server  AgentConnector  审计日志    │
                         │                                         │
                         │  ← bge-m3 embed（向量化，合规）           │
                         │  ← MOIRAI 2.0（Phase B，时序预测）       │
                         └──────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────┼──────────────┐
                    ▼                   ▼              ▼
            ┌──────────────┐   ┌────────────┐  ┌──────────┐
            │  PostgreSQL  │   │   Redis 7  │  │  vLLM    │
            │  TimescaleDB │   │  Shadow    │  │  Qwen3   │
            │  pgvector    │   │  Cache     │  │  bge-m3  │
            │  (替代Milvus) │   │  (替代Ditto)│  │          │
            └──────────────┘   └────────────┘  └──────────┘

Phase B 增加：opcua-bridge(DMZ) → Redis Streams → Nexus
Phase C 增加：Kafka / Milvus / Eclipse Ditto（按需）
```

**边界规则：**

| 组件         | 只做这些                               | 绝不做                                |
| ------------ | -------------------------------------- | ------------------------------------- |
| Studio       | 展示数据，收集用户操作，发 HTTP 请求   | 直接调 AI，直接调 /v1/tools/\*        |
| Nexus        | 数据存储，业务规则，HITL，MCP 工具服务 | LLM 推理（chat completion），对话管理 |
| OpenClaw     | AI 对话，Agent Loop，Skill 调度        | 持久化业务数据，直接操数据库          |
| Skills       | prompt + 工具选择策略配置              | 业务逻辑，数据库操作                  |
| opcua-bridge | OT 数据采集，推 Redis Streams          | 连 PostgreSQL，连 Milvus              |

---

## 八、什么是真正的先进性（对照 2026 年行业趋势）

### ✅ 正在做且正确的

1. **MCP 工具协议**：2025-2026 年主流 AI 工具接口标准，Anthropic/OpenAI/Google 均支持
2. **Tool-chaining vs Intent-routing**：正确范式，消除意图分类的脆弱性
3. **HITL 工单状态机**：工业 AI 安全的正确做法，与 ISA-99 工业安全理念一致
4. **三层知识体系 L0/L1/L2/L3**：渐进可信度，有引用来源，优于黑盒 AI
5. **bge-m3 + RAG**：中文工业文本的正确选型
6. **Feishu Bot 优先**：中国企业 AI 落地的最低摩擦路径

### ⚠️ 概念正确但实现超前（做 Phase C 的设计）

1. **Eclipse Ditto**：正确的 IoT 数字孪生标准，但 Phase A 场景不需要
2. **Apache Kafka**：正确的 OT/IT 桥接方案，但 30 设备用不着
3. **Milvus**：正确的企业级向量库，但 5 万向量 pgvector 更合适
4. **10 个 Skill**：细粒度 Skill 是正确方向，但 Phase A 先验证核心再拆分

### ❌ 存在问题的设计

1. **Apache AGE**：实验性图数据库扩展，风险大于收益
2. **Phase A 范围无节制膨胀**：每次对话加新功能，没有做减法
3. **Skill 提到 Ditto**：与实际实现产生错误耦合

---

## 九、行动清单（按优先级）

### 立即执行（影响 Phase A 启动）

```
[ ] 1. DEVELOPMENT-CONTRACT.md §五：移除 Kafka、Milvus、Eclipse Ditto 的启动命令
       替换为 pgvector（PostgreSQL 扩展，已有）和 Redis Shadow（替代 Ditto）
       docker compose up -d postgres redis vllm openclaw  ← 4 个服务

[ ] 2. 移除 Apache AGE 扩展初始化命令
       删除：CREATE EXTENSION IF NOT EXISTS age;

[ ] 3. industrial-twin/SKILL.md：删除 "Ditto digital twin snapshots" 表述
       替换为 "Redis-cached shadow state via Nexus /v1/equipment/{id}"

[ ] 4. industrial-simulation/SKILL.md → 重命名为 SKILL.md.deprecated
       OpenClaw Skills 配置中移除此 Skill

[ ] 5. CURSOR-MULTITASK-GUIDE.md T11（MCP Server）：添加 fastmcp 库使用说明
```

### 本周完成（架构清晰化）

```
[ ] 6. 修改 Phase A 技术栈图（所有文档中的架构图）
       PostgreSQL + Redis + vLLM + OpenClaw（4个）
       注明 Phase B/C 才引入 Kafka/Milvus/Ditto

[ ] 7. 合并 industrial-twin + industrial-kb + industrial-workorder
       → 一个 industrial-assistant Skill（Phase A 主 Skill）
       生产/班次/巡检 Skill 推迟到 Phase A+ 验证后

[ ] 8. MODULE-DESIGN-PLATFORM.md 中的 Milvus 代码替换为 pgvector
       MilvusService → VectorService（接口不变，实现换 pgvector）
```

### Phase B 前完成

```
[ ] 9. opcua-bridge 重命名为 ot-bridge，定义 Protocol Adapter 接口
       OPC-UA 是一种实现，Modbus/IEC104 是另一种

[ ] 10. 引入 MOIRAI 2.0 独立服务（仅当时序预测有实际需求时）
        Phase A 用 TimescaleDB 移动平均 + 阈值规则替代
```

---

_本文档是对整个项目 2026-05-11 架构状态的独立批判性审查。_  
_所有标注"立即执行"的项目在开发启动前必须完成，否则 Phase A 开发难度不必要地增大。_
