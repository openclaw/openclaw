---
read_when:
  - 实现 macOS 应用功能
  - 更改 macOS 上的 Gateway网关生命周期或节点桥接
summary: OpenClaw macOS 伴侣应用（菜单栏 + Gateway网关代理）
title: macOS 应用
x-i18n:
  generated_at: "2026-02-01T21:33:53Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a5b1c02e5905e4cbc6c0688149cdb50a5bf7653e641947143e169ad948d1f057
  source_path: platforms/macos.md
  workflow: 15
---

# OpenClaw macOS 伴侣应用（菜单栏 + Gateway网关代理）

macOS 应用是 OpenClaw 的**菜单栏伴侣**。它拥有权限，在本地管理/连接 Gateway网关（launchd 或手动），并将 macOS 能力作为节点暴露给智能体。

## 功能说明

- 在菜单栏显示原生通知和状态。
- 拥有 TCC 提示（通知、辅助功能、屏幕录制、麦克风、语音识别、自动化/AppleScript）。
- 运行或连接到 Gateway网关（本地或远程）。
- 暴露 macOS 专有工具（画布、摄像头、屏幕录制、`system.run`）。
- 在**远程**模式下启动本地节点宿主服务（launchd），在**本地**模式下停止它。
- 可选托管 **PeekabooBridge** 用于 UI 自动化。
- 根据请求通过 npm/pnpm 安装全局 CLI（`openclaw`）（不建议将 bun 用于 Gateway网关运行时）。

## 本地模式与远程模式

- **本地**（默认）：如果存在正在运行的本地 Gateway网关，应用会连接到它；否则通过 `openclaw gateway install` 启用 launchd 服务。
- **远程**：应用通过 SSH/Tailscale 连接到 Gateway网关，不会启动本地进程。
  应用会启动本地**节点宿主服务**，以便远程 Gateway网关可以访问这台 Mac。
  应用不会将 Gateway网关作为子进程启动。

## Launchd 控制

应用管理一个标签为 `bot.molt.gateway` 的用户级 LaunchAgent（使用 `--profile`/`OPENCLAW_PROFILE` 时为 `bot.molt.<profile>`；旧版 `com.openclaw.*` 仍会被卸载）。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

运行命名配置文件时，请将标签替换为 `bot.molt.<profile>`。

如果 LaunchAgent 未安装，可从应用中启用或运行 `openclaw gateway install`。

## 节点能力（Mac）

macOS 应用将自身呈现为一个节点。常用命令：

- 画布：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- 摄像头：`camera.snap`、`camera.clip`
- 屏幕：`screen.record`
- 系统：`system.run`、`system.notify`

节点上报 `permissions` 映射表，以便智能体判断哪些操作被允许。

节点服务 + 应用 IPC：

- 当无头节点宿主服务运行时（远程模式），它通过 WS 作为节点连接到 Gateway网关。
- `system.run` 在 macOS 应用（UI/TCC 上下文）中通过本地 Unix 套接字执行；提示和输出保留在应用内。

示意图（SCI）：

```
Gateway网关 -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 执行审批（system.run）

`system.run` 由 macOS 应用中的**执行审批**控制（设置 → 执行审批）。
安全策略 + 询问方式 + 允许列表存储在 Mac 本地：

```
~/.openclaw/exec-approvals.json
```

示例：

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

注意事项：

- `allowlist` 条目是解析后二进制路径的 glob 模式。
- 在提示中选择"始终允许"会将该命令添加到允许列表中。
- `system.run` 环境变量覆盖会先过滤（移除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`），然后与应用的环境变量合并。

## 深度链接

应用注册 `openclaw://` URL 方案用于本地操作。

### `openclaw://agent`

触发 Gateway网关 `agent` 请求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查询参数：

- `message`（必填）
- `sessionKey`（可选）
- `thinking`（可选）
- `deliver` / `to` / `channel`（可选）
- `timeoutSeconds`（可选）
- `key`（可选，无人值守模式密钥）

安全性：

- 不带 `key` 时，应用会提示确认。
- 带有有效 `key` 时，运行为无人值守模式（用于个人自动化）。

## 新手引导流程（典型）

1. 安装并启动 **OpenClaw.app**。
2. 完成权限清单（TCC 提示）。
3. 确保**本地**模式已激活且 Gateway网关正在运行。
4. 如需终端访问，安装 CLI。

## 构建与开发工作流（原生）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（或 Xcode）
- 打包应用：`scripts/package-mac-app.sh`

## 调试 Gateway网关连接（macOS CLI）

使用调试 CLI 来执行与 macOS 应用相同的 Gateway网关 WebSocket 握手和发现逻辑，无需启动应用。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

连接选项：

- `--url <ws://host:port>`：覆盖配置
- `--mode <local|remote>`：从配置中解析（默认：配置值或 local）
- `--probe`：强制执行新的健康探测
- `--timeout <ms>`：请求超时（默认：`15000`）
- `--json`：结构化输出，便于对比

发现选项：

- `--include-local`：包含会被过滤为"本地"的 Gateway网关
- `--timeout <ms>`：总发现窗口时间（默认：`2000`）
- `--json`：结构化输出，便于对比

提示：与 `openclaw gateway discover --json` 对比，查看 macOS 应用的发现管道（NWBrowser + tailnet DNS-SD 回退）是否与 Node CLI 基于 `dns-sd` 的发现有差异。

## 远程连接机制（SSH 隧道）

当 macOS 应用在**远程**模式下运行时，它会打开 SSH 隧道，使本地 UI 组件可以像访问 localhost 一样与远程 Gateway网关通信。

### 控制隧道（Gateway网关 WebSocket 端口）

- **用途：** 健康检查、状态、Web Chat、配置及其他控制平面调用。
- **本地端口：** Gateway网关端口（默认 `18789`），始终稳定。
- **远程端口：** 远程主机上的相同 Gateway网关端口。
- **行为：** 不使用随机本地端口；应用复用现有的健康隧道，或在需要时重启。
- **SSH 形式：** `ssh -N -L <local>:127.0.0.1:<remote>`，带 BatchMode + ExitOnForwardFailure + keepalive 选项。
- **IP 上报：** SSH 隧道使用 local loopback，因此 Gateway网关看到的节点 IP 为 `127.0.0.1`。如果需要显示真实客户端 IP，请使用 **Direct (ws/wss)** 传输方式（参阅 [macOS 远程访问](/platforms/mac/remote)）。

有关设置步骤，请参阅 [macOS 远程访问](/platforms/mac/remote)。有关协议详情，请参阅 [Gateway网关协议](/gateway/protocol)。

## 相关文档

- [Gateway网关运行手册](/gateway)
- [Gateway网关（macOS）](/platforms/mac/bundled-gateway)
- [macOS 权限](/platforms/mac/permissions)
- [画布](/platforms/mac/canvas)
