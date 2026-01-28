---
read_when:
  - 设置或调试远程 Mac 控制
summary: macOS 应用通过 SSH 远程控制 OpenClaw Gateway网关的流程
title: 远程控制
x-i18n:
  generated_at: "2026-02-01T21:33:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 61b43707250d5515fd0f85f092bdde24598f14904398ff3fca3736bcc48d72f8
  source_path: platforms/mac/remote.md
  workflow: 15
---

# 远程 OpenClaw（macOS ⇄ 远程主机）

此流程让 macOS 应用充当运行在另一台主机（桌面/服务器）上的 OpenClaw Gateway网关的完整远程控制器。这是应用的 **Remote over SSH**（远程运行）功能。所有功能——健康检查、语音唤醒转发和 Web Chat——都复用 _设置 → 通用_ 中相同的远程 SSH 配置。

## 模式

- **本地（此 Mac）**：所有内容在笔记本电脑上运行，无需 SSH。
- **Remote over SSH（默认）**：OpenClaw 命令在远程主机上执行。Mac 应用使用 `-o BatchMode` 加上你选择的身份/密钥打开 SSH 连接，并进行本地端口转发。
- **Remote direct (ws/wss)**：无 SSH 隧道。Mac 应用直接连接到 Gateway网关 URL（例如通过 Tailscale Serve 或公共 HTTPS 反向代理）。

## 远程传输方式

远程模式支持两种传输方式：

- **SSH 隧道**（默认）：使用 `ssh -N -L ...` 将 Gateway网关端口转发到 localhost。由于隧道是 local loopback 的，Gateway网关会将节点 IP 识别为 `127.0.0.1`。
- **Direct (ws/wss)**：直接连接到 Gateway网关 URL。Gateway网关会看到真实的客户端 IP。

## 远程主机的前提条件

1. 安装 Node + pnpm 并构建/安装 OpenClaw CLI（`pnpm install && pnpm build && pnpm link --global`）。
2. 确保 `openclaw` 在非交互式 shell 的 PATH 中（如有需要，创建符号链接到 `/usr/local/bin` 或 `/opt/homebrew/bin`）。
3. 开启 SSH 密钥认证。我们建议使用 **Tailscale** IP 以实现局域网外的稳定可达性。

## macOS 应用设置

1. 打开 _设置 → 通用_。
2. 在 **OpenClaw runs** 下，选择 **Remote over SSH** 并设置：
   - **传输方式**：**SSH 隧道** 或 **Direct (ws/wss)**。
   - **SSH 目标**：`user@host`（可选 `:port`）。
     - 如果 Gateway网关在同一局域网中并通过 Bonjour 广播，可从发现列表中选择以自动填充此字段。
   - **Gateway网关 URL**（仅 Direct 模式）：`wss://gateway.example.ts.net`（或局域网使用 `ws://...`）。
   - **身份文件**（高级）：密钥路径。
   - **项目根目录**（高级）：用于命令执行的远程代码仓库路径。
   - **CLI 路径**（高级）：可选的 `openclaw` 可执行入口/二进制文件路径（广播时自动填充）。
3. 点击 **测试远程连接**。成功表示远程 `openclaw status --json` 正常运行。失败通常意味着 PATH/CLI 问题；exit 127 表示远程未找到 CLI。
4. 健康检查和 Web Chat 现在会自动通过此 SSH 隧道运行。

## Web Chat

- **SSH 隧道**：Web Chat 通过转发的 WebSocket 控制端口（默认 18789）连接到 Gateway网关。
- **Direct (ws/wss)**：Web Chat 直接连接到配置的 Gateway网关 URL。
- 不再有单独的 WebChat HTTP 服务器。

## 权限

- 远程主机需要与本地相同的 TCC 授权（自动化、辅助功能、屏幕录制、麦克风、语音识别、通知）。在该机器上运行新手引导以一次性授予权限。
- 节点通过 `node.list` / `node.describe` 广播其权限状态，以便智能体了解可用功能。

## 安全注意事项

- 建议在远程主机上绑定 local loopback，并通过 SSH 或 Tailscale 连接。
- 如果将 Gateway网关绑定到非 local loopback 接口，请要求令牌/密码认证。
- 参阅 [安全](/gateway/security) 和 [Tailscale](/gateway/tailscale)。

## WhatsApp 登录流程（远程）

- 在**远程主机**上运行 `openclaw channels login --verbose`。用手机上的 WhatsApp 扫描二维码。
- 如果认证过期，在该主机上重新运行登录。健康检查会显示链接问题。

## 故障排除

- **exit 127 / not found**：`openclaw` 不在非登录 shell 的 PATH 中。将其添加到 `/etc/paths`、你的 shell rc 文件中，或创建符号链接到 `/usr/local/bin`/`/opt/homebrew/bin`。
- **健康探测失败**：检查 SSH 可达性、PATH，以及 Baileys 是否已登录（`openclaw status --json`）。
- **Web Chat 卡住**：确认 Gateway网关在远程主机上正在运行，且转发端口与 Gateway网关 WS 端口匹配；界面需要健康的 WS 连接。
- **节点 IP 显示 127.0.0.1**：使用 SSH 隧道时这是预期行为。如果你希望 Gateway网关看到真实客户端 IP，请将**传输方式**切换为 **Direct (ws/wss)**。
- **语音唤醒**：触发短语在远程模式下会自动转发；无需单独的转发器。

## 通知声音

通过 `openclaw` 和 `node.invoke` 在脚本中为每个通知选择声音，例如：

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

应用中不再有全局"默认声音"开关；调用方按请求选择声音（或不使用声音）。
