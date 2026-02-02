---
read_when:
  - 打包 OpenClaw.app
  - 调试 macOS gateway launchd 服务
  - 为 macOS 安装 gateway CLI
summary: macOS 上的 Gateway网关运行时（外部 launchd 服务）
title: macOS 上的 Gateway网关
x-i18n:
  generated_at: "2026-02-01T21:32:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4a3e963d13060b123538005439213e786e76127b370a6c834d85a369e4626fe5
  source_path: platforms/mac/bundled-gateway.md
  workflow: 15
---

# macOS 上的 Gateway网关（外部 launchd）

OpenClaw.app 不再捆绑 Node/Bun 或 Gateway网关运行时。macOS 应用
要求**外部**安装 `openclaw` CLI，不会将 Gateway网关作为子进程启动，而是管理一个
按用户配置的 launchd 服务来保持 Gateway网关运行（如果本地已有 Gateway网关在运行，则会连接到现有实例）。

## 安装 CLI（本地模式必需）

Mac 上需要 Node 22+，然后全局安装 `openclaw`：

```bash
npm install -g openclaw@<version>
```

macOS 应用的 **Install CLI** 按钮通过 npm/pnpm 执行相同的安装流程（不建议使用 bun 作为 Gateway网关运行时）。

## Launchd（Gateway网关作为 LaunchAgent）

标签：

- `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.openclaw.*` 可能仍然存在）

Plist 位置（按用户）：

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  （或 `~/Library/LaunchAgents/bot.molt.<profile>.plist`）

管理者：

- macOS 应用在本地模式下负责 LaunchAgent 的安装/更新。
- CLI 也可以安装它：`openclaw gateway install`。

行为：

- "OpenClaw Active" 启用/禁用 LaunchAgent。
- 退出应用**不会**停止 Gateway网关（launchd 会保持其运行）。
- 如果配置端口上已有 Gateway网关在运行，应用会连接到该实例，而不是启动新的。

日志：

- launchd 标准输出/错误：`/tmp/openclaw/openclaw-gateway.log`

## 版本兼容性

macOS 应用会将 Gateway网关版本与自身版本进行比对。如果不兼容，请更新全局 CLI 以匹配应用版本。

## 冒烟测试

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

然后：

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
