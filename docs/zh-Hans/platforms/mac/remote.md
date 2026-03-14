---
read_when:
  - 设置或调试远程 mac 控制时
summary: macOS 应用通过 SSH 控制远程 OpenClaw Gateway 网关的流程
title: 远程控制
x-i18n:
  generated_at: "2026-02-03T07:52:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 61b43707250d5515fd0f85f092bdde24598f14904398ff3fca3736bcc48d72f8
  source_path: platforms/mac/remote.md
  workflow: 15
---

# 远程 OpenClaw（macOS ⇄ 远程主机）

此流程让 macOS 应用作为运行在另一台主机（桌面/服务器）上的 OpenClaw Gateway 网关的完整远程控制。这是应用的 **Remote over SSH**（远程运行）功能。所有功能——健康检查、语音唤醒转发和 Web Chat——都重用来自 _Settings → General_ 的相同远程 SSH 配置。

## 模式

- **Local (this Mac)**：一切都在笔记本电脑上运行。不涉及 SSH。
- **Remote over SSH（默认）**：OpenClaw 命令在远程主机上执行。mac 应用使用 `-o BatchMode` 加上你选择的身份/密钥打开 SSH 连接，并进行本地端口转发。
- **Remote direct (ws/wss)**：无 SSH 隧道。mac 应用直接连接到 Gateway 网关 URL（例如，通过 Tailscale Serve 或公共 HTTPS 反向代理）。

## 远程传输

远程模式支持两种传输方式：

- **SSH 隧道**（默认）：使用 `ssh -N -L ...` 将 Gateway 网关端口转发到 localhost。Gateway 网关会将节点的 IP 视为 `127.0.0.1`，因为隧道是 loopback。
- **Direct (ws/wss)**：直接连接到 Gateway 网关 URL。Gateway 网关看到真实的客户端 IP。

## 远程主机上的先决条件

1. 安装 Node + pnpm 并构建/安装 OpenClaw CLI（`pnpm install && pnpm build && pnpm link --global`）。
2. 确保 `openclaw` 在非交互式 shell 的 PATH 中（如需要，请符号链接到 `/usr/local/bin` 或 `/opt/homebrew/bin`）。
3. 使用密钥认证打开 SSH。我们推荐使用 **Tailscale** IP 以实现离开局域网时的稳定可达性。

## macOS 应用设置

1. 打开 _Settings → General_。
2. 在 **OpenClaw runs** 下，选择 **Remote over SSH** 并设置：
   - **Transport**：**SSH tunnel** 或 **Direct (ws/wss)**。
   - **SSH target**：`user@host`（可选 `:port`）。
     - 如果 Gateway 网关在同一局域网上并广播 Bonjour，从发现列表中选择它以自动填充此字段。
   - **Gateway URL**（仅 Direct）：`wss://gateway.example.ts.net`（或本地/局域网使用 `ws://...`）。
   - **Identity file**（高级）：你的密钥路径。
   - **Project root**（高级）：用于命令的远程 checkout 路径。
   - **CLI path**（高级）：可运行的 `openclaw` 入口点/二进制文件的可选路径（广播时自动填充）。
3. 点击 **Test remote**。成功表示远程 `openclaw status --json` 正确运行。失败通常意味着 PATH/CLI 问题；退出码 127 表示远程找不到 CLI。
4. 健康检查和 Web Chat 现在将自动通过此 SSH 隧道运行。

## Web Chat

- **SSH 隧道**：Web Chat 通过转发的 WebSocket 控制端口（默认 18789）连接到 Gateway 网关。
- **Direct (ws/wss)**：Web Chat 直接连接到配置的 Gateway 网关 URL。
- 不再有单独的 WebChat HTTP 服务器。

## 权限

- 远程主机需要与本地相同的 TCC 批准（自动化、辅助功能、屏幕录制、麦克风、语音识别、通知）。在该机器上运行新手引导以一次性授予它们。
- 节点通过 `node.list` / `node.describe` 广播其权限状态，以便智能体知道哪些可用。

## 安全注意事项

- 优先在远程主机上使用 loopback 绑定，并通过 SSH 或 Tailscale 连接。
- 如果你将 Gateway 网关绑定到非 loopback 接口，请要求令牌/密码认证。
- 参见[安全](/gateway/security)和 [Tailscale](/gateway/tailscale)。

## WhatsApp 登录流程（远程）

- **在远程主机上**运行 `openclaw channels login --verbose`。用手机上的 WhatsApp 扫描二维码。
- 如果认证过期，在该主机上重新运行登录。健康检查会显示关联问题。

## 故障排除

- **exit 127 / not found**：`openclaw` 不在非登录 shell 的 PATH 中。将其添加到 `/etc/paths`、你的 shell rc，或符号链接到 `/usr/local/bin`/`/opt/homebrew/bin`。
- **Health probe failed**：检查 SSH 可达性、PATH，以及 Baileys 是否已登录（`openclaw status --json`）。
- **Web Chat 卡住**：确认 Gateway 网关正在远程主机上运行，转发的端口与 Gateway 网关 WS 端口匹配；UI 需要健康的 WS 连接。
- **节点 IP 显示 127.0.0.1**：使用 SSH 隧道时是预期的。如果你想让 Gateway 网关看到真实的客户端 IP，请将 **Transport** 切换到 **Direct (ws/wss)**。
- **Voice Wake**：触发短语在远程模式下自动转发；不需要单独的转发器。

## 通知声音

通过带有 `openclaw` 和 `node.invoke` 的脚本为每个通知选择声音，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

应用中不再有全局"默认声音"开关；调用者为每个请求选择声音（或无声音）。
