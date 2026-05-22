# OpenClaw 安装与 ClawTwin Skills 配置指南

**适用场景**：从零在场站服务器上部署 OpenClaw Gateway，安装 ClawTwin 工业 Skills，接入飞书  
**前置条件**：Platform API 已启动（`docker compose up -d`），飞书 Bot 已创建

---

## 一、OpenClaw 安装

### 方式 A：Docker（推荐，与 Platform 统一部署）

```bash
# docker-compose.yml 中已包含 openclaw 服务（见 PHASE-A-SCAFFOLD.md §二）
docker compose up openclaw -d

# 查看日志
docker compose logs openclaw -f
```

### 方式 B：本机安装（Mac 开发环境）

```bash
# 安装 OpenClaw CLI（Node 22+）
npm install -g openclaw@latest   # 或 pnpm add -g openclaw@latest

# 验证安装
openclaw --version
```

---

## 二、飞书 Channel 配置

```bash
# 在 OpenClaw 配置目录中添加飞书 Channel
mkdir -p ~/.openclaw/channels/feishu
cat > ~/.openclaw/channels/feishu/config.json << 'EOF'
{
  "type": "feishu",
  "app_id": "<FEISHU_BOT_APP_ID>",
  "app_secret": "<FEISHU_BOT_APP_SECRET>",
  "base_url": "<FEISHU_BASE_URL>",
  "webhook_verify_token": "<FEISHU_VERIFY_TOKEN>"
}
EOF
# base_url 公有云留空，私有化飞书填内网地址（如 http://feishu.company.com）
```

**Docker 部署时的飞书配置**：

```yaml
# docker-compose.yml openclaw 服务的 environment
openclaw:
  environment:
    FEISHU_APP_ID: ${FEISHU_BOT_APP_ID}
    FEISHU_APP_SECRET: ${FEISHU_BOT_APP_SECRET}
    FEISHU_BASE_URL: ${FEISHU_BASE_URL:-}
    FEISHU_VERIFY_TOKEN: ${FEISHU_VERIFY_TOKEN}
```

---

## 三、安装 ClawTwin Industrial Skills

Skills 目录位于 `contrib/industrial-oilgas-skills/`（本仓库）。

```bash
# 将 Skills 目录链接到 OpenClaw 配置路径
# 方式 1：软链接（本地开发，实时修改）
ln -s /path/to/openclaw/contrib/industrial-oilgas-skills \
      ~/.openclaw/skills/clawtwin-industrial

# 方式 2：Docker 挂载（生产部署）
# docker-compose.yml 中已配置：
# volumes:
#   - ./contrib/industrial-oilgas-skills:/home/openclaw/.openclaw/skills/clawtwin-industrial

# 验证 Skills 已加载
openclaw skills list
# 期望输出：
# ✓ industrial-twin       读取设备实时状态
# ✓ industrial-kb         知识库检索
# ✓ industrial-workorder  工单生成与审批
# ✓ industrial-analytics  趋势分析与异常检测
# ✓ clawtwin-project      开发引导（开发环境专用）
```

---

## 四、配置 Skills 连接 Platform

每个 Skill 通过环境变量连接 Platform API。

```bash
# 在 OpenClaw 环境中设置（或写入 ~/.openclaw/.env）
export CLAWTWIN_PLATFORM_URL=http://platform-api:8080
export CLAWTWIN_OPENCLAW_SERVICE_TOKEN=<从 Platform 管理员获取>

# 如果 OpenClaw 在 Docker 内，platform-api 直接用服务名访问
# 如果 OpenClaw 在本机，改为 http://localhost:8080
```

**Docker 方式**（在 docker-compose.yml openclaw service 的 environment）：

```yaml
openclaw:
  environment:
    CLAWTWIN_PLATFORM_URL: http://platform-api:8080
    CLAWTWIN_OPENCLAW_SERVICE_TOKEN: ${OPENCLAW_SERVICE_TOKEN}
    # ⚠️ 不设置 OPENCLAW_WIKI_URL：L3 知识存于 Platform 自己的 PostgreSQL+Milvus
    # memory-wiki 是 OpenClaw CLI 工具（非 REST API），不用于工业 L3 知识存储
```

---

## 五、Service Token 生成

Platform 管理员在 Admin 页面（或通过 API）为 OpenClaw 实例生成 Service Token：

```bash
# 通过 API 生成 Service Token（sys_admin）
curl -X POST http://localhost:8080/v1/admin/service-tokens \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "openclaw-station-cng001",
    "description": "CNG-001 场站 OpenClaw 实例",
    "station_ids": ["STATION-CNG-001"]
  }'
# Response: { "token": "oc-xxx-yyy-zzz", "expires_at": null }

# 将 token 写入环境变量
export CLAWTWIN_OPENCLAW_SERVICE_TOKEN=oc-xxx-yyy-zzz
```

---

## 六、验证 Skill 连接 Platform

```bash
# 测试：直接调用 twin_read 工具（模拟 OpenClaw 调用）
curl -X POST http://localhost:8080/v1/tools/twin/read \
  -H "X-OpenClaw-Service-Token: oc-xxx-yyy-zzz" \
  -H "X-Feishu-OpenId: ou_test_user_123" \
  -H "Content-Type: application/json" \
  -d '{"equipment_id": "C-001"}'

# 期望输出：
# {
#   "equipment_id": "C-001",
#   "name": "天然气压缩机",
#   "status": "NORMAL",
#   "current": { "axial_vibration": {"value": 2.3, "unit": "mm/s"}, ... },
#   "citations": ["MockData:C-001:2026-05-08T..."]
# }
```

---

## 七、飞书 Webhook 回调地址配置

飞书开放平台需要配置 OpenClaw 的接收地址：

```
# OpenClaw 飞书事件接收地址（飞书开放平台 → 事件订阅）
公有云飞书：https://your-domain.com/ai/feishu/events
私有化飞书：http://internal-server/ai/feishu/events（内网直连）

# 飞书卡片回调地址（Platform 处理审批，不经过 OpenClaw）
https://your-domain.com/v1/feishu/webhook
或（私有化）：http://internal-server/v1/feishu/webhook
```

**两条独立通道**：

- 飞书 → OpenClaw：AI 对话消息（`/ai/feishu/events`）
- 飞书 → Platform：卡片按钮回调（`/v1/feishu/webhook`，HITL 审批）

---

## 八、用户飞书绑定流程

1. Admin 在 Studio `/admin/users` 创建用户（工号+初始密码+角色+场站）
2. Admin 点击「发送绑定邀请」→ 系统生成绑定链接（15 分钟有效）
3. 用户打开链接 `studio.clawtwin.local/bind?token=xxx`
4. 用户输入工号+密码登录 → 自动绑定飞书身份 → 跳转 Studio
5. 此后用户在飞书发的消息会关联到其 Platform 账号（ABAC 权限生效）

---

## 九、运行验证清单

```bash
# 1. OpenClaw 启动正常
curl http://localhost:3000/health
# 期望：{"status": "ok"}

# 2. Skills 已加载
openclaw skills list | grep industrial
# 期望：4 个 industrial-* skill

# 3. Platform 连通性
curl -H "X-OpenClaw-Service-Token: oc-xxx" \
     http://localhost:8080/v1/health
# 期望：{"status": "ok", ...}

# 4. 飞书消息路由（发一条消息，OpenClaw 应该收到）
# 在飞书中 @ OpenClaw Bot 发「测试」
# 查看 OpenClaw 日志：docker compose logs openclaw | tail -20

# 5. 工具调用端到端
# 在飞书发「C-001 现在压力多少？」
# 期望：OpenClaw 调用 industrial-twin Skill → 返回设备数据 + citations
```

---

## 十、常见问题

### OpenClaw 找不到 Skill

```
原因：SKILL.md 路径不对，或 SKILL.md 格式有误
检查：ls ~/.openclaw/skills/clawtwin-industrial/industrial-twin/SKILL.md
     openclaw skills list --debug
```

### Platform 返回 403（Service Token 无效）

```
原因：CLAWTWIN_OPENCLAW_SERVICE_TOKEN 与 Platform 数据库中存储的不匹配
解决：重新通过 POST /v1/admin/service-tokens 生成并更新环境变量
```

### 飞书消息未送达 OpenClaw

```
公有云飞书：检查 Webhook URL 是否可从公网访问（用 curl 测试）
私有化飞书：检查飞书服务器到 OpenClaw 的网络路由
     检查：curl -X POST http://openclaw:3000/feishu/events -d '{"type": "url_verification", "token": "xxx"}'
```

### 工单审批卡片按钮点击无响应

```
原因：Platform Webhook 地址未配置，或签名验证失败
检查：
  1. FEISHU_VERIFY_TOKEN 是否与飞书开放平台配置一致
  2. Platform 日志：docker compose logs platform-api | grep webhook
  3. 飞书开放平台 → 事件与回调 → 查看最近回调记录
```
