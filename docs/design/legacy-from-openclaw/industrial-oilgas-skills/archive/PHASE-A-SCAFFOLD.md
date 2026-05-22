# ClawTwin Phase A 开发脚手架

## 从零到可展示 Demo 的 14 天路线图

**日期**：2026-05-08（最近更新 2026-05-11）
**目标**：Day 14 可以演示完整流程：3D 场站 → 点击设备 → AI 分析 → 飞书告警卡片  
**原则**：所有代码从能运行的最小化版本开始，不预留未用的抽象

> ## ⚠️ 范式纠正（2026-05-11，最高优先）
>
> ClawTwin 是 **Industrial Foundry**，不是 Agent 系统。
>
> - 本文档 Day 1-3 的目录结构与初始化脚本（按 routers/services/models 组织）**已被取代**
> - 实际目录结构按 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §八` 7 层执行
> - 第一周里程碑改为：T0.5 Ontology Loader → T2.5 Executor → T2.6 Auto-Generator → T3 Equipment YAML
> - 见 `CURSOR-MULTITASK-GUIDE.md` 已更新的任务列表

> ## ⚠️ 技术栈修正说明（2026-05-11 更新）
>
> 本文档原版（2026-05-08）包含的 `docker-compose.yml` 有 **8 个以上的服务**
> （Milvus + etcd + MinIO + Kafka + Zookeeper + Ditto），这与现行架构决策冲突。
>
> **Phase A 正确技术栈只有 4 个服务**（见 `ARCHITECTURE-SIMPLIFICATION-AUDIT.md §三`）：
>
> ```
> postgres（TimescaleDB + pgvector）+ redis + vllm + openclaw
> ```
>
> **具体变更：**
>
> - ❌ Milvus + etcd → ✅ pgvector（已内置于 PostgreSQL）
> - ❌ MinIO → ✅ Phase B 才引入（Phase A 文件存本地磁盘或跳过）
> - ❌ Kafka + Zookeeper → ✅ Redis Streams（Phase B 再换）
> - ❌ Eclipse Ditto → ✅ Redis Hash 设备影子（Phase B 再换）
>
> **知识库向量存储：**
>
> - ❌ Milvus Collection + pymilvus → ✅ pgvector + LlamaIndex（见 `MODULE-DESIGN-PLATFORM.md §八`）
>
> 本文档正文描述的业务流程和代码结构仍然有效，**仅 docker-compose.yml 部分需要参照下方修正版本**。
>
> ---
>
> ### 修正版 docker-compose.yml（Phase A，4 个服务）
>
> ```yaml
> # docker-compose.yml（Phase A 修正版）
> services:
>   postgres:
>     image: timescale/timescaledb-ha:pg16-latest # 包含 TimescaleDB + pgvector
>     environment:
>       POSTGRES_USER: clawtwin
>       POSTGRES_PASSWORD: clawtwin_dev
>       POSTGRES_DB: clawtwin
>     ports:
>       - "5432:5432"
>     volumes:
>       - postgres_data:/var/lib/postgresql/data
>     healthcheck:
>       test: ["CMD-SHELL", "pg_isready -U clawtwin"]
>       interval: 10s
>       retries: 5
>
>   redis:
>     image: redis:7-alpine
>     ports:
>       - "6379:6379"
>     volumes:
>       - redis_data:/data
>     healthcheck:
>       test: ["CMD", "redis-cli", "ping"]
>       interval: 5s
>       retries: 3
>
>   vllm:
>     image: vllm/vllm-openai:latest
>     runtime: nvidia # 需要 GPU；无 GPU 时注释掉并用 api-base-url 指向远端
>     environment:
>       HUGGING_FACE_HUB_TOKEN: ${HF_TOKEN}
>     command: >
>       --model Qwen/Qwen3-1.7B-GPTQ-Int4
>       --max-model-len 32768
>       --enable-prefix-caching
>     ports:
>       - "8000:8000"
>     volumes:
>       - ~/.cache/huggingface:/root/.cache/huggingface
>
>   openclaw:
>     image: ghcr.io/openclaw/openclaw:latest
>     env_file: .env
>     ports:
>       - "4000:4000"
>     depends_on:
>       - platform-api # 等 Platform 起来后再起
>     volumes:
>       - ./openclaw-config:/app/data
>
>   platform-api:
>     build: ./platform-api
>     env_file: .env
>     ports:
>       - "8080:8080"
>     depends_on:
>       postgres:
>         condition: service_healthy
>       redis:
>         condition: service_healthy
>     volumes:
>       - ./platform-api:/app # 开发时热重载
>
> volumes:
>   postgres_data:
>   redis_data:
> ```
>
> **Phase A 不需要** MinIO / Milvus / etcd / Kafka / Zookeeper / Ditto。
> 忽略本文档正文中出现的 `milvus:` / `minio:` / `kafka:` / `etcd:` 服务定义。

---

## 一、项目结构（从 Day 1 建立）

```
~/Projects/
  clawtwin-platform/        ← 新建（Platform 后端，我们写的代码）
    docker-compose.yml
    docker-compose.override.yml   ← 本地 mock 配置
    .env.example
    platform-api/           ← FastAPI 服务（Python）
      main.py
      routers/
        objects.py          ← /v1/objects/*
        tools.py            ← /v1/tools/*
        analytics.py        ← /v1/analytics/*
        ingest.py           ← /v1/ingest/*
        feishu_webhook.py   ← /v1/feishu/webhook（飞书事件回调接收）
      services/
        ai_client.py        ← GPU 推理服务 HTTP 客户端（httpx 调 vLLM OpenAI API，内置 Circuit Breaker）
        kb.py               ← Milvus 知识库客户端（Python SDK，gRPC）
        moirai_client.py    ← MOIRAI 时序预测 HTTP 客户端（httpx 调 MOIRAI 独立服务）
        feishu.py           ← Feishu Bot 客户端（推送消息）
        feishu_hitl.py      ← Feishu HITL 工单状态机驱动
        ingest.py           ← IngestPipeline（asyncio.Queue，背压保护）
        # 注：vLLM Python 库不在 Platform 里安装，Platform 通过 HTTP 访问 GPU 服务器
      scheduler/
        jobs.py             ← APScheduler 定时任务
        anomaly_poll.py     ← 每小时异常轮询
        morning_briefing.py ← 每日晨报
      models/
        equipment.py        ← Equipment 数据模型
        workorder.py        ← WorkOrder 数据模型
        station.py          ← Station 数据模型
      hitl/
        workorder_fsm.py    ← 工单状态机 + 飞书卡片 HITL
      pyproject.toml
      requirements.txt
    data/
      mock/
        station-S001.json   ← 场站 mock 数据（C-001 等设备）
        equipment-C001.json ← 设备 mock 数据（含阈值）

  clawtwin-studio/          ← 从 archive/maibot-ui 复制后改名
    package.json            ← name 改为 @clawtwin/studio
    src/
      pages/
        TwinPage.tsx        ← 新增：/twin 路由页面
        CommandPage.tsx     ← 新增：/command 全屏 3D 页面
        admin/
          KnowledgeAdminPage.tsx  ← 新增：/admin/knowledge 知识管理
      surfaces/
        TwinSurface.tsx           ← 新增：3D 场景容器（Babylon.js）
        EquipmentDetailPanel.tsx  ← 新增：设备详情右侧面板
        KPIDashboard.tsx          ← 新增：KPI 仪表盘（Phase A 简版）
      router.tsx            ← 修改：添加 /twin、/command、/admin/* 路由
    packages/               ← 保留不动（adapter / store / ui-kit）
```

---

## 二、docker-compose.yml（Phase A 基础设施）

> **分层说明**
>
> - **Phase A Core**（MOCK_MODE=true）：`platform-api` + `postgres` + `redis` + `milvus` + `etcd` + `minio` + `nginx` + `openclaw`，Kafka/Ditto 可选
> - **Phase A Extended**（MOCK_MODE=false，接真实 OPC-UA）：追加 `kafka` + `zookeeper` + `opcua-bridge` + `ditto`
> - **Eclipse Ditto** 在 Phase A MOCK_MODE 下跳过，Platform 用 Redis Hash 存实时设备状态，Phase B 迁移到 Ditto

```yaml
# clawtwin-platform/docker-compose.yml
version: "3.9"

# ── 网络分区（见 CLAWTWIN-MASTER-V2.md 附录）────────────────────
networks:
  clawtwin-it: # IT 内网 Zone 2（Platform 所有服务）
    driver: bridge
  clawtwin-dmz: # DMZ 采集网 Zone 1（opcua-bridge 专用）
    driver: bridge
  clawtwin-kafka: # Kafka 跨区消息总线
    driver: bridge

services:
  # ══════════════════════════════════════════════════════════════
  # 我们开发的服务
  # ══════════════════════════════════════════════════════════════

  platform-api:
    build: ./platform-api
    ports:
      - "8080:8080"
    env_file: .env
    environment:
      DATABASE_URL: "postgresql+asyncpg://clawtwin:${POSTGRES_PASSWORD:-clawtwin}@postgres:5432/clawtwin"
      REDIS_URL: "redis://redis:6379"
      MILVUS_HOST: "milvus"
      MILVUS_PORT: "19530"
      MINIO_ENDPOINT: "minio:9000"
      KAFKA_BROKERS: "kafka:9092"
      # Phase A：MOCK_MODE=true 时跳过 Ditto/Kafka/OPC-UA，直接读 Redis
      DITTO_URL: "http://ditto:8080" # Phase A 中此 URL 不会被调用
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
      milvus:
        condition: service_started
      minio:
        condition: service_started
    networks:
      - clawtwin-it
      - clawtwin-kafka
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  # OpenClaw Gateway（AI 对话引擎，独立产品）
  openclaw:
    image: ghcr.io/openclaw/openclaw:latest # 或本地 build
    ports:
      - "3000:3000"
    volumes:
      - ./openclaw-config:/home/openclaw/.openclaw # 挂载 skill 配置
    environment:
      OPENCLAW_SKILL_DIRS: "/home/openclaw/.openclaw/skills"
    networks:
      - clawtwin-it
    restart: unless-stopped

  # Nginx（唯一对外入口）
  nginx:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./clawtwin-studio/dist:/usr/share/nginx/html:ro
    depends_on:
      - platform-api
      - openclaw
    networks:
      - clawtwin-it
    restart: unless-stopped

  # OPC-UA Bridge（DMZ，Phase A 用 opcua-mock-server 替代）
  opcua-bridge:
    build: ./opcua-bridge
    profiles: ["real-opcua"] # 不在 Phase A 默认启动，用 --profile real-opcua 激活
    env_file: .env
    networks:
      - clawtwin-dmz
      - clawtwin-kafka
    restart: unless-stopped

  opcua-mock-server:
    image: python:3.12-slim
    command: python /app/opcua-mock-server.py
    profiles: ["mock-opcua"] # docker compose --profile mock-opcua up
    volumes:
      - ./scripts/opcua-mock-server.py:/app/opcua-mock-server.py
    networks:
      - clawtwin-dmz
    ports:
      - "4840:4840"

  # ══════════════════════════════════════════════════════════════
  # 开源基础设施
  # ══════════════════════════════════════════════════════════════

  postgres:
    image: timescale/timescaledb:latest-pg16
    environment:
      POSTGRES_USER: clawtwin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-clawtwin}
      POSTGRES_DB: clawtwin
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./data/seeds/init.sql:/docker-entrypoint-initdb.d/01-init.sql
    ports:
      - "5432:5432"
    networks:
      - clawtwin-it
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clawtwin"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    networks:
      - clawtwin-it
    restart: unless-stopped

  # Milvus + 依赖（etcd 是 Milvus 的元数据协调服务）
  etcd:
    image: quay.io/coreos/etcd:v3.5.9
    environment:
      ETCD_AUTO_COMPACTION_MODE: revision
      ETCD_AUTO_COMPACTION_RETENTION: "1000"
      ETCD_QUOTA_BACKEND_BYTES: "4294967296"
      ETCD_SNAPSHOT_COUNT: "50000"
    command: >
      etcd
      --advertise-client-urls=http://etcd:2379
      --listen-client-urls=http://0.0.0.0:2379
      --data-dir=/etcd
    volumes:
      - etcd_data:/etcd
    networks:
      - clawtwin-it

  minio:
    image: minio/minio:RELEASE.2024-01-18T22-51-28Z
    environment:
      MINIO_ROOT_USER: ${MINIO_ACCESS_KEY:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_SECRET_KEY:-minioadmin123}
    command: minio server /minio_data --console-address ":9001"
    volumes:
      - minio_data:/minio_data
    ports:
      - "9000:9000" # S3 API
      - "9001:9001" # MinIO Console
    networks:
      - clawtwin-it
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 5s
      retries: 3

  milvus:
    image: milvusdb/milvus:v2.5.4
    command: milvus run standalone
    environment:
      ETCD_ENDPOINTS: etcd:2379
      MINIO_ADDRESS: minio:9000
      MINIO_ACCESS_KEY_ID: ${MINIO_ACCESS_KEY:-minioadmin}
      MINIO_SECRET_ACCESS_KEY: ${MINIO_SECRET_KEY:-minioadmin123}
    depends_on:
      - etcd
      - minio
    ports:
      - "19530:19530"
    volumes:
      - milvus_data:/var/lib/milvus
    networks:
      - clawtwin-it

  # Kafka（Phase A MOCK_MODE=true 时不被调用，但预置好备用）
  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    profiles: ["with-kafka"]
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
    volumes:
      - zk_data:/var/lib/zookeeper/data
    networks:
      - clawtwin-kafka

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    profiles: ["with-kafka"]
    depends_on:
      - zookeeper
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    volumes:
      - kafka_data:/var/lib/kafka/data
    networks:
      - clawtwin-kafka
      - clawtwin-it

  # Eclipse Ditto（Phase B，接真实 OPC-UA 时启用）
  # Phase A MOCK_MODE：Platform 用 Redis Hash 存实时设备状态替代 Ditto
  ditto:
    image: eclipse/ditto:3.7.0
    profiles: ["with-ditto"]
    environment:
      DITTO_DEVOPS_SECURE_STATUS: "false"
    ports:
      - "8081:8080"
    networks:
      - clawtwin-it

volumes:
  postgres_data:
  redis_data:
  etcd_data:
  minio_data:
  milvus_data:
  zk_data:
  kafka_data:
```

**常用启动命令**：

```bash
# Phase A（Mock 模式，最精简）
docker compose up -d

# Phase A + Kafka（准备接 OPC-UA Bridge）
docker compose --profile with-kafka up -d

# Phase A + OPC-UA 模拟服务器（本地调试数据采集）
docker compose --profile with-kafka --profile mock-opcua up -d

# Phase B（完整生产模式）
docker compose --profile with-kafka --profile with-ditto --profile real-opcua up -d
```

---

## 三、Platform API 核心端点

> ⚠️ **注意**：本节的 `main.py` 是早期简化版，已由 `MODULE-DESIGN-PLATFORM.md §七` 的完整版取代。  
> **开发时以 MODULE-DESIGN-PLATFORM.md §七 为准**，此处仅保留作历史参考。

完整 `main.py` 实现（含 lifespan、安全中间件、所有路由注册）→ 见 **MODULE-DESIGN-PLATFORM.md §七**  
完整 `config.py` 实现（所有配置项）→ 见 **MODULE-DESIGN-PLATFORM.md §六**

---

## 四、Equipment Ontology API（Phase A：Mock）

```python
# platform-api/routers/objects.py
from fastapi import APIRouter, HTTPException
from models.equipment import EquipmentObject
import json, os

router = APIRouter()

# Phase A：从 JSON 文件加载 mock 数据，Phase B 改接 Ditto
MOCK_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "mock")

def load_mock_equipment(equipment_id: str) -> dict:
    path = os.path.join(MOCK_DIR, f"equipment-{equipment_id}.json")
    if not os.path.exists(path):
        # 尝试从场站数据生成
        station = load_mock_station("S001")
        for eq in station.get("equipment", []):
            if eq["equipment_id"] == equipment_id:
                return enrich_with_runtime(eq)
        raise HTTPException(404, f"Equipment {equipment_id} not found")
    with open(path) as f:
        return json.load(f)

def enrich_with_runtime(eq: dict) -> dict:
    """Phase A：Mock 实时数据（正态分布随机值，模拟真实波动）"""
    import random, datetime
    base = {
        "equipment_id": eq["equipment_id"],
        "name": eq["name"],
        "type": eq["type"],
        "current": {},
        "thresholds": eq.get("thresholds", {}),
        "status": "NORMAL",
        "last_updated": datetime.datetime.utcnow().isoformat() + "Z",
        "citations": [f"mock:{eq['equipment_id']}:dev"]
    }
    # 简单 mock：在正常范围内随机，偶尔触发 WARNING
    if eq["type"] == "reciprocating_compressor":
        base["current"] = {
            "vibration":     round(random.gauss(2.5, 0.8), 2),
            "outlet_pressure": round(random.gauss(6.1, 0.15), 2),
            "inlet_temp":    round(random.gauss(35, 3), 1),
        }
        v = base["current"]["vibration"]
        base["status"] = "ALARM" if v > 5.0 else "WARNING" if v > 3.5 else "NORMAL"
    return base

def load_mock_station(station_id: str) -> dict:
    path = os.path.join(MOCK_DIR, f"station-{station_id}.json")
    with open(path) as f:
        return json.load(f)

@router.get("/equipment/{equipment_id}", response_model=dict)
async def get_equipment(equipment_id: str):
    """Industrial Ontology: 获取设备完整对象（静态定义 + 实时状态）"""
    return load_mock_equipment(equipment_id)

@router.get("/station/{station_id}", response_model=dict)
async def get_station(station_id: str):
    """Industrial Ontology: 获取场站对象"""
    station = load_mock_station(station_id)
    # 聚合各设备状态
    equipment_list = station.get("equipment_ids", [])
    station_status = "NORMAL"
    for eid in equipment_list[:5]:  # 采样前5个
        try:
            eq = load_mock_equipment(eid)
            if eq["status"] == "ALARM":
                station_status = "ALARM"
                break
            elif eq["status"] == "WARNING" and station_status == "NORMAL":
                station_status = "WARNING"
        except Exception:
            pass
    station["computed_status"] = station_status
    station["citations"] = [f"mock:station:{station_id}:dev"]
    return station

@router.get("/equipment/{equipment_id}/links", response_model=dict)
async def get_equipment_links(equipment_id: str):
    """Industrial Ontology: 获取设备上下游关系（Phase A：Mock）"""
    # Phase B 接 GraphRAG
    mock_links = {
        "C-001": {
            "upstream": [],
            "downstream": [
                {"equipment_id": "P-003", "relation": "flow_to", "label": "干线输气管 P-003"},
                {"equipment_id": "V-005", "relation": "isolation", "label": "旁路阀 V-005"}
            ]
        }
    }
    return {
        "equipment_id": equipment_id,
        "links": mock_links.get(equipment_id, {"upstream": [], "downstream": []}),
        "citations": [f"mock:links:{equipment_id}:dev"]
    }
```

---

## 五、Station Mock 数据（data/mock/station-S001.json）

```json
{
  "station_id": "S001",
  "name": "沙坪坝 A 输气场站",
  "type": "compressor_station",
  "location": { "province": "重庆", "city": "沙坪坝区" },
  "equipment_ids": ["C-001", "SDV-001", "SDV-002", "FT-001", "PT-001"],
  "equipment": [
    {
      "equipment_id": "C-001",
      "name": "天然气压缩机组 C-001",
      "type": "reciprocating_compressor",
      "thresholds": {
        "vibration": { "warn": 3.5, "alarm": 5.0, "unit": "mm/s" },
        "outlet_pressure": { "warn": 6.5, "alarm": 7.0, "unit": "MPa" },
        "inlet_temp": { "warn": 45, "alarm": 55, "unit": "°C" }
      }
    },
    {
      "equipment_id": "SDV-001",
      "name": "紧急截断阀 SDV-001",
      "type": "shutdown_valve",
      "thresholds": {
        "position": { "warn": null, "alarm": null, "unit": "%" }
      }
    },
    {
      "equipment_id": "FT-001",
      "name": "超声波流量计 FT-001",
      "type": "flow_meter",
      "thresholds": {
        "flow_rate": { "warn": 95, "alarm": 100, "unit": "万方/天" }
      }
    }
  ]
}
```

---

## 六、工单 HITL（platform-api/hitl/workorder_fsm.py）

```python
# platform-api/hitl/workorder_fsm.py
"""
工单状态机 + 飞书审批卡片
Platform 直接管理 HITL 流程，不依赖 OpenClaw TaskFlow
"""
import uuid, datetime
from enum import Enum
from services.feishu import FeishuClient

# ⚠️ WorkOrderStatus（大写）已废弃！
# 权威枚举在 MODULE-DESIGN-PLATFORM.md §19.3（WorkOrderState，值全部小写下划线）
# Phase A 脚手架使用字符串 mock，Phase B 换 WorkOrderState 枚举 + PostgreSQL ORM

# Phase A: 内存存储（mock），字段名与 §19.3/§19.5 对齐
_workorders: dict[str, dict] = {}

async def create_draft(equipment_id: str, title: str, description: str,
                       priority: str = "P2") -> dict:
    """创建工单草稿（state=draft），推送飞书审批卡片。
    字段对齐 §19.5 WorkOrder TypeScript 接口。"""
    wo_id = f"W-{uuid.uuid4().hex[:8].upper()}"
    wo = {
        "wo_id":         wo_id,           # ← 主键字段名 wo_id
        "equipment_id":  equipment_id,
        "title":         title,
        "priority":      priority,
        "description":   description,
        "state":         "draft",          # ← 字段名 state，值小写
        "created_at":    datetime.datetime.utcnow().isoformat() + "Z",
    }
    _workorders[wo_id] = wo
    return wo

async def submit_for_approval(wo_id: str, current_user_id: str) -> dict:
    """提交审批（draft → pending_approval），推送飞书审批卡片"""
    wo = _workorders.get(wo_id)
    if not wo:
        raise ValueError(f"工单 {wo_id} 不存在")
    if wo["state"] != "draft":
        raise ValueError(f"只有 draft 状态可以提交，当前 state={wo['state']}")
    wo["state"] = "pending_approval"
    await FeishuClient.send_workorder_approval_card(wo)
    return wo

async def handle_approval(wo_id: str, approved: bool, approver_id: str) -> dict:
    """处理飞书卡片回调（批准/驳回）"""
    wo = _workorders.get(wo_id)
    if not wo:
        raise ValueError(f"工单 {wo_id} 不存在")

    if approved:
        wo["state"] = "approved"           # pending_approval → approved
        wo["approved_by"] = approver_id
        wo["approved_at"] = datetime.datetime.utcnow().isoformat() + "Z"
        # Phase B: 调用 write_l3_knowledge(wo) 完工后沉淀 L3 知识
    else:
        wo["state"] = "rejected"           # pending_approval → rejected（可修改后重新提交）
        wo["rejected_by"] = approver_id

    return wo
```

---

## 七、Platform Scheduler（晨报 + 告警轮询）

```python
# platform-api/scheduler/jobs.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from scheduler.morning_briefing import run_morning_briefing
from scheduler.anomaly_poll import run_anomaly_poll

scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")

def start_scheduler():
    scheduler.add_job(
        run_morning_briefing,
        "cron", hour=7, minute=0,
        id="morning_briefing",
        replace_existing=True
    )
    scheduler.add_job(
        run_anomaly_poll,
        "cron", minute=0,  # 每小时
        id="anomaly_poll",
        replace_existing=True
    )
    scheduler.start()

# platform-api/scheduler/anomaly_poll.py
import os, random
from services.feishu import FeishuClient

STATION_ID = os.getenv("CLAWTWIN_STATION_ID", "S001")
EQUIPMENT_IDS = ["C-001", "SDV-001", "FT-001"]

async def run_anomaly_poll():
    """
    Phase A: 模拟 MOIRAI 异常检测
    Phase B: 替换为真实 MOIRAI 服务调用
    """
    for eq_id in EQUIPMENT_IDS:
        # Phase A: 10% 概率随机触发 WARNING（模拟）
        if random.random() < 0.10:
            alert = {
                "equipment_id": eq_id,
                "level": "P2",
                "message": f"[MOCK] {eq_id} 检测到异常趋势（Phase A 模拟）",
                "confidence": round(random.uniform(0.65, 0.85), 2),
                "citation": f"mock-moirai:{eq_id}"
            }
            await FeishuClient.send_alert(alert)
```

---

## 八、Feishu Bot 客户端（platform-api/services/feishu.py）

```python
# platform-api/services/feishu.py
# ⚠️ 此文件是早期草稿版本，已被 MODULE-DESIGN-PLATFORM.md §13.3 中的完整 FeishuClient 取代
# 环境变量键名已标准化：FEISHU_SERVER_URL / FEISHU_APP_ID / FEISHU_APP_SECRET
import os, httpx

# 私有化飞书：设置 FEISHU_SERVER_URL=http://feishu.company.com
# 公有云飞书：不设置，默认使用官方地址
_BASE     = os.getenv("FEISHU_SERVER_URL") or "https://open.feishu.cn"
FEISHU_API = f"{_BASE}/open-apis"   # 所有 API 调用自动适配公有/私有化

APP_ID     = os.getenv("FEISHU_APP_ID", "")
APP_SECRET = os.getenv("FEISHU_APP_SECRET", "")
DUTY_CHAT  = os.getenv("FEISHU_DUTY_CHAT_ID", "")

_token_cache: dict = {}

async def _get_token() -> str:
    """获取飞书 tenant_access_token（缓存 1 小时）"""
    import time
    if _token_cache.get("expires_at", 0) > time.time():
        return _token_cache["token"]
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{FEISHU_API}/auth/v3/tenant_access_token/internal",
                                 json={"app_id": APP_ID, "app_secret": APP_SECRET})
        data = resp.json()
        _token_cache["token"] = data["tenant_access_token"]
        _token_cache["expires_at"] = time.time() + data["expire"] - 60
    return _token_cache["token"]

class FeishuClient:

    @staticmethod
    async def send_alert(alert: dict):
        """发送 P1/P2/P3 告警消息卡片到值班群"""
        if not DUTY_CHAT:
            print(f"[MOCK Feishu Alert] {alert}")   # Dev 模式：只打印
            return
        level_emoji = {"P1": "🔴", "P2": "🟡", "P3": "🔵"}.get(alert["level"], "⚪")
        content = {
            "msg_type": "interactive",
            "card": {
                "elements": [
                    {"tag": "div", "text": {"content": (
                        f"{level_emoji} **[{alert['level']} 告警]** {alert['equipment_id']}\n"
                        f"{alert['message']}\n"
                        f"置信度：{alert.get('confidence', 'N/A')}\n"
                        f"来源：{alert.get('citation', 'N/A')}"
                    ), "tag": "lark_md"}},
                    {"tag": "action", "actions": [
                        {"tag": "button", "text": {"content": "✅ 确认处理", "tag": "plain_text"},
                         "type": "primary", "value": {"action": "ack", "eq_id": alert["equipment_id"]}},
                        {"tag": "button", "text": {"content": "📋 查看详情", "tag": "plain_text"},
                         "type": "default",
                         "url": f"http://studio.clawtwin.local/#/{alert['equipment_id']}"}
                    ]}
                ]
            }
        }
        token = await _get_token()
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{FEISHU_API}/im/v1/messages?receive_id_type=chat_id",
                headers={"Authorization": f"Bearer {token}"},
                json={"receive_id": DUTY_CHAT, **content}
            )

    @staticmethod
    async def send_workorder_approval_card(wo: dict):
        """发送工单草稿审批卡片"""
        if not DUTY_CHAT:
            print(f"[MOCK Feishu WorkOrder] {wo['id']}: {wo['symptom']}")
            return
        steps_text = "\n".join(f"  {i+1}. {s}" for i, s in enumerate(wo["suggested_steps"]))
        content = {
            "msg_type": "interactive",
            "card": {
                "elements": [
                    {"tag": "div", "text": {"content": (
                        f"📋 **工单草稿 {wo['id']}**（待审批，未提交）\n\n"
                        f"**设备**：{wo['equipment_id']}\n"
                        f"**现象**：{wo['symptom']}\n\n"
                        f"**建议步骤**：\n{steps_text}\n\n"
                        f"来源：{', '.join(wo.get('citations', []))}"
                    ), "tag": "lark_md"}},
                    {"tag": "action", "actions": [
                        {"tag": "button", "text": {"content": "✅ 批准", "tag": "plain_text"},
                         "type": "primary",
                         "value": {"action": "approve", "wo_id": wo["id"]}},
                        {"tag": "button", "text": {"content": "❌ 拒绝", "tag": "plain_text"},
                         "type": "danger",
                         "value": {"action": "reject", "wo_id": wo["id"]}}
                    ]}
                ]
            }
        }
        token = await _get_token()
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{FEISHU_API}/im/v1/messages?receive_id_type=chat_id",
                headers={"Authorization": f"Bearer {token}"},
                json={"receive_id": DUTY_CHAT, **content}
            )
```

---

## 九、Studio 路由扩展（maibot-ui/src/router.tsx）

在 `createBrowserRouter` 的路由数组中添加以下路由（不修改现有路由）：

```tsx
// 在 router.tsx 中新增（紧接在其他路由之后）

const TwinPage = lazy(() =>
  import("./pages/TwinPage").then((m) => ({ default: m.TwinPage }))
);

const CommandPage = lazy(() =>
  import("./pages/CommandPage").then((m) => ({ default: m.CommandPage }))
);

// 在 createBrowserRouter 的 routes 数组中添加：
{
  path: "/twin",
  element: (
    <RequireAuth>
      <Suspense fallback={<RouteFallback />}>
        <TwinPage />
      </Suspense>
    </RequireAuth>
  ),
  errorElement: <RouteErrorFallback />,
},
{
  path: "/command",
  element: (
    <Suspense fallback={<RouteFallback />}>
      <CommandPage />
    </Suspense>
  ),
  errorElement: <RouteErrorFallback />,
},
```

---

## 十、TwinPage 最小化实现（maibot-ui/src/pages/TwinPage.tsx）

```tsx
// src/pages/TwinPage.tsx
import { useState } from "react";
import { TwinSurface } from "../surfaces/TwinSurface";
import { EquipmentDetailPanel } from "../surfaces/EquipmentDetailPanel";

interface EquipmentState {
  equipment_id: string;
  name: string;
  status: "NORMAL" | "WARNING" | "ALARM" | "OFFLINE";
  current: Record<string, number>;
  thresholds: Record<string, { warn: number; alarm: number; unit: string }>;
  citations: string[];
}

export function TwinPage() {
  const [selected, setSelected] = useState<EquipmentState | null>(null);

  async function handleEquipmentClick(equipmentId: string) {
    const resp = await fetch(
      `${import.meta.env.VITE_PLATFORM_URL}/v1/objects/equipment/${equipmentId}`,
    );
    const data = await resp.json();
    setSelected(data);
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {/* 左：3D 场景 */}
      <div style={{ flex: 1 }}>
        <TwinSurface onEquipmentClick={handleEquipmentClick} />
      </div>

      {/* 右：设备详情面板（可收起） */}
      {selected && (
        <div style={{ width: 380, borderLeft: "1px solid #333", overflowY: "auto" }}>
          <EquipmentDetailPanel equipment={selected} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}
```

---

## 十一、TwinSurface 最小化实现（Babylon.js WebGPU）

```tsx
// src/surfaces/TwinSurface.tsx
import { useEffect, useRef } from "react";

interface Props {
  onEquipmentClick: (equipmentId: string) => void;
}

// Phase A：简单几何体占位，Phase B 替换为 glTF 模型
const EQUIPMENT_POSITIONS: Record<string, [number, number, number]> = {
  "C-001": [0, 0.5, 0],
  "SDV-001": [-3, 0.5, 2],
  "SDV-002": [3, 0.5, 2],
  "FT-001": [0, 0.5, 4],
  "PT-001": [0, 0.5, -3],
};

export function TwinSurface({ onEquipmentClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    (async () => {
      const {
        Engine,
        Scene,
        ArcRotateCamera,
        Vector3,
        HemisphericLight,
        MeshBuilder,
        StandardMaterial,
        Color3,
        ActionManager,
        ExecuteCodeAction,
      } = await import("@babylonjs/core");

      const engine = new Engine(canvasRef.current!, true, { adaptToDeviceRatio: true });
      const scene = new Scene(engine);

      // 相机
      const camera = new ArcRotateCamera(
        "cam",
        -Math.PI / 2,
        Math.PI / 3,
        15,
        Vector3.Zero(),
        scene,
      );
      camera.attachControl(canvasRef.current!, true);

      // 环境光
      new HemisphericLight("light", new Vector3(0, 1, 0), scene);

      // 地面
      const ground = MeshBuilder.CreateGround("ground", { width: 20, height: 20 }, scene);
      const groundMat = new StandardMaterial("groundMat", scene);
      groundMat.diffuseColor = new Color3(0.15, 0.15, 0.2);
      ground.material = groundMat;

      // 设备几何体
      for (const [equipId, pos] of Object.entries(EQUIPMENT_POSITIONS)) {
        const box = MeshBuilder.CreateBox(equipId, { size: 1.2 }, scene);
        box.position = new Vector3(...pos);

        const mat = new StandardMaterial(`mat-${equipId}`, scene);
        mat.diffuseColor = new Color3(0.2, 0.5, 0.8); // 蓝色
        box.material = mat;

        // 点击事件
        box.actionManager = new ActionManager(scene);
        box.actionManager.registerAction(
          new ExecuteCodeAction(ActionManager.OnPickTrigger, () => {
            onEquipmentClick(equipId);
          }),
        );
      }

      engine.runRenderLoop(() => scene.render());
      window.addEventListener("resize", () => engine.resize());

      return () => {
        engine.dispose();
        window.removeEventListener("resize", () => engine.resize());
      };
    })();
  }, [onEquipmentClick]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }}
    />
  );
}
```

---

## 十二、14 天任务分解

```
Week 1（基础设施 + Ontology API + 3D 原型）

Day 1：
  ✓ git clone platform repo（新建 clawtwin-platform/）
  ✓ docker-compose up postgres redis ditto
  ✓ 验证：psql -h localhost -U clawtwin
  ✓ FastAPI skeleton：pnpm install / pip install / uvicorn main:app --reload

Day 2：
  ✓ GET /health → {"status": "ok"}
  ✓ 创建 data/mock/station-S001.json（完整设备列表）
  ✓ GET /v1/objects/equipment/C-001 → Mock 返回含 status/citations

Day 3-4：
  ✓ GET /v1/objects/station/S001 → 场站对象（含 computed_status）
  ✓ GET /v1/objects/equipment/{id}/links → 上下游关系 mock
  ✓ 编写 pytest 基础测试（mock 数据格式正确）

Day 5：
  ✓ maibot-ui 安装 @babylonjs/core
  ✓ TwinSurface.tsx：几何体 + 点击事件
  ✓ TwinPage.tsx：左右布局
  ✓ 路由：/twin

Day 6-7：
  ✓ EquipmentDetailPanel.tsx：显示设备名称/状态/当前值/阈值
  ✓ 状态颜色：NORMAL=绿, WARNING=黄, ALARM=红
  ✓ 联调：点击 3D 设备 → 右侧面板出现 C-001 数据
  ✓ 本周产出：可以演示"点击设备看状态"

Week 2（OpenClaw Skills 接入 + 飞书 HITL）

Day 8：
  ✓ 安装 4 个 industrial Skills 到个人 OpenClaw
  ✓ 配置 CLAWTWIN_PLATFORM_URL
  ✓ 飞书问"C-001 状态？" → twin_read → 返回 mock 数据

Day 9：
  ✓ industrial-kb 测试：飞书问"压缩机振动超标怎么处理？"
  ✓ Phase A：返回 mock 知识（直接写在 kb_search mock response 里）

Day 10：
  ✓ POST /v1/tools/workorder/draft → 生成工单 JSON
  ✓ FeishuClient.send_workorder_approval_card（dev 模式：打印）
  ✓ 飞书问"C-001 建工单" → workorder_draft → 打印草稿

Day 11：
  ✓ APScheduler 启动（platform-api 内）
  ✓ anomaly_poll：10% 概率 mock 异常 → 打印告警
  ✓ 接入 Feishu Bot（填入真实 APP_ID/SECRET）
  ✓ 验证：飞书收到告警卡片

Day 12：
  ✓ POST /v1/hitl/workorder/callback（飞书卡片回调）
  ✓ 点击"批准" → 工单状态变 APPROVED
  ✓ 完整 HITL 流程端到端：draft → 飞书卡片 → 批准 → 状态更新

Day 13：
  ✓ 整合 demo 流程：
    1. 打开 Studio /twin → 3D 场站
    2. 点击 C-001 → 右侧面板（WARNING 状态）
    3. 飞书收到告警 → 回复"分析" → AI 推理 → 建工单
    4. 工单审批卡片 → 批准
  ✓ 录制 demo 视频 / 截图

Day 14：
  ✓ 修复 demo 流程中的 bug
  ✓ 更新 README 和启动文档
  ✓ 推送代码，准备 Phase B 规划
```

---

## 十三、.env.example

```bash
# clawtwin-platform/.env.example

# 运行模式
MOCK_MODE=true                     # true=mock数据, false=真实OPC-UA

# Platform API 鉴权
# Phase A：OpenClaw 调用时携带 X-OpenClaw-User-OpenId header（服务端查绑定表）
#          废弃全局共享 API Key 方案（安全漏洞：一旦泄露所有站数据裸奔）
# Phase B：JWT RS256（用户登录后签发，8小时有效期）
CLAWTWIN_OPENCLAW_SERVICE_TOKEN=oc-service-token-change-in-prod  # OpenClaw 实例注册令牌

# 飞书 Bot（Phase A 用单个 App 覆盖 AI 对话 + 系统通知）
# 私有化飞书：设置 FEISHU_SERVER_URL=http://feishu.company.com（内网地址）
# 公有云飞书：不填此项，默认使用 https://open.feishu.cn
FEISHU_SERVER_URL=
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_DUTY_CHAT_ID=               # 值班群 chat_id（在飞书群「群机器人」里查）
FEISHU_VERIFY_TOKEN=               # 飞书回调验证 Token（开放平台配置）【生产必须配置，否则 webhook 裸奔】
FEISHU_ENCRYPT_KEY=                # 飞书回调加密 Key（生产必须开启，防止内容被截获）

# 飞书 Webhook 回调地址（供飞书服务器回调）
# 公有云飞书开发阶段：用 ngrok（ngrok http 8080），填入 ngrok URL
# 私有化飞书：填写 Platform 内网地址即可（全程内网，不需要 ngrok）
FEISHU_WEBHOOK_URL=http://localhost:8080/v1/feishu/webhook

# OpenClaw Skill 配置中填写的 Platform 地址（Skills 通过此地址调用 Tool API）
# 已废弃 CLAWTWIN_API_KEY（全局共享 Key 是安全漏洞，见 ADR-6）
# 改为：OpenClaw 实例注册令牌 + 飞书 open_id 双重验证
CLAWTWIN_PLATFORM_URL=http://platform-api:8080

# GPU 服务器 vLLM（Phase A 可为空，告警文本由 Platform 生成）
VLLM_BASE_URL=http://gpu-server:8000

# Studio
VITE_PLATFORM_URL=http://localhost:8080

# 场站配置
CLAWTWIN_STATION_ID=S001
```

---

## 十四、飞书 Webhook 接收端（补充实现）

**此文件是 Phase A 的必须项，缺少则 HITL 工单审批无法闭环。**

```python
# platform-api/routers/feishu_webhook.py

from fastapi import APIRouter, Request
import os, logging

router = APIRouter()
logger = logging.getLogger(__name__)

FEISHU_VERIFY_TOKEN = os.getenv("FEISHU_VERIFY_TOKEN", "")

@router.post("/v1/feishu/webhook")
async def feishu_webhook(request: Request):
    """
    接收飞书事件回调（飞书开放平台配置的回调地址）

    两类事件：
    1. URL 验证（飞书首次配置时发 challenge，必须原样返回）
    2. 卡片按钮点击（工单审批 / 告警确认）
    """
    body = await request.json()

    # 1. URL 验证（配置 Webhook 时飞书会发这个）
    if "challenge" in body:
        logger.info("Feishu webhook URL validation challenge received")
        return {"challenge": body["challenge"]}

    # 2. 解析事件类型
    event_type = body.get("type", "")
    logger.info(f"Feishu webhook event: {event_type}")

    # 3. 卡片按钮点击事件（工单审批/告警确认）
    if event_type == "card.action.trigger":
        action_value = body.get("action", {}).get("value", {})
        action_type  = action_value.get("action")   # "approve" / "reject" / "ack"
        wo_id        = action_value.get("wo_id")
        eq_id        = action_value.get("eq_id")
        open_id      = body.get("operator", {}).get("open_id", "unknown")

        logger.info(f"Card action: {action_type}, wo_id={wo_id}, eq_id={eq_id}, by={open_id}")

        if action_type == "approve" and wo_id:
            from hitl.workorder_fsm import handle_approval
            ok = await handle_approval(wo_id, approved=True, approver_id=open_id)
            if ok:
                return {"toast": {"type": "success", "content": f"工单 {wo_id} 已批准，执行人员已通知"}}
            return {"toast": {"type": "error", "content": "工单状态异常，请刷新后重试"}}

        elif action_type == "reject" and wo_id:
            from hitl.workorder_fsm import handle_approval
            await handle_approval(wo_id, approved=False, approver_id=open_id)
            return {"toast": {"type": "info", "content": "已拒绝，草稿已关闭"}}

        elif action_type == "ack" and eq_id:
            # 告警确认（记录谁确认了，写 L3 memory）
            logger.info(f"Alarm acknowledged: {eq_id} by {open_id}")
            return {"toast": {"type": "success", "content": f"{eq_id} 告警已确认"}}

    return {"status": "ok"}
```

在 `main.py` 中注册这个路由：

```python
# platform-api/main.py（添加）
from routers.feishu_webhook import router as feishu_webhook_router
app.include_router(feishu_webhook_router)
```

**飞书开放平台配置步骤：**

```
1. 登录 open.feishu.cn → 创建 App（ClawTwin-Platform）
2. 应用功能 → 机器人 → 启用
3. 权限管理 → 开通：im:message:send_as_bot, im:chat:readonly
4. 事件订阅 → 添加事件：卡片回调（card.action.trigger）
5. 事件订阅 → 请求地址：https://your-ngrok-url.ngrok.io/v1/feishu/webhook
6. 保存 → 飞书会发一个 challenge POST 到这个地址
7. 如果返回 {"challenge": "..."} → 配置成功
8. 复制 Verify Token 和 Encrypt Key 填入 .env
9. 发布应用（审核或企业自建直接生效）
```

---

## 十五、Studio 复制与改造步骤（完整）

```bash
# 在新的 clawtwin-platform 项目里执行：

cd ~/Projects/clawtwin-platform

# 复制 maibot-ui 为 clawtwin-studio
cp -r ~/Projects/archive/maibot-ui ./clawtwin-studio

# 修改包名
cd clawtwin-studio
# 编辑 package.json: "name": "maibot-ui" → "@clawtwin/studio"

# 清理无关页面（这些是 openclaw 企业功能，工业版不需要）
rm src/pages/ExpertMarketPage.tsx \
   src/pages/MarketplacePage.tsx \
   src/pages/BillingPage.tsx \
   src/pages/EmployeeListPage.tsx \
   src/pages/EmployeeProfilePage.tsx \
   src/pages/EmployeeAutopilotNarrowPage.tsx

# 添加环境变量
cat >> .env.example << 'EOF'
VITE_PLATFORM_URL=http://localhost:8080
VITE_STATION_ID=S001
EOF

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

在 `src/router.tsx` 中添加工业路由：

```tsx
// 在现有路由基础上添加（不删除任何现有路由）
import { lazy } from "react";

const TwinPage    = lazy(() => import("./pages/TwinPage"));
const CommandPage = lazy(() => import("./pages/CommandPage"));
const KnowledgeAdminPage = lazy(() => import("./pages/admin/KnowledgeAdminPage"));

// 在 <Routes> 里添加：
<Route path="/twin"    element={<TwinPage />} />
<Route path="/command" element={<CommandPage />} />
<Route path="/admin/knowledge" element={<KnowledgeAdminPage />} />
```

**关键原则：保持 AI 对话核心不变**

```
Studio 的核心价值来自 maibot-ui 已有的：
  packages/adapter/   ← OpenClaw Gateway WebSocket 接入
  packages/store/     ← 状态管理（含 gatewayUrl）
  src/shell/          ← 三栏布局 + AI 对话面板

这些不需要改，直接复用。
工业页面（/twin, /command）只是添加在 router 里的新路由。
用户在 Studio 右侧面板里的 AI 对话 = 连接用户自己的 OpenClaw。
OpenClaw 装了 industrial-* Skills → AI 回答工业问题 + 调 Platform API。
```

---

## 附录：nginx/nginx.conf（Nginx 反向代理配置）

```nginx
# clawtwin-platform/nginx/nginx.conf
# 部署结构：
#   80  /        → Studio 静态文件（clawtwin-studio/dist）
#   80  /v1/     → platform-api:8080（反向代理）
#   80  /ws/     → openclaw:3000（WebSocket，AI 对话）

server {
    listen 80;
    server_name _;

    # Studio 静态文件（React SPA）
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback（所有非文件请求都返回 index.html，让 React Router 处理）
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Platform API 反向代理
    location /v1/ {
        proxy_pass         http://platform-api:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;

        # Feishu Webhook 需要原始请求体（Signature 验证）
        proxy_request_buffering off;
    }

    # OpenClaw WebSocket（AI 对话实时通道）
    location /ws/ {
        proxy_pass             http://openclaw:3000;
        proxy_http_version     1.1;
        proxy_set_header       Upgrade $http_upgrade;
        proxy_set_header       Connection "upgrade";
        proxy_set_header       Host $host;
        proxy_read_timeout     3600s;    # WebSocket 长连接
    }

    # 安全头
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # 静态资源缓存（JS/CSS hash 命名，可长期缓存）
    location ~* \.(js|css|woff2|png|jpg|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## 附录：Studio 构建与部署流程

```bash
# 1. 构建 Studio（每次发版前执行）
cd clawtwin-studio
pnpm install
pnpm build              # 输出到 dist/（供 nginx 挂载）

# 2. 启动所有服务（Phase A 默认配置，mock 模式）
cd ..   # 回到 clawtwin-platform/
docker compose up -d

# 3. 开发时（热更新，不经过 nginx）
cd clawtwin-studio
pnpm dev               # Vite dev server 在 :5173，/v1/* 代理到 :8080

# 注意：pnpm dev 启动的 Studio 直接代理 Platform API，
#       不经过 nginx，适合前端调试；生产/集成测试用 docker compose。
```
