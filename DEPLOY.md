# OpenClaw 部署指南

## 概述

OpenClaw 是一个多渠道 AI 网关，支持通过 Web UI、飞书、Telegram、Discord 等渠道与 AI 模型交互。

- 仓库：https://github.com/openclaw/openclaw
- 文档：https://docs.openclaw.ai
- 私有镜像：https://git.leot.fun/leotwang/openclaw

---

## 服务器信息

| 项目 | 详情 |
|---|---|
| 服务器 | `c.leot.fun`（`118.195.136.73`） |
| 分配域名 | `claw.leot.fun` |
| Web UI | https://claw.leot.fun |
| 反代方案 | Podman + nginx-proxy + acme-companion（自动 HTTPS） |
| 容器网络 | `proxy-network` |
| 资源 | 2 核 / 3.7G 内存 / 50G 磁盘 |
| 境外代理 | `66.42.94.13:18888`（Vultr，tinyproxy，解决 API 地区限制） |
| Git 仓库 | https://git.leot.fun/leotwang/openclaw |
| Registry | `registry.leot.fun`（用户: `leot`） |

---

## 本地环境准备

### 安装 Podman（Windows）

```bash
# 安装 scoop（无需管理员权限）
powershell -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; irm get.scoop.sh | iex"

# 刷新 PATH 后安装 podman
scoop install podman

# 初始化 Podman Machine（基于 WSL）
podman machine init
podman machine start
```

### 登录私有 Registry

```bash
podman login registry.leot.fun -u leot -p <registry-password>
```

> Registry 凭据存储在服务器 `/opt/leot_svr/secrets/registry.env`

---

## 构建 & 推送镜像

> 服务器配置较低，构建在本地完成，推送到私有 Registry。

```bash
cd d:/work/openclaw

# 本地构建
podman build -t registry.leot.fun/openclaw:latest .

# 推送到 Registry
podman push registry.leot.fun/openclaw:latest
```

构建耗时约 5-10 分钟，镜像大小约 4.5GB。

---

## 服务器部署

### 1. SSH 连接

```bash
ssh root@c.leot.fun
```

### 2. 创建数据目录

```bash
mkdir -p /opt/leot_svr/data/openclaw/config
mkdir -p /opt/leot_svr/data/openclaw/workspace
```

### 3. 拉取镜像

```bash
# 先登录 Registry
podman login registry.leot.fun -u leot -p <registry-password>

# 拉取镜像
podman pull registry.leot.fun/openclaw:latest
```

### 4. 生成 Gateway Token

```bash
OPENCLAW_TOKEN=$(openssl rand -hex 32)
echo "$OPENCLAW_TOKEN" > /opt/leot_svr/data/openclaw/.gateway_token
echo "Gateway Token: $OPENCLAW_TOKEN"
# 记下来，登录 Web UI 需要
```

### 5. 运行 Onboard 配置

```bash
podman run --rm \
  --network proxy-network \
  -v /opt/leot_svr/data/openclaw/config:/home/node/.openclaw \
  -v /opt/leot_svr/data/openclaw/workspace:/home/node/.openclaw/workspace \
  -e HOME=/home/node \
  registry.leot.fun/openclaw:latest \
  node dist/index.js onboard \
    --non-interactive \
    --accept-risk \
    --auth-choice openrouter-api-key \
    --openrouter-api-key <your-openrouter-key> \
    --no-install-daemon
```

> Onboard 完成后需要修复目录权限和同步 Token：

```bash
# 修复权限（容器内 node 用户 uid=1000）
chown -R 1000:1000 /opt/leot_svr/data/openclaw

# 将 Gateway Token 写入配置文件（配置文件优先于环境变量）
OPENCLAW_TOKEN=$(cat /opt/leot_svr/data/openclaw/.gateway_token)
sed -i "s|\"token\": \".*\"|\"token\": \"$OPENCLAW_TOKEN\"|" /opt/leot_svr/data/openclaw/config/openclaw.json
```

### 6. 启动 Gateway

```bash
OPENCLAW_TOKEN=$(cat /opt/leot_svr/data/openclaw/.gateway_token)

podman run -d \
  --name openclaw-gateway \
  --restart unless-stopped \
  --network proxy-network \
  --memory 1g \
  -v /opt/leot_svr/data/openclaw/config:/home/node/.openclaw \
  -v /opt/leot_svr/data/openclaw/workspace:/home/node/.openclaw/workspace \
  -e HOME=/home/node \
  -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_TOKEN \
  -e OPENROUTER_API_KEY=<your-openrouter-key> \
  -e HTTPS_PROXY=http://66.42.94.13:18888 \
  -e HTTP_PROXY=http://66.42.94.13:18888 \
  -e NO_PROXY=localhost,127.0.0.1,10.89.0.0/16 \
  -e VIRTUAL_HOST=claw.leot.fun \
  -e LETSENCRYPT_HOST=claw.leot.fun \
  -e LETSENCRYPT_EMAIL=admin@leot.fun \
  -e VIRTUAL_PORT=18789 \
  registry.leot.fun/openclaw:latest \
  node --max-old-space-size=768 dist/index.js gateway --bind lan --port 18789 --allow-unconfigured
```

**参数说明：**

| 参数 | 作用 |
|---|---|
| `VIRTUAL_HOST` + `LETSENCRYPT_HOST` | nginx-proxy 自动反代 + 自动 HTTPS 证书 |
| `VIRTUAL_PORT=18789` | nginx-proxy 转发到容器 18789 端口 |
| `--memory 1g` | 容器最大内存 1GB |
| `--max-old-space-size=768` | Node.js 堆内存限制 768MB |
| `--bind lan` | 绑定到局域网接口（容器网络需要） |
| `--allow-unconfigured` | 允许未完全配置时启动 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 通过境外代理访问 OpenRouter API，绕过地区限制 |
| `NO_PROXY` | 本地和容器网络内流量不走代理 |

### 7. 验证

```bash
# 检查容器状态
podman ps --filter name=openclaw

# 查看日志
podman logs -f openclaw-gateway

# 容器内部验证
podman inspect openclaw-gateway --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# 用返回的 IP 测试
curl -s -o /dev/null -w "%{http_code}" http://<container-ip>:18789
# 应返回 200

# 外网 HTTPS 验证
curl -s -o /dev/null -w "%{http_code}" https://claw.leot.fun
# 应返回 200
```

---

## 首次登录 Web UI

### 注意事项

1. 打开 https://claw.leot.fun
2. 在 Overview 页面的 **Gateway Token** 输入框中粘贴 Token（注意不要有多余空格）
3. 点击 **Connect**
4. 首次连接会触发 **设备配对（pairing）**，需要在服务器上批准：

```bash
# 查看待批准设备
podman exec openclaw-gateway node dist/index.js devices list

# 批准设备
podman exec openclaw-gateway node dist/index.js devices approve <request-id>
```

也可以通过 URL 参数直接传入 Token：

```
https://claw.leot.fun?token=<your-gateway-token>
```

---

## 模型配置

所有模型通过同一个 OpenRouter API Key 调用，统一计费。

获取 Key：https://openrouter.ai/keys

### 当前配置

编辑 `/opt/leot_svr/data/openclaw/config/openclaw.json`，修改 `agents.defaults.model`：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/anthropic/claude-sonnet-4.5",
        "fallbacks": ["openrouter/google/gemini-2.5-flash-preview"]
      },
      "subagents": {
        "model": "openrouter/anthropic/claude-sonnet-4.5",
        "thinking": "low"
      }
    }
  }
}
```

> **选型说明：** Claude Sonnet 4.5 能力强，适合复杂对话和编码。需要境外代理才能使用（见启动命令中的 `HTTPS_PROXY`）。Gemini 2.5 Flash 作为 fallback。需要省钱时在聊天中 `/model deepseek` 切到 DeepSeek V3.2（$0.25/M tokens，Claude 的 1/12）。

> **注意：** OpenRouter 模型 ID 用点号不用横线，如 `claude-sonnet-4.5`（不是 `claude-sonnet-4-5`），`deepseek-v3.2`（不是 `deepseek-v3-0324`）。

修改后重启容器：`podman restart openclaw-gateway`

### 聊天中切换模型

| 命令 | 效果 |
|---|---|
| `/model` | 查看当前模型 |
| `/model list` | 列出所有可用模型 |
| `/model claude-sonnet-4` | 临时切到 Claude |
| `/model deepseek` | 切回 DeepSeek |

> `/model` 切换仅影响当前会话，不改全局配置。

---

## 运维命令

```bash
# 查看状态
podman ps --filter name=openclaw

# 查看日志
podman logs -f openclaw-gateway

# 查看资源占用
podman stats --no-stream openclaw-gateway

# 重启
podman restart openclaw-gateway

# 停止
podman stop openclaw-gateway

# 查看设备列表
podman exec openclaw-gateway node dist/index.js devices list

# 查看 Skills
podman exec openclaw-gateway node dist/index.js skills list
```

### 更新部署

```bash
# === 本地 ===
cd d:/work/openclaw
podman build -t registry.leot.fun/openclaw:latest .
podman push registry.leot.fun/openclaw:latest

# === 服务器 ===
podman pull registry.leot.fun/openclaw:latest
podman stop openclaw-gateway && podman rm openclaw-gateway
# 重新执行启动命令（步骤 6）
```

---

## DNS 配置

`claw.leot.fun` 需要 CNAME 指向 `c.leot.fun`（或 A 记录指向 `118.195.136.73`）。

DNS 生效后，nginx-proxy-acme 会自动申请 Let's Encrypt 证书。如果证书未自动生成：

```bash
podman restart nginx-proxy-acme
# 查看证书申请日志
podman logs --tail 30 nginx-proxy-acme | grep claw
# 确认证书文件
ls -la /opt/leot_svr/data/gateway/nginx-certs/claw.leot.fun*
```

---

## Swap 配置（推荐）

服务器内存 3.7G，建议加 Swap 防止 OOM：

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 访问方式

| 方式 | 说明 | 国内可用 |
|---|---|---|
| **Web UI** | https://claw.leot.fun ，用 Gateway Token 登录 | 直接用 |
| **飞书** | 内置飞书插件，支持私聊/群聊 | 直接用 |
| Telegram | 需配置 Bot Token | 需翻墙 |
| Discord | 需配置 Bot Token | 需翻墙 |

飞书接入文档：https://docs.openclaw.ai/channels/feishu

---

## 故障排查

### Gateway OOM

如果日志出现 `FATAL ERROR: Reached heap limit Allocation failed`：
- 增大 `--max-old-space-size`（当前 768MB）
- 增大容器 `--memory` 限制（当前 1GB）
- 确保已配置 Swap

### 设备认证失败 (device token mismatch)

1. 确认 Token 无多余空格
2. 确认 `openclaw.json` 中的 `gateway.auth.token` 与输入的 Token 一致
3. 清除浏览器 localStorage 后重试：
   ```javascript
   localStorage.removeItem('openclaw.device.auth.v1');
   localStorage.removeItem('openclaw-device-identity-v1');
   location.reload();
   ```

### HTTPS 502

1. 检查 DNS 解析：`dig claw.leot.fun +short` 应指向 `118.195.136.73`
2. 检查容器是否运行：`podman ps --filter name=openclaw`
3. 重启 nginx-proxy：`podman restart nginx-proxy`

### 模型地区限制 (403 not available in your region)

Anthropic (Claude) 等模型对中国 IP 有地区限制。解决方案：通过境外代理转发 API 请求。

当前架构：
```
国内 OpenClaw 容器 --HTTPS_PROXY--> 66.42.94.13 (tinyproxy) --> openrouter.ai
```

境外代理配置（`66.42.94.13`，CentOS 7）：
```bash
# tinyproxy 配置文件: /etc/tinyproxy/tinyproxy.conf
# 端口: 18888，仅允许国内服务器 IP (118.195.136.73) 访问
# 防火墙: firewalld rich rule 限制来源 IP
systemctl status tinyproxy
firewall-cmd --list-rich-rules
```

如果代理不通：
1. 检查境外服务器 tinyproxy 是否运行：`ssh root@66.42.94.13 systemctl status tinyproxy`
2. 从国内服务器测试连通性：`curl -s --proxy http://66.42.94.13:18888 https://openrouter.ai/api/v1/models -o /dev/null -w '%{http_code}'`（应返回 200）
3. 检查防火墙规则：`ssh root@66.42.94.13 firewall-cmd --list-rich-rules`

---

## 关键文件路径

| 路径 | 说明 |
|---|---|
| `/opt/leot_svr/data/openclaw/config/openclaw.json` | 主配置文件 |
| `/opt/leot_svr/data/openclaw/.gateway_token` | Gateway Token |
| `/opt/leot_svr/data/openclaw/workspace/` | Agent 工作目录 |
| `/opt/leot_svr/data/openclaw/workspace/SOUL.md` | Agent 人格/语言设置 |
| `/opt/leot_svr/secrets/registry.env` | Registry 凭据 |
