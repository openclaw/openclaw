# 工业 AI 数字孪生平台 · 最终一次性架构

**版本**：1.0 FINAL · 2026-05-08  
**原则**：架构决定一次，分阶段是「接数据 + 激活功能」，不是「换技术栈」  
**适用**：Phase 1 到 Phase 3 用同一套代码和服务，只改配置和数据量

---

## 一、为什么一步到位是正确的

### 1.1 「先简化后迁移」的真实代价

```
典型错误路径：
  Phase 1：pgvector → Phase 2：迁 Milvus → 重写索引代码 + 数据迁移
  Phase 1：Three.js → Phase 2：迁 Babylon.js → 全部渲染代码重写
  Phase 1：无 Ditto → Phase 2：加 Ditto → 数据模型重构
  Phase 1：无 Kafka → Phase 2：加 Kafka → 数据管道全部重建

每次「后面再改」都是：重写代码 + 数据迁移 + 重新测试 + 客户业务中断
通常代价 = 原始开发量的 50–100%
```

### 1.2 一步到位的正确理解

```
一步到位 ≠ Phase 1 就要有 100 个场站的数据
一步到位 = 架构代码只写一次，数据和集成逐步接入

Phase 1 与 Phase 3 的区别不在于技术栈，而在于：
  · 接了多少个 OPC UA 数据源（0 个 mock → N 个真实）
  · 索引了多少文档（50 份 → 5000 份）
  · 接入了多少场站（1 个 → N 个）
  · 激活了哪些 AI 功能（基础问答 → 预测维护 → 领域微调）
```

### 1.3 哪些东西真的需要「分阶段」

真正无法跳过的阶段性约束只有两个：

```
① 数据积累（客观时间）：
  领域模型微调需要 ≥ 50,000 条标注数据
  → 必须等 12–18 个月客户数据积累
  → 代码架构可以 Day 1 就写好训练 pipeline，数据到了就跑

② 客户侧基础设施（客观条件）：
  真实 OPC UA 需要客户现场 OPC UA 服务器
  → 架构 Day 1 就部署 Ditto + Kafka
  → Phase 1 用 mock OPC UA 生产者，Phase 2 换成真实 UA 桥接
  → Ditto 侧代码零变化
```

---

## 二、最终架构定义（一次决定，永不更换）

### 2.1 服务层（11 个 Docker 服务，一次性部署）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Docker Compose 部署清单                              │
├──────┬──────────────────────┬────────────────────────┬──────────────────┤
│  #   │  服务                │  镜像                  │  职责            │
├──────┼──────────────────────┼────────────────────────┼──────────────────┤
│  1   │  openclaw-gateway    │  openclaw/openclaw     │  LLM 网关 + Cron │
│  2   │  qwen36-vllm         │  vllm/vllm-openai      │  LLM 推理（GPU） │
│  3   │  milvus-standalone   │  milvusdb/milvus       │  向量检索         │
│  4   │  etcd                │  bitnami/etcd          │  Milvus 元数据   │
│  5   │  minio               │  minio/minio           │  文档+模型存储    │
│  6   │  postgres            │  timescale/timescaledb │  关系+时序数据    │
│  7   │  ditto               │  eclipse/ditto         │  数字孪生运行时   │
│  8   │  kafka               │  bitnami/kafka         │  数据总线         │
│  9   │  moirai-service      │  自构建（Python）       │  时序异常检测     │
│  10  │  graphrag-service    │  自构建（Python）       │  知识图谱提取     │
│  11  │  web-app             │  自构建（Node+Nginx）   │  Babylon.js 3D   │
└──────┴──────────────────────┴────────────────────────┴──────────────────┘

总 VRAM：Qwen3.6-35B-A3B INT4 = 约 20G → 1×H100 80G（有余量）
总 RAM：约 24G（数据库 + 服务）→ 32G 服务器够用
总存储：SSD 2T（模型 20G + 数据库 100G + 文档 500G + 余量）
```

### 2.2 数据流架构（一次写定）

```
                    ┌──────────────────────────────────────┐
                    │  数据感知层                            │
                    │  Phase 1: mock OPC UA producer        │
                    │  Phase 2: 真实 asyncua OPC UA 桥接    │
                    │  Phase 3: 多场站 OPC UA 集群          │
                    └──────────────────┬───────────────────┘
                                       │ Kafka Topic: sensors.raw
                    ┌──────────────────▼───────────────────┐
                    │  Apache Kafka（消息总线）              │
                    │  同一 Kafka，Phase 1 mock，Phase 2 真实│
                    └───────┬──────────────────┬────────────┘
                            │                  │
               ┌────────────▼──────┐  ┌────────▼──────────┐
               │  Eclipse Ditto    │  │  MOIRAI 2.0 Service│
               │  Thing = 设备     │  │  实时异常检测       │
               │  Phase 1: mock    │  │  → 触发 OpenClaw   │
               │  Phase 2: 真实    │  └────────────────────┘
               └────────────┬──────┘
                            │ REST API（只读）
                    ┌───────▼──────────────────────────────┐
                    │  OpenClaw Gateway                     │
                    │  工具：asset_read / kb_search /        │
                    │       twin_read / wo_draft            │
                    │  Cron：06:00 晨报 / 告警触发           │
                    │  TaskFlow：工单 HITL 审批流            │
                    └───────┬──────────────────────────────┘
                            │
               ┌────────────┴───────────────────┐
               │                                │
    ┌──────────▼──────────┐       ┌─────────────▼──────┐
    │  Milvus（向量）      │       │  GraphRAG Service   │
    │  Phase 1: 50 文档    │       │  Phase 1: 5 手册    │
    │  Phase 2: 5000 文档  │       │  Phase 2: 100 文档  │
    └─────────────────────┘       └────────────────────┘
               │
    ┌──────────▼──────────┐
    │  PostgreSQL          │
    │  + TimescaleDB       │
    │  工单记录 / 用户 /    │
    │  设备台账 / 时序归档  │
    └─────────────────────┘
```

### 2.3 3D 渲染层（全部 Babylon.js 8，一次决定）

```
不存在「先 Three.js 后 Babylon.js」的迁移
所有 3D 界面统一 Babylon.js 8 WebGPU：

┌─────────────────────────────────────────────────────────┐
│  界面 A · PC 控制台（Studio）                            │
│  Babylon.js 8 + WebGPU + OpenPBR                       │
│  Phase 1: 30 台设备，程序化几何，无 HDRI                │
│  Phase 2: PBR 材质 + HDRI 环境 + 后处理                 │
│  Phase 3: OPC UA 实时数据驱动颜色/状态叠加              │
├─────────────────────────────────────────────────────────┤
│  界面 B · 指挥大屏（Command）                            │
│  Babylon.js 8 + WebGPU + HDRI + OpenPBR + SSAO         │
│  Phase 1: 同 Studio，全屏布局（先交付给客户展示）         │
│  Phase 2: 粒子流动 + 热场 + 完整 PBR                    │
├─────────────────────────────────────────────────────────┤
│  界面 C · 飞书 3D 卡片预览（轻量）                       │
│  Babylon.js WebGL fallback（兼容移动端）                 │
│  仅展示单台设备的 3D 几何 + 状态标注                     │
└─────────────────────────────────────────────────────────┘

资产加载顺序（LOD 分级，同一代码）：
  LOD 0（加载前）：盒子占位符（立即显示）
  LOD 1（首帧）：程序化几何，无材质
  LOD 2（2 秒）：PBR 材质 + 法线贴图
  LOD 3（选中时）：螺栓级细节 + SSAO
```

---

## 三、分阶段激活矩阵（架构不变，配置变）

```
┌──────────────────────────┬─────────────────┬─────────────────┬──────────────────┐
│  功能                    │  Phase 1（MVP）  │  Phase 2（产品） │  Phase 3（智能化）│
│                          │  12 周，1 客户   │  16 周，3 客户  │  12 个月+，10 客户│
├──────────────────────────┼─────────────────┼─────────────────┼──────────────────┤
│  Qwen3.6-35B-A3B 部署    │  ✅              │  ✅              │  ✅ + LoRA 微调   │
│  Milvus 部署             │  ✅（50 文档）   │  ✅（5000 文档） │  ✅（50000 文档） │
│  Ditto 部署              │  ✅（mock 数据） │  ✅（真实 1 站）  │  ✅（真实 N 站）  │
│  Kafka 部署              │  ✅（mock 生产）  │  ✅（OPC UA 桥） │  ✅（多站桥接）   │
│  GraphRAG 部署           │  ✅（5 手册索引）│  ✅（跨文档推理）│  ✅（全知识库）   │
│  Babylon.js 3D           │  ✅（程序化几何）│  ✅（PBR + HDRI）│  ✅（流动+热场）  │
│  OpenClaw Cron 晨报      │  ✅              │  ✅              │  ✅               │
│  TaskFlow 工单 HITL      │  ✅              │  ✅              │  ✅               │
│  MOIRAI 2.0 异常检测     │  ✅（mock 数据） │  ✅（真实传感器）│  ✅               │
│  P&ID OCR 解析           │  手动 + OCR 辅助│  ✅（全自动）    │  ✅               │
│  多租户                  │  ❌（单站）      │  ✅              │  ✅               │
│  SAP PM / CMMS 集成      │  ❌              │  ✅（1 系统）    │  ✅（多系统）     │
│  领域模型微调             │  ❌              │  ❌              │  ✅（50K 数据后） │
│  AR 现场引导             │  ❌              │  ❌              │  ✅               │
└──────────────────────────┴─────────────────┴─────────────────┴──────────────────┘
```

---

## 四、mock OPC UA → 真实 OPC UA：代码零变化

这是「一步到位」设计最优雅的地方——**Ditto 和后端代码完全不感知数据来源**：

```python
# Phase 1：mock 数据生产者（一个 Python 脚本）
# 向 Kafka 推送模拟传感器数据

import time, random, json
from kafka import KafkaProducer

producer = KafkaProducer(bootstrap_servers='kafka:9092')
while True:
    msg = {
        "thingId": "station-szp-a:SDV-001",
        "features": {
            "pressure": {"properties": {"value": 6.8 + random.gauss(0, 0.1)}},
            "temperature": {"properties": {"value": 45.2 + random.gauss(0, 0.5)}}
        }
    }
    producer.send('ditto.inbound', json.dumps(msg).encode())
    time.sleep(5)

# Phase 2：替换上面的 Python 脚本为 OPC UA 桥接器
# asyncua → Kafka，完全相同的 Kafka topic 和消息格式
# Ditto 接收到的数据格式完全一致 → 后端零变化
```

```
切换步骤（Phase 1 → Phase 2）：
  1. 停止 mock 生产者容器
  2. 启动 opc-ua-bridge 容器（asyncua + Kafka producer）
  3. 配置 OPC UA server 地址（一行 env 变量）
  4. 完成

Ditto、OpenClaw 工具、前端 3D——全部零改动
```

---

## 五、为什么 GraphRAG 优于 Jena Fuseki（一次决定）

```
Jena Fuseki（SPARQL 图数据库）的问题：
  · 需要手工用 OWL/Turtle 语言编写本体（需要专家）
  · 每次新增设备类型都要更新本体定义（维护成本高）
  · SPARQL 查询语言陡峭学习曲线
  · Java 生态，内存重

Microsoft GraphRAG v3.0.9（MIT，2026-04-13 更新）：
  · 输入：任何文本文档（PDF/Word/Markdown）
  · 处理：Qwen3.6 自动提取实体 + 关系 → 知识图谱
  · 查询：自然语言直接查（无需 SPARQL）
  · 多粒度：局部查询（单文档）+ 全局查询（跨文档主题）

工业场景对比：

  传统（Jena）：
    「SDV-001 的维修规程是什么？」
    → 手工维护 OWL 本体 → SPARQL 查询 → 拼接回答

  GraphRAG：
    「SDV-001 的维修规程是什么？」
    → 自动从 10 份手册提取知识图谱
    → 自然语言查询
    → 回答 + citations（跨手册综合）

决定：使用 GraphRAG，完全不引入 Jena Fuseki
仍然保留：OWL 本体概念（在 station-data.json 中以 JSON 表示），
          但不运行 SPARQL 服务器
```

---

## 六、一次性 Docker Compose 完整清单

```yaml
# docker-compose.yml（Phase 1 到 Phase 3 同一份文件，靠 profile 控制）

version: "3.9"

services:
  # ── AI 推理 ──────────────────────────────────────────────────────
  vllm:
    image: vllm/vllm-openai:latest
    runtime: nvidia
    environment:
      - MODEL=Qwen/Qwen3.6-35B-A3B
      - QUANTIZATION=awq_marlin
      - MAX_MODEL_LEN=32768
    volumes:
      - model-cache:/root/.cache/huggingface
    ports: ["8000:8000"]

  openclaw:
    image: openclaw/openclaw:latest
    environment:
      - OPENCLAW_MODEL_URL=http://vllm:8000/v1
      - OPENCLAW_MODEL_ID=Qwen/Qwen3.6-35B-A3B
    volumes:
      - ./openclaw-config:/config
      - ./skills:/skills
    ports: ["3000:3000"]

  # ── 向量知识库 ───────────────────────────────────────────────────
  etcd:
    image: bitnami/etcd:latest
    environment: [ALLOW_NONE_AUTHENTICATION=yes]

  milvus:
    image: milvusdb/milvus:v2.5-latest
    environment:
      - ETCD_ENDPOINTS=etcd:2379
      - MINIO_ADDRESS=minio:9000
    ports: ["19530:19530"]
    depends_on: [etcd, minio]

  # ── 存储 ─────────────────────────────────────────────────────────
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    volumes:
      - minio-data:/data
    ports: ["9000:9000"]

  postgres:
    image: timescale/timescaledb:latest-pg16
    environment:
      - POSTGRES_PASSWORD=industrial
      - POSTGRES_DB=claw_twin
    volumes:
      - pg-data:/var/lib/postgresql/data
    ports: ["5432:5432"]

  # ── 数字孪生 ─────────────────────────────────────────────────────
  kafka:
    image: bitnami/kafka:latest
    environment:
      - KAFKA_CFG_PROCESS_ROLES=broker,controller
      - KAFKA_CFG_NODE_ID=1
      - KAFKA_CFG_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093
      - KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=1@kafka:9093
    ports: ["9092:9092"]

  ditto:
    image: eclipse/ditto:latest
    environment:
      - KAFKA_BOOTSTRAP_SERVERS=kafka:9092
    ports: ["8080:8080"]
    depends_on: [kafka]

  # Phase 1 使用 mock 生产者（profiles: [mock]）
  mock-opc-producer:
    build: ./services/mock-opc-producer
    environment:
      - KAFKA_BOOTSTRAP=kafka:9092
      - STATION_DATA=/data/station-data.json
    volumes:
      - ./data:/data
    profiles: [mock] # ← Phase 1 启用

  # Phase 2 替换为真实 OPC UA 桥（profiles: [production]）
  opc-ua-bridge:
    build: ./services/opc-ua-bridge
    environment:
      - OPC_UA_SERVER_URL=${OPC_UA_SERVER_URL}
      - KAFKA_BOOTSTRAP=kafka:9092
    profiles: [production] # ← Phase 2 启用

  # ── AI 服务 ─────────────────────────────────────────────────────
  moirai-service:
    build: ./services/moirai
    environment:
      - KAFKA_BOOTSTRAP=kafka:9092
      - OPENCLAW_WEBHOOK=http://openclaw:3000/webhook/anomaly
    ports: ["8090:8090"]

  graphrag-service:
    build: ./services/graphrag
    environment:
      - MILVUS_HOST=milvus:19530
      - LLM_URL=http://vllm:8000/v1
      - LLM_MODEL=Qwen/Qwen3.6-35B-A3B
      - MINIO_ENDPOINT=minio:9000
    ports: ["8091:8091"]

  # ── 前端 ─────────────────────────────────────────────────────────
  web-app:
    build: ./apps/web
    environment:
      - OPENCLAW_API=http://openclaw:3000
      - DITTO_API=http://ditto:8080
    ports: ["80:80"]

volumes:
  model-cache:
  minio-data:
  pg-data:
```

**Phase 1 启动命令**：

```bash
docker compose --profile mock up -d
```

**Phase 2 切换命令**（停 mock，启 OPC UA 桥，零代码变更）：

```bash
docker compose --profile mock down mock-opc-producer
OPC_UA_SERVER_URL=opc.tcp://client-server:4840 \
  docker compose --profile production up -d opc-ua-bridge
```

---

## 七、Babylon.js 8 一次性工程设计

```
目录结构（一次性搭好，分阶段填充资产）：

apps/web/
├── src/
│   ├── engine/
│   │   ├── scene.ts          ← Babylon.js 8 场景初始化（WebGPU + fallback WebGL）
│   │   ├── materials/        ← OpenPBR 材质库（Phase 1: 基础金属; Phase 2: 全套 PBR）
│   │   ├── lighting/         ← HDRI 加载器（Phase 1: 默认灯光; Phase 2: polyhaven HDRI）
│   │   ├── postprocess/      ← SSAO + Bloom + ToneMapping（Phase 1: 关闭; Phase 2: 开启）
│   │   └── equipment/        ← 参数化设备几何（阀门/管道/仪表，程序化生成）
│   ├── twin/
│   │   ├── state-sync.ts     ← Ditto REST API → 3D 颜色/动画同步
│   │   └── lod-manager.ts    ← LOD 0-3 管理（距离/选中触发）
│   ├── ui/
│   │   ├── studio.tsx        ← PC 控制台布局（AI 对话 + 3D + 面板）
│   │   └── command.tsx       ← 指挥大屏布局（全屏 3D + KPI + 告警）
│   └── api/
│       └── openclaw.ts       ← OpenClaw API 封装
│
└── public/
    └── assets/
        ├── hdri/             ← polyhaven HDRI（Phase 2 加入）
        ├── textures/         ← ambientCG PBR 材质（Phase 2 加入）
        └── models/           ← glTF 模型（按需增加）

Phase 1 激活：程序化几何 + 默认光照 + WebGPU 引擎就绪
Phase 2 激活：--profile hdri → 加载 HDRI；--profile pbr → 加载 PBR 材质；--profile postfx → 开启后处理
Phase 3 激活：流体粒子 + 热场 + 变形动画（Ditto 数据驱动）
```

---

## 八、最终判断

```
问：为什么要先用一种方案，后面再改方案？
答：不应该。这是错误的。

正确做法：
  · 架构选型（技术栈）：一次决定，永不迁移
  · 数据接入：Phase 1 用 mock，Phase 2 接真实，架构零变化
  · 功能激活：Phase 1 关闭 PBR/HDRI，Phase 2 开启，代码零变化
  · 规模扩展：Phase 1 单租户，Phase 2 多租户，表结构 Day 1 就设计好

需要「分阶段」的只有：
  · 时间（数据积累 → 才能微调）
  · 客户条件（有 OPC UA 服务器 → 才能接真实数据）
  · 资金（更多服务器 → 才能多站并发）

这些都是客观约束，与技术栈选择无关。
```

---

_依据：OpenClaw src/cron/ + TaskFlow SKILL.md · Babylon.js 8 WebGPU PBR 2025-10 合并 · GraphRAG v3.0.9 2026-04 · MOIRAI 2.0 2025-08_
