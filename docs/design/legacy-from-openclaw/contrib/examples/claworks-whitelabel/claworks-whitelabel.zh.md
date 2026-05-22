# ClaWorks 白标部署（单公网 :443）

对外只暴露 **ClaWorks 品牌 HTTPS**；Agent 运行时与 ClaWorks Platform 绑定 **loopback / 内网**，飞书默认 **WebSocket 出站长连接**（无需公网入站 webhook）。

## 架构

```
[飞书 App ×1] ──出站 WebSocket──► [Agent Runtime 127.0.0.1:18789]
                                        │ HTTP cw_*
                                        ▼
                                 [ClaWorks 127.0.0.1:8000]

[公网/企业 DMZ] ──:443──► [Nginx 白标]
                            ├── /          → Studio 静态页
                            ├── /v1/       → ClaWorks Platform
                            └── /hooks/im/ → Agent Runtime（仅 webhook 模式）
```

| 端口      | 进程              | 应对外                    |
| --------- | ----------------- | ------------------------- |
| **443**   | Nginx             | ✅ 唯一公网口             |
| **18789** | Agent Runtime     | ❌ loopback / Docker 内网 |
| **8000**  | ClaWorks monolith | ❌ loopback / Docker 内网 |
| **18800** | 浏览器 CDP        | ❌ loopback only          |

## 文件清单

| 文件                                         | 用途                                   |
| -------------------------------------------- | -------------------------------------- |
| `claworks-whitelabel.openclaw.fragment.json` | 合并进 `openclaw.json`                 |
| `feishu-account.example.json`                | 飞书 App 凭证片段（可选合并）          |
| `nginx/nginx.conf.template`                  | Nginx 模板                             |
| `.env.example`                               | 环境变量                               |
| `scripts/setup-whitelabel.sh`                | **一键**：合并配置 + 渲染 Nginx + 验收 |
| `scripts/merge-openclaw-config.mjs`          | 仅合并 OpenClaw 配置                   |
| `scripts/render-nginx.sh`                    | 渲染 `nginx/nginx.conf`                |
| `scripts/verify-whitelabel.sh`               | 部署后验收                             |
| `scripts/ufw-whitelabel.sh`                  | UFW 防火墙（可选）                     |
| `studio-dist/index.html`                     | Studio 占位页                          |
| `docker-compose.yml`                         | Docker 版（仅 nginx 映射 443）         |

---

## 零、一键 setup（推荐）

```bash
cd contrib/examples/claworks-whitelabel
cp .env.example .env
# 编辑 PUBLIC_HOST、TLS 路径、STUDIO_STATIC_ROOT

chmod +x scripts/*.sh
./scripts/setup-whitelabel.sh

# 安装 Nginx（需 sudo）
sudo cp nginx/nginx.conf /etc/nginx/conf.d/claworks.conf
sudo nginx -t && sudo systemctl reload nginx

# 可选防火墙
sudo ./scripts/ufw-whitelabel.sh apply
```

合并飞书凭证（在编辑 `feishu-account.example.json` 后）：

```bash
node scripts/merge-openclaw-config.mjs --public-host ai.example.com --fragment feishu-account.example.json
openclaw channels login --channel feishu   # 或使用 wizard 写入凭证
openclaw gateway restart
```

---

## 一、裸机部署（推荐试点）

### 1. 准备 ClaWorks Platform

```bash
createdb claworks
export DATABASE_URL=postgresql+asyncpg://user:pass@127.0.0.1:5432/claworks
claworks start --port 8000
# 生产建议 Platform 仅监听 127.0.0.1（按 ClaWorks 部署文档绑定地址）
```

确认：`curl -sf http://127.0.0.1:8000/v1/health`

### 2. 合并 Agent Runtime 配置

将 `claworks-whitelabel.openclaw.fragment.json` 合并进 `~/.claworks/claworks.json`（或 `CLAWORKS_CONFIG_DIR`）：

- 把 `REPLACE_PUBLIC_HOST` 换成公网域名，如 `ai.example.com`
- 设置 `gateway.auth.token`（`openclaw onboard` 或 `openclaw doctor` 生成）
- 配置飞书 `channels.feishu.accounts.main.appId` / `appSecret`
- 确认 `connectionMode: "websocket"`（默认，无需公网 webhook URL）
- 确认 `plugins.entries.bonjour.enabled: false`

> **状态目录隐藏**：将状态目录指向 `.claworks`，避免进程文件句柄（`lsof`/`/proc`）暴露内部运行时名称：
>
> ```bash
> export OPENCLAW_STATE_DIR=~/.claworks
> export OPENCLAW_CONFIG_PATH=~/.claworks/claworks.json
> export NODE_OPTIONS=--title=claworks-agent
> ```
>
> 裸机建议写入 `.bashrc` / systemd unit；Docker 已在 `docker-compose.yml` 中配置。

启动 Agent Runtime（仅 loopback）：

```bash
OPENCLAW_STATE_DIR=~/.claworks OPENCLAW_CONFIG_PATH=~/.claworks/claworks.json \
  NODE_OPTIONS=--title=claworks-agent openclaw gateway restart
# 或：openclaw gateway --bind loopback --port 18789
```

### 3. 渲染并启用 Nginx

```bash
cd contrib/examples/claworks-whitelabel
cp .env.example .env
# 编辑 PUBLIC_HOST、TLS 路径、STUDIO_STATIC_ROOT

chmod +x scripts/*.sh
./scripts/render-nginx.sh
sudo cp nginx/nginx.conf /etc/nginx/conf.d/claworks.conf
sudo nginx -t && sudo systemctl reload nginx
```

`.env` 裸机示例：

```bash
PUBLIC_HOST=ai.example.com
OPENCLAW_UPSTREAM=127.0.0.1:18789
CLAWORKS_UPSTREAM=127.0.0.1:8000
TLS_CERT_PATH=/etc/letsencrypt/live/ai.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/ai.example.com/privkey.pem
STUDIO_STATIC_ROOT=/var/www/claworks-studio/dist
OPENCLAW_DISABLE_BONJOUR=1
```

### 4. 防火墙

```bash
# 仅开放 443（及 80 跳转）
# 确保 18789、8000 未对 0.0.0.0 监听
sudo ufw allow 443/tcp
sudo ufw deny 18789/tcp
```

### 5. 飞书开放平台

- **事件订阅**：选择 **长连接（WebSocket）**，不要填公网 URL
- **权限**：`im:message`、`im:message:send_as_bot` 等 Bot 权限
- **单 App**：对话 + 卡片审批均走 OpenClaw WebSocket（`card.action.trigger` 已在插件内处理）

若必须用 **Webhook 模式**：

- 事件 URL 填：`https://ai.example.com/hooks/im/events`
- `openclaw.json` 中 `channels.feishu.webhookPath` 已为 `/hooks/im/events`

### 6. 验收

```bash
./scripts/verify-whitelabel.sh
openclaw clawworks status -v
openclaw doctor
```

Agent 会话：`cw_status` → `cw_kb_search` → 飞书发消息测试。

---

## 二、Docker 部署

### 1. 构建白标镜像并渲染 Nginx

```bash
cd contrib/examples/claworks-whitelabel
cp .env.example .env
```

`.env` 中设置（Docker 服务名已更新为 `agent-runtime`）：

```bash
PUBLIC_HOST=ai.example.com
OPENCLAW_UPSTREAM=agent-runtime:18789       # docker-compose 服务名，已改为中性名称
CLAWORKS_UPSTREAM=host.docker.internal:8000
TLS_CERT_PATH=/etc/nginx/ssl/fullchain.pem
TLS_KEY_PATH=/etc/nginx/ssl/privkey.pem
STUDIO_STATIC_ROOT=/var/www/claworks-studio
TLS_CERT_HOST_PATH=/path/on/host/fullchain.pem
TLS_KEY_HOST_PATH=/path/on/host/privkey.pem
# 白标镜像名称（docker ps 中不暴露上游名称）
AGENT_RUNTIME_IMAGE=claworks-agent:local
# 状态目录隐藏（挂载到 .claworks）
CLAWORKS_CONFIG_DIR=${HOME}/.claworks
OTEL_SERVICE_NAME=ClaWorks
```

```bash
./scripts/render-nginx.sh
```

### 2. 启动

```bash
# 在仓库根目录构建白标镜像（用中性标签）
docker build -t claworks-agent:local .

cd contrib/examples/claworks-whitelabel
docker compose up -d
```

Agent Runtime 在 compose 内 **`--bind lan`**（仅 bridge 可达），**不**映射 `18789` 到宿主机。  
容器名为 `claworks-agent-runtime`；`docker ps` 不会出现 openclaw 字样。

---

## 三、LLM 出站请求头白标（重要）

这是最常被忽略的泄漏维度：Agent Runtime 向 LLM 供应商发出 HTTP 请求时，会在某些**官方端点**中注入归属头，让供应商知道来源。

### 哪些情况会泄漏

| 供应商 / 端点类型                      | 泄漏内容                                                 | 泄漏方向                 |
| -------------------------------------- | -------------------------------------------------------- | ------------------------ |
| `api.openai.com`（直连）               | `User-Agent: <runtime>/VERSION`、`originator: <runtime>` | 仅 OpenAI 日志可见       |
| `openrouter.ai`（直连）                | `HTTP-Referer`、`X-OpenRouter-Title`                     | 仅 OpenRouter 控制台可见 |
| `api.anthropic.com`（直连）            | SDK defaultHeaders                                       | 仅 Anthropic 日志可见    |
| **自定义 baseUrl**（Qwen、私有部署等） | **不发送任何归属头**                                     | ✅ 完全无泄漏            |

> **结论**：只要使用**自定义 baseUrl**（包括私有 Qwen、企业 Ollama、自建代理），归属引擎将端点归类为 `"custom"`，完全不发送任何品牌头。这是 ClaWorks 部署的推荐模型配置。

### 规避方案（按场景）

**场景 A — 使用私有/自定义 LLM（推荐）**  
在 `claworks.json` 的 `models.providers.<id>.baseUrl` 填入私有地址（例如 Qwen 内网 IP）。无需任何额外配置，归属头自动不发送。

```json
"models": {
  "providers": {
    "qwen": {
      "baseUrl": "http://10.0.0.5:8080/v1"
    }
  }
}
```

**场景 B — 必须使用 OpenRouter（通过自建代理）**  
架设一个本地/内网 HTTP 代理，转发到 `api.openrouter.ai`，`baseUrl` 填代理地址：

```json
"models": {
  "providers": {
    "openrouter": {
      "baseUrl": "https://your-internal-proxy.example.com/openrouter/v1"
    }
  }
}
```

代理对外看起来是 custom 端点，归属头不发送。

**场景 C — 直连 OpenRouter（接受供应商可见）**  
Fragment 已添加 `models.providers.openrouter.headers` 覆盖，尽力替换 `HTTP-Referer` 与 `X-OpenRouter-Title`：

```json
"models": {
  "providers": {
    "openrouter": {
      "headers": {
        "HTTP-Referer": "https://your-domain.com",
        "X-OpenRouter-Title": "ClaWorks"
      }
    }
  }
}
```

> 注意：`models.providers.<id>.headers` 为"额外静态头"，与归属策略的合并优先级取决于配置层，实际效果请在 OpenRouter 控制台验证。若需确保完全覆盖，使用场景 B 的代理方案。

### OTEL / 遥测服务名

Fragment 已设置 `diagnostics.otel.serviceName: "claworks-agent-runtime"`。  
`.env` 中同时设置 `OTEL_SERVICE_NAME=ClaWorks`，供 SDK 自动检测在配置加载前生效：

```bash
OTEL_SERVICE_NAME=ClaWorks
OTEL_RESOURCE_ATTRIBUTES=service.name=ClaWorks,service.namespace=claworks
```

### 进程 / 容器名

| 层面                | 泄漏源           | 修复                                                        |
| ------------------- | ---------------- | ----------------------------------------------------------- |
| `ps / top`          | Node.js 进程标题 | `NODE_OPTIONS=--title=claworks-agent`                       |
| `docker ps`         | 容器名           | `container_name: claworks-agent-runtime`（已配置）          |
| `docker ps` 镜像列  | 镜像标签         | 构建为 `claworks-agent:local`（`AGENT_RUNTIME_IMAGE` 变量） |
| `lsof / /proc/*/fd` | 状态目录路径     | `OPENCLAW_STATE_DIR=~/.claworks`（已配置）                  |
| systemd journal     | Unit 名称        | 单元文件改为 `claworks-agent.service`（见 `systemd/` 目录） |

---

## 四、白标检查清单（公网可见维度全覆盖）

| 维度                          | 要求                                     | 本方案状态                                           |
| ----------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 公网端口                      | 仅 **443**（+ 80→443 跳转）              | ✅ Nginx 唯一入口                                    |
| Agent 运行时端口              | 18789 / 18800 绑 loopback                | ✅ `gateway.bind: loopback`                          |
| ClaWorks Platform 端口        | 8000 / 8001 不对外                       | ✅ 需手动确认防火墙                                  |
| Bonjour / mDNS                | 关闭广播                                 | ✅ `bonjour.enabled: false`                          |
| 响应头                        | `X-Powered-By: ClaWorks`，无 Server 信息 | ✅ Nginx `server_tokens off`                         |
| `/__openclaw__/` 路径         | 公网返回 404                             | ✅ Nginx 显式屏蔽                                    |
| `/openclaw/` 路径             | 公网返回 404                             | ✅ Nginx 显式屏蔽                                    |
| `/cw-admin/` 路径             | 公网返回 404（仅 SSH 隧道）              | ✅ Nginx 显式屏蔽                                    |
| `/console/` 路径              | 已从 Nginx 移除                          | ✅ 不存在该路由                                      |
| Studio 首页内容               | 不含内部运行时字符串                     | ✅ 需用真实 Studio 构建替换占位页                    |
| 飞书                          | WebSocket 出站，无入站依赖               | ✅ 无需公网 webhook URL                              |
| 进程名 `ps/top`               | 不含内部运行时名称                       | ✅ `NODE_OPTIONS=--title=claworks-agent`             |
| Docker 容器名/镜像            | 不含内部名称                             | ✅ `claworks-agent-runtime` + `claworks-agent:local` |
| 状态目录 `lsof`               | 不含 `.openclaw`                         | ✅ `OPENCLAW_STATE_DIR=~/.claworks`                  |
| OTEL 遥测 service.name        | `ClaWorks`                               | ✅ Fragment + env 双重配置                           |
| LLM 出站头（自定义 URL）      | **不发送**任何归属头                     | ✅ `endpointClass: custom` 无归属                    |
| LLM 出站头（OpenRouter 直连） | `HTTP-Referer` / `X-OpenRouter-Title`    | ⚠️ Fragment 尽力覆盖；确保隐藏建议走内网代理         |
| LLM 出站头（OpenAI.com 直连） | `User-Agent`/`originator`                | ⚠️ 仅 OpenAI 日志可见；建议走自建代理规避            |

**验收**（自动化）：

```bash
./scripts/verify-whitelabel.sh
```

脚本检查：内部服务健康、端口绑定、响应头、路径屏蔽、Studio 首页内容、进程名、Docker 容器名、LLM 提供商头配置。

---

## 五、运维控制台（仅 SSH 隧道访问）

运维控制台**不通过公网 Nginx 暴露**，必须用 SSH 端口转发访问：

```bash
ssh -L 18789:127.0.0.1:18789 user@<服务器IP>
# 然后在本机浏览器打开：
open http://localhost:18789/cw-admin/
```

`gateway.controlUi.basePath` 设为 `/cw-admin`（已不含 `openclaw` 字符串）。  
Nginx 对外同时屏蔽 `/__openclaw__/`、`/openclaw/`、`/cw-admin/` 路径（均返回 404），防止任何路径探测泄露内部运行时信息。

---

## 六、故障排查

| 现象                            | 处理                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| 飞书无回复                      | `openclaw logs --follow`；确认 WebSocket 长连接已建立                                 |
| `/v1/health` 502                | ClaWorks 进程与 `CLAWORKS_UPSTREAM` 不一致                                            |
| 外网仍能扫到 18789              | `lsof -i :18789`；改 loopback + 防火墙                                                |
| Bonjour 广播                    | 确认 `plugins.entries.bonjour.enabled: false`                                         |
| Control UI WS 失败              | 检查 `allowedOrigins` 与 Nginx `Upgrade` 头                                           |
| `docker ps` 显示内部名称        | 设置 `AGENT_RUNTIME_IMAGE=claworks-agent:local` 并重建镜像                            |
| `ps` 显示内部名称               | 确认 `NODE_OPTIONS=--title=claworks-agent` 已设置                                     |
| OTEL 中出现内部 service.name    | 设置 `OTEL_SERVICE_NAME=ClaWorks` 并在 fragment 中配置 `diagnostics.otel.serviceName` |
| OpenRouter 控制台仍显示内部名称 | 检查 `models.providers.openrouter.headers` 是否生效；可改用内网代理方案               |

---

## 相关

- [claworks-canonical-guide.zh.md](../claworks-canonical-guide.zh.md)
- [ClaWorks integration](https://docs.openclaw.ai/plugins/claworks-integration)
- [Feishu channel](https://docs.openclaw.ai/channels/feishu)
