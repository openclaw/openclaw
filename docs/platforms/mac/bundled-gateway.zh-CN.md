---
summary: "macOS 上的网关运行时（外部 launchd 服务）"
read_when:
  - 打包 OpenClaw.app
  - 调试 macOS 网关 launchd 服务
  - 为 macOS 安装网关 CLI
title: "macOS 上的网关"
---

# macOS 上的网关（外部 launchd）

OpenClaw.app 不再捆绑 Node/Bun 或网关运行时。macOS 应用
期望**外部** `openclaw` CLI 安装，不会将网关作为
子进程生成，而是管理每个用户的 launchd 服务来保持网关
运行（或如果已经运行，则附加到现有的本地网关）。

## 安装 CLI（本地模式所需）

Node 24 是 Mac 上的默认运行时。Node 22 LTS，当前为 `22.14+`，仍然可以兼容使用。然后全局安装 `openclaw`：

```bash
npm install -g openclaw@<version>
```

macOS 应用的**安装 CLI** 按钮运行与应用内部使用的相同全局安装流程：它首选 npm，然后是 pnpm，然后是 bun（如果这是唯一检测到的包管理器）。Node 仍然是推荐的网关运行时。

## Launchd（作为 LaunchAgent 的网关）

标签：

- `ai.openclaw.gateway`（或 `ai.openclaw.<profile>`；旧版 `com.openclaw.*` 可能保留）

Plist 位置（每个用户）：

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  （或 `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`）

管理器：

- macOS 应用在本地模式下拥有 LaunchAgent 安装/更新。
- CLI 也可以安装它：`openclaw gateway install`。

行为：

- “OpenClaw Active” 启用/禁用 LaunchAgent。
- 应用退出**不会**停止网关（launchd 保持其活动状态）。
- 如果网关已经在配置的端口上运行，应用会附加到它
  而不是启动一个新的。

日志记录：

- launchd 标准输出/错误：`/tmp/openclaw/openclaw-gateway.log`

## 版本兼容性

macOS 应用会检查网关版本与其自身版本的兼容性。如果它们不兼容，请更新全局 CLI 以匹配应用版本。

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