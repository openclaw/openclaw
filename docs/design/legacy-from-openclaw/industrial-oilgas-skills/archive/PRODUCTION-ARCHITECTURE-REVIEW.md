# 生产级落地架构审查

## ClawTwin 工程落地 · 集成 · 管理运维全面审视

**日期**：2026-05-08  
**性质**：面向真实客户现场部署的架构批判性审查  
**目标**：让架构师、实施工程师、运维工程师都能看懂，并能独立执行交付

---

## 一、先讲结论——诚实的工程评估

```
当前状态评分（工程落地视角 1-5分）：

AI 功能设计         ████████░  4.0  概念清晰，但还没有跑通的代码
安全架构            ███████░░  3.5  ADR-6/7 定义了正确方向，尚未实现
生产部署设计        █████░░░░  2.5  Docker Compose 有了，但缺大量生产要素
OT/IT 网络设计      ████░░░░░  2.0  几乎没有考虑（严重缺口）
运维管理设计        ███░░░░░░  1.5  基本没有（最大短板）
客户交付流程        ██░░░░░░░  1.0  完全没有设计

现实判断：
  这是一个设计良好的 MVP 概念，有清晰的技术方向
  但距离「可交付给真实石油天然气客户」还差 6-12 个月的工程工作
  当前版本可以做 Demo，不能交付生产
```

---

## 二、工业现场的真实网络结构

这是理解一切工程决策的基础——工业现场根本不是一个平坦的内网：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Zone 0：现场控制层（OT 网络，物理隔离）                                  │
│                                                                         │
│  PLC / RTU / DCS ──► OPC-UA 服务器（如 Kepware、PTC）                   │
│  现场仪表（压力计、流量计、温度计）                                         │
│  紧急切断阀（ESD）控制器                                                   │
│                                                                         │
│  ⚠️ 规则：任何 IT 系统不得直连此层。违反此规则 = 违反工业安全规范           │
└─────────────────────┬───────────────────────────────────────────────────┘
                      │ 只允许单向数据出（数据二极管 / 防火墙严格规则）
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Zone 1：数据采集层（DMZ / 数据转发区）                                   │
│                                                                         │
│  opcua-bridge（我们开发）                                                 │
│    · 从 OPC-UA 服务器订阅数据（只读）                                     │
│    · 转发到 Zone 2 的 Kafka（单向，不反向）                               │
│  Kafka Producer                                                          │
│                                                                         │
│  ⚠️ 此区域不部署数据库、不部署 AI、不部署 Web 服务                         │
└─────────────────────┬───────────────────────────────────────────────────┘
                      │ Kafka 消息（TCP，严格防火墙规则）
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Zone 2：IT 业务层（企业内网）                                            │
│                                                                         │
│  ┌────────────────────┐  ┌─────────────────────────────────────────┐   │
│  │ 服务器 A            │  │ 服务器 B（如有）                         │   │
│  │ ClawTwin Platform  │  │ 数据库服务器                             │   │
│  │  platform-api      │  │  PostgreSQL（含 TimescaleDB）            │   │
│  │  Eclipse Ditto     │  │  Milvus（向量库）                        │   │
│  │  Kafka Consumer    │  │  MinIO（文档存储）                        │   │
│  │  OpenClaw Gateway  │  │  Redis（缓存）                           │   │
│  │  Nginx（反向代理）  │  └─────────────────────────────────────────┘   │
│  └────────────────────┘                                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ GPU 服务器（推理层）                                              │   │
│  │   vLLM + Qwen3.6-35B-A3B INT4（:8000）                          │   │
│  │   MOIRAI 2.0（:8888）                                            │   │
│  │   Embedding Service（:8001）                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────┬───────────────────────────────────────────────────┘
                      │ HTTPS（防火墙控制出口）
                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Zone 3：外部服务（互联网 or 私有化部署）                                  │
│                                                                         │
│  飞书服务器（公有云 or 企业私有化部署）                                     │
│  外部知识源（厂商文档 API 等）                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

**当前设计的严重问题**：`opcua-bridge` 直接与 Platform 在同一个 Docker Compose 里，没有任何 OT/IT 分区。这在真实工业项目中是不合格的。

---

## 三、生产硬件部署规格

### 3.1 最小化单站部署（典型天然气输送站，10-30人）

```
服务器配置（建议）：

服务器 A：Platform 主机（必须，不可省略）
  CPU：16核（Intel Xeon 或 AMD EPYC）
  内存：64GB RAM
  存储：2TB SSD（RAID 1）
  网络：双网卡（一个接 IT 网，一个接 DMZ 数据采集区）
  OS：Ubuntu Server 22.04 LTS

服务器 B（可选，数据库独立）：
  CPU：8核
  内存：32GB RAM
  存储：4TB SSD（RAID 1，PostgreSQL + Milvus）
  → Phase A 可以合并到服务器 A，Phase B 建议独立

GPU 服务器（推理层，可与多站共享）：
  GPU：NVIDIA A100 40GB × 2（或 RTX 4090 × 4）
  RAM：128GB
  存储：4TB NVMe SSD（模型文件 + 推理缓存）
  → Qwen3.6-35B-A3B INT4 约占 20GB VRAM，一卡可用
  → 多站共享时建议 2 卡（一卡推理 + 一卡备用/异步）

DMZ 数据采集服务器（或用服务器 A 的第二网卡）：
  CPU：4核
  内存：16GB RAM
  存储：500GB SSD
  只运行：opcua-bridge + Kafka Producer
  网络：双网卡（一个接 OT 网，一个接 IT 网）
  → 这是 OT 和 IT 之间的「桥」，必须严格控制
```

### 3.2 运维工程师工作站（供应商工程师现场使用）

```
MacBook Pro（已有）：
  用途：ClawTwin Studio 访问（浏览器即可）
        现场调试（SSH 到服务器）
        知识文档上传（通过 Studio Admin 页面）
  不需要本地运行任何 ClawTwin 服务
```

---

## 四、服务组件分布（生产版）

```
组件                      服务器位置      网络区域    重启影响
────────────────────────────────────────────────────────────────────
platform-api (FastAPI)    服务器 A        IT Zone     影响 API 调用（5秒内）
Eclipse Ditto             服务器 A        IT Zone     影响实时孪生（数秒）
Kafka Broker              服务器 A        IT Zone     影响数据流（Broker 重连）
OpenClaw Gateway          服务器 A        IT Zone     影响 AI 对话（秒级）
Nginx                     服务器 A        IT Zone     短暂不可用（<1秒）
PostgreSQL                服务器 B/A      IT Zone     影响所有持久化（关键）
Milvus                    服务器 B/A      IT Zone     影响知识检索（分钟级）
MinIO                     服务器 B/A      IT Zone     影响文档存储
Redis                     服务器 A        IT Zone     影响缓存（自动降级）
vLLM（Qwen3.6）           GPU 服务器      IT Zone     影响 AI 回复质量（降级）
MOIRAI                    GPU 服务器      IT Zone     影响异常检测（降级）
opcua-bridge              DMZ 服务器      DMZ         影响实时数据（队列缓冲）
Kafka Producer            DMZ 服务器      DMZ         影响实时数据（队列缓冲）

降级策略（GPU 服务器不可用时）：
  · Platform 切换到「简化模式」
  · AI 回复：使用规则引擎生成基础响应（不是 LLM，但有基本功能）
  · 异常检测：使用阈值规则（替代 MOIRAI）
  · 工单草稿：可以继续工作（工单内容由规则生成，质量下降）
  · 数字孪生展示：不受影响（纯数据展示，不依赖 AI）
```

---

## 五、数据流（生产级完整视图）

```
实时数据流（低延迟，1秒内）：
  OT Network
    OPC-UA Server
      └─► opcua-bridge（DMZ）
            └─► Kafka（IT Zone）
                  └─► Ditto Consumer（platform-api）
                        └─► Eclipse Ditto（孪生状态更新）
                              ├─► Studio /twin（WebSocket 推送）
                              └─► Scheduler（阈值检查，触发告警）

历史数据流（批量，允许延迟）：
  Ditto 状态变化
    └─► Kafka（history topic）
          └─► TimescaleDB 写入（platform-api）
                └─► MOIRAI 分析（每小时批量）
                      └─► 异常评分写 PostgreSQL

知识检索流（用户查询触发）：
  OpenClaw → /v1/tools/kb/search
    └─► platform-api
          ├─► Milvus 向量检索（L0/L1/L2 文档）
          ├─► GraphRAG 关系查询（实体关系）
          └─► Milvus L3 查询（station_id 过滤，工单经验）
                └─► 合并排序 + citations → 返回 OpenClaw

飞书消息流（用户交互）：
  飞书 App → 飞书服务器
    ├─► OpenClaw（AI 对话事件）
    │     └─► Skills → /v1/tools/*（Platform 强制 ABAC）
    │           └─► 结果 → OpenClaw → 飞书 → 用户
    └─► /v1/feishu/webhook（卡片回调 → HITL 审批）
          └─► 验签 → 权限验证 → 工单状态更新 → 审计日志
```

---

## 六、客户现场交付流程（工程实施手册）

### Phase 0：交付前评估（上门 1-2 天）

```
需要从客户获取的信息：

IT 基础设施：
  □ 服务器硬件规格（CPU/内存/存储）
  □ 操作系统版本
  □ 内网 IP 地址规划
  □ 防火墙规则（是否允许我们指定端口）
  □ 飞书版本（公有云/私有化，版本号）

OT 系统：
  □ OPC-UA 服务器地址和端口
  □ OPC-UA 安全模式（None/Sign/SignAndEncrypt）
  □ 现有设备列表（设备名称、类型、测点 ID）
  □ 是否有现有 SCADA/DCS 系统
  □ OT/IT 网络隔离情况（防火墙规则、是否有数据二极管）

业务系统：
  □ 现有工单系统类型（SAP PM/Maximo/Excel/自研）
  □ 是否有 API 接口
  □ 历史工单数量（决定 L3 知识初始化工作量）
  □ 知识文档数量（PDF 操作规程、维修手册、标准等）

用户和权限：
  □ 场站用户列表（姓名、工号、飞书账号、角色）
  □ 组织架构（操作员/主管/工程师数量）
  □ 值班群 chat_id（飞书群）

网络连通性（需要测试）：
  □ 服务器 → 飞书服务器（私有化：内网即可；公有云：需出口）
  □ 服务器 → GPU 服务器（如果 GPU 在他处）
  □ DMZ 服务器 → OT Zone OPC-UA 端口
  □ 员工工作站 → Platform API（Studio 访问）
```

### Phase 1：基础设施部署（1天）

```
Step 1: 安装 Docker & Docker Compose
  ssh user@server-a
  curl -fsSL https://get.docker.com | sh
  docker compose version   # 验证 >= 2.20

Step 2: 部署 ClawTwin Platform
  git clone https://git.clawtwin.com/clawtwin-platform.git
  cd clawtwin-platform
  cp .env.example .env
  # 编辑 .env（填入飞书、GPU 服务器地址等）
  docker compose up -d
  # 验证所有容器健康
  docker compose ps

Step 3: 初始化数据库
  docker compose exec platform-api python manage.py migrate
  docker compose exec platform-api python manage.py create_admin
  # 输出：admin 账号 + 初始密码

Step 4: 验证基础健康
  curl http://localhost:8080/v1/health
  # 期望：{"status":"ok","services":{"postgres":"up","ditto":"up",...}}

Step 5: 配置 Nginx + SSL（如需）
  # 私有化飞书：HTTP 即可
  # 公有云飞书：需要配置 Let's Encrypt 或自签证书

交付物：运行中的 ClawTwin Platform，可访问 /v1/health
时间估计：4-6小时（含网络调试）
```

### Phase 2：OT 数据接入（2-3天）

```
Step 1: 部署 opcua-bridge（DMZ 服务器）
  # DMZ 服务器上
  git clone ... clawtwin-opcua-bridge
  # 配置 OPC-UA 服务器地址、节点 ID 映射

Step 2: 配置设备节点映射（最耗时的步骤）
  # config/node_mapping.yaml
  equipment_nodes:
    C-001:
      outlet_pressure: "ns=2;i=1001"
      inlet_temperature: "ns=2;i=1002"
      shaft_vibration: "ns=2;i=1003"
      speed: "ns=2;i=1004"
    SDV-001:
      position: "ns=2;i=2001"   # 0=关, 1=开, 中间值=故障

  # 需要客户 DCS/OPC-UA 工程师提供节点 ID 对照表
  # 这是最依赖客户配合的一步，通常需要 1-2 天联调

Step 3: 验证数据流
  # 检查 Ditto 中的设备状态是否实时更新
  curl http://platform:8080/v1/objects/equipment/C-001
  # 期望：current.outlet_pressure 每秒变化

Step 4: 配置 OT/IT 防火墙规则
  DMZ → IT Zone，只允许：
    TCP :9092（Kafka）
  OT Zone → DMZ，只允许：
    TCP :4840（OPC-UA 默认端口）
  禁止：DMZ → OT Zone（单向！）

交付物：Studio /twin 中可以看到实时设备状态
时间估计：2-3天（含与客户 DCS 工程师联调）
```

### Phase 3：知识库初始化（1-2周）

```
这是最耗时也最有价值的阶段：

文档收集（客户提供）：
  □ 设备操作手册（PDF）
  □ 维修规程（PDF）
  □ 历史事故报告（脱敏）
  □ 行业标准（GB/T、SY/T 等）
  □ 历史工单（Excel/CSV 导出）

文档处理（我们执行）：
  1. PDF → 文本提取（docling/unstructured）
  2. 文本 → Milvus 向量索引（分层：L0/L1/L2）
  3. 历史工单 CSV → PostgreSQL（用 csv_import.py）
  4. 历史工单 → 批量写 L3 kb_documents（layer=L3）+ Milvus 向量化
  5. GraphRAG 增量构建（提取实体关系）
  6. 验证知识检索效果（20个典型问题 QA 验证）

时间估计：
  小规模（< 200份文档）：3-5天
  中等规模（200-1000份）：1-2周
  需要部分由客户收集文档（2-4天）

这个阶段是 ClawTwin 知识质量的决定因素
```

### Phase 4：用户绑定和权限配置（0.5天）

```
Step 1: 创建 Platform 用户
  登录 Studio Admin
  批量导入用户（CSV：工号、姓名、角色、场站）

Step 2: 用户飞书绑定
  向每位用户发送绑定链接
  用户用工号+临时密码登录 Platform → 绑定飞书账号
  验证：用户在飞书发"测试" → OpenClaw 能识别身份

Step 3: 配置飞书群
  将 ClawTwin Bot 加入值班群
  配置 Platform .env 中的 FEISHU_DUTY_CHAT_ID

Step 4: 权限验证
  操作员：能查询本站设备，不能查其他站
  主管：能审批工单
  工程师：能查多站，不能建工单
```

### Phase 5：试运行（2-4周监护期）

```
监护期运维内容：
  · 每日检查 Docker 容器状态
  · 每日检查审计日志（异常访问模式）
  · 收集用户反馈（AI 回答质量、误报率等）
  · 知识库持续补充（根据用户常见问题）
  · 异常检测阈值调优（MOIRAI 误报/漏报调整）
  · 性能调优（慢查询、内存使用）
```

---

## 七、运维管理——日常操作手册

### 7.1 日常健康检查（每日自动）

```bash
# 健康检查脚本（clawtwin-platform/scripts/health-check.sh）

#!/bin/bash
set -e

echo "=== ClawTwin Daily Health Check ==="
DATE=$(date +%Y-%m-%d)

# 1. Docker 容器状态
echo "[1] Container Status"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"

# 2. Platform API 健康端点
echo "[2] Platform API"
STATUS=$(curl -sf http://localhost:8080/v1/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])")
echo "   Status: $STATUS"

# 3. 数据库连接
echo "[3] Database"
docker compose exec -T postgres pg_isready -U clawtwin

# 4. 实时数据流（检查最近 5 分钟是否有数据写入）
echo "[4] Real-time Data Feed"
LAST_TS=$(docker compose exec -T postgres psql -U clawtwin -c \
  "SELECT MAX(time) FROM equipment_readings WHERE time > NOW()-INTERVAL '5 minutes';" -t -A)
if [ -z "$LAST_TS" ]; then
  echo "   ⚠️ WARNING: No data in last 5 minutes"
else
  echo "   ✓ Last reading: $LAST_TS"
fi

# 5. GPU 服务器（vLLM）
echo "[5] vLLM"
GPU_STATUS=$(curl -sf http://gpu-server:8000/health 2>/dev/null && echo "UP" || echo "DOWN")
echo "   Status: $GPU_STATUS"

# 6. 磁盘使用
echo "[6] Disk Usage"
df -h / | tail -1 | awk '{print "   " $5 " used (" $4 " free)"}'

echo "=== Health Check Complete ==="
```

### 7.2 升级策略（零停机升级）

```
Platform API 升级（最常见）：

# 1. 拉取新版本
git pull origin main

# 2. 检查有无数据库迁移（如有，评估影响）
python3 manage.py showmigrations --plan

# 3. 蓝绿部署（如果有多副本）
docker compose up -d --no-deps --build platform-api

# 4. 如果单副本，只能滚动重启（30秒内 AI 对话不可用，数据采集不受影响）
docker compose restart platform-api

# 5. 验证
curl http://localhost:8080/v1/health
# 检查日志
docker compose logs platform-api --tail 50

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OpenClaw Skills 更新（影响最小，最常见）：

# 在 OpenClaw 服务器上
cd ~/.openclaw/agents/<orgAgentId>/skills/
# 更新 SKILL.md 文件内容
# OpenClaw 支持热加载，不需要重启（确认版本支持）
openclaw skills reload industrial-twin

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LLM 模型升级（高风险，需要计划停机）：

# 1. 在 GPU 服务器上下载新模型（与旧模型并存）
# 2. 在非高峰时间切换 vLLM 指向新模型
# 3. 运行验证测试集（10个标准问题，人工评审回答质量）
# 4. 如果不满意，切回旧模型（保留旧模型至少 1 周）

数据库 Schema 变更（最高风险，需要仔细计划）：

原则：
  · 只做向前兼容的变更（加列 = 安全，删列 = 危险）
  · 不可在生产高峰期执行迁移
  · 迁移前必须备份
  · 迁移后监控 30 分钟
```

### 7.3 备份策略

```
备份目标和 RPO/RTO：

数据类型          备份频率    保留时间    RPO       RTO
────────────────────────────────────────────────────────
PostgreSQL        每日全量    30天        24小时    2小时
                  每小时增量  7天         1小时     30分钟
Milvus            每周快照    4周         1周       4小时
MinIO(文档)       每日同步    永久        24小时    2小时
审计日志          实时写入    永久        0         1分钟

备份脚本（clawtwin-platform/scripts/backup.sh）：

#!/bin/bash
BACKUP_DIR="/backup/clawtwin/$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# PostgreSQL 备份
docker compose exec -T postgres pg_dump -U clawtwin clawtwin_db \
  | gzip > "$BACKUP_DIR/postgres.sql.gz"

# Milvus 快照（每周）
if [ "$(date +%u)" = "7" ]; then
  curl -X POST "http://localhost:19530/api/v1/snapshot" \
    -H "Content-Type: application/json" \
    -d '{"collection_name":"industrial_kb","snapshot_name":"weekly_backup"}'
fi

# MinIO 同步（到备份存储）
mc mirror minio/clawtwin /backup/clawtwin/minio/

echo "Backup completed: $BACKUP_DIR"

# 清理 30 天前的备份
find /backup/clawtwin/ -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
```

### 7.4 故障恢复手册

```
故障场景 1：Platform API 无法启动
  诊断：docker compose logs platform-api | tail -50
  常见原因：
    a. PostgreSQL 未就绪（等待 30 秒重启）
    b. 配置文件错误（检查 .env）
    c. 端口冲突（检查 8080 端口占用）
  恢复：docker compose restart platform-api

故障场景 2：实时数据停止更新
  诊断：docker compose logs opcua-bridge | tail -30
  常见原因：
    a. OPC-UA 服务器重启（opcua-bridge 自动重连，等待 1 分钟）
    b. DMZ → IT 网络中断（检查防火墙）
    c. Kafka 积压过大（检查 Lag）
  恢复：docker compose restart opcua-bridge

故障场景 3：AI 回复停止（OpenClaw 无响应）
  诊断：
    a. 检查 OpenClaw 进程状态
    b. 检查 vLLM：curl http://gpu-server:8000/health
  常见原因：
    a. GPU 服务器内存 OOM（vLLM 崩溃）→ 重启 vLLM
    b. OpenClaw 与 Platform API 网络中断
  降级：Platform 切换到规则引擎模式（设置 FALLBACK_MODE=true）
       用户仍可查询设备状态，但 AI 质量下降

故障场景 4：PostgreSQL 数据库损坏
  这是最严重的故障，需要执行备份恢复流程：
  1. 停止 platform-api（防止继续写入损坏数据）
  2. 恢复最近的 pg_dump 备份
  3. 重放增量备份（如果有）
  4. 验证数据完整性
  5. 重启 platform-api
  预计停机时间：1-4小时（取决于数据量）
```

---

## 八、监控和可观测性

```
Phase A（最小可行监控）：
  · docker compose ps（手动，每天检查）
  · /v1/health 端点（Nginx 每 30 秒探活）
  · 结构化日志（JSON 格式，写文件，定期查）
  · 关键指标写 PostgreSQL（简单查询即可看）

Phase B（生产级监控，必须在交付生产前完成）：
  · Prometheus + Grafana（基础设施指标）
    - CPU、内存、磁盘使用率
    - Platform API 请求延迟（P50/P95/P99）
    - vLLM 推理延迟
    - Kafka 消费 Lag（数据积压量）

  · 告警规则（发送到值班群 or 短信）：
    - Platform API 5分钟无响应 → 立即告警
    - 实时数据 10分钟无更新 → 告警
    - GPU 服务器内存 > 90% → 预警
    - 磁盘使用 > 80% → 预警
    - PostgreSQL 连接数 > 80% → 预警

  · 日志聚合（Loki 或 ELK，按需）：
    - 审计日志查询界面（谁查了什么）
    - 错误日志告警（5分钟内错误数 > 10）
```

---

## 九、多站管理（10个场站的中型企业）

```
当前设计缺口：如何管理 10 个场站的 ClawTwin

方案（按实施复杂度排序）：

方案 A：独立部署，人工管理（Phase A/B 合理）
  · 每个场站独立的 Docker Compose 环境
  · 使用 Ansible Playbook 批量部署和更新
  · 缺点：更新 10 个场站需要执行 10 次 Ansible

ansible-playbook \
  -i inventory/stations.yaml \
  playbooks/update-platform.yml \
  --limit station-S001,station-S002

方案 B：中央化管理控制台（Phase B 实现）
  · Platform Admin 增加「场站管理」模块
  · 集中查看所有场站的健康状态
  · 集中推送 Skills 更新
  · 跨站汇聚报表（区域/总部视角）

方案 C：Kubernetes + Helm（大规模，20站以上）
  · 每个场站一个 Kubernetes Namespace
  · Helm Chart 管理所有服务
  · ArgoCD 实现 GitOps 部署
  · 成本：需要 Kubernetes 运维能力（高门槛）
  → Phase C 考虑，不要过早引入

结论：Phase A/B 用 Ansible，Phase C 按需考虑 K8s
```

---

## 十、工程实施的诚实评估——什么该做，什么不该做

### 必须做（Phase A 开发前）

```
① OT/IT 网络分区设计文档
   · 明确 opcua-bridge 的网络位置
   · 明确防火墙规则清单
   · 没有这个，真实工业客户不会允许部署

② 健康检查端点（/v1/health）
   · 检查所有依赖服务状态
   · Nginx 探活配置
   · 这是运维的基础

③ 安全基线（ADR-6）
   · 飞书 Webhook 签名验证（已定义，必须实现）
   · 工单审批角色验证（已定义，必须实现）
   · 审计日志（已定义，必须实现）
```

### Phase B 前必须完成（生产部署前）

```
④ 数据库备份脚本 + 定时任务
⑤ 基础监控（Prometheus/Grafana 或等效方案）
⑥ 告警配置（关键服务宕机通知）
⑦ 用户绑定流程（Admin UI）
⑧ Ansible 部署 Playbook（便于重复部署）
⑨ OPC-UA 节点映射工具（客户配置界面）
```

### 不该做的（避免过度工程）

```
✗ 不要现在搞 Kubernetes（10站以内 Ansible 足够）
✗ 不要现在做 HA 双主 PostgreSQL（备份恢复足够 Phase A/B）
✗ 不要现在做多租户 SaaS（先交付 3-5 个客户再说）
✗ 不要现在做完整的 SIEM（审计日志 + 人工审查即可）
✗ 不要现在做移动端 App（飞书已经覆盖移动端需求）
```

---

## 十一、总结：从 Demo 到生产的差距

```
当前状态（2026-05）：
  技术概念验证（Demo 级别）
  核心算法和数据流设计清晰
  安全架构已定义（ADR-6/7）
  OT/IT 分区尚未考虑
  运维工具几乎为零

到「可交付第一个客户」需要：
  时间：约 4-6 个月（2人全职）
  阶段：
    M1-M2：Platform API 基础功能 + OT 接入 + 安全基线
    M3-M4：知识库 + Studio + 飞书 HITL（可演示）
    M5-M6：运维工具 + 备份 + 监控 + 交付流程文档

第一个客户应该是：
  中型天然气输送站（规模可控）
  已有 OPC-UA 服务器（减少接入工作量）
  IT 团队友好（配合程度高）
  接受"共建产品"的定位（愿意容忍早期不成熟）
  合同里明确标注「试点项目」（管理预期）
```
