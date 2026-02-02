---
description: Deploy OpenClaw on Fly.io
title: Fly.io
x-i18n:
  generated_at: "2026-02-01T21:21:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a00bae43e416112eb269126445c51492a30abe9e136d89e161fc4193314a876f
  source_path: platforms/fly.md
  workflow: 15
---

# Fly.io 部署

**目标：** 在 [Fly.io](https://fly.io) 机器上运行 OpenClaw Gateway网关，配备持久化存储、自动 HTTPS 和 Discord/渠道访问。

## 你需要什么

- 已安装 [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/)
- Fly.io 账户（免费套餐即可）
- 模型认证：Anthropic API 密钥（或其他提供商密钥）
- 渠道凭据：Discord 机器人令牌、Telegram 令牌等

## 新手快速路径

1. 克隆仓库 → 自定义 `fly.toml`
2. 创建应用 + 卷 → 设置密钥
3. 使用 `fly deploy` 部署
4. 通过 SSH 创建配置或使用控制面板 UI

## 1）创建 Fly 应用

```bash
# 克隆仓库
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 创建新的 Fly 应用（选择你自己的名称）
fly apps create my-openclaw

# 创建持久化卷（1GB 通常足够）
fly volumes create openclaw_data --size 1 --region iad
```

**提示：** 选择离你最近的区域。常见选项：`lhr`（伦敦）、`iad`（弗吉尼亚）、`sjc`（圣何塞）。

## 2）配置 fly.toml

编辑 `fly.toml` 以匹配你的应用名称和需求。

**安全提示：** 默认配置会暴露公共 URL。如需无公网 IP 的加固部署，请参阅[私有部署](#私有部署加固)或使用 `fly.private.toml`。

```toml
app = "my-openclaw"  # 你的应用名称
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**关键设置：**

| 设置                           | 原因                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `--bind lan`                   | 绑定到 `0.0.0.0`，使 Fly 的代理能够访问 Gateway网关                       |
| `--allow-unconfigured`         | 无需配置文件即可启动（之后再创建）                                        |
| `internal_port = 3000`         | 必须与 `--port 3000`（或 `OPENCLAW_GATEWAY_PORT`）匹配，用于 Fly 健康检查 |
| `memory = "2048mb"`            | 512MB 太小；推荐 2GB                                                      |
| `OPENCLAW_STATE_DIR = "/data"` | 将状态持久化到卷上                                                        |

## 3）设置密钥

```bash
# 必需：Gateway网关令牌（用于非 local loopback 绑定）
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# 模型提供商 API 密钥
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 可选：其他提供商
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# 渠道令牌
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**注意事项：**

- 非 local loopback 绑定（`--bind lan`）出于安全需要 `OPENCLAW_GATEWAY_TOKEN`。
- 请像对待密码一样对待这些令牌。
- **所有 API 密钥和令牌优先使用环境变量而非配置文件**。这样可以避免密钥出现在 `openclaw.json` 中，防止意外暴露或被记录到日志。

## 4）部署

```bash
fly deploy
```

首次部署会构建 Docker 镜像（约 2-3 分钟）。后续部署会更快。

部署后验证：

```bash
fly status
fly logs
```

你应该看到：

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5）创建配置文件

通过 SSH 连接到机器以创建正式配置：

```bash
fly ssh console
```

创建配置目录和文件：

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**注意：** 当 `OPENCLAW_STATE_DIR=/data` 时，配置路径为 `/data/openclaw.json`。

**注意：** Discord 令牌可以来自：

- 环境变量：`DISCORD_BOT_TOKEN`（推荐用于密钥）
- 配置文件：`channels.discord.token`

如果使用环境变量，无需在配置中添加令牌。Gateway网关会自动读取 `DISCORD_BOT_TOKEN`。

重启以应用配置：

```bash
exit
fly machine restart <machine-id>
```

## 6）访问 Gateway网关

### 控制面板 UI

在浏览器中打开：

```bash
fly open
```

或访问 `https://my-openclaw.fly.dev/`

粘贴你的 Gateway网关令牌（即 `OPENCLAW_GATEWAY_TOKEN` 的值）进行认证。

### 日志

```bash
fly logs              # 实时日志
fly logs --no-tail    # 最近的日志
```

### SSH 控制台

```bash
fly ssh console
```

## 故障排除

### "App is not listening on expected address"

Gateway网关绑定到了 `127.0.0.1` 而不是 `0.0.0.0`。

**修复：** 在 `fly.toml` 的进程命令中添加 `--bind lan`。

### 健康检查失败 / 连接被拒绝

Fly 无法通过配置的端口访问 Gateway网关。

**修复：** 确保 `internal_port` 与 Gateway网关端口匹配（设置 `--port 3000` 或 `OPENCLAW_GATEWAY_PORT=3000`）。

### 内存不足（OOM）/ 内存问题

容器持续重启或被终止。迹象：`SIGABRT`、`v8::internal::Runtime_AllocateInYoungGeneration` 或无声重启。

**修复：** 在 `fly.toml` 中增加内存：

```toml
[[vm]]
  memory = "2048mb"
```

或更新现有机器：

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**注意：** 512MB 太小。1GB 可能可以工作但在负载或详细日志记录下可能 OOM。**推荐 2GB。**

### Gateway网关锁文件问题

Gateway网关拒绝启动并报"already running"错误。

这发生在容器重启但 PID 锁文件在卷上持久保留时。

**修复：** 删除锁文件：

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

锁文件位于 `/data/gateway.*.lock`（不在子目录中）。

### 配置未被读取

如果使用 `--allow-unconfigured`，Gateway网关会创建一个最小配置。你在 `/data/openclaw.json` 的自定义配置应在重启后被读取。

验证配置是否存在：

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### 通过 SSH 写入配置

`fly ssh console -C` 命令不支持 shell 重定向。要写入配置文件：

```bash
# 使用 echo + tee（从本地管道到远程）
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# 或使用 sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**注意：** 如果文件已存在，`fly sftp` 可能会失败。请先删除：

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### 状态未持久化

如果重启后凭据或会话丢失，说明状态目录写入了容器文件系统。

**修复：** 确保 `fly.toml` 中设置了 `OPENCLAW_STATE_DIR=/data` 并重新部署。

## 更新

```bash
# 拉取最新更改
git pull

# 重新部署
fly deploy

# 检查健康状态
fly status
fly logs
```

### 更新机器命令

如果需要在不完全重新部署的情况下更改启动命令：

```bash
# 获取机器 ID
fly machines list

# 更新命令
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# 或同时增加内存
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**注意：** `fly deploy` 后，机器命令可能会重置为 `fly.toml` 中的内容。如果你做了手动更改，请在部署后重新应用。

## 私有部署（加固）

默认情况下，Fly 分配公网 IP，使你的 Gateway网关可通过 `https://your-app.fly.dev` 访问。这很方便，但意味着你的部署可被互联网扫描器（Shodan、Censys 等）发现。

如需**无公网暴露**的加固部署，请使用私有模板。

### 何时使用私有部署

- 你只进行**出站**调用/消息（无入站 webhook）
- 你使用 **ngrok 或 Tailscale** 隧道处理 webhook 回调
- 你通过 **SSH、代理或 WireGuard** 访问 Gateway网关而非浏览器
- 你希望部署**对互联网扫描器不可见**

### 设置

使用 `fly.private.toml` 代替标准配置：

```bash
# 使用私有配置部署
fly deploy -c fly.private.toml
```

或转换现有部署：

```bash
# 列出当前 IP
fly ips list -a my-openclaw

# 释放公网 IP
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# 切换到私有配置，使未来的部署不再分配公网 IP
# （移除 [http_service] 或使用私有模板部署）
fly deploy -c fly.private.toml

# 分配仅私有的 IPv6
fly ips allocate-v6 --private -a my-openclaw
```

之后，`fly ips list` 应该只显示 `private` 类型的 IP：

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### 访问私有部署

由于没有公网 URL，请使用以下方法之一：

**方案 1：本地代理（最简单）**

```bash
# 将本地端口 3000 转发到应用
fly proxy 3000:3000 -a my-openclaw

# 然后在浏览器中打开 http://localhost:3000
```

**方案 2：WireGuard VPN**

```bash
# 创建 WireGuard 配置（一次性）
fly wireguard create

# 导入到 WireGuard 客户端，然后通过内部 IPv6 访问
# 示例：http://[fdaa:x:x:x:x::x]:3000
```

**方案 3：仅 SSH**

```bash
fly ssh console -a my-openclaw
```

### 私有部署中的 Webhook

如果你需要 webhook 回调（Twilio、Telnyx 等）但不想公网暴露：

1. **ngrok 隧道** - 在容器内或作为 sidecar 运行 ngrok
2. **Tailscale Funnel** - 通过 Tailscale 暴露特定路径
3. **仅出站** - 某些提供商（Twilio）在无 webhook 的情况下也能正常进行出站呼叫

使用 ngrok 的语音通话配置示例：

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" }
        }
      }
    }
  }
}
```

ngrok 隧道在容器内运行，提供公共 webhook URL 而不暴露 Fly 应用本身。

### 安全优势

| 方面             | 公网     | 私有     |
| ---------------- | -------- | -------- |
| 互联网扫描器     | 可被发现 | 隐藏     |
| 直接攻击         | 可能     | 被阻止   |
| 控制面板 UI 访问 | 浏览器   | 代理/VPN |
| Webhook 投递     | 直接     | 通过隧道 |

## 注意事项

- Fly.io 使用 **x86 架构**（非 ARM）
- Dockerfile 兼容两种架构
- WhatsApp/Telegram 新手引导请使用 `fly ssh console`
- 持久化数据存储在 `/data` 卷上
- Signal 需要 Java + signal-cli；请使用自定义镜像并保持内存在 2GB+ 以上。

## 费用

使用推荐配置（`shared-cpu-2x`，2GB RAM）：

- 每月约 $10-15，取决于使用量
- 免费套餐包含一定额度

详情参见 [Fly.io 定价](https://fly.io/docs/about/pricing/)。
