---
read_when:
  - 打包 OpenClaw.app
  - 调试 macOS Gateway 网关 launchd 服务
  - 为 macOS 安装 Gateway 网关 CLI
summary: macOS 上的 Gateway 网关运行时（外部 launchd 服务）
title: macOS 上的 Gateway 网关
x-i18n:
  generated_at: "2026-02-03T07:52:30Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4a3e963d13060b123538005439213e786e76127b370a6c834d85a369e4626fe5
  source_path: platforms/mac/bundled-gateway.md
  workflow: 15
---

# macOS 上的 Gateway 网关（外部 launchd）

OpenClaw.app 不再捆绑 Node/Bun 或 Gateway 网关运行时。macOS 应用期望有一个**外部**的 `openclaw` CLI 安装，不会将 Gateway 网关作为子进程启动，而是管理一个每用户的 launchd 服务来保持 Gateway 网关运行（或者如果已有本地 Gateway 网关正在运行，则连接到现有的）。

## 安装 CLI（本地模式必需）

你需要在 Mac 上安装 Node 22+，然后全局安装 `openclaw`：

```bash
npm install -g openclaw@<version>
```

macOS 应用的**安装 CLI**按钮通过 npm/pnpm 运行相同的流程（不推荐使用 bun 作为 Gateway 网关运行时）。

## Launchd（Gateway 网关作为 LaunchAgent）

标签：

- `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.openclaw.*` 可能仍然存在）

Plist 位置（每用户）：

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  （或 `~/Library/LaunchAgents/bot.molt.<profile>.plist`）

管理者：

- macOS 应用在本地模式下拥有 LaunchAgent 的安装/更新权限。
- CLI 也可以安装它：`openclaw gateway install`。

行为：

- "OpenClaw Active"启用/禁用 LaunchAgent。
- 应用退出**不会**停止 Gateway 网关（launchd 保持其存活）。
- 如果 Gateway 网关已经在配置的端口上运行，应用会连接到它而不是启动新的。

日志：

- launchd stdout/err：`/tmp/openclaw/openclaw-gateway.log`

## 版本兼容性

macOS 应用会检查 Gateway 网关版本与其自身版本是否匹配。如果不兼容，请更新全局 CLI 以匹配应用版本。

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
