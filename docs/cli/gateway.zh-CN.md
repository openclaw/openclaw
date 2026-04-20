---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — 运行、查询和发现网关"
read_when:
  - 从 CLI 运行 Gateway（开发或服务器）
  - 调试 Gateway 身份验证、绑定模式和连接性
  - 通过 Bonjour 发现网关（本地 + 广域 DNS-SD）
title: "gateway"
---

# Gateway CLI

Gateway 是 OpenClaw 的 WebSocket 服务器（通道、节点、会话、钩子）。

本页中的子命令位于 `openclaw gateway …` 下。

相关文档：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 运行 Gateway

运行本地 Gateway 进程：

```bash
openclaw gateway
```

前台别名：

```bash
openclaw gateway run
```

注意：

- 默认情况下，除非 `~/.openclaw/openclaw.json` 中设置了 `gateway.mode=local`，否则 Gateway 拒绝启动。对于临时/开发运行，使用 `--allow-unconfigured`。
- `openclaw onboard --mode local` 和 `openclaw setup` 应该写入 `gateway.mode=local`。如果文件存在但缺少 `gateway.mode`，将其视为损坏或被覆盖的配置并修复它，而不是隐式假设本地模式。
- 如果文件存在且缺少 `gateway.mode`，Gateway 会将其视为可疑的配置损坏，并拒绝为您“猜测本地”。
- 无身份验证的环回外绑定被阻止（安全护栏）。
- `SIGUSR1` 在授权时触发进程内重启（`commands.restart` 默认启用；设置 `commands.restart: false` 可阻止手动重启，同时仍允许网关工具/配置应用/更新）。
- `SIGINT`/`SIGTERM` 处理程序停止网关进程，但它们不会恢复任何自定义终端状态。如果使用 TUI 或原始模式输入包装 CLI，请在退出前恢复终端。

### 选项

- `--port <port>`: WebSocket 端口（默认来自配置/环境；通常为 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`: 监听器绑定模式。
- `--auth <token|password>`: 身份验证模式覆盖。
- `--token <token>`: 令牌覆盖（还为进程设置 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`: 密码覆盖。警告：内联密码可能会在本地进程列表中暴露。
- `--password-file <path>`: 从文件读取网关密码。
- `--tailscale <off|serve|funnel>`: 通过 Tailscale 暴露 Gateway。
- `--tailscale-reset-on-exit`: 在关闭时重置 Tailscale serve/funnel 配置。
- `--allow-unconfigured`: 允许在配置中没有 `gateway.mode=local` 的情况下启动网关。这仅为临时/开发引导绕过启动防护；它不会写入或修复配置文件。
- `--dev`: 如果缺少，则创建开发配置 + 工作区（跳过 BOOTSTRAP.md）。
- `--reset`: 重置开发配置 + 凭据 + 会话 + 工作区（需要 `--dev`）。
- `--force`: 在启动前杀死所选端口上的任何现有监听器。
- `--verbose`: 详细日志。
- `--cli-backend-logs`: 仅在控制台中显示 CLI 后端日志（并启用 stdout/stderr）。
- `--ws-log <auto|full|compact>`: WebSocket 日志样式（默认 `auto`）。
- `--compact`: `--ws-log compact` 的别名。
- `--raw-stream`: 将原始模型流事件记录到 jsonl。
- `--raw-stream-path <path>`: 原始流 jsonl 路径。

## 查询运行中的 Gateway

所有查询命令都使用 WebSocket RPC。

输出模式：

- 默认：人类可读（在 TTY 中着色）。
- `--json`: 机器可读 JSON（无样式/旋转器）。
- `--no-color`（或 `NO_COLOR=1`）：禁用 ANSI 同时保持人类布局。

共享选项（在支持的地方）：

- `--url <url>`: Gateway WebSocket URL。
- `--token <token>`: Gateway 令牌。
- `--password <password>`: Gateway 密码。
- `--timeout <ms>`: 超时/预算（因命令而异）。
- `--expect-final`: 等待“最终”响应（代理调用）。

注意：当您设置 `--url` 时，CLI 不会回退到配置或环境凭据。
请明确传递 `--token` 或 `--password`。缺少明确的凭据是错误。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway usage-cost`

从会话日志中获取使用成本摘要。

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --json
```

选项：

- `--days <days>`: 包含的天数（默认 `30`）。

### `gateway status`

`gateway status` 显示 Gateway 服务（launchd/systemd/schtasks）以及可选的 RPC 探测。

```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --require-rpc
```

选项：

- `--url <url>`: 添加显式探测目标。配置的远程 + 本地主机仍然被探测。
- `--token <token>`: 探测的令牌身份验证。
- `--password <password>`: 探测的密码身份验证。
- `--timeout <ms>`: 探测超时（默认 `10000`）。
- `--no-probe`: 跳过 RPC 探测（仅服务视图）。
- `--deep`: 也扫描系统级服务。
- `--require-rpc`: 当 RPC 探测失败时退出非零。不能与 `--no-probe` 组合使用。

注意：

- 即使本地 CLI 配置缺失或无效，`gateway status` 仍然可用于诊断。
- `gateway status` 在可能的情况下解析配置的身份验证 SecretRef 用于探测身份验证。
- 如果在此命令路径中未解析所需的身份验证 SecretRef，`gateway status --json` 在探测连接/身份验证失败时报告 `rpc.authWarning`；请明确传递 `--token`/`--password` 或先解析秘密源。
- 如果探测成功，未解析的身份验证引用警告会被抑制以避免误报。
- 在脚本和自动化中使用 `--require-rpc`，当监听服务不足且您需要 Gateway RPC 本身健康时。
- `--deep` 添加对额外 launchd/systemd/schtasks 安装的尽力扫描。当检测到多个类似网关的服务时，人类输出会打印清理提示并警告大多数设置应该在每台机器上运行一个网关。
- 人类输出包括解析的文件日志路径以及 CLI 与服务配置路径/有效性快照，以帮助诊断配置文件或状态目录漂移。
- 在 Linux systemd 安装上，服务身份验证漂移检查从单元中读取 `Environment=` 和 `EnvironmentFile=` 值（包括 `%h`、引用路径、多个文件和可选的 `-` 文件）。
- 漂移检查使用合并的运行时环境（服务命令环境优先，然后是进程环境回退）解析 `gateway.auth.token` SecretRef。
- 如果令牌身份验证未有效激活（显式 `gateway.auth.mode` 为 `password`/`none`/`trusted-proxy`，或模式未设置，其中密码可以获胜且没有令牌候选可以获胜），令牌漂移检查会跳过配置令牌解析。

### `gateway probe`

`gateway probe` 是“调试所有内容”命令。它始终探测：

- 您配置的远程网关（如果设置），以及
- 本地主机（环回）**即使配置了远程**。

如果您传递 `--url`，该显式目标会添加到两者之前。人类输出将目标标记为：

- `URL (explicit)`
- `Remote (configured)` 或 `Remote (configured, inactive)`
- `Local loopback`

如果多个网关可达，它会打印所有网关。当您使用隔离的配置文件/端口时（例如，救援机器人），支持多个网关，但大多数安装仍然运行单个网关。

```bash
openclaw gateway probe
openclaw gateway probe --json
```

解释：

- `Reachable: yes` 表示至少一个目标接受了 WebSocket 连接。
- `RPC: ok` 表示详细 RPC 调用（`health`/`status`/`system-presence`/`config.get`）也成功了。
- `RPC: limited - missing scope: operator.read` 表示连接成功但详细 RPC 受到范围限制。这被报告为**降级**可达性，而不是完全失败。
- 仅当没有探测目标可达时，退出代码才为非零。

JSON 注意事项（`--json`）：

- 顶层：
  - `ok`: 至少一个目标可达。
  - `degraded`: 至少一个目标具有范围有限的详细 RPC。
  - `primaryTargetId`: 最佳目标，按以下顺序视为活动赢家：显式 URL、SSH 隧道、配置的远程，然后是本地环回。
  - `warnings[]`: 尽力警告记录，包含 `code`、`message` 和可选的 `targetIds`。
  - `network`: 从当前配置和主机网络派生的本地环回/tailnet URL 提示。
  - `discovery.timeoutMs` 和 `discovery.count`: 此探测传递使用的实际发现预算/结果计数。
- 每个目标（`targets[].connect`）：
  - `ok`: 连接后的可达性 + 降级分类。
  - `rpcOk`: 完整的详细 RPC 成功。
  - `scopeLimited`: 详细 RPC 因缺少操作员范围而失败。

常见警告代码：

- `ssh_tunnel_failed`: SSH 隧道设置失败；命令回退到直接探测。
- `multiple_gateways`: 多个目标可达；这是不寻常的，除非您故意运行隔离的配置文件，例如救援机器人。
- `auth_secretref_unresolved`: 无法为失败的目标解析配置的身份验证 SecretRef。
- `probe_scope_limited`: WebSocket 连接成功，但详细 RPC 因缺少 `operator.read` 而受限。

#### 通过 SSH 远程（Mac 应用程序 parity）

macOS 应用程序的“通过 SSH 远程”模式使用本地端口转发，因此远程网关（可能仅绑定到环回）可以在 `ws://127.0.0.1:<port>` 上访问。

CLI 等效项：

```bash
openclaw gateway probe --ssh user@gateway-host
```

选项：

- `--ssh <target>`: `user@host` 或 `user@host:port`（端口默认为 `22`）。
- `--ssh-identity <path>`: 身份文件。
- `--ssh-auto`: 从解析的发现端点（`local.` 加上配置的广域域名，如果有）中选择第一个发现的网关主机作为 SSH 目标。仅 TXT 提示被忽略。

配置（可选，用作默认值）：

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

低级 RPC 助手。

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

选项：

- `--params <json>`: 参数的 JSON 对象字符串（默认 `{}`）
- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--timeout <ms>`
- `--expect-final`
- `--json`

注意：

- `--params` 必须是有效的 JSON。
- `--expect-final` 主要用于在最终有效负载之前流式传输中间事件的代理样式 RPC。

## 管理 Gateway 服务

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

命令选项：

- `gateway status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `gateway install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- `gateway uninstall|start|stop|restart`: `--json`

注意：

- `gateway install` 支持 `--port`、`--runtime`、`--token`、`--force`、`--json`。
- 当令牌身份验证需要令牌且 `gateway.auth.token` 由 SecretRef 管理时，`gateway install` 验证 SecretRef 是否可解析，但不会将解析的令牌持久化到服务环境元数据中。
- 如果令牌身份验证需要令牌且配置的令牌 SecretRef 未解析，安装会失败关闭，而不是持久化回退明文。
- 对于 `gateway run` 上的密码身份验证，优先使用 `OPENCLAW_GATEWAY_PASSWORD`、`--password-file` 或 SecretRef 支持的 `gateway.auth.password`，而不是内联 `--password`。
- 在推断的身份验证模式中，仅 shell 的 `OPENCLAW_GATEWAY_PASSWORD` 不会放宽安装令牌要求；安装托管服务时使用持久配置（`gateway.auth.password` 或配置 `env`）。
- 如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password` 且未设置 `gateway.auth.mode`，则安装会被阻止，直到明确设置模式。
- 生命周期命令接受 `--json` 用于脚本编写。

## 发现网关（Bonjour）

`gateway discover` 扫描 Gateway 信标（`_openclaw-gw._tcp`）。

- 多播 DNS-SD: `local.`
- 单播 DNS-SD（广域 Bonjour）：选择一个域（例如：`openclaw.internal.`）并设置拆分 DNS + DNS 服务器；请参阅 [/gateway/bonjour](/gateway/bonjour)

只有启用了 Bonjour 发现（默认）的网关才会广播信标。

广域发现记录包括（TXT）：

- `role`（网关角色提示）
- `transport`（传输提示，例如 `gateway`）
- `gatewayPort`（WebSocket 端口，通常为 `18789`）
- `sshPort`（可选；当它不存在时，客户端默认 SSH 目标为 `22`）
- `tailnetDns`（MagicDNS 主机名，当可用时）
- `gatewayTls` / `gatewayTlsSha256`（启用 TLS + 证书指纹）
- `cliPath`（写入广域区域的远程安装提示）

### `gateway discover`

```bash
openclaw gateway discover
```

选项：

- `--timeout <ms>`: 每命令超时（浏览/解析）；默认 `2000`。
- `--json`: 机器可读输出（也禁用样式/旋转器）。

示例：

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```

注意：

- CLI 扫描 `local.` 加上配置的广域域名（当启用时）。
- JSON 输出中的 `wsUrl` 派生自解析的服务端点，而不是仅 TXT 提示，如 `lanHost` 或 `tailnetDns`。
- 在 `local.` mDNS 上，`sshPort` 和 `cliPath` 仅在 `discovery.mdns.mode` 为 `full` 时广播。广域 DNS-SD 仍然写入 `cliPath`；`sshPort` 在那里也保持可选。
