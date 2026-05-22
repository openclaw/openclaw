# ClawTwin 产品命名、商业定位与完整模块接口清单

**版本**：1.0，2026-05-11  
**性质**：产品定义 + 技术规范双用文档  
**权威性**：命名部分覆盖 PRODUCT-VISION-V3.md §二；模块部分覆盖 MODULE-DESIGN-PLATFORM.md §一

---

## 一、命名体系：为什么这样命名

### 1.1 命名参考系

| 国际产品     | 核心语义层          | 运行层             | 智能层   | 工作台     |
| :----------- | :------------------ | :----------------- | :------- | :--------- |
| Palantir     | Ontology            | Foundry            | AIP      | Workshop   |
| Salesforce   | Objects/Schema      | Platform           | Einstein | Lightning  |
| Microsoft    | Azure Digital Twins | Fabric             | Copilot  | Power Apps |
| Honeywell    | —                   | **Forge**          | —        | HMI        |
| GE Digital   | —                   | **Predix**         | —        | —          |
| Siemens      | —                   | **MindSphere→IOX** | —        | —          |
| **ClawTwin** | **Ontology**        | **Nexus**          | **Sage** | **Studio** |

**命名原则**：

- 简短易记，中英文均可发音
- 含义指向核心价值，不是技术实现
- 整体有家族感，各产品名词有内在逻辑

### 1.2 产品家族名称体系（最终版）

```
品牌名：ClawTwin
        含义：Claw = OpenClaw AI 能力基因；Twin = 数字孪生工业基因
        定位：工业 AI 操作系统（Industrial AI Operating System）

产品线：
  ClawTwin Nexus      工业 AI 中枢（数据+本体+行动+连接）
  ClawTwin Studio     工业操作工作台（工程师+管理层 PC 界面）
  ClawTwin Sage       工业 AI 技能包（OpenClaw Skills + 知识包）
  ClawTwin Connect    企业连接器套件（OT+IT 系统集成 SDK）

辅助组件（不单独对外，随 Nexus 交付）：
  ClawTwin Bridge     OT 数据采集桥（opcua-bridge，DMZ 部署）
  ClawTwin Mobile     移动端体验（飞书 Bot + 审批卡片，随 Nexus 配置）
```

---

## 二、各产品商业定位与边界

### 2.1 ClawTwin Nexus（工业 AI 中枢）

```
英文定位：Industrial AI Semantic Hub
中文定位：工业 AI 语义中枢

一句话：
  「连接工业世界与 AI 世界的神经中枢——
   把设备数据、行业知识、企业流程统一在一个
   AI 可理解的语义空间里。」

替代的旧名称：ClawTwin Platform（太通用）

为什么叫 Nexus：
  · Nexus = 拉丁语"纽带、连接点"
  · 含义：连接 OT（设备）+ IT（企业系统）+ AI（推理）+ 人（操作员）
  · 技术界：Nexus 常用于"hub"类产品（无版权冲突）
  · 读音：中文可称"纽联"或直接用英文

核心职责（做）：
  ✓ 工业本体管理（设备类型/指标/关系/行动定义）
  ✓ 数字孪生状态管理（实时设备镜像）
  ✓ 时序数据存储与查询（TimescaleDB）
  ✓ 知识库管理（文档摄入/向量化/检索）
  ✓ 工单全生命周期管理（FSM + HITL）
  ✓ 告警管理与路由
  ✓ 企业系统集成（通过 Connect 连接器）
  ✓ 用户认证与权限管理（ABAC）
  ✓ 审计日志（不可篡改）
  ✓ AI 任务调度（接受 Studio 触发，分发给 Sage/Skill）
  ✓ 定时监控任务（MOIRAI 异常检测，晨报生成）
  ✓ SSE 实时推送（设备状态推送到 Studio）

明确不做（边界）：
  ✗ AI 推理（在 Sage/GPU Server，Nexus 不调 LLM chat）
  ✗ 用户界面（在 Studio）
  ✗ OPC-UA 直采（在 Bridge，DMZ 隔离）
  ✗ 控制指令（不写 PLC/DCS，只读）

商业模式：
  · 私有化部署许可（按站场/年）
  · 源代码订阅（大客户可获得源码审计权）
  · 实施服务（部署+培训+集成）
  · 年度维护（含 Bug 修复和小版本升级）

技术实现：
  FastAPI + PostgreSQL/TimescaleDB + **pgvector** + Redis（**Phase A**；Kafka/独立 Milvus/Eclipse Ditto 为 **Phase B/C 按需**，见 ARCHITECTURE-SIMPLIFICATION-AUDIT）
```

### 2.2 ClawTwin Studio（工业操作工作台）

```
英文定位：Industrial Operations Workbench
中文定位：工业 AI 操作工作台

一句话：
  「为工程师和调度员设计的 AI 决策工作台——
   让复杂的工业决策像操作 iPad 一样直觉。」

核心职责（做）：
  ✓ 场站/设备对象浏览（Palantir Workshop 范式）
  ✓ P&ID 工艺图（SVG/实时状态叠加）
  ✓ 设备实时状态看板（SSE 驱动）
  ✓ AI 诊断结果展示（带引用来源）
  ✓ 告警管理界面（ISA-18.2 分级）
  ✓ 工单创建/审批/追踪（HITL 工作流）
  ✓ 知识库浏览与搜索
  ✓ KPI 分析图表
  ✓ 班次交接
  ✓ 大屏 Command 视图（Phase B）
  ✓ 管理员后台（本体/用户/KB/系统）

明确不做：
  ✗ 业务逻辑计算（在 Nexus）
  ✗ AI 推理（在 Sage）
  ✗ 移动端（在 Mobile/飞书）

商业模式：
  · 随 Nexus 捆绑交付（不单独销售）
  · 座席数量授权（同时在线用户数）
```

### 2.3 ClawTwin Sage（工业 AI 技能包）

```
英文定位：Industrial AI Skills & Intelligence Pack
中文定位：工业 AI 智能技能包

一句话：
  「预装了行业专家知识的工业 AI 技能套件——
   让你的操作员第一天就拥有 20 年工龄专家的判断力。」

为什么叫 Sage：
  · Sage = 智者、贤人（英文），也有「悟性深厚」的含义
  · 工业语境：有经验的老工程师 = industrial sage
  · 区别于通用 AI：不是「ChatGPT」，是「行业专家」

核心职责（做）：
  ✓ OpenClaw Skills（设备诊断/工单/知识/分析/异常）
  ✓ 行业 Prompt 模板库（标准版 + 设备类型定制版）
  ✓ 行业知识包（L0 标准规范 + L1 设备手册）
  ✓ HITL 工作流模板（行业最佳实践工单流程）
  ✓ 飞书交互模板（告警卡片/审批卡片/晨报卡片）
  ✓ AI 模型运行配置（vLLM/MOIRAI 部署指南）
  ✓ Skill 版本管理（AI 模型升级时 Skill 同步更新）

明确不做：
  ✗ LLM 模型训练（使用 Qwen3/vLLM 开源）
  ✗ 数据存储（在 Nexus）
  ✗ 用户界面（Studio/飞书）
  ✗ 企业系统集成（在 Connect）

商业模式：
  · 行业包年订阅（油气包、化工包、电力包）
  · 含：Skill 代码 + 知识包 + Prompt 模板 + 更新服务
  · 随 AI 模型进化，Sage 质量持续提升，订阅价值增加
  · 可与 Nexus 捆绑（Suite），也可单独销售给有 Nexus 的客户

技术实现：
  OpenClaw 部署（外部产品，我们配置 Skills）
  GPU Server：vLLM + bge-m3 + MOIRAI
```

### 2.4 ClawTwin Connect（企业连接器套件）

```
英文定位：Industrial Enterprise Connector Suite
中文定位：企业系统集成连接器

一句话：
  「让 ClawTwin Nexus 与你现有的任何企业系统对话——
   不替换你的 ERP/CMMS/OA，而是让它们变聪明。」

核心职责（做）：
  ✓ OT 侧连接器（OPC-UA / AVEVA PI / Modbus / REST）
  ✓ IT 侧连接器（飞书OA / ERP / CMMS / HR）
  ✓ Connector SDK（合作伙伴自建连接器的开发框架）
  ✓ 连接器注册表（Nexus 中的连接器管理）
  ✓ 连接器健康监控
  ✓ 数据映射配置（外部字段 → Nexus 对象属性）

商业模式：
  · 基础连接器（飞书/OPC-UA）随 Nexus 免费提供
  · 企业级连接器（SAP/Maximo/ABB/Honeywell）按模块收费
  · Connector SDK 开源（吸引合作伙伴生态）
  · 合作伙伴认证连接器（分成模式）
```

---

## 三、完整架构图（命名修正版）

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                    ClawTwin Industrial AI Operating System                ║
╚═══════════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────────┐
│                    用户接触层（User Touch Layer）                          │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  ClawTwin Studio │  │  ClawTwin Mobile │  │  API / MCP 接口      │  │
│  │  工业操作工作台  │  │  飞书 Bot+审批   │  │  第三方系统集成      │  │
│  │  PC 浏览器       │  │  手机移动端      │  │  HiAgent / 自定义    │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
└───────────┼──────────────────────┼────────────────────────┼─────────────┘
            │ User JWT             │ 飞书事件               │ API Key
            ▼                      ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              ClawTwin Sage（工业 AI 技能包）                              │
│                                                                         │
│  OpenClaw Gateway（开源，承载 Skills）                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │equipment │ │knowledge │ │workorder │ │analytics │ │ anomaly/pid  │ │
│  │-twin     │ │-base     │ │-hitl     │ │-query    │ │ /visual-insp.│ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ │
│       │             │             │             │              │         │
│  Service Token（Skill → Nexus）                                          │
│       │             │             │             │              │         │
│       └──────────────┴─────────────┴─────────────┴──────────────┘       │
│                                   │                                      │
│  直接调用 GPU Server（不经 Nexus） │  GPU Server                          │
│  vLLM Qwen3-35B :8000            ◄┘  bge-m3 :8001  MOIRAI :8002        │
└────────────────────────────────────────────────────────────────────────┘
                                   │ Service Token
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              ClawTwin Nexus（工业 AI 中枢）                               │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Ontology Engine（本体引擎）                                        │  │
│  │  /v1/ontology/*  ← 设备类型/指标/关系/行动的权威定义              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Digital Twin Runtime（孪生运行时）                                 │  │
│  │  /v1/objects/*  /v1/readings/*  ← 实时状态 + 时序数据             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Knowledge Manager（知识管理）                                      │  │
│  │  /v1/kb/*  ← L0-L3 向量知识检索、文档摄入                         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Action Engine（行动引擎）                                          │  │
│  │  /v1/workorders/*  /v1/alarms/*  ← HITL 工单 FSM + 告警路由      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  AI Job Dispatcher（AI 任务分发）                                   │  │
│  │  /v1/ai/jobs/*  ← 接受 Studio 触发，路由到 Sage Skill             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Connect Layer（企业连接器层）                                      │  │
│  │  connectors/  ← OT 适配器 + IT 企业连接器                         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Security & Audit（安全审计，贯穿所有层）                           │  │
│  │  JWT + ABAC + 审计日志 + Rate Limiting                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  存储层（Nexus 私有，数据不出厂）                                         │
│  PostgreSQL/TimescaleDB+**pgvector**  |  Redis  |  Ditto/Kafka（Phase B/C） │
│                                                                         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
┌─────────────────────────┐        ┌────────────────────────────┐
│  ClawTwin Bridge        │        │  ClawTwin Connect          │
│  OT 数据采集桥           │        │  企业连接器                 │
│  Zone 1 DMZ 部署         │        │  ERP / CMMS / OA / HR     │
│  OPC-UA → Kafka          │        │  双向读写（权限受控）       │
└─────────────────────────┘        └────────────────────────────┘
```

> **Phase A 对齐**：向量检索用 **PostgreSQL pgvector**（`kb_chunks.embedding`），**不**默认独立 Milvus；与 `DESIGN-FINAL-LOCK.md`、`clawtwin-project/SKILL.md` 铁律 10/20 一致。

> **简图补充说明**：上图是分层鸟瞰，不展开各产品全部页面、引擎、Topic 与端到端调度。**按产品线补全功能面 + 业务时间轴调度**（含 Sage 全套 Skill、Kafka 异步边、Studio 全列表、Bridge/Connect 边界）见 **`PRODUCT-LAYER-ARCHITECTURE-EXPANDED.md`**；API 以 **`DESIGN-FINAL-LOCK.md`** 为终态，§四 中与 LOCK 不一致的路径以 LOCK 为准。

---

## 四、ClawTwin Nexus：完整模块与接口清单

### 4.1 模块目录结构（权威版）

```
nexus/                              # ClawTwin Nexus 服务根目录
│
├── main.py                         # 应用入口（FastAPI app + lifespan）
├── config/
│   └── settings.py                 # 配置（env 变量，见 §27.8）
│
├── core/                           # 核心横切模块
│   ├── response.py                 # 统一响应格式 ok/paginate/err
│   ├── security.py                 # JWT 解码 + Service Token 验证
│   ├── pagination.py               # get_pagination 依赖
│   ├── trace.py                    # TraceMiddleware（X-Trace-Id）
│   └── exceptions.py              # 全局异常处理
│
├── routers/                        # API 路由（每组一个文件）
│   ├── auth.py                     # 认证路由
│   ├── ontology.py                 # 本体管理路由（新）
│   ├── objects.py                  # 对象查询路由
│   ├── equipment.py                # 设备路由
│   ├── stations.py                 # 场站路由
│   ├── readings.py                 # 传感器读数路由（新，独立）
│   ├── workorders.py               # 工单路由
│   ├── alarms.py                   # 告警路由
│   ├── shifts.py                   # 班次路由
│   ├── kb.py                       # 知识库路由
│   ├── analytics.py                # 分析路由
│   ├── ai_jobs.py                  # AI 任务路由（Studio 触发）
│   ├── tools.py                    # Tool API（Service Token only）
│   ├── sse.py                      # SSE 实时推送路由
│   ├── feishu.py                   # 飞书 Webhook 路由
│   ├── media.py                    # 文件上传路由
│   ├── admin.py                    # 管理员路由
│   ├── reports.py                  # 数据导出路由
│   └── health.py                   # 健康检查 + Prometheus 指标
│
├── engines/                        # 核心业务引擎（新目录结构）
│   ├── ontology/                   # 本体引擎
│   │   ├── registry.py             # EQUIPMENT_TYPE_REGISTRY（DB 持久化版）
│   │   ├── models.py               # equipment_types/metrics/actions ORM
│   │   └── seed.py                 # 初始化本体数据脚本
│   │
│   ├── twin/                       # 孪生运行时引擎
│   │   ├── state_manager.py        # 设备状态读写（Redis；Ditto Phase B/C）
│   │   ├── ingest.py               # IngestPipeline（背压/采样/丢弃）
│   │   └── sse_publisher.py        # SSE 推送服务
│   │
│   ├── knowledge/                  # 知识管理引擎
│   │   ├── search.py               # 三层检索（L0-L3 + GraphRAG）
│   │   ├── ingest_pipeline.py      # 文档→chunks→embed→**pgvector**（铁律 20）
│   │   └── l3_writer.py            # 工单完成→自动写入 L3 知识
│   │
│   ├── action/                     # 行动执行引擎
│   │   ├── workorder_fsm.py        # 工单状态机（DRAFT→DONE）
│   │   ├── primary_action.py       # compute_primary_action（纯规则）
│   │   └── action_templates.py     # ACTION_TEMPLATES 定义
│   │
│   ├── alarm/                      # 告警引擎
│   │   ├── alarm_manager.py        # 告警创建/确认/屏蔽（ISA-18.2）
│   │   └── alarm_router.py         # 告警→飞书/SSE 路由
│   │
│   └── ai_jobs/                    # AI 任务分发引擎
│       ├── job_queue.py            # Redis List 队列管理
│       ├── job_worker.py           # 后台 worker（触发 Sage/OpenClaw）
│       └── job_models.py           # AIJob ORM 模型
│
├── connectors/                     # 企业连接器层（ClawTwin Connect 实现）
│   ├── base.py                     # BaseConnector 抽象类
│   ├── registry.py                 # 连接器注册表
│   ├── ot/                         # OT 侧连接器
│   │   ├── opcua_adapter.py        # OPC-UA 连接器
│   │   ├── aveva_pi.py             # AVEVA PI 连接器（Phase B）
│   │   ├── rest_adapter.py         # 通用 REST 连接器
│   │   ├── modbus_adapter.py       # Modbus 连接器（Phase B）
│   │   └── csv_import.py           # CSV 批量导入工具
│   └── it/                         # IT 侧连接器
│       ├── feishu_oa.py            # 飞书 OA 审批连接器
│       ├── feishu_hr.py            # 飞书 HR 组织同步
│       ├── cmms_generic.py         # 通用 CMMS 连接器（Maximo 兼容）
│       ├── erp_generic.py          # 通用 ERP 连接器（Phase B）
│       └── dingtalk_oa.py          # 钉钉 OA 连接器（Phase B）
│
├── services/                       # 外部服务客户端（轻量封装）
│   ├── embed_client.py             # bge-m3 HTTP 客户端（embed only）
│   ├── moirai_client.py            # MOIRAI HTTP 客户端
│   ├── feishu_push.py              # 飞书消息推送客户端
│   ├── feishu_hitl.py              # 飞书 HITL 回调处理
│   └── pgvector_kb.py             # kb_chunks 向量读写（PostgreSQL；**非** Milvus）
│
├── kafka/                          # Kafka 消费者（OT 数据流接收）
│   ├── consumer.py                 # opcua.realtime 消费→TimescaleDB+Redis
│   └── event_consumer.py           # opcua.events 消费→告警引擎
│
├── scheduler/                      # 定时任务
│   ├── jobs.py                     # APScheduler 注册中心
│   ├── anomaly.py                  # MOIRAI 异常检测任务（30s）
│   ├── morning.py                  # 晨报任务（06:00，结构化卡片）
│   ├── kpi.py                      # 每日 KPI 聚合（00:05）
│   └── helpers.py                  # 辅助查询函数
│
├── db/                             # 数据库层
│   ├── base.py                     # DeclarativeBase
│   ├── session.py                  # AsyncSession 工厂
│   ├── models/                     # ORM 模型
│   │   ├── user.py                 # User, Role, UserStation
│   │   ├── station.py              # Station（含 ims_config JSONB）
│   │   ├── equipment.py            # Equipment
│   │   ├── equipment_reading.py    # EquipmentReading（TimescaleDB 超表）
│   │   ├── alarm.py                # Alarm
│   │   ├── workorder.py            # WorkOrder（wo_id + state FSM）
│   │   ├── knowledge.py            # KBDocument, IngestTask
│   │   ├── audit.py                # AuditLog（append-only）
│   │   ├── ai_job.py               # AIJob（AI 任务队列记录）
│   │   └── ontology.py             # EquipmentType, TypeMetric, TypeAction
│   └── migrations/                 # Alembic 迁移文件
│
└── auth/                           # 认证模块
    ├── deps.py                     # get_current_user / require_station / get_service_token
    ├── jwt_utils.py                # JWT 创建/解码
    ├── password.py                 # bcrypt hash/verify
    └── feishu_bind.py              # 飞书账号绑定逻辑
```

### 4.2 完整 API 接口清单（按模块）

#### AUTH（认证）

```
POST   /v1/auth/login               用户名密码登录 → JWT
POST   /v1/auth/feishu/bind         飞书账号绑定
POST   /v1/auth/feishu/callback     飞书 OAuth 回调
POST   /v1/auth/refresh             JWT 刷新
DELETE /v1/auth/logout              退出登录
```

#### ONTOLOGY（本体管理）

```
GET    /v1/ontology/equipment-types              获取所有设备类型定义
GET    /v1/ontology/equipment-types/{type_id}    获取单个设备类型
GET    /v1/ontology/equipment-types/{type_id}/metrics   该类型的指标定义
GET    /v1/ontology/equipment-types/{type_id}/actions   该类型支持的行动
POST   /v1/ontology/equipment-types              创建设备类型（Admin）
PUT    /v1/ontology/equipment-types/{type_id}    更新设备类型（Admin）
DELETE /v1/ontology/equipment-types/{type_id}    删除设备类型（Admin）
```

#### OBJECTS（对象聚合查询）

```
GET    /v1/objects/equipment/{id}            聚合对象（静态属性+实时状态+告警+工单）
GET    /v1/objects/equipment/{id}/links      上下游关联设备
GET    /v1/objects/equipment/{id}/timeline   设备历史事件时间线
GET    /v1/objects/station/{id}              场站聚合对象
GET    /v1/objects/station/{id}/health       场站整体健康评分
```

#### EQUIPMENT（设备 CRUD）

```
GET    /v1/equipment                         设备列表（分页）
GET    /v1/equipment/{id}                    设备详情
GET    /v1/equipment/{id}/ai-context         AI 诊断上下文快照（Service Token）
GET    /v1/equipment/{id}/health-score       设备健康评分（规则计算）
GET    /v1/equipment/{id}/primary-action     当前主行动建议（规则计算）
POST   /v1/equipment                         创建设备（Admin）
PUT    /v1/equipment/{id}                    更新设备（Admin）
DELETE /v1/equipment/{id}                    删除设备（Admin）
```

#### STATIONS（场站）

```
GET    /v1/stations                          场站列表
GET    /v1/stations/{id}                     场站详情
GET    /v1/stations/{id}/equipment           场站下的设备列表
GET    /v1/stations/{id}/alarms/active       场站活跃告警
POST   /v1/stations                          创建场站（Admin）
PUT    /v1/stations/{id}                     更新场站（含 ims_config）
```

#### READINGS（传感器读数）

```
GET    /v1/readings/{equipment_id}           最近 N 条读数
GET    /v1/readings/{equipment_id}/range     时间范围查询（from/to）
GET    /v1/readings/{equipment_id}/latest    最新一条（所有指标）
GET    /v1/readings/{equipment_id}/aggregate 聚合统计（avg/max/min，按时间粒度）
POST   /v1/readings/batch                    批量写入（内部，Kafka 消费者调用）
```

#### P&ID（工艺图数据）

```
GET    /v1/pid/layout/{station_id}           P&ID 拓扑结构（节点+连接 JSON）
GET    /v1/pid/realtime/{station_id}         各节点当前状态（颜色编码用）
PUT    /v1/pid/layout/{station_id}           更新 P&ID 布局（Admin）
```

#### WORKORDERS（工单）

```
GET    /v1/workorders                        工单列表（分页，可按 state/station 过滤）
GET    /v1/workorders/{wo_id}                工单详情
POST   /v1/workorders                        手动创建工单
POST   /v1/workorders/{wo_id}/submit         提交审批（draft→pending）
POST   /v1/workorders/{wo_id}/approve        批准（pending→approved）
POST   /v1/workorders/{wo_id}/reject         驳回（pending→draft）
POST   /v1/workorders/{wo_id}/start          开始执行（approved→executing）
POST   /v1/workorders/{wo_id}/complete       完成（executing→done）
POST   /v1/workorders/{wo_id}/cancel         取消（任意→cancelled）
GET    /v1/workorders/{wo_id}/history        工单状态变更历史
GET    /v1/workorders/export                 工单导出（CSV/Excel）
```

#### ALARMS（告警）

```
GET    /v1/alarms                            告警列表（分页）
GET    /v1/alarms/{id}                       告警详情
POST   /v1/alarms/{id}/acknowledge           确认告警
POST   /v1/alarms/{id}/shelve                屏蔽告警（N分钟）
POST   /v1/alarms/{id}/close                 关闭告警
GET    /v1/alarms/statistics                 告警统计（by 设备/类型/时段）
```

#### SHIFTS（班次）

```
GET    /v1/shifts/current                    当前班次信息
GET    /v1/shifts/{id}                       班次详情
POST   /v1/shifts/handover                   班次交接（含 AI 生成摘要）
GET    /v1/shifts/handover/draft             生成交接摘要草稿（AI，异步）
```

#### KNOWLEDGE BASE（知识库）

```
GET    /v1/kb/search                         知识语义搜索（embed + **pgvector**；Phase A 可子串回退见 LOCK）
POST   /v1/kb/search                         同上（POST 版，支持更长 query）
GET    /v1/kb/documents                      文档列表（分页）
GET    /v1/kb/documents/{id}                 文档详情
POST   /v1/kb/documents                      上传文档（触发向量化任务）
DELETE /v1/kb/documents/{id}                 删除文档（含向量）
GET    /v1/kb/documents/{id}/status          向量化任务状态
POST   /v1/kb/ingest                         批量摄入（Service Token）
```

#### ANALYTICS（分析查询）

```
GET    /v1/analytics/equipment-health        设备健康趋势（N天）
GET    /v1/analytics/alarm-stats             告警统计（by 设备/类型/时间）
GET    /v1/analytics/kpi                     KPI 汇总（availability/efficiency/MTBF）
GET    /v1/analytics/top-anomalies           Top N 异常设备
GET    /v1/analytics/trend                   指定指标趋势（支持聚合粒度）
GET    /v1/analytics/workorder-stats         工单统计（by 状态/类型/处理时长）
```

#### AI JOBS（AI 任务，Studio 触发）

```
POST   /v1/ai/jobs                           创建 AI 任务（User JWT）
GET    /v1/ai/jobs/{job_id}                  查询任务状态和结果
GET    /v1/ai/jobs                           历史任务列表
DELETE /v1/ai/jobs/{job_id}                  取消待执行任务
```

#### TOOL API（Service Token Only，供 Sage/Skill 调用）

```
GET    /v1/tools/equipment/context           设备上下文快照（Skill 组 Prompt 用）
POST   /v1/tools/kb/search                   知识检索（同 /v1/kb/search，Service Token 版）
POST   /v1/tools/workorders/ai-draft         创建 AI 工单草稿（Skill 完成推理后调）
POST   /v1/tools/kb/ingest                   知识摄入（Skill 写入 L3 知识）
POST   /v1/tools/alarms/create               创建告警（MOIRAI 异常检测结果）
GET    /v1/tools/stations/{id}/context       场站整体上下文（Skill 用）
```

#### SSE（实时推送）

```
GET    /v1/sse/station/{station_id}          场站实时数据流（SSE）
GET    /v1/sse/alarms/{station_id}           告警实时流（SSE）
GET    /v1/sse/ai-jobs/{job_id}              AI 任务完成通知（SSE）
```

#### FEISHU（飞书事件）

```
POST   /v1/feishu/webhook                    飞书事件总入口（验签+路由）
POST   /v1/feishu/oa/callback                飞书 OA 审批回调
```

#### MEDIA（文件）

```
POST   /v1/media/upload                      上传文件（图片/PDF）
GET    /v1/media/{id}                        获取文件
DELETE /v1/media/{id}                        删除文件（Admin）
```

#### NOTIFICATIONS（通知）

```
POST   /v1/notifications/notify-operator     通知指定操作员（飞书消息）
POST   /v1/notifications/broadcast           广播到值班群
GET    /v1/notifications/preferences         用户通知偏好
PUT    /v1/notifications/preferences         更新通知偏好
```

#### ADMIN（管理员，需 sys_admin 角色）

```
── 用户管理 ──
GET    /v1/admin/users                       用户列表
POST   /v1/admin/users                       创建用户
PUT    /v1/admin/users/{id}                  更新用户
PUT    /v1/admin/users/{id}/stations         更新用户场站权限
PUT    /v1/admin/users/{id}/active           启用/禁用用户

── 本体管理 ──
（见 /v1/ontology/* 的 POST/PUT/DELETE，Admin 权限）

── 知识库管理 ──
（见 /v1/kb/documents 的管理操作）

── 系统管理 ──
GET    /v1/admin/system/health               系统服务健康状态
GET    /v1/admin/system/stats                系统统计（用户数/工单数/KB文档数）
GET    /v1/admin/audit-logs                  审计日志查询（分页）
POST   /v1/admin/system/backup               触发手动备份
GET    /v1/admin/connectors                  连接器状态列表
PUT    /v1/admin/connectors/{id}/config      更新连接器配置
```

#### HEALTH & METRICS（可观测性）

```
GET    /v1/health                            服务健康状态（所有依赖）
GET    /v1/metrics                           Prometheus 格式指标
```

---

## 五、ClawTwin Sage：完整模块与技能清单

### 5.1 Skill 列表（OpenClaw 配置）

```
skills/
├── equipment-twin/               # 设备孪生技能
│   ├── SKILL.md                  # 技能文档（触发条件/工具/行为规则）
│   ├── manifest.json             # OpenClaw 技能声明
│   └── tools.py                  # 工具实现（调用 Nexus API + vLLM）
│
├── knowledge-base/               # 知识库技能
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── workorder-hitl/               # 工单 HITL 技能
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── analytics-query/              # 数据分析技能
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── anomaly-alert/                # 异常预警技能（MOIRAI 驱动）
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── pid-analysis/                 # P&ID 分析技能（Phase B）
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── visual-inspect/               # 视觉巡检技能（Phase B，Qwen2.5-VL）
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
├── shift-handover/               # 班次交接技能
│   ├── SKILL.md
│   ├── manifest.json
│   └── tools.py
│
└── incident-manager/             # 事件根因分析技能（Phase B）
    ├── SKILL.md
    ├── manifest.json
    └── tools.py
```

### 5.2 Prompt 模板库（版本化管理）

```
prompts/
├── diagnosis/
│   ├── compressor_v1.txt         # 压缩机诊断提示词
│   ├── valve_v1.txt              # 阀门诊断提示词
│   ├── pump_v1.txt               # 泵组诊断提示词
│   └── generic_equipment_v1.txt  # 通用设备诊断提示词
├── workorder/
│   ├── ai_draft_v1.txt           # AI 工单起草提示词
│   └── completion_summary_v1.txt # 完工摘要提示词
├── analytics/
│   ├── kpi_summary_v1.txt        # KPI 摘要提示词
│   └── trend_analysis_v1.txt     # 趋势分析提示词
└── briefing/
    └── morning_report_v1.txt     # 晨报生成提示词（Sage 只用于生成文字段落）
```

### 5.3 知识包内容（L0/L1 标准版）

```
knowledge-packs/
├── oil-gas/                      # 石油天然气知识包
│   ├── L0-standards/             # 行业标准（公开文档）
│   │   ├── GB-T-50251.pdf        # 输气管道工程设计规范
│   │   ├── SY-T-5543.pdf         # 压缩机组操作维护规程
│   │   ├── API-670.pdf           # 振动监测标准
│   │   └── API-RP-14C.pdf        # 安全分析标准
│   ├── L1-equipment/             # 设备类手册（脱敏版）
│   │   ├── compressor-generic.pdf
│   │   ├── gate-valve-generic.pdf
│   │   └── centrifugal-pump-generic.pdf
│   └── seed-script.py            # 知识包摄入脚本
├── chemical/                     # 化工知识包（Phase B）
└── power/                        # 电力知识包（Phase B）
```

---

## 六、ClawTwin Connect：连接器接口规范

### 6.1 连接器基类接口

```python
# connectors/base.py
class BaseConnector(ABC):
    """
    所有连接器必须实现此接口。
    合作伙伴按此规范可以开发自定义连接器。
    """
    @property
    @abstractmethod
    def connector_id(self) -> str: ...        # "feishu_oa" | "sap_erp" | ...

    @property
    @abstractmethod
    def connector_type(self) -> str: ...      # "it" | "ot"

    @abstractmethod
    async def health_check(self) -> bool: ... # 连接器健康检查

    @abstractmethod
    async def configure(self, config: dict) -> None: ...  # 配置更新

class OTConnector(BaseConnector):
    """OT 侧连接器基类（设备数据读取）"""
    @abstractmethod
    async def read_equipment(self, equipment_id: str) -> Reading: ...

    @abstractmethod
    async def subscribe(self, equipment_ids: list[str],
                        callback: Callable) -> None: ...

class ITConnector(BaseConnector):
    """IT 侧连接器基类（企业系统集成）"""
    @abstractmethod
    async def push_work_order(self, workorder: dict) -> str: ...  # 返回外部系统 ID
    @abstractmethod
    async def pull_user_org(self) -> list[dict]: ...               # 拉取组织架构
    @abstractmethod
    async def trigger_approval(self, approval_data: dict) -> str: ... # 发起审批
```

### 6.2 连接器配置 API（Nexus 提供）

```
GET    /v1/admin/connectors                  已注册连接器列表（含健康状态）
GET    /v1/admin/connectors/{id}             连接器详情和配置
POST   /v1/admin/connectors/{id}/test        测试连接
PUT    /v1/admin/connectors/{id}/config      更新配置（加密存储敏感字段）
POST   /v1/admin/connectors/{id}/enable      启用连接器
DELETE /v1/admin/connectors/{id}/disable     禁用连接器
```

---

## 七、ClawTwin Studio：完整页面与组件清单

### 7.1 页面路由结构

```
/login                            登录页
/studio                           主工作台（需认证）
  /studio/dashboard               场站概览看板（默认页）
  /studio/equipment/:id           设备详情（对象中心页）
  /studio/pid                     P&ID 工艺图
  /studio/alarms                  告警中心（ISA-18.2）
  /studio/workorders              工单中心
  /studio/workorders/:wo_id       工单详情
  /studio/analytics               数据分析
  /studio/knowledge               知识库浏览
  /studio/shifts                  班次管理
  /studio/ai-jobs                 AI 任务历史
/command                          大屏视图（Phase B）
/admin                            管理员后台（sys_admin only）
  /admin/users                    用户管理
  /admin/stations                 场站管理
  /admin/equipment                设备管理
  /admin/ontology                 本体配置（★新，设备类型/指标/行动）
  /admin/knowledge                知识库管理
  /admin/connectors               连接器配置（★新）
  /admin/system                   系统状态
```

### 7.2 核心组件清单

```
布局组件：
  StudioShell           主布局（NavRail + CenterView + ContextPanel）
  NavRail               左侧导航栏（场站/告警/工单快捷入口）
  CenterView            中央内容区（Twin/Graph/Trend/Kanban/PID 切换）
  ContextPanel          右侧上下文面板（设备详情/AI 建议）
  CommandPalette        全局搜索（Cmd+K）

数据显示组件：
  EquipmentCard         设备状态卡片（指标 + 状态色 + 主行动）
  HealthScoreCard       设备健康评分卡（多维评分）
  AlarmBadge            告警徽标（P1/P2/P3 分级）
  MetricSparkline       指标迷你图表
  TrendChart            指标趋势图（时序）
  PIDViewer             P&ID 工艺图（SVG + 实时状态叠加）
  TwinSurface           3D 孪生场景（Babylon.js，Phase B）

AI 交互组件：
  AIInsightPanel        AI 诊断结论展示（置信度 + 引用来源）
  WorkOrderDraftInline  工单草稿内嵌面板（AI 起草 + 人工编辑 + 提交）
  InvestigationBanner   P1 告警全屏调查模式
  AIJobTracker          AI 任务进度条（轮询 SSE）
  CitationBlock         知识引用展示块

业务组件：
  AlarmQueuePanel       告警队列面板（排序 + 过滤）
  WorkOrderTable        工单列表表格
  WorkOrderDetail       工单详情（含审批链）
  ShiftHandoverCard     班次交接卡片
  KPIDashboard          KPI 看板（各类统计图）
  KnowledgeBrowser      知识库浏览（文档列表 + 搜索）

管理员组件：
  OntologyEditor        本体编辑器（设备类型/指标/行动 CRUD）
  ConnectorConfig       连接器配置面板
  UserTable             用户管理表格
  KBUploader            知识库文档上传（含向量化进度）
  SystemStatus          系统依赖健康看板

基础 Hook：
  useSSE(stationId)     订阅场站 SSE 数据流
  useAIJob(jobId)       轮询 AI 任务状态
  useEquipment(id)      设备数据（React Query）
  useWorkOrders(filter) 工单列表（分页）
  useAlarms(stationId)  告警列表
  useOntology()         本体定义（缓存）
```

---

## 八、数据库完整表清单

```
核心业务表：
  users                   用户（id/feishu_open_id/role/name）
  user_stations           用户-场站权限（user_id/station_id）
  stations                场站（id/name/location/ims_config）
  equipment               设备（id/station_id/type/name/manufacturer）
  equipment_readings      传感器读数（TimescaleDB 超表）
  alarms                  告警（id/equipment_id/level/state/metric）
  work_orders             工单（wo_id/state/ai_draft/citations）
  work_order_history      工单状态变更历史（FSM 审计）
  shifts                  班次记录
  audit_logs              审计日志（append-only）

知识库表：
  kb_documents            文档元数据（id/title/layer/station_id/status）
  ingest_tasks            向量化任务（document_id/state/progress）

AI 相关表：
  ai_jobs                 AI 任务队列记录（job_id/type/state/result）

本体定义表：
  equipment_types         设备类型定义（type_id/name_zh/name_en/category）
  equipment_type_metrics  设备类型指标（type_id/metric/unit/warn/alarm）
  equipment_type_actions  设备类型行动（type_id/action_id/label/requires_approval）

P&ID 表：
  pid_layouts             P&ID 布局数据（station_id/layout JSONB）

媒体表：
  media_files             文件（id/filename/content_type/storage_path）

向量存储（**pgvector** / `kb_chunks`）：
  kb_chunks 行           知识向量（document_id/chunk_id/embedding/layer/station_id…；**非** Milvus collection）
```

---

## 九、对外接口规范（面向集成商）

### 9.1 鉴权方式汇总

```
场景                    令牌类型           获取方式
──────────────────────────────────────────────────────────────────
用户登录后访问 API      User JWT           POST /v1/auth/login
飞书用户访问 API        User JWT（飞书绑定）飞书 OAuth → 绑定
Sage/Skill 调用 API     Service Token      管理员配置，静态密钥
第三方应用              API Key            申请（Phase B 实现）
内部服务间              内网 IP 限制       无需鉴权（限 Prometheus）
```

### 9.2 标准响应格式

```json
// 成功
{"ok": true, "data": {...}, "meta": {"trace_id": "abc123"}}

// 列表（分页）
{"ok": true, "data": [...], "meta": {"total": 100, "page": 1, "per_page": 20}}

// 错误
{"ok": false, "code": "NOT_FOUND", "message": "设备不存在", "trace_id": "abc123"}
```

### 9.3 Webhook 回调规范（Nexus 作为客户端发出）

```
事件类型                触发条件              目标
ALARM_CREATED          新告警触发             飞书值班群 / 企业连接器
ALARM_UPDATED          告警状态变更           飞书
WORKORDER_CREATED      工单创建              CMMS 连接器 / 飞书
WORKORDER_STATE        工单状态变更           飞书 OA / CMMS
AI_JOB_DONE            AI 任务完成           Studio SSE
MOIRAI_ANOMALY         时序预测异常          告警引擎
```

---

## 十、命名迁移对照表（旧→新）

| 旧名称                         | 新名称                     | 备注                                       |
| :----------------------------- | :------------------------- | :----------------------------------------- |
| ClawTwin Platform              | **ClawTwin Nexus**         | 对外品牌名                                 |
| platform-api/                  | nexus/                     | 代码目录（Phase B 迁移，Phase A 可暂不改） |
| Industry Skills                | **ClawTwin Sage**          | AI 技能包品牌名                            |
| IMS Adapter SDK                | **ClawTwin Connect（OT）** | 归入 Connect 范畴                          |
| Enterprise Connector           | **ClawTwin Connect（IT）** | 归入 Connect 范畴                          |
| `services/ai_client.py`        | `services/embed_client.py` | §26 已修正                                 |
| `services/vllm.py`             | 已废弃                     | §26/§27 已删除                             |
| `routers/tools.py diagnose`    | 已移至 Sage Skill          | §27 修正                                   |
| `EQUIPMENT_TYPE_REGISTRY` dict | ontology/ 数据库           | §28.3 修正                                 |

---

_本文档创建于 2026-05-11，是 ClawTwin 产品命名体系和模块接口的权威参考。_  
_代码目录仍用 platform-api/（Phase A 不改），对外文档统一使用 Nexus/Sage/Connect 名称。_
