---
read_when:
  - 你想通过浏览器操作 Gateway网关
  - 你想通过 Tailnet 访问而无需 SSH 隧道
summary: 基于浏览器的 Gateway网关控制界面（聊天、节点、配置）
title: 控制界面
x-i18n:
  generated_at: "2026-02-01T21:44:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 91f6d3f297fb87ffb7c98f9d4955ac624a41fd920af54f1f480e4727816a506b
  source_path: web/control-ui.md
  workflow: 15
---

# 控制界面（浏览器）

控制界面是一个由 Gateway网关提供服务的小型 **Vite + Lit** 单页应用：

- 默认地址：`http://<host>:18789/`
- 可选前缀：设置 `gateway.controlUi.basePath`（例如 `/openclaw`）

它通过同一端口**直接与 Gateway网关 WebSocket** 通信。

## 快速打开（本地）

如果 Gateway网关在这台计算机上运行，请打开：

- http://127.0.0.1:18789/（或 http://localhost:18789/）

如果页面无法加载，请先启动 Gateway网关：`openclaw gateway`。

认证在 WebSocket 握手期间通过以下方式提供：

- `connect.params.auth.token`
- `connect.params.auth.password`
  仪表板设置面板允许你存储令牌；密码不会被持久化。
  新手引导向导默认会生成一个 Gateway网关令牌，首次连接时请在此处粘贴。

## 设备配对（首次连接）

当你从新浏览器或设备连接到控制界面时，Gateway网关需要进行**一次性配对审批** — 即使你在同一个 Tailnet 上且
设置了 `gateway.auth.allowTailscale: true`。这是一项防止
未授权访问的安全措施。

**你会看到：**"disconnected (1008): pairing required"

**审批设备：**

```bash
# 列出待处理的请求
openclaw devices list

# 通过请求 ID 审批
openclaw devices approve <requestId>
```

审批后，设备会被记住，除非你使用 `openclaw devices revoke --device <id> --role <role>` 撤销，否则不需要重新审批。参见
[设备 CLI](/cli/devices) 了解令牌轮换和撤销。

**说明：**

- 本地连接（`127.0.0.1`）会自动审批。
- 远程连接（局域网、Tailnet 等）需要显式审批。
- 每个浏览器配置文件会生成唯一的设备 ID，因此切换浏览器或
  清除浏览器数据将需要重新配对。

## 当前功能

- 通过 Gateway网关 WS 与模型聊天（`chat.history`、`chat.send`、`chat.abort`、`chat.inject`）
- 在聊天中流式传输工具调用 + 实时工具输出卡片（智能体事件）
- 渠道：WhatsApp/Telegram/Discord/Slack + 插件渠道（Mattermost 等）状态 + 二维码登录 + 每渠道配置（`channels.status`、`web.login.*`、`config.patch`）
- 实例：在线列表 + 刷新（`system-presence`）
- 会话：列表 + 每会话思考/详细模式覆盖（`sessions.list`、`sessions.patch`）
- 定时任务：列表/添加/运行/启用/禁用 + 运行历史（`cron.*`）
- Skills：状态、启用/禁用、安装、API 密钥更新（`skills.*`）
- 节点：列表 + 能力（`node.list`）
- 执行审批：编辑 Gateway网关或节点允许列表 + `exec host=gateway/node` 的询问策略（`exec.approvals.*`）
- 配置：查看/编辑 `~/.openclaw/openclaw.json`（`config.get`、`config.set`）
- 配置：应用 + 带验证的重启（`config.apply`）并唤醒最后活跃的会话
- 配置写入包含基础哈希保护，防止覆盖并发编辑
- 配置模式 + 表单渲染（`config.schema`，包括插件 + 渠道模式）；原始 JSON 编辑器仍然可用
- 调试：状态/健康/模型快照 + 事件日志 + 手动 RPC 调用（`status`、`health`、`models.list`）
- 日志：实时跟踪 Gateway网关文件日志，支持过滤/导出（`logs.tail`）
- 更新：运行包/git 更新 + 重启（`update.run`）并附带重启报告

## 聊天行为

- `chat.send` 是**非阻塞的**：它会立即确认并返回 `{ runId, status: "started" }`，响应通过 `chat` 事件流式传输。
- 使用相同的 `idempotencyKey` 重新发送时，运行中返回 `{ status: "in_flight" }`，完成后返回 `{ status: "ok" }`。
- `chat.inject` 将助手备注追加到会话记录中，并广播 `chat` 事件用于仅 UI 更新（不触发智能体运行，不投递到渠道）。
- 停止：
  - 点击**停止**（调用 `chat.abort`）
  - 输入 `/stop`（或 `stop|esc|abort|wait|exit|interrupt`）进行带外中止
  - `chat.abort` 支持 `{ sessionKey }`（无需 `runId`）以中止该会话的所有活跃运行

## Tailnet 访问（推荐）

### 集成 Tailscale Serve（首选）

将 Gateway网关保持在 local loopback 上，让 Tailscale Serve 通过 HTTPS 代理：

```bash
openclaw gateway --tailscale serve
```

打开：

- `https://<magicdns>/`（或你配置的 `gateway.controlUi.basePath`）

默认情况下，当 `gateway.auth.allowTailscale` 为 `true` 时，Serve 请求可以通过 Tailscale 身份头
（`tailscale-user-login`）进行认证。OpenClaw
通过使用 `tailscale whois` 解析 `x-forwarded-for` 地址并与头信息匹配来验证身份，且仅在请求通过带有 Tailscale `x-forwarded-*` 头的 local loopback 到达时才接受。如果你希望即使对 Serve 流量也要求令牌/密码，请设置
`gateway.auth.allowTailscale: false`（或强制 `gateway.auth.mode: "password"`）。

### 绑定到 Tailnet + 令牌

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

然后打开：

- `http://<tailscale-ip>:18789/`（或你配置的 `gateway.controlUi.basePath`）

在 UI 设置中粘贴令牌（作为 `connect.params.auth.token` 发送）。

## 不安全的 HTTP

如果你通过明文 HTTP（`http://<lan-ip>` 或 `http://<tailscale-ip>`）打开仪表板，
浏览器运行在**非安全上下文**中并会阻止 WebCrypto。默认情况下，
OpenClaw **会阻止**没有设备身份的控制界面连接。

**推荐修复：**使用 HTTPS（Tailscale Serve）或在本地打开 UI：

- `https://<magicdns>/`（Serve）
- `http://127.0.0.1:18789/`（在 Gateway网关主机上）

**降级示例（仅令牌，通过 HTTP）：**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

这将为控制界面禁用设备身份 + 配对（即使在 HTTPS 上也是如此）。仅在
你信任网络时使用。

有关 HTTPS 设置指导，请参阅 [Tailscale](/gateway/tailscale)。

## 构建 UI

Gateway网关从 `dist/control-ui` 提供静态文件。使用以下命令构建：

```bash
pnpm ui:build # 首次运行时自动安装 UI 依赖
```

可选的绝对基础路径（当你需要固定的资源 URL 时）：

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

本地开发（独立的开发服务器）：

```bash
pnpm ui:dev # 首次运行时自动安装 UI 依赖
```

然后将 UI 指向你的 Gateway网关 WS URL（例如 `ws://127.0.0.1:18789`）。

## 调试/测试：开发服务器 + 远程 Gateway网关控制界面是静态文件；WebSocket 目标可配置，可以

与 HTTP 源不同。当你想在本地使用 Vite 开发服务器但 Gateway网关运行在其他地方时，这很方便。

1. 启动 UI 开发服务器：`pnpm ui:dev`
2. 打开类似以下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

可选的一次性认证（如果需要）：

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

说明：

- `gatewayUrl` 在加载后存储到 localStorage 并从 URL 中移除。
- `token` 存储在 localStorage 中；`password` 仅保存在内存中。
- 当 Gateway网关在 TLS 之后（Tailscale Serve、HTTPS 代理等）时使用 `wss://`。

远程访问设置详情：[远程访问](/gateway/remote)。
