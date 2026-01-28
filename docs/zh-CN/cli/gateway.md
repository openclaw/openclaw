---
read_when:
  - 从 CLI 运行 Gateway网关（开发或服务器环境）
  - 调试 Gateway网关认证、绑定模式和连接问题
  - 通过 Bonjour 发现 Gateway网关（局域网 + tailnet）
summary: OpenClaw Gateway网关 CLI（`openclaw gateway`）— 运行、查询和发现 Gateway网关
title: gateway
x-i18n:
  generated_at: "2026-02-01T19:59:19Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 054dd48056e4784f153c6511c8eb35b56f239db8d4e629661841a00259e9abbf
  source_path: cli/gateway.md
  workflow: 14
---

# Gateway网关 CLI

Gateway网关是 OpenClaw 的 WebSocket 服务器（渠道、节点、会话、钩子）。

本页中的子命令位于 `openclaw gateway …` 下。

相关文档：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 运行 Gateway网关运行本地 Gateway网关进程：

```bash
openclaw gateway
```

前台运行别名：

```bash
openclaw gateway run
```

注意事项：

- 默认情况下，除非在 `~/.openclaw/openclaw.json` 中设置了 `gateway.mode=local`，否则 Gateway网关会拒绝启动。使用 `--allow-unconfigured` 进行临时/开发运行。
- 在没有认证的情况下绑定到 local loopback 以外的地址会被阻止（安全防护措施）。
- 授权后 `SIGUSR1` 会触发进程内重启（需启用 `commands.restart` 或使用 Gateway网关工具/配置应用/更新）。
- `SIGINT`/`SIGTERM` 处理程序会停止 Gateway网关进程，但不会恢复任何自定义终端状态。如果你使用 TUI 或原始模式输入包装 CLI，请在退出前恢复终端。

### 选项

- `--port <port>`：WebSocket 端口（默认来自配置/环境变量；通常为 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`：监听器绑定模式。
- `--auth <token|password>`：认证模式覆盖。
- `--token <token>`：令牌覆盖（同时为进程设置 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`：密码覆盖（同时为进程设置 `OPENCLAW_GATEWAY_PASSWORD`）。
- `--tailscale <off|serve|funnel>`：通过 Tailscale 暴露 Gateway网关。
- `--tailscale-reset-on-exit`：关闭时重置 Tailscale serve/funnel 配置。
- `--allow-unconfigured`：允许在配置中没有 `gateway.mode=local` 的情况下启动 Gateway网关。
- `--dev`：如果缺失则创建开发配置和工作区（跳过 BOOTSTRAP.md）。
- `--reset`：重置开发配置 + 凭据 + 会话 + 工作区（需要 `--dev`）。
- `--force`：启动前终止所选端口上的现有监听器。
- `--verbose`：详细日志。
- `--claude-cli-logs`：仅在控制台显示 claude-cli 日志（并启用其 stdout/stderr）。
- `--ws-log <auto|full|compact>`：WebSocket 日志样式（默认 `auto`）。
- `--compact`：`--ws-log compact` 的别名。
- `--raw-stream`：将原始模型流事件记录到 jsonl。
- `--raw-stream-path <path>`：原始流 jsonl 路径。

## 查询运行中的 Gateway网关所有查询命令使用 WebSocket RPC。

输出模式：

- 默认：人类可读（TTY 中带颜色）。
- `--json`：机器可读的 JSON（无样式/加载动画）。
- `--no-color`（或 `NO_COLOR=1`）：禁用 ANSI 但保持人类可读布局。

共享选项（在支持的命令中）：

- `--url <url>`：Gateway网关 WebSocket URL。
- `--token <token>`：Gateway网关令牌。
- `--password <password>`：Gateway网关密码。
- `--timeout <ms>`：超时时间/预算（因命令而异）。
- `--expect-final`：等待"最终"响应（智能体调用）。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 显示 Gateway网关服务（launchd/systemd/schtasks）以及可选的 RPC 探测。

```bash
openclaw gateway status
openclaw gateway status --json
```

选项：

- `--url <url>`：覆盖探测 URL。
- `--token <token>`：探测的令牌认证。
- `--password <password>`：探测的密码认证。
- `--timeout <ms>`：探测超时时间（默认 `10000`）。
- `--no-probe`：跳过 RPC 探测（仅查看服务状态）。
- `--deep`：同时扫描系统级服务。

### `gateway probe`

`gateway probe` 是"全面调试"命令。它始终会探测：

- 你配置的远程 Gateway网关（如已设置），以及
- localhost（local loopback），**即使已配置远程 Gateway网关**。

如果有多个 Gateway网关可达，它会全部输出。当你使用隔离的配置文件/端口时（例如救援机器人），支持多个 Gateway网关，但大多数安装仍然运行单个 Gateway网关。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 通过 SSH 远程连接（Mac 应用对等模式）

macOS 应用的"通过 SSH 远程连接"模式使用本地端口转发，使远程 Gateway网关（可能仅绑定到 local loopback）可通过 `ws://127.0.0.1:<port>` 访问。

CLI 等效命令：

```bash
openclaw gateway probe --ssh user@gateway-host
```

选项：

- `--ssh <target>`：`user@host` 或 `user@host:port`（端口默认为 `22`）。
- `--ssh-identity <path>`：身份文件。
- `--ssh-auto`：自动选择第一个发现的 Gateway网关主机作为 SSH 目标（仅限局域网/WAB）。

配置（可选，用作默认值）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

底层 RPC 辅助工具。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## 管理 Gateway网关服务

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

注意事项：

- `gateway install` 支持 `--port`、`--runtime`、`--token`、`--force`、`--json`。
- 生命周期命令接受 `--json` 用于脚本编写。

## 发现 Gateway网关（Bonjour）

`gateway discover` 扫描 Gateway网关信标（`_openclaw-gw._tcp`）。

- 组播 DNS-SD：`local.`
- 单播 DNS-SD（广域 Bonjour）：选择一个域名（例如：`openclaw.internal.`）并设置分离 DNS + DNS 服务器；参见 [/gateway/bonjour](/gateway/bonjour)

只有启用了 Bonjour 发现（默认启用）的 Gateway网关才会广播信标。

广域发现记录包含（TXT）：

- `role`（Gateway网关角色提示）
- `transport`（传输提示，例如 `gateway`）
- `gatewayPort`（WebSocket 端口，通常为 `18789`）
- `sshPort`（SSH 端口；如未指定默认为 `22`）
- `tailnetDns`（MagicDNS 主机名，如可用）
- `gatewayTls` / `gatewayTlsSha256`（TLS 启用 + 证书指纹）
- `cliPath`（可选的远程安装路径提示）

### `gateway discover`

```bash
openclaw gateway discover
```

选项：

- `--timeout <ms>`：每条命令的超时时间（浏览/解析）；默认 `2000`。
- `--json`：机器可读输出（同时禁用样式/加载动画）。

示例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
