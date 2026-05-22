# 开发快速启动指南（Developer Quickstart）

**版本**：1.6 · 2026-05-13（§三 **Phase A full** 仅 PR→`main`/`master`）  
**目标**：让新成员在 30 分钟内启动完整的本地开发环境

---

## 〇、多仓布局与命令 cwd（先于 §三、§四）

Phase A **可运行代码** 在独立仓，不在 `openclaw` 源码树内的 `platform/` 路径。

| 用途                          | 目录                                             | 说明                                                                                                                                                                                     |
| :---------------------------- | :----------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nexus / Platform API          | **`clawtwin-platform/platform-api/`**            | **`pytest`、Alembic、`uvicorn` 的 cwd 必须在此**（勿在 `openclaw` 根目录跑，见 **`TESTING-GUIDE.md` §二.0**、**`PHASE-A-PROGRESS-AUDIT.md` §8**、**`CURSOR-MULTITASK-GUIDE.md` [T18]**） |
| Studio（Refine）              | **`clawtwin-studio/refine-clawtwin/`**           | `pnpm install` / `pnpm dev` / `pnpm build`；详见该目录 **`README.md`**                                                                                                                   |
| 设计 / Skills / 本 Quickstart | **`openclaw/contrib/industrial-oilgas-skills/`** | 文档权威：`DESIGN-FINAL-LOCK.md`、`DEVELOPMENT-CONTRACT.md`、`clawtwin-project/SKILL.md`                                                                                                 |

**Platform 启动与单测**以 **`clawtwin-platform/platform-api/README.md`** 为唯一执行权威（含 `CLAWTWIN_*`、dev login、smoke curl）。

---

## 一、前置条件

```bash
# 检查环境
node --version    # ≥ 22.0
python --version  # ≥ 3.11
docker --version  # ≥ 24.0
pnpm --version    # ≥ 8.0

# 硬件建议（最低可运行，无 AI 推理）
RAM: ≥ 16GB
Disk: ≥ 50GB

# AI 推理需要独立 GPU Server（见 §五）
```

---

## 二、基础设施启动（Docker Compose）

> **注意**：本节为**历史单仓**示例，包含 Kafka、Milvus、AGE 等。**Phase A 精简栈**（PostgreSQL + Redis + 外置 OpenClaw/vLLM）以 **`ARCHITECTURE-SIMPLIFICATION-AUDIT.md`** 与 **`platform-api`** 仓内 Compose/README 为准；多数本地开发可只起 **PostgreSQL**（+ 可选 Redis）后直接进入 **§三**。

```bash
# 克隆仓库
git clone https://github.com/your-org/clawtwin
cd clawtwin

# 一键启动所有基础设施（数据库、缓存、消息队列、向量库）
docker compose -f infra/docker-compose.dev.yml up -d

# 启动的服务：
#  postgres:5432   - PostgreSQL 16 (TimescaleDB + pgvector + AGE)
#  redis:6379      - Redis 7（缓存 + 队列）
#  kafka:9092      - Kafka（事件总线）
#  minio:9000      - MinIO（对象存储）
#  milvus:19530    - Milvus（向量数据库）
#  grafana:3000    - Grafana（监控面板，可选）

# 验证（等待约 30 秒）
docker compose -f infra/docker-compose.dev.yml ps
```

### infra/docker-compose.dev.yml

```yaml
version: "3.9"
services:
  postgres:
    image: timescale/timescaledb-ha:pg16-latest
    environment:
      POSTGRES_DB: clawtwin
      POSTGRES_USER: clawtwin
      POSTGRES_PASSWORD: dev123
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/init-pg-extensions.sql:/docker-entrypoint-initdb.d/01-ext.sql

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      CLUSTER_ID: "MkU3OEVBNTcwNTJENDM2Qk"
    ports: ["9092:9092"]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports: ["9000:9000", "9001:9001"]
    volumes:
      - miniodata:/data

  milvus:
    image: milvusdb/milvus:v2.4.0
    command: milvus run standalone
    environment:
      ETCD_ENDPOINTS: ""
      MINIO_ADDRESS: minio:9000
    ports: ["19530:19530"]
    depends_on: [minio]

volumes:
  pgdata:
  miniodata:
```

### infra/init-pg-extensions.sql

```sql
-- 在 Docker 初始化时自动执行
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
CREATE SCHEMA IF NOT EXISTS ag_catalog;
```

---

## 三、Platform（后端）启动

**权威步骤**见 **`clawtwin-platform/platform-api/README.md` § Run (dev) / Tests**。下列为最小摘录（cwd = **`platform-api/`**）：

```bash
cd clawtwin-platform/platform-api   # 以你本机克隆路径为准

python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# 本地 smoke（可选）：见 README「Smoke」— CLAWTWIN_AUTH_DEV、/v1/health 等

.venv/bin/uvicorn apps.http.main:app --reload --host 127.0.0.1 --port 8000
```

```bash
# 单测（必须在 platform-api 目录）
.venv/bin/pytest
```

```bash
# Phase B（M2→M3）合并门禁：M2 连接器/CMMS + M3 飞轮/CBR/KB 等 pytest 子集
# 对齐 CLAWTWIN-MILESTONE-PLAN.md「M2 启动清单」第 6–7 步；需 uv：`uv run …` 同 README
./scripts/phase_b_acceptance.sh
# 首次或缺 Modbus 可选依赖：./scripts/phase_b_acceptance.sh --full
```

**GitHub Actions（多仓 `clawtwin-platform`）**：`platform-api` 变更在 **PR / push** 上会跑 **Phase B** 与（在 **PR 目标为 `main`/`master`** 时）**Phase A `--full`**。详见 **`clawtwin-platform/.github/workflows/README.md`**；根 **`README.md` » CI**。

```bash
curl -s http://127.0.0.1:8000/v1/health
```

以下 **`.env` 示例块** 与 **`seed_dev_data.py`** 为早期 **单仓 `platform/`** 模板，**变量名与现用 `CLAWTWIN_*` 可能不一致**；环境门控以 **`platform-api/README.md`「Auth environment」表** 为准，勿照抄旧块到生产。

### （历史参考）platform/.env.example

```bash
# 数据库
DATABASE_URL=postgresql+asyncpg://clawtwin:dev123@localhost:5432/clawtwin
REDIS_URL=redis://localhost:6379/0

# 安全
JWT_SECRET=dev-secret-do-not-use-in-production-please-change

# Kafka
KAFKA_BOOTSTRAP_SERVERS=localhost:9092

# MinIO
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=clawtwin-dev

# Milvus
MILVUS_HOST=localhost
MILVUS_PORT=19530
MILVUS_COLLECTION=clawtwin_kb_dev

# AI 推理（Phase A 用模拟模式，不需要真实 GPU）
AGENT_RUNTIME=mock            # mock | openclaw | hiagent | dify | none
AI_MOCK_ENABLED=true          # 设为 true 时 AI 任务立即返回模拟结果

# 飞书（可选，不配置则飞书功能不可用）
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
# 交互式审批卡片按钮回调：须与 ``infra/feishu_card.py`` 的 HMAC 签名一致（生产必填）
CLAWTWIN_FEISHU_CARD_SECRET=
# 飞书开放平台「事件订阅」请求网址（可访问的 Platform 公网基址 + 路径）：
#   {CLAWTWIN_PUBLIC_BASE_URL}/v1/feishu/events
# 卡片内「批准/拒绝」会向该 URL POST ``card.action.trigger``；内网开发需 ngrok/Cloudflare Tunnel。
CLAWTWIN_PUBLIC_BASE_URL=http://127.0.0.1:8000
```

### （历史参考）platform/scripts/seed_dev_data.py

```python
#!/usr/bin/env python3
"""创建开发环境种子数据"""
import asyncio
from auth.password import hash_password
from db.session import get_async_session
from models.user import User
from models.station import Station
from models.equipment import Equipment, EquipmentType

async def seed():
    async with get_async_session() as db:
        # 创建默认管理员
        admin = User(
            username="admin",
            email="admin@clawtwin.dev",
            hashed_password=hash_password("Admin@1234"),
            role="sys_admin",
            display_name="开发管理员",
        )
        db.add(admin)

        # 创建测试站场
        station = Station(
            name="测试站场-A",
            location="北京市",
            timezone="Asia/Shanghai",
            extra_metadata={"type": "compression_station"},
        )
        db.add(station)
        await db.flush()

        # 创建设备类型
        compressor_type = EquipmentType(
            type_code="centrifugal_compressor",
            display_name="离心压缩机",
            unit_system="metric",
        )
        db.add(compressor_type)
        await db.flush()

        # 创建测试设备
        compressor = Equipment(
            name="C-101",
            station_id=station.id,
            equipment_type_id=compressor_type.id,
            tag="C-101",
            manufacturer="西门子",
            model="STC-SV",
            install_date="2020-01-01",
        )
        db.add(compressor)

        await db.commit()
        print("✅ 种子数据创建完成")
        print(f"   管理员账号: admin / Admin@1234")
        print(f"   API: http://localhost:8000/docs")

asyncio.run(seed())
```

---

## 四、Studio（前端）启动（Refine：`refine-clawtwin`）

**权威变量与端口**见 **`clawtwin-studio/refine-clawtwin/README.md`**。

```bash
cd clawtwin-studio/refine-clawtwin   # 以你本机克隆路径为准

pnpm install    # 或 npm install

# 可选 .env.local：
#   VITE_CLAWTWIN_API_BASE=http://127.0.0.1:8000
#   VITE_CLAWTWIN_API_JWT=<access_token>   # 非 CLAWTWIN_AUTH_DEV 时需要
# 开发中启用 MSW 桩（无需后端可调部分 Tab）：
#   VITE_CLAWTWIN_MSW=1

pnpm dev        # 默认端口见 vite.config（常见 5175）
```

构建：

```bash
pnpm build
```

### （历史参考）旧 monorepo `studio/.env.local.example`

以下变量名适用于**旧 Studio 脚手架**，与 **refine-clawtwin** 的 **`VITE_CLAWTWIN_*`** 不同；请以 **`refine-clawtwin/src/env.ts`** 与 **`README.md`** 为准。

```bash
# API 基地址（历史）
VITE_API_BASE=http://localhost:8000

# 是否使用 MSW（历史命名；refine 用 VITE_CLAWTWIN_MSW=1）
VITE_USE_MSW=true

# Babylon.js 资产路径（3D 资产存放位置）
VITE_ASSETS_BASE=/assets/3d/

# 特性开关
VITE_FEATURE_3D_TWIN=true
VITE_FEATURE_AI_FORECAST=false  # Phase B
```

### 前端开发的两种模式（refine-clawtwin）

```
模式 A：MSW（无后端或减少依赖）
  VITE_CLAWTWIN_MSW=1 pnpm dev
  · main.tsx 在 DEV 且 MSW=1 时挂载 handlers.ts
  · 可与空 VITE_CLAWTWIN_API_BASE（走 Vite 代理相对路径）组合，见 README

模式 B：对接真实 platform-api
  VITE_CLAWTWIN_API_BASE=http://127.0.0.1:8000 pnpm dev
  · 按需设置 VITE_CLAWTWIN_API_JWT；服务端可开 CLAWTWIN_AUTH_DEV=1 做本地绕过（仅限开发）
```

---

## 五、AI 推理配置（可选，Phase A 可以用 Mock）

### 5.1 Mock 模式（开发默认）

```bash
# platform/.env
AGENT_RUNTIME=mock
AI_MOCK_ENABLED=true

# AI 任务会在 2 秒后返回模拟诊断结果
# 不需要 GPU 或 LLM 配置
```

### 5.2 对接真实 GPU Server（vLLM）

```bash
# 假设 GPU Server 在 192.168.10.50，运行 vLLM with Qwen3-35B
# GPU Server 已有：vllm serve Qwen/Qwen3-35B-A22B --port 8001

# platform/.env
AGENT_RUNTIME=none      # 直驱模式（Nexus 直接调 vLLM）
AI_MOCK_ENABLED=false
NEXUS_GPU_SERVER_URL=http://192.168.10.50:8001
NEXUS_EMBEDDING_URL=http://192.168.10.50:8002   # 嵌入模型
```

### 5.3 对接 OpenClaw

```bash
# 1. 先确保 OpenClaw 已安装 Sage Skills
#    openclaw install ./sage/industrial-twin/
#    openclaw install ./sage/industrial-kb/

# 2. platform/.env
AGENT_RUNTIME=openclaw
OPENCLAW_URL=http://localhost:9001
OPENCLAW_API_KEY=sk-your-key-here

# 3. 生成 Service Token（OpenClaw 用）
curl -X POST http://localhost:8000/v1/admin/service-tokens \
  -H "Authorization: Bearer $(your-admin-jwt)" \
  -d '{"name":"openclaw-sage","scopes":["tool:call"]}'
# 把返回的 token 填入 OpenClaw 的 Skill 配置中
```

---

## 六、验证清单

启动完成后，按顺序验证以下功能：

```bash
# 1. 后端健康
curl http://localhost:8000/health

# 2. 登录获取 JWT
TOKEN=$(curl -s -X POST http://localhost:8000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@1234"}' | jq -r .data.token)

# 3. 获取设备列表
curl http://localhost:8000/v1/equipment \
  -H "Authorization: Bearer $TOKEN"

# 4. 获取设备决策包
curl "http://localhost:8000/v1/equipment/1/decision-package" \
  -H "Authorization: Bearer $TOKEN"

# 5. 触发 AI 分析任务
TASK_ID=$(curl -s -X POST http://localhost:8000/v1/ai/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"job_type":"diagnose","equipment_id":1}' | jq -r .data.task_id)

# 6. 查询任务状态（等 2 秒，mock 模式下很快）
sleep 2
curl "http://localhost:8000/v1/ai/jobs/$TASK_ID" \
  -H "Authorization: Bearer $TOKEN"
```

```
前端验证（浏览器打开 http://localhost:5173）：
  □ 登录页面正常显示
  □ 登录后进入 StudioShell
  □ 左侧 NavRail 显示设备列表
  □ 点击设备 → DeviceIntelPanel 显示（使用 MSW 数据）
  □ 切换到"危险"场景：window.__MSW_SCENARIO__ = "critical"
  □ Panel 颜色变为红色，显示 P1 告警
  □ SSE 连接图标显示绿色（已连接）
```

---

## 七、常见问题（FAQ）

```
Q: docker compose 启动失败，postgres 退出
A: 检查 5432 端口是否被本机 postgres 占用
   sudo lsof -i :5432
   解决：改端口 or 停止本机 postgres

Q: alembic upgrade head 失败，说扩展不存在
A: 检查 init-pg-extensions.sql 是否在 docker 初始化时执行
   docker exec -it clawtwin-postgres-1 psql -U clawtwin -c "\dx"
   应该看到 timescaledb、vector、age 三个扩展

Q: Studio 报 "Cannot connect to SSE"
A: MSW 模式下 SSE 是模拟的，不需要真实连接
   检查 handlers/sse.ts 是否正确配置了 mock SSE handler

Q: 飞书消息发不出去
A: 确认 FEISHU_APP_ID 和 FEISHU_APP_SECRET 已配置
   检查飞书应用的 IP 白名单是否包含开发机器的出口 IP

Q: Milvus 启动失败
A: Milvus standalone 需要 etcd，确认 docker compose 中包含 etcd
   或者用内嵌 etcd：image: milvusdb/milvus:v2.4.0-standalone

Q: 前端切换到真实后端，但 API 报 CORS 错误
A: platform/main.py 的 CORS 配置
   CORS_ORIGINS=["http://localhost:5173"]  # 确保包含前端端口
```

---

## 八、并行开发约定

```
多个工程师同时开发时的约定：

API 契约变更：
  · 变更 API 路径/格式前，先在 #tech-design 群通知
  · 同时更新：routers/*.py + studio/src/lib/mock/handlers/*.ts
  · 不能只改后端不改 Mock（会破坏前端开发）

数据库变更：
  · 新字段必须有 alembic 迁移文件
  · 不要直接 ALTER TABLE（保证其他人能用 alembic upgrade head 同步）

分支策略：
  · feature/task-{id}-{description}
  · 不要长期保留与 main 相差超过 3 天的分支
  · PR 必须通过：pnpm test + pnpm format:check

任务文件所有权：
  · 参考 PARALLEL-DEV-TASKSPEC.md 中各任务的"主权文件"列表
  · 尽量避免修改不属于自己任务的文件
```

---

_本文档是新成员加入时的第一手参考资料。_  
_30 分钟内无法成功启动，请立即在 #tech-help 群反馈，可能是文档需要更新。_
