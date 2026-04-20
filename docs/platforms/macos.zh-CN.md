---
summary: "OpenClaw macOS 伴随应用（菜单栏 + 网关代理）"
read_when:
  - 实现 macOS 应用功能
  - 更改 macOS 上的网关生命周期或节点桥接
title: "macOS 应用"
---

# OpenClaw macOS 伴随应用（菜单栏 + 网关代理）

macOS 应用是 OpenClaw 的**菜单栏伴随应用**。它拥有权限，
管理/本地附加到网关（launchd 或手动），并将 macOS
能力作为节点暴露给代理。

## 它的功能

- 在菜单栏中显示原生通知和状态。
- 拥有 TCC 提示（通知、辅助功能、屏幕录制、麦克风、
  语音识别、自动化/AppleScript）。
- 运行或连接到网关（本地或远程）。
- 暴露 macOS 专用工具（画布、相机、屏幕录制、`system.run`）。
- 在**远程**模式下启动本地节点主机服务（launchd），在**本地**模式下停止它。
- 可选托管 **PeekabooBridge** 用于 UI 自动化。
- 根据请求通过 npm、pnpm 或 bun 安装全局 CLI（`openclaw`）（应用优先使用 npm，然后是 pnpm，然后是 bun；Node 仍然是推荐的网关运行时）。

## 本地 vs 远程模式

- **本地**（默认）：应用附加到运行中的本地网关（如果存在）；
  否则它通过 `openclaw gateway install` 启用 launchd 服务。
- **远程**：应用通过 SSH/Tailscale 连接到网关，从不启动
  本地进程。
  应用启动本地**节点主机服务**，以便远程网关可以访问这台 Mac。
  应用不会将网关作为子进程生成。
  网关发现现在优先使用 Tailscale MagicDNS 名称而不是原始 tailnet IP，
  因此当 tailnet IP 更改时，Mac 应用可以更可靠地恢复。

## Launchd 控制

应用管理标记为 `ai.openclaw.gateway` 的每用户 LaunchAgent
（或使用 `--profile`/`OPENCLAW_PROFILE` 时的 `ai.openclaw.<profile>`；遗留的 `com.openclaw.*` 仍然卸载）。

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

运行命名配置文件时，将标签替换为 `ai.openclaw.<profile>`。

如果 LaunchAgent 未安装，请从应用启用它或运行 `openclaw gateway install`。

## 节点能力（mac）

macOS 应用将自己呈现为节点。常见命令：

- 画布：`canvas.present`、`canvas.navigate`、`canvas.eval`、`canvas.snapshot`、`canvas.a2ui.*`
- 相机：`camera.snap`、`camera.clip`
- 屏幕：`screen.snapshot`、`screen.record`
- 系统：`system.run`、`system.notify`

节点报告 `permissions` 映射，以便代理可以决定允许什么。

节点服务 + 应用 IPC：

- 当无头节点主机服务运行时（远程模式），它作为节点连接到网关 WS。
- `system.run` 在 macOS 应用（UI/TCC 上下文）中通过本地 Unix 套接字执行；提示 + 输出保留在应用中。

图表（SCI）：

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 执行批准（system.run）

`system.run` 由 macOS 应用中的**执行批准**控制（设置 → 执行批准）。
安全性 + 询问 + 允许列表存储在 Mac 本地：

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

注意：

- `allowlist` 条目是已解析二进制路径的 glob 模式。
- 包含 shell 控制或扩展语法（`&&`、`||`、`;`、`|`、`` ` ``、`$`、`<`、`>`、`(`、`)`）的原始 shell 命令文本被视为允许列表未命中，需要明确批准（或允许列出 shell 二进制文件）。
- 在提示中选择“始终允许”会将该命令添加到允许列表。
- `system.run` 环境覆盖被过滤（删除 `PATH`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`），然后与应用的环境合并。
- 对于 shell 包装器（`bash|sh|zsh ... -c/-lc`），请求范围的环境覆盖被减少到一个小的显式允许列表（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）。
- 对于允许列表模式下的始终允许决策，已知的调度包装器（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）保留内部可执行路径而不是包装器路径。如果解包不安全，则不会自动持久化允许列表条目。

## 深度链接

应用注册 `openclaw://` URL 方案用于本地操作。

### `openclaw://agent`

触发网关 `agent` 请求。

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

安全性：

- 没有 `key`，应用会提示确认。
- 没有 `key`，应用会为确认提示强制执行短消息限制，并忽略 `deliver` / `to` / `channel`。
- 使用有效的 `key`，运行是无人值守的（用于个人自动化）。

## 引导流程（典型）

1. 安装并启动 **OpenClaw.app**。
2. 完成权限清单（TCC 提示）。
3. 确保**本地**模式处于活动状态且网关正在运行。
4. 如果您需要终端访问，请安装 CLI。

## 状态目录放置（macOS）

避免将 OpenClaw 状态目录放在 iCloud 或其他云同步文件夹中。
同步支持的路径可能会增加延迟，并偶尔导致会话和凭据的文件锁定/同步竞争。

首选本地非同步状态路径，例如：

```bash
OPENCLAW_STATE_DIR=~/.openclaw
```

如果 `openclaw doctor` 检测到以下状态：

- `~/Library/Mobile Documents/com~apple~CloudDocs/...`
- `~/Library/CloudStorage/...`

它会警告并建议移回本地路径。

## 构建和开发工作流（原生）

- `cd apps/macos && swift build`
- `swift run OpenClaw`（或 Xcode）
- 打包应用：`scripts/package-mac-app.sh`

## 调试网关连接（macOS CLI）

使用调试 CLI 来执行与 macOS 应用相同的网关 WebSocket 握手和发现逻辑，而无需启动应用。

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

连接选项：

- `--url <ws://host:port>`：覆盖配置
- `--mode <local|remote>`：从配置解析（默认：配置或本地）
- `--probe`：强制进行新的健康探测
- `--timeout <ms>`：请求超时（默认：`15000`）
- `--json`：用于差异的结构化输出

发现选项：

- `--include-local`：包括将被过滤为“本地”的网关
- `--timeout <ms>`：总体发现窗口（默认：`2000`）
- `--json`：用于差异的结构化输出

提示：与 `openclaw gateway discover --json` 进行比较，看看
macOS 应用的发现管道（`local.` 加上配置的广域域，带有
广域和 Tailscale Serve 回退）是否与
基于 Node CLI 的 `dns-sd` 发现不同。

## 远程连接管道（SSH 隧道）

当 macOS 应用在**远程**模式下运行时，它打开一个 SSH 隧道，以便本地 UI
组件可以与远程网关通信，就好像它在本地主机上一样。

### 控制隧道（网关 WebSocket 端口）

- **目的**：健康检查、状态、Web 聊天、配置和其他控制平面调用。
- **本地端口**：网关端口（默认 `18789`），始终稳定。
- **远程端口**：远程主机上的相同网关端口。
- **行为**：无随机本地端口；应用重用现有健康隧道
  或在需要时重新启动它。
- **SSH 形状**：`ssh -N -L <local>:127.0.0.1:<remote>` 带有 BatchMode +
  ExitOnForwardFailure + 保持活动选项。
- **IP 报告**：SSH 隧道使用环回，因此网关将看到节点
  IP 为 `127.0.0.1`。如果您希望显示真实的客户端
  IP，请使用 **Direct (ws/wss)** 传输（参见 [macOS 远程访问](/platforms/mac/remote)）。

有关设置步骤，请参阅 [macOS 远程访问](/platforms/mac/remote)。有关协议详细信息，请参阅 [网关协议](/gateway/protocol)。

## 相关文档

- [网关运行手册](/gateway)
- [网关（macOS）](/platforms/mac/bundled-gateway)
- [macOS 权限](/platforms/mac/permissions)
- [画布](/platforms/mac/canvas)