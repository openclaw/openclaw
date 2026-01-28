---
read_when:
  - 运行或调试 Gateway网关进程时
summary: Gateway网关服务的运维手册、生命周期与操作指南
title: Gateway网关运维手册
x-i18n:
  generated_at: "2026-02-01T20:40:09Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 497d58090faaa6bdae62780ce887b40a1ad81e2e99ff186ea2a5c2249c35d9ba
  source_path: gateway/index.md
  workflow: 14
---

# Gateway网关服务运维手册

最后更新：2025-12-09

## 简介

- 始终运行的进程，拥有唯一的 Baileys/Telegram 连接以及控制/事件平面。
- 替代旧版 `gateway` 命令。CLI 入口：`openclaw gateway`。
- 持续运行直到被停止；遇到致命错误时以非零状态退出，以便 supervisor 重启。

## 如何运行（本地）

```bash
openclaw gateway --port 18789
# 在标准输出中获取完整的调试/跟踪日志：
openclaw gateway --port 18789 --verbose
# 如果端口被占用，先终止监听进程再启动：
openclaw gateway --force
# 开发循环（TS 文件变更时自动重载）：
pnpm gateway:watch
```

- 配置热重载会监视 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）。
  - 默认模式：`gateway.reload.mode="hybrid"`（安全变更热应用，关键变更则重启）。
  - 热重载在需要时通过 **SIGUSR1** 进行进程内重启。
  - 通过 `gateway.reload.mode="off"` 禁用。
- WebSocket 控制平面绑定到 `127.0.0.1:<port>`（默认 18789）。
- 同一端口也提供 HTTP 服务（控制 UI、钩子、A2UI）。单端口复用。
  - OpenAI Chat Completions (HTTP)：[`/v1/chat/completions`](/gateway/openai-http-api)。
  - OpenResponses (HTTP)：[`/v1/responses`](/gateway/openresponses-http-api)。
  - Tools Invoke (HTTP)：[`/tools/invoke`](/gateway/tools-invoke-http-api)。
- 默认在 `canvasHost.port`（默认 `18793`）启动 Canvas 文件服务器，从 `~/.openclaw/workspace/canvas` 提供 `http://<gateway-host>:18793/__openclaw__/canvas/` 服务。通过 `canvasHost.enabled=false` 或 `OPENCLAW_SKIP_CANVAS_HOST=1` 禁用。
- 日志输出到标准输出；使用 launchd/systemd 保持进程存活并轮转日志。
- 传入 `--verbose` 可在故障排除时将调试日志（握手、请求/响应、事件）从日志文件镜像到标准输出。
- `--force` 使用 `lsof` 查找所选端口上的监听进程，发送 SIGTERM，记录被终止的进程，然后启动 Gateway网关（如果缺少 `lsof` 则快速失败）。
- 如果在 supervisor（launchd/systemd/mac app 子进程模式）下运行，停止/重启通常发送 **SIGTERM**；旧版本可能将其显示为 `pnpm` `ELIFECYCLE` 退出码 **143**（SIGTERM），这是正常关闭，不是崩溃。
- **SIGUSR1** 在授权时触发进程内重启（Gateway网关工具/配置应用/更新，或启用 `commands.restart` 以进行手动重启）。
- 默认需要 Gateway网关认证：设置 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）或 `gateway.auth.password`。客户端必须发送 `connect.params.auth.token/password`，除非使用 Tailscale Serve 身份。
- 向导现在默认生成令牌，即使在 local loopback 上也是如此。
- 端口优先级：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 默认 `18789`。

## 远程访问

- 推荐使用 Tailscale/VPN；否则使用 SSH 隧道：
  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```
- 客户端通过隧道连接到 `ws://127.0.0.1:18789`。
- 如果配置了令牌，客户端即使通过隧道也必须在 `connect.params.auth.token` 中包含令牌。

## 多个 Gateway网关（同一主机）

通常不需要：一个 Gateway网关可以服务多个消息渠道和智能体。仅在需要冗余或严格隔离（例如：救援机器人）时使用多个 Gateway网关。

如果隔离状态 + 配置并使用唯一端口，则支持多实例。完整指南：[多 Gateway网关](/gateway/multiple-gateways)。

服务名称是配置文件感知的：

- macOS：`bot.molt.<profile>`（旧版 `com.openclaw.*` 可能仍然存在）
- Linux：`openclaw-gateway-<profile>.service`
- Windows：`OpenClaw Gateway网关 (<profile>)`

安装元数据嵌入在服务配置中：

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

救援机器人模式：保持第二个 Gateway网关隔离，使用独立的配置文件、状态目录、工作区和基础端口间距。完整指南：[救援机器人指南](/gateway/multiple-gateways#rescue-bot-guide)。

### 开发配置文件（`--dev`）

快速路径：运行完全隔离的开发实例（配置/状态/工作区），不影响主要设置。

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# 然后指向开发实例：
openclaw --dev status
openclaw --dev health
```

默认值（可通过环境变量/标志/配置覆盖）：

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001`（Gateway网关 WS + HTTP）
- 浏览器控制服务端口 = `19003`（派生：`gateway.port+2`，仅 local loopback）
- `canvasHost.port=19005`（派生：`gateway.port+4`）
- 在 `--dev` 下运行 `setup`/`onboard` 时，`agents.defaults.workspace` 默认变为 `~/.openclaw/workspace-dev`。

派生端口（经验规则）：

- 基础端口 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）
- 浏览器控制服务端口 = 基础端口 + 2（仅 local loopback）
- `canvasHost.port = 基础端口 + 4`（或 `OPENCLAW_CANVAS_HOST_PORT` / 配置覆盖）
- 浏览器配置文件 CDP 端口从 `browser.controlPort + 9 .. + 108` 自动分配（按配置文件持久化）。

每个实例的检查清单：

- 唯一的 `gateway.port`
- 唯一的 `OPENCLAW_CONFIG_PATH`
- 唯一的 `OPENCLAW_STATE_DIR`
- 唯一的 `agents.defaults.workspace`
- 独立的 WhatsApp 号码（如果使用 WA）

按配置文件安装服务：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

示例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## 协议（运维视角）

- 完整文档：[Gateway网关协议](/gateway/protocol) 和 [Bridge 协议（旧版）](/gateway/bridge-protocol)。
- 客户端必须发送的第一帧：`req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`。
- Gateway网关回复 `res {type:"res", id, ok:true, payload:hello-ok }`（或 `ok:false` 附带错误信息，然后关闭连接）。
- 握手完成后：
  - 请求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`
- 结构化在线状态条目：`{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`（对于 WS 客户端，`instanceId` 来自 `connect.client.instanceId`）。
- `agent` 响应分两个阶段：首先是 `res` 确认 `{runId,status:"accepted"}`，然后在运行完成后发送最终 `res` `{runId,status:"ok"|"error",summary}`；流式输出以 `event:"agent"` 形式到达。

## 方法（初始集合）

- `health` — 完整健康快照（与 `openclaw health --json` 形状相同）。
- `status` — 简短摘要。
- `system-presence` — 当前在线状态列表。
- `system-event` — 发布在线状态/系统通知（结构化）。
- `send` — 通过活跃渠道发送消息。
- `agent` — 运行智能体回合（在同一连接上流式返回事件）。
- `node.list` — 列出已配对 + 当前已连接的节点（包括 `caps`、`deviceFamily`、`modelIdentifier`、`paired`、`connected` 以及已通告的 `commands`）。
- `node.describe` — 描述节点（能力 + 支持的 `node.invoke` 命令；适用于已配对节点和当前已连接的未配对节点）。
- `node.invoke` — 在节点上调用命令（例如 `canvas.*`、`camera.*`）。
- `node.pair.*` — 配对生命周期（`request`、`list`、`approve`、`reject`、`verify`）。

另请参阅：[在线状态](/concepts/presence) 了解在线状态的生成/去重方式以及稳定的 `client.instanceId` 为何重要。

## 事件

- `agent` — 来自智能体运行的流式工具/输出事件（带 seq 标签）。
- `presence` — 在线状态更新（带 stateVersion 的增量）推送给所有已连接的客户端。
- `tick` — 定期心跳/空操作，确认活跃性。
- `shutdown` — Gateway网关正在退出；负载包含 `reason` 和可选的 `restartExpectedMs`。客户端应重新连接。

## WebChat 集成

- WebChat 是原生 SwiftUI UI，直接通过 Gateway网关 WebSocket 进行历史记录、发送、中止和事件交互。
- 远程使用通过相同的 SSH/Tailscale 隧道；如果配置了 Gateway网关令牌，客户端在 `connect` 时包含它。
- macOS 应用通过单个 WS（共享连接）连接；它从初始快照中获取在线状态，并监听 `presence` 事件以更新 UI。

## 类型与验证

- 服务器使用 AJV 根据协议定义生成的 JSON Schema 验证每个入站帧。
- 客户端（TS/Swift）使用生成的类型（TS 直接使用；Swift 通过仓库的生成器）。
- 协议定义是唯一的事实来源；通过以下命令重新生成 schema/模型：
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## 连接快照

- `hello-ok` 包含一个 `snapshot`，其中有 `presence`、`health`、`stateVersion` 和 `uptimeMs`，以及 `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`，使客户端无需额外请求即可立即渲染。
- `health`/`system-presence` 仍可用于手动刷新，但在连接时不是必需的。

## 错误码（res.error 结构）

- 错误使用 `{ code, message, details?, retryable?, retryAfterMs? }` 格式。
- 标准错误码：
  - `NOT_LINKED` — WhatsApp 未认证。
  - `AGENT_TIMEOUT` — 智能体未在配置的截止时间内响应。
  - `INVALID_REQUEST` — schema/参数验证失败。
  - `UNAVAILABLE` — Gateway网关正在关闭或依赖不可用。

## 心跳行为

- `tick` 事件（或 WS ping/pong）会定期发出，以便客户端在没有流量时也能知道 Gateway网关处于活跃状态。
- 发送/智能体确认仍为独立响应；不要将 tick 用于发送。

## 重放/间隙

- 事件不会重放。客户端检测到 seq 间隙后，应在继续之前刷新（`health` + `system-presence`）。WebChat 和 macOS 客户端现在会在检测到间隙时自动刷新。

## 进程监管（macOS 示例）

- 使用 launchd 保持服务存活：
  - Program：`openclaw` 的路径
  - Arguments：`gateway`
  - KeepAlive：true
  - StandardOut/Err：文件路径或 `syslog`
- 失败时 launchd 会重启；致命的配置错误应持续退出，以便运维人员注意到。
- LaunchAgents 是按用户的，需要已登录的会话；对于无头设置，请使用自定义 LaunchDaemon（未随附）。
  - `openclaw gateway install` 写入 `~/Library/LaunchAgents/bot.molt.gateway.plist`
    （或 `bot.molt.<profile>.plist`；旧版 `com.openclaw.*` 会被清理）。
  - `openclaw doctor` 审计 LaunchAgent 配置，并可将其更新为当前推荐的默认值。

## Gateway网关服务管理（CLI）

使用 Gateway网关 CLI 进行安装/启动/停止/重启/状态查询：

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

注意事项：

- `gateway status` 默认使用服务解析的端口/配置探测 Gateway网关 RPC（可通过 `--url` 覆盖）。
- `gateway status --deep` 添加系统级扫描（LaunchDaemons/系统单元）。
- `gateway status --no-probe` 跳过 RPC 探测（在网络不可用时有用）。
- `gateway status --json` 输出稳定，适用于脚本。
- `gateway status` 将 **supervisor 运行时**（launchd/systemd 运行中）与 **RPC 可达性**（WS 连接 + 状态 RPC）分开报告。
- `gateway status` 打印配置路径 + 探测目标，以避免"localhost vs LAN 绑定"混淆和配置文件不匹配。
- `gateway status` 在服务看起来正在运行但端口已关闭时包含最后一条 Gateway网关错误行。
- `logs` 通过 RPC 跟踪 Gateway网关文件日志（无需手动 `tail`/`grep`）。
- 如果检测到其他类似 Gateway网关的服务，CLI 会发出警告，除非它们是 OpenClaw 配置文件服务。
  我们仍建议大多数场景下**每台机器一个 Gateway网关**；使用隔离的配置文件/端口实现冗余或救援机器人。参见 [多 Gateway网关](/gateway/multiple-gateways)。
  - 清理：`openclaw gateway uninstall`（当前服务）和 `openclaw doctor`（旧版迁移）。
- `gateway install` 在已安装时为空操作；使用 `openclaw gateway install --force` 重新安装（配置文件/环境/路径变更）。

捆绑的 Mac 应用：

- OpenClaw.app 可以捆绑一个基于 Node 的 Gateway网关中继，并安装按用户的 LaunchAgent，标签为
  `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.openclaw.*` 标签仍可正常卸载）。
- 要正常停止，使用 `openclaw gateway stop`（或 `launchctl bootout gui/$UID/bot.molt.gateway`）。
- 要重启，使用 `openclaw gateway restart`（或 `launchctl kickstart -k gui/$UID/bot.molt.gateway`）。
  - `launchctl` 仅在 LaunchAgent 已安装时有效；否则先使用 `openclaw gateway install`。
  - 运行命名配置文件时，将标签替换为 `bot.molt.<profile>`。

## 进程监管（systemd 用户单元）

OpenClaw 在 Linux/WSL2 上默认安装 **systemd 用户服务**。我们推荐单用户机器使用用户服务（更简单的环境，按用户配置）。对于多用户或始终在线的服务器，使用**系统服务**（无需 lingering，共享监管）。

`openclaw gateway install` 写入用户单元。`openclaw doctor` 审计该单元，并可将其更新为当前推荐的默认值。

创建 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：

```
[Unit]
Description=OpenClaw Gateway网关 (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

启用 lingering（必需，以便用户服务在注销/空闲后继续运行）：

```
sudo loginctl enable-linger youruser
```

新手引导在 Linux/WSL2 上会运行此命令（可能提示输入 sudo 密码；写入 `/var/lib/systemd/linger`）。
然后启用服务：

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**替代方案（系统服务）** - 对于始终在线或多用户服务器，可以安装 systemd **系统**单元而非用户单元（无需 lingering）。创建 `/etc/systemd/system/openclaw-gateway[-<profile>].service`（复制上述单元，将 `WantedBy=multi-user.target`，设置 `User=` + `WorkingDirectory=`），然后：

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows 安装应使用 **WSL2** 并遵循上述 Linux systemd 部分。

## 运维检查

- 存活性：打开 WS 并发送 `req:connect` → 期望收到带有 `payload.type="hello-ok"`（含快照）的 `res`。
- 就绪性：调用 `health` → 期望 `ok: true` 且 `linkChannel` 中有已连接的渠道（适用时）。
- 调试：订阅 `tick` 和 `presence` 事件；确保 `status` 显示已连接/认证时间；在线状态条目显示 Gateway网关主机和已连接的客户端。

## 安全保证

- 默认假设每台主机一个 Gateway网关；如果运行多个配置文件，请隔离端口/状态并指向正确的实例。
- 不会回退到直接 Baileys 连接；如果 Gateway网关不可用，发送会快速失败。
- 非 connect 的首帧或格式错误的 JSON 会被拒绝并关闭 socket。
- 优雅关闭：关闭前发出 `shutdown` 事件；客户端必须处理关闭 + 重新连接。

## CLI 辅助工具

- `openclaw gateway health|status` — 通过 Gateway网关 WS 请求健康/状态信息。
- `openclaw message send --target <num> --message "hi" [--media ...]` — 通过 Gateway网关发送（对 WhatsApp 具有幂等性）。
- `openclaw agent --message "hi" --to <num>` — 运行智能体回合（默认等待最终结果）。
- `openclaw gateway call <method> --params '{"k":"v"}'` — 用于调试的原始方法调用器。
- `openclaw gateway stop|restart` — 停止/重启受监管的 Gateway网关服务（launchd/systemd）。
- Gateway网关辅助子命令假设 Gateway网关已在 `--url` 上运行；它们不再自动启动 Gateway网关。

## 迁移指南

- 弃用 `openclaw gateway` 和旧版 TCP 控制端口的用法。
- 更新客户端以使用带有强制 connect 和结构化在线状态的 WS 协议。
