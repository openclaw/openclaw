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
| 境外代理 | Shadowsocks 加密代理（宿主机 sslocal-rust → `nas.bucky.pub:6444`），解决 API 地区限制和 GFW 封锁 |
| 旧代理（备用） | `66.42.94.13:18888`（Vultr，tinyproxy，仅适用于未被 GFW 封锁的域名如 OpenRouter） |
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
  -v /opt/leot_svr/tools/bin:/opt/tools:ro \
  -e PATH=/opt/tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e HOME=/home/node \
  -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_TOKEN \
  -e NODE_OPTIONS='--require /home/node/.openclaw/set-proxy.js' \
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
| `NODE_OPTIONS` | 通过 `--require` 注入代理脚本，仅 Node 进程内部设置 `HTTPS_PROXY`（见下方说明） |
| `-v .../tools/bin:/opt/tools:ro` | 只读挂载外部 CLI 工具目录 |
| `-e PATH=/opt/tools:...` | 让容器内直接找到挂载的工具 |

> **代理隔离机制**：不在容器环境变量中设置 `HTTPS_PROXY`，而是通过 `NODE_OPTIONS=--require set-proxy.js` 仅在 Node.js 进程内部注入代理变量。`set-proxy.js` 同时拦截 `child_process` 的所有 spawn/exec 方法，在子进程环境中剥掉代理变量。
>
> 效果：
> - AI 模型调用（`pi-ai` 库内置的 `proxy-agent`）→ 读 `process.env.HTTPS_PROXY` → **走 SS 代理**
> - Telegram API → 通过 `channels.telegram.proxy` 配置 → **走 SS 代理**
> - Agent 执行的 CLI 工具（curl、calc-cli 等）→ 子进程无代理变量 → **直连**
>
> 代理脚本路径：`/home/node/.openclaw/set-proxy.js`（宿主机 `/opt/leot_svr/data/openclaw/config/set-proxy.js`）

> **trustedProxies 配置**：Gateway 通过 nginx-proxy 反代时，需要在 `openclaw.json` 中配置 `gateway.trustedProxies`，否则日志会出现 `Proxy headers detected from untrusted address`，导致设备配对和认证异常。当前配置：
>
> ```json
> "trustedProxies": ["10.89.0.0/16"]
> ```
>
> 如果 onboard 生成的配置文件中 `gateway.bind` 为 `loopback`，需手动改为 `lan`（与启动命令一致）。

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
        "fallbacks": ["openrouter/google/gemini-2.5-flash"]
      },
      "models": {
        "openrouter/auto": { "alias": "OpenRouter Auto" },
        "openrouter/anthropic/claude-sonnet-4.5": { "alias": "Claude Sonnet 4.5" },
        "openrouter/anthropic/claude-opus-4.6": { "alias": "Claude Opus 4.6" },
        "openrouter/google/gemini-2.5-flash": { "alias": "Gemini 2.5 Flash" },
        "openrouter/google/gemini-3-flash-preview": { "alias": "Gemini 3 Flash" },
        "openrouter/deepseek/deepseek-v3.2": { "alias": "DeepSeek V3.2" },
        "openrouter/deepseek/deepseek-r1-0528": { "alias": "DeepSeek R1" },
        "openrouter/x-ai/grok-4.1-fast": { "alias": "Grok 4.1 Fast" },
        "openrouter/moonshotai/kimi-k2.5": { "alias": "Kimi K2.5" }
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

> **注意：** OpenRouter 模型 ID 格式是 `openrouter/vendor/model`（三段式），如 `openrouter/deepseek/deepseek-v3.2`、`openrouter/anthropic/claude-sonnet-4.5`。不要省略 vendor 前缀（如 ~~`openrouter/deepseek-v3.2`~~ 是错的）。

> **注意：** `agents.defaults.models` 一旦配置就会变成**模型允许列表**（代码：`src/agents/model-selection.ts` `buildConfiguredAllowlistKeys`）。只有列在里面的模型才能通过 `/model` 切换。新增模型需要同时加到这个列表里。

修改后重启容器：`podman restart openclaw-gateway`

### 可用模型一览

| `/model` 命令 | 模型 | 输入价格 | 输出价格 | 适合场景 |
|---|---|---|---|---|
| `/model claude-sonnet` | Claude Sonnet 4.5 | $3.00/M | $15.00/M | 编码、复杂推理（默认） |
| `/model claude-opus` | Claude Opus 4.6 | $5.00/M | $25.00/M | 最强，长难任务 |
| `/model gemini-2.5` | Gemini 2.5 Flash | $0.30/M | $2.50/M | 通用，性价比好 |
| `/model gemini-3` | Gemini 3 Flash | $0.50/M | $3.00/M | 最新推理模型，1M 上下文 |
| `/model deepseek` | DeepSeek V3.2 | $0.25/M | $0.38/M | 最便宜，日常对话 |
| `/model deepseek-r1` | DeepSeek R1 | $0.50/M | $2.18/M | 深度推理 |
| `/model grok` | Grok 4.1 Fast | $0.20/M | $0.50/M | 超便宜，2M 上下文 |
| `/model kimi` | Kimi K2.5 | $0.45/M | $2.25/M | 编码能力强 |

### 聊天中切换模型

| 命令 | 效果 |
|---|---|
| `/model` | 查看当前模型 |
| `/model list` | 列出所有可用模型 |
| `/model claude-sonnet` | 切到 Claude Sonnet 4.5 |
| `/model deepseek` | 切到 DeepSeek V3.2 |
| `/model grok` | 切到 Grok 4.1 Fast |

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
| **Telegram** | 内置插件，需配置 Bot Token，通过 SS 代理访问 | 直接用（服务端代理） |
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

此错误表示浏览器本地存储的**设备密钥对**与服务器端的配对记录不匹配，不是 Gateway Token 本身的问题。

**快速修复**（浏览器端）：

1. 用**无痕/隐私模式**打开 https://claw.leot.fun ，重新输入 Gateway Token
2. 或在浏览器 F12 控制台执行：
   ```javascript
   localStorage.clear();
   location.reload();
   ```

**彻底修复**（服务器端，清除所有已配对设备，需要所有客户端重新配对）：

```bash
# 清空配对数据
echo '{}' > /opt/leot_svr/data/openclaw/config/devices/paired.json
echo '{}' > /opt/leot_svr/data/openclaw/config/devices/pending.json
chown 1000:1000 /opt/leot_svr/data/openclaw/config/devices/*.json
podman restart openclaw-gateway
# 然后在浏览器清除 localStorage 后重新连接，触发配对流程
# 用 devices list 查看并 approve 待批准设备
```

> **注意**：如果同时清除了服务器端的 `identity/device-auth.json`，CLI 工具自身也需要重新配对。

### HTTPS 502

1. 检查 DNS 解析：`dig claw.leot.fun +short` 应指向 `118.195.136.73`
2. 检查容器是否运行：`podman ps --filter name=openclaw`
3. 重启 nginx-proxy：`podman restart nginx-proxy`

### 模型地区限制 (403 not available in your region)

Anthropic (Claude)、Telegram 等服务对中国 IP 有地区限制。解决方案：通过 Shadowsocks 加密代理转发请求。

当前架构：
```
OpenClaw 容器 --HTTP_PROXY(10.89.0.1:1088)--> 宿主机 sslocal-rust --加密--> nas.bucky.pub:6444 (SS 服务端) --> openrouter.ai / api.telegram.org
```

> **为什么不用 tinyproxy？** 之前使用 Vultr 上的 tinyproxy（`66.42.94.13:18888`）作为 HTTP 代理。但 HTTP CONNECT 请求是明文的（`CONNECT api.telegram.org:443`），GFW 能识别目标域名后注入伪造 RST 包切断连接。对于未被封锁的域名（如 `openrouter.ai`）tinyproxy 仍可用，但 Telegram 等被封域名必须用加密代理。

#### Shadowsocks 代理配置

宿主机上运行 `sslocal-rust`（shadowsocks-rust 1.21.2），由 systemd 管理：

- 二进制路径：`/usr/local/bin/sslocal-rust`
- 配置文件：`/etc/shadowsocks/telegram.json`
- 服务名：`sslocal-telegram.service`

配置文件内容：
```json
{
    "server": "nas.bucky.pub",
    "server_port": 6444,
    "password": "<ss-password>",
    "method": "aes-256-gcm",
    "timeout": 300,
    "locals": [
        { "local_address": "127.0.0.1", "local_port": 1087, "protocol": "socks" },
        { "local_address": "10.89.0.1", "local_port": 1088, "protocol": "http" },
        { "local_address": "127.0.0.1", "local_port": 1088, "protocol": "http" }
    ]
}
```

监听端口（仅内网，不暴露外网）：
- `127.0.0.1:1087` — SOCKS5（仅宿主机本地）
- `127.0.0.1:1088` — HTTP 代理（仅宿主机本地）
- `10.89.0.1:1088` — HTTP 代理（容器网关接口，供容器访问）

防火墙规则：仅允许容器网段 `10.89.0.0/16` 访问 1088 端口。

运维命令：
```bash
# 查看 SS 代理状态
systemctl status sslocal-telegram

# 重启 SS 代理
systemctl restart sslocal-telegram

# 查看 SS 代理日志
journalctl -u sslocal-telegram --no-pager -n 30

# 测试代理是否工作（宿主机）
curl -s --proxy http://127.0.0.1:1088 https://api.telegram.org -o /dev/null -w '%{http_code}'
# 应返回 302

# 测试代理是否工作（容器内）
podman exec openclaw-gateway curl -s --proxy http://10.89.0.1:1088 https://api.telegram.org -o /dev/null -w '%{http_code}'
# 应返回 302
```

如果代理不通：
1. 检查 sslocal-rust 是否运行：`systemctl status sslocal-telegram`
2. 检查端口是否监听：`ss -ltnp | grep -E '1087|1088'`
3. 检查 SS 服务端是否可达：`curl -s --socks5-hostname 127.0.0.1:1087 https://api.telegram.org -o /dev/null -w '%{http_code}'`
4. 检查防火墙：`firewall-cmd --list-rich-rules`（应包含 `10.89.0.0/16` 对 1088 的 allow 规则）

#### 旧代理（tinyproxy，备用）

Vultr 上的 tinyproxy（`66.42.94.13:18888`）仍然可用于未被 GFW 封锁的域名。如需回退：
```bash
# 容器环境变量改回 tinyproxy
-e HTTPS_PROXY=http://66.42.94.13:18888
-e HTTP_PROXY=http://66.42.94.13:18888
```

境外代理配置（`66.42.94.13`，CentOS 7）：
```bash
# tinyproxy 配置文件: /etc/tinyproxy/tinyproxy.conf
# 端口: 18888，仅允许国内服务器 IP (118.195.136.73) 访问
# 防火墙: firewalld rich rule 限制来源 IP
systemctl status tinyproxy
firewall-cmd --list-rich-rules
```

---

## 外部 CLI 工具挂载

OpenClaw 支持通过 **CLI Backend** 机制调用外部 CLI 工具。推荐将所有工具放在宿主机统一目录，通过 Volume 挂载进容器，无需重新构建镜像。

### 1. 宿主机准备工具目录

```bash
mkdir -p /opt/leot_svr/tools/bin
```

### 2. 放入工具

以 `calc-cli`（Rust 静态二进制计算器）为例。源码在 `cli/calc-cli/`，功能：

- 支持 `+ - * / % ^` 和括号，正确处理运算优先级
- 输出 JSON 格式：`{"expression":"2+3*4","result":14}`
- 纯静态编译，无任何运行时依赖，仅 ~460KB

**本地交叉编译**（Windows → Linux 静态二进制）：

```bash
# 安装 musl target（仅首次）
rustup target add x86_64-unknown-linux-musl

# 交叉编译
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER='rust-lld'
cargo build --release --target x86_64-unknown-linux-musl --manifest-path cli/calc-cli/Cargo.toml

# 产物：cli/calc-cli/target/x86_64-unknown-linux-musl/release/calc-cli (~460KB)
```

**上传到服务器**：

```bash
scp cli/calc-cli/target/x86_64-unknown-linux-musl/release/calc-cli root@c.leot.fun:/opt/leot_svr/tools/bin/
ssh root@c.leot.fun chmod +x /opt/leot_svr/tools/bin/calc-cli
```

**用法示例**：

```bash
calc-cli '2 + 3 * 4'           # {"expression":"2 + 3 * 4","result":14}
calc-cli '(1 + 2) ^ 3'         # {"expression":"(1 + 2) ^ 3","result":27}
calc-cli '100 / 3'             # {"expression":"100 / 3","result":33.333...}
calc-cli --expr '10 % 3'       # {"expression":"10 % 3","result":1}
echo '2**10' | calc-cli --stdin # {"expression":"2**10","result":1024}
```

### 3. 启动命令加挂载

在 `podman run` 命令中添加两行（对比步骤 6）：

> 启动命令已合并到步骤 6，包含工具挂载和 SS 代理配置。此处不再重复。

### 4. 在 TOOLS.md 中告知 Agent

Agent 通过内置的 `exec` 工具执行 shell 命令。要让 Agent 知道有哪些外部 CLI 可用，需要编辑工作区的 `TOOLS.md`。

> **注意：** `cliBackends` 是 **模型后端**（把 prompt 发给另一个 AI CLI 获取回复），不是工具注册机制。
> 不要把外部 CLI 工具注册到 `cliBackends` 里。
>
> 代码依据：`src/agents/cli-runner.ts` 中 CLI 后端运行时会注入
> `"Tools are disabled in this session. Do not call tools."`，
> 它只用于文本生成回退（如 claude-cli、codex-cli）。

编辑 `/opt/leot_svr/data/openclaw/workspace/TOOLS.md`，添加工具说明：

```markdown
### 计算器 CLI

系统中安装了 `calc-cli`，一个高精度数学表达式计算器。

- 路径：`/opt/tools/calc-cli`（已在 PATH 中，可直接执行 `calc-cli`）
- 支持运算符：`+ - * / % ^ **` 和括号 `()`
- 输出格式：JSON `{"expression":"...","result":...}`
- 支持负数、嵌套括号、运算优先级

使用方式（通过 exec 工具调用）：

    calc-cli '2 + 3 * 4'              # {"expression":"2 + 3 * 4","result":14}
    calc-cli '(100 - 20) ^ 2 / 5'     # {"expression":"(100-20)^2/5","result":1280}
    calc-cli --expr '10 % 3'           # {"expression":"10 % 3","result":1}

当用户需要数学计算时，优先使用 calc-cli 而不是手动计算。
```

> Agent 在新对话开始时会加载 `TOOLS.md`，无需重启容器，开新对话即可生效。

### 5. 验证工具可用

```bash
# 进容器测试 CLI 可执行
podman exec openclaw-gateway calc-cli '2 + 3 * 4'
# 输出: {"expression":"2 + 3 * 4","result":14}

podman exec openclaw-gateway calc-cli '(1+2)^3'
# 输出: {"expression":"(1+2)^3","result":27}

# 然后在 Web UI 开新对话，问 Agent 计算问题即可
```

### 工具管理注意事项

- **新增工具**：放入 `/opt/leot_svr/tools/bin/`，重启容器即可，无需重新构建镜像
- **静态二进制**优先：避免动态链接库兼容问题（容器基于 Debian bookworm / node:22）
- **脚本工具**：确保 shebang 正确（`#!/bin/bash`），且容器内有对应解释器
- **依赖运行时的工具**：如 Python/Node 脚本，可额外挂载依赖目录或在 Dockerfile 中预装运行时
- **权限**：挂载 `:ro` 防止容器内误改；工具文件需有可执行权限（`chmod +x`）

---

## 关键文件路径

| 路径 | 说明 |
|---|---|
| `/opt/leot_svr/data/openclaw/config/openclaw.json` | 主配置文件 |
| `/opt/leot_svr/data/openclaw/config/set-proxy.js` | Node.js 代理注入脚本（仅 Node 进程内生效，CLI 子进程不继承） |
| `/opt/leot_svr/data/openclaw/.gateway_token` | Gateway Token |
| `/opt/leot_svr/data/openclaw/workspace/` | Agent 工作目录 |
| `/opt/leot_svr/data/openclaw/workspace/SOUL.md` | Agent 人格/语言设置 |
| `/opt/leot_svr/tools/bin/` | 外部 CLI 工具目录（挂载到容器 `/opt/tools`） |
| `/opt/leot_svr/secrets/registry.env` | Registry 凭据 |
| `/etc/shadowsocks/telegram.json` | Shadowsocks 代理配置 |
| `/usr/local/bin/sslocal-rust` | Shadowsocks 客户端二进制 |
| `/etc/systemd/system/sslocal-telegram.service` | SS 代理 systemd 服务 |
