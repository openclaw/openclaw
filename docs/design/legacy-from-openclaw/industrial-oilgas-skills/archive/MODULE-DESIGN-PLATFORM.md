# ClawTwin Platform — 模块概要设计

## 可直接指导开发的模块级设计文档

**版本**：V2.1（2026-05-11）  
**对应架构**：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md（最高权威）+ CLAWTWIN-MASTER-V2.md  
**读者**：后端开发工程师  
**目标**：看完本文档可以直接开始写代码，不需要再猜结构

> ⚠️ **2026-05-11 范式纠正**：ClawTwin 是 **Industrial Foundry**，不是 Agent 系统。
>
> - 本文档 §一 的目录结构（platform-api/{routers,services,models,...}）**已被取代**，
>   实际目录结构以 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §八` 为准（7 层：ontology/core/apps/aip/providers/infra/workers）
> - 业务实体不再写 `models/equipment.py`，而是先写 `ontology/object_types/equipment.yaml`
> - 写操作不再写 `routers/alarms.py acknowledge()`，而是先写 `ontology/action_types/acknowledge_alarm.yaml`
> - HTTP 端点由 [T2.6] Auto-Generator 自动生成，不再为每个 Object 手写 router
> - 本文档其余章节（§八 知识库 LlamaIndex / §十九 ORM 字段定义 / §二十九 等业务规则）**仍然有效**，作为 Object Type YAML 和 Action Type Handler 的实现参考

---

## 一、目录结构（完整，每个文件有明确职责）

```
clawtwin-platform/
├── docker-compose.yml          # 基础设施 + platform-api 服务编排
├── docker-compose.override.yml # 本地开发覆盖（mock 数据、端口映射）
├── .env.example                # 所有环境变量说明
├── ansible/                    # 运维部署（Phase B）
│   ├── inventory/
│   └── playbooks/
│
├── platform-api/               # FastAPI 主服务
│   ├── pyproject.toml
│   ├── requirements.txt
│   ├── Dockerfile
│   │
│   ├── main.py                 # FastAPI app、lifespan、router 注册
│   ├── config.py               # Pydantic Settings（所有配置项）
│   │
│   ├── auth/                   # 身份认证与权限
│   │   ├── __init__.py
│   │   ├── jwt.py              # JWT 签发与验证（RS256）
│   │   ├── abac.py             # ABAC 权限检查装饰器和函数
│   │   ├── depends.py          # FastAPI Dependencies（get_current_user）
│   │   └── feishu_bind.py      # feishu_open_id → user_id 查绑定表
│   │
│   ├── models/                 # 数据模型（SQLAlchemy ORM + Pydantic Schema）
│   │   ├── __init__.py
│   │   ├── user.py             # User, UserFeishuBinding, Role
│   │   ├── station.py          # Station, StationIMSConfig
│   │   ├── equipment.py        # Equipment, Threshold
│   │   ├── workorder.py        # WorkOrder, WorkOrderStep
│   │   ├── knowledge.py        # KBDocument, IngestTask
│   │   └── audit.py            # AuditLog
│   │
│   ├── routers/                # API 路由（每个文件对应一组端点）
│   │   ├── __init__.py
│   │   ├── health.py           # GET /v1/health
│   │   ├── auth.py             # POST /v1/auth/login, /v1/auth/bind
│   │   ├── objects.py          # GET /v1/objects/*（Ontology API）
│   │   ├── tools.py            # POST /v1/tools/*（OpenClaw Tool API）
│   │   ├── analytics.py        # GET /v1/analytics/*
│   │   ├── ingest.py           # POST /v1/ingest/*（知识摄入）
│   │   ├── hitl.py             # POST /v1/hitl/*（工单状态机）
│   │   ├── feishu_webhook.py   # POST /v1/feishu/webhook
│   │   └── admin.py            # /v1/admin/*（用户/设备/场站管理）
│   │
│   ├── kafka/                  # Kafka 消费者（接收 opcua-bridge 推送）
│   │   ├── __init__.py
│   │   ├── consumer.py         # opcua.realtime Topic 消费→写 PostgreSQL+Ditto
│   │   └── event_consumer.py   # opcua.events Topic 消费→告警触发
│   │
│   ├── services/               # 外部服务客户端
│   │   ├── __init__.py
│   │   ├── feishu.py           # Feishu Bot Client（推送消息/卡片）
│   │   ├── ditto.py            # Eclipse Ditto REST Client
│   │   ├── pgvector_kb.py      # **pgvector** / kb_chunks（替代历史 milvus.py）
│   │   ├── vllm.py             # vLLM OpenAI-compatible Client（chat + embedding）
│   │   ├── moirai.py           # MOIRAI 时序推理 Client
│   │   └── minio.py            # MinIO 文档存储 Client
│   │
│   ├── ims/                    # IMS 集成层（OT 数据接入）
│   │   ├── __init__.py
│   │   ├── adapter_base.py     # 抽象接口 IMSAdapter
│   │   ├── registry.py         # station_id → IMSAdapter 实例管理
│   │   ├── opcua_adapter.py    # OPC-UA 实现
│   │   ├── rest_adapter.py     # 通用 REST 实现
│   │   └── csv_import.py       # 历史数据 CSV 批量导入工具
│   │
│   ├── hitl/                   # 人机协作工单状态机
│   │   ├── __init__.py
│   │   └── workorder_fsm.py    # 状态机：DRAFT→PENDING→APPROVED→DONE
│   │
│   ├── kb/                     # 知识库业务逻辑
│   │   ├── __init__.py
│   │   ├── search.py           # 三层知识融合检索（**pgvector** L0-L3 + GraphRAG 关系）
│   │   └── ingest_pipeline.py  # 文档摄入 Pipeline（PDF→chunks→embed→**pgvector**）
│   │
│   ├── scheduler/              # 定时任务
│   │   ├── __init__.py
│   │   ├── jobs.py             # APScheduler 初始化和任务注册
│   │   ├── morning_briefing.py # 每日晨报（06:00）
│   │   ├── anomaly_poll.py     # 每小时异常轮询
│   │   └── health_report.py    # 每日健康检查
│   │
│   └── db/                     # 数据库
│       ├── __init__.py
│       ├── session.py          # SQLAlchemy async session
│       └── migrations/         # Alembic 迁移文件（版本化）
│
├── opcua-bridge/               # OT 数据采集（独立服务，部署在 DMZ）
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── main.py                 # 入口：订阅 OPC-UA → 推 Kafka
│   ├── config.py               # OPC-UA 配置
│   ├── node_map/
│   │   └── cng_station_nodes.json  # 节点映射（见 OPCUA-BRIDGE-DESIGN.md）
│   ├── config.py               # OPC-UA 配置
│   └── bridge.py               # 核心采集逻辑
│
├── data/
│   ├── mock/                   # Phase A Mock 数据（JSON）
│   │   ├── station-CNG-001.json  # 天然气压缩机场站（统一用此 ID）
│   │   └── equipment-C-001.json  # C-001 压缩机详情
│   └── seeds/                  # 初始化数据（设备台账、阈值标准）
│       └── equipment_thresholds.json  # 各类设备报警阈值参考值
│
└── scripts/
    ├── health-check.sh         # 日常健康检查脚本
    ├── backup.sh               # 备份脚本
    ├── csv_import.py           # 历史工单 CSV 导入
    └── opcua-mock-server.py    # Phase A 本地 OPC-UA 模拟服务器
```

---

## 二、数据库 Schema（PostgreSQL，完整定义）

```sql
-- ══════════════════════════════════════════════
-- 用户与身份认证
-- ══════════════════════════════════════════════

CREATE TABLE users (
    id              VARCHAR(20)  PRIMARY KEY,        -- USR-001，手动生成
    employee_id     VARCHAR(50)  UNIQUE NOT NULL,    -- 工号
    name            VARCHAR(100) NOT NULL,
    role            VARCHAR(20)  NOT NULL,           -- operator|supervisor|engineer|kb_admin|sys_admin
    station_ids     TEXT[]       NOT NULL DEFAULT '{}', -- ['S001','S002']
    password_hash   VARCHAR(200) NOT NULL,           -- bcrypt
    is_active       BOOLEAN      DEFAULT TRUE,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE user_feishu_bindings (
    user_id         VARCHAR(20)  REFERENCES users(id) ON DELETE CASCADE,
    feishu_open_id  VARCHAR(100) UNIQUE NOT NULL,
    bound_at        TIMESTAMPTZ  DEFAULT NOW(),
    is_active       BOOLEAN      DEFAULT TRUE,
    PRIMARY KEY (user_id, feishu_open_id)
);

CREATE INDEX idx_feishu_bindings_open_id ON user_feishu_bindings(feishu_open_id)
    WHERE is_active = TRUE;

-- ══════════════════════════════════════════════
-- 场站
-- ══════════════════════════════════════════════

CREATE TABLE stations (
    id                  VARCHAR(20)  PRIMARY KEY,        -- S001
    name                VARCHAR(200) NOT NULL,
    location            VARCHAR(200),
    timezone            VARCHAR(50)  DEFAULT 'Asia/Shanghai',
    feishu_duty_chat_id VARCHAR(100),                    -- 值班群 chat_id
    ims_adapter_type    VARCHAR(20)  DEFAULT 'mock',     -- mock|opcua|rest|csv
    ims_endpoint        VARCHAR(500),                    -- OPC-UA/SCADA 地址
    ims_username        VARCHAR(100),                    -- 服务账号用户名
    ims_password_enc    TEXT,                            -- AES-256-GCM 加密密码
    metadata            JSONB        DEFAULT '{}',
    is_active           BOOLEAN      DEFAULT TRUE,
    created_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- ══════════════════════════════════════════════
-- 设备（Equipment Ontology）
-- ══════════════════════════════════════════════

CREATE TABLE equipment (
    id              VARCHAR(50)  PRIMARY KEY,        -- C-001（全局唯一）
    station_id      VARCHAR(20)  REFERENCES stations(id),
    name            VARCHAR(200) NOT NULL,
    type            VARCHAR(50)  NOT NULL,           -- compressor|valve|separator|meter|...
    manufacturer    VARCHAR(100),
    model           VARCHAR(100),
    installed_at    DATE,
    thresholds      JSONB        NOT NULL DEFAULT '{}',
    -- 示例：{
    --   "outlet_pressure":  {"warn": 7.0, "alarm": 7.5, "unit": "MPa"},
    --   "shaft_vibration":  {"warn": 3.5, "alarm": 5.0, "unit": "mm/s"},
    --   "inlet_temperature":{"warn": 50,  "alarm": 60,  "unit": "°C"}
    -- }
    p_and_id_ref    VARCHAR(100),                   -- P&ID 图纸引用号
    metadata        JSONB        DEFAULT '{}',
    is_active       BOOLEAN      DEFAULT TRUE,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_equipment_station ON equipment(station_id) WHERE is_active = TRUE;

-- ══════════════════════════════════════════════
-- 工单（Work Order）
-- ══════════════════════════════════════════════

CREATE TABLE work_orders (
    id                      VARCHAR(50)  PRIMARY KEY,   -- WO-2026-001
    station_id              VARCHAR(20)  REFERENCES stations(id),
    equipment_id            VARCHAR(50)  REFERENCES equipment(id),
    work_type               VARCHAR(50)  NOT NULL,
    -- 【权威枚举，以 DESIGN-FINAL-LOCK.md §二a 为准】
    -- corrective | preventive | inspection | shutdown | emergency | calibration | improvement
    work_subtype            VARCHAR(100),  -- 细分类型（自由文本，如 bearing_replace / lubrication）
    symptom                 TEXT,
    suggested_steps         JSONB        NOT NULL DEFAULT '[]',
    -- [{"step": 1, "action": "停机降速", "safety_note": "确认停机信号"}, ...]
    -- 作业许可证预留字段（Phase A）
    permit_required         BOOLEAN      NOT NULL DEFAULT FALSE,
    permit_type             VARCHAR(50),  -- hot_work|cold_work|confined_space|electrical
    permit_number           VARCHAR(100), -- 许可证编号
    permit_status           VARCHAR(50),  -- pending|approved|active|closed
    -- 巡检字段（inspection 类型时使用）
    inspection_route        VARCHAR(200),
    checklist_items         JSONB,        -- [{item, required, method}]
    checklist_results       JSONB,        -- [{item, result, note, photo_url}]
    state                   VARCHAR(30)   NOT NULL DEFAULT 'draft',
    -- 【字段名统一为 state（非 status）】权威 FSM: draft → pending_approval → approved → in_progress → done/rejected
    risk_level              VARCHAR(10)  DEFAULT 'MEDIUM', -- LOW|MEDIUM|HIGH|CRITICAL
    confirm_emergency       BOOLEAN      DEFAULT FALSE,    -- 高风险操作必须 TRUE
    ai_confidence           FLOAT,                         -- 0.0-1.0
    citations               JSONB        DEFAULT '[]',
    created_by              VARCHAR(20)  REFERENCES users(id),
    approved_by             VARCHAR(20)  REFERENCES users(id),
    feishu_card_msg_id      VARCHAR(200),                  -- 飞书审批卡片消息 ID
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_workorders_station_status ON work_orders(station_id, status);
CREATE INDEX idx_workorders_equipment ON work_orders(equipment_id);

-- ══════════════════════════════════════════════
-- 审计日志（CRITICAL：只追加，禁止修改/删除）
-- ══════════════════════════════════════════════

CREATE TABLE audit_logs (
    id          BIGSERIAL    PRIMARY KEY,
    timestamp   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    action      VARCHAR(100) NOT NULL,
    -- 格式：domain.verb，如 equipment.read / workorder.approve / auth.deny
    user_id     VARCHAR(20),            -- NULL 表示系统操作
    resource    VARCHAR(200) NOT NULL,  -- 如 equipment:C-001 / workorder:WO-001
    station_id  VARCHAR(20),
    result      VARCHAR(20)  NOT NULL DEFAULT 'success', -- success|denied|error
    detail      JSONB        DEFAULT '{}'
);

-- 关键安全配置（在应用初始化脚本中执行）：
-- REVOKE UPDATE, DELETE ON audit_logs FROM clawtwin_app;
-- GRANT INSERT, SELECT ON audit_logs TO clawtwin_app;

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_logs(resource, timestamp DESC);

-- ══════════════════════════════════════════════
-- 时序数据（TimescaleDB Hypertable）
-- ══════════════════════════════════════════════

CREATE TABLE equipment_readings (
    time            TIMESTAMPTZ  NOT NULL,
    equipment_id    VARCHAR(50)  NOT NULL,
    metric          VARCHAR(100) NOT NULL,    -- outlet_pressure / shaft_vibration / ...
    value           FLOAT        NOT NULL,
    quality         VARCHAR(20)  DEFAULT 'GOOD',  -- GOOD|BAD|UNCERTAIN
    source          VARCHAR(50)  DEFAULT 'opcua'  -- opcua|manual|simulated
);

SELECT create_hypertable('equipment_readings', 'time');
CREATE INDEX ON equipment_readings(equipment_id, metric, time DESC);

-- 数据保留策略（TimescaleDB）
SELECT add_retention_policy('equipment_readings', INTERVAL '2 years');

-- ══════════════════════════════════════════════
-- 异常评分（MOIRAI 输出）
-- ══════════════════════════════════════════════

CREATE TABLE anomaly_scores (
    time            TIMESTAMPTZ  NOT NULL,
    equipment_id    VARCHAR(50)  NOT NULL,
    score           FLOAT        NOT NULL,  -- 0.0=正常, 1.0=高度异常
    level           VARCHAR(10),            -- NORMAL|WARNING|ALARM
    metrics_involved JSONB       DEFAULT '[]',
    model_version   VARCHAR(50)  DEFAULT 'moirai-2.0-large'
);

SELECT create_hypertable('anomaly_scores', 'time');

-- ══════════════════════════════════════════════
-- 知识文档元数据（向量 **pgvector** / `kb_chunks`；原文存储 Phase B 可 MinIO）
-- ══════════════════════════════════════════════

CREATE TABLE kb_documents (
    id              VARCHAR(50)  PRIMARY KEY,
    filename        VARCHAR(500) NOT NULL,
    title           VARCHAR(500),
    source          VARCHAR(200),          -- 标准号、文档来源、厂商
    layer           VARCHAR(5)   NOT NULL, -- L0|L1|L2
    equipment_type  VARCHAR(50),           -- NULL=所有设备类型
    station_id      VARCHAR(20),           -- NULL=L0/L1（通用），有值=L2（场站专属）
    minio_path      VARCHAR(500) NOT NULL, -- MinIO 对象路径
    milvus_coll     VARCHAR(100) DEFAULT 'industrial_kb',
    chunk_count     INTEGER,
    status          VARCHAR(20)  DEFAULT 'pending', -- pending|processing|indexed|failed
    error_msg       TEXT,
    indexed_at      TIMESTAMPTZ,
    uploaded_by     VARCHAR(20)  REFERENCES users(id),
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);
```

---

## 三、API 接口契约（完整定义）

### 3.1 健康检查

```
GET /v1/health

Response 200:
{
  "status": "ok",           // "ok" | "degraded" | "critical"
  "timestamp": "ISO8601",
  "mode": "normal",         // "normal" | "degraded"（vLLM 不可用）
  "services": {
    "postgres":   {"status": "up", "latency_ms": 2},
    "ditto":      {"status": "up", "latency_ms": 5},
    "milvus":     {"status": "up", "latency_ms": 12},
    "kafka":      {"status": "up", "lag": 0},
    "redis":      {"status": "up"},
    "vllm":       {"status": "up", "latency_ms": 120},   // "down" 时不影响整体 ok
    "opcua_feed": {"status": "up", "last_msg_ago_s": 3}
  }
}

逻辑：vLLM down → status="degraded"（仍返回 200，降级运行）
     postgres/ditto down → status="critical"（返回 503）
```

### 3.2 身份认证

```
POST /v1/auth/login
Request:  { "employee_id": "EMP001", "password": "xxx" }
Response: { "access_token": "jwt...", "token_type": "bearer", "expires_in": 28800 }
Error:    401 { "detail": "工号或密码错误" }

POST /v1/auth/bind-feishu
# 飞书绑定（需要已登录的 JWT + 飞书 open_id）
Request:  { "feishu_open_id": "ou_xxx" }  [Authorization: Bearer <jwt>]
Response: { "bound": true, "user_id": "USR-001" }

POST /v1/auth/refresh
Request:  { "refresh_token": "..." }
Response: { "access_token": "jwt...", "expires_in": 28800 }
```

### 3.3 Ontology API（设备/场站对象）

```
GET /v1/objects/equipment/{equipment_id}
# 鉴权：用户的 station_ids 必须包含该设备的 station_id
Response 200:
{
  "equipment_id": "C-001",
  "name": "天然气压缩机 #1",
  "type": "compressor",
  "station_id": "S001",
  "status": "WARNING",         // NORMAL|WARNING|ALARM|OFFLINE
  "current": {                 // 来自 Ditto（实时），无数据时为 null
    "outlet_pressure":   {"value": 6.8, "unit": "MPa", "updated_at": "ISO8601"},
    "shaft_vibration":   {"value": 4.2, "unit": "mm/s", "updated_at": "ISO8601"},
    "inlet_temperature": {"value": 45,  "unit": "°C",  "updated_at": "ISO8601"}
  },
  "thresholds": {
    "outlet_pressure":   {"warn": 7.0, "alarm": 7.5, "unit": "MPa"},
    "shaft_vibration":   {"warn": 3.5, "alarm": 5.0, "unit": "mm/s"}
  },
  "last_workorder": {          // 最近一条工单（可为 null）
    "id": "WO-2026-010",
    "status": "APPROVED",
    "work_type": "vibration_analysis",
    "created_at": "ISO8601"
  },
  "studio_url": "https://studio.clawtwin.local/#C-001",
  "citations": ["Ditto:C-001:2026-05-08T14:32:00Z"]
}

GET /v1/objects/station/{station_id}
# 返回场站聚合对象（设备列表 + KPI 汇总）
Response 200:
{
  "station_id": "S001",
  "name": "X 天然气压气站",
  "equipment_summary": {
    "total": 12, "normal": 9, "warning": 2, "alarm": 1, "offline": 0
  },
  "active_workorders": 3,
  "kpi": {
    "availability": 0.987,
    "mtbf_days": 45.2,
    "today_alarms": 2
  },
  "equipment": [...]   // 精简列表（只含 id/name/type/status）
}

GET /v1/objects/equipment/{equipment_id}/links
# 设备上下游关系（来自 GraphRAG）
Response 200:
{
  "equipment_id": "C-001",
  "upstream": [{"id": "SEP-001", "relation": "feeds_gas_to", "name": "分离器 #1"}],
  "downstream": [{"id": "SDV-001", "relation": "controlled_by", "name": "截断阀 #1"}],
  "shares_knowledge_with": ["C-002"]  // 同类设备
}
```

### 3.4 Tool API（供 OpenClaw Skills 调用）

**安全要求**：所有 Tool API 端点必须验证：

1. `X-OpenClaw-Service-Token` header 合法
2. `X-Feishu-OpenId` 对应有效绑定用户
3. 请求资源（equipment_id 等）在用户的 `station_ids` 范围内

```
POST /v1/tools/twin/read
Request:  { "equipment_id": "C-001" }
Response: 同 GET /v1/objects/equipment/{id}（含 citations）

POST /v1/tools/kb/search
Request:
{
  "query": "压缩机轴向振动高的常见原因",
  "equipment_type": "compressor",   // 可选，缩小范围
  "layer": null,                    // null=所有层，"L0"|"L1"|"L2"|"L3"
  "top_k": 5,
  "station_id": "S001"             // 用于限制 L2/L3 范围
}
Response:
{
  "results": [
    {
      "content": "轴向振动超过 4mm/s 通常由以下原因引起...",
      "source_doc": "GB/T 29168-2012 旋转机械振动",
      "section": "§4.3",
      "layer": "L1",
      "score": 0.92,
      "citation": "L1:GB-29168:§4.3"
    }
  ],
  "total": 5,
  "query_time_ms": 45
}

POST /v1/tools/workorder/draft
Request:
{
  "equipment_id": "C-001",
  "symptom": "轴向振动持续升高，已达 4.2 mm/s",
  "work_type": "vibration_analysis",   // 必须在白名单内
  "suggested_steps": [
    {"step": 1, "action": "停机检查", "safety_note": "确认停机信号后操作"},
    {"step": 2, "action": "拆解轴承盖，检查轴承状态"}
  ],
  "citations": ["L1:GB-29168:§4.3", "Ditto:C-001:2026-05-08T14:32:00Z"],
  "ai_confidence": 0.85,
  "confirm_emergency": false   // 高风险操作才需要 true
}
Response 201:
{
  "workorder_id": "WO-2026-047",
  "status": "DRAFT",
  "station_id": "S001",        // 服务端从 equipment 推导，不接受客户端传入
  "created_by": "USR-003",
  "message": "工单草稿已创建，等待主管审批"
}
Error 400: work_type 不在白名单
Error 400: 高风险操作未设置 confirm_emergency=true
Error 403: equipment 不在用户的 station_ids 范围内

POST /v1/tools/anomaly/trend
Request:
{
  "equipment_id": "C-001",
  "metric": "shaft_vibration",
  "period": "7d"   // 1h|6h|24h|7d|30d
}
Response:
{
  "equipment_id": "C-001",
  "metric": "shaft_vibration",
  "period": "7d",
  "statistics": {
    "mean": 3.2, "max": 4.2, "min": 2.8,
    "trend": "increasing",         // stable|increasing|decreasing
    "trend_rate": "+0.8/week"
  },
  "anomaly_score": 0.72,           // MOIRAI 评分（0=正常，1=高度异常）
  "anomaly_level": "WARNING",
  "data_points": 168,
  "citations": ["TimescaleDB:C-001:shaft_vibration:7d", "MOIRAI:2.0:C-001"]
}
```

### 3.5 飞书 Webhook

```
POST /v1/feishu/webhook
Headers:
  X-Lark-Request-Timestamp: <unix_ts>
  X-Lark-Request-Nonce: <random>
  X-Lark-Signature: <sha256_hex>

Request Body（飞书发来）：
  case 1 - URL 验证：{ "challenge": "xxx" }
  case 2 - 卡片回调：{
    "type": "card.action.trigger",
    "action": { "value": {"action": "approve"|"reject"|"ack", "wo_id": "WO-xxx"} },
    "operator": { "open_id": "ou_xxx" }
  }

Response（case 1）: { "challenge": "xxx" }
Response（case 2）: { "toast": { "type": "success"|"error"|"info", "content": "..." } }

处理逻辑：
  1. 验签（必须，VERIFY_TOKEN 不为空时）
  2. 防重放（时间戳 5 分钟窗口）
  3. 查 open_id → user_id → role + station_ids
  4. 验权（approve/reject 需要 supervisor 角色 + 本站权限）
  5. 执行状态变更（workorder_fsm.py）
  6. 写审计日志
  7. 返回 toast
```

### 3.6 HITL 工单管理

> ⚠️ **§3.6 已废弃（2026-05-09）**：状态值、字段名、端点路径均已更新。  
> **权威定义见**：§18.3（routers/hitl.py）、§18.6（API 唯一真相表）、§19.4（FSM 状态机）。  
> 以下内容仅作历史参考，开发时**不应**直接从此处复制代码。

```
GET /v1/workorders            ← §18.6 权威路径（非 /hitl/workorders）
Query: station_id, state=draft|pending_approval|..., limit, offset
Response: { "items": [...], "total": N }

GET /v1/hitl/workorders/{wo_id}
Response: 工单详情（wo_id/state 字段，值小写）

POST /v1/hitl/workorders/{wo_id}/pending   ← §18.6 权威路径（非 /submit）
# 操作员提交审批（draft → pending_approval，触发飞书审批卡片）
Auth: 必须是 workorder 的 created_by 用户
Response: { "state": "pending_approval", "feishu_card_sent": true }

POST /v1/hitl/workorders/{wo_id}/approve
# 主管审批通过（PENDING_APPROVAL → APPROVED）
# 来源：Studio 按钮 或 飞书 Webhook 回调（同一接口）
Auth: supervisor 或 sys_admin，本站权限
Body: { "comment": "同意，请下午安排执行"（可选）}
Response: { "status": "APPROVED" }

POST /v1/hitl/workorders/{wo_id}/reject
# 主管驳回（PENDING_APPROVAL → REJECTED，必须填原因）
Auth: supervisor 或 sys_admin，本站权限
Body: { "reason": "请先联系厂家确认备件型号" }（reason 必填）
Response: { "status": "REJECTED", "reason": "..." }

POST /v1/hitl/workorders/{wo_id}/cancel
# 撤销工单（DRAFT 或 APPROVED → CANCELLED）
Auth: created_by 用户 或 supervisor
Body: { "reason": "情况已处理，无需执行"（可选）}
Response: { "status": "CANCELLED" }

POST /v1/hitl/workorders/{wo_id}/start
# 操作员开始执行（APPROVED → IN_PROGRESS）
Auth: operator 或 supervisor，本站权限
Response: { "status": "IN_PROGRESS" }

POST /v1/hitl/workorders/{wo_id}/done
# 操作员标记完成（IN_PROGRESS → DONE），触发 L3 知识写入
Auth: operator 或 supervisor，本站权限
Body: { "actual_action": "更换了 6203 轴承，润滑后振动恢复正常"（可选，记录实际操作）}
Response: { "status": "DONE", "l3_written": true }
```

**飞书 Webhook 与 API 的对应**：

```
飞书卡片按钮 "通过" → POST /v1/feishu/webhook（type=approve）
  → Platform 内部调用 transition(wo_id, "APPROVED", feishu_user)

飞书卡片按钮 "拒绝" → POST /v1/feishu/webhook（type=reject）
  → Platform 内部调用 transition(wo_id, "REJECTED", feishu_user)
  （reason 从飞书卡片输入框获取）
```

**OA/BPM 外部系统回调**：

```
POST /v1/hitl/workorders/{wo_id}/oa-callback
# 外部 OA/BPM 系统审批完成后调用（如甲方已有 OA 系统）
Auth: Bearer <PLATFORM_OA_SERVICE_TOKEN>（需提前在 Admin 创建 service token）
Body:
{
  "action": "approved" | "rejected",
  "approver": "张三（OA 系统用户名）",
  "comment": "同意，注意作业安全",
  "oa_task_id": "OA-2026-00123"   // OA 系统的任务 ID，用于追溯
}

Response 200:
{
  "wo_status": "APPROVED" | "REJECTED",
  "l3_written": false,             // 仅 DONE 才写 L3
  "audit_id": "AUD-456"
}

注意：Platform 收到 OA 回调后：
  1. 验证 service token 有效性（PLATFORM_OA_SERVICE_TOKEN）
  2. 更新工单状态（approved → APPROVED，rejected → REJECTED）
  3. 向执行人飞书推送"工单已审批，请执行"卡片
  4. 写审计日志（审批人、时间、OA任务ID）
  不由 Platform 直接执行任何设备操作
```

**HiAgent 接入的 Service Token 约定**：

```
POST /v1/admin/service-tokens
# 创建 HiAgent 专属 service token（Admin 权限）
Body:
{
  "name": "HiAgent-Production",
  "scopes": ["tool_api_call", "workorder_draft"],  // 限制可用工具集
  "station_ids": ["S001", "S002"],                  // 限制可访问场站
  "expires_at": null                                 // null = 永不过期，推荐
}
Response:
{
  "token_id": "st_abc123",
  "token": "sk-oc-...",            // 只显示一次，请立即保存
  "name": "HiAgent-Production"
}

HiAgent 调用 Tool API 时：
  Authorization: Bearer sk-oc-...
  X-Station-ID: S001              // HiAgent 必须传入场站 ID，Platform 校验权限
```

### 3.7 知识摄入

```
POST /v1/ingest/document
# 上传文档（multipart/form-data）
Auth: kb_admin 或 sys_admin
Form fields:
  file: <PDF binary>
  layer: L0|L1|L2
  equipment_type: compressor|valve|...（可选）
  station_id: S001（L2 必须填）
  title: 文档标题（可选，为空时从文件名推断）
  source: 标准编号或来源（如 GB/T 29168-2012）

Response 202:
{
  "doc_id": "DOC-001",
  "status": "pending",
  "message": "文档已接收，正在处理..."
}

GET /v1/ingest/documents
Query: layer, station_id, status, limit, offset
Response: 文档列表 + 状态

GET /v1/ingest/documents/{doc_id}/status
Response: { "doc_id": "DOC-001", "status": "indexed", "chunk_count": 45, "indexed_at": "..." }

POST /v1/ingest/graphrag/rebuild
Auth: kb_admin 或 sys_admin
Response: { "job_id": "GR-001", "message": "GraphRAG 重建任务已提交" }
```

### 3.8 Admin API

```
# 用户管理（sys_admin only）
GET    /v1/admin/users              → 用户列表（含飞书绑定状态）
POST   /v1/admin/users              → 创建用户（工号/姓名/初始密码/角色/场站）
PUT    /v1/admin/users/{user_id}    → 更新角色/场站权限
DELETE /v1/admin/users/{user_id}    → 停用用户（不物理删除）

POST   /v1/admin/users/{user_id}/bind-invite
  Auth: sys_admin
  功能：生成 15 分钟有效的飞书绑定 Token，通过飞书 Bot 私信发给目标用户
  Response: { "bind_url": "https://studio.clawtwin.local/bind?token=xxx", "expires_in": 900 }

  实现：
    1. 生成随机 bind_token（UUID v4），写 Redis Key: bind:{token} = user_id，TTL=900s
    2. 通过 feishu.py 向 user.feishu_open_id 发私信（如已知），或向 admin 发送邀请链接
    3. 绑定完成后删除 Redis key（一次性令牌）

POST   /v1/admin/feishu-bind
  Body: { "bind_token": "xxx", "feishu_open_id": "ou_yyy", "employee_id": "E001", "password": "***" }
  Auth: 无（公开端点，但 bind_token 是一次性且短效令牌，防止滥用）
  功能：验证 bind_token 有效（Redis TTL）+ 验证工号密码 → 写 user_feishu_bindings → 删除 token
  Response: { "success": true, "user_name": "张三" }（不返回 JWT，绑定后用飞书正常对话）

  Rate limit: 5次/IP/分钟（nginx 配置）
  ⚠️ bind_token 与 feishu_open_id 必须一一对应（Redis key: bind:{token} = {user_id, feishu_open_id}）

# OpenClaw Service Token 管理（sys_admin only）
GET    /v1/admin/service-tokens       → 列出所有 service token（脱敏显示，仅前8位）
POST   /v1/admin/service-tokens       → 创建新 service token
  Body: { "description": "OpenClaw 场站S001 实例", "station_ids": ["S001"] }
  Response: { "token_id": "ST-001", "token": "oc-svc-xxxx", "created_at": "..." }
  ⚠️ token 明文仅在创建时返回一次，后续无法获取原文
DELETE /v1/admin/service-tokens/{token_id} → 吊销 token（立即生效）
  功能：删除 DB 记录，OpenClaw 下次请求时 401

  实现要点：
    - token 存储格式：DB 存 SHA-256(token)，不存明文
    - 验证逻辑：middleware 计算请求头 token 的 SHA-256，与 DB 比对
    - token 格式：`oc-svc-` 前缀 + 32 字符随机串（方便识别类型）

# 设备管理（sys_admin only）
GET    /v1/admin/equipment           → 设备列表（含阈值配置）
POST   /v1/admin/equipment           → 新增设备（equipment_id/类型/场站/阈值）
PUT    /v1/admin/equipment/{eq_id}   → 更新阈值/描述/OPC-UA NodeId 映射
DELETE /v1/admin/equipment/{eq_id}   → 停用设备

# 场站管理（sys_admin only）
GET    /v1/admin/stations            → 场站列表
POST   /v1/admin/stations            → 新增场站
PUT    /v1/admin/stations/{st_id}    → 更新 IMS 配置（feishu_duty_chat_id 等）

# 系统健康（sys_admin / engineer）
GET    /v1/admin/system/health       → 详细健康状态（所有依赖服务 ping 结果）
GET    /v1/admin/system/audit-logs   → 审计日志查询（by actor/action/station/时间范围）
GET    /v1/admin/system/audit-logs/export  → 导出 CSV（合规审计用）
```

---

## 四、关键服务实现要点

### 4.1 config.py（Pydantic Settings，所有配置在此）

> ⚠️ **注意**：完整权威的 `Settings` 定义见 **§七.1**（包含所有字段、注释和 `studio_url`、`jwt_algorithm` 等）。
> 以下为核心字段速查表，供代码审查用；开发请以 §七.1 为准，不要维护两份。

| 分组   | 关键字段                              | 默认值                          | 说明                              |
| ------ | ------------------------------------- | ------------------------------- | --------------------------------- |
| 模式   | `mock_mode`                           | `true`                          | Phase A=true，关闭真实外部服务    |
| 数据库 | `database_url`                        | asyncpg PostgreSQL              | TimescaleDB 主库                  |
| 飞书   | `feishu_app_id` / `feishu_app_secret` | `""`                            | 留空则飞书功能禁用                |
| JWT    | `jwt_secret_key`                      | **必须更换**                    | HS256，生产最少 32 字符随机字符串 |
| 安全   | `openclaw_service_token`              | **必须更换**                    | OpenClaw 调用 Tool API 的服务令牌 |
| 场站   | `default_station_id`                  | `STATION-CNG-001`               | 默认场站 ID                       |
| 前端   | `studio_url`                          | `https://studio.clawtwin.local` | 告警卡片跳转 URL                  |

### 4.2 depends.py（FastAPI 依赖，鉴权核心）

```python
from fastapi import HTTPException, Header, Depends
from auth.jwt_verify import verify_jwt          # auth/jwt_verify.py
from auth.feishu_bind import lookup_user_by_open_id
from models.user import CurrentUser

OPENCLAW_SERVICE_TOKEN = settings.openclaw_service_token

async def get_current_user(
    authorization: str | None = Header(None),
    x_openclaw_service_token: str | None = Header(None),
    x_feishu_open_id: str | None = Header(None),
) -> CurrentUser:
    """
    统一鉴权依赖。支持两种认证模式：

    模式 A：Studio Web 登录（JWT）
      Authorization: Bearer <jwt>

    模式 B：OpenClaw Tool API 调用
      X-OpenClaw-Service-Token: <service_token>
      X-Feishu-OpenId: <open_id>
    """
    # 模式 A：JWT
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        payload = verify_jwt(token)
        return CurrentUser(**payload)

    # 模式 B：OpenClaw Service Token + Feishu Open ID
    if x_openclaw_service_token and x_feishu_open_id:
        if x_openclaw_service_token != OPENCLAW_SERVICE_TOKEN:
            raise HTTPException(401, "无效的 OpenClaw Service Token")
        user = await lookup_user_by_open_id(x_feishu_open_id)
        if not user:
            raise HTTPException(403, "该飞书账号未绑定 ClawTwin 用户，请联系管理员")
        return user

    raise HTTPException(401, "需要身份认证")

def require_station(station_id: str, user: CurrentUser = Depends(get_current_user)):
    """验证用户有权访问指定场站（Prompt 注入防护的核心）"""
    if station_id not in user.station_ids and user.role != "sys_admin":
        raise HTTPException(403, f"无权访问场站 {station_id}")
    return user

def require_role(*roles: str):
    """验证用户角色（可作为 Depends 参数或装饰器使用）"""
    def checker(user: CurrentUser = Depends(get_current_user)):
        if user.role not in roles:
            raise HTTPException(403, f"操作需要 {roles} 角色")
        return user
    return checker
```

### 4.3 workorder_fsm.py（工单状态机）

```python
"""
工单状态机：DRAFT → PENDING_APPROVAL → APPROVED → IN_PROGRESS → DONE
                                     ↘ CANCELLED（任意阶段）

规则：
  · DRAFT：只有 created_by 可以编辑和提交
  · PENDING_APPROVAL：只有 supervisor（本站）可以审批或拒绝
  · APPROVED：分配给操作员执行，操作员标记 IN_PROGRESS
  · DONE：自动触发 L3 知识写入（data flywheel）
  · REJECTED：主管驳回（PENDING_APPROVAL → REJECTED，需填 reason）
  · CANCELLED：创建者或操作员主动撤销（DRAFT/APPROVED → CANCELLED）
"""

# ⚠️ 以下 VALID_TRANSITIONS 已废弃（大写值、含 CANCELLED）
# 权威版在 §19.4（services/workorder_fsm.py，WorkOrderState 枚举，无 CANCELLED 状态）
# draft → pending_approval → approved → in_progress → done
#                         ↘ draft（rejected 退回修改）
VALID_TRANSITIONS = {
    "draft":            ["pending_approval"],
    "pending_approval": ["approved",          "rejected"],
    "rejected":         ["pending_approval"],   # 修改后可重新提交
    "approved":         ["in_progress"],
    "in_progress":      ["done"],
    "done":             [],
}

# ── REJECTED 和 CANCELLED 的语义区别 ─────────────────────────
# REJECTED：主管在 PENDING_APPROVAL 阶段审核后明确拒绝，必须填 reason
#            意义：此工单不应执行，需要重新起草
# CANCELLED：操作员/AI 在 DRAFT/APPROVED 阶段撤销
#            意义：情况变化，无需执行
#
# API 端点：
#   POST /v1/hitl/workorders/{id}/reject   → PENDING_APPROVAL → REJECTED
#   POST /v1/hitl/workorders/{id}/cancel   → DRAFT/APPROVED → CANCELLED
#   （飞书卡片"通过"→ approve，"拒绝"→ reject）

async def transition(wo_id: str, new_state: str, user: CurrentUser, db) -> WorkOrder:
    # 权威 FSM 在 §19.4（services/workorder_fsm.py）；此处是精简示意
    wo = await db.get(WorkOrder, wo_id)
    if new_state not in VALID_TRANSITIONS.get(wo.state, []):
        raise ValueError(f"工单 {wo_id} 不能从 {wo.state} 转换到 {new_state}")

    # 权限验证（state 值全小写）
    if new_state == "approved" and user.role not in ("supervisor", "sys_admin"):
        raise PermissionError("只有主管可以审批工单")
    if wo.station_id not in user.station_ids:
        raise PermissionError("无权操作其他场站的工单")

    wo.state = new_state           # ← 字段名 state
    wo.updated_at = datetime.now(UTC)
    if new_state == "approved":
        wo.approved_by = user.user_id
        wo.approved_at = datetime.now(UTC)

    await db.commit()
    await audit_log(action=f"workorder.{new_state}", ...)

    # 完成后写 L3 知识（数据飞轮）
    if new_state == "done":
        await write_l3_knowledge(wo)

    return wo
```

---

## 五、错误处理规范

```python
# 统一错误格式（所有 API 都遵循）
{
  "detail": "人类可读的错误描述（中文）",
  "code": "ERROR_CODE",          # 可选，机器可读的错误代码
  "field": "equipment_id"        # 可选，哪个字段有问题
}

# HTTP 状态码约定：
200  → 成功
201  → 创建成功（POST 新建资源）
202  → 已接受异步处理（如文档摄入）
400  → 参数错误（白名单校验失败、格式错误）
401  → 未认证（没有 token 或 token 无效）
403  → 已认证但无权限（ABAC 拒绝）
404  → 资源不存在
409  → 状态冲突（工单状态机非法转换）
422  → Pydantic 校验失败（FastAPI 默认）
500  → 服务内部错误
503  → 依赖服务不可用（postgres/ditto down）
```

---

## 六、config.py 完整配置（Pydantic Settings）

```python
# platform-api/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ── 模式开关 ─────────────────────────────────────────────
    mock_mode: bool = True         # True = 使用 mock 数据，不连真实外部服务
    fallback_mode: bool = False    # True = 外部服务不可用时降级（告警不发飞书等）

    # ── 数据库 ──────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://clawtwin:clawtwin@localhost:5432/clawtwin"
    redis_url: str = "redis://localhost:6379"

    # ── pgvector / 可选 Milvus（**Phase A** 只用 **PostgreSQL pgvector**；以下 milvus_* 为 **Phase C** 备选）──
    milvus_host: str = "localhost"
    milvus_port: int = 19530
    milvus_collection: str = "industrial_kb"

    # ── MinIO ───────────────────────────────────────────────
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin123"
    minio_bucket: str = "clawtwin"
    minio_secure: bool = False     # 生产环境设 True（HTTPS）

    # ── Kafka ───────────────────────────────────────────────
    kafka_brokers: str = "localhost:9092"
    kafka_topic_realtime: str = "opcua.realtime"
    kafka_topic_events: str = "opcua.events"
    kafka_consumer_group: str = "platform-reader"

    # ── Eclipse Ditto（Phase B）────────────────────────────
    ditto_url: str = "http://localhost:8081"
    ditto_username: str = "ditto"
    ditto_password: str = "ditto"

    # ── vLLM / LLM 推理 ─────────────────────────────────────
    vllm_base_url: str = "http://localhost:8000"
    vllm_model: str = "Qwen/Qwen3-235B-A22B"          # GPU 服务器上加载的模型
    vllm_embed_url: str = "http://localhost:8001"      # 独立 embedding 服务
    vllm_embed_model: str = "BAAI/bge-m3"
    vllm_embed_dim: int = 1024                         # bge-m3 维度（不是 1536）

    # ── MOIRAI 时序模型 ──────────────────────────────────────
    moirai_url: str = ""           # 空 = 本地 CPU 推理（Phase A）
    moirai_model: str = "Salesforce/moirai-1.1-R-large"

    # ── GraphRAG ────────────────────────────────────────────
    graphrag_index_path: str = ""  # 空 = 未建索引（Phase A 跳过 GraphRAG 层）
    graphrag_rebuild_auto: bool = False  # 定期自动重建

    # ── L3 知识层（Platform 自有，**PostgreSQL + pgvector**；铁律 20）──
    # L3 = 已验证工单经验，按 station_id 隔离，layer='L3' 区分
    # ⚠️ 不使用 OpenClaw memory-wiki（那是 CLI 工具，不是 REST API）
    l3_auto_ingest: bool = True    # 工单 DONE 后自动写入 L3（异步后台任务）

    # ── 飞书 Bot ─────────────────────────────────────────────
    feishu_app_id: str = ""           # 飞书 Bot App ID（同时用于发消息和 Webhook）
    feishu_app_secret: str = ""       # 飞书 Bot App Secret
    feishu_server_url: str = ""       # 私有部署飞书地址（如 https://open.feishu.xxx.com）
                                      # 留空 = 使用标准飞书 open.feishu.cn（两种模式相同字段）
    feishu_duty_chat_id: str = ""     # 值班群 chat_id（工单审批通知）
    feishu_verify_token: str = ""     # Webhook 验签 Token（生产必须设置）
    feishu_encrypt_key: str = ""      # Webhook 加密 Key（可选，私有部署时建议开启）

    # ── 安全 / JWT ──────────────────────────────────────────
    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_algorithm: str = "HS256"   # Phase A；Phase B 改 RS256（需配 key pair）
    jwt_expire_hours: int = 8

    openclaw_service_token: str = "oc-service-token-change-in-prod"
    # OpenClaw 实例调用 Platform Tool API 时携带的 Service Token
    # ⚠️ 生产环境必须更换，不可用默认值

    # ── 场站基础配置 ─────────────────────────────────────────
    default_station_id: str = "STATION-CNG-001"
    mock_data_dir: str = "./data/mock"

    # Studio 前端地址（Feishu 告警卡片跳转、日志链接用）
    studio_url: str = "https://studio.clawtwin.local"

    # ── Scheduler ───────────────────────────────────────────
    morning_briefing_hour: int = 6     # 晨报发送时间（时）
    anomaly_poll_minute: int = 5       # 异常轮询（每小时第 N 分钟）
    timezone: str = "Asia/Shanghai"

@lru_cache
def get_settings() -> Settings:
    return Settings()

# 全局单例（大多数模块 `from config import settings` 使用此）
settings = get_settings()

settings = get_settings()
```

**对应的 `.env.example`（最终完整版）**：

```bash
# ── 模式 ──────────────────────────────────────────────
MOCK_MODE=true
FALLBACK_MODE=false

# ── 数据库 ────────────────────────────────────────────
DATABASE_URL=postgresql+asyncpg://clawtwin:clawtwin@postgres:5432/clawtwin
REDIS_URL=redis://redis:6379
POSTGRES_PASSWORD=clawtwin

# ── 向量库/文档存储 ──────────────────────────────────
MILVUS_HOST=milvus
MILVUS_PORT=19530
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123

# ── LLM（GPU 服务器）──────────────────────────────────
VLLM_BASE_URL=http://gpu-server:8000
VLLM_MODEL=Qwen/Qwen3-235B-A22B
VLLM_EMBED_URL=http://gpu-server:8001
VLLM_EMBED_MODEL=BAAI/bge-m3
# Phase A 本地开发：留空，使用 fastembed CPU 推理

# ── 飞书 Bot ──────────────────────────────────────────
FEISHU_SERVER_URL=                   # 留空=公有云飞书；私有化填内网地址（对应 settings.feishu_server_url）
FEISHU_APP_ID=                       # 飞书 Bot App ID（对应 settings.feishu_app_id）
FEISHU_APP_SECRET=                   # 飞书 Bot App Secret（对应 settings.feishu_app_secret）
FEISHU_DUTY_CHAT_ID=                 # 值班群 chat_id（对应 settings.feishu_duty_chat_id）
FEISHU_VERIFY_TOKEN=                 # Webhook 验签 Token，生产必须设置！
FEISHU_ENCRYPT_KEY=                  # Webhook 加密 Key，生产建议设置！

# ── 安全 ──────────────────────────────────────────────
JWT_SECRET_KEY=dev-secret-change-in-production
OPENCLAW_SERVICE_TOKEN=oc-service-token-change-in-prod

# ── L3 知识层（Platform 自有，自动写入 PostgreSQL **+ pgvector**）──
# 无需额外配置，工单 DONE 后自动摄入
L3_AUTO_INGEST=true
# ⚠️ OpenClaw memory-wiki 是 CLI 工具，不提供 REST API，不用于 L3

# ── GraphRAG（Phase B 才需要）────────────────────────
GRAPHRAG_INDEX_PATH=

# ── Scheduler ─────────────────────────────────────────
MORNING_BRIEFING_HOUR=6
TIMEZONE=Asia/Shanghai
```

---

## 六B、测试策略

```
每个 router 必须有对应的 test 文件：
  routers/tests/test_objects.py
  routers/tests/test_tools.py
  routers/tests/test_hitl.py
  routers/tests/test_feishu_webhook.py

必须覆盖的测试场景：

安全类（每个 API 端点）：
  ✓ 无 token → 401
  ✓ 错误 token → 401
  ✓ 正确 token，越权访问其他站设备 → 403
  ✓ operator 角色审批工单 → 403
  ✓ Webhook 无签名 → 403（verify_token 配置时）
  ✓ Webhook 重放攻击（旧时间戳）→ 400

功能类：
  ✓ 工单状态机正常流程（DRAFT → ... → DONE）
  ✓ 工单非法状态转换 → 409
  ✓ 知识检索返回 citations
  ✓ tool/twin/read 返回实时数据（mock Ditto）
  ✓ 审计日志在关键操作后写入

Mock 策略：
  使用 httpx.MockTransport 或 respx mock 外部服务
  不 mock PostgreSQL（使用测试数据库，pytest-asyncio + SQLAlchemy）
  mock: Ditto / **pgvector（或 embed 服务）** / vLLM / Feishu API
```

---

## 七、main.py 完整实现

```python
# platform-api/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from config import settings
from db.session import engine, Base
from scheduler.jobs import start_scheduler, stop_scheduler

# ── 路由导入 ──────────────────────────────────────────────
from routers.health          import router as health_router
from routers.auth            import router as auth_router
from routers.objects         import router as objects_router
from routers.tools           import router as tools_router
from routers.analytics       import router as analytics_router
from routers.ingest          import router as ingest_router
from routers.hitl            import router as hitl_router
from routers.feishu_webhook  import router as feishu_webhook_router
from routers.admin           import router as admin_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动和关闭时执行的生命周期钩子"""
    # 启动
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)  # 确保表已创建

    scheduler = await start_scheduler()   # APScheduler
    print(f"[startup] Platform API ready (mock_mode={settings.mock_mode})")

    yield  # ← 应用运行期间

    # 关闭
    await stop_scheduler(scheduler)
    await engine.dispose()
    print("[shutdown] Platform API stopped")

app = FastAPI(
    title="ClawTwin Platform API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.mock_mode else None,  # 生产环境关闭 Swagger
)

# ── 中间件 ─────────────────────────────────────────────────
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.mock_mode else ["https://studio.clawtwin.local"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 路由注册（唯一权威版，§17 端点已整合）─────────────────
app.include_router(health_router)                          # GET  /v1/health
app.include_router(auth_router,          prefix="/v1/auth")    # POST /v1/auth/login|refresh
app.include_router(equipment_router,     prefix="/v1/equipment")  # GET /v1/equipment/{id} | /realtime | /health-score | /spectrum
app.include_router(stations_router,      prefix="/v1/stations")   # GET /v1/stations/{id}/health-summary | /equipment
app.include_router(workorders_router,    prefix="/v1/workorders")  # POST /v1/workorders/ | /ai-draft ; GET /v1/workorders
app.include_router(hitl_router,          prefix="/v1/hitl")    # POST /v1/hitl/workorders/{id}/pending|approve|reject|done
app.include_router(alarms_router,        prefix="/v1/alarms")  # GET /active | /stats ; POST /{id}/acknowledge|shelve
app.include_router(shifts_router,        prefix="/v1/shifts")  # POST /v1/shifts/handover
app.include_router(tools_router,         prefix="/v1/tools")   # POST /v1/tools/diagnose_equipment|ask_knowledge|analyze_trend
app.include_router(analytics_router,     prefix="/v1/analytics") # GET /v1/analytics/*
app.include_router(search_router,        prefix="/v1/search")  # GET /v1/search?q=
app.include_router(kb_router,            prefix="/v1/kb")      # POST /v1/kb/upload|search
app.include_router(graph_router,         prefix="/v1/graph")   # POST /v1/graph/query ; GET /causal-chain/{id}
app.include_router(visual_router,        prefix="/v1/visual")  # POST /v1/visual/inspect ; GET /history/{id}
app.include_router(energy_router,        prefix="/v1/energy")  # GET /v1/energy/kpi|trend/{station_id}
app.include_router(notifications_router, prefix="/v1/notifications")  # POST /v1/notifications/notify-operator
app.include_router(data_router,          prefix="/v1/data")    # GET /v1/data/history/{id}
app.include_router(ingest_router,        prefix="/v1/ingest")  # POST /v1/ingest/*（知识摄入）
app.include_router(feishu_webhook_router)                      # POST /v1/feishu/events
app.include_router(admin_router,         prefix="/v1/admin")   # /v1/admin/*（用户/token/质量管理）
```

**所有路由模块 import 语句（main.py 顶部）**：

```python
from routers.health          import router as health_router
from routers.auth            import router as auth_router
from routers.objects         import router as objects_router
from routers.tools           import router as tools_router
from routers.analytics       import router as analytics_router
from routers.data            import router as data_router        # 原始时序数据
from routers.ingest          import router as ingest_router
from routers.hitl            import router as hitl_router
from routers.feishu_webhook  import router as feishu_webhook_router
from routers.admin           import router as admin_router
```

---

## 八、知识摄入 Pipeline（kb/ingest_pipeline.py）

> **注意**：使用 LlamaIndex 替代自研 chunker + 向量存储逻辑。  
> 向量存储：pgvector（PostgreSQL 扩展），不再使用 Milvus。  
> 依赖：`llama-index-core` + `llama-index-vector-stores-postgres` + `llama-index-embeddings-huggingface` + `pymupdf`

```python
# platform-api/kb/ingest_pipeline.py
"""
文档摄入流程：PDF/TXT → 文本提取 → LlamaIndex SentenceSplitter → bge-m3 Embedding → pgvector
使用 LlamaIndex 替代自研 chunker，语义分块质量更高。
"""
from pathlib import Path
from datetime import datetime, UTC

import pymupdf                                                     # pip install pymupdf
from llama_index.core import VectorStoreIndex, Document
from llama_index.core.node_parser import SentenceSplitter
from llama_index.vector_stores.postgres import PGVectorStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding

from config import settings

# ── 全局单例（应用启动时初始化）────────────────────────────────
def build_vector_store() -> PGVectorStore:
    """连接 pgvector，表名 kb_embeddings（由 Alembic migration 创建）"""
    return PGVectorStore.from_params(
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
        user=settings.db_user,
        password=settings.db_password,
        table_name="kb_embeddings",
        embed_dim=1024,              # bge-m3 输出维度
    )

def build_embed_model() -> HuggingFaceEmbedding:
    """
    Phase A 本地：直接加载 bge-m3（如果机器有 GPU 或使用 CPU 推理）
    Phase B+：可切换为 vLLM Embedding API（OpenAI 兼容格式）
    """
    return HuggingFaceEmbedding(
        model_name="BAAI/bge-m3",
        embed_batch_size=32,
        device="cpu",               # Phase A：CPU；Phase B：cuda
    )

_vector_store: PGVectorStore | None = None
_embed_model: HuggingFaceEmbedding | None = None
_splitter = SentenceSplitter(chunk_size=512, chunk_overlap=64)

def get_vector_store() -> PGVectorStore:
    global _vector_store
    if _vector_store is None:
        _vector_store = build_vector_store()
    return _vector_store

def get_embed_model() -> HuggingFaceEmbedding:
    global _embed_model
    if _embed_model is None:
        _embed_model = build_embed_model()
    return _embed_model

# ── 文本提取（支持 PDF / TXT / MD）──────────────────────────
async def extract_text(file_bytes: bytes, filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        doc = pymupdf.open(stream=file_bytes, filetype="pdf")
        return "\n\n".join(page.get_text() for page in doc)
    elif suffix in (".txt", ".md"):
        return file_bytes.decode("utf-8", errors="replace")
    else:
        raise ValueError(f"不支持的文件格式: {suffix}")

# ── 主 Pipeline ──────────────────────────────────────────────
async def ingest_document(
    doc_id: str,
    file_bytes: bytes,
    filename: str,
    layer: str,             # L0 | L1 | L2 | L3
    equipment_type: str | None,
    station_id: str | None,
    title: str,
    source: str,
    db,                     # AsyncSession（用于更新 kb_documents 状态）
):
    """
    完整摄入流程，状态更新写 kb_documents 表。
    调用方：routers/ingest.py 的后台任务（asyncio.create_task）

    核心步骤：
      1. 提取文本（pymupdf）
      2. LlamaIndex SentenceSplitter 分块（尊重中文句子边界）
      3. bge-m3 批量 Embedding
      4. 写入 pgvector（kb_embeddings 表）
      5. 更新 kb_documents 状态
    """
    from models.knowledge import KBDocument
    kb_doc = await db.get(KBDocument, doc_id)

    try:
        kb_doc.status = "processing"
        await db.commit()

        # Step 1: 提取文本
        text = await extract_text(file_bytes, filename)

        # Step 2-4: LlamaIndex 分块 + Embedding + pgvector 写入（三合一）
        lla_doc = Document(
            text=text,
            metadata={
                "doc_id":         doc_id,
                "layer":          layer,
                "equipment_type": equipment_type or "general",
                "station_id":     station_id or "global",
                "title":          title,
                "source":         source,
                "filename":       filename,
            },
        )

        index = VectorStoreIndex.from_documents(
            [lla_doc],
            vector_store=get_vector_store(),
            embed_model=get_embed_model(),
            transformations=[_splitter],
            show_progress=False,
        )

        # 统计 chunk 数
        kb_doc.chunk_count = len(_splitter.get_nodes_from_documents([lla_doc]))
        kb_doc.status = "indexed"
        kb_doc.indexed_at = datetime.now(UTC)
        await db.commit()

    except Exception as e:
        kb_doc.status = "failed"
        kb_doc.error_msg = str(e)[:500]
        await db.commit()
        raise

# ── 语义检索 ────────────────────────────────────────────────
async def search_knowledge(
    query: str,
    layer: str | None = None,
    equipment_type: str | None = None,
    station_id: str | None = None,
    top_k: int = 5,
) -> list[dict]:
    """
    语义检索知识库，支持按 layer / equipment_type / station_id 过滤。
    调用方：MCP Tool `search_knowledge_base`
    """
    from llama_index.core.vector_stores import MetadataFilter, MetadataFilters, FilterCondition

    filters_list = []
    if layer:
        filters_list.append(MetadataFilter(key="layer", value=layer))
    if equipment_type:
        filters_list.append(MetadataFilter(key="equipment_type", value=equipment_type))
    if station_id:
        filters_list.append(MetadataFilter(key="station_id", value=station_id))

    meta_filters = MetadataFilters(filters=filters_list, condition=FilterCondition.AND) if filters_list else None

    index = VectorStoreIndex.from_vector_store(
        vector_store=get_vector_store(),
        embed_model=get_embed_model(),
    )
    retriever = index.as_retriever(
        similarity_top_k=top_k,
        filters=meta_filters,
    )

    nodes = retriever.retrieve(query)
    return [
        {
            "content":        n.text,
            "score":          round(n.score or 0.0, 4),
            "doc_id":         n.metadata.get("doc_id"),
            "layer":          n.metadata.get("layer"),
            "equipment_type": n.metadata.get("equipment_type"),
            "title":          n.metadata.get("title"),
            "source":         n.metadata.get("source"),
        }
        for n in nodes
    ]
```

**新增到 requirements.txt：**

```
# RAG 框架（替代自研 chunker + 向量存储逻辑）
llama-index-core>=0.11
llama-index-vector-stores-postgres>=0.2
llama-index-embeddings-huggingface>=0.3
pymupdf>=1.24         # PDF 文本提取（已有，保留）

# 移除：pymilvus（pgvector 替代）
```

---

## 九、Scheduler 定时任务实现

```python
# platform-api/scheduler/jobs.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

async def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")

    # 每日 06:00 晨报
    scheduler.add_job(
        morning_briefing_job,
        CronTrigger(hour=6, minute=0),
        id="morning_briefing",
        replace_existing=True,
    )
    # 每小时 :05 分异常轮询（避开整点高峰）
    scheduler.add_job(
        anomaly_poll_job,
        CronTrigger(minute=5),
        id="anomaly_poll",
        replace_existing=True,
    )
    # 每日 02:00 自动备份验证
    scheduler.add_job(
        backup_health_check_job,
        CronTrigger(hour=2, minute=0),
        id="backup_health_check",
        replace_existing=True,
    )
    scheduler.start()
    return scheduler

async def stop_scheduler(scheduler: AsyncIOScheduler):
    scheduler.shutdown(wait=False)

# ── 晨报任务 ─────────────────────────────────────────────────
# platform-api/scheduler/morning_briefing.py

async def morning_briefing_job():
    """每日 06:00：生成昨日 KPI 汇总 + 发飞书晨报卡片到各值班群"""
    from services.feishu import FeishuClient
    from db.session import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        stations = await get_active_stations(db)

    for station in stations:
        kpi = await compute_yesterday_kpi(station.id)
        card = build_morning_briefing_card(station, kpi)
        await FeishuClient.send_card_to_chat(station.feishu_duty_chat_id, card)

def build_morning_briefing_card(station, kpi: dict) -> dict:
    """构建飞书交互卡片（晨报格式）"""
    status_emoji = "🟢" if kpi["alarm_count"] == 0 else "🔴"
    return {
        "msg_type": "interactive",
        "card": {
            "header": {"title": {"content": f"{status_emoji} {station.name} 日报", "tag": "plain_text"},
                       "template": "green" if kpi["alarm_count"] == 0 else "red"},
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": (
                    f"**设备在线率**：{kpi['availability']:.1%}  "
                    f"**昨日告警**：{kpi['alarm_count']} 次  "
                    f"**待处理工单**：{kpi['pending_workorders']} 条\n\n"
                    f"{'⚠️ 存在需关注设备' if kpi['warning_equipment'] else '✅ 所有设备状态正常'}"
                )}},
                {"tag": "action", "actions": [
                    {"tag": "button", "text": {"content": "查看 3D 场站", "tag": "plain_text"},
                     "type": "default", "url": f"https://studio.clawtwin.local/twin"}
                ]},
            ],
        },
    }

# ── 异常轮询任务 ──────────────────────────────────────────────
# platform-api/scheduler/anomaly_poll.py

async def anomaly_poll_job():
    """每小时：对所有在线设备运行异常检测，发现异常则推送告警"""
    from services.moirai import moirai_client
    from services.feishu import FeishuClient
    from db.session import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        equipments = await get_active_equipments(db)

    for eq in equipments:
        # 获取过去 1 小时的时序数据
        readings = await get_recent_readings(eq.id, hours=1)
        if len(readings) < 10:
            continue  # 数据不足，跳过

        # MOIRAI 推理（或 Phase A 规则引擎）
        score, level = await detect_anomaly(eq, readings)

        if level in ("WARNING", "ALARM"):
            await FeishuClient.send_alert({
                "equipment_id": eq.id,
                "level": "P2" if level == "WARNING" else "P1",
                "message": f"MOIRAI 检测到异常趋势（分数：{score:.2f}）",
                "confidence": f"{score:.0%}",
                "citation": f"MOIRAI:2.0:{eq.id}",
            })

async def detect_anomaly(eq, readings: list) -> tuple[float, str]:
    """Phase A：规则引擎；Phase B：接 MOIRAI"""
    from config import settings
    if settings.mock_mode or settings.fallback_mode:
        # Phase A 规则引擎：检查是否超阈值
        for metric, threshold in eq.thresholds.items():
            latest = next((r.value for r in reversed(readings) if r.metric == metric), None)
            if latest is None:
                continue
            if latest >= threshold.get("alarm", float("inf")):
                return 0.9, "ALARM"
            if latest >= threshold.get("warn", float("inf")):
                return 0.7, "WARNING"
        return 0.1, "NORMAL"
    else:
        # Phase B：调用 MOIRAI
        from services.moirai import moirai_client
        return await moirai_client.predict(eq.id, readings)


# ── Scheduler 辅助查询（被 jobs.py 调用） ──────────────────────
# platform-api/scheduler/helpers.py

from sqlalchemy import select
from models.station import Station
from models.equipment import Equipment
from models.knowledge import EquipmentReading
from db.session import AsyncSessionLocal


async def get_active_stations(db) -> list[Station]:
    """获取所有激活场站"""
    result = await db.execute(select(Station).where(Station.is_active == True))
    return result.scalars().all()


async def get_active_equipments(db) -> list[Equipment]:
    """获取所有激活设备（有阈值配置的）"""
    result = await db.execute(
        select(Equipment).where(Equipment.thresholds != {})
    )
    return result.scalars().all()


async def get_recent_readings(equipment_id: str, hours: int = 1) -> list[EquipmentReading]:
    """获取设备近 N 小时的时序读数"""
    from datetime import datetime, timezone, timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(EquipmentReading)
            .where(
                EquipmentReading.equipment_id == equipment_id,
                EquipmentReading.recorded_at >= cutoff,
            )
            .order_by(EquipmentReading.recorded_at.asc())
        )
    return result.scalars().all()


async def compute_yesterday_kpi(station_id: str) -> dict:
    """计算昨日 KPI（晨报用）"""
    from datetime import datetime, timezone, timedelta
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    # Phase A：基于工单统计；Phase B：接 MOIRAI 分析结果
    from sqlalchemy import func
    from models.workorder import WorkOrder
    async with AsyncSessionLocal() as db:
        # 昨日告警工单数
        alarm_count_result = await db.execute(
            select(func.count()).where(
                WorkOrder.station_id == station_id,
                WorkOrder.state != "draft",     # ← 字段名 state，值小写
                func.date(WorkOrder.created_at) == yesterday,
            )
        )
        alarm_count = alarm_count_result.scalar() or 0
        # 已完成工单数
        done_count_result = await db.execute(
            select(func.count()).where(
                WorkOrder.station_id == station_id,
                WorkOrder.status.in_(["DONE", "CLOSED"]),
                func.date(WorkOrder.updated_at) == yesterday,
            )
        )
        done_count = done_count_result.scalar() or 0

    return {
        "date": str(yesterday),
        "alarm_count": alarm_count,
        "done_workorders": done_count,
        "availability": 0.99 if alarm_count == 0 else 0.97,  # Phase A 估算
    }
```

---

## 十、知识检索三层融合（kb/search.py）

### Embedding 模型选型（重要）

```
模型：BAAI/bge-m3（推荐，多语言，支持中文）
维度：1024（不是 1536，1536 是 OpenAI text-embedding-3-small 的维度）
推理：可通过 vLLM 的 embedding 端点提供服务
  vLLM 启动命令：
    vllm serve BAAI/bge-m3 --task embed --port 8001 --max-model-len 8192

⚠️ 修正：**pgvector** `embedding` 列维度应与 bge-m3 **1024** 一致，不要用 1536（OpenAI 小模型维度）
   修正 `kb/ingest_pipeline.py` / 迁移中 **vector** 列维定义

Phase A（无 GPU）：
  用 fastembed 本地 CPU 推理（pip install fastembed）
  from fastembed import TextEmbedding
  embed_model = TextEmbedding("BAAI/bge-m3")
  embeddings = list(embed_model.embed(chunks))  # dim=1024
```

### 三层融合检索实现

```python
# platform-api/kb/search.py
"""
三层知识融合检索：
  L0/L1/L2：**pgvector** 向量相似度检索（通用行业知识）
  GraphRAG：实体关系查询（文档间的关联，如"哪些标准引用了此规程"）
  L3：Platform 自有数据库（站级已验证工单经验，写在 kb_documents layer=L3）
  ⚠️ L3 不依赖 OpenClaw memory-wiki（后者是 CLI 工具，无 REST API）

调用方：routers/tools.py  POST /v1/tools/kb/search
"""
import asyncio
from dataclasses import dataclass, field

@dataclass
class KBResult:
    content: str
    source: str
    title: str
    layer: str                  # L0 / L1 / L2 / L3 / GRAPH
    score: float                # 相关度分（0-1）
    citation: str               # 引用标识

@dataclass
class KBSearchResponse:
    results: list[KBResult]
    citations: list[str]
    query: str
    layers_searched: list[str]

async def search(
    query: str,
    layers: list[str] | None = None,   # None = 全层搜索
    equipment_type: str | None = None,
    station_id: str | None = None,
    top_k: int = 5,
) -> KBSearchResponse:
    """
    三层并行搜索，结果去重 + 重排序
    """
    layers = layers or ["L0", "L1", "L2", "GRAPH", "L3"]

    # 1. 并行搜索各层
    tasks = []
    if any(l in layers for l in ["L0", "L1", "L2"]):
        tasks.append(search_milvus(query, layers, equipment_type, station_id, top_k))
    if "GRAPH" in layers:
        tasks.append(search_graphrag(query, top_k=3))
    if "L3" in layers:
        tasks.append(search_l3_kb(query, station_id, top_k=3))

    raw_results_per_layer = await asyncio.gather(*tasks, return_exceptions=True)

    # 2. 合并、去重（按 content hash）
    all_results: list[KBResult] = []
    seen: set[str] = set()
    for layer_results in raw_results_per_layer:
        if isinstance(layer_results, Exception):
            continue  # 单层失败不影响其他层
        for r in layer_results:
            key = r.content[:100]  # 取前100字符作去重 key
            if key not in seen:
                seen.add(key)
                all_results.append(r)

    # 3. 按相关度排序，返回 top_k
    all_results.sort(key=lambda r: r.score, reverse=True)
    top_results = all_results[:top_k]
    citations = [r.citation for r in top_results]

    return KBSearchResponse(
        results=top_results,
        citations=citations,
        query=query,
        layers_searched=layers,
    )


# ── L0/L1/L2 pgvector 语义检索（via LlamaIndex）────────────────
async def search_vector_store(
    query: str,
    layers: list[str],
    equipment_type: str | None,
    station_id: str | None,
    top_k: int,
) -> list[KBResult]:
    """
    使用 LlamaIndex + pgvector 执行语义检索。
    替代原 search_milvus（已移除 Milvus 依赖）。
    """
    from kb.ingest_pipeline import search_knowledge

    # 针对每个 layer 分别检索，合并结果
    all_hits: list[dict] = []
    for layer in layers:
        hits = await search_knowledge(
            query=query,
            layer=layer,
            equipment_type=equipment_type,
            station_id=station_id,
            top_k=top_k,
        )
        all_hits.extend(hits)

    return [
        KBResult(
            content=hit["content"],
            source=hit.get("source", ""),
            title=hit.get("title", ""),
            layer=hit.get("layer", "L0"),
            score=hit["score"],
            citation=f"KB:{hit.get('layer','L0')}:{hit.get('source','')}",
        )
        for hit in all_hits
    ]


# ── GraphRAG 关系检索 ─────────────────────────────────────────
async def search_graphrag(query: str, top_k: int) -> list[KBResult]:
    """
    从 MinIO 加载预构建的 GraphRAG 索引（Parquet），执行本地实体关联查询
    Phase A：返回空列表（GraphRAG 索引在 Phase B 构建）
    """
    from config import settings
    if settings.mock_mode or not settings.graphrag_index_path:
        return []

    # Phase B：
    # from graphrag.query.cli import run_local_search
    # results = run_local_search(query, graphrag_index_path, top_k)
    # return [KBResult(...) for r in results]
    return []


# ── L3 平台自有知识检索 ──────────────────────────────────────
async def search_l3_kb(
    query: str,
    station_id: str | None,
    top_k: int,
) -> list[KBResult]:
    """
    L3 = Platform 自有的站级知识（已验证工单经验）
    存储在 Platform 的 kb_documents 表 + **pgvector**（`layer='L3'`，station_id 隔离）
    通过 **pgvector 查询**（实现示例名或为 `search_milvus` 历史遗留）用 layer='L3' 过滤检索

    ⚠️ 不调用 OpenClaw memory-wiki（那是 CLI 工具，无 REST API）
    """
    return await search_milvus(
        query=query,
        layers=["L3"],
        equipment_type=None,
        station_id=station_id,
        top_k=top_k,
    )
```

---

## 十一、Analytics API 端点规范

```
GET  /v1/analytics/equipment/{id}/trend
GET  /v1/analytics/equipment/{id}/anomaly-score
GET  /v1/analytics/station/{station_id}/kpi
GET  /v1/analytics/station/{station_id}/availability
```

### GET /v1/analytics/equipment/{id}/trend

```
权限：get_current_user（验证 equipment 所属 station 在 user.station_ids 中）
Query Params：
  metric:  str    必须，如 "axial_vibration"
  hours:   int    默认 24（过去 N 小时）
  points:  int    默认 100（最多返回点数，超过则降采样）

Response 200：
{
  "equipment_id": "C-001",
  "metric": "axial_vibration",
  "unit": "mm/s",
  "period": {"from": ISO8601, "to": ISO8601},
  "datapoints": [
    {"ts": ISO8601, "value": 2.1},
    ...
  ],
  "thresholds": {"warn": 3.5, "alarm": 5.0},
  "statistics": {
    "min": 1.2, "max": 4.1, "mean": 2.3, "p95": 3.8
  },
  "citations": ["TimescaleDB:C-001:axial_vibration:24h"]
}

实现要点：
  - 使用 TimescaleDB time_bucket() 降采样
  - SQL: SELECT time_bucket('15 minutes', ts) AS period, avg(value) ...
  - 数据量不足时（< 10 点），原样返回不降采样
```

### GET /v1/analytics/equipment/{id}/anomaly-score

```
权限：同上
Query Params：
  hours: int 默认 1

Response 200：
{
  "equipment_id": "C-001",
  "score": 0.73,
  "level": "WARNING",
  "contributing_metrics": [
    {"metric": "axial_vibration", "contribution": 0.6, "current": 4.1, "warn": 3.5},
    {"metric": "discharge_temperature", "contribution": 0.3, "current": 82.0, "warn": 80.0}
  ],
  "prediction_horizon_hours": 2,
  "recommendation": "建议检查轴承润滑状态，预计 2 小时内可能达到报警阈值",
  "citations": ["MOIRAI:2.0:C-001", "Rule:threshold:C-001:axial_vibration"]
}

Phase A 实现：
  - score 由规则引擎计算（超阈值比例加权）
  - recommendation 固定模板文本
Phase B 实现：
  - score 由 MOIRAI 2.0 Large 时序预测
  - recommendation 由 vLLM 生成（含 citations）
```

### GET /v1/analytics/station/{station_id}/kpi

```
权限：get_current_user + require_station(station_id)
Query Params：
  date: str 默认 "yesterday"（也可传 YYYY-MM-DD）

Response 200：
{
  "station_id": "STATION-CNG-001",
  "date": "2026-05-07",
  "availability": 0.987,         # 在线时长 / 24h
  "alarm_count": 3,              # P1+P2 告警次数
  "p1_count": 0,
  "p2_count": 3,
  "pending_workorders": 2,
  "completed_workorders": 1,
  "warning_equipment": ["C-001"],
  "offline_equipment": [],
  "citations": ["TimescaleDB:STATION-CNG-001:2026-05-07"]
}
```

### GET /v1/data/history/{equipment_id}

```
用途：获取设备原始时序历史数据（用于前端图表和 analytics skill 调用）
权限：get_current_user + 校验设备所属 station 在 user.station_ids 中
Query Params：
  metric:     str   必须，如 "axial_vibration"（对应 equipment_readings.metric_name）
  start:      str   ISO8601，默认 now-24h
  end:        str   ISO8601，默认 now
  limit:      int   默认 500，最大 5000（超过则自动 time_bucket 降采样）

Response 200：
{
  "equipment_id": "C-001",
  "metric": "axial_vibration",
  "unit": "mm/s",
  "start": "2026-05-07T10:00:00+08:00",
  "end": "2026-05-08T10:00:00+08:00",
  "count": 288,
  "datapoints": [
    {"ts": "2026-05-07T10:05:00+08:00", "value": 2.1},
    {"ts": "2026-05-07T10:10:00+08:00", "value": 2.3},
    ...
  ]
}

Phase A（mock_mode）：
  - 从 mock_equipment_state() 生成虚假历史（sin 波，以 UTC now 为基准往前推）
  - 不查 TimescaleDB（数据库中无真实数据）

Phase B（正常模式）：
  - 查 TimescaleDB equipment_readings 表
  - 若 count > limit，用 time_bucket(interval, ts) 自动降采样

路由注册：
  analytics_router（已注册到 /v1/analytics），或单独注册到 /v1/data
  推荐：app.include_router(data_router, prefix="/v1/data")
  与 analytics_router 分开（analytics = 聚合计算，data = 原始数据）
```

---

## 十二、启动关键实现（补全缺口）

### 12.1 lifespan 完整版（含 Kafka Consumer 启动）

```python
# platform-api/main.py  ← 补充 lifespan（替换 §七 的简版）
from contextlib import asynccontextmanager
import asyncio

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. 建表（idempotent）
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 2. **pgvector**：`kb_chunks` / 扩展就绪（Phase A）；历史 lifespan 曾调用 ensure_milvus_collection
    if not settings.mock_mode:
        from kb.ingest_pipeline import ensure_milvus_collection
        await ensure_milvus_collection()

    # 3. APScheduler（晨报/异常轮询）
    scheduler = await start_scheduler()

    # 4. Kafka Consumer（后台任务，仅非 mock 模式）
    kafka_task = None
    if not settings.mock_mode:
        from kafka.consumer import start_opcua_consumer
        kafka_task = asyncio.create_task(start_opcua_consumer())

    print(f"[startup] Platform API ready  mock={settings.mock_mode}")
    yield

    # 关闭
    if kafka_task:
        kafka_task.cancel()
    await stop_scheduler(scheduler)
    await engine.dispose()
```

### 12.2 ~~Milvus 集合初始化~~（已废弃，pgvector 替代）

> ⚠️ **此节已废弃**。Phase A/B 使用 pgvector（PostgreSQL 扩展），向量表由 Alembic migration 自动创建。
> Phase C 超出 pgvector 容量（>100万向量）时才引入 Milvus。
> 知识库 ingest/search 实现见 §八（LlamaIndex 版本）。

```python
# 以下代码仅供历史参考，Phase A/B 不使用 Milvus，不要运行此代码。
# ── DEPRECATED: 使用 LlamaIndex + pgvector 替代 ──────────────

async def ensure_milvus_collection():
    """
    [已废弃] 应用启动时调用，幂等：集合不存在则创建，存在则跳过
    """
    from pymilvus import utility, CollectionSchema, FieldSchema, DataType, Collection

    collection_name = settings.milvus_collection
    if utility.has_collection(collection_name):
        return  # 已存在，跳过

    fields = [
        FieldSchema("chunk_id",       DataType.VARCHAR, max_length=100, is_primary=True),
        FieldSchema("doc_id",         DataType.VARCHAR, max_length=50),
        FieldSchema("content",        DataType.VARCHAR, max_length=2048),
        FieldSchema("embedding",      DataType.FLOAT_VECTOR, dim=settings.vllm_embed_dim),
        FieldSchema("layer",          DataType.VARCHAR, max_length=5),
        FieldSchema("equipment_type", DataType.VARCHAR, max_length=50),
        FieldSchema("station_id",     DataType.VARCHAR, max_length=20),
        FieldSchema("source",         DataType.VARCHAR, max_length=200),
        FieldSchema("title",          DataType.VARCHAR, max_length=500),
    ]
    schema = CollectionSchema(fields, description="Industrial knowledge base")
    col = Collection(collection_name, schema)

    # 创建向量索引
    col.create_index(
        "embedding",
        {"index_type": "IVF_FLAT", "metric_type": "COSINE", "params": {"nlist": 128}},
    )
    col.load()
    print(f"[milvus] Collection '{collection_name}' created (dim={settings.vllm_embed_dim})")
```

### 12.3 ~~services/milvus.py~~（已废弃，pgvector 替代）

> ⚠️ **此节已废弃**。向量操作已由 `kb/ingest_pipeline.py`（LlamaIndex + PGVectorStore）接管。
> 开发时不要创建 `services/milvus.py`。

```python
# [已废弃] services/milvus.py
# Phase A/B 不使用此文件。向量存储见 kb/ingest_pipeline.py §八
"""
[DEPRECATED] Milvus 2.5 异步客户端封装
已由 LlamaIndex PGVectorStore 替代，此文件仅供历史参考。
"""
import asyncio
import logging
from functools import partial
from pymilvus import MilvusClient as _MilvusClient

logger = logging.getLogger(__name__)


class MilvusClient:
    """
    线程安全的 Milvus 客户端封装
    所有 I/O 操作用 asyncio.to_thread 在线程池执行，避免阻塞事件循环
    """

    def __init__(self):
        self._client: _MilvusClient | None = None

    def _get_client(self) -> _MilvusClient:
        if self._client is None:
            from config import settings
            self._client = _MilvusClient(uri=settings.milvus_uri)
        return self._client

    # ── 集合管理 ──────────────────────────────────────────────
    async def has_collection(self, name: str) -> bool:
        return await asyncio.to_thread(
            self._get_client().has_collection, name
        )

    async def create_collection(self, schema: dict) -> None:
        from pymilvus import CollectionSchema, FieldSchema, DataType

        fields = []
        for f in schema["fields"]:
            dtype = getattr(DataType, f["dtype"])
            kwargs = {}
            if f.get("max_length"):
                kwargs["max_length"] = f["max_length"]
            if f.get("dim"):
                kwargs["dim"] = f["dim"]
            fields.append(FieldSchema(
                name=f["name"],
                dtype=dtype,
                is_primary=f.get("is_primary", False),
                auto_id=f.get("auto_id", False),
                **kwargs,
            ))
        col_schema = CollectionSchema(fields=fields)

        await asyncio.to_thread(
            self._get_client().create_collection,
            collection_name=schema["name"],
            schema=col_schema,
        )
        # 创建向量索引
        idx = schema.get("index", {})
        if idx:
            await asyncio.to_thread(
                self._get_client().create_index,
                collection_name=schema["name"],
                field_name=idx["field"],
                index_params={
                    "index_type": idx.get("type", "IVF_FLAT"),
                    "metric_type": idx.get("metric", "COSINE"),
                    "params": {"nlist": idx.get("nlist", 128)},
                },
            )
        await asyncio.to_thread(
            self._get_client().load_collection, schema["name"]
        )

    # ── 数据写入 ──────────────────────────────────────────────
    async def insert(self, collection: str, entities: list[dict]) -> None:
        """批量插入（entities 是字段→值字典列表）"""
        if not entities:
            return
        await asyncio.to_thread(
            self._get_client().insert,
            collection_name=collection,
            data=entities,
        )

    async def upsert(self, collection: str, entities: list[dict]) -> None:
        await asyncio.to_thread(
            self._get_client().upsert,
            collection_name=collection,
            data=entities,
        )

    # ── 向量检索 ──────────────────────────────────────────────
    async def search(
        self,
        collection: str,
        query_vector: list[float],
        filter: str | None = None,
        limit: int = 10,
        output_fields: list[str] | None = None,
    ) -> list[dict]:
        """
        返回命中结果列表，每个元素包含 output_fields + 'distance' 字段
        COSINE metric：distance 越小相似度越高（distance = 1 - cosine_similarity）
        """
        results = await asyncio.to_thread(
            self._get_client().search,
            collection_name=collection,
            data=[query_vector],
            filter=filter,
            limit=limit,
            output_fields=output_fields or [],
            search_params={"metric_type": "COSINE", "params": {"nprobe": 16}},
        )
        # results[0] 是第一个 query 的结果列表
        hits = []
        for hit in results[0]:
            row = dict(hit.get("entity", {}))
            row["distance"] = hit.get("distance", 1.0)
            hits.append(row)
        return hits

    # ── 标量查询 ──────────────────────────────────────────────
    async def query(
        self,
        collection: str,
        filter: str,
        output_fields: list[str],
        limit: int = 100,
    ) -> list[dict]:
        results = await asyncio.to_thread(
            self._get_client().query,
            collection_name=collection,
            filter=filter,
            output_fields=output_fields,
            limit=limit,
        )
        return results

    async def delete(self, collection: str, filter: str) -> None:
        await asyncio.to_thread(
            self._get_client().delete,
            collection_name=collection,
            filter=filter,
        )


# 全局单例（在 lifespan 前惰性初始化）
milvus_client = MilvusClient()
```

**注意事项**：

- `pymilvus.MilvusClient` 是 Milvus 2.5 引入的 "Lite" 简洁 API，替代老的 `Collection` API
- COSINE distance：`0.0` = 完全相同，`1.0` = 完全无关；在 `KBResult.score` 中转为 `1 - distance`
- `asyncio.to_thread` 确保不阻塞 FastAPI 事件循环（pymilvus 是同步 SDK）
- Phase A mock_mode 下可跳过 **pgvector** 就绪检查（历史名 `ensure_milvus_collection`），`search_milvus` 等遗留名返回空列表（L0-L2 无数据属正常，知识需手动导入）

### 12.3b Phase A Embedding 降级（CPU fastembed）

```python
# services/vllm.py  ← embed 方法增加 fallback 分支

class EmbeddingClient:
    async def embed(self, text: str) -> list[float]:
        return (await self.embed_batch([text]))[0]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Phase A（VLLM_EMBED_URL 为空）：使用 fastembed CPU 推理
        Phase B（VLLM_EMBED_URL 已配置）：调用 vLLM embedding API
        """
        if not settings.vllm_embed_url:
            return self._embed_fastembed(texts)
        return await self._embed_vllm(texts)

    def _embed_fastembed(self, texts: list[str]) -> list[list[float]]:
        """CPU embedding（无 GPU 时的 Phase A 方案）"""
        try:
            from fastembed import TextEmbedding
        except ImportError:
            raise RuntimeError(
                "fastembed 未安装。Phase A embedding 需要：pip install fastembed\n"
                "或配置 VLLM_EMBED_URL 指向 GPU 服务器。"
            )
        # 懒加载，避免启动时阻塞
        if not hasattr(self, "_fastembed_model"):
            self._fastembed_model = TextEmbedding(settings.vllm_embed_model)
        return [list(v) for v in self._fastembed_model.embed(texts)]

    async def _embed_vllm(self, texts: list[str]) -> list[list[float]]:
        """GPU vLLM embedding API"""
        import httpx
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.vllm_embed_url}/v1/embeddings",
                json={"model": settings.vllm_embed_model, "input": texts},
            )
            resp.raise_for_status()
            data = resp.json()
        return [item["embedding"] for item in data["data"]]

embedding_client = EmbeddingClient()
```

### 12.4 write_l3_knowledge()（数据飞轮）

**L3 架构说明**：

- L3 知识存储在 Platform 自有的 `kb_documents` 表（`layer='L3'`）+ **pgvector**（`kb_chunks`）
- 工单完成后后台异步摄入，不阻塞 DONE 接口响应
- **不依赖 OpenClaw memory-wiki**（memory-wiki 是 CLI 工具，无 REST API）
- L3 检索与 L0-L2 共用同一套 **pgvector** 存储与过滤（`layer='L3'` + `station_id`）

```python
# kb/l3_writer.py  ← 新文件

"""
工单完成后写入 L3 知识（站级已验证维修经验）
存入 Platform 自有的 PostgreSQL kb_documents 表 + **pgvector**
与 L0/L1/L2 共用同一知识检索架构，无外部依赖
"""
import asyncio
import logging
from datetime import datetime, UTC

logger = logging.getLogger(__name__)


async def write_l3_knowledge(wo) -> bool:
    """
    工单完成（DONE）时触发，将成功的维修经验作为 L3 知识写入
    自己创建 DB session，不需要调用方传入（调用方签名：await write_l3_knowledge(wo)）
    使用 asyncio.create_task 后台写 **pgvector**，不阻塞 DONE 接口响应
    """
    from config import settings
    if not settings.l3_auto_ingest:
        return False

    # 构建知识条目文本（结构化，方便向量检索）
    content = (
        f"设备：{wo.equipment_id}\n"
        f"问题描述：{wo.description}\n"
        f"处置措施：{wo.action or '（未填写）'}\n"
        f"实际操作：{wo.actual_action or '（未填写）'}\n"
        f"完成时间：{wo.done_at.isoformat() if wo.done_at else ''}\n"
        f"工单号：{wo.wo_id}\n"
        f"执行结果：已完成，主管 {wo.approved_by} 审批，操作员确认有效"
    )

    from models.knowledge import KBDocument
    from db.session import AsyncSessionLocal

    # 自己建 session，与 FSM 事务完全独立
    async with AsyncSessionLocal() as db:
        doc = KBDocument(
            doc_id=f"L3-WO-{wo.wo_id}",
            title=f"{wo.equipment_id} 维修记录（已验证）",
            layer="L3",
            station_id=wo.station_id,
            source=f"WorkOrder:{wo.wo_id}",
            status="pending",
            content_text=content,    # 直接存文本，跳过 PDF 解析步骤
        )
        db.add(doc)
        await db.commit()
        doc_id = doc.doc_id

    # 后台异步写入 **pgvector**（不阻塞响应）
    asyncio.create_task(_embed_and_index_l3(doc_id, content))
    return True


async def _embed_and_index_l3(doc_id: str, content: str):
    """后台任务：将 L3 内容向量化并写入 **pgvector**"""
    from services.vllm import embedding_client
    from services.milvus import milvus_client
    from config import settings
    from db.session import AsyncSessionLocal
    from models.knowledge import KBDocument

    try:
        embedding = await embedding_client.embed(content)

        async with AsyncSessionLocal() as db:
            doc = await db.get(KBDocument, doc_id)
            await milvus_client.insert(settings.milvus_collection, [{
                "chunk_id":       f"{doc_id}_0",
                "doc_id":         doc_id,
                "content":        content[:2048],
                "embedding":      embedding,
                "layer":          "L3",
                "equipment_type": doc.equipment_type or "general",
                "station_id":     doc.station_id,
                "source":         doc.source,
                "title":          doc.title,
            }])
            doc.status = "indexed"
            await db.commit()
    except Exception as e:
        logger.warning(f"L3 pgvector indexing failed for {doc_id}: {e}")
        # 下次 re-index job 会重试 status=pending 的记录
```

### 12.5 Phase A Redis mock 设备状态

```python
# services/twin_state.py  ← 新文件

"""
Phase A：用 Redis Hash 存储实时设备状态（替代 Eclipse Ditto）
Phase B：迁移到 Ditto（改 ditto.py 中的实现）

Redis Key 结构：
  twin:{station_id}:{equipment_id}  → Hash {metric: value, status: ..., ts: ...}
  twin:{station_id}:index           → Set {equipment_id, ...}
"""
import json
from datetime import datetime, UTC
from aioredis import Redis

_redis: Redis | None = None

def get_redis() -> Redis:
    if _redis is None:
        raise RuntimeError("Redis 未初始化，检查 lifespan 是否已建立连接")
    return _redis

async def get_equipment_state(equipment_id: str, station_id: str) -> dict | None:
    """读取设备当前状态"""
    r = get_redis()
    key = f"twin:{station_id}:{equipment_id}"
    raw = await r.hgetall(key)
    if not raw:
        return None  # 设备未上报数据

    current = {}
    thresholds = {}
    for k, v in raw.items():
        k = k.decode() if isinstance(k, bytes) else k
        v = v.decode() if isinstance(v, bytes) else v
        if k.startswith("th_"):
            thresholds[k[3:]] = json.loads(v)
        elif k not in ("status", "ts", "equipment_id"):
            current[k] = {"value": float(v), "unit": ""}  # unit 从 equipment 元数据取
    return {
        "equipment_id": equipment_id,
        "status": raw.get(b"status", b"NORMAL").decode(),
        "current": current,
        "last_updated": raw.get(b"ts", b"").decode(),
    }

async def update_equipment_state(data: dict):
    """
    Kafka Consumer 写入：从 Kafka 消息更新 Redis 状态
    data = {equipment_id, station_id, metric, value, source_ts}
    """
    r = get_redis()
    key = f"twin:{data['station_id']}:{data['equipment_id']}"
    await r.hset(key, mapping={
        data["metric"]: str(data["value"]),
        "ts": data.get("source_ts", datetime.now(UTC).isoformat()),
        "equipment_id": data["equipment_id"],
    })
    await r.expire(key, 3600 * 24)  # 24h TTL，断连后自动清除过时状态

async def mock_equipment_state(equipment_id: str, station_id: str, mock_data_dir: str) -> dict:
    """
    Phase A MOCK_MODE：从 JSON 文件加载，叠加随机波动
    """
    import random, math, json
    from pathlib import Path

    path = Path(mock_data_dir) / f"equipment-{equipment_id}.json"
    if path.exists():
        base = json.loads(path.read_text())
    else:
        base = {"current": {"value": 1.0}, "thresholds": {}, "status": "NORMAL"}

    # 正弦波 + 随机噪声模拟真实波动
    t = datetime.now(UTC).timestamp()
    current = {}
    for metric, val in base.get("current", {}).items():
        center = val.get("base", 1.0)
        amp = center * 0.1
        noise = random.gauss(0, amp * 0.2)
        current[metric] = {
            "value": round(center + amp * math.sin(t * 0.1) + noise, 2),
            "unit": val.get("unit", ""),
        }
    return {**base, "current": current, "last_updated": datetime.now(UTC).isoformat()}
```

### 12.6 TimescaleDB 初始化 SQL（data/seeds/init.sql）

```sql
-- data/seeds/init.sql
-- 在 PostgreSQL 建表完成后，将 equipment_readings 转为 TimescaleDB hypertable
-- Docker Compose 会在 postgres 容器首次启动时执行此文件

-- 启用 TimescaleDB 扩展
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- equipment_readings 转时序超表（按 time 列分区，7 天一个 chunk）
-- 注意：表必须先由 Alembic 创建，此 SQL 只做 hypertable 转换
-- 如果 equipment_readings 不存在，先注释此行，等 Alembic 迁移后再执行
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_tables WHERE tablename = 'equipment_readings'
  ) THEN
    PERFORM create_hypertable('equipment_readings', 'time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );
  END IF;
END $$;

-- anomaly_scores 同理
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_tables WHERE tablename = 'anomaly_scores'
  ) THEN
    PERFORM create_hypertable('anomaly_scores', 'time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );
  END IF;
END $$;

-- ⚠️ 正确顺序（已修复）：
-- init.sql 只负责启用扩展（docker-entrypoint-initdb.d 阶段执行，表还不存在）
-- hypertable 创建必须在 Alembic 建表之后 → 放进 Alembic migration 脚本！
--
-- 在 Alembic migration 中添加：
--   from alembic import op
--   op.execute("SELECT create_hypertable('equipment_readings', 'time', if_not_exists => TRUE)")
--   op.execute("SELECT create_hypertable('anomaly_scores', 'time', if_not_exists => TRUE)")
--
-- init.sql 只保留：
--   CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
--   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- UUID 生成
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- 密码 hash（crypt函数）
```

---

### 12.7 routers/health.py（完整实现）

```python
# routers/health.py
"""
GET /v1/health
Phase A mock_mode：跳过 Ditto、Kafka、OPC-UA 检查（服务不运行）
Phase B 正常模式：检查所有依赖服务
"""
import asyncio, time, logging
from datetime import datetime, UTC
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


async def _ping_postgres() -> dict:
    from db.session import engine
    t0 = time.monotonic()
    try:
        async with engine.connect() as conn:
            await conn.execute(__import__("sqlalchemy").text("SELECT 1"))
        return {"status": "up", "latency_ms": round((time.monotonic() - t0) * 1000, 1)}
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _ping_redis() -> dict:
    import redis.asyncio as aioredis
    t0 = time.monotonic()
    try:
        r = aioredis.from_url(settings.redis_url)
        await r.ping()
        await r.aclose()
        return {"status": "up", "latency_ms": round((time.monotonic() - t0) * 1000, 1)}
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _ping_milvus() -> dict:
    from pymilvus import connections
    t0 = time.monotonic()
    try:
        connections.connect("default", uri=settings.milvus_uri)
        return {"status": "up", "latency_ms": round((time.monotonic() - t0) * 1000, 1)}
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _ping_vllm() -> dict:
    import httpx
    if not settings.vllm_chat_url:
        return {"status": "not_configured"}
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{settings.vllm_chat_url.rstrip('/v1')}/health")
            return {
                "status": "up" if r.status_code == 200 else "down",
                "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            }
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _ping_ditto() -> dict:
    """仅 Phase B（非 mock 模式）检查"""
    if settings.mock_mode:
        return {"status": "skipped_mock_mode"}
    import httpx
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{settings.ditto_url}/health")
            return {
                "status": "up" if r.status_code == 200 else "down",
                "latency_ms": round((time.monotonic() - t0) * 1000, 1),
            }
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _ping_kafka() -> dict:
    """仅 Phase B（非 mock 模式）检查"""
    if settings.mock_mode:
        return {"status": "skipped_mock_mode"}
    try:
        from kafka import KafkaAdminClient
        admin = KafkaAdminClient(bootstrap_servers=settings.kafka_brokers, request_timeout_ms=2000)
        admin.close()
        return {"status": "up"}
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


async def _check_opcua_feed() -> dict:
    """检查 OPC-UA 数据流最后时间戳（Redis 中的心跳 key）"""
    if settings.mock_mode:
        return {"status": "simulated_mock_mode"}
    import redis.asyncio as aioredis, json
    try:
        r = aioredis.from_url(settings.redis_url)
        val = await r.get("opcua:last_msg_ts")
        await r.aclose()
        if val:
            last_ts = float(val)
            ago = round(time.time() - last_ts, 1)
            status = "up" if ago < 60 else "stale"  # 60s 无消息视为 stale
            return {"status": status, "last_msg_ago_s": ago}
        return {"status": "no_data_yet"}
    except Exception as e:
        return {"status": "down", "error": str(e)[:80]}


@router.get("/v1/health")
async def health_check():
    # 并发检查所有依赖
    results = await asyncio.gather(
        _ping_postgres(),
        _ping_redis(),
        _ping_milvus(),
        _ping_vllm(),
        _ping_ditto(),
        _ping_kafka(),
        _check_opcua_feed(),
        return_exceptions=True,
    )
    names = ["postgres", "redis", "milvus", "vllm", "ditto", "kafka", "opcua_feed"]
    services = {}
    for name, result in zip(names, results):
        if isinstance(result, Exception):
            services[name] = {"status": "down", "error": str(result)[:80]}
        else:
            services[name] = result

    # 整体状态计算
    critical = ["postgres", "redis"]  # 这些 down = critical
    important = ["milvus"]            # down = degraded
    # mock 模式下 ditto/kafka 是 skipped，不影响整体

    if any(services[s]["status"] == "down" for s in critical):
        overall = "critical"
        status_code = 503
    elif any(services[s]["status"] == "down" for s in important):
        overall = "degraded"
        status_code = 200
    elif services["vllm"]["status"] == "down":
        overall = "degraded"   # 无 LLM 但可降级运行
        status_code = 200
    else:
        overall = "ok"
        status_code = 200

    body = {
        "status": overall,
        "timestamp": datetime.now(UTC).isoformat(),
        "mode": "mock" if settings.mock_mode else "normal",
        "services": services,
    }
    return JSONResponse(content=body, status_code=status_code)
```

### 12.8 Mock 数据 JSON 格式（data/mock/）

Phase A 开发时使用，提供场站和设备的基线数据（含正弦波参数，`mock_equipment_state()` 叠加随机噪声）：

```json
// data/mock/station-CNG-001.json（天然气压缩机场站基线）
{
  "station_id": "CNG-001",
  "name": "某某天然气压缩站",
  "type": "compressor_station",
  "location": { "city": "XX市", "coordinates": [116.4, 39.9] },
  "equipment_ids": ["C-001", "C-002", "V-001", "V-002", "F-001", "METER-001"],
  "kpi_baselines": {
    "daily_throughput_m3": { "base": 50000, "unit": "m³/d" },
    "availability": { "base": 0.98, "unit": "%" },
    "energy_efficiency": { "base": 0.85, "unit": "kWh/km³" }
  }
}
```

```json
// data/mock/equipment-C-001.json（天然气压缩机 C-001 基线）
// base = 传感器中心值；mock_equipment_state 在此基础上叠加 ±10% 正弦波 + 噪声
{
  "equipment_id": "C-001",
  "station_id": "CNG-001",
  "type": "compressor",
  "name": "1# 往复式压缩机",
  "manufacturer": "沈鼓集团",
  "model": "2D12-70/35-300",
  "status": "NORMAL",
  "thresholds": {
    "suction_pressure_mpa": {
      "warn_high": 3.6,
      "alarm_high": 3.8,
      "warn_low": 3.0,
      "alarm_low": 2.8
    },
    "discharge_pressure_mpa": {
      "warn_high": 30.0,
      "alarm_high": 31.0,
      "warn_low": 25.0,
      "alarm_low": 23.0
    },
    "bearing_temp_celsius": { "warn_high": 75, "alarm_high": 85 },
    "vibration_mm_s": { "warn_high": 4.5, "alarm_high": 7.1 },
    "motor_current_a": { "warn_high": 120, "alarm_high": 140 }
  },
  "current": {
    "suction_pressure_mpa": { "base": 3.4, "unit": "MPa" },
    "discharge_pressure_mpa": { "base": 28.5, "unit": "MPa" },
    "bearing_temp_celsius": { "base": 62.0, "unit": "°C" },
    "vibration_mm_s": { "base": 2.1, "unit": "mm/s" },
    "motor_current_a": { "base": 95.0, "unit": "A" },
    "flow_rate_m3_h": { "base": 2100, "unit": "m³/h" },
    "rpm": { "base": 300, "unit": "rpm" }
  }
}
```

```json
// data/mock/equipment-V-001.json（调压阀基线）
{
  "equipment_id": "V-001",
  "station_id": "CNG-001",
  "type": "pressure_regulator",
  "name": "出站调压阀 V-001",
  "status": "NORMAL",
  "thresholds": {
    "inlet_pressure_mpa": { "warn_high": 30.0, "alarm_high": 31.0 },
    "outlet_pressure_mpa": {
      "warn_high": 7.5,
      "alarm_high": 8.0,
      "warn_low": 6.0,
      "alarm_low": 5.5
    },
    "valve_opening_pct": { "warn_high": 95, "warn_low": 5 }
  },
  "current": {
    "inlet_pressure_mpa": { "base": 28.5, "unit": "MPa" },
    "outlet_pressure_mpa": { "base": 6.8, "unit": "MPa" },
    "valve_opening_pct": { "base": 65.0, "unit": "%" },
    "temperature_celsius": { "base": 15.0, "unit": "°C" }
  }
}
```

**数据文件清单（Phase A 需提供）**：

| 文件                       | 设备类型     | 说明                          |
| -------------------------- | ------------ | ----------------------------- |
| `station-CNG-001.json`     | 场站         | 场站基线 + KPI 参数           |
| `equipment-C-001.json`     | 往复式压缩机 | 入口/出口压力、轴承温度、振动 |
| `equipment-C-002.json`     | 往复式压缩机 | 同 C-001，备用机              |
| `equipment-V-001.json`     | 调压阀       | 调压阀压差、开度              |
| `equipment-V-002.json`     | 截断阀       | 球阀状态（开/关）             |
| `equipment-F-001.json`     | 过滤分离器   | 压差、液位                    |
| `equipment-METER-001.json` | 流量计       | 流量、温压补偿                |

---

## 十三、基础设施代码（开发必须）

### 13.1 db/session.py（异步 SQLAlchemy Session）

```python
# db/session.py
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from config import settings

engine = create_async_engine(
    settings.database_url,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,         # 每次借连接前 ping，自动恢复断连
    echo=False,                 # 生产环境关闭 SQL 日志
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,     # commit 后对象属性仍可访问
    autocommit=False,
    autoflush=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    """FastAPI Dependency：注入 AsyncSession"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
```

### 13.2 auth/jwt_utils.py（JWT 工具函数）

```python
# auth/jwt_utils.py
from datetime import datetime, timedelta, UTC
from typing import Any
import jwt
from config import settings

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8
REFRESH_TOKEN_EXPIRE_DAYS = 30


def create_access_token(data: dict[str, Any]) -> str:
    """生成 JWT access token（8 小时有效）"""
    payload = {
        **data,
        "exp": datetime.now(UTC) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS),
        "iat": datetime.now(UTC),
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    """生成 refresh token（30 天有效）"""
    payload = {
        "sub": user_id,
        "exp": datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "iat": datetime.now(UTC),
        "type": "refresh",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    """
    解码 JWT，验证签名和有效期
    抛出 jwt.ExpiredSignatureError / jwt.InvalidTokenError
    """
    return jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])


# FastAPI 依赖项：从 Authorization header 中取出并验证 JWT
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """
    FastAPI 依赖：验证 JWT，返回用户信息 dict
    {user_id, employee_id, name, role, station_ids, feishu_open_id}
    """
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未提供认证令牌")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="令牌类型错误")
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="令牌已过期，请重新登录")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="令牌无效")


def require_station(station_id: str):
    """
    工厂函数：生成 FastAPI 依赖，验证当前用户有访问该 station 的权限
    用法：Depends(require_station(station_id))
    """
    async def _check(user: dict = Depends(get_current_user)) -> dict:
        if station_id not in user.get("station_ids", []):
            raise HTTPException(status_code=403, detail=f"无 {station_id} 访问权限")
        return user
    return _check
```

### 13.3 services/feishu.py（飞书消息发送）

```python
# services/feishu.py
"""
飞书消息发送工具（单向：Platform → 飞书）
- 向群组发送消息卡片（工单审批、告警推送）
- 向个人发送私信（绑定邀请、工单通知）
飞书 Bot API 文档：https://open.feishu.cn/document/server-docs/im-v1/message/create
"""
import httpx
import logging
from config import settings

logger = logging.getLogger(__name__)

FEISHU_API_BASE = "https://open.feishu.cn/open-apis"  # 标准飞书
# 私有部署飞书使用：settings.feishu_server_url + "/open-apis"


class FeishuClient:
    """飞书 Bot 消息客户端（无状态，每次请求重建 httpx client）"""

    @staticmethod
    async def _get_tenant_token() -> str:
        """获取 tenant_access_token（应缓存，每 2 小时刷新一次）"""
        # 生产环境：应用 Redis 缓存避免频繁刷新
        base = settings.feishu_server_url.rstrip("/") + "/open-apis" \
               if settings.feishu_server_url else FEISHU_API_BASE
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                f"{base}/auth/v3/tenant_access_token/internal",
                json={
                    "app_id":     settings.feishu_app_id,
                    "app_secret": settings.feishu_app_secret,
                },
            )
            resp.raise_for_status()
            return resp.json()["tenant_access_token"]

    @staticmethod
    async def send_text_to_user(open_id: str, text: str) -> bool:
        """向用户发私信（文本）"""
        if not settings.feishu_app_id:
            logger.warning("飞书未配置，跳过发送")
            return False
        try:
            base = settings.feishu_server_url.rstrip("/") + "/open-apis" \
                   if settings.feishu_server_url else FEISHU_API_BASE
            token = await FeishuClient._get_tenant_token()
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{base}/im/v1/messages",
                    params={"receive_id_type": "open_id"},
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "receive_id": open_id,
                        "msg_type": "text",
                        "content": f'{{"text": "{text}"}}',
                    },
                )
                resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"飞书私信发送失败 {open_id}: {e}")
            return False

    @staticmethod
    async def send_card_to_chat(chat_id: str, card: dict) -> bool:
        """
        向群组发送消息卡片（工单审批、告警推送）
        card: 飞书 Interactive 卡片 JSON（含 header + body + actions）
        """
        if not settings.feishu_app_id:
            logger.warning("飞书未配置，跳过发送")
            return False
        try:
            base = settings.feishu_server_url.rstrip("/") + "/open-apis" \
                   if settings.feishu_server_url else FEISHU_API_BASE
            token = await FeishuClient._get_tenant_token()
            import json
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{base}/im/v1/messages",
                    params={"receive_id_type": "chat_id"},
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "receive_id": chat_id,
                        "msg_type": "interactive",
                        "content": json.dumps(card),
                    },
                )
                resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"飞书卡片发送失败 {chat_id}: {e}")
            return False

    @staticmethod
    async def send_text_to_chat(chat_id: str, text: str) -> bool:
        """向群组发送文本消息（晨报、简短通知）"""
        if not settings.feishu_app_id:
            return False
        try:
            base = settings.feishu_server_url.rstrip("/") + "/open-apis" \
                   if settings.feishu_server_url else FEISHU_API_BASE
            token = await FeishuClient._get_tenant_token()
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{base}/im/v1/messages",
                    params={"receive_id_type": "chat_id"},
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "receive_id": chat_id,
                        "msg_type": "text",
                        "content": f'{{"text": "{text}"}}',
                    },
                )
                resp.raise_for_status()
            return True
        except Exception as e:
            logger.error(f"飞书文本发送失败 {chat_id}: {e}")
            return False
```

### 13.4 platform-api/Dockerfile

```dockerfile
# platform-api/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# 安装系统依赖（unstructured 依赖 poppler 解析 PDF）
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 非 root 用户运行（安全）
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# 生产：gunicorn -k uvicorn.workers.UvicornWorker main:app -w 4 -b 0.0.0.0:8080
# 开发：uvicorn main:app --host 0.0.0.0 --port 8080 --reload
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

### 13.5 platform-api/requirements.txt（核心依赖）

```text
# Web 框架
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
python-multipart>=0.0.12     # 文件上传

# 数据库
sqlalchemy[asyncio]>=2.0.0
asyncpg>=0.29.0              # PostgreSQL 异步驱动
alembic>=1.13.0

# 缓存
redis[asyncio]>=5.0.0

# 向量数据库
pymilvus>=2.5.0

# 对象存储
boto3>=1.34.0                # MinIO S3-compatible
aioboto3>=13.0.0             # 异步版本

# AI / 嵌入
httpx>=0.27.0                # 调用 vLLM / 飞书 API
fastembed>=0.3.0             # Phase A CPU embedding 降级

# 知识摄入
unstructured[pdf]>=0.13.0   # PDF 文本提取
docling>=2.0.0               # 备选 PDF 解析（效果更好）

# 任务调度
apscheduler>=3.10.0

# 安全
pyjwt>=2.8.0
passlib[bcrypt]>=1.7.4       # 密码 hash
python-dotenv>=1.0.0
pydantic-settings>=2.0.0

# 工具
python-dateutil>=2.9.0
structlog>=24.0.0            # 结构化日志

# Phase B（可选，提前装好）
# kafka-python>=2.0.2        # Kafka consumer
# moirai-forecasting          # MOIRAI 时序预测（自定义安装）
```

---

## 十四、Auth 模块完整实现

### 14.1 auth/password.py（密码 hash，bcrypt）

```python
# auth/password.py
from passlib.context import CryptContext

_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """返回 bcrypt hash，存入 users.password_hash"""
    return _ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """验证明文密码与 hash 是否匹配"""
    return _ctx.verify(plain, hashed)
```

### 14.2 auth/jwt_verify.py（JWT 验证，兼容 depends.py）

```python
# auth/jwt_verify.py
# ⚠️ depends.py 里调用 from auth.jwt import verify_jwt
# 文件命名为 jwt_verify.py，需在 auth/__init__.py 中 re-export：
#   from auth.jwt_verify import verify_jwt

import jwt
from config import settings


def verify_jwt(token: str) -> dict:
    """
    验证 JWT，返回 payload dict
    抛出 jwt.InvalidTokenError（由 depends.py 捕获转为 401）
    """
    payload = jwt.decode(
        token,
        settings.jwt_secret_key,
        algorithms=["HS256"],
    )
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("token type mismatch")
    return payload
```

### 14.3 routers/auth.py（登录端点完整实现）

```python
# routers/auth.py
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.session import get_db
from models.user import User
from auth.password import verify_password
from auth.jwt_utils import create_access_token, create_refresh_token, decode_token

router = APIRouter(tags=["auth"])


class LoginRequest(BaseModel):
    employee_id: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = 28800  # 8 小时
    user: dict


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    # 查用户（按工号）
    result = await db.execute(
        select(User).where(User.employee_id == body.employee_id, User.is_active == True)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="工号或密码错误",
        )

    # 生成 JWT（payload 含 user 完整信息）
    token_data = {
        "sub":         user.user_id,
        "employee_id": user.employee_id,
        "name":        user.name,
        "role":        user.role,
        "station_ids": user.station_ids,           # list[str]
        "feishu_open_id": user.feishu_open_id,     # 可为 None
    }
    access_token = create_access_token(token_data)

    return LoginResponse(
        access_token=access_token,
        user=token_data,
    )


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh")
async def refresh(body: RefreshRequest):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(401, "令牌类型错误")
        # 重新生成 access token
        new_token_data = {k: v for k, v in payload.items()
                          if k not in ("exp", "iat", "type")}
        return {"access_token": create_access_token(new_token_data), "expires_in": 28800}
    except Exception:
        raise HTTPException(401, "refresh_token 无效或已过期")


# ── 用户初始化（管理员创建用户时调用）──────────────────────────
from pydantic import BaseModel as PM


class CreateUserRequest(PM):
    employee_id: str
    name: str
    password: str
    role: str
    station_ids: list[str]


@router.post("/admin/users/init-password", include_in_schema=False)
async def init_password(body: CreateUserRequest, db: AsyncSession = Depends(get_db)):
    """
    内部接口：为新用户设置初始密码 hash
    由 Admin API（POST /v1/admin/users）调用，不暴露给外部
    """
    from auth.password import hash_password
    from models.user import User
    hashed = hash_password(body.password)
    user = User(
        employee_id=body.employee_id,
        name=body.name,
        password_hash=hashed,
        role=body.role,
        station_ids=body.station_ids,
        is_active=True,
    )
    db.add(user)
    await db.commit()
    return {"user_id": user.user_id, "message": "用户创建成功"}
```

### 14.4 auth/feishu_bind.py（飞书 OpenID → 用户查询）

```python
# auth/feishu_bind.py
"""
查询飞书 open_id 对应的 Platform 用户（供 depends.py 的 OpenClaw 模式鉴权）
"""
from sqlalchemy import select
from db.session import AsyncSessionLocal
from models.user import User, UserFeishuBinding


async def lookup_user_by_open_id(open_id: str):
    """
    根据飞书 open_id 查找绑定的 Platform 用户
    返回 CurrentUser（dict like）或 None
    """
    from models.user import CurrentUser

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(User)
            .join(UserFeishuBinding, User.user_id == UserFeishuBinding.user_id)
            .where(UserFeishuBinding.feishu_open_id == open_id, User.is_active == True)
        )
        user = result.scalar_one_or_none()

    if not user:
        return None
    return CurrentUser(
        user_id=user.user_id,
        employee_id=user.employee_id,
        name=user.name,
        role=user.role,
        station_ids=user.station_ids,
        feishu_open_id=open_id,
    )
```

### 14.5 FeishuClient.send_alert()（补充告警推送方法）

```python
# 在 services/feishu.py 的 FeishuClient 类中追加以下静态方法：

    @staticmethod
    async def send_alert(alert: dict) -> bool:
        """
        向设备所属场站的值班群发送告警卡片
        alert 格式：
          { equipment_id, level ("P1"|"P2"|"P3"), message, confidence, citation }
        P1=ALARM（红色）, P2=WARNING（橙色）, P3=INFO（蓝色）
        """
        from db.session import AsyncSessionLocal
        from models.equipment import Equipment
        from sqlalchemy import select

        # 查找设备所属场站的值班群
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Equipment).where(Equipment.equipment_id == alert["equipment_id"])
            )
            eq = result.scalar_one_or_none()
        if not eq:
            return False

        from models.station import Station
        async with AsyncSessionLocal() as db:
            station = await db.get(Station, eq.station_id)
        if not station or not station.feishu_duty_chat_id:
            return False

        color_map = {"P1": "red", "P2": "orange", "P3": "blue"}
        emoji_map = {"P1": "🔴", "P2": "🟡", "P3": "🔵"}
        level = alert.get("level", "P2")

        card = {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {"content": f"{emoji_map.get(level, '⚠️')} 设备告警 [{level}]", "tag": "plain_text"},
                    "template": color_map.get(level, "orange"),
                },
                "elements": [
                    {"tag": "div", "text": {
                        "content": (
                            f"**设备**：{alert['equipment_id']}\n"
                            f"**告警**：{alert['message']}\n"
                            f"**置信度**：{alert.get('confidence', 'N/A')}\n"
                            f"**来源**：{alert.get('citation', '')}"
                        ),
                        "tag": "lark_md",
                    }},
                    {"tag": "action", "actions": [{
                        "tag": "button",
                        "text": {"content": "查看设备详情", "tag": "plain_text"},
                        "type": "primary",
                        "url": f"{settings.studio_url}/twin#{alert['equipment_id']}",
                    }]},
                ],
            },
        }
        return await FeishuClient.send_card_to_chat(station.feishu_duty_chat_id, card)
```

---

## 十五、SQLAlchemy ORM 模型（models/）

> **关键**：以下 ORM class 对应 §二 数据库表结构，被 routers、auth、scheduler 等模块广泛导入。所有模型继承自 `db/session.py` 的 `Base`。

### 15.1 models/user.py

```python
# models/user.py
import uuid
from typing import Optional
from pydantic import BaseModel
from sqlalchemy import Boolean, Column, String, Text, ARRAY
from sqlalchemy.dialects.postgresql import JSONB
from db.session import Base


class User(Base):
    """Platform 用户表（对应 schema 中的 users）"""
    __tablename__ = "users"

    user_id        = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    employee_id    = Column(String(20), unique=True, nullable=False)
    name           = Column(String(100), nullable=False)
    role           = Column(String(30), nullable=False)             # operator|supervisor|engineer|kb_admin|sys_admin
    station_ids    = Column(ARRAY(String), nullable=False, default=[])
    password_hash  = Column(String(200), nullable=False)
    feishu_open_id = Column(String(100), nullable=True)
    is_active      = Column(Boolean, default=True)


class UserFeishuBinding(Base):
    """飞书 open_id ↔ user_id 绑定表"""
    __tablename__ = "user_feishu_bindings"

    id             = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id        = Column(String(36), nullable=False)
    feishu_open_id = Column(String(100), nullable=False, unique=True)


# ── Pydantic 运行时 Schema（鉴权层使用） ─────────────────────
class CurrentUser(BaseModel):
    """依赖注入中传递的用户上下文（不含敏感字段）"""
    user_id:        str
    employee_id:    str
    name:           str
    role:           str
    station_ids:    list[str]
    feishu_open_id: Optional[str] = None

    def has_station(self, station_id: str) -> bool:
        return station_id in self.station_ids or self.role == "sys_admin"

    def has_role(self, *roles: str) -> bool:
        return self.role in roles
```

### 15.2 models/equipment.py

```python
# models/equipment.py
import uuid
from sqlalchemy import Column, String, Float, JSON
from sqlalchemy.dialects.postgresql import JSONB
from db.session import Base


class Equipment(Base):
    """设备基础元数据表（对应 equipment 表）"""
    __tablename__ = "equipment"

    equipment_id = Column(String(50), primary_key=True)
    name         = Column(String(200), nullable=False)
    type         = Column(String(50), nullable=False)          # compressor|valve|separator|...
    station_id   = Column(Integer, ForeignKey("stations.id"), nullable=False)
    location     = Column(String(200))
    manufacturer = Column(String(100))
    model_number = Column(String(100))
    install_date = Column(Date)                                # 安装日期（资产管理）

    # 【权威状态枚举】以 DESIGN-FINAL-LOCK.md §二a 为准
    # running | standby | warn | alarm | fault | maintenance | commissioned | offline
    status       = Column(String(30), default="offline")

    # 阈值配置：{"outlet_pressure": {"warn": 7.0, "alarm": 7.5, "unit": "MPa"}}
    thresholds   = Column(JSONB, default={})
    # 3D 位置（Studio 场景坐标）
    position_3d  = Column(JSONB, default={})                   # {"x": 0, "y": 0, "z": 0}
    # Phase B：OPC-UA node id
    opc_node_id  = Column(String(200))

    created_at   = Column(TIMESTAMPTZ, server_default=func.now())
    updated_at   = Column(TIMESTAMPTZ, onupdate=func.now())
```

### 15.3 models/station.py

```python
# models/station.py
from sqlalchemy import Column, String, Float, Boolean
from db.session import Base


class Station(Base):
    """场站基础信息表"""
    __tablename__ = "stations"

    station_id           = Column(String(50), primary_key=True)
    name                 = Column(String(200), nullable=False)
    location             = Column(String(300))
    timezone             = Column(String(50), default="Asia/Shanghai")
    feishu_duty_chat_id  = Column(String(100))   # 值班群 chat_id（告警/晨报发送目标）
    is_active            = Column(Boolean, default=True)
```

### 15.4 models/workorder.py

```python
# models/workorder.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text, JSON, func
from sqlalchemy.dialects.postgresql import JSONB
from db.session import Base


class WorkOrder(Base):
    """工单主表（权威版 — 以 DESIGN-FINAL-LOCK.md §二a 为准）"""
    __tablename__ = "work_orders"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    station_id      = Column(Integer, ForeignKey("stations.id"), nullable=False)
    equipment_id    = Column(String(50), ForeignKey("equipment.id"), nullable=True)

    # 工单类型（权威枚举）: corrective|preventive|inspection|shutdown|emergency|calibration|improvement
    work_type       = Column(String(50), nullable=False)
    work_subtype    = Column(String(100))        # 细分类型（自由文本）
    priority        = Column(String(20), default="normal")  # emergency|urgent|normal|low
    state           = Column(String(30), nullable=False, default="draft")
    # FSM: draft → pending_approval → approved → in_progress → done / rejected

    title           = Column(String(300), nullable=False)
    description     = Column(Text)
    ai_draft        = Column(JSONB, default={})          # AI 生成草稿
    execution_notes = Column(Text)
    completion_evidence = Column(JSONB, default=[])

    # 人员
    created_by      = Column(Integer, ForeignKey("users.id"))
    assignee_id     = Column(Integer, ForeignKey("users.id"))
    approved_by     = Column(Integer, ForeignKey("users.id"))

    # 关联
    trigger_alarm_id = Column(Integer, ForeignKey("alarms.id"))
    shift_record_id  = Column(Integer, ForeignKey("shift_records.id"))

    # 作业许可证（Phase A 预留）
    permit_required  = Column(Boolean, default=False)
    permit_type      = Column(String(50))   # hot_work|cold_work|confined_space|electrical
    permit_number    = Column(String(100))
    permit_status    = Column(String(50))   # pending|approved|active|closed

    # 巡检字段（inspection 类型时使用）
    inspection_route  = Column(String(200))
    checklist_items   = Column(JSONB)
    checklist_results = Column(JSONB)

    # OA 集成
    oa_callback_url  = Column(String(500))
    oa_approval_id   = Column(String(200))

    created_at      = Column(TIMESTAMPTZ, server_default=func.now())
    updated_at      = Column(TIMESTAMPTZ, onupdate=func.now())
    due_at          = Column(TIMESTAMPTZ)
    started_at      = Column(TIMESTAMPTZ)
    completed_at    = Column(TIMESTAMPTZ)
```

### 15.5 models/knowledge.py

```python
# models/knowledge.py
import uuid
from sqlalchemy import Column, String, Text, Integer, DateTime, func
from sqlalchemy.dialects.postgresql import JSONB
from db.session import Base


class KBDocument(Base):
    """知识库文档（L0-L3，PostgreSQL 元数据，向量在 **pgvector**）"""
    __tablename__ = "kb_documents"

    doc_id      = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    layer       = Column(String(5), nullable=False)    # L0|L1|L2|L3
    title       = Column(String(500), nullable=False)
    content     = Column(Text, nullable=False)
    source      = Column(String(300))                  # 来源（manual、work_order_id、etc.）
    equipment_ids = Column(JSONB, default=[])          # 关联设备列表
    station_id  = Column(String(50))
    # 在 **kb_chunks** 中的 doc/chunk id（通常与 PostgreSQL doc_id 对齐）
    milvus_id   = Column(String(36))
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    created_by  = Column(String(36))                   # user_id


class EquipmentReading(Base):
    """设备时序读数（TimescaleDB hypertable）"""
    __tablename__ = "equipment_readings"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    equipment_id = Column(String(50), nullable=False)
    metric       = Column(String(100), nullable=False)
    value        = Column(String(50), nullable=False)  # 存 str 防止精度丢失
    unit         = Column(String(20))
    recorded_at  = Column(DateTime(timezone=True), nullable=False)

    # TimescaleDB hypertable：在 Alembic migration 中执行
    # SELECT create_hypertable('equipment_readings', 'recorded_at', if_not_exists => TRUE);
```

---

## 十六、新增 API 端点（Phase B/C 扩展）

### 16.1 视觉巡检 API

```python
# routers/visual_inspection.py

from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import httpx, base64, json

router = APIRouter(prefix="/v1/visual", tags=["visual_inspection"])


class InspectionResult(BaseModel):
    equipment_id: str
    image_url: str
    captured_at: datetime
    ai_summary: str
    confidence: float
    findings: list[dict]   # [{item, status, confidence, detail}]
    severity: str          # normal | attention | warning | critical
    model: str             # qwen2.5-vl


class TriggerInspectionReq(BaseModel):
    equipment_id: str
    image_base64: Optional[str] = None   # 若不提供，Platform 从摄像头拉取
    camera_url: Optional[str] = None


@router.post("/inspect", response_model=InspectionResult)
async def trigger_inspection(
    req: TriggerInspectionReq,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """触发单台设备视觉巡检。Phase A: 接受 Base64 图片；Phase B: 自动拉取摄像头。"""
    # 1. 取图像
    if req.image_base64:
        image_data = req.image_base64
    elif req.camera_url:
        async with httpx.AsyncClient(timeout=10) as c:
            resp = await c.get(req.camera_url)
            image_data = base64.b64encode(resp.content).decode()
    else:
        raise HTTPException(400, "需要提供 image_base64 或 camera_url")

    # 2. 调 Qwen2.5-VL（vLLM OpenAI-compatible API）
    vl_prompt = """分析这张工业设备图片，检查：
1. 是否有液体泄漏（油、水、气体凝液）
2. 仪表是否清晰可读
3. 外壳是否有腐蚀、变形或损伤
4. 是否有结霜、过热等异常迹象
5. 管道连接处是否正常

输出 JSON 格式：
{
  "summary": "一句话总结",
  "severity": "normal|attention|warning|critical",
  "findings": [
    {"item": "检查项", "status": "ok|attention|warning|critical", "confidence": 0.95, "detail": "详情"}
  ]
}"""

    async with httpx.AsyncClient(timeout=60) as c:
        vl_resp = await c.post(
            f"{settings.llm_base_url}/v1/chat/completions",
            json={
                "model": "qwen2.5-vl-7b-instruct",
                "messages": [
                    {"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}},
                        {"type": "text", "text": vl_prompt}
                    ]}
                ],
                "temperature": 0.1,
                "response_format": {"type": "json_object"}
            }
        )

    raw = vl_resp.json()["choices"][0]["message"]["content"]
    analysis = json.loads(raw)

    # 3. 计算整体置信度（取 findings 平均值）
    findings = analysis.get("findings", [])
    overall_conf = sum(f["confidence"] for f in findings) / max(len(findings), 1)

    result = InspectionResult(
        equipment_id=req.equipment_id,
        image_url="",    # Phase B: 存 MinIO 返回 URL
        captured_at=datetime.utcnow(),
        ai_summary=analysis.get("summary", ""),
        confidence=round(overall_conf, 3),
        findings=findings,
        severity=analysis.get("severity", "normal"),
        model="qwen2.5-vl-7b-instruct"
    )

    # 4. 高风险自动推送飞书
    if result.severity in ("warning", "critical"):
        await FeishuClient.send_visual_alert(req.equipment_id, result)

    # 5. 写入巡检记录（省略 DB 保存代码，思路同 WorkOrder）
    return result


@router.get("/history/{equipment_id}")
async def get_inspection_history(
    equipment_id: str,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """获取设备视觉巡检历史记录"""
    # SELECT * FROM visual_inspections WHERE equipment_id = :id ORDER BY captured_at DESC LIMIT :limit
    return {"equipment_id": equipment_id, "records": [], "total": 0}
```

### 16.2 能耗监控 API

```python
# routers/energy.py
# 基于 TimescaleDB 的能耗数据聚合与 CoolProp 物理约束校验

from fastapi import APIRouter, Depends, Query
from datetime import datetime, timedelta
from typing import Literal

router = APIRouter(prefix="/v1/energy", tags=["energy"])


class EnergyKPIResponse(BaseModel):
    station_id: str
    period_start: datetime
    period_end: datetime
    total_power_kwh: float
    unit_energy_kwh_per_km3: float    # 万方天然气耗电量（行业标准指标）
    efficiency_actual: float           # 实际效率（%）
    efficiency_theoretical: float      # CoolProp 计算理论效率（%）
    efficiency_gap: float              # 效率差距（pct points）
    carbon_kg_co2: float               # 碳排放（千克 CO2 当量）
    cost_cny: float                    # 电费（元）
    optimization_hint: Optional[str]   # AI 优化建议（若效率差 > 5%）


@router.get("/kpi/{station_id}", response_model=EnergyKPIResponse)
async def get_energy_kpi(
    station_id: str,
    period: Literal["day", "week", "month"] = "day",
    date: Optional[str] = Query(None, description="YYYY-MM-DD，默认昨日"),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    获取场站能耗 KPI。
    - total_power_kwh：从 equipment_readings WHERE metric='power_kw' 聚合
    - unit_energy：按输气量计算单位能耗
    - efficiency_theoretical：调用 CoolProp 基于当前温压计算理论压缩效率
    - carbon：power_kwh * 0.581 kg/kWh（华北电网碳排放因子）
    """
    # Phase A: 基于 mock 数据返回示例数据
    # Phase B: 接入真实 TimescaleDB 数据 + CoolProp 计算
    return EnergyKPIResponse(
        station_id=station_id,
        period_start=datetime.utcnow() - timedelta(days=1),
        period_end=datetime.utcnow(),
        total_power_kwh=12450.0,
        unit_energy_kwh_per_km3=82.3,
        efficiency_actual=84.2,
        efficiency_theoretical=87.1,
        efficiency_gap=2.9,
        carbon_kg_co2=7233.45,
        cost_cny=7468.2,
        optimization_hint="进口温度可降低 2°C，预计效率提升 1.5-2%，节省 ¥120/天"
    )


@router.get("/trend/{station_id}")
async def get_energy_trend(
    station_id: str,
    days: int = 30,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """获取能耗趋势数据（用于 Studio Trend View）"""
    # TimescaleDB time_bucket 聚合
    return {"station_id": station_id, "days": days, "data": []}
```

### 16.3 知识图谱 API（Apache AGE）

```python
# routers/knowledge_graph.py
# 通过 Apache AGE（PostgreSQL 扩展）提供因果关系查询

from fastapi import APIRouter, Depends
from pydantic import BaseModel

router = APIRouter(prefix="/v1/graph", tags=["knowledge_graph"])


class GraphQueryReq(BaseModel):
    cypher: str                          # Cypher 查询语句
    equipment_id: Optional[str] = None  # 限定设备范围（安全过滤）
    limit: int = 20


@router.post("/query")
async def query_knowledge_graph(
    req: GraphQueryReq,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    执行 Cypher 查询 AGE 因果知识图谱。

    示例查询（AI 调用此工具时自动生成）：
    MATCH (e:Equipment {id: 'C-001'})-[:CAUSES]->(f:Failure)
    RETURN e, f LIMIT 10

    图谱数据来源：
    - 设备/故障节点：Ontology 导入时创建
    - CAUSES/MITIGATES 边：AI 从 L3 工单中自动提取
    """
    # 安全：只允许 READ-ONLY Cypher（MATCH/RETURN，不允许 CREATE/DELETE）
    safe_cypher = req.cypher.strip().upper()
    if not safe_cypher.startswith("MATCH"):
        return {"error": "仅支持 MATCH 查询"}

    # 执行 AGE Cypher
    age_sql = f"""
    SELECT * FROM cypher('clawtwin_graph', $$
        {req.cypher}
    $$) AS (result agtype);
    """
    try:
        result = await db.execute(age_sql)
        rows = result.fetchall()
        return {"data": [dict(r) for r in rows], "count": len(rows)}
    except Exception as e:
        return {"error": str(e), "cypher": req.cypher}


@router.get("/causal-chain/{equipment_id}")
async def get_causal_chain(
    equipment_id: str,
    failure_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    获取设备的因果关系链（AI 诊断时使用）。
    返回：该设备历史故障的根因 → 故障现象 → 处置方法链

    示例结果：
    [
      {
        "root_cause": "轴承润滑不足",
        "failure": "轴承磨损",
        "symptom": "振动值升高",
        "mitigation": "补充润滑油 + 更换轴承",
        "confidence": 0.85,
        "source_workorders": ["WO-031", "WO-067"]
      }
    ]
    """
    # Phase A: 返回 mock 因果链（**pgvector** L3 检索结果的结构化版本）
    # Phase B: 从 AGE 图谱中实时查询
    return {
        "equipment_id": equipment_id,
        "causal_chains": [
            {
                "root_cause": "轴承润滑不足",
                "failure": "轴承磨损",
                "symptom": "振动值升高（> 3.5 mm/s）",
                "mitigation": "补充润滑油 L-DAB68，检查对中精度",
                "confidence": 0.85,
                "source_workorders": ["WO-031"]
            }
        ]
    }
```

### 16.4 CoolProp 物理计算集成

```python
# services/physics.py
# 基于 CoolProp 的热力学物理约束计算

try:
    import CoolProp.CoolProp as CP
    COOLPROP_AVAILABLE = True
except ImportError:
    COOLPROP_AVAILABLE = False


class CompressorPhysics:
    """往复式/离心式压缩机物理约束计算（CoolProp 集成）"""

    @staticmethod
    def theoretical_efficiency(
        fluid: str,           # 'Methane' or 'NaturalGas'
        T_inlet_K: float,     # 进口温度（开尔文）
        P_inlet_Pa: float,    # 进口压力（帕）
        P_outlet_Pa: float,   # 出口压力（帕）
        compression_type: str = "isentropic"  # isentropic | polytropic
    ) -> dict:
        """
        计算理论压缩效率（用于与实测值对比，判断性能退化）

        返回：
        {
          "isentropic_efficiency": 0.87,  # 等熵效率
          "compression_ratio": 4.2,
          "T_outlet_theoretical_K": 423.5,
          "power_per_flow_kw_per_kgs": 185.3,
          "notes": ""
        }
        """
        if not COOLPROP_AVAILABLE:
            return {"error": "CoolProp 未安装，无法计算理论效率", "fallback": True}

        try:
            # 等熵压缩：计算出口温度
            H_inlet = CP.PropsSI("H", "T", T_inlet_K, "P", P_inlet_Pa, fluid)
            S_inlet = CP.PropsSI("S", "T", T_inlet_K, "P", P_inlet_Pa, fluid)

            # 等熵出口焓（理论值）
            H_outlet_isentropic = CP.PropsSI("H", "S", S_inlet, "P", P_outlet_Pa, fluid)
            T_outlet_isentropic = CP.PropsSI("T", "S", S_inlet, "P", P_outlet_Pa, fluid)

            compression_ratio = P_outlet_Pa / P_inlet_Pa
            isentropic_work = H_outlet_isentropic - H_inlet  # J/kg

            return {
                "isentropic_efficiency": 0.87,   # 实际 = 等熵功 / 实际功（需实测值）
                "compression_ratio": round(compression_ratio, 2),
                "T_outlet_theoretical_K": round(T_outlet_isentropic, 1),
                "isentropic_work_kj_per_kg": round(isentropic_work / 1000, 2),
                "notes": f"基于 {fluid}，等熵假设"
            }
        except Exception as e:
            return {"error": str(e), "fallback": True}

    @staticmethod
    def energy_optimization_hint(
        actual_efficiency: float,
        theoretical_efficiency: float,
        T_inlet_K: float,
        gap_threshold: float = 0.05    # 5% 效率差触发优化建议
    ) -> Optional[str]:
        """
        如果实际效率与理论效率差距超过阈值，生成优化建议
        """
        gap = theoretical_efficiency - actual_efficiency
        if gap < gap_threshold:
            return None

        hints = []
        if T_inlet_K > 308:  # 进口温度超过 35°C
            delta_t = T_inlet_K - 305
            est_improvement = delta_t * 0.005   # 经验值：降温 1°C 约提升 0.5%
            hints.append(f"进口温度偏高 {delta_t:.1f}K，降温可提升效率约 {est_improvement:.1%}")

        hints.append(f"当前效率 {actual_efficiency:.1%}，理论 {theoretical_efficiency:.1%}，差距 {gap:.1%}")
        hints.append("建议安排设备检查：气阀磨损、活塞环泄漏、余隙容积异常")

        return "；".join(hints)


# requirements.txt 追加：
# CoolProp>=6.4.1
# pyomo>=6.7.0    # 优化计算（Phase B）
```

### 16.5 requirements.txt 补充依赖

在现有 `requirements.txt` 末尾追加：

```txt
# ── Phase B 物理计算层 ─────────────────────────────────────────
CoolProp>=6.4.1             # 热力学物理约束计算
pyomo>=6.7.0                # 优化问题建模（能耗优化）

# ── Phase B 图数据库 ──────────────────────────────────────────
age>=1.5.0                  # Apache AGE（需 PostgreSQL 16 插件）

# ── Phase B 视觉 AI ───────────────────────────────────────────
Pillow>=10.0.0              # 图像预处理
httpx[http2]>=0.27.0        # 已有，确认版本

# ── 监控 ──────────────────────────────────────────────────────
prometheus-client>=0.20.0   # FastAPI 指标暴露（配合 Grafana）
opentelemetry-api>=1.24.0   # 分布式 Tracing
```

---

## 十七、决策驱动 API 补全（对应 Studio DeviceIntelPanel V2）

> 本节补全 MODULE-DESIGN-STUDIO §27-31 中 Studio 调用、但 Platform 之前未定义的端点。  
> 这是 Phase A 开发的关键合约——前后端必须对齐这些接口才能联调。

### 17.1 AI 诊断端点（扩展版，含 primary_action）

```python
# routers/tools.py —— 对 diagnose_equipment 的关键扩展

from pydantic import BaseModel
from typing import Optional, Literal

class PrimaryAction(BaseModel):
    label: str                  # "立即通知现场操作员"
    icon: str                   # "🚨"
    color: Literal["red", "orange", "blue", "green"]
    reason: str                 # AI 给出的简短理由（1-2 句）
    action_type: Literal["create_wo", "notify", "inspect", "schedule"]
    urgent: bool

class DiagnosisResult(BaseModel):
    equipment_id: str
    summary: str                # AI 诊断摘要（markdown，< 200 字）
    confidence: float           # 0.0 - 1.0
    citations: list[dict]       # [{"label": "文档名", "link": "/kb/xxx"}]
    primary_action: Optional[PrimaryAction]     # ← 新增
    predicted_breach_minutes: Optional[int]     # ← 新增（None = 无预测）
    data_quality_issues: list[dict] = []        # 数据质量问题列表
    thinking_used: bool = False                 # 是否使用了 Thinking 模式
    model: str = "qwen3-standard"


def compute_primary_action(
    status: str,
    health_score: Optional[float],
    urgency_minutes: Optional[int],
    active_alarms: list,
) -> Optional[PrimaryAction]:
    """
    Platform 端计算 One Big Action（前端只负责渲染，不做判断）。
    优先级：P1告警 > 超限倒计时 < 2h > 低健康分 > 无行动
    """
    p1_alarms = [a for a in active_alarms if a.get("priority") == "P1"]

    if p1_alarms:
        return PrimaryAction(
            label="立即通知现场操作员",
            icon="🚨",
            color="red",
            reason=f"P1 告警：{p1_alarms[0].get('message', '')}（{len(p1_alarms)} 条未处理）",
            action_type="notify",
            urgent=True,
        )

    if urgency_minutes is not None and urgency_minutes < 120:
        h = urgency_minutes // 60
        m = urgency_minutes % 60
        return PrimaryAction(
            label="建紧急预防性工单",
            icon="⚠️",
            color="orange",
            reason=f"预计 {h}h{m:02d}m 后超限，建议立即安排检查",
            action_type="create_wo",
            urgent=True,
        )

    if health_score is not None and health_score < 65:
        return PrimaryAction(
            label="建预防性维保工单",
            icon="🔧",
            color="blue",
            reason=f"健康评分 {health_score:.0f}，建议本周内安排预防性维保",
            action_type="create_wo",
            urgent=False,
        )

    return None   # 设备健康，不显示主行动


@router.post("/tools/diagnose_equipment", response_model=DiagnosisResult)
async def diagnose_equipment(
    equipment_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    AI 诊断端点（Studio DeviceIntelPanel 核心调用）。
    内部流程：
      1. 权限校验（require_station）
      2. 数据质量预检（DataQualityChecker）
      3. 构造设备上下文（build_equipment_context）
      4. 获取活跃告警
      5. vLLM 推理（快速模式 standard，异常复杂时自动升级 thinking）
      6. compute_primary_action 计算主行动
      7. 写审计日志
    """
    # 1. 权限
    eq = await get_equipment_or_404(equipment_id, db)
    require_station(eq.station_id, current_user)

    # 2. 数据质量预检
    checker = DataQualityChecker()
    quality_issues = await checker.check(equipment_id, db)
    critical_issues = [i for i in quality_issues if i["severity"] == "critical"]
    if len(critical_issues) >= 2:
        return DiagnosisResult(
            equipment_id=equipment_id,
            summary="⚠️ 数据质量不足，AI 诊断暂停。请检查传感器连接。",
            confidence=0.0,
            citations=[],
            primary_action=None,
            predicted_breach_minutes=None,
            data_quality_issues=quality_issues,
        )

    # 3. 构造上下文
    context = await build_equipment_context(equipment_id, db)

    # 4. 活跃告警
    active_alarms = await get_active_alarms_for_equipment(equipment_id, db)

    # 5. LLM 诊断（简化调用，完整实现在 §十 services/vllm.py）
    use_thinking = eq.equipment_type in ("compressor", "pump") and len(active_alarms) > 0
    model_key = "thinking" if use_thinking else "standard"

    diagnosis_prompt = f"""你是油气场站设备诊断专家。请基于以下信息诊断设备状态：

{context}

要求：
- 摘要 ≤ 150 字，结构清晰
- 置信度 0.0-1.0（数据充分时 ≥ 0.7）
- 必须引用知识来源
- 如能预测超限时间，请给出分钟数

输出 JSON：
{{
  "summary": "...",
  "confidence": 0.85,
  "citations": [{{"label": "文档名", "link": "URL"}}],
  "predicted_breach_minutes": null
}}"""

    from services.vllm import VLLMClient
    result = await VLLMClient.chat(
        messages=[{"role": "user", "content": diagnosis_prompt}],
        model=model_key,
        response_format="json",
    )

    # 6. 计算主行动
    hs_row = await get_health_score_cached(equipment_id, db)
    primary_action = compute_primary_action(
        status=eq.status,
        health_score=hs_row.overall_score if hs_row else None,
        urgency_minutes=result.get("predicted_breach_minutes"),
        active_alarms=[a.__dict__ for a in active_alarms],
    )

    # 7. 审计
    await audit_log(current_user.id, "equipment.diagnose", {"equipment_id": equipment_id}, db)

    return DiagnosisResult(
        equipment_id=equipment_id,
        summary=result["summary"],
        confidence=result["confidence"],
        citations=result.get("citations", []),
        primary_action=primary_action,
        predicted_breach_minutes=result.get("predicted_breach_minutes"),
        data_quality_issues=quality_issues,
        thinking_used=use_thinking,
        model=model_key,
    )
```

---

### 17.2 设备健康评分端点

```python
# routers/equipment.py 追加

from pydantic import BaseModel

class DimensionScore(BaseModel):
    key: str         # "vibration" | "thermal" | "lubrication" | "runtime"
    label: str       # "振动" | "温度" | "润滑" | "运行时长"
    score: float     # 0-100
    trend: Literal["up", "down", "flat"]
    delta: float     # 与上次评分的差值
    status_text: str # "正常" | "注意" | "警告"

class HealthScoreResult(BaseModel):
    equipment_id: str
    overall_score: float
    overall_trend: Literal["up", "down", "flat"]
    overall_delta: float
    dimensions: list[DimensionScore]
    ai_summary: str
    ai_confidence: float
    scored_at: datetime

@router.get("/{equipment_id}/health-score", response_model=HealthScoreResult)
async def get_health_score(
    equipment_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    设备多维健康评分（NavRail 热力图 + DeviceIntelPanel HealthScoreCard 用）。
    评分算法：
      · 振动维度（30%）：当前值/告警阈值 → 0-100 线性映射
      · 温度维度（25%）：当前值与正常运行温度区间的偏差
      · 润滑维度（25%）：基于上次维保工单的时间衰减 + 运行小时数
      · 运行时长维度（20%）：运行小时 vs. 大修间隔的比例
    Phase A：润滑和运行时长用 mock 计算（无真实维保数据）
    Phase B：从 IMS 工单历史计算
    """
    eq = await get_equipment_or_404(equipment_id, db)
    require_station(eq.station_id, current_user)

    # Phase A 简化实现：基于实时指标计算前两个维度，后两个固定
    readings = await get_latest_readings(equipment_id, db)
    vib_val = readings.get("vibration", {}).get("value", 0)
    temp_val = readings.get("outlet_temp", {}).get("value", 0)

    vib_alarm = eq.thresholds.get("vibration", {}).get("alarm", 10.0) if eq.thresholds else 10.0
    temp_alarm = eq.thresholds.get("outlet_temp", {}).get("alarm", 95.0) if eq.thresholds else 95.0

    vib_score  = max(0, min(100, 100 - (vib_val / vib_alarm) * 100))
    temp_score = max(0, min(100, 100 - (temp_val / temp_alarm) * 100))

    dimensions = [
        DimensionScore(key="vibration",  label="振动",   score=vib_score,  trend="flat", delta=0, status_text="正常" if vib_score > 70 else "警告"),
        DimensionScore(key="thermal",    label="温度",   score=temp_score, trend="flat", delta=0, status_text="正常" if temp_score > 70 else "警告"),
        DimensionScore(key="lubrication",label="润滑",   score=80.0,       trend="flat", delta=0, status_text="正常"),  # Phase A mock
        DimensionScore(key="runtime",    label="运行时长", score=75.0,      trend="down", delta=-2, status_text="注意"),  # Phase A mock
    ]

    overall = sum(d.score * w for d, w in zip(dimensions, [0.30, 0.25, 0.25, 0.20]))
    ai_summary = f"综合健康评分 {overall:.0f}，" + (
        "振动和温度指标处于正常范围。" if overall > 75 else
        "存在需要关注的异常指标，建议近期安排检查。"
    )

    return HealthScoreResult(
        equipment_id=equipment_id,
        overall_score=round(overall, 1),
        overall_trend="flat",
        overall_delta=0,
        dimensions=dimensions,
        ai_summary=ai_summary,
        ai_confidence=0.75,
        scored_at=datetime.utcnow(),
    )
```

---

### 17.3 振动频谱端点

```python
# routers/equipment.py 追加

@router.get("/{equipment_id}/spectrum")
async def get_vibration_spectrum(
    equipment_id: str,
    window: str = "60s",   # "60s" | "5m" | "1h"
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    FFT 振动频谱分析。Phase A：从最近 60 条读数计算；Phase B：真实高频数据。
    返回：频率-幅值对 + AI 解读文字
    """
    eq = await get_equipment_or_404(equipment_id, db)
    require_station(eq.station_id, current_user)

    if not eq.thresholds or "vibration" not in (eq.thresholds or {}):
        return {"error": "该设备无振动传感器配置", "spectrum": []}

    rows = await db.execute(
        select(EquipmentReading)
        .where(EquipmentReading.equipment_id == equipment_id)
        .where(EquipmentReading.metric_name == "vibration")
        .order_by(EquipmentReading.recorded_at.desc())
        .limit(128)
    )
    readings = rows.scalars().all()

    if len(readings) < 16:
        return {"error": "振动数据不足（< 16 条），无法计算频谱", "spectrum": []}

    values = [float(r.value) for r in reversed(readings)]

    import numpy as np
    n = len(values)
    sample_rate_hz = 100   # Phase A: 假设 100 Hz（实际 Phase B 从读数时间戳计算）
    fft_vals = np.abs(np.fft.rfft(values)) / n
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate_hz)

    spectrum = [
        {"freq_hz": round(float(f), 2), "amplitude": round(float(a), 6)}
        for f, a in zip(freqs[1:], fft_vals[1:])  # 跳过 DC 分量
    ]

    # Phase A mock AI 解读
    peak_idx = int(np.argmax(fft_vals[1:])) + 1
    peak_freq = float(freqs[peak_idx])
    ai_interpretation = (
        f"主频 {peak_freq:.1f} Hz（对应转速 {peak_freq * 60:.0f} RPM）。"
        + ("频谱正常，未检测到特征故障频率。" if float(fft_vals[peak_idx]) < 2.0
           else "存在异常谐波分量，建议结合趋势分析判断轴承状态。")
    )

    return {
        "equipment_id": equipment_id,
        "spectrum": spectrum,
        "peak_freq_hz": peak_freq,
        "sample_rate_hz": sample_rate_hz,
        "sample_count": n,
        "ai_interpretation": ai_interpretation,
        "window": window,
    }
```

---

### 17.4 工单 AI 草稿端点

```python
# routers/workorders.py 追加

class AIDraftRequest(BaseModel):
    equipment_id: str
    context_hint: Optional[str] = None  # 操作员补充说明（可选）

class AIDraftResult(BaseModel):
    title: str
    priority: Literal["P1", "P2", "P3"]
    description: str
    suggested_assignee: Optional[str] = None   # 建议指派人（根据值班表）
    estimated_duration_hours: Optional[float] = None

@router.post("/workorders/ai-draft", response_model=AIDraftResult)
async def ai_draft_workorder(
    req: AIDraftRequest,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    基于最新 AI 诊断结果生成工单草稿（供 WorkOrderDraftInline 预填）。
    优先使用缓存的诊断结果（Redis），避免重复调用 LLM。
    """
    eq = await get_equipment_or_404(req.equipment_id, db)
    require_station(eq.station_id, current_user)

    # 尝试获取缓存诊断（diagnose_equipment 调用后 5 分钟内有效）
    import aioredis, json as _json
    redis = aioredis.from_url(settings.redis_url)
    cached = await redis.get(f"diagnosis:{req.equipment_id}")
    diag = _json.loads(cached) if cached else None

    # 基于诊断生成草稿
    pa = diag.get("primary_action") if diag else None
    pa_label = pa.get("label", "") if pa else ""
    pa_reason = pa.get("reason", "") if pa else ""
    is_urgent = pa.get("urgent", False) if pa else False
    breach_min = diag.get("predicted_breach_minutes") if diag else None

    title = pa_label or f"{eq.name} 预防性检查"
    priority = "P1" if is_urgent else "P2"

    breach_info = ""
    if breach_min is not None and breach_min < 480:
        breach_info = f"\n\n⚠️ AI 预测：约 {breach_min // 60}h{breach_min % 60:02d}m 后超限。"

    description = (
        f"**设备**：{eq.name}（{req.equipment_id}）\n\n"
        f"**AI 诊断**：{diag.get('summary', '无诊断摘要') if diag else '请填写情况描述'}\n\n"
        f"**建议行动**：{pa_reason}"
        + breach_info
        + (f"\n\n**操作员补充**：{req.context_hint}" if req.context_hint else "")
        + "\n\n**执行要求**：\n1. 现场确认设备状态\n2. 记录实测数据\n3. 完成后上传现场照片"
    )

    return AIDraftResult(
        title=title,
        priority=priority,
        description=description,
        estimated_duration_hours=2.0 if priority == "P1" else 4.0,
    )
```

---

### 17.5 全局搜索端点（CommandPalette 用）

```python
# routers/search.py（新建文件）

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/v1/search", tags=["search"])

class SearchResultItem(BaseModel):
    id: str
    type: Literal["equipment", "workorder", "alarm", "knowledge"]
    title: str
    subtitle: str
    status: Optional[str] = None
    equipment_id: Optional[str] = None   # alarm/workorder 关联设备

@router.get("", response_model=dict)
async def global_search(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(8, le=20),
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    全局搜索（Cmd+K CommandPalette 用）。
    搜索范围：设备名/ID、工单标题、活跃告警、KB文档标题。
    权限过滤：只返回用户有权限的场站数据。
    """
    results: list[SearchResultItem] = []
    q_lower = q.lower()

    # 1. 设备（精确匹配 equipment_id 或模糊匹配 name）
    eq_rows = await db.execute(
        select(Equipment)
        .where(Equipment.station_id.in_(current_user.station_ids))
        .where(or_(
            Equipment.equipment_id.ilike(f"%{q}%"),
            Equipment.name.ilike(f"%{q}%"),
        ))
        .limit(limit)
    )
    for eq in eq_rows.scalars():
        results.append(SearchResultItem(
            id=eq.equipment_id, type="equipment",
            title=eq.name, subtitle=eq.equipment_id,
            status=eq.status,
        ))

    # 2. 工单（标题模糊匹配）
    if len(results) < limit:
        wo_rows = await db.execute(
            select(WorkOrder)
            .where(WorkOrder.station_id.in_(current_user.station_ids))
            .where(WorkOrder.title.ilike(f"%{q}%"))
            .limit(limit - len(results))
        )
        for wo in wo_rows.scalars():
            results.append(SearchResultItem(
                id=wo.wo_id, type="workorder",
                title=wo.title, subtitle=f"{wo.state} · {wo.equipment_id}",
                status=wo.state, equipment_id=wo.equipment_id,
            ))

    # 3. 知识文档（标题模糊匹配，不做向量搜索，只做标题检索）
    if len(results) < limit:
        kb_rows = await db.execute(
            select(KBDocument)
            .where(KBDocument.title.ilike(f"%{q}%"))
            .limit(limit - len(results))
        )
        for doc in kb_rows.scalars():
            results.append(SearchResultItem(
                id=doc.doc_id, type="knowledge",
                title=doc.title, subtitle=f"L{doc.layer} · {doc.source}",
            ))

    return {"results": results[:limit], "total": len(results)}
```

---

### 17.6 站场热力图端点（NavRail StationHeatmap 用）

```python
# routers/stations.py 追加

class AreaStatus(BaseModel):
    area_name: str                                    # "压缩机区" | "计量区" | "阀组区"
    status: Literal["normal", "warn", "alarm", "offline"]
    equipment_count: int
    alarm_count: int
    warn_count: int

class StationHealthSummary(BaseModel):
    station_id: str
    areas: list[AreaStatus]
    overall_status: Literal["normal", "warn", "alarm", "offline"]
    total_equipment: int
    total_alarms: int
    updated_at: datetime

@router.get("/{station_id}/health-summary", response_model=StationHealthSummary)
async def get_station_health_summary(
    station_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    场站健康摘要（NavRail StationHeatmap 用）。
    按 equipment.area 字段分组，计算各区域状态。
    Phase A：equipment.area 从 mock 数据中取（如 "压缩机区"/"计量区"/"阀组区"）
    """
    require_station(station_id, current_user)

    eq_rows = await db.execute(
        select(Equipment).where(Equipment.station_id == station_id)
    )
    equipments = eq_rows.scalars().all()

    # 按区域分组
    area_map: dict[str, list] = {}
    for eq in equipments:
        area = eq.area or "未分区"
        area_map.setdefault(area, []).append(eq)

    def area_status(eqs: list) -> Literal["normal", "warn", "alarm", "offline"]:
        statuses = [e.status for e in eqs]
        if "alarm" in statuses:  return "alarm"
        if "warn"  in statuses:  return "warn"
        if all(s == "offline" for s in statuses): return "offline"
        return "normal"

    areas = [
        AreaStatus(
            area_name=name,
            status=area_status(eqs),
            equipment_count=len(eqs),
            alarm_count=sum(1 for e in eqs if e.status == "alarm"),
            warn_count=sum(1 for e in eqs if e.status == "warn"),
        )
        for name, eqs in sorted(area_map.items())
    ]

    total_alarms = sum(a.alarm_count for a in areas)
    overall = "alarm" if any(a.status == "alarm" for a in areas) else \
              "warn"  if any(a.status == "warn"  for a in areas) else "normal"

    return StationHealthSummary(
        station_id=station_id,
        areas=areas,
        overall_status=overall,
        total_equipment=len(equipments),
        total_alarms=total_alarms,
        updated_at=datetime.utcnow(),
    )
```

---

### 17.7 ISA-18.2 告警管理端点

```python
# routers/alarms.py（新建文件）

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional, Literal

router = APIRouter(prefix="/v1/alarms", tags=["alarms"])

# Alarm ORM Model（需在 models/alarm.py 中定义）
# class Alarm(Base):
#     __tablename__ = "alarms"
#     alarm_id = Column(String, primary_key=True, default=lambda: f"A-{uuid4().hex[:8].upper()}")
#     equipment_id = Column(String, ForeignKey("equipment.equipment_id"))
#     station_id = Column(String, ForeignKey("stations.station_id"))
#     priority = Column(Enum("P1","P2","P3","P4"), nullable=False)
#     message = Column(Text, nullable=False)
#     state = Column(Enum("active","acknowledged","shelved","resolved"), default="active")
#     triggered_at = Column(DateTime, default=datetime.utcnow)
#     acknowledged_at = Column(DateTime, nullable=True)
#     shelved_until = Column(DateTime, nullable=True)
#     shelved_by = Column(String, nullable=True)
#     count = Column(Integer, default=1)   # ISA-18.2 去重计数

@router.get("/active")
async def get_active_alarms(
    station_id: Optional[str] = None,
    equipment_id: Optional[str] = None,
    priority: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """获取活跃告警列表（State = active 或 acknowledged）。"""
    query = select(Alarm).where(Alarm.state.in_(["active", "acknowledged"]))

    if station_id:
        require_station(station_id, current_user)
        query = query.where(Alarm.station_id == station_id)
    else:
        query = query.where(Alarm.station_id.in_(current_user.station_ids))

    if equipment_id:
        query = query.where(Alarm.equipment_id == equipment_id)
    if priority:
        query = query.where(Alarm.priority == priority)

    rows = await db.execute(query.order_by(Alarm.priority, Alarm.triggered_at.desc()))
    alarms = rows.scalars().all()
    return {"alarms": alarms, "total": len(alarms)}


@router.post("/{alarm_id}/acknowledge")
async def acknowledge_alarm(
    alarm_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """确认告警（ISA-18.2 Acknowledge 状态）。"""
    alarm = await get_alarm_or_404(alarm_id, db)
    require_station(alarm.station_id, current_user)

    alarm.state = "acknowledged"
    alarm.acknowledged_at = datetime.utcnow()
    await db.commit()
    await audit_log(current_user.id, "alarm.acknowledge", {"alarm_id": alarm_id}, db)
    return {"ok": True}


class ShelveRequest(BaseModel):
    duration_minutes: Literal[30, 60, 480]  # ISA-18.2 建议搁置选项
    reason: Optional[str] = None

@router.post("/{alarm_id}/shelve")
async def shelve_alarm(
    alarm_id: str,
    req: ShelveRequest,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """搁置告警（ISA-18.2 Suppressed 状态，到期自动恢复）。"""
    alarm = await get_alarm_or_404(alarm_id, db)
    require_station(alarm.station_id, current_user)

    alarm.state = "shelved"
    alarm.shelved_until = datetime.utcnow() + timedelta(minutes=req.duration_minutes)
    alarm.shelved_by = current_user.username
    await db.commit()
    await audit_log(current_user.id, "alarm.shelve",
        {"alarm_id": alarm_id, "duration_min": req.duration_minutes}, db)
    return {"ok": True, "shelved_until": alarm.shelved_until.isoformat()}


@router.get("/stats")
async def get_alarm_stats(
    station_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    告警 KPI 统计（ISA-18.2 对标）。
    目标：告警率 ≤ 1 条/10分钟（正常工况）
    """
    require_station(station_id, current_user)

    now = datetime.utcnow()
    one_hour_ago = now - timedelta(hours=1)

    # 最近 1 小时告警数
    count_result = await db.execute(
        select(func.count(Alarm.alarm_id))
        .where(Alarm.station_id == station_id)
        .where(Alarm.triggered_at >= one_hour_ago)
    )
    hourly_count = count_result.scalar()

    # P1 平均响应时间（分钟）
    p1_result = await db.execute(
        select(func.avg(
            func.extract("epoch", Alarm.acknowledged_at - Alarm.triggered_at) / 60
        ))
        .where(Alarm.station_id == station_id)
        .where(Alarm.priority == "P1")
        .where(Alarm.acknowledged_at.isnot(None))
        .where(Alarm.triggered_at >= now - timedelta(days=7))
    )
    avg_p1_response_min = float(p1_result.scalar() or 0)

    rate_per_10min = hourly_count / 6  # ISA-18.2 标准单位
    isa_status = "compliant" if rate_per_10min <= 1.0 else "overloaded"

    return {
        "station_id": station_id,
        "hourly_alarm_count": hourly_count,
        "rate_per_10min": round(rate_per_10min, 2),
        "isa_18_2_status": isa_status,
        "avg_p1_response_min": round(avg_p1_response_min, 1),
        "target_rate": 1.0,
    }
```

---

### 17.8 班次交接端点

```python
# routers/shifts.py（新建文件）

from fastapi import APIRouter, Depends
from pydantic import BaseModel

router = APIRouter(prefix="/v1/shifts", tags=["shifts"])

class HandoverRequest(BaseModel):
    station_id: str
    to_user_id: str
    notes: Optional[str] = None   # 当班人员手动补充

@router.post("/handover")
async def create_shift_handover(
    req: HandoverRequest,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    生成班次交接报告并推送飞书。
    内容：本班告警摘要 + 未完成工单 + 搁置中告警 + AI 建议（Phase B 加 MOIRAI 预测）
    """
    require_station(req.station_id, current_user)

    shift_start = datetime.utcnow() - timedelta(hours=8)

    # 1. 本班处理的告警
    handled = await db.execute(
        select(Alarm)
        .where(Alarm.station_id == req.station_id)
        .where(Alarm.triggered_at >= shift_start)
        .where(Alarm.state.in_(["acknowledged", "resolved"]))
    )
    handled_alarms = handled.scalars().all()

    # 2. 未完成工单（接班人需跟进）
    pending_wo = await db.execute(
        select(WorkOrder)
        .where(WorkOrder.station_id == req.station_id)
        .where(WorkOrder.state.in_(["pending_approval", "approved", "in_progress"]))
    )
    pending_workorders = pending_wo.scalars().all()

    # 3. 搁置中的告警（接班后到期自动恢复）
    shelved = await db.execute(
        select(Alarm)
        .where(Alarm.station_id == req.station_id)
        .where(Alarm.state == "shelved")
        .where(Alarm.shelved_until > datetime.utcnow())
    )
    shelved_alarms = shelved.scalars().all()

    handover_data = {
        "from_user": current_user.username,
        "to_user_id": req.to_user_id,
        "station_id": req.station_id,
        "shift_start": shift_start.isoformat(),
        "shift_end": datetime.utcnow().isoformat(),
        "summary": f"本班处理 {len(handled_alarms)} 个告警，{len(pending_workorders)} 个工单待接手",
        "handled_alarms": [{"alarm_id": a.alarm_id, "message": a.message, "priority": a.priority} for a in handled_alarms],
        "pending_workorders": [{"wo_id": wo.wo_id, "title": wo.title, "state": wo.state} for wo in pending_workorders],
        "shelved_alarms": [{"alarm_id": a.alarm_id, "message": a.message, "shelved_until": a.shelved_until.isoformat()} for a in shelved_alarms],
        "notes": req.notes or "",
        "ai_predictions": ["Phase B 实现：MOIRAI 接班后 8h 趋势预测"],
    }

    # 4. 推送飞书交接卡片
    to_user_row = await db.get(User, req.to_user_id)
    if to_user_row and to_user_row.feishu_open_id:
        await FeishuClient.send_handover_card(to_user_row.feishu_open_id, handover_data)

    await audit_log(current_user.id, "shift.handover",
        {"station_id": req.station_id, "to": req.to_user_id}, db)

    return handover_data


# FeishuClient 追加（services/feishu.py）
# @staticmethod
# async def send_handover_card(open_id: str, data: dict):
#     card = {
#         "config": {"wide_screen_mode": True},
#         "elements": [
#             {"tag": "div", "text": {"tag": "lark_md",
#              "content": f"📋 **班次交接报告**\n{data['summary']}"}},
#             {"tag": "div", "text": {"tag": "lark_md",
#              "content": f"**未完成工单**（{len(data['pending_workorders'])} 条）：\n" +
#              "\n".join(f"- {wo['wo_id']}: {wo['title']}" for wo in data['pending_workorders'][:5])}},
#             {"tag": "div", "text": {"tag": "lark_md",
#              "content": f"**搁置告警**（{len(data['shelved_alarms'])} 条，接班后到期自动恢复）"}},
#         ]
#     }
#     await FeishuClient._send_card(open_id, card)
```

---

### 17.9 main.py router 注册更新

```python
# main.py —— 追加新 router 注册（在现有 include_router 之后）

from routers import (
    auth, equipment, stations, workorders, tools,
    alarms,    # ← 新增
    shifts,    # ← 新增
    search,    # ← 新增
)

app.include_router(alarms.router)
app.include_router(shifts.router)
app.include_router(search.router)
```

---

### 17.10 数据库 Schema 补全（Alarm 表）

```sql
-- migrations/add_alarms_table.sql（Alembic 迁移内容）

CREATE TABLE alarms (
    alarm_id       VARCHAR(32)  PRIMARY KEY DEFAULT ('A-' || upper(substring(gen_random_uuid()::text, 1, 8))),
    equipment_id   VARCHAR(64)  NOT NULL REFERENCES equipment(equipment_id),
    station_id     VARCHAR(64)  NOT NULL REFERENCES stations(station_id),
    priority       VARCHAR(4)   NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
    message        TEXT         NOT NULL,
    state          VARCHAR(16)  NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active','acknowledged','shelved','resolved')),
    triggered_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    shelved_until  TIMESTAMPTZ,
    shelved_by     VARCHAR(64),
    resolved_at    TIMESTAMPTZ,
    count          INTEGER      NOT NULL DEFAULT 1,   -- ISA-18.2 重复计数
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alarms_station_state ON alarms(station_id, state);
CREATE INDEX idx_alarms_equipment      ON alarms(equipment_id, triggered_at DESC);
CREATE INDEX idx_alarms_priority       ON alarms(priority, triggered_at DESC);
```

---

_§十七 新增（2026-05-09）：决策驱动 API 补全。_  
_涵盖：diagnose_equipment 扩展（primary_action + predicted_breach_minutes）/ 健康评分 / 频谱 / 工单 AI 草稿 / 全局搜索 / 热力图 / 告警管理（ISA-18.2）/ 班次交接。_  
_以上端点是 Studio DeviceIntelPanel V2 / NavRail V2 / CommandPalette 的 API 合约。_

---

## 十八、缺口补全（一致性修复，2026-05-09）

> **HTTP 路径/方法裁决（2026-05-12）**：以 **`DESIGN-FINAL-LOCK.md` §一** 为**最高权威**；**`NEXUS-API-REFERENCE.md`** 为联调速查。**§18.6** 与 LOCK 不一致时：**先对齐代码与 LOCK，再回本表**。团队流程：**`TEAM-COLLAB-GUIDE.md` §三 / §四**。

> 修复 Studio 调用但 Platform 之前缺失的端点。  
> **本节是 §七 main.py 路由注册的配套实现，必须随 main.py 同步实现。**

### 18.1 main.py import 语句（完整版）

```python
# platform-api/main.py 顶部 import（替代 §七 的旧版本）
from routers.health          import router as health_router
from routers.auth            import router as auth_router
from routers.equipment       import router as equipment_router      # ← 新
from routers.stations        import router as stations_router       # ← 新
from routers.workorders      import router as workorders_router     # ← 新（含 ai-draft）
from routers.hitl            import router as hitl_router
from routers.alarms          import router as alarms_router         # ← 新（§17.7）
from routers.shifts          import router as shifts_router         # ← 新（§17.8）
from routers.tools           import router as tools_router
from routers.analytics       import router as analytics_router
from routers.search          import router as search_router         # ← 新（§17.5）
from routers.kb              import router as kb_router
from routers.graph           import router as graph_router
from routers.visual          import router as visual_router
from routers.energy          import router as energy_router
from routers.notifications   import router as notifications_router  # ← 新（18.3）
from routers.data            import router as data_router
from routers.ingest          import router as ingest_router
from routers.feishu          import router as feishu_webhook_router
from routers.admin           import router as admin_router
```

---

### 18.2 工单路由整合（routers/workorders.py 完整）

> 将原来散落在 tools/hitl 里的工单逻辑整合到专用 router。

```python
# routers/workorders.py
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional, Literal
import uuid
from datetime import datetime

from db.session import get_db
from auth.depends import get_current_user, require_station
from models.workorder import WorkOrder, WorkOrderState   # ⚠️ 权威见 §19.3
from services.audit import audit_log

router = APIRouter(tags=["workorders"])

# ── 查询工单列表 ───────────────────────────────────────────
@router.get("/")
async def list_workorders(
    station_id: Optional[str] = Query(None),
    equipment_id: Optional[str] = Query(None),
    state: Optional[str] = Query(None),    # ← 参数名 state（非 status），值小写下划线
    limit: int = Query(20, le=100),
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """GET /v1/workorders?station_id=&state= — 工单列表（KanbanPage 用）"""
    from sqlalchemy import select
    query = select(WorkOrder).where(
        WorkOrder.station_id.in_(current_user.station_ids)
    )
    if station_id:
        require_station(station_id, current_user)
        query = query.where(WorkOrder.station_id == station_id)
    if equipment_id:
        query = query.where(WorkOrder.equipment_id == equipment_id)
    if state:
        query = query.where(WorkOrder.state == state)

    query = query.order_by(WorkOrder.created_at.desc()).limit(limit)
    rows = await db.execute(query)
    items = rows.scalars().all()
    return {"items": items, "total": len(items)}


# ── AI 预填草稿（不创建工单）──────────────────────────────
class AIDraftReq(BaseModel):
    equipment_id: str
    context_hint: Optional[str] = None

@router.post("/ai-draft")
async def ai_draft_workorder(
    req: AIDraftReq,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    POST /v1/workorders/ai-draft — AI 生成草稿内容（WorkOrderDraftInline 预填用）。
    ⚠️ 只返回草稿内容，不创建工单记录。
    调用方确认后再 POST /v1/workorders/ 真正创建。
    """
    # （完整实现见 §17.4，此处为路由整合版）
    from routers.diagnosis_helpers import generate_wo_draft
    return await generate_wo_draft(req.equipment_id, req.context_hint, current_user, db)


# ── 创建工单 ───────────────────────────────────────────────
class WorkOrderCreateReq(BaseModel):
    equipment_id: str
    title: str
    priority: Literal["P1", "P2", "P3"]
    description: str

@router.post("/", status_code=201)
async def create_workorder(
    req: WorkOrderCreateReq,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """POST /v1/workorders/ — 创建工单，服务端强制 state=draft"""
    from models.equipment import Equipment
    from sqlalchemy import select
    eq = (await db.execute(select(Equipment).where(
        Equipment.equipment_id == req.equipment_id))).scalar_one_or_none()
    if not eq:
        from fastapi import HTTPException
        raise HTTPException(404, f"设备 {req.equipment_id} 不存在")
    require_station(eq.station_id, current_user)

    wo = WorkOrder(
        wo_id=f"W-{uuid.uuid4().hex[:8].upper()}",
        station_id=eq.station_id,
        equipment_id=req.equipment_id,
        title=req.title,
        priority=req.priority,
        description=req.description,
        state=WorkOrderState.DRAFT,            # 服务端强制，不接受客户端传值
        created_by=current_user.user_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(wo)
    await db.commit()
    await db.refresh(wo)
    await audit_log(current_user.user_id, "workorder.create", {"wo_id": wo.wo_id}, db)
    return wo
```

---

### 18.3 HITL 状态流转（routers/hitl.py 完整路径列表）

```python
# routers/hitl.py — 工单状态变更路由（只做状态流转，不创建工单）

router = APIRouter(tags=["hitl"])

# DRAFT → PENDING_APPROVAL
@router.post("/workorders/{wo_id}/pending")
async def submit_for_approval(wo_id: str, ...):
    """操作员提交审批（创建工单后调用）"""
    # FSM: draft → pending_approval
    # 推送飞书审批卡片给主管

# PENDING_APPROVAL → APPROVED
@router.post("/workorders/{wo_id}/approve")
async def approve_workorder(wo_id: str, ...):
    """主管审批通过（或飞书卡片按钮回调）"""
    # FSM: pending_approval → approved

# PENDING_APPROVAL → DRAFT（退回修改）
@router.post("/workorders/{wo_id}/reject")
async def reject_workorder(wo_id: str, ...):
    """主管驳回"""
    # FSM: pending_approval → draft

# APPROVED → IN_PROGRESS
@router.post("/workorders/{wo_id}/start")
async def start_workorder(wo_id: str, ...):
    """操作员开始执行"""
    # FSM: approved → in_progress

# IN_PROGRESS → DONE
@router.post("/workorders/{wo_id}/done")
async def complete_workorder(wo_id: str, ...):
    """完成工单（可上传现场照片）"""
    # FSM: in_progress → done
    # 触发 write_l3_knowledge()

# 状态机枚举（WorkOrderState，models/workorder.py §19.3）:
# draft → pending_approval → approved → in_progress → done
#                         ↘ draft（reject 退回）
```

**FSM 状态映射表（前端 WorkOrderRow 显示用）**：

```typescript
// Studio 统一状态显示（替代散落各处的重复定义）
export const WO_STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  pending_approval: "待审批",
  approved: "已批准",
  in_progress: "执行中",
  done: "已完成",
  // 注意：不存在 "pending"、"ai_draft"、"DRAFT" 等变体
};

export const WO_STATE_COLORS: Record<string, string> = {
  draft: "text-[#8B949E]",
  pending_approval: "text-[#8B5CF6]", // 紫色：等待人工操作
  approved: "text-[#22C55E]", // 绿色：可以执行
  in_progress: "text-[#1F6FEB]", // 蓝色：进行中
  done: "text-[#6B7280]", // 灰色：已结束
};
```

---

### 18.4 通知端点（routers/notifications.py）

```python
# routers/notifications.py（新建）
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from db.session import get_db
from auth.depends import get_current_user
from services.feishu import FeishuClient
from models.user import User
from sqlalchemy import select

router = APIRouter(tags=["notifications"])

class NotifyOperatorReq(BaseModel):
    equipment_id: str
    message: Optional[str] = None   # 自定义消息，为空时用默认格式

@router.post("/notify-operator")
async def notify_operator(
    req: NotifyOperatorReq,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    POST /v1/notifications/notify-operator
    One Big Action "立即通知现场操作员" 对应的后端实现。
    发送飞书消息给该设备所在场站的所有 operator 角色用户。
    """
    from models.equipment import Equipment
    from sqlalchemy import select
    eq = (await db.execute(select(Equipment).where(
        Equipment.equipment_id == req.equipment_id))).scalar_one_or_none()
    if not eq:
        from fastapi import HTTPException
        raise HTTPException(404, f"设备 {req.equipment_id} 不存在")

    # 查找该场站的操作员
    operators = (await db.execute(
        select(User).where(
            User.station_ids.contains([eq.station_id]),
            User.role == "operator",
            User.feishu_open_id.isnot(None),
        )
    )).scalars().all()

    msg = req.message or f"⚠️ 请注意：{eq.name}（{req.equipment_id}）需要立即现场确认，由 {current_user.username} 发起通知。"

    notified = []
    for op in operators:
        try:
            await FeishuClient.send_text(op.feishu_open_id, msg)
            notified.append(op.username)
        except Exception:
            pass

    await audit_log(current_user.user_id, "notification.send",
        {"equipment_id": req.equipment_id, "notified": notified}, db)

    return {"ok": True, "notified_users": notified, "count": len(notified)}
```

---

### 18.5 P&ID 分析端点（routers/tools.py 追加）

```python
# routers/tools.py 追加（给 PIDView 用）

class PIDAnalysisReq(BaseModel):
    station_id: str
    equipment_ids: list[str] = []   # 空=分析整个场站

@router.post("/analyze_pid")
async def analyze_pid(
    req: PIDAnalysisReq,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    POST /v1/tools/analyze_pid
    分析 P&ID 中当前异常设备，高亮异常流程路径，返回 AI 建议。
    Phase A：基于实时状态数据分析，不解析 DEXPI XML。
    Phase B：解析 P&ID DEXPI 文件，识别实际流程路径。
    """
    require_station(req.station_id, current_user)

    # Phase A 实现：查询所有告警设备，生成文字分析
    from models.equipment import Equipment
    from sqlalchemy import select
    alarm_eqs = (await db.execute(
        select(Equipment)
        .where(Equipment.station_id == req.station_id)
        .where(Equipment.status.in_(["alarm", "warn"]))
    )).scalars().all()

    if not alarm_eqs:
        return {
            "anomaly_paths": [],
            "ai_insight": "当前 P&ID 中无异常设备，工艺流程运行正常。",
            "highlighted_equipment_ids": [],
        }

    insight = f"检测到 {len(alarm_eqs)} 台设备异常：" + \
              "、".join(f"{e.name}（{e.status}）" for e in alarm_eqs[:3]) + \
              "。建议检查相关管路是否有连锁影响。"

    return {
        "anomaly_paths": [e.equipment_id for e in alarm_eqs],
        "ai_insight": insight,
        "highlighted_equipment_ids": [e.equipment_id for e in alarm_eqs],
    }
```

---

### 18.6 API 路径唯一真相表（所有端点规范化）

> **本表**：实现蓝图与叙事参考。**路径字符串**与 **`DESIGN-FINAL-LOCK.md` §一** 冲突时以 LOCK 为准（例如：`/v1/tools/*` 仅 OpenClaw、Studio 走 decision-package + `/v1/ai/jobs`；知识检索 `GET /v1/kb/search`；飞书入口 **`POST /v1/feishu/events`** 等）。冲突备忘见 LOCK §八。联调默认 **127.0.0.1:8000**、pytest **cwd = `platform-api`** 见 `NEXUS-API-REFERENCE.md` 头注、`TESTING-GUIDE.md` §二.0。

```
认证
  POST /v1/auth/login                   邮箱/工号 + 密码 → JWT
  POST /v1/auth/refresh                 刷新 Token
  POST /v1/auth/feishu/bind             绑定飞书 OpenID

设备
  GET  /v1/equipment/{id}               设备详情（含 realtime + thresholds + area）
  GET  /v1/equipment/{id}/realtime      最新读数（轮询，10s TTL）
  GET  /v1/equipment/{id}/health-score  多维健康评分
  GET  /v1/equipment/{id}/spectrum      FFT 振动频谱

场站
  GET  /v1/stations/{id}/equipment      场站设备列表
  GET  /v1/stations/{id}/health-summary 各区域健康状态（热力图用）

工单（CURD）
  GET  /v1/workorders                   工单列表（支持 station_id/equipment_id/status 过滤）
  POST /v1/workorders/ai-draft          AI 预填草稿内容（不创建工单）
  POST /v1/workorders/                  创建工单（服务端强制 state=draft）

工单状态流转（HITL）
  POST /v1/hitl/workorders/{id}/pending  提交审批（draft→pending_approval）
  POST /v1/hitl/workorders/{id}/approve  审批通过（pending_approval→approved）
  POST /v1/hitl/workorders/{id}/reject   驳回（pending_approval→draft）
  POST /v1/hitl/workorders/{id}/start    开始执行（approved→in_progress）
  POST /v1/hitl/workorders/{id}/done     完成（in_progress→done + L3沉淀）

告警（ISA-18.2）
  GET  /v1/alarms/active                活跃告警（支持 station_id/priority 过滤）
  GET  /v1/alarms/stats                 告警 KPI（rate_per_10min/p1_response_min）
  POST /v1/alarms/{id}/acknowledge      确认告警
  POST /v1/alarms/{id}/shelve           搁置告警（30/60/480 分钟）

AI 工具
  POST /v1/tools/diagnose_equipment     AI 诊断（含 primary_action + predicted_breach_minutes）
  POST /v1/tools/ask_knowledge          知识问答（含 citations）
  POST /v1/tools/analyze_trend          趋势分析
  POST /v1/tools/analyze_pid            P&ID 异常分析（高亮异常路径）

通知
  POST /v1/notifications/notify-operator  通知场站操作员（One Big Action）

班次
  POST /v1/shifts/handover              生成班次交接报告并推飞书

搜索
  GET  /v1/search?q=&limit=             全局搜索（设备/工单/知识）

知识库
  POST /v1/kb/upload                    上传文档（PDF/Word → L0/L1）
  POST /v1/kb/search                    语义搜索（三层融合）

知识图谱
  POST /v1/graph/query                  Cypher 只读查询
  GET  /v1/graph/causal-chain/{id}      设备因果推理链

视觉巡检（Phase C）
  POST /v1/visual/inspect               触发视觉巡检（Qwen2.5-VL）
  GET  /v1/visual/history/{id}          视觉巡检历史

能耗监控（Phase C）
  GET  /v1/energy/kpi/{station_id}      能耗 KPI
  GET  /v1/energy/trend/{station_id}    能耗趋势

管理
  GET  /v1/admin/data-quality           数据质量 Dashboard
  POST /v1/admin/service-tokens         创建服务 Token（OpenClaw/HiAgent）
  POST /v1/admin/users/{id}/bind-invite 生成飞书绑定邀请

飞书 Webhook
  POST /v1/feishu/events                飞书消息事件（Bot 对话）
  POST /v1/hitl/workorders/{id}/oa-callback  OA/BPM 审批回调
```

---

_§十八 新增（2026-05-09）：缺口补全，修复 API 合约不一致。_  
_§18.6 与本节上文：路径与 **`DESIGN-FINAL-LOCK.md` §一** 对齐维护；不得以本表覆盖 LOCK §一的裁决。_

---

## 十九、数据模型权威定稿（2026-05-11 更新，替代 §二 和 §十五 的冲突部分）

> **本节是唯一真相。§二（SQL Schema）和 §十五（ORM）若与本节矛盾，以本节为准。**  
> **工单类型和设备状态枚举以 DESIGN-FINAL-LOCK.md §二a 为准。**  
> 开发时直接从本节复制，不要混用旧版本。

### 19.1 work_orders 表（权威版）

```sql
-- ⚠️ 2026-05-11 更新：
-- 1. work_type 枚举统一为 7 种（见 DESIGN-FINAL-LOCK §二a）
-- 2. 新增 work_subtype（细分）、permit_required（PTW预留）、巡检字段
-- 3. 主键改为 SERIAL（避免 UUID 复杂性），外键类型统一为 INT

CREATE TABLE work_orders (
    id                  SERIAL       PRIMARY KEY,
    station_id          INT          NOT NULL REFERENCES stations(id),
    equipment_id        VARCHAR(50)  REFERENCES equipment(id),  -- 允许无设备工单

    -- 工单内容
    title               VARCHAR(300) NOT NULL,
    priority            VARCHAR(20)  NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('emergency','urgent','normal','low')),
    description         TEXT,
    work_type           VARCHAR(50)  NOT NULL,
    -- 【权威枚举】: corrective|preventive|inspection|shutdown|emergency|calibration|improvement
    work_subtype        VARCHAR(100),  -- 细分类型（自由文本）

    -- 状态机（小写下划线，对齐 Studio WorkOrderState 类型，见 §19.3）
    state               VARCHAR(30)  NOT NULL DEFAULT 'draft',
    -- draft → pending_approval → approved → in_progress → done
    --                         ↘ draft（reject 退回修改）
    -- ⚠️ 不使用大写 DRAFT/APPROVED，不使用 CLOSED/CANCELLED

    -- AI 相关
    ai_draft            JSONB        DEFAULT '{}',   -- AI 生成的草稿详情
    ai_confidence       FLOAT,                       -- 0.0-1.0
    citations           JSONB        DEFAULT '[]',   -- [{label, link}]

    -- 执行记录
    execution_notes     TEXT,
    completion_evidence JSONB        DEFAULT '[]',   -- [{type, url, note}]

    -- 审批与时间
    created_by          VARCHAR(36)  REFERENCES users(id),
    approved_by         VARCHAR(36)  REFERENCES users(id),
    started_at          TIMESTAMPTZ,
    approved_at         TIMESTAMPTZ,
    done_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- 飞书
    feishu_card_msg_id  VARCHAR(200)
);

CREATE INDEX idx_workorders_station_state    ON work_orders(station_id, state);
CREATE INDEX idx_workorders_equipment        ON work_orders(equipment_id, created_at DESC);
CREATE INDEX idx_workorders_state_created    ON work_orders(state, created_at DESC);
```

### 19.2 equipment 表补充（area 字段）

```sql
-- 追加到 §二 equipment 表（ALTER TABLE 或 migration）
-- 用于 StationHeatmap 按区域分组

ALTER TABLE equipment
    ADD COLUMN IF NOT EXISTS area VARCHAR(100) DEFAULT '未分区',
    -- 示例值：压缩机区 | 计量区 | 阀组区 | 储罐区 | 泵房 | 配电室
    ADD COLUMN IF NOT EXISTS p_model VARCHAR(50) DEFAULT 'box';
    -- Phase A 3D 模型类型：box（方块占位）| cylinder | sphere（Phase C 替换为真实模型）
```

### 19.3 WorkOrder ORM（权威版，替代 §15.4）

```python
# models/workorder.py（权威版，替代 §15.4 的 WorkOrder 类）

import uuid
import enum
from sqlalchemy import Column, String, Text, Float, Boolean, DateTime, Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from db.session import Base


class WorkOrderState(str, enum.Enum):
    """工单状态枚举（值全部小写下划线，与 Studio TypeScript 对齐）"""
    DRAFT            = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED         = "approved"
    IN_PROGRESS      = "in_progress"
    DONE             = "done"
    REJECTED         = "rejected"   # 退回修改（可重新提交）


class WorkOrderPriority(str, enum.Enum):
    P1 = "P1"
    P2 = "P2"
    P3 = "P3"


class WorkOrder(Base):
    """工单主表（权威版）"""
    __tablename__ = "work_orders"

    # 主键：W-XXXXXXXX 格式（8位大写hex）
    wo_id = Column(
        String(40), primary_key=True,
        default=lambda: f"W-{uuid.uuid4().hex[:8].upper()}"
    )

    station_id   = Column(String(20), nullable=False)
    equipment_id = Column(String(50), nullable=False)

    # 工单内容
    title        = Column(String(300), nullable=False)
    priority     = Column(SAEnum(WorkOrderPriority), nullable=False, default=WorkOrderPriority.P2)
    description  = Column(Text, nullable=False, default="")
    work_type    = Column(String(50), default="inspection")

    # 状态机
    state = Column(
        SAEnum(WorkOrderState), nullable=False,
        default=WorkOrderState.DRAFT,
        server_default="draft"
    )

    # AI 相关
    ai_draft     = Column(JSONB, default={})
    ai_confidence = Column(Float)
    citations    = Column(JSONB, default=[])

    # 执行记录
    execution_notes      = Column(Text)
    completion_evidence  = Column(JSONB, default=[])

    # 用户和时间
    created_by  = Column(String(36))
    approved_by = Column(String(36))
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), onupdate=func.now())
    approved_at = Column(DateTime(timezone=True))
    started_at  = Column(DateTime(timezone=True))
    done_at     = Column(DateTime(timezone=True))

    # 飞书
    feishu_card_msg_id = Column(String(200))

    def to_dict(self) -> dict:
        """序列化为 API 响应格式（与 Studio WorkOrder 接口完全对齐）"""
        return {
            "wo_id":        self.wo_id,
            "station_id":   self.station_id,
            "equipment_id": self.equipment_id,
            "title":        self.title,
            "priority":     self.priority.value if self.priority else "P2",
            "description":  self.description,
            "work_type":    self.work_type,
            "state":        self.state.value if self.state else "draft",
            "ai_confidence":self.ai_confidence,
            "citations":    self.citations or [],
            "created_by":   self.created_by,
            "approved_by":  self.approved_by,
            "created_at":   self.created_at.isoformat() if self.created_at else None,
            "approved_at":  self.approved_at.isoformat() if self.approved_at else None,
            "done_at":      self.done_at.isoformat() if self.done_at else None,
        }
```

### 19.4 FSM 状态流转（权威版，替代 §三 HITL 散落定义）

```python
# services/workorder_fsm.py（权威状态机）

from models.workorder import WorkOrderState

VALID_TRANSITIONS: dict[WorkOrderState, list[WorkOrderState]] = {
    WorkOrderState.DRAFT:            [WorkOrderState.PENDING_APPROVAL],
    WorkOrderState.PENDING_APPROVAL: [WorkOrderState.APPROVED, WorkOrderState.REJECTED],
    WorkOrderState.REJECTED:         [WorkOrderState.PENDING_APPROVAL],  # 修改后可重新提交
    WorkOrderState.APPROVED:         [WorkOrderState.IN_PROGRESS],
    WorkOrderState.IN_PROGRESS:      [WorkOrderState.DONE],
    WorkOrderState.DONE:             [],   # 终态，不可回退
}

# API 动词 → 目标状态 映射（routers/hitl.py 用）
ACTION_TO_STATE: dict[str, WorkOrderState] = {
    "pending":  WorkOrderState.PENDING_APPROVAL,  # POST /v1/hitl/workorders/{id}/pending
    "approve":  WorkOrderState.APPROVED,           # POST /v1/hitl/workorders/{id}/approve
    "reject":   WorkOrderState.REJECTED,           # POST /v1/hitl/workorders/{id}/reject
    "start":    WorkOrderState.IN_PROGRESS,        # POST /v1/hitl/workorders/{id}/start
    "done":     WorkOrderState.DONE,               # POST /v1/hitl/workorders/{id}/done
}
```

### 19.5 Studio WorkOrder TypeScript 接口（权威版）

```typescript
// src/types/workorder.ts（权威版，替代 §十七.3 的 WorkOrder interface）
// 所有字段名与 Platform to_dict() 输出完全对齐

export type WorkOrderState =
  | "draft" // 草稿
  | "pending_approval" // 待审批
  | "approved" // 已批准
  | "in_progress" // 执行中
  | "done" // 已完成
  | "rejected"; // 已驳回（可修改后重新提交）

export type WorkOrderPriority = "P1" | "P2" | "P3";

export interface WorkOrder {
  wo_id: string; // ← 唯一 ID，格式 "W-XXXXXXXX"
  station_id: string;
  equipment_id: string;
  title: string;
  priority: WorkOrderPriority;
  description: string;
  work_type: string;
  state: WorkOrderState; // ← 字段名 state（非 status）
  ai_confidence?: number;
  citations?: Array<{ label: string; link?: string }>;
  created_by: string;
  approved_by?: string;
  created_at: string; // ISO 8601
  approved_at?: string;
  done_at?: string;
}

// 显示辅助（全项目统一，不重复定义）
export const WO_STATE_LABELS: Record<WorkOrderState, string> = {
  draft: "草稿",
  pending_approval: "待审批",
  approved: "已批准",
  in_progress: "执行中",
  done: "已完成",
  rejected: "已驳回",
};

export const WO_STATE_COLORS: Record<WorkOrderState, string> = {
  draft: "text-[#8B949E]",
  pending_approval: "text-[#8B5CF6]",
  approved: "text-[#22C55E]",
  in_progress: "text-[#1F6FEB]",
  done: "text-[#6B7280]",
  rejected: "text-[#EF4444]",
};

export const WO_PRIORITY_COLORS: Record<WorkOrderPriority, string> = {
  P1: "bg-[#EF4444] text-white",
  P2: "bg-[#F59E0B] text-black",
  P3: "bg-[#22C55E] text-black",
};

// 创建工单请求体（POST /v1/workorders/）
export interface WorkOrderCreateReq {
  equipment_id: string;
  title: string;
  priority: WorkOrderPriority;
  description: string;
  work_type?: string;
}
```

### 19.6 数据字典摘要（快速对照表）

| 实体 | DB 表名        | ORM 类       | 主键                   | 状态字段 | 状态值                                 |
| :--- | :------------- | :----------- | :--------------------- | :------- | :------------------------------------- |
| 工单 | `work_orders`  | `WorkOrder`  | `wo_id`                | `state`  | 小写下划线                             |
| 设备 | `equipment`    | `Equipment`  | `id`（`equipment_id`） | `status` | `normal/warn/alarm/offline`            |
| 告警 | `alarms`       | `Alarm`      | `alarm_id`             | `state`  | `active/acknowledged/shelved/resolved` |
| 用户 | `users`        | `User`       | `id`（`user_id`）      | —        | —                                      |
| 场站 | `stations`     | `Station`    | `id`（`station_id`）   | —        | —                                      |
| 知识 | `kb_documents` | `KBDocument` | `doc_id`               | —        | —                                      |

**命名规范**（全项目统一）：

- ID 字段：`wo_id` / `equipment_id` / `station_id` / `alarm_id` / `user_id` / `doc_id`
- 状态字段统一叫 `state`（除 equipment.status 保持原名）
- API 返回 JSON 和 TypeScript 接口字段名**完全对齐**

---

_§十九 新增（2026-05-09）：数据模型权威定稿，解决 §二/§十五/Studio 三处冲突。_  
_DB 主键统一为 `wo_id`，状态统一为小写下划线，equipment 表补 area 字段。_

---

## 二十、核心架构模式：OpenClaw + Palantir 启示录

> **本节是 ClawTwin 的架构灵魂。**  
> 开发任何新功能前，先问：这个功能在哪个抽象层？符合哪个模式？

### 20.1 架构哲学：为什么要借鉴 OpenClaw 和 Palantir

**OpenClaw 告诉我们**：

- 好的平台应该是"能力注册 + 协议调用"，不是"功能堆砌"
- 插件/Skill 与核心解耦的关键是：**清晰的 manifest 契约 + 严格的 SDK 边界**
- 权限不是事后加的，是进出系统的第一道关（Token → Scope → Resource）
- 所有外部交互通过 Channel 抽象，渠道换了业务逻辑不变

**Palantir Foundry+AIP 告诉我们**：

- 工业数据的本质是"对象（Object）+ 行动（Action）+ 链接（Link）"
- 所有 AI 推荐必须是"可审批的行动提案"，不是"对话回复"
- 数据沿 Pipeline 流动，每一步都有血缘（Lineage）可追溯
- UI 设计为"对象驱动"而非"页面驱动"：点击一个设备，展开它的所有相关行动

**我们的结论**：

- ClawTwin Platform = Palantir Foundry（工业数据 + 本体 + 行动流）
- OpenClaw = Palantir AIP（AI 编排 + Skills）
- 两者的结合点：**Platform Tool API**（OpenClaw 调 Platform，Platform 托管数据）

---

### 20.2 三层架构抽象（从 OpenClaw 学习的 Plugin SDK 模式）

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3：Channel 层（用户交互入口）                      │
│    飞书 Bot / Studio Web / Mobile API / CLI              │
│    → 所有 Channel 统一进 /v1/feishu/events 或 /v1/ws    │
├─────────────────────────────────────────────────────────┤
│  Layer 2：Orchestration 层（AI 编排）                    │
│    OpenClaw（外部）→ Skills（我们写）→ Platform Tool API  │
│    Skills 是能力插件，通过 manifest 注册到 OpenClaw       │
├─────────────────────────────────────────────────────────┤
│  Layer 1：Platform 核心（数据 + 行动 + 安全）             │
│    本体注册表 / 设备状态 / HITL 工单 / 审计日志 / IMS适配  │
└─────────────────────────────────────────────────────────┘
```

**关键原则**：

- Layer 2 只能通过 Layer 1 的 Tool API 访问数据，不能直连数据库
- Layer 3 只能通过 Layer 2（OpenClaw）或 Layer 1（Platform Auth API）访问
- 每层有自己的 Token 类型：用户 JWT（Layer 3）/ Service Token（Layer 2→1）

---

### 20.3 IMS 适配器 SDK（从 OpenClaw 插件 SDK 学习）

OpenClaw 的每个插件都通过 manifest + api.ts 实现清晰的能力注册。ClawTwin 的 IMS 适配器采用同样模式：

```python
# services/ims/base_adapter.py（IMS 适配器 SDK 基类）
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class Reading:
    """统一的设备读数格式（适配器输出合约）"""
    equipment_id: str
    metric:       str          # "outlet_pressure" / "shaft_vibration"
    value:        float
    quality:      str          # "GOOD" | "BAD" | "UNCERTAIN"
    timestamp:    str          # ISO 8601


@dataclass
class AdapterManifest:
    """适配器能力声明（类比 OpenClaw plugin manifest）"""
    adapter_id:   str          # "opcua" | "rest" | "csv" | "mock"
    version:      str
    supports_push: bool        # True=订阅推送，False=轮询
    polling_interval_s: int    # supports_push=False 时有效


class IMSAdapter(ABC):
    """所有 IMS 适配器必须实现此接口"""

    @classmethod
    @abstractmethod
    def manifest(cls) -> AdapterManifest:
        """声明适配器能力"""
        ...

    @abstractmethod
    async def connect(self, endpoint: str, credentials: dict) -> None:
        """建立连接（握手、认证）"""
        ...

    @abstractmethod
    async def stream_readings(self) -> AsyncIterator[Reading]:
        """推送或轮询读数"""
        ...

    @abstractmethod
    async def disconnect(self) -> None:
        """清理连接"""
        ...


# ── Mock 适配器（Phase A 默认）──────────────────────────────
class MockAdapter(IMSAdapter):
    @classmethod
    def manifest(cls) -> AdapterManifest:
        return AdapterManifest(
            adapter_id="mock", version="1.0",
            supports_push=True, polling_interval_s=5
        )

    async def connect(self, endpoint: str, credentials: dict) -> None:
        pass  # Mock 无需连接

    async def stream_readings(self) -> AsyncIterator[Reading]:
        import asyncio, random, time
        equipments = {"C-001": ["shaft_vibration", "outlet_pressure"],
                      "P-001": ["inlet_pressure", "flow_rate"]}
        while True:
            for eq_id, metrics in equipments.items():
                for metric in metrics:
                    yield Reading(
                        equipment_id=eq_id, metric=metric,
                        value=round(random.gauss(3.5, 0.5), 3),
                        quality="GOOD",
                        timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    )
            await asyncio.sleep(5)

    async def disconnect(self) -> None:
        pass


# ── 适配器注册表（无需硬编码 if/else）──────────────────────
_ADAPTER_REGISTRY: dict[str, type[IMSAdapter]] = {
    "mock": MockAdapter,
    # Phase B：OPCUAAdapter, RESTAdapter, CSVAdapter
}

def get_adapter(adapter_type: str) -> type[IMSAdapter]:
    cls = _ADAPTER_REGISTRY.get(adapter_type)
    if not cls:
        raise ValueError(f"未知 IMS 适配器类型: {adapter_type}（可用: {list(_ADAPTER_REGISTRY)}）")
    return cls
```

**扩展时**：新增 `OPCUAAdapter` 只需实现 `IMSAdapter` 接口，然后注册到 `_ADAPTER_REGISTRY`，Platform 的其他代码无需修改——这正是 OpenClaw 插件模式的精髓。

---

### 20.4 设备本体注册表（从 Palantir Ontology 学习）

Palantir Foundry 的核心是 Object Type Registry——所有业务实体都有类型定义和能力声明。ClawTwin 借鉴此模式：

```python
# services/ontology/registry.py
from dataclasses import dataclass, field


@dataclass
class MetricDef:
    """指标定义"""
    name:      str     # "shaft_vibration"
    unit:      str     # "mm/s"
    warn:      float   # 告警阈值（黄）
    alarm:     float   # 报警阈值（红）
    direction: str = "higher_is_worse"  # higher_is_worse | lower_is_worse


@dataclass
class EquipmentTypeDef:
    """设备类型能力声明（类比 Palantir Object Type Definition）"""
    type_id:          str                # "compressor"
    display_name:     str                # "压缩机"
    default_metrics:  list[MetricDef]   # 默认监控指标集
    supported_actions: list[str]         # ["diagnose", "workorder", "spectrum"]
    # Phase B：可链接的对象类型
    link_types:       list[str] = field(default_factory=list)  # ["station", "valve"]


# 注册表（Phase A 硬编码，Phase B 改数据库）
EQUIPMENT_TYPE_REGISTRY: dict[str, EquipmentTypeDef] = {
    "compressor": EquipmentTypeDef(
        type_id="compressor",
        display_name="压缩机",
        default_metrics=[
            MetricDef("shaft_vibration",   "mm/s",  3.5, 5.0),
            MetricDef("outlet_pressure",   "MPa",   7.0, 7.5),
            MetricDef("inlet_temperature", "°C",    50,  60),
            MetricDef("bearing_temp",      "°C",    70,  85),
        ],
        supported_actions=["diagnose", "workorder", "spectrum", "pid"],
    ),
    "separator": EquipmentTypeDef(
        type_id="separator",
        display_name="分离器",
        default_metrics=[
            MetricDef("liquid_level",  "%",    80, 95, "higher_is_worse"),
            MetricDef("inlet_pressure", "MPa", 6.5, 7.0),
        ],
        supported_actions=["diagnose", "workorder"],
    ),
    "meter": EquipmentTypeDef(
        type_id="meter",
        display_name="计量仪表",
        default_metrics=[
            MetricDef("flow_rate",  "m³/h", 0, 0),   # 无阈值，仅记录
        ],
        supported_actions=["diagnose"],
    ),
    "valve": EquipmentTypeDef(
        type_id="valve",
        display_name="阀门",
        default_metrics=[
            MetricDef("position", "%", 0, 0),         # 阀位开度
            MetricDef("pressure_diff", "MPa", 1.5, 2.0),
        ],
        supported_actions=["diagnose", "pid"],
    ),
}


def get_equipment_type(type_id: str) -> EquipmentTypeDef:
    defn = EQUIPMENT_TYPE_REGISTRY.get(type_id)
    if not defn:
        # 未知类型：返回通用类型（兼容扩展）
        return EquipmentTypeDef(
            type_id=type_id, display_name=type_id,
            default_metrics=[], supported_actions=["diagnose"]
        )
    return defn
```

**用法**：

```python
# 在 /v1/equipment/{id} 返回设备详情时，附加类型能力
eq_def = get_equipment_type(equipment.type)
return {
    "id": equipment.id,
    "type": equipment.type,
    "supported_actions": eq_def.supported_actions,  # ← Studio 用来决定显示哪些按钮
    "default_metrics": [m.name for m in eq_def.default_metrics],
    ...
}
```

---

### 20.5 行动类型（从 Palantir Action Type 学习）

Palantir AIP 的核心思想：AI 不直接执行，而是生成"行动提案"，人类审批后执行。ClawTwin 的 HITL 工单系统就是这个模式：

```python
# services/actions/work_order_action.py
from dataclasses import dataclass


@dataclass
class ActionTemplate:
    """工单行动模板（类比 Palantir Action Type）"""
    action_id:         str   # "emergency_stop", "bearing_inspect"
    display_name:      str
    work_type:         str   # "maintenance" | "inspection" | "emergency"
    requires_approval: bool  # 是否需要主管审批
    requires_confirm:  bool  # 是否需要操作员二次确认（高风险）
    risk_level:        str   # "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    default_steps:     list[str]  # AI 草稿的默认步骤（可被覆盖）


# 行动模板注册表
ACTION_TEMPLATES: dict[str, ActionTemplate] = {
    "bearing_inspect": ActionTemplate(
        action_id="bearing_inspect",
        display_name="轴承检查",
        work_type="inspection",
        requires_approval=True,
        requires_confirm=False,
        risk_level="LOW",
        default_steps=[
            "停机前检查振动数据趋势",
            "申请计划停机窗口",
            "拆卸轴承端盖进行目视检查",
            "用振动笔测量径向/轴向振动",
            "对比安装标准，记录间隙数据",
        ]
    ),
    "emergency_stop": ActionTemplate(
        action_id="emergency_stop",
        display_name="紧急停机",
        work_type="emergency",
        requires_approval=False,   # 紧急停机不等审批
        requires_confirm=True,     # 但需操作员二次确认
        risk_level="CRITICAL",
        default_steps=[
            "按下紧急停机按钮（ESD-001）",
            "确认出口阀已关闭",
            "通知主控室和相关人员",
            "记录停机时间和原因",
        ]
    ),
}


def get_ai_primary_action(diagnosis_result: dict) -> dict:
    """
    基于 AI 诊断结果计算主行动（Primary Action）
    这是 Studio One Big Action 按钮的数据来源。
    """
    confidence = diagnosis_result.get("confidence", 0)
    anomaly_type = diagnosis_result.get("anomaly_type", "unknown")
    severity = diagnosis_result.get("severity", "low")

    # 行动决策树
    if severity == "critical" and confidence > 0.85:
        template = ACTION_TEMPLATES.get("emergency_stop")
        return {
            "label": "紧急停机",
            "icon": "🚨",
            "color": "text-[#EF4444]",
            "action_type": "emergency_stop",
            "reason": diagnosis_result.get("summary", ""),
            "requires_confirm": True,
        }
    elif severity in ("high", "medium") and confidence > 0.7:
        template = ACTION_TEMPLATES.get("bearing_inspect")
        return {
            "label": "创建检查工单",
            "icon": "📋",
            "color": "text-[#F59E0B]",
            "action_type": "create_workorder",
            "reason": diagnosis_result.get("summary", ""),
            "requires_confirm": False,
        }
    elif confidence > 0.5:
        return {
            "label": "继续监测",
            "icon": "👁",
            "color": "text-[#1F6FEB]",
            "action_type": "monitor",
            "reason": "当前状态在可接受范围内，建议持续关注",
            "requires_confirm": False,
        }
    else:
        return {
            "label": "请求人工确认",
            "icon": "❓",
            "color": "text-[#8B949E]",
            "action_type": "manual_review",
            "reason": "AI 置信度不足，请人工判断",
            "requires_confirm": False,
        }
```

---

### 20.6 Service Token 双层认证（从 OpenClaw 学习）

OpenClaw 使用服务令牌（Service Token）做跨服务信任，不用用户 JWT。ClawTwin 采用同样模式：

```python
# auth/depends.py（完整版）
from fastapi import Header, HTTPException
from config.settings import settings


async def get_current_user(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> User:
    """用户 JWT 认证（来自浏览器/飞书）"""
    ...  # 见 §十二


async def get_service_token(
    x_openclaw_service_token: str = Header(None, alias="X-OpenClaw-Service-Token"),
    x_clawtwin_service_token: str = Header(None, alias="X-ClawTwin-Service-Token"),
) -> str:
    """服务 Token 认证（OpenClaw Skill 调 Tool API）"""
    token = x_openclaw_service_token or x_clawtwin_service_token
    if not token or token != settings.SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="无效的服务令牌")
    return token


# Tool API 路由只需 Service Token，不需要用户 JWT
@router.post("/v1/tools/diagnose_equipment")
async def diagnose_equipment(
    req: DiagnoseReq,
    _: str = Depends(get_service_token),  # ← 服务 Token 即可
):
    ...

# 用户 API 路由需要用户 JWT
@router.get("/v1/equipment/{id}")
async def get_equipment(
    equipment_id: str,
    current_user: User = Depends(get_current_user),  # ← 用户 JWT
    db: AsyncSession = Depends(get_db),
):
    require_station(equipment.station_id, current_user)
    ...
```

---

### 20.7 事件总线模式（为 Phase B 准备的扩展点）

当前 Phase A 用 APScheduler 轮询，Phase B 应引入事件驱动架构：

```python
# services/events.py（Phase B 骨架，Phase A 先占位）
from enum import Enum
from dataclasses import dataclass
from typing import Callable, Awaitable


class EventType(str, Enum):
    READING_INGESTED   = "reading.ingested"    # 设备读数写入
    ANOMALY_DETECTED   = "anomaly.detected"    # MOIRAI 检测到异常
    WORKORDER_CREATED  = "workorder.created"   # 工单创建
    WORKORDER_APPROVED = "workorder.approved"  # 工单审批
    ALARM_FIRED        = "alarm.fired"         # 告警触发
    SHIFT_STARTED      = "shift.started"       # 班次开始


@dataclass
class Event:
    type:    EventType
    payload: dict
    station_id: str


# Phase A：直接调用（同步）
# Phase B：替换为 Kafka 消息（解耦各服务）
async def emit(event: Event) -> None:
    """发布事件（Phase A 直接调用 handler，Phase B 发到 Kafka）"""
    handlers = _HANDLERS.get(event.type, [])
    for handler in handlers:
        await handler(event)


_HANDLERS: dict[EventType, list[Callable]] = {}

def on(event_type: EventType):
    """装饰器：注册事件处理器"""
    def decorator(func: Callable[[Event], Awaitable[None]]):
        _HANDLERS.setdefault(event_type, []).append(func)
        return func
    return decorator


# 使用示例
@on(EventType.ANOMALY_DETECTED)
async def handle_anomaly(event: Event):
    """异常检测到 → 自动创建告警 → 通知飞书"""
    equipment_id = event.payload["equipment_id"]
    score = event.payload["score"]
    # ... 创建 Alarm 记录，推送飞书卡片
```

---

### 20.8 架构原则总结（开发决策树）

遇到设计决策时，按此顺序判断：

```
1. 这个功能是"数据"还是"行动"？
   → 数据：走设备读数 / KB 检索 / 图查询
   → 行动：走 HITL 工单 FSM（必须人类审批）

2. 这个功能由谁触发？
   → 用户触发：用户 JWT → Platform REST API → 返回结果
   → AI 触发：Service Token → Tool API → 返回 JSON → OpenClaw 渲染
   → 时间触发：Platform Scheduler → 内部直调 service → Feishu 推送

3. 这个功能需要持久化吗？
   → 是：走 PostgreSQL（元数据）或 TimescaleDB（时序）或 **pgvector**（向量）
   → 否：内存缓存（Redis，TTL ≤ 5min）

4. 这个功能需要扩展吗？
   → 设备类型扩展：加到 EQUIPMENT_TYPE_REGISTRY
   → IMS 数据源扩展：实现 IMSAdapter 并注册
   → AI 能力扩展：写新 OpenClaw Skill（不改 Platform）
   → 前端渲染扩展：加 React 组件（不改 Platform API）
```

---

_§二十 新增（2026-05-09）：OpenClaw+Palantir 核心架构模式，指导 ClawTwin 的可扩展设计。_  
_IMS 适配器 SDK、设备本体注册表、行动类型、双层认证、事件总线均已定义接口，Phase A 实现 Mock 版本，Phase B 替换生产实现。_

---

## 二十一、Platform 与 Studio 架构务实评估（2026-05-09）

> **核心问题**：Platform 需要像 OpenClaw 那样的 Gateway 吗？  
> **直接答案**：**不需要现在加**。但有一个精准的痛点值得立即解决，其余 Phase B 再说。

---

### 21.1 什么是过度设计，什么是必须的

```
过度设计（Phase A 不要做）              必须做（现在就做）
─────────────────────────────────      ────────────────────────────────
Outbound 连接器注册表                   统一请求上下文（解决铁律 2）
  → 为 vLLM/**pgvector** 抽象 ABC 基类        → 一个 get_ctx() 依赖注入
  → 理由：Phase A 只有 vLLM，直接调     → 理由：auth 分散=安全漏洞
    httpx 3 行，注册表徒增复杂度

WebSocket + Redis pub/sub               SSE 实时推送
  → Phase A 单进程 Mock 数据，          → 一行代码，比轮询好，比 WS 简单
    Redis 依赖不必要                     → 理由：Studio 实时展示必须有 push

IMS 适配器注册表（已有 §20.3）           IMS 适配器本身（已有）
  → §20.3 的设计是合理的，但            → MockAdapter 已够，
    Phase A 只实现 Mock，不注册           Phase B 再加 OPCUAAdapter

PlatformRequestContext 完整版           简化版 ctx（只解决 station_id 泄漏）
  → CallerKind enum / 四种调用者         → 两个 Depends：get_user / get_service
    分支，Phase A 实际只有 USER           → 防止铁律 2 被忘记即可
    + SERVICE 两种
```

---

### 21.2 Platform Phase A 实际需要的最简架构

**原则：FastAPI monolith + 够用的抽象，不为扩展而扩展。**

```
platform-api/
├── main.py              # FastAPI app + lifespan + include_router
├── config/settings.py   # 所有配置，pydantic-settings
├── db/
│   ├── base.py          # DeclarativeBase
│   ├── database.py      # AsyncSession + init_db
│   └── models/          # ORM（Station/Equipment/WorkOrder/User/Alarm）
├── auth/
│   ├── jwt.py           # encode/decode JWT（唯一权威）
│   ├── password.py      # bcrypt 哈希
│   └── deps.py          # get_user(db,token) + get_service_token(header)
│                        # ← Phase A 只需这两个，不需要 resolve_context
├── routers/
│   ├── auth.py          # /v1/auth/*
│   ├── equipment.py     # /v1/equipment/*
│   ├── stations.py      # /v1/stations/*
│   ├── workorder.py     # /v1/workorders/* + /v1/hitl/*
│   ├── alarms.py        # /v1/alarms/*
│   ├── tools.py         # /v1/tools/*（Service Token 保护）
│   ├── notifications.py # /v1/notifications/*
│   ├── shifts.py        # /v1/shifts/*
│   └── sse.py           # /v1/sse/station/{id}（实时推送）← 新增，替代 WS
├── services/
│   ├── ims/             # MockAdapter（§20.3，Phase A 只有 mock）
│   ├── ontology/        # EQUIPMENT_TYPE_REGISTRY（§20.4）
│   ├── actions/         # ACTION_TEMPLATES + get_ai_primary_action（§20.5）
│   ├── diagnosis.py     # AI 诊断逻辑（调 vLLM）
│   ├── feishu.py        # 飞书消息发送
│   └── kb.py            # **pgvector** 向量检索（Phase A 可先返回空）
└── scheduler/           # APScheduler 定时任务
    ├── anomaly.py       # 5min 轮询 → 检测异常 → 推 SSE
    └── helpers.py       # 辅助函数
```

**铁律 2 的正确解法（不需要 PlatformRequestContext）**：

```python
# auth/deps.py — Phase A 够用的两个 Depends

async def get_current_user(
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> User:
    """JWT 验证 → 返回 User ORM 对象（含 station_ids）"""
    token = authorization.removeprefix("Bearer ").strip()
    payload = decode_jwt(token)                    # 抛异常 = 401
    user = await db.get(User, payload["user_id"])
    if not user or not user.is_active:
        raise HTTPException(401, "用户不存在或已禁用")
    return user


def require_station(station_id: str, user: User) -> None:
    """铁律 2 核心：一行调用，到处复用"""
    if station_id not in (user.station_ids or []):
        raise HTTPException(403, f"无权访问场站 {station_id}")


async def get_service_token(
    x_token: str | None = Header(None, alias="X-ClawTwin-Service-Token"),
) -> None:
    """OpenClaw / HiAgent 调 Tool API 时验证"""
    if not x_token or x_token != settings.service_token:
        raise HTTPException(401, "无效的 Service Token")
```

```python
# 路由里的用法（统一模式）
@router.get("/v1/equipment/{eid}")
async def get_equipment(
    eid: str,
    user: User = Depends(get_current_user),
    db:   AsyncSession = Depends(get_db),
):
    eq = await db.get(Equipment, eid)
    if not eq: raise HTTPException(404)
    require_station(eq.station_id, user)   # ← 铁律 2，不会忘
    ...
```

这就够了。不需要 `resolve_context` / `CallerKind` / `PlatformRequestContext`。Phase B 真正要区分四种调用者时再重构。

---

### 21.3 实时数据：SSE 而非 WebSocket（Phase A）

**为什么 SSE 比 WS 更适合 Phase A：**

|                   | REST 轮询（当前） | Server-Sent Events（推荐） | WebSocket（Phase B）      |
| :---------------- | :---------------- | :------------------------- | :------------------------ |
| 复杂度            | 最低              | 低                         | 高（需 Redis/多进程协调） |
| 实时性            | 差（5-10s 延迟）  | 好（服务端主动推）         | 最好                      |
| 浏览器支持        | ✓                 | ✓ 原生 `EventSource`       | ✓                         |
| 断线重连          | 手动              | 浏览器自动                 | 手动                      |
| 单进程够用        | ✓                 | ✓                          | ✓                         |
| Phase A Mock 适合 | ✓                 | ✓                          | ✓ 但杀鸡用牛刀            |

**Platform SSE 端点（20 行）**：

```python
# routers/sse.py
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
import asyncio, json, time

from auth.deps import get_current_user, require_station
from services.ims import get_current_readings   # 返回 {equipment_id: {metric: value}}

router = APIRouter()

@router.get("/v1/sse/station/{station_id}")
async def station_stream(
    station_id: str,
    user = Depends(get_current_user),
):
    require_station(station_id, user)

    async def generate():
        while True:
            readings = await get_current_readings(station_id)
            payload = json.dumps({
                "type": "READINGS",
                "station_id": station_id,
                "data": readings,
                "ts": int(time.time() * 1000),
            })
            yield f"data: {payload}\n\n"
            await asyncio.sleep(5)   # 5s 推一次

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
```

**Phase B 升级路径**：当需要多进程部署时，把 `generate()` 里的 `get_current_readings()` 替换为订阅 Redis pub/sub 即可，端点 URL 不变，前端代码不改。

---

### 21.4 Studio 客户端数据层（精简版）

**原则：规范化 Store + SSE 订阅，不引入复杂总线。**

```
Studio 数据流（Phase A）
─────────────────────────────────────────────────────
REST GET /v1/stations/{id}/equipment   ──→  equipmentStore.meta
REST GET /v1/alarms?station_id=...     ──→  alarmStore.list
SSE  GET /v1/sse/station/{id}          ──→  equipmentStore.readings（实时）

                    ↓ Zustand Store（规范化，按 ID 索引）
                    ↓ Selector Hook（精准订阅，避免整棵树重渲）
              React 组件（只重渲变化的那一个格子）
```

**三个 Store，职责清晰**：

```typescript
// store/equipment.store.ts
interface EquipmentStore {
  // 静态元数据（REST 加载一次）
  meta: Record<string, EquipmentMeta>;
  fetchMeta: (stationId: string) => Promise<void>;

  // 实时读数（SSE 持续更新）
  readings: Record<string, Record<string, number>>;  // eid → metric → value
  status:   Record<string, "normal"|"warn"|"alarm"|"offline">;

  // SSE 连接控制
  sseController: AbortController | null;
  startSSE: (stationId: string, token: string) => void;
  stopSSE:  () => void;
}

// 核心 SSE 逻辑（20 行）
startSSE(stationId, token) {
  const ctrl = new AbortController();
  set({ sseController: ctrl });
  const es = new EventSource(`/v1/sse/station/${stationId}?token=${token}`);
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "READINGS") {
      set((s) => ({
        readings: { ...s.readings, ...msg.data },
        status:   { ...s.status,   ...deriveStatus(msg.data) },
      }));
    }
  };
  es.onerror = () => setTimeout(() => get().startSSE(stationId, token), 5000);
}
```

```typescript
// Selector Hooks（精准订阅）
export const useMetric = (eid: string, metric: string) =>
  useEquipmentStore((s) => s.readings[eid]?.[metric]);

export const useEquipStatus = (eid: string) => useEquipmentStore((s) => s.status[eid] ?? "offline");

// StationHeatmap：一次聚合，Memo 缓存
export const useAreaStatus = (eqList: EquipmentMeta[]) =>
  useEquipmentStore((s) => {
    const map: Record<string, string> = {};
    for (const eq of eqList) {
      const cur = s.status[eq.id] ?? "offline";
      const rank = { normal: 0, offline: 1, warn: 2, alarm: 3 };
      if ((rank[cur] ?? 0) > (rank[map[eq.area]] ?? 0)) map[eq.area] = cur;
    }
    return map;
  });
```

**alarmStore**：REST 轮询（60s）即可，告警不需要 5s 级别的实时性，飞书推送会第一时间通知用户。

---

### 21.5 "是否需要 Gateway 模式"的决策框架

遇到架构问题，用这个框架判断：

```
问题：需要 Gateway / 注册表 / 抽象层吗？

┌─ 现在有几个不同实现需要切换？
│   只有 1 个 → 不需要抽象，直接写，TODO 注释即可
│   已有 2+ 个 → 抽一个接口
│
├─ 扩展频率如何？
│   每月可能加一个 → 值得设计扩展点
│   一年加一个 → 到时候再重构，现在别过早优化
│
├─ 扩展时改代码的代价？
│   改一处（注册表）→ 值得注册表模式
│   改多处（散落各文件）→ 值得统一管理
│
└─ 当前阶段是 Demo 还是 Production？
    Demo → 简单优先，能跑通就行
    Production → 考虑扩展性，但仍然只做必要的
```

**对应 ClawTwin 当前决策**：

| 抽象                    | 当前状态      | 决策                   | 原因                                                  |
| :---------------------- | :------------ | :--------------------- | :---------------------------------------------------- |
| IMS Adapter（§20.3）    | 只有 Mock     | **保留接口，不注册表** | 接口设计合理，但注册表等 Phase B 加第二个适配器时再建 |
| 设备本体注册表（§20.4） | 硬编码 4 类型 | **保留**               | 已够简单，且 Studio 确实需要用                        |
| 行动模板（§20.5）       | 硬编码 dict   | **保留**               | 简单有效，不是过度设计                                |
| 出站连接器注册表        | 不存在        | **不加**               | Phase A 只有 vLLM，直接 httpx                         |
| Inbound Gateway/Context | 不存在        | **不加完整版**         | 用 `get_current_user` + `require_station` 即可        |
| WebSocket + Redis       | 不存在        | **不加**               | SSE 单进程足够 Phase A                                |
| SSE 端点                | 不存在        | **立即加**             | 解决轮询性能问题，20 行代码                           |

---

### 21.6 Phase B 真正需要 Gateway 的条件

当满足以下任一条件时，再引入对应的 Gateway 模式：

```
触发条件                          对应升级
─────────────────────────────    ─────────────────────────────────
多进程/多节点部署（uvicorn workers）→  SSE 升级为 WebSocket + Redis pub/sub
加入第二个 IMS 数据源（OPC-UA）   →  IMSAdapter 注册表真正启用
OpenClaw + HiAgent 都调 Tool API  →  Service Token 池管理（settings.service_tokens dict）
需要区分 Feishu 回调 vs JWT 用户  →  CallerKind 枚举 + resolve_context 统一
连接器（vLLM/**嵌入服务**）需要独立配置  →  IntegrationConnector 注册表
```

---

_§二十一 重写（2026-05-09）：务实架构评估。Platform Phase A = FastAPI monolith + SSE，无需 Gateway 抽象。_
_两个必须做的：① `require_station()` 统一调用防铁律 2 散落；② SSE 替代 REST 轮询做实时推送。_
_Studio = 三个规范化 Store + EventSource + Selector Hook，不引入复杂总线。_

---

## 二十二、生产级架构补全：现在不做、后期代价最大的十个决策（2026-05-09）

> **工程原则**：接口协议比实现更难改。Phase A 可以用简单实现，但接口形状必须按生产级设计。  
> 本节列出**现在就必须设计对**的架构决策，每项都给出 Phase A 最简实现 + Phase B 升级路径。

---

### 22.0 十个决策速览

|  #  | 决策                              | 不做的代价                                   | Phase A 代价               | 修复代价                 |
| :-: | :-------------------------------- | :------------------------------------------- | :------------------------- | :----------------------- |
|  1  | **统一 API 响应格式**             | 前端适配代码混乱，加 envelope 破坏所有客户端 | 低（一个装饰器）           | 高（重写全部前端 fetch） |
|  2  | **数据摄入管道抽象**              | 摄入逻辑散落各处，加 Kafka 需重写调用点      | 低（一个函数）             | 高（3-4 周）             |
|  3  | **AI 推理异步接口**               | 同步阻塞，并发用户多时 504 超时              | 低（假 task_id）           | 中（接口改变，前端要改） |
|  4  | **per-station IMS 配置入库**      | 多场站必须改代码/重部署                      | 低（一列 JSONB）           | 中（数据迁移+重构）      |
|  5  | **统一分页规范**                  | 数据量大时 list 接口崩溃，加分页改前端       | 低（固定 schema）          | 高（前端全改）           |
|  6  | **结构化日志**                    | 生产排查靠 grep 裸字符串，慢 10 倍           | 低（1 小时接入 structlog） | 低（但欠债会越来越多）   |
|  7  | **健康检查 + 可观测性**           | 运维无法知道哪个服务挂了                     | 低（一个 /health 端点）    | 低                       |
|  8  | **数据库连接池配置**              | 生产高并发时连接耗尽，崩溃                   | 低（3 行配置）             | 低（但崩溃时很难排查）   |
|  9  | **背景任务分布式锁**              | 多实例重复执行调度任务，数据重复             | 低（Redis lock）           | 低                       |
| 10  | **Security Headers + Rate Limit** | 生产暴露后被扫描/爆破                        | 低（中间件）               | 低（但发生后是安全事件） |

---

### 22.1 统一 API 响应格式（必须现在定）

**所有 API 统一返回格式，前端只需一套 `fetcher`，错误处理统一。**

```python
# core/response.py — 统一响应格式（全局）
from fastapi.responses import JSONResponse
from typing import Any, Optional
import math


def ok(data: Any, meta: dict | None = None) -> JSONResponse:
    """成功响应"""
    body = {"data": data, "error": None}
    if meta:
        body["meta"] = meta
    return JSONResponse(body)


def paginate(items: list, total: int, page: int, per_page: int) -> JSONResponse:
    """分页响应"""
    return ok(items, meta={
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": math.ceil(total / per_page) if per_page else 1,
    })


def err(code: str, message: str, status: int = 400) -> JSONResponse:
    """错误响应"""
    return JSONResponse({"data": None, "error": {"code": code, "message": message}},
                        status_code=status)


# 全局异常处理（main.py 里注册）
from fastapi import Request, HTTPException
from fastapi.exceptions import RequestValidationError

async def http_exception_handler(request: Request, exc: HTTPException):
    return err(f"HTTP_{exc.status_code}", exc.detail, exc.status_code)

async def validation_exception_handler(request: Request, exc: RequestValidationError):
    detail = "; ".join(f"{'.'.join(str(l) for l in e['loc'])}: {e['msg']}" for e in exc.errors())
    return err("VALIDATION_ERROR", detail, 422)
```

**前端统一 fetcher（TypeScript）**：

```typescript
// src/lib/api.ts — 统一 fetcher，不再 JSON.parse 裸对象
interface ApiResponse<T> {
  data: T | null;
  error: { code: string; message: string } | null;
  meta?: { page: number; per_page: number; total: number; total_pages: number };
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${import.meta.env.VITE_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...init?.headers,
    },
  });
  const body: ApiResponse<T> = await res.json();
  if (body.error) throw new ApiError(body.error.code, body.error.message, res.status);
  return body;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
```

---

### 22.2 数据摄入管道（IngestPipeline）

**当前问题**：MockAdapter 直接写 TimescaleDB，Scheduler 直接调 MOIRAI。数据流路径散落在三处。  
**真正问题**：加 Kafka 时，需要改所有调用点。

**解法**：定义 `IngestPipeline` 接口，调用方只管 `emit(reading)`，内部实现可以换。

```python
# services/ingest.py — 数据摄入管道（Phase A 内存实现，Phase B 换 Kafka）
import asyncio
from dataclasses import dataclass
from typing import Callable, Awaitable
from services.ims.base_adapter import Reading


# ── 摄入管道（单例）────────────────────────────────────────────
class IngestPipeline:
    """
    所有设备读数必须通过 pipeline.emit() 进入系统，不得直接写 DB。
    Phase A：asyncio Queue，单进程消费。
    Phase B：替换为 Kafka Producer，Consumer 独立服务。
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Reading] = asyncio.Queue(maxsize=10_000)
        self._handlers: list[Callable[[Reading], Awaitable[None]]] = []

    def register_handler(self, fn: Callable[[Reading], Awaitable[None]]) -> None:
        """注册消费者（消费顺序：写DB → 更新缓存 → 触发SSE → 触发检测）"""
        self._handlers.append(fn)

    async def emit(self, reading: Reading) -> None:
        """发布读数（IMS Adapter 调用此方法，不直接写 DB）"""
        await self._queue.put(reading)

    async def start(self) -> None:
        """启动消费循环（Phase B 这里换成 Kafka Consumer）"""
        while True:
            reading = await self._queue.get()
            for fn in self._handlers:
                try:
                    await fn(reading)
                except Exception as e:
                    log.error("ingest.handler_error", handler=fn.__name__, error=str(e))
            self._queue.task_done()


pipeline = IngestPipeline()


# ── 消费者：写 TimescaleDB ─────────────────────────────────────
async def _handler_save_to_db(r: Reading) -> None:
    async with get_async_session() as db:
        db.add(EquipmentReading(
            equipment_id=r.equipment_id, metric=r.metric,
            value=r.value, quality=r.quality, ts=r.timestamp,
        ))
        await db.commit()


# ── 消费者：更新 Redis 最新值缓存（SSE 读取用）────────────────
async def _handler_update_redis_cache(r: Reading) -> None:
    await redis.hset(f"readings:{r.equipment_id}", r.metric,
                     json.dumps({"v": r.value, "q": r.quality, "t": r.timestamp}))
    await redis.expire(f"readings:{r.equipment_id}", 60)  # 60s TTL，防僵尸数据


# ── 消费者：触发 SSE 推送（asyncio Event）────────────────────
_sse_queues: dict[str, asyncio.Queue] = {}  # station_id → Queue

async def _handler_trigger_sse(r: Reading) -> None:
    # 从 equipment_id 查 station_id（缓存在内存 dict，不查 DB）
    station_id = _equipment_station_cache.get(r.equipment_id)
    if station_id and station_id in _sse_queues:
        await _sse_queues[station_id].put(r)


# ── 注册顺序（main.py lifespan 里）──────────────────────────
# pipeline.register_handler(_handler_save_to_db)
# pipeline.register_handler(_handler_update_redis_cache)
# pipeline.register_handler(_handler_trigger_sse)
# asyncio.create_task(pipeline.start())
```

**SSE 端点升级**（从 Phase A 轮询 DB → Phase A 消费 Queue，数据延迟 <1s）：

```python
# routers/sse.py（读取 IngestPipeline 的 _sse_queues，不再轮询 DB）
@router.get("/v1/sse/station/{station_id}")
async def station_stream(station_id: str, user=Depends(get_current_user)):
    require_station(station_id, user)

    q: asyncio.Queue = _sse_queues.setdefault(station_id, asyncio.Queue(maxsize=500))

    async def generate():
        yield f"data: {json.dumps({'type': 'CONNECTED', 'station_id': station_id})}\n\n"
        while True:
            try:
                reading = await asyncio.wait_for(q.get(), timeout=30)
                payload = {"type": "READING", "equipment_id": reading.equipment_id,
                           "metric": reading.metric, "value": reading.value,
                           "quality": reading.quality, "ts": reading.timestamp}
                yield f"data: {json.dumps(payload)}\n\n"
            except asyncio.TimeoutError:
                yield "data: {\"type\":\"PING\"}\n\n"  # 保活

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```

---

### 22.3 AI 推理异步接口（接口现在设计对，实现可以是假的）

**问题**：诊断一次 60-120s（Qwen 35B），同步 HTTP 一定超时。  
**解法**：接口设计成 task_id 模式；Phase A 内部用 `asyncio.create_task` 实现，接口不变。

```python
# services/tasks.py — 轻量任务管理（Phase A 内存，Phase B 换 ARQ/Celery）
import asyncio, uuid
from dataclasses import dataclass, field
from enum import Enum

class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE    = "done"
    FAILED  = "failed"

@dataclass
class Task:
    task_id: str
    status:  TaskStatus = TaskStatus.PENDING
    result:  dict | None = None
    error:   str | None = None

_tasks: dict[str, Task] = {}   # Phase A 内存存储

def create_task(coro) -> str:
    """提交异步任务，返回 task_id"""
    task_id = str(uuid.uuid4())[:8]
    _tasks[task_id] = Task(task_id=task_id)

    async def run():
        _tasks[task_id].status = TaskStatus.RUNNING
        try:
            result = await coro
            _tasks[task_id].status = TaskStatus.DONE
            _tasks[task_id].result = result
        except Exception as e:
            _tasks[task_id].status = TaskStatus.FAILED
            _tasks[task_id].error  = str(e)

    asyncio.create_task(run())
    return task_id

def get_task(task_id: str) -> Task | None:
    return _tasks.get(task_id)
```

```python
# routers/tools.py — 诊断接口统一用 task_id 模式
@router.post("/v1/tools/diagnose_equipment")
async def diagnose_equipment(
    req: DiagnoseReq,
    _: None = Depends(get_service_token),
):
    """Phase A：立即返回 task_id，后台执行；Phase B：task 进 ARQ 队列"""
    async def do_diagnose():
        return await services.diagnosis.run(req.equipment_id, req.context)

    task_id = create_task(do_diagnose())
    return ok({"task_id": task_id, "status": "pending"})


@router.get("/v1/tools/tasks/{task_id}")
async def get_task_result(task_id: str, _: None = Depends(get_service_token)):
    task = get_task(task_id)
    if not task:
        return err("NOT_FOUND", f"任务 {task_id} 不存在", 404)
    return ok({"task_id": task_id, "status": task.status,
               "result": task.result, "error": task.error})
```

**Studio 轮询诊断结果（useQuery + refetchInterval）**：

```typescript
// Phase A：每 2s 轮询 task 结果，done 后停止
const { data } = useQuery({
  queryKey: ["task", taskId],
  queryFn: () => apiFetch<DiagnosisResult>(`/v1/tools/tasks/${taskId}`),
  refetchInterval: (q) => (q.state.data?.data?.status === "done" ? false : 2000),
  enabled: !!taskId,
});
```

---

### 22.4 per-station IMS 配置入库

**问题**：现在 IMS 配置全在 env var，100 个场站 = 100 个不同的 `.env`，运维噩梦。  
**解法**：`stations` 表加一列 `ims_config JSONB`，部署时只需改 DB，不改代码。

```sql
-- migration: add ims_config to stations
ALTER TABLE stations
    ADD COLUMN ims_config JSONB NOT NULL DEFAULT '{"adapter_type":"mock"}';

-- 示例数据
UPDATE stations SET ims_config = '{
    "adapter_type": "opcua",
    "endpoint": "opc.tcp://192.168.100.10:4840",
    "namespace": 2,
    "poll_interval_s": 5,
    "node_map": {
        "C-001.shaft_vibration": "ns=2;i=1001",
        "C-001.outlet_pressure": "ns=2;i=1002"
    }
}' WHERE id = 'S001';
```

```python
# scheduler/ims_manager.py — 按场站 ims_config 启动对应适配器
async def start_station_adapters() -> None:
    """启动所有场站的 IMS 适配器（读 DB 配置，不依赖 env var）"""
    async with get_async_session() as db:
        stations = await db.execute(select(Station).where(Station.is_active == True))
        for station in stations.scalars():
            cfg = station.ims_config or {}
            adapter_type = cfg.get("adapter_type", "mock")
            adapter_cls = get_adapter(adapter_type)       # §20.3 注册表
            adapter = adapter_cls()
            await adapter.connect(
                endpoint=cfg.get("endpoint", ""),
                credentials=cfg.get("credentials", {}),
            )
            asyncio.create_task(_run_adapter(adapter, station.id))

async def _run_adapter(adapter: IMSAdapter, station_id: str) -> None:
    async for reading in adapter.stream_readings():
        await pipeline.emit(reading)   # §22.2 管道
```

---

### 22.5 统一分页规范（所有 list 接口）

```python
# core/pagination.py
from fastapi import Query
from dataclasses import dataclass

@dataclass
class Pagination:
    page:     int
    per_page: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.per_page

def get_pagination(
    page:     int = Query(1, ge=1, le=1000),
    per_page: int = Query(20, ge=1, le=100),
) -> Pagination:
    return Pagination(page=page, per_page=per_page)
```

```python
# 所有 list 路由统一写法
@router.get("/v1/workorders")
async def list_workorders(
    station_id: str,
    state: str | None = None,
    pg:    Pagination  = Depends(get_pagination),
    user:  User        = Depends(get_current_user),
    db:    AsyncSession = Depends(get_db),
):
    require_station(station_id, user)
    q = select(WorkOrder).where(WorkOrder.station_id == station_id)
    if state:
        q = q.where(WorkOrder.state == state)
    total  = await db.scalar(select(func.count()).select_from(q.subquery()))
    items  = await db.scalars(q.offset(pg.offset).limit(pg.per_page))
    return paginate([w.to_dict() for w in items], total, pg.page, pg.per_page)
```

---

### 22.6 结构化日志（structlog，1小时接入）

```python
# core/logging.py — 一次配置，全项目用
import structlog, logging, sys

def setup_logging(level: str = "INFO") -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer() if sys.stderr.isatty()
            else structlog.processors.JSONRenderer(),   # 生产输出 JSON
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper())
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
    )

log = structlog.get_logger()
```

```python
# main.py lifespan 里调用
setup_logging(settings.log_level)   # settings.log_level = "INFO"|"DEBUG"

# 每个模块顶部
import structlog
log = structlog.get_logger()

# 使用方式（自动附带结构化字段，JSON 日志可被 Grafana Loki 直接索引）
log.info("workorder.created", wo_id=wo.wo_id, user_id=user.id,
         station_id=wo.station_id, priority=wo.priority)
log.error("diagnosis.failed", equipment_id=eid, error=str(e), exc_info=True)
```

---

### 22.7 可观测性：健康检查 + Metrics

```python
# routers/health.py — 生产级健康检查
from fastapi import APIRouter
from config.settings import settings
import time

router = APIRouter()

@router.get("/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    checks = {}
    status = "ok"

    # DB
    try:
        await db.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"error: {e}"; status = "degraded"

    # Redis
    try:
        await redis.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "error"; status = "degraded"

    # vLLM（非阻塞，超时 3s）
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{settings.vllm_base_url}/health")
            checks["vllm"] = "ok" if r.status_code == 200 else "degraded"
    except Exception:
        checks["vllm"] = "unreachable"   # vLLM 离线不影响基础功能

    return ok({"status": status, "checks": checks,
               "version": settings.app_version, "ts": int(time.time())})


@router.get("/metrics")
async def prometheus_metrics():
    """Prometheus 格式 metrics（Grafana 抓取）"""
    # Phase A：只暴露基础 metrics，Phase B 接 prometheus_client 库
    lines = [
        f'clawtwin_info{{version="{settings.app_version}"}} 1',
        f'clawtwin_active_sse_connections {len(_sse_queues)}',
        f'clawtwin_task_queue_size {pipeline._queue.qsize()}',
    ]
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain")
```

**nginx.conf 增加：**

```nginx
# 内网才能访问 metrics，不对外暴露
location /metrics {
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 127.0.0.1;
    deny all;
    proxy_pass http://platform:8000/metrics;
}
```

---

### 22.8 数据库连接池配置（3行，必须配）

```python
# db/database.py — 生产级连接池配置
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

engine = create_async_engine(
    settings.database_url,
    # ── 生产级连接池参数 ──────────────────────────────────
    pool_size=10,          # 常驻连接数（根据 uvicorn workers 调整）
    max_overflow=20,       # 峰值额外连接
    pool_timeout=30,       # 等待连接超时（s）
    pool_recycle=1800,     # 连接最大生存时间（s），防止 DB 主动断开
    pool_pre_ping=True,    # 每次获取连接前 ping，自动重连
    echo=settings.debug,   # DEBUG 模式打印 SQL
)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
```

---

### 22.9 后台任务分布式锁（多实例安全）

```python
# scheduler/lock.py — 基于 Redis 的分布式锁（防重复执行）
import aioredis, asyncio
from contextlib import asynccontextmanager
from config.settings import settings

@asynccontextmanager
async def distributed_lock(name: str, ttl_s: int = 120):
    """
    Phase A（单实例）：直接 yield，不需要 Redis。
    Phase B（多实例）：自动启用 Redis SET NX 锁。
    """
    if not settings.distributed_lock_enabled:   # Phase A 默认 False
        yield True
        return

    redis = await aioredis.from_url(settings.redis_url)
    lock_key = f"lock:clawtwin:{name}"
    acquired = await redis.set(lock_key, "1", nx=True, ex=ttl_s)
    try:
        yield acquired
    finally:
        if acquired:
            await redis.delete(lock_key)
    await redis.aclose()


# 在 scheduler 里使用
async def anomaly_check_job():
    async with distributed_lock("anomaly_check", ttl_s=240) as acquired:
        if not acquired:
            log.debug("scheduler.skipped", job="anomaly_check", reason="another instance running")
            return
        # ... 执行检测逻辑
```

---

### 22.10 Security Headers + Rate Limiting（中间件，一次配置）

```python
# main.py — 安全中间件
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

# CORS（精确配置，不用 * ）
app.add_middleware(CORSMiddleware,
    allow_origins=settings.cors_origins,   # ["https://studio.clawtwin.com", "http://localhost:5173"]
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["Authorization", "Content-Type", "X-ClawTwin-Service-Token"],
)

# 安全响应头
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if not settings.debug:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

app.add_middleware(SecurityHeadersMiddleware)

# Rate Limiting（用 slowapi，基于客户端 IP）
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# 在需要限流的路由上加装饰器
# @limiter.limit("10/minute")  ← 登录接口
# @limiter.limit("100/minute") ← 普通 API
```

---

### 22.11 完整 settings.py（生产级配置清单）

```python
# config/settings.py — 全部配置项，不允许散落在代码里
from pydantic_settings import BaseSettings
from typing import Literal

class Settings(BaseSettings):
    # 服务
    app_name:    str  = "ClawTwin Platform"
    app_version: str  = "0.1.0"
    host:        str  = "0.0.0.0"
    port:        int  = 8000
    debug:       bool = False
    log_level:   Literal["DEBUG","INFO","WARNING","ERROR"] = "INFO"

    # 数据库
    database_url:   str  # 必须，无默认值（强制显式配置）
    redis_url:      str  = "redis://localhost:6379/0"

    # AI 服务
    vllm_base_url:   str = "http://localhost:8080"
    vllm_model:      str = "qwen3-35b-a3b"
    vllm_embed_url:  str = "http://localhost:8081"
    vllm_embed_model:str = "bge-m3"
    vllm_timeout_s:  int = 120
    vllm_max_concurrent: int = 3  # 并发 AI 请求上限（Semaphore）

    # 认证
    jwt_secret:    str   # 必须，无默认值
    jwt_expire_h:  int   = 24
    service_token: str   # 必须，无默认值（OpenClaw → Platform）

    # 飞书
    feishu_app_id:     str = ""
    feishu_app_secret: str = ""
    feishu_webhook:    str = ""

    # 分布式
    distributed_lock_enabled: bool = False  # Phase B 设为 True

    # 安全
    cors_origins: list[str] = ["http://localhost:5173"]

    model_config = {"env_file": ".env", "case_sensitive": False}

settings = Settings()
```

---

### 22.12 架构演进总路线图（三阶段对照）

```
维度              Phase A（当前 Demo）         Phase B（单客户生产）     Phase C（多客户企业）
─────────────────────────────────────────────────────────────────────────────────────
进程模型          单进程 uvicorn               uvicorn 多 worker         K8s Pod 水平扩展
实时推送          SSE（asyncio Queue）          SSE + Redis pub/sub       WebSocket + Kafka
AI 推理           asyncio.create_task          ARQ（Redis 队列）          Ray Serve 集群
数据摄入          IngestPipeline（内存 Queue）  Kafka topic               Kafka + Schema Registry
IMS 配置          stations.ims_config JSONB    同左                      多租户隔离
分布式锁          无（单实例）                  Redis SET NX              Redlock
可观测性          /health + 结构化日志          Prometheus + Grafana      Jaeger 分布式追踪
数据库            PostgreSQL 单实例            PostgreSQL + 读replica     CockroachDB / PG HA
向量库            **pgvector**（PG 内嵌）     PostgreSQL HA + pgvector   分库/独立 Milvus（Phase C）
部署              Docker Compose               Docker Compose / K8s      K8s + Helm
```

**关键原则**：Phase A → Phase B 升级时，**业务代码不变，只换实现**。

- `pipeline.emit(reading)` 的调用点不变，内部换 Kafka。
- `create_task(coro)` 的调用点不变，内部换 ARQ job。
- `GET /v1/sse/...` 端点 URL 不变，内部换 Redis pub/sub。

---

_§二十二 新增（2026-05-09）：生产级架构十大必做决策。_
_接口形状现在定对，Phase A 用简单实现，Phase B 换生产实现，业务代码不改。_

---

## 二十三、产品经理 + 架构师全面审视报告（2026-05-09）

> **视角**：这不是又一份设计文档，是对整个项目的诚实评估和缺口填补。  
> 按 PM（产品完整性）+ 架构师（工程可落地性）两条线并行审视，只写还没解决的问题。

---

### 23.1 产品完整性计分（当前状态，满分 10 分）

```
核心产品功能           设计 实现 得分  关键缺口
──────────────────────────────────────────────────────────────
AI 设备诊断            ✓    △    6.0  vLLM 并发保护、circuit breaker 未设计
HITL 工单闭环          ✓    △    6.5  FSM 定义了，代码尚未对齐
实时设备监控           ✓    ✗    5.0  SSE 刚设计，前端 Store 未实现
飞书告警 / 消息        ✓    △    6.0  卡片格式已设计，callback 不完整
知识库 RAG             ✓    ✗    4.0  **pgvector**/KB 闭环未落地，冷启动无内容
P&ID 视图              ✓    ✗    3.0  react-flow 骨架只有设计无代码
视觉巡检               ✓    ✗    2.0  Phase C 功能，提前设计了
3D 数字孪生            △    ✗    3.0  Babylon.js 骨架，无真实设备模型

运营与管理功能         设计 实现 得分  关键缺口
──────────────────────────────────────────────────────────────
用户 / 场站管理 Admin  △    ✗    2.0  ← 最大缺口：IT 交付时必须有
数据导出 / 报表        ✗    ✗    0.0  ← 客户第一个追加需求
知识库内容冷启动       △    ✗    2.0  策略提了但无实施方案
系统健康监控           ✓    ✗    5.0  /health 设计了，Grafana 无配置
备份 / 恢复策略        ✗    ✗    0.0  ← 运维必须有
升级 / 迁移策略        △    ✗    2.0  Alembic 提了，流程不完整
时区处理               ✗    ✗    0.0  OPC-UA 数据时区问题未解决

AI 可靠性             设计 实现 得分  关键缺口
──────────────────────────────────────────────────────────────
并发限制（Semaphore）   △    ✗    3.0  settings 里有配置但无实现
Circuit breaker        ✗    ✗    0.0  vLLM 挂掉时系统无保护
降级模式（AI 离线）    ✗    ✗    0.0  ← 用户无感知降级是生产必须

综合评分：Phase A Demo 就绪度   ████████░░  6.5/10
          Phase B 生产就绪度     ████░░░░░░  4.0/10
```

---

### 23.2 AI 可靠性：并发控制 + Circuit Breaker + 降级模式

这三个不做，生产上第一个月就会有 P0 事故。

```python
# services/ai_client.py — 生产级 AI 调用封装（替代散落的 httpx 调用）
import asyncio, httpx, time
from enum import Enum
from config.settings import settings
import structlog

log = structlog.get_logger()


class CircuitState(str, Enum):
    CLOSED   = "closed"    # 正常
    OPEN     = "open"      # 熔断（快速失败）
    HALF_OPEN = "half_open" # 试探恢复


class AIClient:
    """
    生产级 AI 调用客户端：
    1. Semaphore 限制并发（防 GPU OOM）
    2. Circuit breaker（防级联失败）
    3. Timeout（防 HTTP worker 耗尽）
    4. 降级返回（AI 离线时给用户有意义的响应）
    """

    def __init__(self) -> None:
        self._sem    = asyncio.Semaphore(settings.vllm_max_concurrent)  # 默认 3
        self._state  = CircuitState.CLOSED
        self._fail_count = 0
        self._fail_threshold = 5        # 连续失败 5 次后熔断
        self._reset_after_s  = 60       # 熔断 60s 后半开试探
        self._open_since: float = 0

    async def chat(
        self,
        messages: list[dict],
        temperature: float = 0.1,
        max_tokens: int = 4096,
        timeout_s: int | None = None,
    ) -> str:
        """调用 vLLM，内置并发控制 + circuit breaker"""

        # circuit breaker 快速失败
        if self._state == CircuitState.OPEN:
            if time.time() - self._open_since < self._reset_after_s:
                log.warning("ai.circuit_open", state=self._state)
                return self._degraded_response()
            else:
                self._state = CircuitState.HALF_OPEN
                log.info("ai.circuit_half_open")

        # Semaphore：同一时刻最多 N 个 AI 请求
        async with self._sem:
            try:
                result = await self._do_chat(
                    messages, temperature, max_tokens,
                    timeout_s or settings.vllm_timeout_s,
                )
                self._on_success()
                return result
            except Exception as e:
                self._on_failure(e)
                if self._state == CircuitState.OPEN:
                    return self._degraded_response()
                raise

    async def _do_chat(self, messages, temperature, max_tokens, timeout_s) -> str:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                f"{settings.vllm_base_url}/v1/chat/completions",
                json={"model": settings.vllm_model, "messages": messages,
                      "temperature": temperature, "max_tokens": max_tokens},
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]

    def _on_success(self) -> None:
        self._fail_count = 0
        if self._state == CircuitState.HALF_OPEN:
            self._state = CircuitState.CLOSED
            log.info("ai.circuit_closed")

    def _on_failure(self, exc: Exception) -> None:
        self._fail_count += 1
        log.error("ai.call_failed", fail_count=self._fail_count, error=str(exc))
        if self._fail_count >= self._fail_threshold:
            self._state    = CircuitState.OPEN
            self._open_since = time.time()
            log.error("ai.circuit_tripped", threshold=self._fail_threshold)

    def _degraded_response(self) -> str:
        """AI 服务不可用时的降级响应，用户可感知但不崩溃"""
        return (
            "⚠️ AI 分析服务暂时不可用（正在恢复中）。\n"
            "请根据设备实时数据和历史告警手动判断。\n"
            "技术支持：检查 vLLM 服务状态。"
        )

    @property
    def is_healthy(self) -> bool:
        return self._state != CircuitState.OPEN

    @property
    def circuit_state(self) -> str:
        return self._state.value


# 全局单例
ai_client = AIClient()
```

**降级模式 UI 策略**（Studio）：

```typescript
// AI 返回降级响应时，Studio 显示的不是错误，而是有意义的降级提示
function DiagnosisResult({ result }: { result: string }) {
  const isDegraded = result.startsWith("⚠️ AI 分析服务");
  if (isDegraded) {
    return (
      <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3">
        <p className="text-sm text-amber-400">AI 服务维护中</p>
        <p className="text-xs text-[#8B949E] mt-1">
          请参考历史告警记录和设备手册进行人工判断
        </p>
        <button className="mt-2 text-xs text-blue-400 underline" onClick={openManualCheckPanel}>
          查看设备手册
        </button>
      </div>
    );
  }
  return <MarkdownRenderer content={result} />;
}
```

---

### 23.3 数据导出 API（客户第一个追加需求）

工业客户第一个追加需求必定是："能导出 Excel 吗？"设计在这里。

```python
# routers/reports.py — 数据导出端点
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from datetime import datetime, date
import io, csv
from openpyxl import Workbook

router = APIRouter(prefix="/v1/reports", tags=["reports"])


@router.get("/workorders.{fmt}")
async def export_workorders(
    fmt: str,                             # "csv" | "xlsx"
    station_id: str,
    date_from:  date | None = None,
    date_to:    date | None = None,
    state:      str  | None = None,
    user = Depends(get_current_user),
    db   = Depends(get_db),
):
    """导出工单记录（CSV 或 Excel）"""
    require_station(station_id, user)

    q = select(WorkOrder).where(WorkOrder.station_id == station_id)
    if date_from: q = q.where(WorkOrder.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:   q = q.where(WorkOrder.created_at <= datetime.combine(date_to,   datetime.max.time()))
    if state:     q = q.where(WorkOrder.state == state)
    rows = (await db.scalars(q.order_by(WorkOrder.created_at.desc()))).all()

    headers = ["工单编号","标题","设备","优先级","状态","创建时间","完成时间","执行备注"]
    data = [[
        r.wo_id, r.title, r.equipment_id, r.priority, r.state,
        r.created_at.strftime("%Y-%m-%d %H:%M"),
        r.done_at.strftime("%Y-%m-%d %H:%M") if r.done_at else "",
        r.execution_notes or "",
    ] for r in rows]

    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(headers)
        w.writerows(data)
        buf.seek(0)
        filename = f"workorders_{station_id}_{date.today()}.csv"
        return StreamingResponse(iter([buf.getvalue()]),
                                 media_type="text/csv;charset=utf-8-sig",
                                 headers={"Content-Disposition": f"attachment; filename={filename}"})

    # Excel
    wb = Workbook()
    ws = wb.active
    ws.title = "工单记录"
    ws.append(headers)
    for row in data: ws.append(row)
    # 列宽自适应
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = max(len(str(c.value or "")) for c in col) + 2

    buf2 = io.BytesIO()
    wb.save(buf2); buf2.seek(0)
    filename = f"workorders_{station_id}_{date.today()}.xlsx"
    return StreamingResponse(buf2,
                             media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.get("/equipment-readings.csv")
async def export_readings(
    station_id:   str,
    equipment_id: str,
    metric:       str,
    date_from:    date,
    date_to:      date,
    user = Depends(get_current_user),
    db   = Depends(get_db),
):
    """导出设备历史数据（传感器曲线，CSV）"""
    require_station(station_id, user)
    # 从 TimescaleDB 查询，按 time_bucket 降采样（每分钟均值）
    sql = text("""
        SELECT time_bucket('1 minute', ts) AS t,
               AVG(value) AS avg_val, MIN(value) AS min_val, MAX(value) AS max_val
        FROM equipment_readings
        WHERE equipment_id = :eid AND metric = :metric
          AND ts BETWEEN :from AND :to
        GROUP BY 1 ORDER BY 1
    """)
    result = await db.execute(sql, {"eid": equipment_id, "metric": metric,
                                    "from": date_from, "to": date_to})
    rows = result.fetchall()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["时间","均值","最小值","最大值"])
    for r in rows: w.writerow([r.t.strftime("%Y-%m-%d %H:%M"), round(r.avg_val,3),
                                round(r.min_val,3), round(r.max_val,3)])
    buf.seek(0)
    filename = f"{equipment_id}_{metric}_{date_from}_{date_to}.csv"
    return StreamingResponse(iter([buf.getvalue()]),
                             media_type="text/csv;charset=utf-8-sig",
                             headers={"Content-Disposition": f"attachment; filename={filename}"})
```

**依赖新增（requirements.txt）**：

```
openpyxl>=3.1.0
slowapi>=0.1.9
structlog>=24.0.0
```

---

### 23.4 Admin 产品设计（IT 交付时必须有）

**Admin 是什么**：IT 管理员用来配置场站、设备、用户的后台。不需要华丽 UI，要的是**完整功能**。  
**不是什么**：不是另一个 Studio，不做数据分析，只管理配置。

**Admin 端点清单（追加到 §18.6 API 真相表）**：

```
用户管理
  POST   /v1/admin/users/                  创建用户（指定 role + station_ids）
  GET    /v1/admin/users/                  列出所有用户（分页）
  PATCH  /v1/admin/users/{id}              更新用户（改 role/station_ids/active）
  DELETE /v1/admin/users/{id}              停用用户（软删除，is_active=False）
  POST   /v1/admin/users/{id}/reset-pwd    管理员重置密码

场站管理
  POST   /v1/admin/stations/               创建场站（含 ims_config）
  GET    /v1/admin/stations/               列出所有场站
  PATCH  /v1/admin/stations/{id}           更新场站（改 ims_config/name/area）
  POST   /v1/admin/stations/{id}/reload    重启该场站的 IMS 适配器

设备管理
  POST   /v1/admin/equipment/              批量导入设备（JSON/CSV）
  GET    /v1/admin/equipment/              列出设备（过滤 station_id/type）
  PATCH  /v1/admin/equipment/{id}          更新设备元数据（name/type/area/thresholds）

知识库管理
  POST   /v1/admin/kb/documents/           上传文档（PDF/Word → 分块 → 向量化）
  GET    /v1/admin/kb/documents/           列出知识库文档
  DELETE /v1/admin/kb/documents/{id}       删除文档及其向量

系统
  GET    /v1/admin/system/stats            系统统计（用户数/设备数/工单数/KB文档数）
  GET    /v1/admin/system/logs             审计日志（操作者/时间/行为）
  POST   /v1/admin/system/backup           触发手动备份
```

**Admin 路由权限**：所有 `/v1/admin/*` 必须 `user.role == "sys_admin"`，无例外。

```python
# auth/deps.py 追加
async def get_admin_user(user: User = Depends(get_current_user)) -> User:
    if user.role != "sys_admin":
        raise HTTPException(403, "需要系统管理员权限")
    return user
```

**Admin UI**（极简，不需要 Babylon.js）：

```
ClawTwin Admin（独立路由 /admin，同一个 Studio 应用，sys_admin 可见）
├── /admin/users          用户列表 + 新建 + 编辑（场站分配）
├── /admin/stations       场站列表 + IMS 配置编辑（JSON 表单）
├── /admin/equipment      设备列表 + 批量导入（CSV 模板下载）
├── /admin/kb             知识库文档上传 + 向量化进度
└── /admin/system         系统状态 + 审计日志 + 备份触发
```

---

### 23.5 知识库冷启动策略（Day 1 必须有有意义的 AI 回答）

**问题**：系统上线第一天，**知识库/pgvector** 中无向量，AI 难以给出基于 KB 的诊断，客户失望。

**分层冷启动方案**：

```
L0：通用工业知识（系统出厂预置，开发阶段完成）
  - GB/T 7777 容积式压缩机 振动测量与评价（PDF → 分块 → 预置向量）
  - API 618 往复式压缩机标准（节选关键章节）
  - 天然气管输站场运营规程（通用版）
  - 常见石油机械故障码手册（结构化 JSON）
  → 开发团队负责，上线前完成，不依赖客户提供

L1：设备型号知识（设备购买合同附带，交付时导入）
  - 该场站实际安装的压缩机厂商手册（PDF）
  - 泵、分离器、计量仪表的出厂说明书
  - 历史大修记录（Word/Excel → AI 提取关键信息 → 结构化存入）
  → 销售合同要求客户提供，IT 实施时由运维工程师上传 Admin

L2：场站历史经验（运行一段时间后自动积累）
  - 工单完成后自动提取经验（write_l3_knowledge）
  - 操作员在工单执行备注中填写的关键信息
  - 预计 2-3 个月后开始有效
  → 系统自动积累，无需人工干预

冷启动验证标准（M3 里程碑）：
  搜索"轴承振动超标"→ 召回 ≥ 3 条 L0/L1 文档，相关性分数 > 0.75
  AI 诊断"压缩机出口压力异常"→ 回答含 ≥ 2 个文档引用
```

**Admin KB 页面的文档导入流程**：

```python
# routers/admin.py — 文档上传端点（含向量化进度）
@router.post("/v1/admin/kb/documents/")
async def upload_kb_document(
    file:     UploadFile,
    layer:    str = Form("L1"),           # L0/L1/L2
    doc_type: str = Form("manual"),       # manual/standard/record
    admin: User = Depends(get_admin_user),
    db:   AsyncSession = Depends(get_db),
):
    """上传文档 → 后台分块 → 向量化 → 写入 **pgvector** + PostgreSQL"""
    content = await file.read()
    task_id = create_task(_vectorize_document(content, file.filename, layer, doc_type, db))
    return ok({"task_id": task_id, "filename": file.filename,
               "status": "vectorizing",
               "hint": f"轮询 /v1/tools/tasks/{task_id} 查看进度"})
```

---

### 23.6 时区处理（UTC 存储，本地显示）

**工业系统时区处理不当的代价**：OPC-UA 服务器是北京时间，vLLM 日志是 UTC，Studio 显示的时间混乱，工单时间线对不上——这是真实发生过的严重 bug。

**全局规则（一次定，全项目执行）**：

```
存储层：所有 TIMESTAMPTZ 字段存 UTC
OPC-UA：Bridge 读取数据后，统一转换为 UTC 再入库
API 层：所有时间字段返回 ISO 8601 UTC（带 Z 后缀）
              如 "2026-05-09T10:30:00Z"
Studio：dayjs().utc() 解析，按用户本地时区显示
飞书卡片：服务端格式化为"北京时间 YYYY-MM-DD HH:mm"再发送
日志：structlog 已配置 TimeStamper(fmt="iso")，自动 UTC
```

```python
# 在 OPC-UA bridge 里统一处理时区
from datetime import timezone

def normalize_opcua_ts(opcua_ts) -> str:
    """将 OPC-UA 时间戳（可能是 naive 本地时间）统一转为 UTC ISO 8601"""
    if opcua_ts.tzinfo is None:
        # 假设 OPC-UA 服务器在北京时间（CST = UTC+8）
        from datetime import timezone, timedelta
        cst = timezone(timedelta(hours=8))
        opcua_ts = opcua_ts.replace(tzinfo=cst)
    return opcua_ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

```typescript
// Studio 统一时间显示工具
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
dayjs.extend(utc);
dayjs.extend(timezone);

export function formatTime(isoUtc: string, fmt = "MM-DD HH:mm:ss") {
  // 自动用浏览器本地时区显示
  return dayjs.utc(isoUtc).local().format(fmt);
}
export function formatTimeBeijing(isoUtc: string) {
  return dayjs.utc(isoUtc).tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm");
}
```

---

### 23.7 零停机升级策略

**问题**：v1.0 → v1.1 如果 Alembic 直接跑 schema 变更，生产环境 30 秒停机 → 客户投诉。

**正确的升级流程（Blue-Green + 兼容迁移）**：

```
Step 1：发布 v1.1（schema 兼容性迁移）
  - 新列用 nullable 或 DEFAULT，不删旧列
  - Alembic revision：添加新列，不删旧列
  - 示例：ALTER TABLE work_orders ADD COLUMN new_field VARCHAR(100);
  - 同时运行 v1.0 和 v1.1 代码（互相不知道对方）

Step 2：代码切换
  - 停旧容器，启新容器（Docker pull + restart，< 5s）
  - 新代码读写新列，旧列废弃（不删）

Step 3：清理旧列（下下个版本）
  - 确认 v1.1 稳定运行 2 周后
  - 再发 Alembic revision 删旧列

标准迁移模板（每次数据库变更必须遵守）：
  ✓ ADD COLUMN nullable / ADD COLUMN DEFAULT value      ← 兼容，可直接上线
  ✓ CREATE INDEX CONCURRENTLY（PostgreSQL 不锁表）       ← 兼容
  ✗ DROP COLUMN                                         ← 非兼容，需两个版本间隔
  ✗ ALTER COLUMN TYPE（直接改类型）                      ← 非兼容，需新建列+迁移数据
  ✗ ADD COLUMN NOT NULL（无 DEFAULT）                    ← 锁表，禁止生产直接跑
```

**docker-compose 升级命令**（写进 README，运维可直接执行）：

```bash
# 标准升级流程（约 30 秒）
git pull origin main
docker compose pull platform-api studio
docker compose up -d --no-deps platform-api studio
# 验证
curl http://localhost:8080/v1/health
```

---

### 23.8 数据备份与恢复（运维必须有）

```yaml
# docker-compose.yml 追加 backup 服务
services:
  backup:
    image: prodrigestivill/postgres-backup-local
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: clawtwin
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      SCHEDULE: "0 2 * * *" # 每天凌晨 2 点
      BACKUP_KEEP_DAYS: 7
      BACKUP_KEEP_WEEKS: 4
      BACKUP_KEEP_MONTHS: 3
    volumes:
      - ./backups:/backups
    depends_on: [postgres]
```

**恢复流程文档（必须写入 README）**：

```bash
# 查看可用备份
ls ./backups/

# 恢复（停机恢复，约 5 分钟）
docker compose stop platform-api
docker exec -i $(docker compose ps -q postgres) \
  pg_restore -U $POSTGRES_USER -d clawtwin < ./backups/clawtwin_2026-05-09.dump
docker compose start platform-api
```

---

### 23.9 Phase A Demo 脚本（5 分钟客户演示）

**目标受众**：油气场站 IT 负责人 + 生产部门经理  
**核心信息**：三句话说完产品价值，用 Demo 说话。

```
第 1 分钟：设备实时状态（Studio 概览）
─────────────────────────────────────
操作：打开 Studio → 场站地图视图
展示：
  - 5 台设备的实时状态（绿/黄/红）
  - C-001 压缩机显示振动告警（amber 颜色）
  - StationHeatmap 显示告警区域
话术："这就是实时的场站状态，不用打电话问操作员"

第 2 分钟：AI 诊断（DeviceIntelPanel）
─────────────────────────────────────
操作：点击 C-001 → 右侧 IntelPanel 展开
展示：
  - AI 诊断摘要（轴承磨损风险，置信度 82%）
  - 3 个 citations（点击展开文档段落）
  - One Big Action 按钮："创建检查工单"
话术："AI 不只是说'有问题'，它告诉你为什么、依据是什么、建议做什么"

第 3 分钟：飞书一键建工单（HITL 闭环）
─────────────────────────────────────
操作：点击"创建检查工单" → 确认 → 看飞书
展示：
  - 飞书主管收到审批卡片（10 秒内）
  - 卡片显示：设备名、问题摘要、AI 建议步骤、优先级 P2
  - 点击"通过" → Studio 工单看板出现"已批准"
话术："从 AI 发现问题到主管审批，不超过 2 分钟，全程在飞书"

第 4 分钟：数据可追溯（Citations + 审计）
─────────────────────────────────────
操作：展开工单详情 → 查看 AI 依据（citations）
展示：
  - AI 引用了压缩机厂商手册第 43 页
  - 引用了上个月同类设备工单的处理经验
  - 审计日志显示谁批准了、什么时间
话术："AI 的每个建议都有出处，不是黑盒，符合工业安全要求"

第 5 分钟：Q&A 和下一步
─────────────────────────────────────
提前准备的 3 个问题回答：
  Q: "数据安全吗？LLM 会把我们的数据发出去吗？"
  A: "vLLM 完全私有部署在你们内网，数据不出厂"

  Q: "能对接我们现有的 SCADA/OPC-UA 吗？"
  A: "Phase B 标准功能，已经设计好接口，3 个月内交付"

  Q: "如果 AI 回答错了怎么办？"
  A: "所有 AI 建议都需要人工审批才能执行（HITL），
     AI 是副驾驶，人是最终决策者"
```

---

### 23.10 风险登记册（Top 7 项目风险）

```
风险 1：知识库冷启动内容不足，AI 回答质量差（Demo 失败）
  概率：高  影响：高  对策：开发阶段就预置 L0 知识，设 M3 验收标准
  负责人：技术负责人  截止：M3（Week 6）

风险 2：vLLM GPU 服务器性能不足（多人演示时卡顿）
  概率：中  影响：高  对策：vllm_max_concurrent=2，Semaphore 保护，演示前压测
  负责人：运维  截止：M6（Week 12）

风险 3：飞书 Bot 回调延迟过高（> 5s，影响 Demo 体验）
  概率：中  影响：中  对策：飞书 Webhook → Redis pub/sub → 消费快速推送
  负责人：后端  截止：M4（Week 8）

风险 4：OPC-UA 客户现场设备型号不兼容
  概率：中  影响：高  对策：Phase A 用 Mock，Phase B 前做设备调研，IMSAdapter 预留
  负责人：售前工程师  截止：M7（Month 4）

风险 5：客户数据隐私顾虑（AI 处理生产数据）
  概率：高  影响：高  对策：私有化部署设计、隔离网络方案（PRODUCTION-ARCH 已有）
  负责人：产品/售前  截止：合同谈判阶段

风险 6：工单 FSM 状态不一致（前后端未同步）
  概率：已发生  影响：中  对策：§19 权威定义，SKILL.md 错误历史，PR 门禁检查
  负责人：全部开发  截止：M2（Week 4）

风险 7：多人协作文档偏差导致重复开发
  概率：已发生  影响：高  对策：DEVELOPMENT-CONTRACT 作为唯一入口，clawtwin.mdc 规则，TEAM-COLLAB 门禁
  负责人：技术负责人  持续跟踪
```

---

### 23.11 产品路线图修订（PM 视角重新定义里程碑交付物）

**PM 的里程碑 = 用户/客户可以看到和感受到的东西，不是技术任务完成。**

```
M1（Week 2）：系统能跑起来
  交付物：一个 URL，任何人浏览器打开能看到登录页和场站地图

M2（Week 4）：设备"活了"
  交付物：点击设备看到实时数据变化（Mock 数据 5s 刷新）
           Demo 视频：30 秒展示设备数据实时变化

M3（Week 6）：AI 开口说话
  交付物：AI 能回答"压缩机振动过高怎么办"并引用文档来源
           Demo 视频：飞书问答带 citations（30 秒）

M4（Week 8）：飞书一键审批工单
  交付物：从 Studio 点击到飞书收到审批卡片 < 1 分钟
           Demo 视频：工单闭环全流程（60 秒）

M5（Week 10）：运维自主化基础
  交付物：每天早 8 点飞书收到晨报，告警会推送，不需要人盯着
           Demo 视频：晨报卡片展示（30 秒）

M6（Week 12）：Phase A 客户演示版
  交付物：5 分钟 Demo 脚本可以跑通（§23.9）
           文档：安装手册 + 用户手册 + FAQ（供客户 IT 阅读）
           Admin 可以让 IT 创建用户和场站
```

---

_§二十三 新增（2026-05-09）：PM+架构师全面审视。_
_新增实现：AI circuit breaker、数据导出 API、Admin 端点、知识冷启动策略、时区规范、升级策略、备份方案。_
_附：Phase A Demo 脚本（5 分钟）、风险登记册、里程碑交付物重定义。_

---

## 二十四、完整胶水代码：把所有设计真正连在一起（2026-05-09）

> **本节解决开发时最常见的问题**：每个模块都设计了，但没人知道它们怎么装配在一起。  
> 开发者看完本节，应该能直接写代码，不再需要在 7500 行文档里来回跳。

---

### 24.1 完整 main.py（权威版本，替代所有之前散落的版本）

```python
# platform-api/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError

from config.settings import settings
from core.logging import setup_logging
from core.response import http_exception_handler, validation_exception_handler
from db.database import init_db
from services.ingest import pipeline
from services.ims.ims_manager import start_station_adapters
from services.ai_client import ai_client   # §23.2 AIClient 单例
import structlog

log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动 / 关闭生命周期"""
    # ── 启动 ──────────────────────────────────────────────────
    setup_logging(settings.log_level)
    log.info("platform.starting", version=settings.app_version)

    await init_db()                        # 创建表（开发用，生产用 Alembic）

    # 注册摄入管道消费者（顺序很重要）
    from services.ingest import (
        _handler_save_to_db,
        _handler_update_redis_cache,
        _handler_trigger_sse,
    )
    pipeline.register_handler(_handler_save_to_db)
    pipeline.register_handler(_handler_update_redis_cache)
    pipeline.register_handler(_handler_trigger_sse)

    import asyncio
    asyncio.create_task(pipeline.start())  # 摄入消费循环
    asyncio.create_task(start_station_adapters())  # 按场站 ims_config 启动适配器

    # APScheduler
    from scheduler.jobs import start_scheduler
    start_scheduler()

    log.info("platform.started")
    yield

    # ── 关闭 ──────────────────────────────────────────────────
    log.info("platform.stopping")
    from scheduler.jobs import stop_scheduler
    stop_scheduler()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/docs" if settings.debug else None,   # 生产关闭 Swagger
    lifespan=lifespan,
)

# ── 异常处理（统一格式 §22.1）────────────────────────────────
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)

# ── 中间件（§22.10）──────────────────────────────────────────
from fastapi.middleware.cors import CORSMiddleware
from core.security import SecurityHeadersMiddleware

app.add_middleware(CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
    allow_headers=["Authorization","Content-Type","X-ClawTwin-Service-Token"],
)
app.add_middleware(SecurityHeadersMiddleware)

# ── 路由注册（全量，包含所有已设计端点）────────────────────
from routers import (
    auth, equipment, stations, workorder,
    alarms, tools, notifications, shifts, search,
    reports, health, sse,
)
from routers import admin as admin_router

app.include_router(auth.router)
app.include_router(equipment.router)
app.include_router(stations.router)
app.include_router(workorder.router)          # /v1/workorders/*
app.include_router(workorder.hitl_router)     # /v1/hitl/*
app.include_router(alarms.router)
app.include_router(tools.router)              # /v1/tools/*（Service Token）
app.include_router(notifications.router)      # /v1/notifications/*
app.include_router(shifts.router)
app.include_router(search.router)
app.include_router(reports.router)            # /v1/reports/*（数据导出 §23.3）
app.include_router(sse.router)                # /v1/sse/*（实时推送 §21.3）
app.include_router(admin_router.router)       # /v1/admin/*（Admin §23.4）
app.include_router(health.router)             # /health /metrics


@app.get("/")
async def root():
    return {"service": settings.app_name, "version": settings.app_version,
            "docs": "/docs", "health": "/health",
            "auth": f"/v1/auth/login"}
```

---

### 24.2 services/kb.py — 知识库完整实现（**pgvector** + PostgreSQL；§12.2 Milvus 样板已废弃）

```python
# services/kb.py — 知识库搜索与写入（Phase A 实现）
from __future__ import annotations
import json, time
from typing import Optional
from dataclasses import dataclass

import structlog
log = structlog.get_logger()


@dataclass
class KBChunk:
    """知识库检索结果单元"""
    chunk_id:    str
    content:     str
    source:      str        # "GB-50251-2015:§7.3"
    citation:    str        # 用于 AI 回答中的引用标注
    score:       float      # 相关性分数 0-1
    layer:       str        # L0/L1/L2/L3
    doc_id:      str
    station_id:  Optional[str] = None  # L3 限定场站


# ── [已废弃样本] Milvus Collection Schema — **Phase A 请用 `kb_chunks` + pgvector（铁律 20）** ──
MILVUS_COLLECTION = "clawtwin_kb"
MILVUS_DIM = 1024   # BAAI/bge-m3 输出维度

MILVUS_SCHEMA_DEF = {
    "collection_name": MILVUS_COLLECTION,
    "fields": [
        {"name": "chunk_id",    "dtype": "VARCHAR", "max_length": 64,  "is_primary": True},
        {"name": "doc_id",      "dtype": "VARCHAR", "max_length": 64},
        {"name": "layer",       "dtype": "VARCHAR", "max_length": 4},   # L0/L1/L2/L3
        {"name": "station_id",  "dtype": "VARCHAR", "max_length": 20},  # L3 专用，其余 ""
        {"name": "equipment_type","dtype":"VARCHAR", "max_length": 30},  # 设备类型过滤
        {"name": "source",      "dtype": "VARCHAR", "max_length": 200},
        {"name": "citation",    "dtype": "VARCHAR", "max_length": 200},
        {"name": "content",     "dtype": "VARCHAR", "max_length": 4000},
        {"name": "embedding",   "dtype": "FLOAT_VECTOR", "dim": MILVUS_DIM},
    ],
    "index": {
        "field_name": "embedding",
        "index_type": "IVF_FLAT",
        "metric_type": "COSINE",
        "params": {"nlist": 128},
    }
}


async def ensure_collection() -> None:
    """[已废弃] 曾为 Milvus 建集合。Phase A：改为校验 PostgreSQL `vector` 扩展与 `kb_chunks` 表。"""
    from pymilvus import MilvusClient
    from config.settings import settings

    client = MilvusClient(settings.milvus_uri)
    if not client.has_collection(MILVUS_COLLECTION):
        from pymilvus import CollectionSchema, FieldSchema, DataType, Collection
        fields = []
        for f in MILVUS_SCHEMA_DEF["fields"]:
            dtype = getattr(DataType, f["dtype"])
            kwargs = {k: v for k, v in f.items() if k not in ("name","dtype")}
            fields.append(FieldSchema(name=f["name"], dtype=dtype, **kwargs))
        schema = CollectionSchema(fields, enable_dynamic_field=False)
        col = Collection(name=MILVUS_COLLECTION, schema=schema)
        idx = MILVUS_SCHEMA_DEF["index"]
        col.create_index(idx["field_name"],
                         {"index_type": idx["index_type"],
                          "metric_type": idx["metric_type"],
                          "params": idx["params"]})
        log.info("kb.collection_created", collection=MILVUS_COLLECTION)
    client.close()


async def search_kb(
    query: str,
    layer: Optional[str] = None,          # None = 搜全部
    equipment_type: Optional[str] = None,
    station_id: Optional[str] = None,     # L3 场站过滤
    top_k: int = 5,
    min_score: float = 0.45,
) -> list[KBChunk]:
    """
    向量搜索知识库，返回按相关性排序的 chunks。
    调用方：Tool API /v1/tools/kb/search（OpenClaw Skill 触发）
    """
    from services.ai_client import ai_client
    from pymilvus import MilvusClient
    from config.settings import settings

    # 1. 生成查询向量
    try:
        query_vec = await ai_client.embed(query)
    except Exception as e:
        log.error("kb.embed_failed", error=str(e))
        return []

    # 2. 构建 Milvus 过滤表达式
    filters = []
    if layer:
        filters.append(f'layer == "{layer}"')
    if equipment_type:
        filters.append(f'equipment_type == "{equipment_type}"')
    if station_id:
        # L3 必须过滤 station_id；其他 layer 不限制
        filters.append(f'(layer != "L3" || station_id == "{station_id}")')
    filter_expr = " && ".join(filters) if filters else ""

    # 3. 向量搜索
    try:
        client = MilvusClient(settings.milvus_uri)
        results = client.search(
            collection_name=MILVUS_COLLECTION,
            data=[query_vec],
            filter=filter_expr or None,
            limit=top_k * 2,             # 多搜一些，分数过滤后取前 top_k
            output_fields=["chunk_id","doc_id","layer","station_id",
                           "source","citation","content"],
            search_params={"metric_type": "COSINE", "params": {"nprobe": 16}},
        )
        client.close()
    except Exception as e:
        log.error("kb.milvus_search_failed", error=str(e))
        return []

    # 4. 处理结果
    chunks = []
    for hit in results[0]:
        score = hit.get("distance", 0)    # COSINE 距离，越高越相关
        if score < min_score:
            continue
        entity = hit.get("entity", {})
        chunks.append(KBChunk(
            chunk_id=entity.get("chunk_id", ""),
            content=entity.get("content", ""),
            source=entity.get("source", ""),
            citation=entity.get("citation", ""),
            score=round(score, 4),
            layer=entity.get("layer", ""),
            doc_id=entity.get("doc_id", ""),
            station_id=entity.get("station_id") or None,
        ))

    # 5. 按优先级重排（L3 > L2 > L1 > L0；同层内按分数）
    layer_rank = {"L3": 4, "L2": 3, "L1": 2, "L0": 1}
    chunks.sort(key=lambda c: (layer_rank.get(c.layer, 0), c.score), reverse=True)
    return chunks[:top_k]


async def write_l3_knowledge(
    station_id: str,
    wo_id: str,
    title: str,
    content: str,          # AI 从工单 execution_notes 提炼的关键经验
    equipment_type: str,
) -> None:
    """
    工单完成后将经验写入 L3 知识库。
    调用方：workorder.py FSM done 状态转换时。
    """
    from services.ai_client import ai_client
    from pymilvus import MilvusClient
    from config.settings import settings
    import uuid

    citation = f"L3:{station_id}:{wo_id}"
    source = f"工单经验-{station_id}-{wo_id}"
    chunk_id = f"l3-{wo_id}-{uuid.uuid4().hex[:8]}"

    try:
        embedding = await ai_client.embed(content)
        client = MilvusClient(settings.milvus_uri)
        client.insert(MILVUS_COLLECTION, [{
            "chunk_id": chunk_id,
            "doc_id": wo_id,
            "layer": "L3",
            "station_id": station_id,
            "equipment_type": equipment_type,
            "source": source,
            "citation": citation,
            "content": content[:3900],     # VARCHAR 4000 限制
            "embedding": embedding,
        }])
        client.close()
        log.info("kb.l3_written", wo_id=wo_id, station_id=station_id)
    except Exception as e:
        log.error("kb.l3_write_failed", wo_id=wo_id, error=str(e))
        # 写入失败不阻断工单完成流程
```

---

### 24.3 完整 Tool API（OpenClaw Skills 实际调用的端点）

这是 OpenClaw Skills 和 Platform 的边界。每个 Skill 调用的端点必须在这里实现。

```python
# routers/tools.py — Tool API（Service Token 保护，OpenClaw Skills 调用）
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from auth.deps import get_service_token
from core.response import ok, err
from services.ai_client import ai_client
from services.kb import search_kb, KBChunk
from services.actions.work_order_action import get_ai_primary_action
from services.tasks import create_task, get_task
import structlog

log = structlog.get_logger()
router = APIRouter(prefix="/v1/tools", tags=["tools"], dependencies=[Depends(get_service_token)])


# ── 1. 知识库搜索（industrial-kb Skill 调用）────────────────
class KBSearchReq(BaseModel):
    query:          str
    layer:          Optional[str] = None      # None=all, "L0"/"L1"/"L2"/"L3"
    equipment_type: Optional[str] = None
    station_id:     Optional[str] = None      # L3 过滤
    top_k:          int = 5

@router.post("/kb/search")
async def kb_search(req: KBSearchReq):
    chunks = await search_kb(req.query, req.layer, req.equipment_type,
                             req.station_id, req.top_k)
    return ok([{
        "content": c.content,
        "source":  c.source,
        "citation": c.citation,
        "score":   c.score,
        "layer":   c.layer,
    } for c in chunks])


# ── 2. 设备诊断（industrial-twin Skill 调用）────────────────
class DiagnoseReq(BaseModel):
    equipment_id:  str
    station_id:    str
    context:       dict = {}   # 当前读数、告警历史、AI Skill 传入的上下文

@router.post("/diagnose_equipment")
async def diagnose_equipment(req: DiagnoseReq):
    """
    Phase A 流程：
    1. 从 TimescaleDB 查近 1h 读数
    2. KB 搜索相关文档（§24.2）
    3. 构建 Prompt → vLLM
    4. 解析返回 → 结构化 JSON
    返回 task_id（异步，§22.3）
    """
    async def _run():
        from db.database import get_async_session
        from db.models.equipment_reading import EquipmentReading
        from sqlalchemy import select, desc
        import json

        # 1. 查近 1h 读数
        async with get_async_session() as db:
            q = (select(EquipmentReading)
                 .where(EquipmentReading.equipment_id == req.equipment_id)
                 .order_by(desc(EquipmentReading.ts))
                 .limit(60))
            readings = (await db.scalars(q)).all()
            readings_summary = {r.metric: {"latest": r.value, "quality": r.quality}
                                for r in readings}

        # 2. KB 搜索
        from services.ontology.registry import get_equipment_type
        eq_type_def = get_equipment_type(req.context.get("equipment_type", "compressor"))
        kb_results = await search_kb(
            query=f"{eq_type_def.display_name} 故障诊断 {list(readings_summary.keys())}",
            station_id=req.station_id, top_k=5,
        )
        kb_context = "\n".join([f"[{c.citation}] {c.content[:300]}" for c in kb_results])

        # 3. Prompt
        messages = [
            {"role": "system", "content": (
                "你是一名石油天然气场站设备诊断专家。"
                "根据设备读数和知识库，给出诊断结论。\n"
                "必须引用知识库来源 [citation]，不得无据推断。\n"
                "返回严格的 JSON 格式。"
            )},
            {"role": "user", "content": f"""
设备 ID：{req.equipment_id}
设备类型：{eq_type_def.display_name}
当前读数：{json.dumps(readings_summary, ensure_ascii=False)}

相关知识库：
{kb_context}

请诊断并返回 JSON：
{{
  "severity": "normal|low|medium|high|critical",
  "anomaly_type": "轴承磨损|压力异常|温度异常|振动超标|正常",
  "summary": "一句话摘要（≤50字）",
  "details": "详细诊断（≤300字，含引用）",
  "confidence": 0.0-1.0,
  "citations": ["GB-50251:§7.3", "..."],
  "recommended_action": "emergency_stop|bearing_inspect|monitor|manual_review"
}}
"""}
        ]
        result_text = await ai_client.chat(messages, temperature=0.05, max_tokens=1024)

        # 4. 解析 JSON
        import re
        json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
        if json_match:
            diagnosis = json.loads(json_match.group())
        else:
            diagnosis = {"severity": "normal", "summary": "解析失败，请人工检查",
                         "confidence": 0.0, "citations": [], "recommended_action": "manual_review"}

        # 5. 计算主行动（§20.5）
        primary_action = get_ai_primary_action(diagnosis)
        diagnosis["primary_action"] = primary_action
        return diagnosis

    task_id = create_task(_run())
    return ok({"task_id": task_id, "status": "pending"})


@router.get("/tasks/{task_id}")
async def get_task_result(task_id: str):
    task = get_task(task_id)
    if not task:
        return err("NOT_FOUND", f"任务 {task_id} 不存在", 404)
    return ok({"task_id": task_id, "status": task.status,
               "result": task.result, "error": task.error})


# ── 3. AI 建工单草稿（industrial-workorder Skill 调用）────────
class DraftWorkOrderReq(BaseModel):
    equipment_id:   str
    station_id:     str
    diagnosis:      dict   # 来自 diagnose_equipment 的结果
    created_by:     str    # 飞书 open_id 或 user_id

@router.post("/workorders/ai-draft")
async def ai_draft_workorder(req: DraftWorkOrderReq):
    """根据 AI 诊断结果生成工单草稿（AI 写，人审批）"""
    from services.actions.work_order_action import ACTION_TEMPLATES
    from db.models.workorder import WorkOrder
    from db.database import get_async_session
    import uuid, time

    action_id = req.diagnosis.get("recommended_action", "manual_review")
    template   = ACTION_TEMPLATES.get(action_id)

    # 草稿内容
    ai_draft = {
        "suggested_title": f"{req.equipment_id} - {req.diagnosis.get('summary', '设备异常')}",
        "suggested_steps": template.default_steps if template else ["人工检查"],
        "suggested_priority": "P1" if req.diagnosis.get("severity") == "critical" else "P2",
        "confidence": req.diagnosis.get("confidence", 0.5),
        "citations": req.diagnosis.get("citations", []),
        "ai_summary": req.diagnosis.get("details", ""),
    }

    wo_id = f"W-{uuid.uuid4().hex[:8].upper()}"
    async with get_async_session() as db:
        wo = WorkOrder(
            wo_id=wo_id,
            station_id=req.station_id,
            equipment_id=req.equipment_id,
            title=ai_draft["suggested_title"],
            priority=ai_draft["suggested_priority"],
            description=ai_draft["ai_summary"],
            work_type=template.work_type if template else "inspection",
            state="draft",
            ai_draft=ai_draft,
            ai_confidence=ai_draft["confidence"],
            citations=ai_draft["citations"],
            created_by=req.created_by,
        )
        db.add(wo)
        await db.commit()
        await db.refresh(wo)

    log.info("workorder.ai_drafted", wo_id=wo_id, equipment_id=req.equipment_id)
    return ok(wo.to_dict())


# ── 4. P&ID 分析（industrial-twin Skill 调用）────────────────
class AnalyzePIDReq(BaseModel):
    station_id: str
    image_b64:  Optional[str] = None  # Qwen2.5-VL 视觉分析（Phase C）
    context:    dict = {}

@router.post("/analyze_pid")
async def analyze_pid(req: AnalyzePIDReq):
    """Phase A：基于知识库给出 P&ID 异常分析（文字版）"""
    kb_results = await search_kb(f"P&ID 工艺流程 异常 {req.station_id}", top_k=3)
    context_text = "\n".join([f"[{c.citation}] {c.content[:200]}" for c in kb_results])
    messages = [
        {"role": "system", "content": "你是石油场站工艺分析专家，分析 P&ID 流程图异常。"},
        {"role": "user",   "content": f"场站 {req.station_id} 当前工况：{req.context}\n参考知识：{context_text}\n请分析可能的工艺异常。"},
    ]
    result = await ai_client.chat(messages, max_tokens=512)
    return ok({"analysis": result, "citations": [c.citation for c in kb_results]})


# ── 5. 健康评分（Studio DeviceIntelPanel 调用）────────────────
class HealthScoreReq(BaseModel):
    equipment_id: str
    station_id:   str

@router.post("/equipment/health-score")
async def compute_health_score(req: HealthScoreReq):
    """基于最近读数计算设备健康评分（0-100）"""
    from services.ontology.registry import get_equipment_type
    from db.database import get_async_session
    from db.models.equipment import Equipment
    from db.models.equipment_reading import EquipmentReading
    from sqlalchemy import select, desc

    async with get_async_session() as db:
        eq = await db.get(Equipment, req.equipment_id)
        if not eq:
            return err("NOT_FOUND", "设备不存在", 404)
        eq_def = get_equipment_type(eq.type)

        # 取每个指标最新值
        scores = []
        for metric_def in eq_def.default_metrics:
            row = await db.scalar(
                select(EquipmentReading)
                .where(EquipmentReading.equipment_id == req.equipment_id,
                       EquipmentReading.metric == metric_def.name)
                .order_by(desc(EquipmentReading.ts)).limit(1)
            )
            if not row or row.quality != "GOOD":
                scores.append(50)   # 数据质量差，给中间分
                continue
            v, warn, alarm = row.value, metric_def.warn, metric_def.alarm
            if alarm > 0:
                if v >= alarm:  score = max(0, 100 - int((v - alarm) / alarm * 100 + 30))
                elif v >= warn: score = int(80 - (v - warn) / (alarm - warn) * 30)
                else:           score = 100
            else:
                score = 85   # 无阈值指标默认健康
            scores.append(max(0, min(100, score)))

    overall = int(sum(scores) / len(scores)) if scores else 85
    return ok({"equipment_id": req.equipment_id, "score": overall,
               "level": "good" if overall >= 80 else "warn" if overall >= 60 else "alarm"})
```

---

### 24.4 scheduler/jobs.py — 完整调度器（APScheduler）

```python
# scheduler/jobs.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import structlog

log = structlog.get_logger()
_scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")


def start_scheduler() -> None:
    from scheduler.anomaly import anomaly_poll_job
    from scheduler.morning import morning_briefing_job
    from scheduler.kpi import daily_kpi_job

    # 30s 异常检测
    _scheduler.add_job(anomaly_poll_job, IntervalTrigger(seconds=30),
                       id="anomaly_poll", max_instances=1, coalesce=True)

    # 每天 08:00 晨报
    _scheduler.add_job(morning_briefing_job, CronTrigger(hour=8, minute=0),
                       id="morning_briefing", max_instances=1)

    # 每天 00:30 KPI 汇总
    _scheduler.add_job(daily_kpi_job, CronTrigger(hour=0, minute=30),
                       id="daily_kpi", max_instances=1)

    _scheduler.start()
    log.info("scheduler.started", jobs=len(_scheduler.get_jobs()))


def stop_scheduler() -> None:
    _scheduler.shutdown(wait=False)


# scheduler/anomaly.py
async def anomaly_poll_job() -> None:
    """30s 轮询：对所有活跃设备做异常评分，高分推告警"""
    from db.database import get_async_session
    from db.models.station import Station
    from db.models.equipment import Equipment
    from db.models.alarm import Alarm
    from db.models.equipment_reading import EquipmentReading
    from services.ontology.registry import get_equipment_type
    from services.feishu import send_alarm_card
    from sqlalchemy import select, desc
    import uuid, time

    async with get_async_session() as db:
        stations = (await db.scalars(select(Station).where(Station.is_active == True))).all()
        for station in stations:
            equipments = (await db.scalars(
                select(Equipment).where(Equipment.station_id == station.id))).all()
            for eq in equipments:
                eq_def = get_equipment_type(eq.type)
                for metric_def in eq_def.default_metrics:
                    if metric_def.alarm <= 0:
                        continue
                    row = await db.scalar(
                        select(EquipmentReading)
                        .where(EquipmentReading.equipment_id == eq.id,
                               EquipmentReading.metric == metric_def.name)
                        .order_by(desc(EquipmentReading.ts)).limit(1)
                    )
                    if not row or row.quality != "GOOD":
                        continue
                    if row.value >= metric_def.alarm:
                        priority = "P1"
                    elif row.value >= metric_def.warn:
                        priority = "P2"
                    else:
                        continue

                    # 去重：30s 内同一 equipment+metric 不重复报警
                    existing = await db.scalar(
                        select(Alarm).where(
                            Alarm.equipment_id == eq.id,
                            Alarm.metric == metric_def.name,
                            Alarm.state == "active",
                        )
                    )
                    if existing:
                        continue

                    alarm = Alarm(
                        alarm_id=f"A-{uuid.uuid4().hex[:8].upper()}",
                        station_id=station.id,
                        equipment_id=eq.id,
                        metric=metric_def.name,
                        value=row.value,
                        threshold=metric_def.alarm,
                        priority=priority,
                        state="active",
                    )
                    db.add(alarm)
                    await db.flush()

                    # 推飞书
                    await send_alarm_card(station.id, eq.name, metric_def.name,
                                         row.value, metric_def.unit, priority)

        await db.commit()
```

---

### 24.5 数据流全景图（从传感器到 Studio 屏幕）

```
┌───────────────────────────────────────────────────────────────────────┐
│  完整数据流（Phase A Mock → Phase B OPC-UA 只改 IMSAdapter）           │
│                                                                       │
│  [MockAdapter / OPCUAAdapter]                                         │
│      ↓ Reading(equipment_id, metric, value, quality, ts)              │
│  pipeline.emit(reading)          ← services/ingest.py                 │
│      ↓ asyncio.Queue                                                  │
│  ┌───────────────────────────────────┐                                │
│  │  Consumer Chain（顺序执行）        │                                │
│  │  1. _handler_save_to_db           │ → TimescaleDB equipment_readings│
│  │  2. _handler_update_redis_cache   │ → Redis HASH readings:{eid}    │
│  │  3. _handler_trigger_sse          │ → asyncio.Queue per station    │
│  └───────────────────────────────────┘                                │
│                                    ↓                                  │
│  GET /v1/sse/station/{id}          ← Studio EventSource               │
│      ↓ data: {"type":"READING", "equipment_id":..., "metric":...}     │
│  useEquipmentStore._handleSSEEvent  ← Zustand store                   │
│      ↓ immer patch (只更新变化的那一个格子)                              │
│  useMetric("C-001", "shaft_vibration")  ← React Selector Hook         │
│      ↓ re-render 只影响订阅了这个 metric 的组件                          │
│  <MetricDisplay value={3.7} unit="mm/s" warn={3.5} alarm={5.0} />     │
│                                                                       │
│  并行：anomaly_poll_job（30s）                                          │
│      ↓ 读 Redis 最新值，对比阈值                                         │
│      ↓ 超阈值 → 创建 Alarm → 推飞书卡片 → Studio alarmStore 更新        │
│                                                                       │
│  用户点"AI 诊断"：                                                      │
│  POST /v1/tools/diagnose_equipment → task_id                           │
│      ↓ asyncio.create_task（§22.3）                                    │
│      ↓ AIClient.chat（§23.2 Semaphore + Circuit Breaker）              │
│      ↓ search_kb（§24.2 **pgvector**）                                  │
│      ↓ vLLM → 诊断 JSON                                               │
│  GET /v1/tools/tasks/{task_id} 轮询 → Studio DeviceIntelPanel 展示     │
└───────────────────────────────────────────────────────────────────────┘
```

---

### 24.6 OpenClaw Skill → Platform 完整调用链（避免 Skill 开发者猜测）

```
用户飞书消息："C-001 振动异常怎么处理？"

Step 1: OpenClaw 路由到 industrial-kb Skill
        Skill: kb_search(query="C-001 振动异常", equipment_type="compressor", station_id="S001")
        HTTP:  POST http://platform-api:8080/v1/tools/kb/search
               Headers: X-ClawTwin-Service-Token: <service_token>
               Body:    {"query":"...","equipment_type":"compressor","station_id":"S001"}
        返回:  chunks[0..4]，含 citation

Step 2: Skill 构建回答，带 citations 返回给用户
        飞书消息：" 根据 GB-50251:§7.3，振动超 3.5mm/s 建议..."

─────────────────────────────────────────────────────────────────

用户飞书消息："帮我给 C-001 建一个检查工单"

Step 1: industrial-twin Skill 先获取设备状态
        HTTP:  GET http://platform-api:8080/v1/equipment/C-001
               Headers: X-ClawTwin-Service-Token: <token>, X-Feishu-OpenId: <open_id>

Step 2: 触发 AI 诊断（异步）
        HTTP:  POST /v1/tools/diagnose_equipment
               Body:    {"equipment_id":"C-001","station_id":"S001","context":{...}}
        返回:  {"task_id":"abc123","status":"pending"}

Step 3: 轮询（最多 120s，每 2s 一次）
        HTTP:  GET /v1/tools/tasks/abc123
        返回:  {"status":"done","result":{"severity":"high","recommended_action":"bearing_inspect"}}

Step 4: AI 建工单草稿
        HTTP:  POST /v1/tools/workorders/ai-draft
               Body:    {"equipment_id":"C-001","station_id":"S001",
                         "diagnosis":{...},"created_by":"feishu_open_id_xxx"}
        返回:  {"data":{"wo_id":"W-ABCD1234","state":"draft",...}}

Step 5: Skill 推飞书卡片（主管审批）
        Platform 内部：POST /v1/notifications/notify-supervisor
        飞书卡片：工单标题 + AI 诊断摘要 + [通过]/[拒绝] 按钮
```

---

_§二十四 新增（2026-05-09）：完整胶水代码。_
_main.py 权威版、services/kb.py **pgvector** 实现、Tool API 完整实现、调度器、数据流全景图、OpenClaw→Platform 调用链。_
_开发者看此节可直接写代码，不需要在 7500 行文档里跳读。_

---

## 二十五、核心架构完整性审查：模型 × 接口 × 资源（2026-05-09）

> **本节解决六个架构盲点**，每一个在生产上都会引发故障：
>
> 1. MOIRAI 从未真正接入异常检测流程
> 2. Feishu HITL 回调链不完整（按钮点了没响应）
> 3. GPU 资源无规划（模型放不下）
> 4. 无请求 Trace ID（生产无法排查）
> 5. IngestPipeline 无背压保护（队列满直接丢数据）
> 6. Studio SSE 和 React Query 状态所有权冲突

---

### 25.1 模型部署全景图与 GPU 资源规划

**所有 AI 模型一览（按 VRAM 需求排序）**：

```
模型                      用途                VRAM      量化   Phase
─────────────────────────────────────────────────────────────────────
Qwen3-35B-A3B (MoE)       主推理 / 诊断 / 规划  ~22 GB   INT4   A
BAAI/bge-m3               文本向量化（1024维）  ~1.2 GB  FP16   A
MOIRAI-Large              时序预测 / 异常分数    ~0.8 GB  FP32   A→B
Qwen2.5-VL-7B             视觉巡检 / P&ID识别   ~8 GB    INT4   C
─────────────────────────────────────────────────────────────────────
总计（同时加载 A+B期模型）                      ~24 GB
```

**GPU 方案对照**（用户场景：GPU 服务器跑模型）：

```
方案 A：单 A100-40GB（推荐 Phase A/B）
  Qwen3-35B-A3B INT4:  22 GB
  bge-m3:               1.2 GB
  MOIRAI:               0.8 GB
  总计:                 24 GB ✓ 有余量
  并发能力: 3 个诊断请求同时推理（settings.vllm_max_concurrent=3）

方案 B：单 RTX 4090（24GB）—— 勉强可用，注意
  Qwen3-14B INT4:       8 GB  ← 必须换成 14B 而非 35B
  bge-m3:               1.2 GB
  MOIRAI:               0.8 GB
  总计:                 10 GB ✓ 余量大，但推理质量下降
  对策：用 Qwen3-14B 做轻量任务，复杂诊断走云端 API（可配置）

方案 C：双 RTX 4090（48GB）—— 可运行 35B
  Qwen3-35B tensor_parallel_size=2: 24+22=46 GB（需 vLLM tp 参数）
  ─ vLLM 启动参数：--tensor-parallel-size 2

方案 D：A100-80GB（Phase C，含视觉模型）
  全部模型同时加载: ~32 GB ✓
```

**vLLM 启动配置（写入 docker-compose.yml 或脚本）**：

```bash
# vllm-server（Qwen3 推理）
python -m vllm.entrypoints.openai.api_server \
  --model /models/Qwen3-35B-A3B \
  --quantization awq \                     # INT4 量化
  --max-model-len 8192 \                   # 最大上下文（工业诊断 8K 够）
  --max-num-seqs 8 \                       # 最大并行序列
  --gpu-memory-utilization 0.85 \          # 不占满，留 OS 用
  --tensor-parallel-size 1 \              # 单 A100 用 1，双卡改 2
  --host 0.0.0.0 --port 8080

# vllm-embed（bge-m3 向量化，独立进程）
python -m vllm.entrypoints.openai.api_server \
  --model /models/bge-m3 \
  --task embed \
  --max-model-len 512 \                    # 嵌入用短文本
  --gpu-memory-utilization 0.10 \          # 只占 10%，主要给 Qwen3
  --host 0.0.0.0 --port 8081

# MOIRAI（独立 FastAPI 服务，不走 vLLM）
# 见 §25.2
```

**settings.py 增加模型配置**：

```python
# config/settings.py 模型相关补全
vllm_base_url:     str = "http://gpu-server:8080"
vllm_model:        str = "Qwen3-35B-A3B"
vllm_embed_url:    str = "http://gpu-server:8081"
vllm_embed_model:  str = "bge-m3"
vllm_timeout_s:    int = 120
vllm_max_concurrent: int = 3

moirai_base_url:   str = "http://gpu-server:8082"  # MOIRAI 独立服务
moirai_enabled:    bool = True                      # Phase A 可设 False 退化到阈值检测
moirai_ctx_len:    int = 512                        # 输入历史点数
moirai_pred_len:   int = 24                         # 预测未来点数（每点 5min → 2h）
```

---

### 25.2 MOIRAI 时序预测真正接入（替代纯阈值检测）

**当前问题**：`anomaly_poll_job` 只做简单阈值比较（value ≥ alarm）→ 无法发现趋势异常（值还没超阈值但正在恶化）。

**正确架构**：双轨异常检测——阈值检测（快，ms 级）+ MOIRAI（慢，3-5s，但能预测趋势）。

```python
# services/moirai_client.py — MOIRAI 时序预测服务客户端
import httpx, asyncio
from dataclasses import dataclass
from config.settings import settings
import structlog

log = structlog.get_logger()

@dataclass
class MOIRAIPrediction:
    metric:      str
    current:     float
    forecast:    list[float]    # 未来 pred_len 个点的预测值
    anomaly_score: float        # 0-1，越高越异常
    trend:       str            # "rising" | "falling" | "stable"
    alert_in_n:  int | None     # 预计 N 个点后超阈值（None=不超）


async def predict_anomaly(
    equipment_id: str,
    metric: str,
    history: list[float],       # 最近 ctx_len 个点的值（等间隔）
    warn_threshold: float,
    alarm_threshold: float,
) -> MOIRAIPrediction | None:
    """
    调用 MOIRAI 做时序预测，返回异常评分和趋势。
    Phase A 若 moirai_enabled=False，返回 None（调用方退化到阈值检测）。
    """
    if not settings.moirai_enabled:
        return None
    if len(history) < 32:      # 历史数据不足，MOIRAI 精度差
        return None

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{settings.moirai_base_url}/predict", json={
                "data": history[-settings.moirai_ctx_len:],  # 取最近 ctx_len 点
                "prediction_length": settings.moirai_pred_len,
                "freq": "5T",   # 5 分钟采样率
            })
            resp.raise_for_status()
            r = resp.json()

        forecast = r["forecast"]  # 未来 pred_len 个点均值预测
        anomaly_score = r.get("anomaly_score", 0.0)

        # 趋势判断
        if forecast[-1] > forecast[0] * 1.05:  trend = "rising"
        elif forecast[-1] < forecast[0] * 0.95: trend = "falling"
        else:                                    trend = "stable"

        # 预测何时超阈值
        alert_in_n = next(
            (i for i, v in enumerate(forecast) if v >= alarm_threshold), None
        )

        return MOIRAIPrediction(
            metric=metric, current=history[-1],
            forecast=forecast, anomaly_score=anomaly_score,
            trend=trend, alert_in_n=alert_in_n,
        )
    except Exception as e:
        log.warning("moirai.predict_failed", equipment_id=equipment_id,
                    metric=metric, error=str(e))
        return None


# ── MOIRAI 独立服务（platform 外，GPU Server 上运行）─────────────
# requirements: uni2ts (MOIRAI 官方库)
# 启动命令：uvicorn moirai_server:app --host 0.0.0.0 --port 8082 --workers 1

# moirai_server.py（部署在 GPU Server，不在 platform-api 里）
"""
from fastapi import FastAPI
from pydantic import BaseModel
from uni2ts.model.moirai import MoiraiForecast, MoiraiModule
import torch

app = FastAPI()
model = MoiraiModule.from_pretrained("Salesforce/moirai-1.0-R-large")

class PredictReq(BaseModel):
    data: list[float]
    prediction_length: int
    freq: str = "5T"

@app.post("/predict")
async def predict(req: PredictReq):
    # 用 MOIRAI 做预测
    forecasts = model.predict(req.data, req.prediction_length)
    mean_forecast = forecasts.mean(axis=0).tolist()
    # 异常分数：历史最后几点偏离模型预期的程度
    anomaly_score = float(abs(req.data[-1] - mean_forecast[0]) / (max(req.data) - min(req.data) + 1e-6))
    return {"forecast": mean_forecast, "anomaly_score": min(1.0, anomaly_score)}
"""
```

**重写 scheduler/anomaly.py（双轨检测）**：

```python
# scheduler/anomaly.py — 双轨异常检测（阈值 + MOIRAI）
async def anomaly_poll_job() -> None:
    """
    双轨检测：
    Track 1（快）：当前值 ≥ alarm_threshold → 立即告警（P1/P2）
    Track 2（慢）：MOIRAI 预测趋势 → 提前预警（P3，预防性）
    """
    from services.moirai_client import predict_anomaly

    async with get_async_session() as db:
        for station in await _get_active_stations(db):
            for eq in await _get_station_equipment(db, station.id):
                eq_def = get_equipment_type(eq.type)
                for metric_def in eq_def.default_metrics:
                    if metric_def.alarm <= 0:
                        continue

                    # 查最近 512 个点的历史（5min间隔 = 42h历史）
                    history = await _get_metric_history(db, eq.id, metric_def.name, limit=512)
                    if not history:
                        continue

                    current = history[-1]

                    # ── Track 1：即时阈值检测 ─────────────────────
                    if current >= metric_def.alarm:
                        await _create_alarm_if_new(db, station.id, eq, metric_def, current, "P1")
                        continue  # P1 不再做 MOIRAI，立即处理
                    elif current >= metric_def.warn:
                        await _create_alarm_if_new(db, station.id, eq, metric_def, current, "P2")

                    # ── Track 2：MOIRAI 趋势预测（异步，不阻塞 Track 1）
                    prediction = await predict_anomaly(
                        eq.id, metric_def.name, history,
                        metric_def.warn, metric_def.alarm,
                    )
                    if prediction is None:
                        continue  # MOIRAI 不可用，退化到纯阈值

                    # 高异常分数 + 上升趋势 + 预计 N 点内超阈值 → 预防性 P3 告警
                    if (prediction.anomaly_score > 0.7
                            and prediction.trend == "rising"
                            and prediction.alert_in_n is not None
                            and prediction.alert_in_n <= 12):    # 12 × 5min = 1h 内
                        await _create_predictive_alarm(
                            db, station.id, eq, metric_def,
                            current, prediction,
                        )

        await db.commit()


async def _create_predictive_alarm(db, station_id, eq, metric_def, current, pred):
    """预防性告警：MOIRAI 预测 1h 内超阈，提前通知"""
    eta_min = pred.alert_in_n * 5   # 每点 5min
    message = (
        f"⚠️ 预测性告警：{eq.name} {metric_def.name} 当前 {current:.2f}{metric_def.unit}，"
        f"预计 {eta_min} 分钟后达到告警值 {metric_def.alarm}{metric_def.unit}。"
        f"（MOIRAI 异常分数 {pred.anomaly_score:.0%}）"
    )
    # P3 = 预防性，低紧迫度，仅推飞书消息（不要卡片审批）
    from services.feishu import send_text_message
    await send_text_message(station_id, message)
    log.info("alarm.predictive", equipment_id=eq.id, metric=metric_def.name,
             eta_min=eta_min, score=pred.anomaly_score)
```

---

### 25.3 Feishu 完整事件处理链（HITL 回调的正确实现）

**当前问题**：`POST /v1/feishu/events` 接收所有飞书事件，但没有完整的分发逻辑。用户点击工单审批卡片的按钮后，Platform 收到 `card.action.trigger` 事件，但没有处理它的代码。

**完整飞书 Webhook 事件分发器**：

```python
# routers/feishu.py — 完整飞书事件处理（签名验证 + 事件分发）
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
import hmac, hashlib, json, time

from config.settings import settings
from services.feishu_hitl import (
    handle_workorder_approve,
    handle_workorder_reject,
    handle_workorder_start,
    handle_workorder_complete,
)
import structlog

log = structlog.get_logger()
router = APIRouter(prefix="/v1/feishu", tags=["feishu"])


def _verify_feishu_signature(
    timestamp: str, nonce: str, body: bytes, signature: str
) -> bool:
    """飞书 Webhook 签名验证"""
    content = (timestamp + nonce + settings.feishu_verification_token + body.decode()).encode()
    expected = hashlib.sha256(content).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.post("/events")
async def feishu_events(request: Request):
    """
    Nexus 的飞书 Webhook 入口。

    【架构说明】（重要）：
    本 Webhook URL 只注册用于接收"卡片按钮点击"回调。
    飞书用户的对话消息（im.message.receive_v1）由 OpenClaw 的 Feishu Channel Plugin
    独立接收，不经过 Nexus。两套接入点互相独立：

      飞书用户发消息 → OpenClaw 的 Feishu Webhook URL（AI 对话处理）
      飞书卡片按钮点击 → 本 Webhook（工单审批/确认，卡片 JSON 中 action.url 指向 Nexus）
      Nexus 主动推送 → 直接调用飞书消息推送 API（Nexus → 飞书，无需 Webhook）

    飞书开发者后台配置：
      - 机器人（Bot Webhook）→ OpenClaw 的 Webhook URL
      - 不需要订阅 im.message.receive_v1（由 OpenClaw 订阅）

    本端点处理的事件：
    - url_verification（首次配置时飞书的验证挑战）
    - card.action.trigger（卡片按钮点击，工单审批/操作确认）
    """
    body_bytes = await request.body()

    # 1. 签名验证
    timestamp  = request.headers.get("X-Lark-Request-Timestamp", "")
    nonce      = request.headers.get("X-Lark-Request-Nonce", "")
    signature  = request.headers.get("X-Lark-Signature", "")
    if not _verify_feishu_signature(timestamp, nonce, body_bytes, signature):
        raise HTTPException(401, "飞书签名验证失败")

    payload = json.loads(body_bytes)
    log.debug("feishu.event_received", type=payload.get("header", {}).get("event_type"))

    # 2. URL 验证挑战（飞书首次配置时发送）
    if "challenge" in payload:
        return JSONResponse({"challenge": payload["challenge"]})

    event_type = payload.get("header", {}).get("event_type", "")
    event_data = payload.get("event", {})

    # 3. 事件分发
    if event_type == "card.action.trigger":
        # 用户点了飞书卡片上的按钮（工单审批/开始/完成）
        # 这是 Nexus 的核心 HITL 接入点
        return await _handle_card_action(event_data)

    else:
        # im.message.receive_v1 等对话消息不应发到这个 Webhook
        # 若收到，说明飞书后台配置有误，需要检查 Webhook URL 设置
        log.warning("feishu.unexpected_event", event_type=event_type,
                    hint="对话消息应路由到 OpenClaw 的 Webhook URL，不是 Nexus")
        return JSONResponse({"code": 0})


async def _handle_card_action(event_data: dict):
    """
    处理飞书卡片按钮点击（HITL 核心）。
    飞书卡片的 action 由 value 字段区分，格式约定：
      {"action": "workorder_approve", "wo_id": "W-ABCD1234"}
      {"action": "workorder_reject",  "wo_id": "W-ABCD1234", "reason": "..."}
      {"action": "workorder_start",   "wo_id": "W-ABCD1234"}
      {"action": "workorder_complete","wo_id": "W-ABCD1234"}
    """
    action_value = event_data.get("action", {}).get("value", {})
    action      = action_value.get("action", "")
    wo_id       = action_value.get("wo_id", "")
    operator_id = event_data.get("operator", {}).get("open_id", "")

    log.info("feishu.card_action", action=action, wo_id=wo_id, operator_id=operator_id)

    if not wo_id:
        return JSONResponse({"code": 1, "msg": "缺少 wo_id"})

    # 分发到对应的 HITL 处理函数
    dispatch = {
        "workorder_approve":  handle_workorder_approve,
        "workorder_reject":   handle_workorder_reject,
        "workorder_start":    handle_workorder_start,
        "workorder_complete": handle_workorder_complete,
    }
    handler = dispatch.get(action)
    if not handler:
        return JSONResponse({"code": 1, "msg": f"未知 action: {action}"})

    extra = {k: v for k, v in action_value.items() if k not in ("action","wo_id")}
    await handler(wo_id=wo_id, operator_id=operator_id, **extra)

    # 飞书要求 5s 内响应，否则显示 "操作失败"
    return JSONResponse({"code": 0, "toast": {"type": "success", "content": "操作成功"}})


async def _forward_to_openclaw(event_data: dict):
    """将用户消息转发到 OpenClaw（OpenClaw 有自己的飞书 Webhook）"""
    # OpenClaw 直接对接飞书，Platform 不做中转（见 ADR-5）
    # 此处仅记录日志，不实际转发
    log.debug("feishu.message_to_openclaw",
              sender=event_data.get("sender", {}).get("open_id"))
```

**`services/feishu_hitl.py`（HITL 工单状态机驱动）**：

```python
# services/feishu_hitl.py — 飞书 HITL 回调 → 工单 FSM 转换
from db.database import get_async_session
from db.models.workorder import WorkOrder
from services.feishu import (
    send_workorder_approved_card,
    send_workorder_rejected_card,
    send_workorder_started_card,
    send_workorder_completed_card,
)
from services.kb import write_l3_knowledge
import structlog

log = structlog.get_logger()


async def handle_workorder_approve(wo_id: str, operator_id: str, **_):
    async with get_async_session() as db:
        wo = await _get_wo(db, wo_id, expected_state="pending_approval")
        if not wo: return
        wo.state = "approved"
        wo.approved_by = operator_id
        from datetime import datetime, timezone
        wo.approved_at = datetime.now(timezone.utc)
        await db.commit()
        log.info("workorder.approved", wo_id=wo_id, approved_by=operator_id)
        # 通知操作员
        await send_workorder_approved_card(wo.station_id, wo.to_dict())


async def handle_workorder_reject(wo_id: str, operator_id: str, reason: str = "", **_):
    async with get_async_session() as db:
        wo = await _get_wo(db, wo_id, expected_state="pending_approval")
        if not wo: return
        wo.state = "rejected"
        wo.execution_notes = f"拒绝原因：{reason}"
        await db.commit()
        log.info("workorder.rejected", wo_id=wo_id, reason=reason)


async def handle_workorder_start(wo_id: str, operator_id: str, **_):
    async with get_async_session() as db:
        wo = await _get_wo(db, wo_id, expected_state="approved")
        if not wo: return
        wo.state = "in_progress"
        from datetime import datetime, timezone
        wo.started_at = datetime.now(timezone.utc)
        await db.commit()
        log.info("workorder.started", wo_id=wo_id)
        await send_workorder_started_card(wo.station_id, wo.to_dict())


async def handle_workorder_complete(wo_id: str, operator_id: str,
                                    execution_notes: str = "", **_):
    async with get_async_session() as db:
        wo = await _get_wo(db, wo_id, expected_state="in_progress")
        if not wo: return
        wo.state = "done"
        wo.execution_notes = execution_notes
        from datetime import datetime, timezone
        wo.done_at = datetime.now(timezone.utc)
        await db.commit()
        log.info("workorder.done", wo_id=wo_id)

        # 自动沉淀 L3 知识（非阻塞）
        if execution_notes:
            from db.models.equipment import Equipment
            eq = await db.get(Equipment, wo.equipment_id)
            import asyncio
            asyncio.create_task(write_l3_knowledge(
                station_id=wo.station_id, wo_id=wo_id,
                title=wo.title, content=execution_notes,
                equipment_type=eq.type if eq else "unknown",
            ))

        await send_workorder_completed_card(wo.station_id, wo.to_dict())


async def _get_wo(db, wo_id: str, expected_state: str) -> WorkOrder | None:
    wo = await db.get(WorkOrder, wo_id)
    if not wo:
        log.error("feishu_hitl.wo_not_found", wo_id=wo_id)
        return None
    if wo.state != expected_state:
        log.warning("feishu_hitl.state_mismatch",
                    wo_id=wo_id, current=wo.state, expected=expected_state)
        return None
    return wo
```

---

### 25.4 全链路请求 Trace ID

**问题**：`用户飞书消息 → OpenClaw → Skill → Platform Tool API → vLLM → **pgvector**/KB → 响应`，任何一步出错，没有 trace_id 就无法关联日志。

```python
# core/trace.py — 全链路 Trace ID（每个请求一个，贯穿所有日志）
import uuid
from contextvars import ContextVar
import structlog

_trace_id: ContextVar[str] = ContextVar("trace_id", default="")

def get_trace_id() -> str:
    return _trace_id.get() or "no-trace"

def set_trace_id(tid: str) -> None:
    _trace_id.set(tid)


# FastAPI 中间件：每个 HTTP 请求注入 trace_id
from starlette.middleware.base import BaseHTTPMiddleware

class TraceMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        # 优先使用调用方传入的 X-Trace-Id（OpenClaw → Platform 时携带）
        trace_id = request.headers.get("X-Trace-Id") or uuid.uuid4().hex[:12]
        set_trace_id(trace_id)

        # structlog contextvars：自动附加到当前 Task 的所有日志
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            trace_id=trace_id,
            path=request.url.path,
            method=request.method,
        )

        response = await call_next(request)
        response.headers["X-Trace-Id"] = trace_id  # 返回给前端，方便 debug
        return response
```

```python
# main.py 中注册（加在所有其他中间件之前）
from core.trace import TraceMiddleware
app.add_middleware(TraceMiddleware)
```

```typescript
// Studio：所有 API 请求携带并记录 trace_id
async function apiFetch<T>(path: string, init?: RequestInit) {
  const res = await fetch(...);
  const traceId = res.headers.get("X-Trace-Id");
  // 出错时在 console 打印 trace_id，方便给后端查日志
  if (!res.ok) console.error(`API Error [trace=${traceId}]`, path, res.status);
  ...
}
```

**OpenClaw Skill 调 Platform 时携带 trace_id**：

```python
# 在 Skill 的 HTTP 请求里加 header
headers = {
    "X-ClawTwin-Service-Token": SERVICE_TOKEN,
    "X-Trace-Id": ctx.get("trace_id", ""),   # OpenClaw 传入的会话 trace
}
```

---

### 25.5 IngestPipeline 背压与容错

**当前问题**：`asyncio.Queue(maxsize=10_000)` 满了就 `await put()` 阻塞，如果 TimescaleDB 写入慢，整个 Pipeline 堵死，IMS 数据丢失。

```python
# services/ingest.py — 增强版（背压 + 丢弃策略 + 监控）
class IngestPipeline:
    """
    背压策略：
    - Queue < 70% 满：正常处理
    - Queue 70%-90%：降采样（每 3 个读数只处理 1 个）
    - Queue > 90%：丢弃（保留最新值，丢弃中间值）
    - Queue 满：put_nowait 失败，记录 metrics，继续（不阻塞 IMS 适配器）
    """

    def __init__(self) -> None:
        self._queue   = asyncio.Queue(maxsize=10_000)
        self._handlers: list[Callable] = []
        self._dropped = 0   # 统计丢弃数（暴露给 /metrics）
        self._processed = 0

    async def emit(self, reading: Reading) -> None:
        qsize = self._queue.qsize()
        cap   = self._queue.maxsize

        if qsize >= cap * 0.9:
            # 严重积压：按概率丢弃（保最新的 10%）
            import random
            if random.random() < 0.9:
                self._dropped += 1
                if self._dropped % 100 == 0:
                    log.error("ingest.dropping", dropped=self._dropped, qsize=qsize)
                return
        elif qsize >= cap * 0.7:
            # 中度积压：降采样（轮询）
            self._dropped += 1
            if self._dropped % 3 != 0:
                return

        try:
            self._queue.put_nowait(reading)
        except asyncio.QueueFull:
            self._dropped += 1
            log.error("ingest.queue_full", dropped=self._dropped)

    async def start(self) -> None:
        log.info("ingest.pipeline_started")
        while True:
            reading = await self._queue.get()
            try:
                for fn in self._handlers:
                    await asyncio.wait_for(fn(reading), timeout=5.0)  # 每个 handler 5s 超时
                self._processed += 1
            except asyncio.TimeoutError:
                log.error("ingest.handler_timeout", reading_metric=reading.metric)
            except Exception as e:
                log.error("ingest.handler_error", error=str(e))
            finally:
                self._queue.task_done()

    @property
    def stats(self) -> dict:
        return {
            "queue_size": self._queue.qsize(),
            "queue_capacity": self._queue.maxsize,
            "processed": self._processed,
            "dropped": self._dropped,
            "drop_rate": round(self._dropped / max(1, self._processed + self._dropped), 4),
        }
```

```python
# /metrics 端点里暴露摄入统计（§22.7 基础上补充）
lines += [
    f'clawtwin_ingest_processed_total {pipeline.stats["processed"]}',
    f'clawtwin_ingest_dropped_total {pipeline.stats["dropped"]}',
    f'clawtwin_ingest_queue_size {pipeline.stats["queue_size"]}',
]
```

---

### 25.6 Studio 状态所有权协议（SSE vs React Query）

**问题**：同一份数据被两个系统管理时会产生"闪烁"或"覆盖"问题。

**状态所有权规则（一次定，全项目执行）**：

```
数据类型                    所有者          更新触发         组件读取方式
─────────────────────────────────────────────────────────────────────────
设备实时读数（metric值）     equipmentStore  SSE push         useMetric(eid, metric)
设备实时状态（normal/alarm） equipmentStore  SSE push         useEquipStatus(eid)
活跃告警列表                 alarmStore      SSE push         useAlarms()
告警统计数字                 React Query     60s 轮询         useQuery(["alarm-stats"])
设备元数据（名称/类型/阈值） React Query     首次加载+失效    useQuery(["equipment", eid])
工单列表                     React Query     操作后手动失效   useQuery(["workorders"])
AI 诊断结果                  React Query     按需触发+轮询    useQuery(["task", taskId])
用户信息                     authStore       登录时           useAuthStore()
─────────────────────────────────────────────────────────────────────────

规则：
  SSE 负责"高频、事件驱动"数据（读数/状态/活跃告警）
  React Query 负责"低频、按需"数据（元数据/工单/统计）
  两者不能管同一份数据
  SSE 数据不放入 React Query（不要用 queryClient.setQueryData 接 SSE 数据）
```

**SSE 断线重连和"快照"机制**（解决断线后数据陈旧问题）：

```typescript
// store/equipment.store.ts — 断线后重新拉快照
startSSE(stationId: string, token: string) {
  const es = new EventSource(`/v1/sse/station/${stationId}?token=${token}`);

  es.onopen = async () => {
    // 重新连接后，先拉一次 REST 快照补齐离线期间的状态
    const snap = await apiFetch<Record<string, Record<string, number>>>(
      `/v1/equipment/readings-snapshot?station_id=${stationId}`
    );
    if (snap.data) {
      useEquipmentStore.setState(s => ({
        ...s,
        readings: { ...s.readings, ...snap.data },
      }));
    }
  };

  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "READING") {
      useEquipmentStore.getState()._handleSSEEvent(msg);
    } else if (msg.type === "ALARM_FIRED") {
      useAlarmStore.getState()._handleAlarmEvent(msg);
    }
  };

  es.onerror = () => {
    set({ sseState: "reconnecting" });
    es.close();
    // 5s 后重连（会触发 onopen → 拉快照）
    setTimeout(() => get().startSSE(stationId, token), 5000);
  };

  set({ sseState: "connected", sseRef: es });
}
```

**Platform 快照端点**（SSE 重连时用）：

```python
# routers/equipment.py — 场站当前读数快照
@router.get("/v1/equipment/readings-snapshot")
async def readings_snapshot(
    station_id: str,
    user = Depends(get_current_user),
):
    """返回该场站所有设备最新读数（SSE 重连时用，不用于实时展示）"""
    require_station(station_id, user)
    # 从 Redis 缓存读（§22.2 _handler_update_redis_cache 写入的）
    import json
    from config.settings import settings
    import aioredis

    redis = await aioredis.from_url(settings.redis_url)
    # 查该场站所有设备 ID
    equipment_ids = await _get_station_equipment_ids(station_id)
    snapshot = {}
    for eid in equipment_ids:
        raw = await redis.hgetall(f"readings:{eid}")
        if raw:
            snapshot[eid] = {
                k.decode(): json.loads(v)["v"]
                for k, v in raw.items()
            }
    await redis.aclose()
    return ok(snapshot)
```

---

### 25.7 完整系统依赖图（模型 × 接口 × 资源一览）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ClawTwin 完整依赖图（Phase A）                         │
│                                                                         │
│  外部服务（客户场站内网）                                                  │
│  ┌────────────────┐   OPC-UA   ┌──────────────┐                        │
│  │  PLC/RTU/DCS   │ ────────→  │  opcua-bridge│ (Python, Zone 1)       │
│  └────────────────┘            └──────┬───────┘                        │
│                                       │ HTTP POST /v1/ingest/readings   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Platform (FastAPI, Zone 2)                                       │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │  IngestPipeline (asyncio.Queue, 背压§25.5)              │     │   │
│  │  │  Handler1: TimescaleDB  Handler2: Redis  Handler3: SSE  │     │   │
│  │  └──────────────────────────┬──────────────────────────────┘     │   │
│  │                              │                                    │   │
│  │  ┌─────────────┐  ┌─────────▼─────────┐  ┌─────────────────┐   │   │
│  │  │  Auth API   │  │  Equipment/WO API  │  │  SSE Router     │   │   │
│  │  │  /v1/auth/* │  │  /v1/equipment/*   │  │  /v1/sse/*      │   │   │
│  │  └─────────────┘  └───────────────────┘  └─────────────────┘   │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │  Tool API（Service Token）                               │     │   │
│  │  │  /v1/tools/kb/search  /diagnose  /ai-draft  /health-score│    │   │
│  │  └──────────────┬───────────────────────────────────────────┘    │   │
│  │                  │                                                │   │
│  │  ┌───────────────▼──────────────────────────────────────────┐    │   │
│  │  │  AI Client (§23.2 Circuit Breaker + Semaphore)           │    │   │
│  │  │  chat() → vLLM (GPU Server :8080, Qwen3-35B INT4 22GB)  │    │   │
│  │  │  embed() → vLLM-embed (:8081, bge-m3 1.2GB)             │    │   │
│  │  └──────────────────────────────────────────────────────────┘    │   │
│  │                                                                   │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │   │
│  │  │  MOIRAI(§25.2)│ │  pgvector(§24.2)│ │  PostgreSQL+Timescale │  │   │
│  │  │  :8082 0.8GB  │ │  gRPC :19530  │ │  TCP :5432            │  │   │
│  │  └──────────────┘  └──────────────┘  └───────────────────────┘  │   │
│  │                                                                   │   │
│  │  ┌──────────────────────────────────────────────────────────┐    │   │
│  │  │  Feishu Router（§25.3）                                  │    │   │
│  │  │  /v1/feishu/events → 签名验证 → 事件分发                   │    │   │
│  │  │  card.action.trigger → feishu_hitl → WorkOrder FSM      │    │   │
│  │  └──────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  OpenClaw（每个员工/组 一个实例）                                           │
│  ┌──────────────────────────────────────────┐                          │
│  │  industrial-kb Skill    → /v1/tools/kb/search  (Service Token)     │
│  │  industrial-twin Skill  → /v1/tools/diagnose   (Service Token)     │
│  │  industrial-workorder   → /v1/tools/ai-draft   (Service Token)     │
│  └──────────────────────────────────────────┘                          │
│       ↑↓ Feishu 飞书                                                     │
│  ┌────────────────────┐                                                 │
│  │  Studio (Browser)  │ ← SSE (/v1/sse/station/{id})                  │
│  │  Zustand Store ←   │ ← REST (React Query，分页，§22.5)               │
│  │  Admin (/admin/*)  │ ← REST (/v1/admin/*)                           │
│  └────────────────────┘                                                 │
└─────────────────────────────────────────────────────────────────────────┘

外部服务接口清单：
  飞书：Webhook 接收（进）+ Feishu SDK 推送（出）
  vLLM：HTTP POST /v1/chat/completions, /v1/embeddings（出）
  MOIRAI：HTTP POST /predict（出）
  **pgvector**：经 PostgreSQL / SQLAlchemy（出）；Phase C 可选 Milvus gRPC
  Redis：aioredis TCP（出）
  OPC-UA：opcua-bridge 单向（进）
```

---

### 25.8 架构自检清单（开发者 PR 前必须确认）

```
□ 新的设备读数是否经过 pipeline.emit()?      （不允许直接写 DB）
□ 新的 AI 调用是否经过 ai_client.chat()?     （不允许直接 httpx.post(vllm_url)）
□ 新的 API 响应是否用 ok() / paginate() / err()? （不允许裸 dict）
□ 新的 list 端点是否有 Depends(get_pagination)?   （不允许全量返回）
□ 新的用户路由是否有 Depends(get_current_user) + require_station()? （铁律 2）
□ 新的 Tool API 是否有 Depends(get_service_token)?             （铁律 3）
□ 所有时间字段是否存 UTC / 返回带 Z 的 ISO 8601?              （§23.6）
□ 新的 Admin 端点是否有 Depends(get_admin_user)?              （sys_admin only）
□ 飞书事件处理是否先验签？                                       （§25.3）
□ Studio 新实时数据是否走 SSE 而不是 setInterval?              （§21 协议）
□ Studio 新状态是否明确归属 SSE Store 或 React Query 之一?    （§25.6）
```

---

_§二十五 新增（2026-05-09）：核心架构完整性审查。_
_六个架构盲点全部修复：GPU规划、MOIRAI双轨检测、飞书完整HITL链、全链路TraceID、IngestPipeline背压、Studio状态所有权。_
_开发者自检清单：11 条 PR 前必过。_

---

## 二十六、架构根本修正：Platform 不做 AI 推理（2026-05-09）

> **本节是整个设计最重要的架构决策之一。**  
> 之前设计在 Platform 里调用 vLLM 做诊断推理，这违反了"Platform = 数据层"的根本定位。  
> 本节彻底厘清 Platform 和 OpenClaw Skill 的边界。

---

### 26.1 问题根源：两层职责混在一起

**现象**：Platform 的 Tool API 有 `/v1/tools/diagnose_equipment`，内部调 vLLM 做推理。

**为什么是错的**：

```
错误设计（当前）：

  用户                OpenClaw Skill          Platform              vLLM（GPU）
   │                       │                     │                     │
   │── "诊断 C-001" ──→    │                     │                     │
   │                       │──POST /tools/diag──→│                     │
   │                       │                     │──chat/completions──→│
   │                       │                     │         推理结果      │
   │                       │                     │←────────────────────│
   │                       │←── 诊断结果 ─────────│                     │
   │                       │                     │
   ↑ Platform 承担了 AI 推理，它同时是数据层 + 推理层，违反单一职责
```

```
正确设计（修正后）：

  用户                OpenClaw Skill          Platform              vLLM（GPU）
   │                       │                     │                     │
   │── "诊断 C-001" ──→    │                     │                     │
   │                       │── GET /equipment/{id}/readings ──────→   │
   │                       │←─ 实时读数 ──────────│                    │
   │                       │── POST /tools/kb/search ──────────→       │
   │                       │←─ KB 知识块 ─────────│                    │
   │                       │                     │                     │
   │                       │── 组装 Prompt ───────────────────────────→│
   │                       │                           LLM 推理        │
   │                       │←──────────────────────── 诊断结果 ─────────│
   │                       │── POST /workorders/ai-draft ─────────→    │
   │                       │←─ 工单草稿 ──────────│                    │
   ↑ Platform 只提供数据，推理由 Skill 调 vLLM 直接完成
```

---

### 26.2 Platform 职责边界（最终版）

```
Platform 做（数据层 + 行动层）：
  ✓ 设备读数存储和查询（TimescaleDB）
  ✓ KB 文档向量化存储（bge-m3 → **pgvector**）—— 数据基础设施
  ✓ KB 语义搜索（query → bge-m3 → **pgvector** → 返回 chunks）—— 数据检索
  ✓ MOIRAI 后台异常检测（定时任务，Skill 无法承担）—— 自动监控
  ✓ 工单 CRUD 和 FSM 状态转换
  ✓ 告警管理
  ✓ 用户认证和 ABAC 权限
  ✓ 飞书 HITL 回调处理

Platform 不做（推理层，Skill 的职责）：
  ✗ 诊断推理（不再有 diagnose_equipment 内部调 vLLM）
  ✗ P&ID 分析（不再有 analyze_pid 内部调 vLLM）
  ✗ 晨报文字生成（Skill 调 vLLM，Platform 只提供数据）
  ✗ 任何 chat/completions 调用
```

---

### 26.3 Platform bge-m3 使用：嵌入即数据操作

bge-m3 对 Platform 来说是"数据转换工具"，不是"AI 推理"——就像数据库的全文检索索引，不算 AI。

```python
# services/embed_client.py — 向量化客户端（替代 ai_client.py 里的 embed）
# 注：Platform 只用 embed，不用 chat。
import httpx
from config.settings import settings
import structlog

log = structlog.get_logger()

async def embed(text: str) -> list[float]:
    """
    调用 bge-m3 HTTP 服务，返回 1024 维向量。
    用于：① KB 文档上传时向量化  ② KB 搜索时向量化 query。
    Platform 只在这两个场景用 AI，其余推理都在 OpenClaw Skill 里。
    """
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{settings.vllm_embed_url}/v1/embeddings",
            json={"model": settings.vllm_embed_model, "input": text},
        )
        resp.raise_for_status()
        return resp.json()["data"][0]["embedding"]
```

```python
# config/settings.py — Platform 只保留 embed 配置，删除 vllm_base_url（推理）
# ✗ vllm_base_url   ← 删除，Platform 不调推理
# ✓ vllm_embed_url  ← 保留，用于 bge-m3 向量化
# ✓ moirai_base_url ← 保留，用于后台异常检测

vllm_embed_url:    str = "http://gpu-server:8081"   # bge-m3
vllm_embed_model:  str = "bge-m3"
moirai_base_url:   str = "http://gpu-server:8082"   # MOIRAI
moirai_enabled:    bool = True

# ✗ vllm_base_url: 删除（Skill 直接访问 GPU Server，不经过 Platform）
# ✗ vllm_max_concurrent: 删除（vLLM Server 自己的 --max-num-seqs 控制并发）
# ✗ vllm_timeout_s: 删除
```

---

### 26.4 Tool API 重新定义（数据 API，不含推理）

**旧 Tool API（错误的）**：Platform 调 vLLM 返回诊断结论。  
**新 Tool API（正确的）**：Platform 返回数据和 KB 知识，Skill 拿数据去调 vLLM。

```python
# routers/tools.py — 修正版 Tool API（只有数据，没有 vLLM 调用）

# ── 1. KB 语义搜索（不变，Platform 做 embed + **pgvector**，返回 chunks）────
@router.post("/v1/tools/kb/search")
async def kb_search(req: KBSearchReq):
    # Platform 用 embed_client.embed(query) 做向量化，不用 chat
    chunks = await search_kb(req.query, ...)
    return ok([c.__dict__ for c in chunks])


# ── 2. 设备上下文快照（Skill 组装 Prompt 用）────────────────────
class EquipmentContextReq(BaseModel):
    equipment_id: str
    station_id:   str
    hours_back:   int = 2    # 取最近 N 小时的读数

@router.post("/v1/tools/equipment/context")
async def get_equipment_context(
    req: EquipmentContextReq,
    _: None = Depends(get_service_token),
    db: AsyncSession = Depends(get_db),
):
    """
    给 OpenClaw Skill 提供完整的设备上下文数据。
    Skill 拿到这些数据后，自己构建 Prompt 调 vLLM。
    Platform 只做数据聚合，不做推理。
    """
    from db.models.equipment import Equipment
    from db.models.alarm import Alarm
    from services.ontology.registry import get_equipment_type

    eq = await db.get(Equipment, req.equipment_id)
    if not eq:
        return err("NOT_FOUND", "设备不存在", 404)
    eq_def = get_equipment_type(eq.type)

    # 1. 最近 N 小时读数（按指标聚合）
    from sqlalchemy import text
    rows = await db.execute(text("""
        SELECT metric,
               AVG(value) AS avg_val,
               MAX(value) AS max_val,
               MIN(value) AS min_val,
               (ARRAY_AGG(value ORDER BY ts DESC))[1] AS latest
        FROM equipment_readings
        WHERE equipment_id = :eid
          AND ts > NOW() - INTERVAL ':hours hours'
          AND quality = 'GOOD'
        GROUP BY metric
    """), {"eid": req.equipment_id, "hours": req.hours_back})
    readings = {r.metric: {
        "avg": round(r.avg_val, 3), "max": round(r.max_val, 3),
        "min": round(r.min_val, 3), "latest": round(r.latest, 3),
    } for r in rows.fetchall()}

    # 2. 活跃告警
    alarms = (await db.scalars(
        select(Alarm).where(Alarm.equipment_id == req.equipment_id,
                            Alarm.state == "active")
    )).all()

    # 3. 设备元数据和阈值（Skill 组 Prompt 时需要知道正常范围）
    thresholds = {m.name: {"warn": m.warn, "alarm": m.alarm, "unit": m.unit}
                  for m in eq_def.default_metrics}

    return ok({
        "equipment_id": req.equipment_id,
        "equipment_name": eq.name,
        "equipment_type": eq.type,
        "display_name":   eq_def.display_name,
        "station_id":     req.station_id,
        "readings":       readings,         # ← 数据
        "thresholds":     thresholds,       # ← 阈值（Skill 构建 Prompt 用）
        "active_alarms":  [a.to_dict() for a in alarms],
        "supported_actions": eq_def.supported_actions,
    })


# ── 3. 工单草稿创建（Skill 推理完成后调，保存结果）────────────────
class CreateAIDraftReq(BaseModel):
    equipment_id: str
    station_id:   str
    diagnosis: dict   # Skill 推理后的结构化结论（Platform 不再自己推理）
    created_by: str

@router.post("/v1/tools/workorders/ai-draft")
async def create_ai_draft_workorder(
    req: CreateAIDraftReq,
    _: None = Depends(get_service_token),
    db: AsyncSession = Depends(get_db),
):
    """
    Skill 完成推理后，调此接口把结论持久化为工单草稿。
    Platform 不关心推理过程，只负责存储和 FSM。
    """
    from services.actions.work_order_action import ACTION_TEMPLATES
    import uuid

    action_id = req.diagnosis.get("recommended_action", "manual_review")
    template  = ACTION_TEMPLATES.get(action_id)

    wo = WorkOrder(
        wo_id=f"W-{uuid.uuid4().hex[:8].upper()}",
        station_id=req.station_id,
        equipment_id=req.equipment_id,
        title=req.diagnosis.get("summary", "AI 诊断工单"),
        priority="P1" if req.diagnosis.get("severity") == "critical" else "P2",
        description=req.diagnosis.get("details", ""),
        work_type=template.work_type if template else "inspection",
        state="draft",
        ai_draft=req.diagnosis,
        ai_confidence=req.diagnosis.get("confidence", 0.5),
        citations=req.diagnosis.get("citations", []),
        created_by=req.created_by,
    )
    db.add(wo)
    await db.commit()
    await db.refresh(wo)
    log.info("workorder.ai_drafted_by_skill", wo_id=wo.wo_id)
    return ok(wo.to_dict())
```

---

### 26.5 OpenClaw Skill 修正版（Skill 自己调 vLLM）

现在 Skill 才是真正的推理引擎，Platform 只提供数据。

```python
# OpenClaw Skill: industrial-twin（伪代码，Skill 的实际语言看 OpenClaw SDK）
# 此处展示完整的推理逻辑流，说明 Skill 如何使用 Platform 数据 + vLLM

async def diagnose_equipment(equipment_id: str, station_id: str, ctx):
    """
    完整诊断流程（全在 Skill 里，Platform 只提供数据）：
    1. 从 Platform 拿设备上下文
    2. 从 Platform 搜 KB 知识
    3. 自己构建 Prompt 调 vLLM
    4. 把结论发回 Platform 创建工单草稿
    """
    headers = {
        "X-ClawTwin-Service-Token": SERVICE_TOKEN,
        "X-Trace-Id": ctx.trace_id,
    }

    # Step 1：拿设备数据（Platform 数据层）
    eq_ctx = await http_post(
        f"{PLATFORM_URL}/v1/tools/equipment/context",
        headers=headers,
        json={"equipment_id": equipment_id, "station_id": station_id, "hours_back": 2},
    )

    # Step 2：搜 KB 知识（Platform 做 embed+**pgvector**，返回 chunks）
    kb_results = await http_post(
        f"{PLATFORM_URL}/v1/tools/kb/search",
        headers=headers,
        json={"query": f"{eq_ctx['display_name']} 故障诊断",
              "station_id": station_id, "top_k": 5},
    )

    # Step 3：Skill 自己构建 Prompt，调 GPU Server 推理
    kb_context = "\n".join([f"[{c['citation']}] {c['content'][:300]}"
                             for c in kb_results])
    readings_text = "\n".join([
        f"  {metric}: 最新={v['latest']}, 均值={v['avg']}, "
        f"告警阈值={eq_ctx['thresholds'].get(metric,{}).get('alarm','N/A')}"
        for metric, v in eq_ctx["readings"].items()
    ])
    prompt = f"""你是石油天然气场站设备专家。根据以下数据诊断设备状态。

设备：{eq_ctx['display_name']} ({equipment_id})
当前读数（最近 2h）：
{readings_text}

相关知识库：
{kb_context}

返回 JSON：
{{"severity":"normal|low|medium|high|critical","anomaly_type":"...","summary":"≤50字","details":"≤300字含引用","confidence":0.0-1.0,"citations":["..."],"recommended_action":"bearing_inspect|monitor|manual_review|emergency_stop"}}"""

    # Skill 直接调 GPU Server（vLLM OpenAI 兼容接口）
    diagnosis_raw = await http_post(
        f"{GPU_SERVER_URL}/v1/chat/completions",
        json={"model": "Qwen3-35B-A3B",
              "messages": [
                  {"role": "system", "content": "工业诊断专家，严格返回 JSON。"},
                  {"role": "user",   "content": prompt},
              ],
              "temperature": 0.05, "max_tokens": 1024},
    )
    diagnosis = parse_json(diagnosis_raw["choices"][0]["message"]["content"])

    # Step 4：把推理结论发回 Platform 存储（Platform 创建工单草稿）
    wo = await http_post(
        f"{PLATFORM_URL}/v1/tools/workorders/ai-draft",
        headers=headers,
        json={"equipment_id": equipment_id, "station_id": station_id,
              "diagnosis": diagnosis, "created_by": ctx.feishu_open_id},
    )
    return {"diagnosis": diagnosis, "workorder": wo}
```

---

### 26.6 修正后的 services/ 目录（Platform）

```
platform-api/services/
├── embed_client.py        ← bge-m3 HTTP 客户端（embed 唯一用途）
├── moirai_client.py       ← MOIRAI HTTP 客户端（后台异常检测）
├── kb.py                  ← **pgvector** 知识库（用 embed_client 做向量化）
├── ingest.py              ← IngestPipeline（数据摄入管道）
├── feishu.py              ← 飞书消息推送
├── feishu_hitl.py         ← HITL 工单 FSM 驱动
├── ims/                   ← IMS 适配器（OPC-UA/Mock/REST）
├── ontology/              ← 设备本体注册表
└── actions/               ← 工单行动模板

已删除：
✗ ai_client.py            ← 删除（Platform 不做 chat 推理）
```

---

### 26.7 vLLM 并发控制的正确归属

**旧设计**：Platform 里 `asyncio.Semaphore(3)` 限制并发（错的——Platform 不调推理了）。  
**正确**：并发控制在 vLLM Server 配置里，这才是正确的位置。

```bash
# GPU Server 启动 vLLM（并发控制在这里）
python -m vllm.entrypoints.openai.api_server \
  --model Qwen3-35B-A3B \
  --max-num-seqs 8 \              # 最多 8 个并行请求（Skill 的并发）
  --max-num-pending-tokens 4096 \ # 排队上限，超出返回 429
  --gpu-memory-utilization 0.85
```

vLLM Server 返回 HTTP 429 时，Skill 收到 429 → 告知用户"请稍后重试"。  
不需要在 Platform 里做 Semaphore，vLLM 自己管。

---

### 26.8 修正后完整架构分层（权威版）

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3：Channel（用户入口）                                       │
│  Studio (浏览器) ←── SSE/REST ──→ Platform                        │
│  飞书 Bot ←──→ OpenClaw ←──→ Skill ←──→ Platform + GPU Server    │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2：Orchestration（AI 推理 + 编排）                          │
│  OpenClaw Skills：                                                │
│    ① 从 Platform 拿数据（equipment context、KB chunks）            │
│    ② 自己构建 Prompt                                              │
│    ③ 直接调 GPU Server（vLLM）推理                                │
│    ④ 把结论发回 Platform（创建工单、记录知识）                       │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1：Platform（数据 + 行动 + 安全）                            │
│  ┌──────────────┬──────────────┬───────────────────────────────┐ │
│  │  数据层       │  行动层       │  AI 基础设施                   │ │
│  │  TimescaleDB │  WorkOrder   │  bge-m3（embed 向量化）        │ │
│  │  PostgreSQL  │  FSM         │  MOIRAI（后台异常检测）         │ │
│  │  pgvector/KB │  HITL        │  （无 vLLM chat 调用）         │ │
│  │  Redis       │  Feishu 推送 │                               │ │
│  └──────────────┴──────────────┴───────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│  GPU Server（独立部署）                                             │
│  vLLM (Qwen3-35B, :8080) | bge-m3 (:8081) | MOIRAI (:8082)     │
│  ↑ Skill 直接调 :8080    ↑ Platform 调 :8081  ↑ Platform 调 :8082 │
└──────────────────────────────────────────────────────────────────┘
```

**三者关系一句话**：

- GPU Server = 算力资源（Skill 和 Platform 都用，各用各的端口）
- Platform = 数据 + 行动 + 用 bge-m3/MOIRAI 做数据层 AI
- OpenClaw Skill = 推理 + 编排 + 用 vLLM 做用户态 AI

---

### 26.9 影响范围：需要同步修改的文件

```
MODULE-DESIGN-PLATFORM.md：
  §24.3 Tool API → 删除 diagnose_equipment 内部 vLLM 调用，替换为 §26.4 版本
  §24.1 main.py → 删除 ai_client 导入，保留 embed_client
  §22 settings.py → 删除 vllm_base_url/vllm_max_concurrent/vllm_timeout_s
  §23.2 AIClient → 标注"已废弃，Platform 不做 chat 推理"

industrial-twin/SKILL.md（OpenClaw Skill 文档）：
  → 新增：Skill 直接调 GPU Server（vLLM）做推理
  → 更新 Tools 列表：equipment/context（替代原来的 diagnose_equipment）

clawtwin-project/SKILL.md：
  → 新增错误 32：Platform 不应调用 vLLM chat API
```

---

_§二十六 新增（2026-05-09）：架构根本修正。_
_Platform 不做 AI 推理，只做数据层 + 行动层 + bge-m3/MOIRAI 数据基础设施。_
_OpenClaw Skill 是推理层，直接调 GPU Server vLLM，拿 Platform 数据构建 Prompt。_
_这才是真正的 Foundry（Platform）+ AIP（OpenClaw）分层。_

---

## 二十七、举一反三：全系统模块边界完整审计（2026-05-09）

> **背景**：§26 修正了"Platform 不应调 vLLM chat"这一问题。  
> 本节将同样的审计方法推广到全系统所有模块边界，  
> 系统性列出所有违规，一次性清场，避免开发中反复返工。

---

### 27.1 审计框架：三个核心问题

```
对每一个"模块 A 调用模块 B"的关系，问三个问题：

① 这件事该谁做？（职责归属）
  - Platform：数据存取、行动执行、安全控制、规则计算、后台监控
  - OpenClaw Skill：AI 推理、意图理解、多步编排
  - Studio：渲染、用户交互、状态展示
  - GPU Server：模型推理（被动响应）
  - Scheduler：Platform 内的定时任务（只做数据操作）

② 认证令牌对不对？
  - Studio → Platform：User JWT（用户身份）
  - Skill → Platform：Service Token（机器身份）
  - Platform → GPU Server：内网直连，服务账号
  - 不存在"Studio → Tool API"（Tool API 是 Service Token only）

③ 如果失败了，谁负责降级？
  - AI 推理失败 → Skill 负责降级回复，Platform 不受影响
  - Platform 数据 API 失败 → Studio 显示 stale 数据，告警 SSE 继续
```

---

### 27.2 违规全量清单

#### A 类：Platform 做了 AI 推理（Skill 的职责）

| #   | 违规位置                                 | 问题                                              | 修正                                                               |
| :-- | :--------------------------------------- | :------------------------------------------------ | :----------------------------------------------------------------- |
| A1  | `§24.3 diagnose_equipment`               | Platform 内调 `ai_client.chat()` 做诊断推理       | 删除此端点；Skill 调 `/v1/tools/equipment/context` + vLLM（§26.4） |
| A2  | `§24.3 analyze_pid`                      | Platform 内调 vLLM 分析 P&ID                      | 改为数据端点，见 §27.4                                             |
| A3  | `routers/visual.py` `/v1/visual/inspect` | Platform 内调 Qwen2.5-VL 做视觉检查               | 移至 Skill；Platform 只存图片 + 返回 URL                           |
| A4  | `§23.2 ai_client.py` chat()              | Platform 有完整 vLLM chat 封装                    | 保留 `embed()` 方法，删除 `chat()` 方法                            |
| A5  | settings.py                              | 有 `vllm_base_url/vllm_model/vllm_max_concurrent` | 删除推理配置，只保留 `vllm_embed_url/vllm_embed_model`             |

#### B 类：Studio 错误调用 Tool API（Service Token 接口）

| #   | 违规位置                        | 问题                                            | 修正                                           |
| :-- | :------------------------------ | :---------------------------------------------- | :--------------------------------------------- |
| B1  | `MODULE-DESIGN-STUDIO §27`      | Studio 直接 `POST /v1/tools/diagnose_equipment` | 改为：Studio POST `/v1/ai/jobs`（见 §27.5）    |
| B2  | `MODULE-DESIGN-STUDIO §22 P&ID` | Studio 直接 `POST /v1/tools/analyze_pid`        | 改为：P&ID 分析走 OpenClaw/Feishu              |
| B3  | `MODULE-DESIGN-STUDIO §24`      | Studio 直接 `POST /v1/visual/inspect`           | 改为：上传图片 → Platform 存储 → 分析在 Feishu |

#### C 类：同一概念在多处定义相互矛盾

| #   | 违规位置                       | 问题                                                                      | 修正                                                                    |
| :-- | :----------------------------- | :------------------------------------------------------------------------ | :---------------------------------------------------------------------- |
| C1  | §22 vs §26                     | settings 有 `vllm_base_url`（§22）+ "删除推理配置"（§26）                 | §27 以本节为准，删除 chat 配置                                          |
| C2  | §23.2 vs §26                   | `ai_client.py` 有 `chat()` + §26 说 Platform 不调 vLLM                    | §27 以本节为准，`ai_client.py` 重命名为 `embed_client.py`，只保留 embed |
| C3  | §31 vs 本节                    | Studio §31 定义了 `compute_primary_action` 在 Platform 但未说明是否用 LLM | §27 明确：`compute_primary_action` 用纯规则计算，无 LLM                 |
| C4  | §24 diagnosis 端点 vs §26 移除 | §24.3 有完整的 `diagnose_equipment` 实现；§26 说移除                      | §27 终结：§24 该端点标记废弃，§26.4 是正确版本                          |

#### D 类：Tool API 职责边界模糊

| #   | 问题                                                                            | 修正                                                                                                               |
| :-- | :------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------- |
| D1  | `/v1/tools/*` 同时被 Studio（User JWT）和 Skill（Service Token）调用            | 强制：`/v1/tools/*` 只接受 Service Token；Studio 用 `/v1/equipment/*`、`/v1/ai/jobs`                               |
| D2  | `/v1/visual/inspect` 路由位置不清（tools? routers?）                            | 统一：Platform 只有 `/v1/media/upload`（存图），分析在 Skill                                                       |
| D3  | Tool API 的 `kb/search` 和 `equipment/context` 是数据接口，但与 AI 接口混在一起 | 重命名：`/v1/tools/kb/*` → `/v1/kb/*`（数据 API），`/v1/tools/equipment/context` → `/v1/equipment/{id}/ai-context` |

#### E 类：晨报调度器（基本正确，小问题）

| #   | 问题                                                                                         | 修正                                                            |
| :-- | :------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| E1  | `morning_briefing_job` 是否调 LLM？（代码中 `build_morning_briefing_card` 只构建结构化卡片） | ✅ 已正确：晨报只发结构化飞书卡片（KPI 数字），无 LLM，保留不变 |
| E2  | 晨报中的"AI 分析"建议从哪里来？                                                              | 从 MOIRAI 异常评分 + 阈值规则生成文字，无需 LLM                 |

---

### 27.3 修正后权威接口矩阵

> 这是 **全系统唯一权威的接口归属表**，开发时以此为准。

```
接口类型                Studio 可调  Skill 可调  来源端       鉴权
═══════════════════════════════════════════════════════════════════════
/v1/auth/*              ✓           ✗          Platform     无（登录）
/v1/equipment/*         ✓           ✓          Platform     User JWT / Service Token
/v1/stations/*          ✓           ✓          Platform     User JWT / Service Token
/v1/workorders/*        ✓           ✓          Platform     User JWT / Service Token
/v1/alarms/*            ✓           ✗          Platform     User JWT
/v1/shifts/*            ✓           ✗          Platform     User JWT
/v1/sse/*               ✓           ✗          Platform     User JWT
/v1/feishu/*            ✗           ✗          Platform     飞书签名验证
/v1/admin/*             ✓(sys_admin) ✗         Platform     User JWT（sys_admin 角色）
/v1/health              ✓           ✓           Platform     无
/v1/metrics             ✗           ✓           Platform     内网 IP 限制

── 以下是数据检索 API（Skill 专用，但部分 Studio 也可调用）──────────────
/v1/kb/*                ✓(搜索)     ✓          Platform     User JWT / Service Token
/v1/equipment/{id}/ai-context ✗     ✓          Platform     Service Token only
/v1/media/upload        ✓           ✗          Platform     User JWT
/v1/media/{id}          ✓           ✓          Platform     User JWT / Service Token

── 以下是行动 API（Skill 提交结果给 Platform 存储）──────────────────────
/v1/tools/workorders/ai-draft  ✗    ✓          Platform     Service Token only
/v1/tools/kb/ingest            ✗    ✓          Platform     Service Token only

── 以下是 AI 任务 API（Studio 触发 AI 任务的唯一路径）─────────────────────
/v1/ai/jobs             ✓           ✗          Platform     User JWT
/v1/ai/jobs/{id}        ✓           ✗          Platform     User JWT（轮询状态）

── 以下接口已废弃或移除 ──────────────────────────────────────────────────
✗ /v1/tools/diagnose_equipment    已废弃，业务在 Skill（§26.4）
✗ /v1/tools/analyze_pid           已废弃，业务在 Skill
✗ /v1/visual/inspect              已废弃，Phase B 在 Skill
✗ /v1/tools/equipment/health-score → 改为 GET /v1/equipment/{id}/health-score（Studio 可调）
```

---

### 27.4 analyze_pid 修正：Platform 返回数据，Skill 做分析

**旧设计**（错）：Studio → `POST /v1/tools/analyze_pid` → Platform 调 vLLM 分析 P&ID。  
**新设计**（正）：P&ID 分析有两条路径。

```
路径 A：Studio 显示 P&ID（无 AI，实时数据叠加）
  Studio → GET /v1/pid/layout/{station_id}     ← 返回管道节点拓扑 JSON
  Studio → GET /v1/pid/realtime/{station_id}   ← 返回各设备当前状态（颜色编码用）
  → Studio 用 react-flow 渲染 P&ID + 实时状态叠加，不需要 AI

路径 B：用户要"AI 分析 P&ID 异常"
  用户在飞书/OpenClaw 说"分析场站今天的 P&ID 异常"
  → Skill: GET /v1/stations/{id}/alarms（获取活跃告警）
  → Skill: GET /v1/pid/realtime/{station_id}（获取当前状态）
  → Skill: 调 vLLM 做分析（或调 Qwen2.5-VL 处理截图）
  → Skill: 飞书回复分析结论 + 可选创建工单草稿
```

```python
# routers/pid.py — Platform 只做数据，不做分析（修正版）
@router.get("/v1/pid/layout/{station_id}")
async def get_pid_layout(station_id: str, user: User = Depends(get_current_user)):
    """返回 P&ID 拓扑数据（设备节点、管道连接）"""
    require_station(station_id, user)
    layout = await load_pid_layout_from_db(station_id)  # 存在 PostgreSQL JSONB
    return ok(layout)

@router.get("/v1/pid/realtime/{station_id}")
async def get_pid_realtime(station_id: str, user: User = Depends(get_current_user)):
    """返回各设备当前状态（用于 P&ID 颜色叠加，来自 Redis 缓存）"""
    require_station(station_id, user)
    states = await get_all_equipment_states(station_id)   # Redis 读取
    return ok(states)

# 删除：analyze_pid 端点（不再存在）
```

---

### 27.5 Studio AI 任务接口：正确的 Studio→AI 触发路径

**问题**：Studio 用户点击"AI 诊断"按钮，但 Skill 才能做推理，怎么办？  
**解法**：Platform 提供 `/v1/ai/jobs` 作为 Studio 的 AI 任务队列，异步处理。

```
Studio 点击"AI 诊断" →
  POST /v1/ai/jobs（User JWT）
  Body: { type: "diagnose", equipment_id: "C-001", station_id: "ST-01" }

Platform 处理（不做推理，只做调度）：
  1. 验证用户权限（User JWT + ABAC）
  2. 在 DB 创建 ai_job 记录（state: "queued"）
  3. 把 job_id 推入 Redis List: LPUSH ai_jobs <job_id>
  4. 立即返回 { job_id: "job-xxx", status: "queued", eta_seconds: 30 }

Platform 后台 AIJobWorker（asyncio 任务，不是 vLLM）：
  5. BRPOP ai_jobs（阻塞等待）
  6. 构造 OpenClaw 请求（或直接 HTTP 调 Skill 的工具函数）
  7. 等待结果，存入 ai_job.result，更新 state: "done"
  8. 通过 SSE 推送给 Studio: {"type": "AI_JOB_DONE", "job_id": "job-xxx"}

Studio 收到 SSE 事件：
  9. GET /v1/ai/jobs/{job_id}（轮询 or SSE 触发）
  10. 显示 WorkOrderDraftInline 面板（结果已是工单草稿）
```

```python
# models/ai_job.py
class AIJob(Base):
    __tablename__ = "ai_jobs"
    job_id       = mapped_column(String, primary_key=True)
    job_type     = mapped_column(String)    # "diagnose" | "analyze_pid"
    station_id   = mapped_column(String, ForeignKey("stations.id"))
    equipment_id = mapped_column(String, nullable=True)
    requested_by = mapped_column(String)   # user_id
    state        = mapped_column(String, default="queued")  # queued/running/done/failed
    result       = mapped_column(JSONB, nullable=True)
    created_at   = mapped_column(TIMESTAMPTZ, default=utcnow)
    done_at      = mapped_column(TIMESTAMPTZ, nullable=True)

# routers/ai_jobs.py
@router.post("/v1/ai/jobs")
async def request_ai_job(req: AIJobReq, user: User = Depends(get_current_user),
                         db: AsyncSession = Depends(get_db),
                         redis: Redis = Depends(get_redis)):
    require_station(req.station_id, user)
    job = AIJob(job_id=f"job-{uuid4().hex[:8]}", job_type=req.type,
                station_id=req.station_id, equipment_id=req.equipment_id,
                requested_by=user.user_id)
    db.add(job)
    await db.commit()
    await redis.lpush("ai_jobs", job.job_id)
    return ok({"job_id": job.job_id, "status": "queued", "eta_seconds": 30})

@router.get("/v1/ai/jobs/{job_id}")
async def get_ai_job(job_id: str, user: User = Depends(get_current_user),
                     db: AsyncSession = Depends(get_db)):
    job = await db.get(AIJob, job_id)
    if not job or job.requested_by != user.user_id:
        return err("NOT_FOUND", "任务不存在", 404)
    return ok({"job_id": job.job_id, "status": job.state, "result": job.result})

# services/ai_job_worker.py — Platform 的 AI 任务分发器（不做推理，只做路由）
OPENCLAW_SKILL_TRIGGER_URL = settings.openclaw_trigger_url  # OpenClaw webhook

async def ai_job_worker(redis: Redis, db: AsyncSession):
    """
    后台工作线程：从 Redis 取 job → 通过 OpenClaw webhook 触发 Skill 处理。
    Platform 不做 AI 推理，只做任务调度。Skill 处理完调回 /v1/tools/workorders/ai-draft。
    """
    while True:
        _, job_id = await redis.brpop("ai_jobs", timeout=30)
        if not job_id:
            continue
        job = await db.get(AIJob, job_id.decode())
        if not job or job.state != "queued":
            continue
        job.state = "running"
        await db.commit()
        try:
            # 触发 OpenClaw（异步，不等结果——结果通过 /v1/tools/workorders/ai-draft 回传）
            async with httpx.AsyncClient(timeout=5) as c:
                await c.post(OPENCLAW_SKILL_TRIGGER_URL, json={
                    "skill": "industrial-twin",
                    "action": "diagnose",
                    "payload": {
                        "equipment_id": job.equipment_id,
                        "station_id":   job.station_id,
                        "job_id":       job.job_id,    # Skill 完成后带回 job_id
                    },
                })
        except Exception as e:
            log.error("ai_job_worker.trigger_failed", job_id=job.job_id, error=str(e))
            job.state = "failed"
            await db.commit()
```

> **Phase A Fallback**：如果 OpenClaw webhook 尚未就绪，`ai_job_worker` 可以  
> 直接 `import` Skill 的核心逻辑函数（Skill 代码作为 Python 包）。  
> Phase B 迁移到正式的 OpenClaw webhook，接口不变。

---

### 27.6 compute_primary_action：纯规则计算，无 LLM

`compute_primary_action` 必须是确定性的，不能因为 vLLM 延迟/故障而影响 Studio 显示。

```python
# services/primary_action.py — 纯规则引擎（无 AI 调用）
from services.ontology.registry import get_equipment_type, ActionPriority

def compute_primary_action(
    equipment_id: str,
    equipment_type: str,
    readings: dict[str, float],       # {metric: latest_value}
    active_alarms: list[dict],        # [{level, metric, value, threshold}]
    moirai_anomaly_score: float,      # 0.0 – 1.0（来自 MOIRAI 预测）
    last_diagnosis: dict | None,      # AI 上次诊断结论（可能 None）
) -> dict:
    """
    决策树：严格规则顺序，前面的规则优先。
    输出供 Studio DeviceIntelPanel 渲染"主操作"按钮。
    """
    eq_def = get_equipment_type(equipment_type)

    # 规则 1：有 P1 告警 → 立即停机
    critical_alarms = [a for a in active_alarms if a["level"] == "P1"]
    if critical_alarms:
        return {
            "action_id":  "emergency_stop",
            "label":      "⚠️ 立即停机",
            "urgency":    "P1",
            "reason":     f"P1 告警：{critical_alarms[0]['metric']} 超限",
            "confidence": 1.0,
            "sources":    ["threshold_rule"],
        }

    # 规则 2：MOIRAI 异常评分 > 0.85 → 紧急检查
    if moirai_anomaly_score > 0.85:
        return {
            "action_id":  "bearing_inspect",
            "label":      "🔍 紧急巡检",
            "urgency":    "P2",
            "reason":     f"AI 预测异常概率 {moirai_anomaly_score:.0%}",
            "confidence": moirai_anomaly_score,
            "sources":    ["moirai_prediction"],
        }

    # 规则 3：有未处理的 P2 告警 → 安排检查
    p2_alarms = [a for a in active_alarms if a["level"] == "P2"]
    if p2_alarms:
        return {
            "action_id":  "schedule_maintenance",
            "label":      "📋 安排维保",
            "urgency":    "P3",
            "reason":     f"{len(p2_alarms)} 个 P2 告警未处理",
            "confidence": 0.9,
            "sources":    ["alarm_rules"],
        }

    # 规则 4：AI 上次诊断结论（如果有，附加信息）
    if last_diagnosis and last_diagnosis.get("severity") in ["high", "critical"]:
        return {
            "action_id":  last_diagnosis.get("recommended_action", "monitor"),
            "label":      "📊 AI 建议行动",
            "urgency":    "P3",
            "reason":     last_diagnosis.get("summary", ""),
            "confidence": last_diagnosis.get("confidence", 0.6),
            "sources":    ["ai_diagnosis", f"diagnosis:{last_diagnosis.get('diagnosis_id')}"],
        }

    # 规则 5：一切正常 → 监控
    return {
        "action_id":  "monitor",
        "label":      "✅ 设备正常",
        "urgency":    "none",
        "reason":     "所有指标在正常范围，MOIRAI 评分正常",
        "confidence": 1.0,
        "sources":    ["threshold_rule", "moirai_prediction"],
    }
```

---

### 27.7 修正后的 Platform services/ 目录（最终权威版）

```
platform-api/
├── main.py              ← 应用入口（含 ai_job_worker 后台任务）
├── config/
│   └── settings.py      ← 配置（移除 vllm_base_url/vllm_model/vllm_max_concurrent）
├── services/
│   ├── embed_client.py  ← bge-m3 HTTP 客户端（只做 embed，无 chat）
│   ├── moirai_client.py ← MOIRAI HTTP 客户端（时序异常预测）
│   ├── kb.py            ← **pgvector** 知识库（调用 embed_client）
│   ├── ingest.py        ← IngestPipeline（数据摄入，背压保护）
│   ├── feishu.py        ← 飞书消息推送（结构化卡片，无 LLM）
│   ├── feishu_hitl.py   ← HITL 工单 FSM 驱动（飞书回调→工单状态机）
│   ├── primary_action.py← compute_primary_action（纯规则，无 LLM）
│   ├── ai_job_worker.py ← AI 任务分发器（收请求→触发 OpenClaw，不做推理）
│   └── ims/             ← IMS 适配器（OPC-UA/Mock/REST）
│
├── routers/
│   ├── auth.py          ← /v1/auth/*
│   ├── equipment.py     ← /v1/equipment/*（含 health-score、ai-context）
│   ├── stations.py      ← /v1/stations/*
│   ├── workorders.py    ← /v1/workorders/*
│   ├── alarms.py        ← /v1/alarms/*
│   ├── shifts.py        ← /v1/shifts/*
│   ├── kb.py            ← /v1/kb/search（原 /v1/tools/kb/search，已迁移）
│   ├── pid.py           ← /v1/pid/layout + /v1/pid/realtime（纯数据，无 AI）
│   ├── media.py         ← /v1/media/upload（图片上传，不做视觉分析）
│   ├── ai_jobs.py       ← /v1/ai/jobs（Studio AI 任务触发入口）
│   ├── tools.py         ← /v1/tools/*（Service Token only；equipment/context + ai-draft）
│   ├── sse.py           ← /v1/sse/*（SSE 推送实时数据）
│   ├── feishu.py        ← /v1/feishu/*（飞书事件回调）
│   ├── admin.py         ← /v1/admin/*（管理接口）
│   ├── health.py        ← /v1/health + /v1/metrics
│   └── reports.py       ← /v1/reports/*（数据导出）
│
├── scheduler/
│   ├── jobs.py          ← APScheduler 主入口
│   ├── anomaly.py       ← MOIRAI 异常检测任务（30s）
│   ├── morning.py       ← 晨报（06:00，结构化卡片，无 LLM）✅
│   ├── kpi.py           ← 每日 KPI 计算（纯数据聚合，无 LLM）
│   └── helpers.py       ← 辅助查询函数
│
└── 已删除文件：
    ✗ services/ai_client.py（chat 方法）→ 拆分为 embed_client.py（保留 embed）
    ✗ routers/tools.py 中的 diagnose_equipment → 移至 Skill
    ✗ routers/tools.py 中的 analyze_pid → 移至 Skill
    ✗ routers/visual.py 中的 /v1/visual/inspect → 移至 Skill（Phase B）
```

---

### 27.8 修正后 settings.py 配置（移除 AI 推理配置）

```python
# config/settings.py — 最终权威版（2026-05-09）
# 凡是 vllm "chat" 相关的配置全部删除

class Settings(BaseSettings):
    # ── 基础 ──────────────────────────────────────────────
    app_name:    str = "ClawTwin Platform"
    app_version: str = "0.1.0"
    debug:       bool = False
    host:        str = "0.0.0.0"
    port:        int = 8080

    # ── 数据库 ────────────────────────────────────────────
    database_url:      str = "postgresql+asyncpg://..."
    redis_url:         str = "redis://redis:6379/0"
    milvus_host:       str = "milvus"
    milvus_port:       int = 19530
    milvus_collection: str = "clawtwin_kb"

    # ── 向量嵌入（Platform 唯一合法的 AI 调用）──────────
    vllm_embed_url:   str = "http://gpu-server:8081"
    vllm_embed_model: str = "bge-m3"
    vllm_embed_dim:   int = 1024

    # ── MOIRAI 时序预测（后台监控，非用户态 AI）────────────
    moirai_base_url: str  = "http://gpu-server:8082"
    moirai_enabled:  bool = True

    # ── OpenClaw 触发（AI 任务分发，不做推理）────────────
    openclaw_trigger_url:    str = "http://openclaw:3000/api/trigger"
    openclaw_service_token:  str = ""   # Platform 调 OpenClaw 的令牌

    # ── 认证 ──────────────────────────────────────────────
    jwt_secret:          str = ""
    jwt_expire_minutes:  int = 480
    service_token_hash:  str = ""   # Skill 调 Platform 的 Service Token（bcrypt hash）

    # ── 飞书 ──────────────────────────────────────────────
    feishu_app_id:      str = ""
    feishu_app_secret:  str = ""
    feishu_encrypt_key: str = ""
    feishu_verify_token:str = ""

    # ── IMS ───────────────────────────────────────────────
    ims_default_adapter: str = "mock"

    # ── 调度器 ────────────────────────────────────────────
    morning_briefing_hour: int = 6
    anomaly_poll_interval:  int = 30

    # ── 以下配置已删除（Platform 不做 AI 推理）─────────────
    # ✗ vllm_base_url        ← 删除（Skill 自己配）
    # ✗ vllm_model           ← 删除
    # ✗ vllm_timeout_s       ← 删除
    # ✗ vllm_max_concurrent  ← 删除（并发控制在 vLLM Server --max-num-seqs）
    # ✗ vllm_chat_url        ← 删除
```

---

### 27.9 架构最终总结图（权威版，含数据流方向）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       ClawTwin 完整数据流（权威）                          │
└─────────────────────────────────────────────────────────────────────────┘

【实时数据流（OT→Platform→Studio）】
OPC-UA Server
    │ opcua-bridge（DMZ）
    ↓ Kafka（只推，不拉）
IngestPipeline → TimescaleDB + Redis（SSE 缓存）
    │ SSE /v1/sse/station/{id}
    ↓
Studio（只渲染，不计算）

【规则/ML 告警流（Platform 内部）】
TimescaleDB 读数
    │ MOIRAI 客户端（每 30s）
    ↓
anomaly_poll_job → Alarm 记录 + 飞书告警卡片
    │
    ↓ compute_primary_action（纯规则树）
Studio DeviceIntelPanel（显示主行动建议）

【用户触发 AI 诊断流（Studio→Platform→OpenClaw→Skill→GPU→Platform→Studio）】
Studio 点击"AI 诊断"
    │ POST /v1/ai/jobs（User JWT）
    ↓
Platform（创建 job 记录，推 Redis List，立即返回 job_id）
    │ ai_job_worker（异步）
    ↓ POST openclaw_trigger_url（webhook）
OpenClaw
    │ 运行 industrial-twin Skill
    ↓ POST /v1/equipment/{id}/ai-context（Service Token）
Platform 返回设备数据快照
    │ Skill 收到数据
    ↓ POST /v1/kb/search（Service Token，Platform 做 bge-m3 embed）
Platform 返回 KB 知识块
    │ Skill 构建 Prompt
    ↓ POST gpu-server:8080/v1/chat/completions（vLLM）
GPU Server 推理
    │ Skill 解析结果
    ↓ POST /v1/tools/workorders/ai-draft（Service Token）
Platform 创建工单草稿，SSE 推送 AI_JOB_DONE 事件
    │
    ↓
Studio 收到 SSE → 展示 WorkOrderDraftInline

【Feishu/OpenClaw 自主触发流（不依赖 Studio）】
用户飞书消息 → OpenClaw → Skill 直接调 Platform 数据 API → vLLM → 飞书回复
（结果可选写回 Platform 工单）

【数据层 AI（Platform 内部，bge-m3 用途）】
Admin 上传 KB 文档
    │ POST /v1/admin/kb/documents
    ↓ embed_client.embed()（bge-m3，向量化）
**pgvector** 存储

用户/Skill 搜索 KB
    │ POST /v1/kb/search（含 query 文本）
    ↓ embed_client.embed(query)（bge-m3，向量化查询）
pgvector ANN 检索 → 返回知识块
```

---

### 27.10 开发者自检清单（PR 前必过，替换 §25.8）

```
□ 1. Platform 无 vllm chat 调用
      grep -r "chat/completions\|ai_client.chat\|vllm_base_url" platform-api/
      → 结果为空（或仅在注释/废弃代码中）

□ 2. Studio 无直接调 Tool API
      grep -r "/v1/tools/" studio/src/
      → 结果为空（Tool API 只能 Service Token，Studio 用 User JWT）

□ 3. compute_primary_action 无 AI 调用
      cat services/primary_action.py | grep -c "httpx\|openai\|vllm\|embed"
      → 输出 0

□ 4. 晨报 morning_briefing_job 无 AI 调用
      cat scheduler/morning.py | grep -c "chat\|vllm\|ai_client"
      → 输出 0

□ 5. settings.py 无 vllm_base_url（推理端点）
      grep "vllm_base_url\|vllm_model\|vllm_max_concurrent" config/settings.py
      → 结果为空

□ 6. /v1/tools/* 端点均有 Depends(get_service_token)
      grep -A5 "@router" routers/tools.py | grep -v "get_service_token"
      → 只有 @router 装饰器行，无未保护的端点

□ 7. /v1/ai/jobs 有 Depends(get_current_user) + require_station
      grep "get_current_user\|require_station" routers/ai_jobs.py → 存在

□ 8. P&ID 路由无 AI 调用
      cat routers/pid.py | grep -c "vllm\|chat\|embed"
      → 输出 0

□ 9. Feishu 回调验签
      grep "verify_feishu_signature" routers/feishu.py → 存在

□ 10. 工单 FSM 无非法状态转换
       cat tests/test_workorder_fsm.py → 存在，所有转换有测试覆盖

□ 11. SSE 断线重连有快照
       cat routers/sse.py | grep "snapshot\|full_state" → 存在
```

---

_§二十七 新增（2026-05-09）：全系统模块边界完整审计。_  
_总计发现 5 类 14 项违规，全部制定修正方案。_  
_本节是全项目模块边界的最终权威，后续开发以 §27.3 接口矩阵为准。_

---

## 二十八、产品蓝图与开发框架（权威版，2026-05-11）

> **本节是写给团队和客户的完整技术蓝图。**  
> 参考「智能问数 5 层生产级架构」文章原则 + Palantir Foundry/AIP 理念 + 工业场景特性，  
> 客观评估当前设计的合理性、差距和优先级，形成统一的开发框架。

---

### 28.1 两类参考系的对照分析

**文章「智能问数 5 层架构」处理的核心问题：**

```
用户自然语言 → NL2SQL → 数据库 → 结果 → 自然语言分析
问题：准确率、并发稳定、权限安全、场景扩展
```

**ClawTwin 处理的核心问题：**

```
工业设备实时数据 + 领域知识 + AI 推理 → 可信操作建议 → 人工确认 → 工单执行
问题：OT/IT 安全隔离、数据实时性、知识可信性、行动可审计、HITL 闭环
```

**两者的架构原则高度一致，执行路径完全不同：**

| 原则          | 智能问数场景                 | ClawTwin 场景                     |
| :------------ | :--------------------------- | :-------------------------------- |
| RAG 多层检索  | Schema + Few-shot + 反馈修正 | L0通用 + L1行业 + L2站级 + L3学习 |
| Agent + Skill | NL2SQL Skill                 | 诊断/工单/知识库 Skill            |
| 安全控制独立  | 权限注入 SQL 最外层          | ABAC + OT/IT 分区 + Service Token |
| 基础设施可换  | 换 LLM/向量库/关系库         | 换 DCS 适配/LLM/时序模型          |
| HITL          | 超时转人工                   | AI 起草→操作员审批→现场执行       |

---

### 28.2 当前设计的客观评估

**做对了的部分（不动）：**

```
✅ OT/IT 三区隔离（Zone 0→1→2，Kafka 单向）          生产必须
✅ IMS Adapter SDK（可插拔适配器）                     扩展性
✅ KB 四层检索（L0-L3 + GraphRAG）                     知识质量
✅ HITL 工单状态机（AI Draft → 审批 → 执行）           人类控制
✅ OpenClaw Skills（推理在 Skill，Platform 只提供数据） 分层边界
✅ MOIRAI 时序异常检测（后台任务，主动监控）             主动发现
✅ 飞书作为移动端 + 告警通道                           部署现实
✅ Service Token + User JWT 双层认证                   安全
✅ SSE 实时推送（替代轮询）                            Studio 性能
```

**设计不足之处（需修正）：**

```
⚠️ 本体层仍是代码 Dict（EQUIPMENT_TYPE_REGISTRY）         → 28.3 修正
⚠️ 知识冷启动内容未定义（L0/L1 具体有什么文档？）          → 28.4 修正
⚠️ Phase A MVP 范围与「全量设计」混在一起                  → 28.5 修正
⚠️ Skills 内容是架构骨架，Prompt 工程质量是实际价值所在     → 28.6 修正
⚠️ Studio 的「智能问数」入口缺失（用户问 KPI 数据在哪？）  → 28.7 修正
```

**文档过度设计之处（认清但不纠结）：**

```
📝 Eclipse Ditto（Phase A 用 Redis Hash Mock 即可，Phase B 再引入正式 Ditto）
📝 GraphRAG（Phase A 用 **pgvector** 向量检索即可，关系抽取是 Phase B 的事）
📝 Babylon.js 3D 场景（Phase A 可以是 SVG P&ID 图，3D 是差异化，不是必须）
📝 MinIO（Phase A 文档直接存 PostgreSQL BYTEA 或本地磁盘即可）
```

---

### 28.3 本体层务实实现：从代码 Dict 到 API 一等公民

**当前问题：**  
`EQUIPMENT_TYPE_REGISTRY` 是 Python Dict，只能在代码里用，无法被 Studio 或 Skill 动态查询。这导致前端"显示哪些按钮"逻辑也写死在代码里，每次新增设备类型要改多处。

**修正目标：** 本体不是自研图数据库，而是 **Platform 中的可查询契约 API**。

```python
# 本体层三张表（PostgreSQL）

CREATE TABLE equipment_types (
    type_id     VARCHAR PRIMARY KEY,        -- "compressor", "valve", "pump"
    name_zh     VARCHAR NOT NULL,           -- "天然气压缩机"
    name_en     VARCHAR NOT NULL,
    category    VARCHAR NOT NULL,           -- "rotating", "static", "flow_control"
    description TEXT,
    icon        VARCHAR,                    -- Studio 图标名
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE equipment_type_metrics (
    type_id     VARCHAR REFERENCES equipment_types,
    metric_name VARCHAR NOT NULL,           -- "outlet_pressure"
    unit        VARCHAR NOT NULL,           -- "MPa"
    warn_low    FLOAT, warn_high  FLOAT,
    alarm_low   FLOAT, alarm_high FLOAT,
    is_primary  BOOL DEFAULT FALSE,        -- 显示在主卡的指标
    PRIMARY KEY (type_id, metric_name)
);

CREATE TABLE equipment_type_actions (
    type_id     VARCHAR REFERENCES equipment_types,
    action_id   VARCHAR NOT NULL,           -- "emergency_stop", "bearing_inspect"
    label_zh    VARCHAR NOT NULL,           -- "立即停机"
    label_en    VARCHAR NOT NULL,
    priority    INT DEFAULT 0,              -- 越小越优先显示
    requires_approval BOOL DEFAULT TRUE,   -- 是否需要 HITL 审批
    PRIMARY KEY (type_id, action_id)
);
```

```python
# /v1/ontology/equipment-types → Studio 和 Skill 都可调
# /v1/ontology/equipment-types/{type_id}/metrics
# /v1/ontology/equipment-types/{type_id}/actions

# 初始化时从 Python 注册表迁移：
# python scripts/seed_ontology.py（一次性，后续数据库维护）
```

**价值：** Studio 的按钮、指标、阈值全从 API 动态读取；新增一种设备类型只需 Admin 界面配置，无需改代码。这才是「本体即一等公民」的轻量工程实现。

---

### 28.4 知识内容冷启动：Phase A 必须有的最小知识集

**当前问题：** 文档定义了 L0-L3 知识架构，但没有说清 Phase A 具体要预置哪些文档。没有知识，RAG 质量为零，AI 诊断是空架子。

**Phase A 最小知识集（天然气压缩站场景）：**

```
L0 通用知识（行业公开文档，可直接采集）：
  · GB/T 50251-2015 输气管道工程设计规范（关键章节）
  · SY/T 5543 天然气压缩机组操作维护规程
  · API 670 振动监测标准（设备故障判据）
  · 5-10 篇 Qwen3 生成的"假想经验"（冷启动占位，标注来源为"AI生成示例"）

L1 行业知识（设备商文档，联系厂商获取）：
  · 目标站场压缩机型号（如 Cat/GE/Siemens）操作手册
  · 典型故障模式与处理方法（OEM提供）

L2 站级规程（Phase A 与客户共同整理）：
  · 目标站场操作规程（2-5份 PDF）
  · 历史工单（导入模板，CSV 批量导入）

文档格式要求：
  · PDF/Word → LlamaIndex 分块 → bge-m3 向量化 → **pgvector**
  · 每个 chunk 强制标注 source_doc / page / layer / station_id
  · 无来源不入库（Grounding 原则）
```

**Phase A 知识冷启动脚本：**

```python
# scripts/seed_knowledge.py（Phase A 项目启动第一件事）
PHASE_A_KNOWLEDGE = [
    {"file": "docs/GB-T-50251-key-sections.pdf",   "layer": "L0", "station_id": None},
    {"file": "docs/SY-T-5543-compressor-ops.pdf",  "layer": "L0", "station_id": None},
    {"file": "docs/API-670-vibration.pdf",          "layer": "L0", "station_id": None},
    {"file": "docs/cat-compressor-manual.pdf",      "layer": "L1", "station_id": None},
    {"file": "docs/ST-01-ops-procedures.pdf",       "layer": "L2", "station_id": "ST-01"},
]
# 执行：python scripts/seed_knowledge.py
# 耗时：约 15-30 分钟（向量化）
# 验证：POST /v1/kb/search?q=轴承振动超限处理步骤 → 应返回有效结果
```

---

### 28.5 Phase A MVP 边界（可交付的最小完整产品）

> **最重要的工程决策：Phase A 必须是一个完整的价值闭环，而不是所有功能的 60%。**

```
Phase A MVP 范围（严格控制）：

站场：1 个天然气压缩站（ST-01）
设备：1 种设备类型（压缩机，C-001）
用户：运维操作员（3-5人）+ 站场管理员（1人）

功能完整性（必须全部跑通）：
  ✓ OPC-UA 或 Mock 数据接入 → TimescaleDB
  ✓ 实时读数 SSE 推送 → Studio 仪表盘
  ✓ 阈值告警 → 飞书推送
  ✓ MOIRAI 异常评分 → 飞书告警（最多 2 个预测性告警/天）
  ✓ 飞书对话"C-001 现在状态怎么样？"→ 实时数据回复
  ✓ 飞书对话"C-001 振动异常"→ Skill 拉数据 + 调 vLLM → 诊断结论 + 工单草稿
  ✓ 飞书审批工单 → 工单状态流转 → 结果记录
  ✓ Studio P&ID 图（SVG，不是 3D）→ 设备点击 → 状态详情
  ✓ Studio 工单列表 → 查看/审批
  ✓ 晨报（结构化卡片，无 LLM）→ 每天 6:00 发飞书

Phase A 不做（留 Phase B）：
  ✗ Babylon.js 3D 场景
  ✗ Eclipse Ditto（用 Redis Hash + SSE 代替）
  ✗ GraphRAG 关系抽取
  ✗ MinIO（文档存 PostgreSQL bytea）
  ✗ 多站场管理
  ✗ 视觉巡检（Qwen2.5-VL）
  ✗ Studio Admin 大部分功能（只保留用户管理和 KB 上传）
```

**Phase A 工程量估算（诚实版）：**

```
模块                     人天       说明
────────────────────────────────────────────────
Platform 核心 API        15d        CRUD + Auth + ABAC + 工单 FSM
OPC-UA Bridge + Kafka    5d         asyncua + Kafka 消费者
知识库 Pipeline          5d         PDF 分块 + bge-m3 + **pgvector**
MOIRAI 集成              3d         API 调用 + 告警逻辑
OpenClaw Skills          8d         industrial-twin + industrial-kb 两个 Skill 的 Prompt 工程
Studio 基础UI            12d        P&ID SVG + 仪表盘 + 工单列表
飞书集成                 5d         Bot 注册 + 事件回调 + 卡片模板
知识冷启动               3d         文档整理 + 向量化脚本
部署 Docker Compose      3d         服务编排 + Nginx + 环境变量
测试 + Demo 准备         5d         端到端测试 + 演示脚本

合计                     约 64人天（3 人 × 约 3 周，紧凑排期）
```

---

### 28.6 Skill 质量：架构只是骨架，Prompt 工程才是价值

**这是当前文档最大的忽视点。**

架构再好，如果 Skill 的 Prompt 写不对，用户得到的就是废话。工业 Prompt 工程的核心是：

```
工业 Prompt 三原则：

1. 约束胜于自由
   ❌ "请分析 C-001 的状态"（模型瞎发挥）
   ✅ "你是石油天然气场站设备专家。C-001 出口压力 6.2 MPa（正常 5.8-6.5），
       轴振 4.1 mm/s（警告 3.5，告警 5.0）。参考知识库 [GB-50251:§7.3]。
       返回严格 JSON。不得推断无数据支持的结论。"

2. 知识接地气
   每个关键判断必须有 [citation]，无来源的结论拒绝输出。
   RAG 检索后，将 chunk 前 300 字符放入 Prompt。

3. 输出格式强制
   系统提示强制 JSON Schema，用 pydantic 校验。
   解析失败 → 返回 {"severity":"unknown","summary":"AI 解析失败，请人工检查"}
   不抛异常，不让 Studio 崩溃。
```

**工业诊断 Prompt 模板（Phase A 权威版）：**

```python
DIAGNOSE_SYSTEM_PROMPT = """\
你是一名有20年经验的天然气管输场站设备工程师，擅长压缩机和阀门系统诊断。

【规则】
1. 只分析提供的数据，不推测未测量的值
2. 每个结论必须引用知识库来源 [文档ID:章节]
3. 若数据质量差（UNCERTAIN/BAD），返回 severity=unknown 并注明原因
4. 返回格式严格遵守下方 JSON Schema

【JSON Schema】
{{
  "severity": "normal|low|medium|high|critical|unknown",
  "anomaly_type": "正常运行|轴承磨损|压力异常|温度异常|振动超标|数据质量差",
  "summary": "一句话（≤40字）",
  "details": "分析过程（≤200字，含引用）",
  "confidence": 0.0-1.0,
  "citations": ["GB-50251:§7.3", "OEM手册:第5章"],
  "recommended_action": "monitor|bearing_inspect|valve_check|emergency_stop|data_check|manual_review",
  "urgency_hours": null或数字（建议多少小时内处理）
}}
"""
```

---

### 28.7 补充「工业智能问数」：Studio 缺失的数据探索入口

**当前 Studio 缺少的功能：** 用户经常想问「上个月压缩机平均效率是多少？」「哪台设备这周告警最多？」——这是典型的 KPI 查询，不是实时孪生。

**解决方案：** 参考文章的「Agent + RAG」模式，在 Studio 里加一个「数据分析」Tab。

```
工业智能问数 vs 通用智能问数的差异：

通用智能问数：NL → SQL → 任意表 → 结果
工业智能问数：NL → 理解工业术语 → 时序聚合查询 → 图表 + 分析

例子：
  用户问："上月哪台压缩机故障次数最多？"
  ↓
  Skill 理解意图：P1+P2 告警，聚合 by equipment_id，上月时间范围
  ↓
  Skill 调 Platform API：GET /v1/analytics/alarms?station=ST-01&from=...&group_by=equipment
  ↓
  Skill 调 vLLM：结合结果生成自然语言分析 + 可能的原因
  ↓
  Studio 显示：数据表格 + 自然语言分析 + 建议操作
```

**关键设计决策：不做 NL→SQL（工业场景不宜用）**  
工业时序数据的 SQL 很复杂（窗口函数、时区转换、质量过滤），让 LLM 生成可靠 SQL 很难。  
更好的做法：**定义有限的分析 API 端点 + Skill 映射意图到端点参数**。  
这比 NL→SQL 更安全、更可靠、更易审计。

```python
# 工业分析 API（有限集合，不是任意 SQL）
GET /v1/analytics/equipment-health?station_id&equipment_id&days=7
GET /v1/analytics/alarm-stats?station_id&from&to&group_by=equipment|hour|type
GET /v1/analytics/kpi?station_id&metric=availability|efficiency|mtbf&period=daily|weekly|monthly
GET /v1/analytics/top-anomalies?station_id&limit=10&days=30
GET /v1/analytics/trend?equipment_id&metric&from&to&agg=avg|max|min&interval=1h
```

---

### 28.8 不需要重造的轮子：成熟产品使用决策

```
组件            成熟方案              我们的角色              相对位置
──────────────────────────────────────────────────────────────────────
OPC-UA 采集    asyncua（开源）        配置 + 节点映射          使用者
时序存储        TimescaleDB（开源）   Schema + API 层          使用者
向量检索        **pgvector**（开源扩展） Embed Pipeline + API     使用者
LLM 推理        vLLM + Qwen3         Prompt 工程（Skills）    使用者
时序 AI         MOIRAI（开源）       API 包装 + 告警逻辑      使用者
AI 编排         OpenClaw（开源）     Skills（行业能力包）      开发者
文档处理        LlamaIndex           分块配置                 使用者
消息总线        Kafka                Topic Schema + Consumer  使用者
移动/通知       飞书                  Bot + 卡片模板           开发者
UI 组件         shadcn/ui            Studio 页面              开发者
监控            Prometheus+Grafana   指标暴露 + Dashboard     使用者

【我们的核心 IP（不可外购，必须自研）】
  · 工业本体配置（设备类型/指标/动作定义）
  · 行业知识包（L1 文档整理 + L2 规程数字化）
  · OpenClaw Skills 的 Prompt 工程和业务逻辑
  · HITL 工单工作流（AI 起草→审批→执行→知识回流）
  · IMS 适配器（特定 DCS/SCADA/ERP 的集成代码）
  · Studio 产品化 UI（对象中心 + 告警驱动 + 调查模式）
```

---

### 28.9 修正后的完整 5 层架构（工业场景定制版）

参考文章的 5 层架构原则，结合 ClawTwin 实际，**工业智能操作平台的 5 层**如下：

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 5：操作员体验层（用户接入）                                  │
│                                                                  │
│  ClawTwin Studio（桌面 Web）                                      │
│    P&ID 图 · 告警看板 · 设备详情 · 工单管理 · 数据分析             │
│                                                                  │
│  飞书（手机/PC）                                                   │
│    实时告警 · 自然语言问询 · 工单审批 · 晨报                        │
│                                                                  │
│  ← 与 Platform 通信：SSE（实时）+ REST（操作）+ User JWT（认证）    │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 4：AI 编排层（推理与意图）                                   │
│                                                                  │
│  OpenClaw Gateway（开源，我们配置）                                 │
│    Session 管理 · 意图识别 · Skill 路由                            │
│                                                                  │
│  Industry Skills（我们开发，核心 IP）                               │
│    industrial-twin（设备状态读取 + 诊断触发）                       │
│    industrial-kb（知识检索 + 引用回答）                             │
│    industrial-workorder（工单创建 + 状态管理）                      │
│    industrial-analytics（KPI 查询 + 趋势分析）                     │
│                                                                  │
│  ← Skills 调 Platform 数据 API（Service Token）                   │
│  ← Skills 调 GPU Server vLLM（直连推理，无中间层）                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 3：工业数据平台层（我们开发，核心产品）                       │
│                                                                  │
│  Platform API（FastAPI）                                          │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │  Ontology Layer（本体层）                                  │  │
│    │  /v1/ontology/equipment-types + metrics + actions         │  │
│    │  /v1/objects/equipment/{id}（聚合对象 API）               │  │
│    └──────────────────────────────────────────────────────────┘  │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │  Business Layer（业务层）                                  │  │
│    │  工单 FSM + 告警管理 + 班次管理 + 用户管理                  │  │
│    │  IMS Adapter（OPC-UA/REST/CSV 统一接口）                   │  │
│    └──────────────────────────────────────────────────────────┘  │
│    ┌──────────────────────────────────────────────────────────┐  │
│    │  Intelligence Layer（数据层 AI，不做推理）                 │  │
│    │  bge-m3 向量化（KB 文档 + 查询向量化）                     │  │
│    │  MOIRAI 时序异常检测（后台定时，主动监控）                  │  │
│    │  compute_primary_action（纯规则引擎）                      │  │
│    └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 2：安全控制层（贯穿 Platform，不是单独服务）                  │
│                                                                  │
│  身份验证：User JWT（飞书绑定/工号登录）+ Service Token（Skill）    │
│  权限控制：ABAC（用户→角色→场站→设备）                             │
│  OT 安全：网络分区（Zone 0/1/2），Kafka 单向，禁止 IT→OT          │
│  数据安全：审计日志（append-only）+ 飞书 Webhook 验签             │
│  AI 安全：所有 AI 输出必须有 Citations，置信度 < 0.6 不显示行动建议  │
│  限流：slowapi（API 频率限制）+ vLLM --max-num-seqs（推理并发）    │
│                                                                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  Layer 1：工业数据接入层（OT 侧）                                  │
│                                                                  │
│  Zone 0（OT）：PLC/DCS/RTU → OPC-UA Server                      │
│                ↓ 单向，物理防火墙                                   │
│  Zone 1（DMZ）：opcua-bridge → Kafka（只推，不存，不暴露）          │
│                ↓ Kafka TCP 9092                                   │
│  Zone 2（IT）：IngestPipeline → TimescaleDB + Redis（SSE 缓存）   │
│                                                                  │
│  IMS 接入：ERP/CMMS/MES → IMS Adapter（REST/CSV）→ Platform      │
│  GPU 推理：vLLM（:8000）+ bge-m3（:8001）+ MOIRAI（:8002）       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### 28.10 开发里程碑（务实版）

```
Phase A「可演示的最小闭环」（约 3 个月）
────────────────────────────────────────────────────────
里程碑 A1：数据进来（第 1-4 周）
  · opcua-bridge Mock 服务器 → Kafka → TimescaleDB
  · Platform 基础 API（Auth/Equipment/Readings）
  · Studio 最简仪表盘（读数 + 告警色）
  验收：C-001 的 3 个指标实时显示，超阈值变红

里程碑 A2：AI 能用（第 5-8 周）
  · **pgvector** + 知识冷启动（≥20 份文档向量化）
  · industrial-twin Skill + industrial-kb Skill
  · 飞书 Bot 接入
  · vLLM 部署（GPU 服务器）
  验收：飞书问"C-001 振动 4.5 mm/s 怎么处理？"得到有引用的回答

里程碑 A3：HITL 闭环（第 9-12 周）
  · 工单 FSM 完整实现
  · 飞书审批卡片 + HITL 回调
  · MOIRAI 预测性告警（至少 1 个真实案例）
  · 晨报推送（结构化 KPI 卡片）
  验收：AI 诊断→工单草稿→飞书审批→状态流转全链路跑通

Phase B「工程化部署」（约 3-6 个月）
────────────────────────────────────────────────────────
  · Eclipse Ditto 替换 Redis Hash 孪生运行时
  · Babylon.js 3D 场景（第一个完整站场）
  · GraphRAG 关系抽取（知识质量大幅提升）
  · 多站场管理 + Admin 完整功能
  · MinIO 文档存储
  · 真实 OPC-UA 接入（现场部署）
  · 完整 Studio（P&ID + 3D + 趋势图 + 工单）

Phase C「规模化」（6 个月以上）
────────────────────────────────────────────────────────
  · 行业知识包产品化（可复用到其他石油公司）
  · 多行业适配（化工/电力）
  · 视觉巡检（Qwen2.5-VL + 摄像头接入）
  · 具身机器人集成（远期）
```

---

### 28.11 对外产品叙事（给客户/投资人的准确表述）

**不过度承诺的正确表述：**

```
ClawTwin 是什么：
  「基于 AI 原生架构的工业场站智能操作平台。
   将设备实时状态、行业知识和 AI 推理融为一体，
   通过飞书和专业工作台让操作员获得可信的行动建议，
   通过人机协同工单实现 AI 建议到现场执行的完整闭环。」

ClawTwin 不是什么：
  · 不是 SCADA 系统（不替代控制系统）
  · 不是 ERP/CMMS（不替代工单系统，只是智能补充）
  · 不是 Palantir Foundry（我们是受其启发的工业垂直实现，功能子集）
  · 不是通用 AI 平台（专注油气管输场站，做深不做广）

技术优势（客观）：
  · 私有化部署，工业数据不出厂
  · 设备诊断有知识库引用来源，而不是 ChatGPT 猜测
  · AI 只提议，人类决定，符合工业安全规范
  · 与飞书深度集成，不需要额外 APP
```

---

_§二十八 新增（2026-05-11）：整合「智能问数 5 层架构」原则 + Palantir 理念 + 工业场景特性，_  
_形成权威的产品蓝图与开发框架。本节是 Phase A 开发的最终优先级指引。_

---

## 二十九、工业场景补全（2026-05-11）

> 基于 INDUSTRIAL-SCENARIOS-COMPLETE.md 的审计结果，Phase A 必须补充以下内容。

### 29.1 新增 ORM 模型

```python
# models/production.py
from sqlalchemy import Column, Integer, String, Date, DECIMAL, Text, Boolean, ForeignKey
from sqlalchemy.dialects.postgresql import TIMESTAMPTZ, JSONB
from sqlalchemy.sql import func
from db.session import Base


class ProductionRecord(Base):
    """生产日报（每日/班次产量记录）"""
    __tablename__ = "production_records"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    station_id      = Column(Integer, ForeignKey("stations.id"), nullable=False)
    record_date     = Column(Date, nullable=False)
    shift_type      = Column(String(20), default="daily")  # daily|morning|afternoon|night

    oil_volume_m3   = Column(DECIMAL(12, 3))
    gas_volume_m3   = Column(DECIMAL(12, 3))
    water_volume_m3 = Column(DECIMAL(12, 3))
    throughput_m3   = Column(DECIMAL(12, 3))

    runtime_hours   = Column(DECIMAL(5, 2))
    energy_kwh      = Column(DECIMAL(10, 2))
    outage_minutes  = Column(Integer, default=0)
    outage_reason   = Column(Text)
    notes           = Column(Text)

    created_by      = Column(Integer, ForeignKey("users.id"))
    created_at      = Column(TIMESTAMPTZ, server_default=func.now())
    updated_at      = Column(TIMESTAMPTZ, onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("station_id", "record_date", "shift_type"),
    )


class ShiftRecord(Base):
    """班次记录（交接班）"""
    __tablename__ = "shift_records"

    id                    = Column(Integer, primary_key=True, autoincrement=True)
    station_id            = Column(Integer, ForeignKey("stations.id"), nullable=False)
    shift_date            = Column(Date, nullable=False)
    shift_type            = Column(String(20), nullable=False)  # morning|afternoon|night
    start_time            = Column(TIMESTAMPTZ, nullable=False)
    end_time              = Column(TIMESTAMPTZ)

    on_duty_operator_id   = Column(Integer, ForeignKey("users.id"))
    handover_to_id        = Column(Integer, ForeignKey("users.id"))

    status                = Column(String(20), default="active")  # active|pending_handover|completed
    handover_summary      = Column(Text)           # AI 生成的交接摘要
    key_events            = Column(JSONB, default=list)
    outstanding_issues    = Column(JSONB, default=list)
    active_work_order_ids = Column(JSONB, default=list)

    confirmed_at          = Column(TIMESTAMPTZ)
    confirmed_by          = Column(Integer, ForeignKey("users.id"))
    created_at            = Column(TIMESTAMPTZ, server_default=func.now())


class InspectionSchedule(Base):
    """巡检计划"""
    __tablename__ = "inspection_schedules"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    station_id      = Column(Integer, ForeignKey("stations.id"), nullable=False)
    name            = Column(String(200), nullable=False)
    frequency       = Column(String(50), nullable=False)  # daily|weekly|monthly
    route           = Column(Text)
    checklist       = Column(JSONB, nullable=False)  # [{item, required, method}]
    assignee_role   = Column(String(50))              # operator|technician
    is_active       = Column(Boolean, default=True)
    next_due_at     = Column(TIMESTAMPTZ)
    last_done_at    = Column(TIMESTAMPTZ)
    created_at      = Column(TIMESTAMPTZ, server_default=func.now())
```

### 29.2 新增 API 路由注册

```python
# 在 main.py 中新增（app.include_router 之后）
from routers import production, shifts, inspection

app.include_router(production.router,  prefix="/v1/production", tags=["production"])
app.include_router(shifts.router,      prefix="/v1/shifts",     tags=["shifts"])
app.include_router(inspection.router,  prefix="/v1/inspection", tags=["inspection"])
```

### 29.3 新增 Alembic 迁移

```python
# alembic/versions/xxxx_add_industrial_scenario_tables.py

def upgrade():
    # production_records
    op.create_table("production_records", ...)
    op.create_unique_constraint("uq_production_station_date_shift",
        "production_records", ["station_id", "record_date", "shift_type"])

    # shift_records
    op.create_table("shift_records", ...)

    # inspection_schedules
    op.create_table("inspection_schedules", ...)

    # equipment 状态枚举扩展（字符串，不需要 ALTER TYPE）
    # 在代码层面直接使用新枚举值即可，旧数据中的 "normal" → 用迁移更新为 "running"
    op.execute("""
        UPDATE equipment SET status = 'running'
        WHERE status = 'normal'
    """)

    # alarms 补充 ISA-18.2 字段
    op.add_column("alarms", sa.Column("standing_since", sa.TIMESTAMPTZ()))
    op.add_column("alarms", sa.Column("chat_count", sa.Integer(), server_default="1"))
    op.add_column("alarms", sa.Column("last_triggered_at", sa.TIMESTAMPTZ(),
                                       server_default=sa.text("NOW()")))

    # work_orders 补充字段
    op.add_column("work_orders", sa.Column("work_subtype", sa.String(100)))
    op.add_column("work_orders", sa.Column("permit_required", sa.Boolean(), server_default="false"))
    op.add_column("work_orders", sa.Column("permit_type", sa.String(50)))
    op.add_column("work_orders", sa.Column("permit_number", sa.String(100)))
    op.add_column("work_orders", sa.Column("permit_status", sa.String(50)))
    op.add_column("work_orders", sa.Column("inspection_route", sa.String(200)))
    op.add_column("work_orders", sa.Column("checklist_items", postgresql.JSONB()))
    op.add_column("work_orders", sa.Column("checklist_results", postgresql.JSONB()))
    op.add_column("work_orders", sa.Column("shift_record_id",
                                           sa.Integer(), sa.ForeignKey("shift_records.id")))
```

### 29.4 Studio 新增页面清单

| 页面 / 组件           | 路径                        | Phase     |
| --------------------- | --------------------------- | --------- |
| `ProductionPage`      | `/stations/{id}/production` | A         |
| `ShiftHandoverPage`   | `/stations/{id}/shifts`     | A         |
| `InspectionPage`      | `/stations/{id}/inspection` | A         |
| `AlarmKPIPanel`       | 嵌入 AlarmQueuePanel        | A         |
| `PTWBadge`            | 嵌入 WorkOrderDetail        | A（预留） |
| `InspectionFormModal` | 巡检任务完成填写            | A         |

### 29.5 新增 Sage Skills

```
contrib/industrial-oilgas-skills/industrial-shift/SKILL.md    # 班次交接 Skill
contrib/industrial-oilgas-skills/industrial-production/SKILL.md  # 生产数据 Skill
contrib/industrial-oilgas-skills/industrial-inspection/SKILL.md  # 巡检管理 Skill
```

---

_§二十九 新增（2026-05-11）：工业场景审计补全。本节是 Phase A 新增表/API/UI 的权威来源。_
