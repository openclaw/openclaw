# Phase A 开发 Runbook

**周期**：8 周（约 40 个工作日）  
**目标**：可演示的工业数字孪生 MVP，打通数据采集→数字孪生→AI 对话→HITL 工单完整链路  
**原则**：每周结束有可运行的验收点；Mock → Real 渐进替换；不跳步

---

## 快速参考

| 文档                               | 用途                           |
| ---------------------------------- | ------------------------------ |
| `CLAWTWIN-MASTER-V2.md`            | 总架构，遇到结构问题先看这里   |
| `MODULE-DESIGN-PLATFORM.md`        | 后端模块 + API + DB schema     |
| `MODULE-DESIGN-STUDIO.md`          | 前端模块 + 组件树 + hooks      |
| `OPCUA-BRIDGE-DESIGN.md`           | OPC-UA Bridge 详细设计         |
| `ADR-4-SKILL-DESIGN-AND-REVIEW.md` | OpenClaw Skills 设计原则       |
| `ADR-6-SECURITY-ARCHITECTURE.md`   | 安全架构，每个 API 必读        |
| `clawtwin-project/SKILL.md`        | 开发铁律 10 条，每个 PR 前检查 |

---

## Week 1：基础设施 + 骨架

> **Phase A 使用 MOCK_MODE=true，最精简启动不需要 Kafka/Ditto**  
> 完整 docker-compose 见 `PHASE-A-SCAFFOLD.md §二`

### 任务清单

- [ ] `docker-compose.yml` 启动 **Phase A Core** 服务（`postgres` + `redis` + `milvus` + `etcd` + `minio` + `nginx`）
- [ ] 复制 `.env.example` → `.env`，至少设置 `MOCK_MODE=true`
- [ ] `config.py` Pydantic Settings（参考 `MODULE-DESIGN-PLATFORM.md §六`）
- [ ] **Alembic 初始化**（数据库迁移，只做一次）：
  ```bash
  cd platform-api
  pip install alembic asyncpg sqlalchemy[asyncio]
  alembic init migrations
  # 编辑 migrations/env.py：设置 target_metadata = Base.metadata，使用 async engine
  # 编辑 alembic.ini：sqlalchemy.url = ${DATABASE_URL}
  alembic revision --autogenerate -m "initial schema"
  # ⚠️ 检查生成的 migration 文件，确认包含所有表
  # ⚠️ 在生成的 migration 的 upgrade() 最后添加：
  #    op.execute("SELECT create_hypertable('equipment_readings', 'time', if_not_exists => TRUE)")
  #    op.execute("SELECT create_hypertable('anomaly_scores', 'time', if_not_exists => TRUE)")
  alembic upgrade head
  ```
- [ ] Platform API `main.py` + 路由骨架（参考 `MODULE-DESIGN-PLATFORM.md §七`）
  - ⚠️ lifespan 中用 `engine.begin() → conn.run_sync(Base.metadata.create_all)` 仅适用于开发
  - 生产/CI 始终用 `alembic upgrade head`，不要混用两种方式
- [ ] `GET /v1/health` 检查所有依赖服务连接状态（参考 `MODULE-DESIGN-PLATFORM.md §12.7`）
- [ ] `GET /v1/objects/stations` 返回 Mock 场站列表（从 `data/mock/station-CNG-001.json` 读取）
- [ ] `GET /v1/objects/equipment/{id}` 返回 Mock 设备数据（含 mock 实时数据）
- [ ] 准备 Mock 数据文件（参考 `MODULE-DESIGN-PLATFORM.md §12.8`）：
  ```bash
  mkdir -p platform-api/data/mock
  # 按格式创建：station-CNG-001.json, equipment-C-001.json, equipment-V-001.json 等
  ```

### 完成标准（Week 1 验收）

```bash
# 启动 Phase A Core 服务
docker compose up -d
docker compose ps
# 期望：postgres, redis, milvus, etcd, minio 全部 healthy/running

# Platform API 健康检查
curl http://localhost:8080/v1/health
# 期望（MOCK_MODE=true）：
# {
#   "status": "ok",
#   "mock_mode": true,
#   "database": "connected",
#   "redis": "connected",
#   "milvus": "connected",
#   "kafka": "skipped (mock mode)"  ← mock 模式下跳过
# }

curl http://localhost:8080/v1/objects/stations
# 期望：{"stations": [{"id": "STATION-CNG-001", "name": "天然气压缩机场站", ...}]}

curl http://localhost:8080/v1/objects/equipment/C-001
# 期望：包含 current(实时数据)、thresholds、status 字段

# PostgreSQL 表已存在
docker compose exec postgres psql -U clawtwin -c "\dt"
# 期望：列出 users, stations, equipment, work_orders, audit_logs, audit_logs_...（分区表）
```

### 常见错误

- Milvus 首次启动慢（需要 etcd 就绪约 30s）：`docker compose logs milvus | tail -20`
- MinIO 未创建 bucket：`docker compose exec minio mc mb /minio_data/clawtwin`
- `.env` 未配置 `DATABASE_URL` → Platform 报 "connection refused"
- **不要在 Week 1 启动 Kafka**（MOCK_MODE=true 不需要，加它只会增加排错难度）

---

## Week 2：认证 + 飞书绑定

### 任务清单

- [ ] `POST /v1/auth/feishu/callback` 接收飞书 OAuth code，返回 JWT
- [ ] `GET /v1/auth/me` 验证 JWT，返回当前用户信息
- [ ] `POST /v1/admin/feishu-bind` 绑定飞书 open_id 到 Platform 用户（无需 Auth，bind_token 鉴权）
- [ ] `depends.py` 实现 `get_current_user`（JWT 解析）
- [ ] `depends.py` 实现 `require_roles(["supervisor"])` 依赖
- [ ] `depends.py` 实现 `get_station_access` 检查用户 station 权限
- [ ] 单元测试：JWT 有效期、无效 token → 401、权限不足 → 403

### 完成标准（Week 2 验收）

```bash
# Mock JWT（测试专用，用 settings.mock_mode=true 时不验证签名）
TOKEN="Bearer test-token-supervisor"

# 权限测试
curl -H "Authorization: $TOKEN" http://localhost:8080/v1/auth/me
# 期望：{"user_id": "...", "name": "测试用户", "roles": ["supervisor"]}

curl -H "Authorization: $TOKEN" http://localhost:8080/v1/objects/equipment/C-001
# 期望：200 正常返回

# 无 token 访问
curl http://localhost:8080/v1/objects/equipment/C-001
# 期望：{"error": "UNAUTHORIZED", "message": "需要身份认证"}
```

---

## Week 3：工单状态机 + HITL

### 任务清单

- [ ] `workorder_fsm.py` 实现状态机（参考 MODULE-DESIGN-PLATFORM.md 九）
- [ ] `POST /v1/hitl/workorders` 创建工单草稿（仅 OpenClaw Service Token 调用）
- [ ] `GET /v1/hitl/workorders` 查询工单列表（可按 status / station 过滤）
- [ ] `POST /v1/hitl/workorders/{id}/approve` 主管审批通过
- [ ] `POST /v1/hitl/workorders/{id}/reject` 主管驳回（需要 reason）
- [ ] 工单 CRUD 写 `audit_logs` 表
- [ ] 测试：状态机非法转换 → 409、非主管 approve → 403

### 完成标准（Week 3 验收）

```bash
# 创建工单草稿（OpenClaw service token）
curl -X POST http://localhost:8080/v1/hitl/workorders \
  -H "X-OpenClaw-Service-Token: dev-service-token" \
  -H "X-OpenClaw-User-OpenId: ou_test_user" \
  -H "Content-Type: application/json" \
  -d '{"equipment_id":"C-001","title":"C-001轴承异常检查","priority":"P2","description":"轴承异常，建议检查"}'
# 期望：{"wo_id": "W-XXXXXXXX", "state": "draft", ...}  ← 字段名 wo_id/state，值小写

# 操作员提交审批
curl -X POST http://localhost:8080/v1/hitl/workorders/W-XXXXXXXX/pending \
  -H "Authorization: Bearer operator-test-token"
# 期望：{"wo_id": "W-XXXXXXXX", "state": "pending_approval"}

# 主管审批（JWT 含 supervisor 角色）
curl -X POST http://localhost:8080/v1/hitl/workorders/W-XXXXXXXX/approve \
  -H "Authorization: Bearer supervisor-test-token" \
  -H "Content-Type: application/json" \
  -d '{"comment": "同意，安排下午执行"}'
# 期望：{"wo_id": "W-XXXXXXXX", "state": "approved"}   ← 非 "APPROVED"

# 验证审计日志
docker compose exec postgres psql -U clawtwin \
  -c "SELECT action, actor_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5;"
```

---

## Week 4：飞书 Webhook + 告警推送

### 任务清单

- [ ] `POST /v1/feishu/webhook` 接收飞书卡片按钮回调（HITL 审批/驳回）
- [ ] Webhook 签名验证（Hmac-SHA256，`FEISHU_VERIFY_TOKEN`）
- [ ] `services/feishu.py`：`send_alert_card()`、`send_approval_card()`、`update_card()`
- [ ] `docker-compose.yml` 添加 `opcua-mock-server` 服务
- [ ] 异常检测规则引擎（Phase A：阈值规则）写入数据库
- [ ] 告警触发 → 飞书卡片推送（用飞书 Webhook Bot 测试，不需要完整 App）
- [ ] 工单审批结果通过飞书回调更新状态（完整 HITL 闭环）

### 完成标准（Week 4 验收）

```
演示场景（手动触发）：
1. 调用 POST /v1/tools/anomaly/trigger（测试接口，dev only）模拟 C-001 告警
2. 飞书群收到告警卡片（含 P1/P2 级别、设备名、当前值）
3. 点击卡片「确认告警」按钮 → Platform Webhook 收到回调 → 状态更新 confirmed
4. 点击「建工单」→ 工单自动创建为 DRAFT → 发审批卡片给主管
5. 主管点击「通过」→ 状态变 APPROVED

验收截图要求：
  · 飞书卡片截图（告警卡片 + 审批卡片）
  · Platform 日志无 ERROR
  · audit_logs 有完整操作记录
```

---

## Week 5：Studio 前端框架

### 任务清单

- [ ] 复制 `maibot-ui` → `clawtwin-studio/`，删除无关页面
- [ ] 安装依赖：`@babylonjs/core@^7`, `zustand`, `axios`
- [ ] 新增路由：`/twin`, `/command`, `/admin/knowledge`, `/admin/equipment`
- [ ] `auth.store.ts` 实现 JWT 存储 + 从 LocalStorage 初始化
- [ ] `twin.store.ts` 实现 selectedEquipmentId + equipmentList
- [ ] `platformClient.ts` 封装 axios（自动注入 JWT，401 → 跳登录）
- [ ] `useEquipment` hook 实现（参考 MODULE-DESIGN-STUDIO.md 十）
- [ ] `TwinPage` 三栏布局骨架（左 Panel + 中 Canvas 占位 + 右 Panel）

### 完成标准（Week 5 验收）

```bash
cd clawtwin-studio
pnpm dev

# 浏览器打开：
# 1. http://localhost:5173/twin → 三栏布局可见，中间显示「3D 加载中...」
# 2. http://localhost:5173/command → 全屏布局骨架
# 3. http://localhost:5173/admin/knowledge → 页面框架可见
# 4. 无 JWT 访问 /twin → 跳转 /login
# 5. platformClient 请求 /v1/objects/stations → 200 正常（CORS 已配置）
```

---

## Week 6：Babylon.js 3D 场景

### 任务清单

- [ ] `TwinSurface.tsx` 初始化 Babylon.js Scene（WebGPU 降级到 WebGL）
- [ ] 从 Platform 获取设备列表，在 3D 场景中用彩色 Box 占位显示
- [ ] 设备状态颜色：NORMAL=绿、WARNING=黄、ALARM=红（StandardMaterial）
- [ ] 点击 Box → 右侧面板显示设备详情（useEquipment hook）
- [ ] HDRI 环境光（用 Polyhaven `industrial_sunset.hdr`）
- [ ] 场景自动旋转（演示模式，可点击取消）
- [ ] CommandPage：全屏 3D + 右侧 KPI Panel + 告警 Overlay

### 完成标准（Week 6 验收）

```
3D 场景演示：
1. 打开 /twin → 看到 5-8 个彩色 Box 代表设备
2. 点击红色 Box（模拟 C-001 ALARM）→ 右侧显示设备详情（含实时数据）
3. 右侧面板有「问 AI」和「建工单」按钮（点击后注入到 AI 对话框）
4. 10 秒后自动刷新设备状态（颜色可能变化）
5. 打开 /command → 全屏，右侧 KPI 数字，告警时红色提示
```

---

## Week 7：知识库 + OpenClaw Skills

### 任务清单

- [ ] `POST /v1/ingest/documents` 上传文档（先 L0 国家标准，如 GB/T 30094）
- [ ] 知识摄入 Pipeline：PDF → 分块 → Embedding → Milvus（参考 MODULE-DESIGN-PLATFORM.md 八）
- [ ] `POST /v1/tools/kb/search` 知识检索 API（含 citations）
- [ ] Admin KnowledgePage UI：上传 + 状态轮询 + 文档列表
- [ ] OpenClaw 安装 `industrial-twin` skill
- [ ] OpenClaw 安装 `industrial-kb` skill
- [ ] OpenClaw 安装 `industrial-workorder` skill
- [ ] 端到端测试：在飞书输入「C-001 振动多少？」→ OpenClaw 调用 Platform API → 返回实时数据

### 完成标准（Week 7 验收）

```
知识库测试：
1. 上传 PDF（如 GB 50251 输气管道工程设计规范节选）
2. Admin 页面显示状态变化：pending → processing → indexed
3. 调用 POST /v1/tools/kb/search {"query": "压缩机振动标准", "layer": "L0"}
   → 返回包含 citations 的结果

AI 对话测试：
飞书发送：「C-001 现在的压力是多少？」
期望返回：「设备：C-001 天然气压缩机
状态：⚠️ WARNING
出口压力：6.1 MPa（正常：5.8–6.5）
...
citations: [Ditto:C-001:2026-05-08T...]」
```

---

## Week 8：集成测试 + 演示准备

### 任务清单

- [ ] 端到端场景测试（全部 PASS）
- [ ] 安全检查（参考 ADR-6，覆盖 6 个安全场景）
- [ ] `docker compose up` 一键启动文档更新（包含端口映射、挂载说明）
- [ ] `docs/DEMO-SCRIPT.md` 演示剧本（5 分钟版本）
- [ ] `docs/INSTALL.md` 客户现场安装指南（简版）
- [ ] 性能基线：Platform API P99 < 200ms（curl 测试 20 次取 P99）
- [ ] 告警全链路延迟 < 10s（OPC-UA 数据变化 → 飞书收到卡片）

### 完成标准（Week 8 验收）

**必须全部通过的场景**：

```
场景 1：设备状态查询
  步骤：飞书输入「C-001 压力多少？」
  预期：AI 返回实时数据 + citations，10s 内响应

场景 2：异常检测告警
  步骤：mock server 推高 C-001 振动值超阈值
  预期：10s 内飞书收到 P2 告警卡片

场景 3：工单 HITL 闭环
  步骤：飞书输入「C-001 轴承异常，帮我建个工单」
  预期：AI 生成工单草稿 → 发审批卡片给主管 → 主管点通过 → 状态 APPROVED

场景 4：知识检索
  步骤：飞书输入「压缩机日常维护规范是什么？」
  预期：AI 返回带 citation（GB/T 文件名+段落）的答案

场景 5：安全验证
  步骤：无 JWT 访问 Platform API
  预期：401；跨场站访问 → 403

场景 6：大屏演示
  步骤：打开 /command 全屏
  预期：3D 场景 + KPI 自动刷新 + 告警时 Overlay 弹出
```

---

## 常见坑与解决方法

### 坑 1：Milvus 初始化失败

```bash
# 检查 etcd 是否就绪
docker compose logs etcd | grep "ready"
# 如果没有，重启 etcd 服务
docker compose restart etcd
# 等待 30 秒再启动 milvus
docker compose up milvus
```

### 坑 2：飞书 Webhook 签名验证失败

```
原因：服务器时间与飞书服务器时间差 > 5 分钟
解决：
  # 同步系统时间
  sudo ntpdate -u pool.ntp.org
  # 或在 Docker 容器中
  docker compose exec platform-api date
```

### 坑 3：OPC-UA 连接被拒绝

```
原因 1：安全证书不匹配
  解决：Phase A 用 Mock Server（Python asyncua），跳过证书问题

原因 2：Bridge 无法访问 OPC-UA IP
  解决：检查 Docker 网络，opcua-bridge 需要能访问 192.168.10.100

原因 3：SecurityMode 不匹配
  解决：Dev 环境设 OPCUA_SECURITY_MODE=None
```

### 坑 4：Babylon.js 白屏

```
原因 1：WebGPU 不支持（旧版 Chrome）
  解决：添加 fallback 到 WebGL（见 TwinSurface.tsx）

原因 2：Canvas 尺寸为 0
  解决：确保 canvas 父容器有明确高度（height: 100%），不能是 auto

原因 3：引擎未销毁导致内存泄漏
  解决：useEffect return 时调用 engine.dispose()
```

### 坑 5：JWT 过期导致 API 持续 401

```typescript
// platformClient.ts 加上 401 自动重试（刷新 token）
axiosInstance.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401) {
      // 清除本地 token
      useAuthStore.getState().logout();
      // 跳转登录
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);
```

### 坑 6：OpenClaw Skill 未触发

```
检查顺序：
1. skill 文件路径是否正确：contrib/industrial-oilgas-skills/industrial-twin/SKILL.md
2. openclaw config 是否加载了这个 skill 目录
3. skill 的 description 是否覆盖了用户的问法（语义匹配）
4. openclaw 日志中是否有 skill 加载记录
```

---

## 每日开发检查清单（PR 提交前）

```
□ 每个新 API 端点都有认证（require_current_user 或 require_station_access）
□ 关键操作写了 audit_log（create/approve/reject/delete）
□ 飞书 Webhook 有签名验证
□ 没有 station_id hardcode（从 user 权限获取）
□ 错误响应格式统一：{"error": "CODE", "message": "..."}
□ 外部服务调用（Ditto/Milvus/Feishu）有 try/except 和降级处理
□ 新增 Babylon.js 代码只在 surfaces/ 目录
□ citation 字段不为空就显示（不得省略）
```

---

## Phase A 成功定义

Week 8 结束时，以下全部成立：

1. **数据链路**：OPC-UA Mock → Kafka → Platform → PostgreSQL → `/v1/objects/equipment/{id}` 返回实时数据
2. **AI 对话**：飞书发问 → OpenClaw Skill → Platform API → 返回含 citations 答案 < 10s
3. **HITL 闭环**：异常 → 飞书告警 → 工单草稿 → 主管审批 → 状态更新，全程无人工干预（批示除外）
4. **3D 展示**：Studio `/twin` 和 `/command` 可用，设备状态颜色实时更新
5. **知识库**：至少 3 份工业标准文档已入库，检索有 citations
6. **安全**：6 个安全场景全部验证通过（见 ADR-6）
