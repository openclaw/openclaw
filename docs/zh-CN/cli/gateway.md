---
read_when:
  - 从 CLI 运行 Gateway 网关（开发或服务器）
  - 调试 Gateway 网关认证、绑定模式和连接性
  - 通过 Bonjour 发现 Gateway 网关（局域网 + tailnet）
summary: OpenClaw Gateway 网关 CLI（`openclaw gateway`）— 运行、查询和发现 Gateway 网关
title: gateway
x-i18n:
  generated_at: "2026-02-03T07:45:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 054dd48056e4784f153c6511c8eb35b56f239db8d4e629661841a00259e9abbf
  source_path: cli/gateway.md
  workflow: 15
---

# Gateway 网关 CLI

Gateway 网关是 OpenClaw 的 WebSocket 服务器（渠道、节点、会话、hooks）。

本页中的子命令位于 `openclaw gateway …` 下。

相关文档：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 运行 Gateway 网关

运行本地 Gateway 网关进程：

```bash
openclaw gateway
```

前台运行别名：

```bash
openclaw gateway run
```

注意事项：

- 默认情况下，除非在 `~/.openclaw/openclaw.json` 中设置了 `gateway.mode=local`，否则 Gateway 网关将拒绝启动。使用 `--allow-unconfigured` 进行临时/开发运行。
- 在没有认证的情况下绑定到 loopback 之外的地址会被阻止（安全护栏）。
- `SIGUSR1` 在授权时触发进程内重启（启用 `commands.restart` 或使用 gateway 工具/config apply/update）。
- `SIGINT`/`SIGTERM` 处理程序会停止 Gateway 网关进程，但不会恢复任何自定义终端状态。如果你用 TUI 或 raw-mode 输入包装 CLI，请在退出前恢复终端。

### 选项

- `--port <port>`：WebSocket 端口（默认来自配置/环境变量；通常为 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`：监听器绑定模式。
- `--auth <token|password>`：认证模式覆盖。
- `--token <token>`：令牌覆盖（同时为进程设置 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`：密码覆盖（同时为进程设置 `OPENCLAW_GATEWAY_PASSWORD`）。
- `--tailscale <off|serve|funnel>`：通过 Tailscale 暴露 Gateway 网关。
- `--tailscale-reset-on-exit`：关闭时重置 Tailscale serve/funnel 配置。
- `--allow-unconfigured`：允许在配置中没有 `gateway.mode=local` 的情况下启动 Gateway 网关。
- `--dev`：如果缺失则创建开发配置 + 工作区（跳过 BOOTSTRAP.md）。
- `--reset`：重置开发配置 + 凭证 + 会话 + 工作区（需要 `--dev`）。
- `--force`：启动前杀死所选端口上的任何现有监听器。
- `--verbose`：详细日志。
- `--claude-cli-logs`：仅在控制台显示 claude-cli 日志（并启用其 stdout/stderr）。
- `--ws-log <auto|full|compact>`：WebSocket 日志样式（默认 `auto`）。
- `--compact`：`--ws-log compact` 的别名。
- `--raw-stream`：将原始模型流事件记录到 jsonl。
- `--raw-stream-path <path>`：原始流 jsonl 路径。

## 查询运行中的 Gateway 网关

所有查询命令使用 WebSocket RPC。

输出模式：

- 默认：人类可读（TTY 中带颜色）。
- `--json`：机器可读 JSON（无样式/进度指示器）。
- `--no-color`（或 `NO_COLOR=1`）：禁用 ANSI 但保持人类可读布局。

共享选项（在支持的地方）：

- `--url <url>`：Gateway 网关 WebSocket URL。
- `--token <token>`：Gateway 网关令牌。
- `--password <password>`：Gateway 网关密码。
- `--timeout <ms>`：超时/预算（因命令而异）。
- `--expect-final`：等待"最终"响应（智能体调用）。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 显示 Gateway 网关服务（launchd/systemd/schtasks）以及可选的 RPC 探测。

```bash
openclaw gateway status
openclaw gateway status --json
```

选项：

- `--url <url>`：覆盖探测 URL。
- `--token <token>`：探测的令牌认证。
- `--password <password>`：探测的密码认证。
- `--timeout <ms>`：探测超时（默认 `10000`）。
- `--no-probe`：跳过 RPC 探测（仅服务视图）。
- `--deep`：也扫描系统级服务。

### `gateway probe`

`gateway probe` 是"调试一切"命令。它始终探测：

- 你配置的远程 Gateway 网关（如果设置了），以及
- localhost（loopback）**即使配置了远程也会探测**。

如果多个 Gateway 网关可达，它会打印所有。当你使用隔离的配置文件/端口（例如救援机器人）时支持多个 Gateway 网关，但大多数安装仍然运行单个 Gateway 网关。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 通过 SSH 远程（Mac 应用对等）

macOS 应用的"通过 SSH 远程"模式使用本地端口转发，因此远程 Gateway 网关（可能仅绑定到 loopback）变得可以通过 `ws://127.0.0.1:<port>` 访问。

CLI 等效命令：

```bash
openclaw gateway probe --ssh user@gateway-host
```

选项：

- `--ssh <target>`：`user@host` 或 `user@host:port`（端口默认为 `22`）。
- `--ssh-identity <path>`：身份文件。
- `--ssh-auto`：选择第一个发现的 Gateway 网关主机作为 SSH 目标（仅限局域网/WAB）。

配置（可选，用作默认值）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低级 RPC 辅助工具。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## 管理 Gateway 网关服务

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注意事项：

- `gateway install` 支持 `--port`、`--runtime`、`--token`、`--force`、`--json`。
- 生命周期命令接受 `--json` 用于脚本。

## 发现 Gateway 网关（Bonjour）

`gateway discover` 扫描 Gateway 网关信标（`_openclaw-gw._tcp`）。

- 组播 DNS-SD：`local.`
- 单播 DNS-SD（广域 Bonjour）：选择一个域（示例：`openclaw.internal.`）并设置分割 DNS + DNS 服务器；参见 [/gateway/bonjour](/gateway/bonjour)

只有启用了 Bonjour 发现（默认）的 Gateway 网关才会广播信标。

广域发现记录包括（TXT）：

- `role`（Gateway 网关角色提示）
- `transport`（传输提示，例如 `gateway`）
- `gatewayPort`（WebSocket 端口，通常为 `18789`）
- `sshPort`（SSH 端口；如果不存在则默认为 `22`）
- `tailnetDns`（MagicDNS 主机名，如果可用）
- `gatewayTls` / `gatewayTlsSha256`（TLS 启用 + 证书指纹）
- `cliPath`（远程安装的可选提示）

### `gateway discover`

```bash
openclaw gateway discover
```

选项：

- `--timeout <ms>`：每个命令的超时（浏览/解析）；默认 `2000`。
- `--json`：机器可读输出（同时禁用样式/进度指示器）。

示例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
