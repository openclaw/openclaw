# ClawTwin 最终架构综述与 Cursor 开发指南

> 版本：v1.0 · 2026-05-11  
> 目标：一份文档回答所有剩余架构问题 + Cursor 高效开发实战指南  
> 前置必读：`ARCHITECTURE-PROTOCOL-ANALYSIS.md`（最新协议分析权威）

> **⚠️ 技术栈更新说明（2026-05-11）**：  
> 本文档中出现的 Milvus 均应替换为 **pgvector**（PostgreSQL 扩展）。  
> Phase A 技术栈已精简为 4 个服务：`postgres(TimescaleDB+pgvector) + redis + vllm + openclaw`。  
> 知识库 RAG 使用 **LlamaIndex**（`llama-index-core` + `llama-index-vector-stores-postgres`）。  
> 详见：`ARCHITECTURE-SIMPLIFICATION-AUDIT.md` + `ARCHITECTURE-FINAL-CRITICAL-AUDIT.md`

---

## 一、OpenClaw 完整架构解析——ClawTwin 该借鉴什么

### 1.1 OpenClaw 的六大子系统

```
┌────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                       │
│  (daemon / WebSocket server / control plane)                │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Session Mgr │  │  Agent Loop  │  │  Plugin Registry │  │
│  │  per-user    │  │  (LLM calls) │  │  (Skills/Tools)  │  │
│  │  isolation   │  │  tool calls  │  │  MCP / ACP       │  │
│  └─────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Memory Sys  │  │  Channel Sys │  │  Provider Sys    │  │
│  │  MEMORY.md   │  │  Feishu/TG   │  │  Qwen/Claude     │  │
│  │  daily notes │  │  Slack/Discord│ │  OpenAI-compat   │  │
│  │  LanceDB     │  │  WebChat     │  │  vLLM/Ollama     │  │
│  └─────────────┘  └──────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**六大子系统详解：**

| 子系统                  | 职责                                                             | ClawTwin 是否需要借鉴                                               |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Session Manager**     | 多用户对话隔离 (`per-channel-peer`)；会话生命周期；每日/闲置重置 | **不需要** — OpenClaw 已处理，Nexus 不管对话会话                    |
| **Agent Loop**          | LLM 调用 → Tool 调用 → 响应生成 → 流式输出                       | **不需要** — OpenClaw 负责；Nexus 只提供 MCP 工具                   |
| **Memory System**       | MEMORY.md (长期) + daily notes (日志) + LanceDB/Honcho (向量)    | **不需要** — 这是 AI 对话记忆，Nexus 有独立的工业 KB                |
| **Channel System**      | Feishu/Telegram/Discord/Slack 消息路由                           | **不需要** — Feishu 直连 OpenClaw；Nexus 只发推送通知               |
| **Provider System**     | LLM 模型选择、failover、流控                                     | **不需要** — OpenClaw 管理；Nexus 调用独立 vLLM HTTP API            |
| **Plugin/Skill System** | SKILL.md 格式；MCP 工具注册；ACP 代理连接                        | **✅ 借鉴** — Sage Skills 采用 SKILL.md 格式；Nexus 提供 MCP Server |

### 1.2 OpenClaw 记忆系统 vs ClawTwin 知识系统

**关键区分：两者是完全不同层次的"记忆"**

```
OpenClaw 记忆（AI 对话记忆）          ClawTwin 知识（工业域知识）
─────────────────────────────────────────────────────────────
MEMORY.md ← 个人习惯/偏好              工业标准 (GB, SY/T, API 510)
daily notes ← 今日工作日志             设备厂商手册、历史维修案例
LanceDB ← 对话历史向量                 **pgvector** ← 工况-故障语义向量（`kb_chunks`）
session transcripts ← 对话历史         TimescaleDB ← 传感器时序数据
作用域：per-agent-per-user             作用域：per-station (全用户共享)
管理者：OpenClaw 自动维护              管理者：Nexus 知识库管理 API
```

**结论：ClawTwin 不需要实现任何 OpenClaw 式的对话记忆。**  
ClawTwin 的知识库是工业域知识 (L0-L3)，完全不同于 OpenClaw 的用户个人记忆。

### 1.3 OpenClaw 的 Workspace 概念 vs ClawTwin 的 Station 概念

| 维度     | OpenClaw Workspace                               | ClawTwin Station (工作区)            |
| -------- | ------------------------------------------------ | ------------------------------------ |
| 定义     | Agent 的文件系统根目录 (`~/.openclaw/workspace`) | 一座物理站场（泵站、压气站、计量站） |
| 隔离粒度 | per-agent                                        | per-station (ABAC 权限控制)          |
| 内容     | MEMORY.md, SOUL.md, AGENTS.md                    | 设备树、传感器、告警、工单           |
| 多用户   | 通过 `dmScope` 隔离对话                          | 通过 JWT + station_ids 控制访问      |
| 切换     | agent 配置 workspace 路径                        | Studio NavRail 站场选择器            |

**结论：两套 Workspace 概念完全平行，互不干扰。ClawTwin 的"多工作区"是多站场管理，由 Nexus ABAC 控制。**

---

## 二、模块边界最终定义（权威版）

### 2.1 系统全景图（分层）

```
╔══════════════════════════════════════════════════════════════════════╗
║                         用户交互层                                    ║
║  ┌─────────────────────┐          ┌─────────────────────────────┐    ║
║  │  ClawTwin Studio    │          │  Feishu / 企业微信 客户端    │    ║
║  │  React 18 + Babylon │          │  (移动端/桌面端)             │    ║
║  │  运营人员 Web 界面   │          │  操作员消息/指令             │    ║
║  └──────────┬──────────┘          └───────────────┬─────────────┘    ║
╚═════════════╪══════════════════════════════════════╪════════════════╝
              │ REST/SSE                             │ Feishu 协议
              │                                      ▼
╔═════════════╪══════════════╗    ╔══════════════════════════════════╗
║  ClawTwin   │  Nexus       ║    ║  AI Agent Runtime                 ║
║  Platform   │  (FastAPI)   ║    ║  OpenClaw / Hermes / Dify        ║
║  ┌──────────▼───────────┐  ║    ║  ┌────────────┐ ┌─────────────┐ ║
║  │  REST API (Studio用) │  ║    ║  │ Channel    │ │  Agent Loop  │ ║
║  │  MCP Server (AI用)   │◄─╫────╫──│ Plugin     │ │  Memory Sys  │ ║
║  │  Webhook (Feishu卡片)│  ║    ║  │ (Feishu)   │ │  Session Mgr │ ║
║  ├──────────────────────┤  ║    ║  └────────────┘ └─────────────┘ ║
║  │  业务逻辑层           │  ║    ║                ▲                  ║
║  │  Pulse Engine        │  ║    ║                │ vLLM API          ║
║  │  AI Job Queue        │  ║    ╚════════════════╪══════════════════╝
║  │  Action Policy       │  ║                     │
║  │  Scheduler           │  ║    ╔════════════════╪══════════════════╗
║  ├──────────────────────┤  ║    ║  GPU Server (独立)                 ║
║  │  数据层               │  ║    ║  vLLM (Qwen3) + OpenAI-compat API║
║  │  PostgreSQL+pgvector │  ║    ╚════════════════════════════════════╝
║  │  TimescaleDB          │  ║
║  │  Redis (缓存/队列)    │  ║    ╔════════════════════════════════════╗
║  │  Kafka (Phase B/C)   │◄─╫────╫── OPC-UA Bridge (DMZ)              ║
║  └──────────────────────┘  ║    ║  SCADA/DCS → Kafka: ot.telemetry   ║
╚════════════════════════════╝    ╚════════════════════════════════════╝
```

### 2.2 六个独立部署单元（完全解耦）

#### 单元 1：Nexus Platform（核心平台）

```
职责：工业域后端 + MCP 工具提供者 + Studio REST API 服务器

拥有：
  ✅ 设备本体 (equipment, equipment_types, metrics)
  ✅ 告警管理 (alarms, alarm_rules)
  ✅ 工单系统 (work_orders, work_order_tasks)
  ✅ 工业知识库 (kb_documents + **pgvector** / `kb_chunks`)
  ✅ AI 任务队列 (ai_jobs)
  ✅ Pulse Engine (Kafka 消费者 + 告警评估)
  ✅ 决策包 (decision_package, 预计算缓存)
  ✅ 用户与权限 (users, stations, ABAC)

不拥有：
  ❌ AI 对话/会话管理 (交给 OpenClaw)
  ❌ LLM 推理 (调用独立 vLLM)
  ❌ Feishu 消息路由 (交给 OpenClaw)
  ❌ OT 数据采集 (交给 OPC-UA Bridge)

对外接口：
  → REST API  /v1/*       (Studio + OA/ERP 集成)
  → MCP       /mcp        (AI Agent Runtime)
  → Webhook   /feishu/*   (仅 card.action.trigger)
  → SSE       /v1/sse/*   (Studio 实时推送)
  → Admin     /v1/admin/* (运维管理)
```

#### 单元 2：Studio（前端）

```
职责：Web 运营工作台，纯前端

拥有：
  ✅ React UI 组件 (Babylon.js 3D, P&ID, 仪表盘)
  ✅ 客户端状态 (Zustand store)
  ✅ MSW Mock (开发期 API 模拟)

不拥有：
  ❌ 任何后端逻辑
  ❌ 直接数据库连接
  ❌ 独立后端服务

后端 = Nexus Platform（唯一依赖）

通信方式：
  → REST API (GET/POST/PATCH)
  → SSE     (实时告警/AI 任务状态)
  绝不直接访问 DB / Kafka / **PostgreSQL 向量层（pgvector）**
```

**⚠️ 关键确认：Studio 没有独立后端，Nexus 就是 Studio 的后端。**

#### 单元 3：Sage Skills（AI 能力配置包）

```
职责：AI 能力定义，纯配置，无代码

拥有：
  ✅ SKILL.md (系统提示 + MCP 工具配置)
  ✅ 工业 Prompt 模板
  ✅ 工具调用规范 (Nexus MCP 工具列表)

不拥有：
  ❌ 任何运行代码
  ❌ 数据访问逻辑

兼容性：
  → 可在 OpenClaw / Hermes / Dify 任意一个 AI Runtime 中加载
  → 通过 MCP 连接 Nexus 获取工业数据
```

#### 单元 4：AI Agent Runtime（AI 运行时）

```
职责：AI 对话编排 + 渠道管理，独立部署

拥有：
  ✅ 用户对话会话 (session transcripts, MEMORY.md)
  ✅ 渠道连接 (Feishu Bot / 企业微信)
  ✅ LLM 调用编排 (provider failover)
  ✅ Tool 调用执行 (MCP client)

不拥有：
  ❌ 工业域数据 (由 Nexus 通过 MCP 提供)
  ❌ 业务逻辑 (Nexus 处理)

通信方式：
  → 对用户: Feishu/Telegram 消息
  → 对 Nexus: MCP 工具调用 (主路径) + REST API (触发异步任务)
  → 对 GPU: OpenAI-compatible API

可替换性：
  OpenClaw ↔ Hermes ↔ Dify（接口统一为 MCP + REST）
```

#### 单元 5：OPC-UA Bridge（数据采集）

```
职责：OT 数据采集，独立进程，部署在 DMZ

拥有：
  ✅ OPC-UA 连接管理
  ✅ 数据规整 (单位换算, 时间戳标准化)
  ✅ Kafka 发布 (Topic: ot.telemetry, ot.events)

不拥有：
  ❌ 业务逻辑
  ❌ 数据持久化 (Kafka 下游 Nexus 负责)

网络：单向出站（OT → IT），不接受任何入站连接
```

#### 单元 6：GPU Server（推理服务）

```
职责：大模型推理，独立服务器

拥有：
  ✅ vLLM 进程 (Qwen3 INT4)
  ✅ OpenAI-compatible API

不拥有：
  ❌ 任何业务逻辑
  ❌ 状态管理

访问控制：
  → AI Runtime → GPU (LLM 推理)
  → Nexus → GPU (embedding 生成，可选)
```

---

## 三、多用户 / 多会话 / 多工作区设计

### 3.1 多用户（Multi-User）

**层次划分：**

```
Nexus 层（数据隔离）        AI Runtime 层（对话隔离）
─────────────────────────────────────────────────────
JWT 身份认证                 session.dmScope: "per-channel-peer"
ABAC 站场权限                每个 Feishu 用户独立会话
station_ids 字段控制          对话历史互不可见
API 按用户 ID 过滤数据        用户 A 无法看到用户 B 的对话

示例：
  用户 A: station_ids = [1, 2]     用户 A: session_id = "s-alice-feishu"
  用户 B: station_ids = [2, 3]     用户 B: session_id = "s-bob-feishu"
  → 共享站场 2 的设备数据          → AI 记忆完全隔离
  → 各自的操作记录                  → 各自的对话历史
```

**用户角色体系（最终版）：**

| 角色            | station_ids     | 权限                          |
| --------------- | --------------- | ----------------------------- |
| `operator`      | 指定 1-N 个站场 | 读数据 + 创建/关闭工单        |
| `supervisor`    | 指定 1-N 个站场 | 同 operator + 审批 + 报告导出 |
| `station_admin` | 指定 1-N 个站场 | 同 supervisor + 配置设备参数  |
| `sys_admin`     | 全部站场        | 全权限 + 用户管理 + 系统配置  |

### 3.2 多会话（Multi-Session）

**两种会话的明确区分：**

| 维度     | AI 对话会话（OpenClaw 管理） | AI 任务会话（Nexus 管理）    |
| -------- | ---------------------------- | ---------------------------- |
| 触发方式 | 用户发送 Feishu 消息         | 用户在 Studio 点击"AI 诊断"  |
| 生命周期 | 持续（直到 daily reset）     | 一次性（异步任务完成即结束） |
| 状态存储 | OpenClaw sessions/ 目录      | Nexus ai_jobs 表             |
| 上下文   | 携带完整对话历史             | 携带 decision_package 快照   |
| 多并发   | 是（每用户一个活跃会话）     | 是（多个 ai_job 并行）       |

**Studio 中的"对话连续性"设计决策：**

```
Phase A（MVP）：
  Studio AI 任务 = 无状态（每次诊断独立）
  原因：简化实现；每次带完整 decision_package 上下文足够
  影响：用户无法在 Studio 中"追问"AI

Phase B（迭代）：
  引入 Studio 内嵌对话面板
  → Studio 调用 AgentConnector.create_session()
  → OpenClaw 创建新会话
  → Studio 通过 SSE 接收流式 AI 回复
  → 用户可追问，上下文由 OpenClaw 维护
```

### 3.3 多工作区（Multi-Workspace = 多站场）

**站场选择器设计（Studio UI 必需组件）：**

```typescript
// 缺失组件：StationSwitcher
// 位置：Studio NavRail 顶部
interface StationSwitcherProps {
  currentStationId: number;
  availableStations: Station[]; // 来自 JWT payload 的 station_ids
  onSwitch: (stationId: number) => void;
}

// 切换站场时：
// 1. 更新全局 Zustand store: { currentStationId }
// 2. 所有 API 请求自动带上 station_id 查询参数
// 3. 3D 场景重新加载新站场模型
// 4. SSE 订阅切换到新站场
```

**站场隔离保证（Nexus 后端）：**

```python
# 每个 API 端点强制校验 station_id 访问权限
async def require_station_access(
    station_id: int,
    user: User = Depends(get_current_user)
) -> Station:
    if station_id not in user.station_ids and user.role != "sys_admin":
        raise HTTPException(403, "无权访问该站场")
    return await Station.get(station_id)
```

---

## 四、剩余架构空白补全

### 4.1 错误处理与熔断

**MCP 调用失败处理（AI Runtime 侧）：**

```python
# AI Agent 调用 Nexus MCP 工具失败时的降级策略
#   → 网络超时: 自动重试 3 次，指数退避
#   → 认证失败: 提示用户 "系统访问令牌已过期，请联系管理员"
#   → 工具不存在: 返回 "该功能暂不可用"，记录告警
#   → 数据不存在: 返回 "未找到 {equipment_id} 的相关数据"
```

**AI 任务超时处理（Nexus 侧）：**

```python
# ai_jobs 表的超时字段
class AIJob(Base):
    timeout_seconds: int = 300   # 默认 5 分钟
    status: str  # pending → running → completed / failed / timeout

# Scheduler 定期检查超时任务
async def check_job_timeouts():
    expired = await AIJob.filter(
        status="running",
        started_at__lt=datetime.now() - timedelta(seconds=timeout_seconds)
    )
    for job in expired:
        job.status = "timeout"
        await job.save()
        await publish_event("ai_job.timeout", {"job_id": job.id})
```

**Kafka 不可用降级（Nexus 侧）：**

```python
# Phase A: OT 数据通过 REST polling 作为 Kafka 的降级路径
# Pulse Engine 优先消费 Kafka，Kafka 不可用时 fallback 到
# OPC-UA Bridge 的直接 REST API (内网, 不跨 DMZ)
```

### 4.2 多租户（Phase C 准备）

```
Phase A-B: 单租户部署（每个企业独立部署 Nexus 实例）
  优点：数据完全隔离，符合工业企业安全要求
  部署：Docker Compose / K8s on-premise

Phase C（云 SaaS）: 多租户 Nexus
  技术方案：Row-Level Security (PostgreSQL RLS)
  tenant_id 字段全表添加
  每个 API 请求自动注入 tenant_id 过滤
  **pgvector**：按 `tenant_id` / `station_id` 过滤；**独立 Milvus 多租户 Collection** 仅 Phase C 超大规模备选

Phase A 代码预留：
  users 表已有 company_id 字段（可选，暂不强制）
  API 响应格式统一（方便后续多租户改造）
```

### 4.3 Station Switcher 补入 Studio 设计

这是 `MODULE-DESIGN-STUDIO.md` 中遗漏的组件，需要加入。

**触发路由 + 数据刷新流：**

```
用户选择站场 2
    ↓
StationSwitcher.onSwitch(2)
    ↓
store.setCurrentStation(2)
    ↓
┌──────────────────────────────────────┐
│  所有订阅 currentStationId 的组件     │
│  自动重新 fetch:                      │
│  - GET /v1/equipment?station_id=2    │
│  - GET /v1/alarms?station_id=2       │
│  - GET /v1/work-orders?station_id=2  │
│  - 重连 SSE: /v1/sse/station/2       │
└──────────────────────────────────────┘
    ↓
TwinSurface 加载站场 2 的 3D 模型
```

---

## 五、架构完善度最终评估

| 模块               | 设计完整度 | 状态                            |
| ------------------ | ---------- | ------------------------------- |
| Nexus REST API     | 98%        | ✅ 可开发                       |
| Nexus MCP Server   | 95%        | ✅ 可开发（Phase A 必做）       |
| Nexus Pulse Engine | 90%        | ✅ 可开发                       |
| Nexus 知识库       | 92%        | ✅ 可开发                       |
| Nexus 数据模型     | 95%        | ✅ 可开发                       |
| Studio UI 架构     | 88%        | ⚠️ 缺 StationSwitcher 设计      |
| Studio 3D / P&ID   | 85%        | ⚠️ 细节待 Phase A 实现中完善    |
| Sage Skills        | 90%        | ✅ 可开发                       |
| AI Runtime 集成    | 92%        | ✅ 可开发                       |
| OPC-UA Bridge      | 85%        | ✅ 可开发                       |
| 多用户/权限        | 95%        | ✅ 可开发                       |
| 多站场/工作区      | 90%        | ✅ 可开发（补 StationSwitcher） |
| 错误处理           | 75%        | ⚠️ 框架清晰，细节实现中补       |
| **整体**           | **91%**    | **✅ 可支持并行开发**           |

**结论：架构设计已充分完善，可支持按 `PARALLEL-DEV-TASKSPEC.md` 分配的并行开发任务。**

---

## 六、Cursor 多任务高效开发指南

### 6.1 核心原则

```
每个 Cursor Task = 一个独立模块/功能
Task 之间不共享上下文（每个 Task 需要自带完整上下文）
并行 Task 数量：建议 3-4 个（太多难以管理）
```

### 6.2 启动 Task 的标准模板

**每个新 Task 开头必须粘贴的 Context Prompt：**

```
我在开发 ClawTwin 工业数字孪生系统。

项目核心设计文档（按优先级读取）：
1. 首先读 contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md（项目索引）
2. 当前任务相关文档：[见下方]

项目架构关键点：
- Nexus（FastAPI Python）是 Studio 唯一的后端，无独立 Studio 后端
- Studio 是纯 React 前端，通过 REST/SSE 连接 Nexus
- AI Runtime（OpenClaw）通过 MCP 调用 Nexus 工具，不直接访问数据库
- Feishu 消息路由到 OpenClaw，Nexus 只处理卡片按钮回调
- 每个站场是独立工作区，通过 ABAC 权限控制

当前任务：[任务编号和描述]
相关文档：[具体文档路径]

请先阅读 SKILL.md 和相关文档，然后开始工作。
```

### 6.3 各模块开发的文档配置

#### Track A：Nexus 基础设施

```
Task A1 (数据库Schema)：
  必读：DEVELOPMENT-CONTRACT.md §2, MODULE-DESIGN-PLATFORM.md §3-5
  工具：uvicorn + alembic + psql

Task A2 (OPC-UA Bridge)：
  必读：MODULE-DESIGN-PLATFORM.md §1-2, ARCHITECTURE-UPGRADE-V2.md §Kafka
  工具：asyncua, aiokafka

Task A3 (Kafka + Pulse Engine)：
  必读：MODULE-DESIGN-PLATFORM.md §6-7, DESIGN-COMPLETION.md §五
  工具：aiokafka, asyncio
```

#### Track B：Nexus 业务逻辑

```
Task B1 (设备 API + 本体)：
  必读：MODULE-DESIGN-PLATFORM.md §8-10, DESIGN-COMPLETION.md §六

Task B2 (告警 + 工单)：
  必读：MODULE-DESIGN-PLATFORM.md §11-14, NEXUS-BUSINESS-LOGIC.md

Task B3 (知识库 KB)：
  必读：MODULE-DESIGN-PLATFORM.md §16-18, KB-SEED-CONTENT.md

Task B4 (AI Job Queue)：
  必读：MODULE-DESIGN-PLATFORM.md §19-20, DESIGN-COMPLETION.md §五

Task B5 (MCP Server)：
  必读：ARCHITECTURE-PROTOCOL-ANALYSIS.md §5, PARALLEL-DEV-TASKSPEC.md Task C2
```

#### Track C：AI 集成

```
Task C1 (Sage Skills SKILL.md)：
  必读：ADR-8-AGENT-INTEGRATION.md, ARCHITECTURE-FINAL-REVIEW.md §3
  工具：OpenClaw CLI 加载测试

Task C2 (Feishu 推送)：
  必读：ARCHITECTURE-FINAL-REVIEW.md §4 (Feishu 两路流), MODULE-DESIGN-PLATFORM.md §Feishu

Task C3 (AgentConnector)：
  必读：ARCHITECTURE-PROTOCOL-ANALYSIS.md §4, ADR-8-AGENT-INTEGRATION.md §二
```

#### Track UI：Studio 前端

```
Task UI1 (基础框架 + Auth)：
  必读：STUDIO-UI-ARCHITECTURE.md §一-三, DEV-QUICKSTART.md §Studio

Task UI2 (Mission Control 主页)：
  必读：STUDIO-UI-ARCHITECTURE.md §四, ECOSYSTEM-AND-EXPERIENCE-VISION.md §UI

Task UI3 (3D TwinSurface)：
  必读：MODULE-DESIGN-STUDIO.md §3D, STUDIO-UI-ARCHITECTURE.md §TwinSurface
  工具：Babylon.js 8 文档

Task UI4 (工单面板)：
  必读：MODULE-DESIGN-STUDIO.md §WorkOrder, DEVELOPMENT-CONTRACT.md §WorkOrder API

Task UI5 (告警面板)：
  必读：MODULE-DESIGN-STUDIO.md §Alarm, MODULE-DESIGN-PLATFORM.md §告警

Task UI6 (知识库界面)：
  必读：MODULE-DESIGN-STUDIO.md §KB, NEXUS-HEADLESS-INTEGRATION.md §Context API
```

### 6.4 并行任务推荐组合（3-4 个同时进行）

**Week 1（启动阶段）**：

```
Task A1（DB Schema）+ Task UI1（Studio 框架）+ Task A2（OPC-UA Bridge）
→ 建立基础设施骨架和 UI 脚手架
```

**Week 2-3（核心功能）**：

```
Task B1（设备 API）+ Task UI2（Mission Control）+ Task B3（KB）
→ 数据层和 UI 主页同步推进
```

**Week 4（集成）**：

```
Task B5（MCP Server）+ Task C1（Sage Skills）+ Task UI3（3D）
→ AI 能力接入 + 3D 场景
```

### 6.5 Cursor 多任务操作流程

```
1. 顶部菜单 → New Chat（创建新 Task）
2. 粘贴 §6.2 的标准 Context Prompt
3. 填入具体任务编号和相关文档路径
4. 用 @mention 引用文档（例如 @MODULE-DESIGN-PLATFORM.md）
5. 开始描述具体任务

切换 Task 时：
  → Cursor 左侧边栏可以看到所有 Chat
  → 每个 Chat 保持独立上下文
  → 已完成的功能在验证后关闭 Chat，防止上下文污染
```

### 6.6 验证节点（Dev Loop）

**每完成一个 Task，按此顺序验证：**

```bash
# 1. 格式检查（快速）
pnpm exec oxfmt --check --threads=1 <修改的文件>

# 2. 类型检查（中等）
pnpm check:changed --staged

# 3. 单元测试（针对性）
pnpm test <具体文件路径>

# 4. 集成冒烟（功能就绪时）
# Nexus: curl http://localhost:8000/v1/equipment?station_id=1
# Studio: 浏览器访问 http://localhost:5173
# MCP: mcp-inspector http://localhost:8000/mcp

# 5. 跨 Task 集成（里程碑节点）
# 在 Testbox 运行完整测试套件
blacksmith testbox run --id <ID> "pnpm test"
```

### 6.7 SKILL.md 使用方法

ClawTwin 项目 Skill 文件位于：
`contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md`

在 Cursor 中使用：

```
方式 1：在 Chat 开头 @contrib/industrial-oilgas-skills/clawtwin-project/SKILL.md
方式 2：在 .cursor/rules/ 中配置自动加载（推荐）
方式 3：手动复制 SKILL.md 的文档索引粘贴到 Task 开头
```

**SKILL.md 文档索引结构（关键部分）：**

```
产品战略:     PRODUCT-VISION-V3.md → COMMERCIAL-ARCHITECTURE.md
系统架构:     ARCHITECTURE-PROTOCOL-ANALYSIS.md (必读)
             → ARCHITECTURE-FINAL-REVIEW.md
             → NEXUS-FRAMEWORK-ARCHITECTURE.md
开发规范:     DEVELOPMENT-CONTRACT.md → PARALLEL-DEV-TASKSPEC.md
平台模块:     MODULE-DESIGN-PLATFORM.md (1200行, 分节引用)
界面模块:     MODULE-DESIGN-STUDIO.md → STUDIO-UI-ARCHITECTURE.md
集成决策:     ADR-8-AGENT-INTEGRATION.md
设计补全:     DESIGN-COMPLETION.md (MSW/Feishu/SQL/AdminAPI)
快速启动:     DEV-QUICKSTART.md
```

---

## 七、里程碑确认（最终版）

### Phase A（MVP，12周）

| 里程碑           | 周次   | 核心交付                            | 验收标准                                       |
| ---------------- | ------ | ----------------------------------- | ---------------------------------------------- |
| M1 基础设施就绪  | W1-2   | DB Schema + Kafka + OPC-UA Bridge   | `alembic upgrade head` 成功；OT 数据流入 Kafka |
| M2 核心 API 可用 | W3-5   | 设备/告警/工单 API + ABAC           | Postman 全部接口 200；多用户权限隔离验证       |
| M3 Studio 可演示 | W4-6   | Mission Control + 告警面板          | 浏览器可登录；实时告警更新；工单创建           |
| M4 AI 初步集成   | W6-8   | MCP Server + Sage Skills + OpenClaw | Feishu 消息可触发设备诊断；结果卡片回显        |
| M5 3D 场景       | W7-9   | TwinSurface + P&ID 基础             | 3D 模型可交互；设备状态实时着色                |
| M6 知识库就绪    | W8-10  | KB 导入 + 向量搜索                  | L0 标准文档可检索；AI 可引用知识库回答         |
| M7 Phase A 完整  | W11-12 | 集成测试 + 安全审计 + 文档          | 端到端演示完整；doctor 健康检查通过            |

### Phase B（深度功能，12周）

| 里程碑                | 核心交付                            |
| --------------------- | ----------------------------------- |
| B1 Kafka 统一事件总线 | 替换 in-process 事件；Grafana 监控  |
| B2 时序分析增强       | MOIRAI 预测集成；连续聚合视图       |
| B3 Studio 对话面板    | 内嵌 AI 对话；追问能力              |
| B4 OA 集成            | 飞书审批工作流；Context API for ERP |
| B5 知识飞轮           | L2 案例积累；L3 跨客户学习（脱敏）  |

### Phase C（商业化，持续）

| 里程碑         | 核心交付                       |
| -------------- | ------------------------------ |
| C1 SaaS 多租户 | RLS；多公司隔离                |
| C2 Marketplace | Sage Skills 市场；第三方技能包 |
| C3 移动端      | ClawTwin Mobile（飞书小程序）  |

---

## 八、快速参考：文档与功能对应表

| 需要了解什么                    | 读哪个文档                                                |
| ------------------------------- | --------------------------------------------------------- |
| 整体系统架构、协议选型          | `ARCHITECTURE-PROTOCOL-ANALYSIS.md`                       |
| Feishu 集成正确流程             | `ARCHITECTURE-FINAL-REVIEW.md` §4                         |
| OpenClaw vs Hermes vs Dify 选择 | `ADR-8-AGENT-INTEGRATION.md`                              |
| Nexus 所有 API 端点             | `MODULE-DESIGN-PLATFORM.md`                               |
| Studio 组件和路由               | `MODULE-DESIGN-STUDIO.md` + `STUDIO-UI-ARCHITECTURE.md`   |
| 数据库 Schema + ORM             | `MODULE-DESIGN-PLATFORM.md` §ORM + `DESIGN-COMPLETION.md` |
| Kafka 消息格式                  | `DESIGN-COMPLETION.md` §七                                |
| MSW Mock 配置                   | `DESIGN-COMPLETION.md` §一                                |
| Feishu 卡片 JSON                | `DESIGN-COMPLETION.md` §二                                |
| 并行开发任务分配                | `PARALLEL-DEV-TASKSPEC.md`                                |
| 本地开发环境搭建                | `DEV-QUICKSTART.md`                                       |
| 知识库初始内容                  | `KB-SEED-CONTENT.md`                                      |
| 商业模式 / 许可证               | `COMMERCIAL-ARCHITECTURE.md`                              |
| 开源 vs 闭源策略                | `COMMERCIAL-ARCHITECTURE.md` §BUSL-1.1                    |

---

_本文档是 ClawTwin 项目架构综述的最终权威版本。_  
_如有架构疑问，优先查阅本文档，然后追溯具体模块文档。_
