# OpenClaw Docker + Discord 安装与调试手册（v2026.2.15）

本文档记录了当前这套环境中，如何使用 Docker 安装并运行 OpenClaw，以及如何完成 Discord 通道接入与常见问题排查。

本手册基于稳定发布标签：`v2026.2.15`  
发布页：<https://github.com/openclaw/openclaw/releases/tag/v2026.2.15>

## 1. 前置条件

- 已安装并启动 Docker Desktop（或 OrbStack）
- 本机可访问 GitHub（拉取依赖和镜像元数据）
- 已准备 Discord Bot Token
- OpenClaw 项目目录为：`/Users/tjp/projects/openclaw/openclaw`

## 2. 切到稳定版本

在项目根目录执行：

```bash
cd /Users/tjp/projects/openclaw/openclaw
git fetch --tags
git switch -c stable-v2026.2.15 v2026.2.15
```

验证：

```bash
git describe --tags --exact-match
git rev-parse --short HEAD
```

期望输出标签为 `v2026.2.15`。

## 3. Docker 构建与网关启动

### 3.1 构建镜像

```bash
cd /Users/tjp/projects/openclaw/openclaw
docker build -t openclaw:local -f Dockerfile .
```

### 3.2 非交互初始化

```bash
docker compose run --rm openclaw-cli onboard \
  --non-interactive \
  --accept-risk \
  --flow quickstart \
  --mode local \
  --auth-choice skip \
  --gateway-bind lan \
  --gateway-auth token \
  --gateway-token "<YOUR_GATEWAY_TOKEN>" \
  --skip-channels \
  --skip-skills \
  --skip-daemon \
  --skip-ui \
  --skip-health
```

### 3.3 启动网关

```bash
docker compose up -d openclaw-gateway
docker compose ps
```

默认端口映射：

- `18789`：Control UI / Gateway
- `18790`：Bridge

## 4. Control UI 未授权问题（1008 token missing）

如果浏览器或客户端提示：

`unauthorized: gateway token missing (open the dashboard URL and paste the token in Control UI settings)`

使用下面命令生成带 token 的控制台地址：

```bash
docker compose run --rm openclaw-cli dashboard
```

然后直接打开类似以下地址（注意 `#token=` 段）：

`http://127.0.0.1:18789/#token=<YOUR_GATEWAY_TOKEN>`

## 5. Discord 通道配置

> 在 `v2026.2.15` 中，很多 bundled 插件默认是 disabled，需要先启用。

### 5.1 启用 Discord 插件

```bash
docker compose run --rm openclaw-cli plugins enable discord
docker compose restart openclaw-gateway
```

### 5.2 写入 Discord Bot Token

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<DISCORD_BOT_TOKEN>"
docker compose restart openclaw-gateway
```

### 5.3 验证 Discord 已登录

```bash
docker logs --tail 120 openclaw-openclaw-gateway-1
```

日志中看到类似内容表示成功：

- `starting provider`
- `logged in to discord as <bot_id>`

### 5.4 查看通道状态

```bash
docker compose run --rm openclaw-cli channels status
docker compose run --rm openclaw-cli channels list --json
```

## 6. WhatsApp 说明（当前不配置）

当前策略是**不再配置 WhatsApp**。

如果曾经启动过登录流程（等待扫码），可直接停止：

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
docker stop <whatsapp_login_container_name>
```

后续只保留 Discord 通道即可。

## 7. 常用调试命令速查

```bash
# 查看网关状态
docker compose ps

# 实时查看网关日志
docker compose logs -f openclaw-gateway

# 查看插件状态
docker compose run --rm openclaw-cli plugins list --json

# 查看通道状态（配置 + 探针）
docker compose run --rm openclaw-cli channels status --probe --json

# 重启网关
docker compose restart openclaw-gateway

# 停止网关
docker compose down
```

## 8. 本次实践的关键经验

- 稳定标签构建比直接使用 `main` 更可控。
- `channels add --channel discord/whatsapp` 报 `Unknown channel` 时，优先检查插件是否启用。
- Control UI 必须带 token 登录，否则会持续报 `1008 unauthorized`。
- `channels status` 失败时，优先看网关容器日志判断是认证问题、配对问题，还是插件/配置问题。
