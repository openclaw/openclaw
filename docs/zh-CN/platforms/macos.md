---
read_when:
  - 实现 macOS 应用功能
  - 在 macOS 上更改 Gateway 网关生命周期或节点桥接
summary: OpenClaw macOS 配套应用（菜单栏 + Gateway 网关代理）
title: macOS 应用
x-i18n:
  generated_at: "2026-02-03T07:53:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: a5b1c02e5905e4cbc6c0688149cdb50a5bf7653e641947143e169ad948d1f057
  source_path: platforms/macos.md
  workflow: 15
---

# OpenClaw macOS 配套应用（菜单栏 + Gateway 网关代理）

macOS 应用是 OpenClaw 的**菜单栏配套应用**。它拥有权限，在本地管理/附加到 Gateway 网关（launchd 或手动），并作为节点向智能体暴露 macOS 功能。

## 功能

- 在菜单栏中显示原生通知和状态。
- 拥有 TCC 提示（通知、辅助功能、屏幕录制、麦克风、语音识别、自动化/AppleScript）。
- 运行或连接到 Gateway 网关（本地或远程）。
- 暴露 macOS 专用工具（Canvas、相机、屏幕录制、`system.run`）。
- 在**远程**模式下启动本地节点主机服务（launchd），在**本地**模式下停止它。
- 可选地托管 **PeekabooBridge** 用于 UI 自动化。
- 根据请求通过 npm/pnpm 安装全局 CLI（`openclaw`）（不建议使用 bun 作为 Gateway 网关运行时）。

## 本地 vs 远程模式

- **本地**（默认）：如果存在运行中的本地 Gateway 网关，应用附加到它；否则通过 `openclaw gateway install` 启用 launchd 服务。
- **远程**：应用通过 SSH/Tailscale 连接到 Gateway 网关，从不启动本地进程。
  应用启动本地**节点主机服务**，以便远程 Gateway 网关可以访问此 Mac。
  应用不会将 Gateway 网关作为子进程生成。

## Launchd 控制

应用管理一个标记为 `bot.molt.gateway` 的每用户 LaunchAgent（使用 `--profile`/`OPENCLAW_PROFILE` 时为 `bot.molt.<profile>`；旧版 `com.openclaw.*` 仍会卸载）。

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

运行命名配置文件时，将标签替换为 `bot.molt.<profile>`。

如果 LaunchAgent 未安装，从应用中启用它或运行 `openclaw gateway install`。

## 节点功能（mac）

macOS 应用将自身呈现为一个节点。常用命令：

- Canvas：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- 相机：`camera.snap`、`camera.clip`
- 屏幕：`screen.record`
- 系统：`system.run`、`system.notify`

节点报告一个 `permissions` 映射，以便智能体可以决定什么是允许的。

节点服务 + 应用 IPC：

- 当无头节点主机服务运行时（远程模式），它作为节点连接到 Gateway 网关 WS。
- `system.run` 在 macOS 应用中执行（UI/TCC 上下文）通过本地 Unix 套接字；提示 + 输出保留在应用内。

图示（SCI）：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec 审批（system.run）

`system.run` 由 macOS 应用中的 **Exec 审批**控制（设置 → Exec approvals）。安全 + 询问 + 允许列表本地存储在 Mac 上：

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
- 在提示中选择"Always Allow"会将该命令添加到允许列表。
- `system.run` 环境覆盖会被过滤（删除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`），然后与应用的环境合并。

## 深度链接

应用为本地操作注册 `openclaw://` URL 方案。

### `openclaw://agent`

触发 Gateway 网关 `agent` 请求。

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

查询参数：

- `message`（必需）
- `sessionKey`（可选）
- `thinking`（可选）
- `deliver` / `to` / `channel`（可选）
- `timeoutSeconds`（可选）
- `key`（可选无人值守模式密钥）

安全：

- 没有 `key` 时，应用会提示确认。
- 有有效的 `key` 时，运行是无人值守的（用于个人自动化）。

## 新手引导流程（典型）

1. 安装并启动 **OpenClaw.app**。
2. 完成权限清单（TCC 提示）。
3. 确保**本地**模式处于活动状态且 Gateway 网关正在运行。
4. 如果你想要终端访问，安装 CLI。

## 构建和开发工作流程（原生）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（或 Xcode）
- 打包应用：`scripts/package-mac-app.sh`

## 调试 Gateway 网关连接（macOS CLI）

使用调试 CLI 来执行与 macOS 应用使用的相同的 Gateway 网关 WebSocket 握手和发现逻辑，而无需启动应用。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Connect 选项：

- `--url <ws://host:port>`：覆盖配置
- `--mode <local|remote>`：从配置解析（默认：配置或 local）
- `--probe`：强制进行新的健康探测
- `--timeout <ms>`：请求超时（默认：`15000`）
- `--json`：用于比较的结构化输出

Discovery 选项：

- `--include-local`：包含会被过滤为"本地"的 Gateway 网关
- `--timeout <ms>`：总体发现窗口（默认：`2000`）
- `--json`：用于比较的结构化输出

提示：与 `openclaw gateway discover --json` 比较，查看 macOS 应用的发现管道（NWBrowser + tailnet DNS-SD 回退）是否与 Node CLI 基于 `dns-sd` 的发现不同。

## 远程连接管道（SSH 隧道）

当 macOS 应用在**远程**模式下运行时，它会打开一个 SSH 隧道，以便本地 UI 组件可以像在 localhost 上一样与远程 Gateway 网关通信。

### 控制隧道（Gateway 网关 WebSocket 端口）

- **目的：**健康检查、状态、Web Chat、配置和其他控制平面调用。
- **本地端口：**Gateway 网关端口（默认 `18789`），始终稳定。
- **远程端口：**远程主机上的相同 Gateway 网关端口。
- **行为：**无随机本地端口；应用复用现有的健康隧道或在需要时重启它。
- **SSH 形式：**`ssh -N -L <local>:127.0.0.1:<remote>`，带有 BatchMode + ExitOnForwardFailure + keepalive 选项。
- **IP 报告：**SSH 隧道使用 loopback，因此 Gateway 网关将看到节点 IP 为 `127.0.0.1`。如果你想要显示真实的客户端 IP，请使用 **Direct (ws/wss)** 传输（参见 [macOS 远程访问](/platforms/mac/remote)）。

有关设置步骤，请参阅 [macOS 远程访问](/platforms/mac/remote)。有关协议详情，请参阅 [Gateway 网关协议](/gateway/protocol)。

## 相关文档

- [Gateway 网关运维手册](/gateway)
- [Gateway 网关（macOS）](/platforms/mac/bundled-gateway)
- [macOS 权限](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
