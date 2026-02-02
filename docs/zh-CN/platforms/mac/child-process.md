---
read_when:
  - 将 Mac 应用与 Gateway网关生命周期集成
summary: macOS 上的 Gateway网关生命周期（launchd）
title: Gateway网关生命周期
x-i18n:
  generated_at: "2026-02-01T21:32:36Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9b910f574b723bc194ac663a5168e48d95f55cb468ce34c595d8ca60d3463c6a
  source_path: platforms/mac/child-process.md
  workflow: 15
---

# macOS 上的 Gateway网关生命周期

macOS 应用默认**通过 launchd 管理 Gateway网关**，不会将 Gateway网关作为子进程启动。它首先尝试连接到已在配置端口上运行的 Gateway网关；如果无法连接，则通过外部 `openclaw` CLI（无内嵌运行时）启用 launchd 服务。这为你提供了可靠的登录自启动和崩溃后自动重启。

子进程模式（由应用直接启动 Gateway网关）**目前未使用**。如果你需要与 UI 更紧密的耦合，请在终端中手动运行 Gateway网关。

## 默认行为（launchd）

- 应用安装一个标签为 `bot.molt.gateway` 的用户级 LaunchAgent（使用 `--profile`/`OPENCLAW_PROFILE` 时为 `bot.molt.<profile>`；兼容旧版 `com.openclaw.*`）。
- 当启用本地模式时，应用会确保 LaunchAgent 已加载，并在需要时启动 Gateway网关。
- 日志写入 launchd Gateway网关日志路径（可在调试设置中查看）。

常用命令：

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

运行命名配置文件时，请将标签替换为 `bot.molt.<profile>`。

## 未签名的开发构建

`scripts/restart-mac.sh --no-sign` 用于在没有签名密钥时进行快速本地构建。为防止 launchd 指向未签名的中继二进制文件，它会：

- 写入 `~/.openclaw/disable-launchagent`。

已签名的 `scripts/restart-mac.sh` 运行会在检测到该标记文件时清除此覆盖。手动重置方法：

```bash
rm ~/.openclaw/disable-launchagent
```

## 仅连接模式

要强制 macOS 应用**永不安装或管理 launchd**，请使用 `--attach-only`（或 `--no-launchd`）启动。这会设置 `~/.openclaw/disable-launchagent`，使应用仅连接到已运行的 Gateway网关。你也可以在调试设置中切换相同的行为。

## 远程模式

远程模式不会启动本地 Gateway网关。应用使用 SSH 隧道连接到远程主机，并通过该隧道进行通信。

## 为何优先选择 launchd

- 登录时自动启动。
- 内置重启/KeepAlive 语义。
- 可预测的日志和进程监管。

如果将来再次需要真正的子进程模式，应将其作为独立的、明确的开发专用模式进行文档记录。
