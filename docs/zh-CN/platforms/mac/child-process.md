---
read_when:
  - 将 mac 应用与 Gateway 网关生命周期集成时
summary: macOS 上的 Gateway 网关生命周期（launchd）
title: Gateway 网关生命周期
x-i18n:
  generated_at: "2026-02-03T07:52:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9b910f574b723bc194ac663a5168e48d95f55cb468ce34c595d8ca60d3463c6a
  source_path: platforms/mac/child-process.md
  workflow: 15
---

# macOS 上的 Gateway 网关生命周期

macOS 应用**默认通过 launchd 管理 Gateway 网关**，不会将
Gateway 网关作为子进程生成。它首先尝试连接到配置端口上已运行的
Gateway 网关；如果无法访问，它会通过外部 `openclaw` CLI（无嵌入式运行时）启用 launchd
服务。这为你提供了可靠的登录时自动启动和崩溃后重启。

子进程模式（由应用直接生成 Gateway 网关）**目前未使用**。
如果你需要与 UI 更紧密的耦合，请在终端中手动运行 Gateway 网关。

## 默认行为（launchd）

- 应用安装标记为 `bot.molt.gateway` 的按用户 LaunchAgent
  （使用 `--profile`/`OPENCLAW_PROFILE` 时为 `bot.molt.<profile>`；支持旧版 `com.openclaw.*`）。
- 当启用本地模式时，应用确保 LaunchAgent 已加载，并
  在需要时启动 Gateway 网关。
- 日志写入 launchd Gateway 网关日志路径（在调试设置中可见）。

常用命令：

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

运行命名配置文件时，将标签替换为 `bot.molt.<profile>`。

## 未签名的开发构建

`scripts/restart-mac.sh --no-sign` 用于在没有签名密钥时的快速本地构建。为了防止 launchd 指向未签名的中继二进制文件，它：

- 写入 `~/.openclaw/disable-launchagent`。

已签名运行的 `scripts/restart-mac.sh` 会在标记存在时清除此覆盖。要手动重置：

```bash
rm ~/.openclaw/disable-launchagent
```

## 仅连接模式

要强制 macOS 应用**永不安装或管理 launchd**，请使用
`--attach-only`（或 `--no-launchd`）启动它。这会设置 `~/.openclaw/disable-launchagent`，
因此应用只会连接到已运行的 Gateway 网关。你可以在调试设置中切换相同的
行为。

## 远程模式

远程模式永远不会启动本地 Gateway 网关。应用使用到
远程主机的 SSH 隧道并通过该隧道连接。

## 为什么我们更喜欢 launchd

- 登录时自动启动。
- 内置的重启/KeepAlive 语义。
- 可预测的日志和监管。

如果将来再次需要真正的子进程模式，它应该被记录为
单独的、明确的仅开发模式。
