---
read_when:
  - 你想从浏览器操作 Gateway 网关
  - 你想要无需 SSH 隧道的 Tailnet 访问
summary: Gateway 网关的浏览器控制 UI（聊天、节点、配置）
title: 控制 UI
x-i18n:
  generated_at: "2026-02-03T10:13:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bef105a376fc1a1df44e3e4fb625db1cbcafe2f41e718181c36877b8cbc08816
  source_path: web/control-ui.md
  workflow: 15
---

# 控制 UI（浏览器）

控制 UI 是一个由 Gateway 网关提供服务的小型 **Vite + Lit** 单页应用：

- 默认：`http://<host>:18789/`
- 可选前缀：设置 `gateway.controlUi.basePath`（例如 `/openclaw`）

它**直接与同一端口上的 Gateway 网关 WebSocket** 通信。

## 快速打开（本地）

如果 Gateway 网关在同一台计算机上运行，打开：

- http://127.0.0.1:18789/（或 http://localhost:18789/）

如果页面加载失败，请先启动 Gateway 网关：`openclaw gateway`。

认证在 WebSocket 握手期间通过以下方式提供：

- `connect.params.auth.token`
- `connect.params.auth.password`
  仪表板设置面板允许你存储 token；密码不会被持久化。
  新手引导向导默认生成一个 Gateway 网关 token，所以在首次连接时将其粘贴到这里。

## 设备配对（首次连接）

当你从新浏览器或设备连接到控制 UI 时，Gateway 网关需要**一次性配对批准** — 即使你在同一个 Tailnet 上且 `gateway.auth.allowTailscale: true`。这是防止未授权访问的安全措施。

**你会看到：** "disconnected (1008): pairing required"

**批准设备：**

```bash
# 列出待处理的请求
openclaw devices list

# 按请求 ID 批准
openclaw devices approve <requestId>
```

一旦批准，设备会被记住，除非你使用 `openclaw devices revoke --device <id> --role <role>` 撤销它，否则不需要重新批准。参见 [Devices CLI](/cli/devices) 了解 token 轮换和撤销。

**注意：**

- 本地连接（`127.0.0.1`）会自动批准。
- 远程连接（LAN、Tailnet 等）需要显式批准。
- 每个浏览器配置文件生成唯一的设备 ID，因此切换浏览器或清除浏览器数据将需要重新配对。

## 目前可以做什么

- 通过 Gateway 网关 WS 与模型聊天（`chat.history`、`chat.send`、`chat.abort`、`chat.inject`）
- 在聊天中流式传输工具调用 + 实时工具输出卡片（智能体事件）
- 渠道：WhatsApp/Telegram/Discord/Slack + 插件渠道（Mattermost 等）状态 + QR 登录 + 每渠道配置（`channels.status`、`web.login.*`、`config.patch`）
- 实例：在线列表 + 刷新（`system-presence`）
- 会话：列表 + 每会话思考/详细覆盖（`sessions.list`、`sessions.patch`）
- 定时任务：列出/添加/运行/启用/禁用 + 运行历史（`cron.*`）
- Skills：状态、启用/禁用、安装、API 密钥更新（`skills.*`）
- 节点：列表 + 能力（`node.list`）
- 执行批准：编辑 Gateway 网关或节点允许列表 + `exec host=gateway/node` 的询问策略（`exec.approvals.*`）
- 配置：查看/编辑 `~/.openclaw/openclaw.json`（`config.get`、`config.set`）
- 配置：应用 + 带验证的重启（`config.apply`）并唤醒上次活动的会话
- 配置写入包含基础哈希保护，以防止覆盖并发编辑
- 配置 schema + 表单渲染（`config.schema`，包括插件 + 渠道 schema）；原始 JSON 编辑器仍然可用
- 调试：状态/健康/模型快照 + 事件日志 + 手动 RPC 调用（`status`、`health`、`models.list`）
- 日志：Gateway 网关文件日志的实时尾部跟踪，带过滤/导出（`logs.tail`）
- 更新：运行包/git 更新 + 重启（`update.run`）并显示重启报告

## 聊天行为

- `chat.send` 是**非阻塞的**：它立即以 `{ runId, status: "started" }` 确认，响应通过 `chat` 事件流式传输。
- 使用相同的 `idempotencyKey` 重新发送在运行时返回 `{ status: "in_flight" }`，完成后返回 `{ status: "ok" }`。
- `chat.inject` 将助手备注附加到会话转录，并为仅 UI 更新广播 `chat` 事件（无智能体运行，无渠道投递）。
- 停止：
  - 点击**停止**（调用 `chat.abort`）
  - 输入 `/stop`（或 `stop|esc|abort|wait|exit|interrupt`）以带外中止
  - `chat.abort` 支持 `{ sessionKey }`（无 `runId`）以中止该会话的所有活动运行

## Tailnet 访问（推荐）

### 集成 Tailscale Serve（首选）

保持 Gateway 网关在 loopback 上，让 Tailscale Serve 用 HTTPS 代理它：

```bash
openclaw gateway --tailscale serve
```

打开：

- `https://<magicdns>/`（或你配置的 `gateway.controlUi.basePath`）

默认情况下，当 `gateway.auth.allowTailscale` 为 `true` 时，Serve 请求可以通过 Tailscale 身份头（`tailscale-user-login`）进行认证。OpenClaw 通过使用 `tailscale whois` 解析 `x-forwarded-for` 地址并与头匹配来验证身份，并且只在请求通过 Tailscale 的 `x-forwarded-*` 头到达 loopback 时接受这些。如果你想即使对于 Serve 流量也要求 token/密码，请设置 `gateway.auth.allowTailscale: false`（或强制 `gateway.auth.mode: "password"`）。

### 绑定到 tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

然后打开：

- `http://<tailscale-ip>:18789/`（或你配置的 `gateway.controlUi.basePath`）

将 token 粘贴到 UI 设置中（作为 `connect.params.auth.token` 发送）。

## 不安全的 HTTP

如果你通过普通 HTTP 打开仪表板（`http://<lan-ip>` 或 `http://<tailscale-ip>`），浏览器在**非安全上下文**中运行并阻止 WebCrypto。默认情况下，OpenClaw **阻止**没有设备身份的控制 UI 连接。

**推荐修复：** 使用 HTTPS（Tailscale Serve）或在本地打开 UI：

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（在 Gateway 网关主机上）

**降级示例（仅通过 HTTP 使用 token）：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

这会为控制 UI 禁用设备身份 + 配对（即使在 HTTPS 上）。仅在你信任网络时使用。

参见 [Tailscale](/gateway/tailscale) 了解 HTTPS 设置指南。

## 构建 UI

Gateway 网关从 `dist/control-ui` 提供静态文件。使用以下命令构建：

```bash
pnpm ui:build # 首次运行时自动安装 UI 依赖
```

可选的绝对基础路径（当你想要固定的资源 URL 时）：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

用于本地开发（单独的开发服务器）：

```bash
pnpm ui:dev # 首次运行时自动安装 UI 依赖
```

然后将 UI 指向你的 Gateway 网关 WS URL（例如 `ws://127.0.0.1:18789`）。

## 调试/测试：开发服务器 + 远程 Gateway 网关

控制 UI 是静态文件；WebSocket 目标是可配置的，可以与 HTTP 源不同。当你想要在本地使用 Vite 开发服务器但 Gateway 网关在其他地方运行时，这很方便。

1. 启动 UI 开发服务器：`pnpm ui:dev`
2. 打开类似以下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

可选的一次性认证（如需要）：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

注意：

- `gatewayUrl` 在加载后存储在 localStorage 中并从 URL 中移除。
- `token` 存储在 localStorage 中；`password` 仅保留在内存中。
- 当 Gateway 网关在 TLS 后面时（Tailscale Serve、HTTPS 代理等），使用 `wss://`。

远程访问设置详情：[远程访问](/gateway/remote)。
