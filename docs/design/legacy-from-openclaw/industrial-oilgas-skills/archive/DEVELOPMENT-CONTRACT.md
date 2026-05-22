# ClawTwin 开发契约

> **每一位加入开发的工程师都必须先读本文件，再读具体模块文档。**  
> 本文件是精华索引，不是完整设计——引用到的文档才是权威实现。  
> **版本**：1.2 · 2026-05-12

> **文档入口（新成员对齐 cwd）**：总索引 **`DESIGN-FINAL-MASTER-INDEX.md`** → 本地多仓库与命令目录 **`DEV-QUICKSTART.md` §〇** → **`clawtwin-platform/platform-api/README.md`**（启动与 `CLAWTWIN_*`）→ **`TESTING-GUIDE.md` §二.0**（**pytest/Alembic 仅在 `platform-api/` 目录执行**）→ 回到本文件与任务文档。

> **★ 范式声明（最高优先）**：ClawTwin = Industrial Foundry（不是 Agent 系统）。
> 一等公民：Object Type / Link Type / Action Type / Function Type / Pipeline / Marking。
> Agent / MCP / CLI / HTTP 都是 Ontology 之上的视图层。
> 见 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（最高架构权威）。
> **业务编排与控制面**（Playbook·Trigger·Policy·InvocationContext；智能体 = 能力平面）：`PLATFORM-BUSINESS-CONTROL-PLANE.md`。

---

## 一、产品是什么（30 秒版本）

**ClawTwin** = 油气管输站场的 **Industrial Foundry**（Palantir Foundry 风格的工业本体平台）。  
**三层价值**：

- ① **Ontology Layer**：Object（设备/告警/工单等）+ Action（写操作）+ Function（AI 推理）+ Pipeline（数据接入）
- ② **AIP Layer**：OpenClaw + MCP，让 LLM 通过 Ontology 操作所有业务
- ③ **Apps Layer**：Studio（Workshop 风格）+ 飞书 Bot + 移动端

**不是什么**：不是 SCADA 替代品，不是工艺控制系统，不是 Agent 应用，不是通用工业平台。  
**核心差异**：本体驱动 + 行业知识 + AI 增强 = 可演进、可治理、可审计的工业智能基座。

---

## 二、系统由哪些部分组成

```
用户入口
├── ClawTwin Studio    浏览器桌面 Web App（Palantir Foundry 范式）
├── ClawTwin Mobile    飞书客户端内承载（机器人 + 消息/审批卡片；**非**独立原生 App）
└── ClawTwin Command   大屏全景视图（Platform C 期）

核心服务（我们自研）
└── Platform           FastAPI 后端，数据接入+AI调度+工单管理+安全控制

外部服务（独立部署，不在 Platform 代码里）
Phase A 核心（4个服务，见 ARCHITECTURE-SIMPLIFICATION-AUDIT.md §三）：
├── OpenClaw           开源 AI 网关，加载 3 个 Sage Skills
├── vLLM               大模型推理（Qwen3 + bge-m3 embed）
├── PostgreSQL         主库（TimescaleDB时序 + pgvector向量，替代Milvus）
└── Redis              缓存 + 设备影子状态（替代Eclipse Ditto）

Phase B 新增（真实 OT 接入）：
├── opcua-bridge       OT 数据采集（DMZ 隔离区，推 Redis Streams）
└── MinIO              文件存储（工单证据照片）

Phase C 新增（多站场规模）：
├── Apache Kafka       高吞吐消息总线（100站场+）
├── Milvus             十亿级向量库（pgvector超出容量时）
└── Eclipse Ditto      数字孪生标准（多租户 W3C WoT 需要时）
```

---

## 三、绝对不能做的事（违反即返工）

### 安全红线

| ❌ 错误                        | ✅ 正确                                   | 文档位置         |
| :----------------------------- | :---------------------------------------- | :--------------- |
| `station_id = body.station_id` | `station_id` 从 JWT 或设备推导 + 校验权限 | SKILL §1 铁律 2  |
| 飞书 Webhook 不验签            | `verify_feishu_signature()` 必须运行      | SKILL §1 铁律 4  |
| 工单审批只验角色               | 角色 AND 场站权限双重验证                 | SKILL §1 铁律 5  |
| 关键操作不写审计日志           | `audit_log()` 写所有关键操作              | SKILL §1 铁律 6  |
| AI 直接发控制指令给 DCS        | AI 只起草建议，人去现场执行               | SKILL §1 铁律 12 |

### 架构红线

| ❌ 错误                                             | ✅ 正确                                                                            | 文档位置                                        |
| :-------------------------------------------------- | :--------------------------------------------------------------------------------- | :---------------------------------------------- |
| Platform 里包含 OpenClaw 代码                       | Platform 是独立服务，通过 HTTP 调用                                                | SKILL §1 铁律 1                                 |
| 每人一个 OpenClaw 实例                              | 组织粒度，Session 级会话隔离                                                       | SKILL §1 铁律 13                                |
| OPC-UA 和 IMS 同一链路                              | 两条独立链路，equipment_id 上关联                                                  | SKILL §1 铁律 11                                |
| opcua-bridge 接 PostgreSQL                          | opcua-bridge 只推 Kafka                                                            | SKILL §1 铁律 8                                 |
| HiAgent 直连数据库                                  | HiAgent 只调 Platform Tool API                                                     | SKILL §1 铁律 14                                |
| 引入 Neo4j / LangGraph / K8s                        | 已锁定技术栈，见禁止列表                                                           | SKILL §1 铁律 10                                |
| 自建 chunker / 向量写入逻辑                         | 使用 `llama-index-core` + `llama-index-vector-stores-postgres`                     | ARCHITECTURE-FINAL-CRITICAL-AUDIT §二           |
| HTTP router / MCP tool / CLI 各自写业务             | 单一 @tool 装饰函数，三处入口自动暴露                                              | ARCHITECTURE-PRUNING-2026 §三                   |
| 写 Action 抽象类 / Generic / SafetyContract 类      | 装饰器 + 函数 + Pydantic（OpenClaw 风格）                                          | ARCHITECTURE-PRUNING-2026 §一/§二               |
| 分 ports/adapters/interfaces 7 层目录               | 5 层：core/channels/providers/infra/workers                                        | ARCHITECTURE-PRUNING-2026 §3.1                  |
| 跳过 invoke() 直接调 handler                        | 必须经 invoke()（权限/限流/审批/trace 全部强制）                                   | ARCHITECTURE-PRUNING-2026 §3.2                  |
| 业务代码自行写 audit_log                            | invoke() 框架内自动写，业务只关心 handler                                          | ARCHITECTURE-PRUNING-2026 §3.2                  |
| LLM 调用不写 trace                                  | 所有 LLM 调用 + tool 执行必写 llm_traces 表                                        | CORE-ARCHITECTURE-AUDIT-2026 §四                |
| 工单审批硬编码在 hitl/workorder_fsm                 | 走统一 ApprovalQueue（任何 tool 可声明 requires_approval=True）                    | CORE-ARCHITECTURE-AUDIT-2026 §五                |
| Studio/Feishu/MCP/CLI 各自实现入口                  | 统一 Channel 抽象（HTTPChannel/FeishuChannel/MCPChannel/CLIChannel）               | ARCHITECTURE-PRUNING-2026 §四.1                 |
| LLM 调用硬编码 vLLM                                 | 通过 LLMProvider 抽象，可切换通义/文心/Claude                                      | ARCHITECTURE-PRUNING-2026 §四.2                 |
| 直接在 SQLAlchemy 加业务实体                        | 必须先有 Object Type YAML 声明（ontology/object_types/）                           | INDUSTRIAL-FOUNDRY-ARCHITECTURE §四.1 + 铁律 25 |
| 业务代码 session.commit() 改对象                    | 必须经 ActionExecutor.execute()（带声明式 validators/effects/audit/trace/lineage） | INDUSTRIAL-FOUNDRY §四.2 + 铁律 26              |
| 业务代码直接调 LLM                                  | 必须封装为 Function Type（ai_function 委派 OpenClaw）                              | INDUSTRIAL-FOUNDRY §四.3 + 铁律 27              |
| worker 写 ad-hoc 数据导入脚本                       | 必须为 Pipeline YAML（声明 source/transformations/destination/lineage）            | INDUSTRIAL-FOUNDRY §七 + 铁律 28                |
| 每个 Object 手写 React 详情页                       | Studio 优先用 Ontology 自动生成 UI（70%）；自定义页面也调 Ontology API             | INDUSTRIAL-FOUNDRY §五 + 铁律 29                |
| 把 ClawTwin 设计成 Agent 系统                       | ClawTwin 是 Industrial Foundry：Object/Action/Function/Pipeline 是一等公民         | INDUSTRIAL-FOUNDRY §一/§十五                    |
| 在 Foundry 里 if openclaw / if hiagent              | AgentRuntime 抽象，MCP+OpenAPI 双协议暴露同一 Ontology                             | USER-ENVIRONMENT §三 + 铁律 30                  |
| 为客户 IMS 写一次性脚本                             | 沉淀为 Connector 包（connectors/{erp,cmms,...}/<vendor>/）                         | USER-ENVIRONMENT §四 + 铁律 31                  |
| Object Type 不声明 SoT                              | 必填 source_of_truth_strategy.default = foundry/external/hybrid                    | INDUSTRIAL-FOUNDRY §四.1.5 + 铁律 32            |
| Foundry 处理飞书对话消息                            | 飞书消息直进 AgentRuntime；Foundry 只处理卡片回调和主动推送                        | USER-ENVIRONMENT §五 + 铁律 33                  |
| 为 ClawTwin 开发独立 Mobile App                     | 使用飞书小程序+卡片，不开发独立 App                                                | USER-ENVIRONMENT §五 + 铁律 33                  |
| 默认部署形态是 SaaS                                 | 默认私有化（OT/IMS 数据不出客户域）；SaaS 仅 PoC 或低敏感                          | USER-ENVIRONMENT §六 + 铁律 34                  |
| 跳过 buy/borrow/build 三问                          | 任何技术组件都先问"成熟方案有没有"，没有才自己写                                   | TECH-STACK §一 + 铁律 35                        |
| 自创 Object Type schema YAML 语法                   | 用 LinkML（工业本体标准建模语言），ClawTwin 仅做 annotations 扩展                  | TECH-STACK §2.1 + 铁律 36                       |
| 自写 SAP / Oracle / 用友 等 ERP Connector           | 用 Airbyte 现有 350+ Connector + Foundry mapping 适配层                            | TECH-STACK §2.2 + 铁律 37                       |
| 自写 React Admin Panel 框架                         | Studio 70% 自动生成用 Refine（refine.dev）；30% 自定义才写普通 React               | TECH-STACK §2.3 + 铁律 38                       |
| 从零写工业基础知识（"压缩机基础"等通用内容）        | 接 OSDU/ISO 14224/ISO 15926/ISA-18.2/国标全文公开系统/OPC-UA Companion Specs       | TECH-STACK §2.7 + 铁律 39                       |
| **Platform 任何地方调 vLLM chat**                   | **Platform 只调 bge-m3（embed）+ MOIRAI（后台）**                                  | **§26 + §27**                                   |
| **Platform settings 有 vllm_base_url**              | **删除推理配置；只保留 vllm_embed_url**                                            | **§27.8**                                       |
| **diagnose/analyze_pid/visual_inspect 在 Platform** | **这三个业务全在 OpenClaw Skill**                                                  | **§27.2**                                       |
| **Studio 直接调 `/v1/tools/*`**                     | **Tool API 是 Service Token only；Studio 用 `/v1/ai/jobs`**                        | **§27.3**                                       |
| **compute_primary_action 调 AI**                    | **纯规则计算（阈值树 + MOIRAI 评分），无 LLM**                                     | **§27.6**                                       |
| **P&ID 分析在 Platform**                            | **P&ID 数据在 Platform；分析在 Skill（Feishu 触发）**                              | **§27.4**                                       |

### UI 红线

| ❌ 错误                  | ✅ 正确                                    | 文档位置         |
| :----------------------- | :----------------------------------------- | :--------------- |
| 前端判断显示什么行动按钮 | Platform 计算 `primary_action`，前端只渲染 | SKILL §11 铁律 2 |
| P1 告警用 toast 提示     | 全屏 InvestigationBanner + 调查模式        | SKILL §11 铁律 3 |
| 点击「建工单」跳页面     | WorkOrderDraftInline 内嵌切换 Tab          | SKILL §11 铁律 8 |
| 空状态显示"请选择设备"   | 无选中时显示 AlarmQueuePanel               | SKILL §11 铁律 6 |
| 颜色硬编码乱写           | 从 `tokens.ts` 的 COLORS/CX 取             | SKILL §11 铁律 5 |
| 做 Studio 移动端适配     | < 1024px 显示 MobileGuard，引导飞书        | SKILL §11 铁律 9 |

---

## 四、开发前必须建立的环境变量

```bash
# .env（从 .env.example 复制，不要提交真实值）

# 数据库
DATABASE_URL=postgresql+asyncpg://clawtwin:password@localhost:5432/clawtwin
REDIS_URL=redis://localhost:6379

# 安全
JWT_SECRET_KEY=<随机 32 字节，openssl rand -hex 32>
JWT_EXPIRE_MINUTES=480

# 飞书（私有化部署地址）
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFY_TOKEN=xxx   # 测试环境可留空，生产必填
FEISHU_SERVER_URL=https://your-feishu.company.com

# OpenClaw
OPENCLAW_BASE_URL=http://localhost:4000
OPENCLAW_SERVICE_TOKEN=<从 /v1/admin/service-tokens 生成>

# vLLM
VLLM_BASE_URL=http://gpu-server:8000/v1
VLLM_MODEL_STANDARD=Qwen/Qwen3-35B-A3B-GPTQ-Int4
VLLM_MODEL_THINKING=Qwen/Qwen3-35B-A3B-Thinking-GPTQ-Int4
VLLM_MODEL_VISION=Qwen/Qwen2.5-VL-7B-Instruct

# Milvus（Phase C，Phase A/B 用 pgvector，以下留空）
# MILVUS_HOST=localhost
# MILVUS_PORT=19530

# Mock 模式（Phase A 无真实 OPC-UA 数据时）
MOCK_MODE=true

# 功能开关
VITE_ENABLE_VISUAL_INSPECTION=false   # Studio 前端
```

---

## 五、数据库初始化顺序

> **Phase A 精简栈**（4 个服务，约 6GB RAM，MacBook M1/M2 可运行）  
> Kafka/Milvus/Eclipse Ditto/Apache AGE 已移至 Phase B/C，Phase A 不启动。  
> 详见：`ARCHITECTURE-SIMPLIFICATION-AUDIT.md §三`

```bash
# 1. 启动 Phase A 核心服务（4个，精简版）
docker compose up -d postgres redis vllm openclaw

# 其中 postgres 镜像已包含：TimescaleDB + pgvector（替代 Milvus）
# Redis 承担设备影子状态存储（替代 Eclipse Ditto）
# Kafka/Milvus/Ditto 不在 Phase A 启动

# 2. 初始化 PostgreSQL 扩展（TimescaleDB + pgvector，移除 AGE）
psql -U clawtwin -d clawtwin -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
psql -U clawtwin -d clawtwin -c "CREATE EXTENSION IF NOT EXISTS vector;"
# ❌ 不再执行：CREATE EXTENSION IF NOT EXISTS age;（AGE 已移除，风险 > 收益）

# 3. 运行 Alembic 迁移
cd platform-api
alembic upgrade head

# 4. 导入冷启动知识（必须，否则 AI 无法回答问题）
python scripts/seed_knowledge.py --l0-dir data/kb/l0/ --l1-dir data/kb/l1/

# 5. 创建初始管理员账号
python scripts/create_admin.py --username admin --password <密码> --station S001

# 6. Phase A 完整服务验证
clawtwin doctor  # 检查所有 4 个服务连通性
```

**Phase B 新增**（真实 OT 数据接入时）：

```bash
docker compose up -d opcua-bridge minio
# Redis Streams 替代 Kafka（30设备/1Hz，Redis 足够）
```

**Phase C 新增**（多站场高吞吐时）：

```bash
docker compose up -d kafka milvus eclipse-ditto
```

---

## 六、核心业务流速查

### 设备状态更新流

```
[Phase A Mock]  Platform Scheduler 每 5s 写 mock 数据 → TimescaleDB
[Phase B 真实]  SCADA → OPC-UA → opcua-bridge → Kafka → TimescaleDB

Studio 端：useEquipmentIntel Hook → GET /v1/equipment/{id}/realtime（轮询 10s）
```

### AI 诊断流（Studio 触发异步任务）

```
用户在 Studio 点击「AI 诊断」
  ↓
Studio: POST /v1/ai/jobs { job_type:"diagnose", equipment_id:X }
  ↓
Nexus: 创建 ai_jobs 记录(status=pending) → 返回 { job_id }
       同时预加载 decision_package（GET /v1/equipment/{id}/decision-package）
  ↓
Studio: 打开 SSE GET /v1/sse/ai-jobs/{job_id} 监听进度
  ↓
Nexus AI Job Worker:
  1. build_equipment_context(equipment_id) [24h趋势 + 5条工单 + KB检索]
  2. DataQualityChecker 预检（质量差时返回 quality_issues，提前终止）
  3. 通过 AgentConnector 触发 OpenClaw 会话
  ↓
OpenClaw（加载 Sage industrial-twin Skill）:
  1. 通过 MCP 调用 Nexus get_equipment_context()
  2. Qwen3 Thinking 生成诊断
  3. 回调 POST /v1/ai/jobs/{id}/result { summary, confidence, citations, recommended_action }
  ↓
Nexus: 更新 ai_jobs 状态=completed，SSE 推送 { type:"completed", result:{...} }
  ↓
Studio: DeviceIntelPanel 渲染 AIInsightCard + One Big Action

⚠️  Platform 内部永远不直接调 vLLM 做 LLM 推理（铁律 §三 架构红线）
⚠️  Studio 永远不直接调 /v1/tools/*（Tool API 是 ServiceToken only）
```

### 工单 HITL 流

```
操作员点击 One Big Action → WorkOrderDraftInline 展开
  ↓
AI 预填草稿（POST /v1/workorders/ai-draft）
  ↓
操作员确认/修改 → POST /v1/workorders/（state 由服务端设为 draft）
  ↓
FSM draft → pending_approval（POST /v1/hitl/workorders/{id}/pending）
  ↓
飞书卡片推送给主管（FeishuClient.send_approval_card）
  ↓
主管点击 [批准] → POST /v1/hitl/workorders/{id}/approve
  ↓
FSM pending_approval → approved → in_progress
  ↓
执行完成后 → POST /v1/hitl/workorders/{id}/done（上传证据）
  ↓
FSM IN_PROGRESS → DONE
  ↓
L3 知识自动沉淀（write_l3_knowledge 写 kb_documents + pgvector，通过 LlamaIndex 摄入）
```

### 飞书消息流（两大类，共三路）

```
【类型一：用户发消息给机器人】
  飞书 App → 飞书服务器 → 飞书 Webhook（OpenClaw 配置）
           ↓
         OpenClaw Feishu Channel Plugin（im.message.receive_v1）
           ↓
         OpenClaw Agent Loop（加载 Sage Skills）
           ↓ MCP 工具调用
         Nexus Platform API（/v1/equipment、/v1/kb/search 等）
           ↓
         OpenClaw 生成回复 → 飞书发送 → 用户

  ⚠️  飞书对话消息【永远不经过 Nexus】
  ⚠️  Nexus 的 /v1/feishu/events 不处理 im.message.receive_v1

【类型二：系统主动推送通知】
  通道 B（告警推送）：
    Nexus Pulse Engine → FeishuClient.send_alert() → 飞书服务器 → 用户手机

  通道 C（工单审批卡片）：
    Nexus → FeishuClient.send_approval_card() → 主管手机
    主管点击 [批准/驳回] → 飞书服务器 → Webhook POST /v1/feishu/events
    → Nexus（仅处理 card.action.trigger）→ POST /v1/hitl/workorders/{id}/approve
    （必须 verify_feishu_signature）
```

---

## 七、关键 API 端点一览

> **权威路径来源**：`DESIGN-FINAL-LOCK.md §一`（最终裁定，冲突时以此为准）。  
> 下表为常用子集 + 调用方说明。完整 Request/Response 格式见 `NEXUS-API-REFERENCE.md`。

```
调用方说明：
  [Studio]  → JWT Bearer Token，用户身份
  [Agent]   → Service Token（Bearer），AI Runtime（OpenClaw/Hermes）
  [OA]      → OA Service Token，审批系统

# 认证
POST /v1/auth/login                        [Studio] 邮箱+密码 → JWT + refresh_token
POST /v1/auth/refresh                      [Studio] 刷新 JWT
GET  /v1/auth/me                           [Studio] 当前用户信息（含 station_ids）

# 设备
GET  /v1/equipment                         [Studio] 设备列表（?station_id=&status=&page=）
GET  /v1/equipment/{id}                    [Studio] 设备详情（含最新读数快照）
GET  /v1/equipment/{id}/readings           [Studio] 历史时序数据（?metric=&from=&to=）
GET  /v1/equipment/{id}/decision-package   [Studio/Agent] 决策包（Redis 缓存，<10ms）

# 告警
GET  /v1/alarms                            [Studio] 告警列表（?station_id=&priority=&status=）
POST /v1/alarms/{id}/acknowledge           [Studio] 确认告警
POST /v1/alarms/{id}/resolve               [Studio] 关闭告警

# 工单
GET  /v1/workorders                        [Studio] 工单列表（?station_id=&state=）
POST /v1/workorders/ai-draft               [Studio] AI 预填草稿（不创建工单）
POST /v1/workorders/                       [Studio] 创建工单（state 服务端强制="draft"）
PATCH /v1/workorders/{id}                  [Studio] 编辑工单（仅 draft 状态）
POST /v1/hitl/workorders/{id}/pending      [Studio] 提交审批 → pending_approval
POST /v1/hitl/workorders/{id}/approve      [Studio/OA] 审批通过 → approved
POST /v1/hitl/workorders/{id}/reject       [Studio/OA] 驳回 → draft
POST /v1/hitl/workorders/{id}/start        [Studio] 开始执行 → in_progress
POST /v1/hitl/workorders/{id}/done         [Studio] 完成（含证据上传）→ done
POST /v1/hitl/workorders/{id}/oa-callback  [OA] OA 系统审批回调

# AI 任务（Studio 用，异步）
POST /v1/ai/jobs                           [Studio] 提交 AI 任务（返回 job_id）
GET  /v1/ai/jobs/{job_id}                  [Studio] 查询任务状态和结果
GET  /v1/sse/ai-jobs/{job_id}             [Studio] SSE 实时任务进度流
POST /v1/ai/jobs/{job_id}/result          [Agent] AI Agent 回写结果（ServiceToken）

# 实时推送
GET  /v1/sse/station/{station_id}         [Studio] 场站综合 SSE 流（设备读数+告警）

# 知识库
GET  /v1/kb/documents                      [Studio] 文档列表
POST /v1/kb/documents                      [Studio/Admin] 上传文档
GET  /v1/kb/search?q=&layer=              [Studio/Agent] 语义搜索（返回 citations）

# MCP（AI Agent 专用）
GET/POST /mcp                              [Agent] MCP Server（ServiceToken 认证）

# Context API（OA/ERP 集成）
GET  /v1/ctx/equipment/{id}               [OA] 设备上下文快照
GET  /v1/ctx/workorder/{id}              [OA] 工单上下文快照

# 飞书
POST /v1/feishu/events                    [Feishu] 仅处理 card.action.trigger（卡片按钮）

# Admin（sys_admin only）
GET  /v1/admin/users                       [Admin] 用户列表
POST /v1/admin/users                       [Admin] 创建用户
GET  /v1/admin/health/detail               [Admin] 系统健康详情
GET  /v1/admin/audit-logs                  [Admin] 审计日志

# 管理
POST /v1/admin/service-tokens              创建服务 Token
GET  /v1/admin/data-quality                数据质量 Dashboard
POST /v1/admin/users/{id}/bind-invite      飞书绑定邀请

# 飞书 Webhook
POST /v1/feishu/events                     飞书 Bot 事件
POST /v1/hitl/workorders/{id}/oa-callback  OA/BPM 回调
```

**工单状态枚举（前后端统一）**：

```
draft → pending_approval → approved → in_progress → done
                        ↘ draft（reject 退回）

⚠️ 禁止使用的变体：DRAFT / ai_draft / pending / APPROVED / submitted
```

---

## 八、最常犯错的实现细节

### 后端（Python/FastAPI）

```python
# ✅ 正确：异步 session（不是同步）
from db.session import get_db
async def get_equipment(db: AsyncSession = Depends(get_db)):

# ✅ 正确：权限验证（两步缺一不可）
user = Depends(get_current_user)
require_station(equipment.station_id, user)  # 在 get_equipment_or_404 内部

# ✅ 正确：工单状态服务端强制
workorder.state = WorkOrderState.DRAFT     # 不接受 body.state；字段名为 state 非 status

# ✅ 正确：vLLM 调用（OpenAI-compatible）
from services.vllm import VLLMClient
response = await VLLMClient.chat(messages, model="standard")  # 不要直接 httpx

# ✅ 正确：LlamaIndex MetadataFilter 语法（pgvector，不是 Milvus 过滤器）
# 使用 llama_index.core.vector_stores.MetadataFilter，不是 Milvus 的 filter_expr 字符串
from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
filters = MetadataFilters(filters=[
    MetadataFilter(key="layer", value="L1"),
    MetadataFilter(key="station_id", value=station_id),
])
```

### 前端（TypeScript/React）

```typescript
// ✅ 正确：从 store 取 station_id，不从 URL 取
const { selectedStationId } = useTwinStore();

// ✅ 正确：数据获取在 Hook 里，不在组件里
const { aiInsight, primaryAction } = useEquipmentIntel(equipmentId);

// ✅ 正确：内嵌工单，不跳页面
const [tab, setTab] = useState<"intel" | "draft_wo">("intel");
// 点击建工单 → setTab("draft_wo")，不 navigate("/workorders/new")

// ✅ 正确：颜色从 tokens 取
import { COLORS } from "@/styles/tokens";
// className={`text-[${COLORS.semantic.alarm}]`}  或直接 "text-[#EF4444]"

// ✅ 正确：请求取消（切换设备时）
const abortRef = useRef<AbortController>(null);
useEffect(() => {
  abortRef.current?.abort();
  abortRef.current = new AbortController();
  // ... fetch with signal: abortRef.current.signal
}, [equipmentId]);
```

---

## 九、Phase A Demo 必须能跑通的场景

开发完成的验收标准是以下 **5 个场景** 全部可以演示给客户：

```
场景 1：设备异常发现
  操作：打开 Studio → 看到 C-001 红色闪烁 → 点击 → 看到倒计时"01:23"+ 橙色大按钮
  验证：IntelPanel 显示 AI 诊断和 Citations，一键可建工单

场景 2：AI 知识问答（飞书）
  操作：飞书 Bot 发送"C-001 振动高是什么原因"
  验证：60 秒内收到飞书卡片，包含诊断摘要 + 知识来源

场景 3：HITL 工单审批
  操作：建工单 → 主管飞书收到审批请求 → 点批准 → Studio 工单 state 变 approved
  验证：L3 知识自动记录工单结论（state 全小写，字段名 state 非 status）

场景 4：全局搜索
  操作：Cmd+K → 输入"C-001" → 点击 → Studio 自动跳到该设备并选中
  验证：搜索响应 < 500ms

场景 5：班次交接
  操作：NavRail 底部点"班次交接" → 填接班人 → 发送
  验证：接班人飞书收到本班摘要卡片（告警处理数、待处理工单、AI 预测）

场景 6：生产数据录入（★ v3.0 新增）
  操作：Studio → 生产数据页 → 录入今日输量 21.36 万方 → 提交
  验证：GET /v1/production/kpi 返回可用率 97.9%，晨报飞书卡片含生产数据

场景 7：逾期巡检提醒（★ v3.0 新增）
  操作：飞书 Bot 问"今天有什么逾期巡检"
  验证：industrial-inspection Skill 调用 /v1/inspection/overdue 返回逾期列表
```

---

## 十、文档更新规约

当你修改了设计：

1. **同步更新** 对应的 Level 1 文档（Platform/Studio/UI-UX）
2. **同步更新** `clawtwin-project/SKILL.md` 的快速参考索引
3. **如果是架构级改动**，写新的 `ADR-N-TOPIC.md`
4. **不允许**只在对话中达成共识、不写进文档

文档的 Commit 信息格式：

```
docs(clawtwin): <描述变更内容> [phase-a|phase-b|phase-c]

例：
docs(clawtwin): add CommandPalette spec to UI-UX-DESIGN §22.5 [phase-a]
docs(clawtwin): update Platform API /v1/shifts/handover [phase-a]
```

---

## 十一、完整设计文档总清单（交付版，2026-05-11 v3.1）

> 按"职能角色"索引，避免团队成员迷失在 69 份文档中。  
> **★ 找不到文档时直接看 `DESIGN-FINAL-MASTER-INDEX.md`（5 分钟找到所有信息）**

### 所有人必读（第一天）

| 优先级 | 文档                                            | 位置   | 作用                                                    |
| :----- | :---------------------------------------------- | :----- | :------------------------------------------------------ |
| ★★★    | `DESIGN-FINAL-MASTER-INDEX.md`                  | 同目录 | **总入口**：69 份文档导航 + 44 条铁律映射 + 17 周路线图 |
| ★★★    | `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`            | 同目录 | **架构层最高权威**（Foundry / Ontology / 7 层）         |
| ★★★    | `USER-ENVIRONMENT-DELIVERY-VALIDATION.md`       | 同目录 | **交付层最高权威**（飞书 + Agent + IMS）                |
| ★★★    | `TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md` | 同目录 | **选型层最高权威**（buy/borrow/build）                  |
| ★★★    | `DEVELOPMENT-CONTRACT.md`                       | 本文件 | 全局契约 + 架构红线                                     |
| ★★★    | `clawtwin-project/SKILL.md`                     | 同目录 | 44 条铁律 + 检查清单                                    |
| ★★★    | `CURSOR-MULTITASK-GUIDE.md`                     | 同目录 | 18+ 任务定义 + 提示词                                   |
| ★★     | `TEAM-COLLAB-GUIDE.md`                          | 同目录 | 多团队协作规则                                          |
| ★      | `CODE-AUDIT-REPORT.md`                          | 同目录 | 现有代码 M1 阻断项                                      |

### 后端团队

| 优先级 | 文档                        | 关键章节                                                                                     |
| :----- | :-------------------------- | :------------------------------------------------------------------------------------------- |
| ★★★    | `MODULE-DESIGN-PLATFORM.md` | **§十八～§二十五（API 真相表/数据模型/架构模式/SSE/生产级决策/PM审视/胶水代码/架构完整性）** |
| ★★     | `PHASE-A-SCAFFOLD.md`       | §脚手架代码、Alembic 初始化                                                                  |
| ★★     | `PHASE-A-RUNBOOK.md`        | 启动/测试/curl 验证                                                                          |
| ★      | `INTEGRATION-AND-GAPS.md`   | 飞书/OA/IMS 集成细节                                                                         |

### 前端团队

| 优先级 | 文档                                 | 关键章节                                               |
| :----- | :----------------------------------- | :----------------------------------------------------- |
| ★★★    | `MODULE-DESIGN-STUDIO.md`            | §二十七（IntelPanel）、§二十九（NavRail）、§十（Hook） |
| ★★★    | `MODULE-DESIGN-PLATFORM.md §十九.五` | TypeScript WorkOrder 类型定义                          |
| ★★     | `UI-UX-DESIGN.md`                    | §二十二（Palantir 原则）、§二十一（状态机）            |

### AI 集成团队

| 优先级 | 文档                                  | 关键章节                                                                                          |
| :----- | :------------------------------------ | :------------------------------------------------------------------------------------------------ |
| ★★★    | `MODULE-DESIGN-PLATFORM.md`           | §六（OpenClaw集成）、§十七（Tool API）、§二十（架构模式 §20.3-20.6）、§二十一（Gateway/WS/Store） |
| ★★     | Skills：`industrial-twin/SKILL.md` 等 | 各 Skill 的 manifest 和工具声明                                                                   |

### DevOps 团队

| 优先级 | 文档                    | 关键章节                                              |
| :----- | :---------------------- | :---------------------------------------------------- |
| ★★★    | `CLAWTWIN-MASTER-V2.md` | §五（OT/IT分区）、§六（安全架构）、§十（Docker 拓扑） |
| ★★     | `PHASE-A-SCAFFOLD.md`   | docker-compose、nginx.conf、环境变量                  |

### 工业场景与运营文档（★ v3.0 新增）

| 优先级 | 文档                               | 作用                                            |
| :----- | :--------------------------------- | :---------------------------------------------- |
| ★★★    | `INDUSTRIAL-SCENARIOS-COMPLETE.md` | 36个工业场景覆盖度审计 + Phase A缺口 + 枚举终态 |
| ★★★    | `NEXUS-API-REFERENCE.md`           | 完整API参考手册（31个端点，含生产/班次/巡检）   |
| ★★     | `DESIGN-FINAL-LOCK.md §二a`        | 设备状态8种枚举 + 工单类型7种枚举（终态）       |

### Skills 配置文档

| Skill                 | 文件                             | 用途                        |
| :-------------------- | :------------------------------- | :-------------------------- |
| industrial-twin       | `industrial-twin/SKILL.md`       | 设备状态读取、异常分析      |
| industrial-kb         | `industrial-kb/SKILL.md`         | 知识库检索                  |
| industrial-workorder  | `industrial-workorder/SKILL.md`  | 工单创建、状态查询          |
| industrial-analytics  | `industrial-analytics/SKILL.md`  | 趋势分析、KPI               |
| industrial-shift      | `industrial-shift/SKILL.md`      | ★ 班次交接                  |
| industrial-production | `industrial-production/SKILL.md` | ★ 生产数据录入查询          |
| industrial-inspection | `industrial-inspection/SKILL.md` | ★ 巡检管理                  |
| industrial-admin      | `industrial-admin/SKILL.md`      | ★ 系统运维（sys_admin专用） |

### 归档参考（不需要主动阅读，有问题时查阅）

| 文档                                       | 用途                                   |
| :----------------------------------------- | :------------------------------------- |
| `STRATEGIC-PROPOSAL-V1.md`                 | 战略背景，竞品分析                     |
| `PHILOSOPHY-ECONOMICS-REVIEW.md`           | 哲学/经济学视角评审                    |
| `CRITICAL-REVIEW-AND-EVOLUTION.md`         | 技术演进决策记录                       |
| `CRITICAL-REVIEW-WAVE2.md`                 | 用户体验批判性评审                     |
| `ADR-*.md`                                 | 架构决策记录（ADR 2-8）                |
| `FINAL_*.md`、`INDUSTRIAL_BRAIN_MASTER.md` | 早期草稿，概念理解用，数据以新文档为准 |
| `ARCH_DECISION_RECORD.md`                  | 早期ADR，已被ADR-2~8替代               |

> **完整 P0/P1/P2/归档分类详见 `DESIGN-FINAL-MASTER-INDEX.md §三`**

---

## 十二、现有代码与设计的已知偏差（2026-05-09 快速摘要）

> 详情见 `CODE-AUDIT-REPORT.md`。以下是 M1 Week 1 必须修复的阻断项。

```
[A-001] JWT 认证失效：所有路由无鉴权（任何人可访问所有 API）
[A-002] station_id 从用户输入获取：违反铁律 2，存在越权风险
[A-003] 整数主键 ID：与设计的字符串 ID（C-001/W-XXXXXXXX）不兼容
[A-004] WorkOrder 字段错误：status→state，pending→pending_approval
[A-005] 路由缺少 /v1/ 前缀：前端所有 API 调用无法对接
[A-006] 工单路由结构错误：/draft /create 应改为 §18.6 定义的正确路径
[A-009] User 缺少 station_ids：ABAC 权限系统无法工作
```

修复顺序：A-001 → A-003 → A-009 → A-002 → A-004 → A-005 → A-006

---

_本文件由 ClawTwin 项目组维护。最后更新：2026-05-09（增加团队分工文档、架构模式、代码审计结论）。_  
_读完本文件后，请继续阅读：TEAM-COLLAB-GUIDE.md → CODE-AUDIT-REPORT.md → 自己模块的设计文档_
