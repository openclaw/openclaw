---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 运行或调试 Gateway 网关进程时（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: Gateway 网关服务、生命周期和运维的运行手册（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Gateway 网关运行手册（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:50:03Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 497d58090faaa6bdae62780ce887b40a1ad81e2e99ff186ea2a5c2249c35d9ba（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: gateway/index.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway 网关服务运行手册（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
最后更新：2025-12-09（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 是什么（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 拥有单一 Baileys/Telegram 连接和控制/事件平面的常驻进程。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 替代旧版 `gateway` 命令。CLI 入口点：`openclaw gateway`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 运行直到停止；出现致命错误时以非零退出码退出，以便 supervisor 重启它。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 如何运行（本地）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 在 stdio 中获取完整的调试/追踪日志：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789 --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 如果端口被占用，终止监听器然后启动：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 开发循环（TS 更改时自动重载）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 配置热重载监视 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 默认模式：`gateway.reload.mode="hybrid"`（热应用安全更改，关键更改时重启）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 热重载在需要时通过 **SIGUSR1** 使用进程内重启。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 使用 `gateway.reload.mode="off"` 禁用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 将 WebSocket 控制平面绑定到 `127.0.0.1:<port>`（默认 18789）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 同一端口也提供 HTTP 服务（控制界面、hooks、A2UI）。单端口多路复用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenAI Chat Completions（HTTP）：[`/v1/chat/completions`](/gateway/openai-http-api)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenResponses（HTTP）：[`/v1/responses`](/gateway/openresponses-http-api)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Tools Invoke（HTTP）：[`/tools/invoke`](/gateway/tools-invoke-http-api)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 默认在 `canvasHost.port`（默认 `18793`）上启动 Canvas 文件服务器，从 `~/.openclaw/workspace/canvas` 提供 `http://<gateway-host>:18793/__openclaw__/canvas/`。使用 `canvasHost.enabled=false` 或 `OPENCLAW_SKIP_CANVAS_HOST=1` 禁用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 输出日志到 stdout；使用 launchd/systemd 保持运行并轮转日志。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 故障排除时传递 `--verbose` 以将调试日志（握手、请求/响应、事件）从日志文件镜像到 stdio。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force` 使用 `lsof` 查找所选端口上的监听器，发送 SIGTERM，记录它终止了什么，然后启动 Gateway 网关（如果缺少 `lsof` 则快速失败）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 如果你在 supervisor（launchd/systemd/mac 应用子进程模式）下运行，stop/restart 通常发送 **SIGTERM**；旧版本可能将其显示为 `pnpm` `ELIFECYCLE` 退出码 **143**（SIGTERM），这是正常关闭，不是崩溃。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SIGUSR1** 在授权时触发进程内重启（Gateway 网关工具/配置应用/更新，或启用 `commands.restart` 以进行手动重启）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 默认需要 Gateway 网关认证：设置 `gateway.auth.token`（或 `OPENCLAW_GATEWAY_TOKEN`）或 `gateway.auth.password`。客户端必须发送 `connect.params.auth.token/password`，除非使用 Tailscale Serve 身份。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 向导现在默认生成令牌，即使在 loopback 上也是如此。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 端口优先级：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 默认 `18789`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 远程访问（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 首选 Tailscale/VPN；否则使用 SSH 隧道：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ssh -N -L 18789:127.0.0.1:18789 user@host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 然后客户端通过隧道连接到 `ws://127.0.0.1:18789`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 如果配置了令牌，即使通过隧道，客户端也必须在 `connect.params.auth.token` 中包含它。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 多个 Gateway 网关（同一主机）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
通常不需要：一个 Gateway 网关可以服务多个消息渠道和智能体。仅在需要冗余或严格隔离（例如：救援机器人）时使用多个 Gateway 网关。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
如果你隔离状态 + 配置并使用唯一端口，则支持。完整指南：[多个 Gateway 网关](/gateway/multiple-gateways)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
服务名称是配置文件感知的：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS：`bot.molt.<profile>`（旧版 `com.openclaw.*` 可能仍然存在）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux：`openclaw-gateway-<profile>.service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows：`OpenClaw Gateway (<profile>)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
安装元数据嵌入在服务配置中：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_MARKER=openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_KIND=gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SERVICE_VERSION=<version>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
救援机器人模式：保持第二个 Gateway 网关隔离，使用自己的配置文件、状态目录、工作区和基础端口间隔。完整指南：[救援机器人指南](/gateway/multiple-gateways#rescue-bot-guide)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Dev 配置文件（`--dev`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
快速路径：运行完全隔离的 dev 实例（配置/状态/工作区）而不触及你的主设置。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev gateway --allow-unconfigured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 然后定位到 dev 实例：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --dev health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
默认值（可通过 env/flags/config 覆盖）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR=~/.openclaw-dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_GATEWAY_PORT=19001`（Gateway 网关 WS + HTTP）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 浏览器控制服务端口 = `19003`（派生：`gateway.port+2`，仅 loopback）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost.port=19005`（派生：`gateway.port+4`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 当你在 `--dev` 下运行 `setup`/`onboard` 时，`agents.defaults.workspace` 默认变为 `~/.openclaw/workspace-dev`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
派生端口（经验法则）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 基础端口 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 浏览器控制服务端口 = 基础 + 2（仅 loopback）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost.port = 基础 + 4`（或 `OPENCLAW_CANVAS_HOST_PORT` / 配置覆盖）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 浏览器配置文件 CDP 端口从 `browser.controlPort + 9 .. + 108` 自动分配（按配置文件持久化）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
每个实例的检查清单：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 唯一的 `gateway.port`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 唯一的 `OPENCLAW_CONFIG_PATH`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 唯一的 `OPENCLAW_STATE_DIR`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 唯一的 `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 单独的 WhatsApp 号码（如果使用 WA）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
按配置文件安装服务：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile main gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --profile rescue gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
示例：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 协议（运维视角）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 完整文档：[Gateway 网关协议](/gateway/protocol) 和 [Bridge 协议（旧版）](/gateway/bridge-protocol)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 客户端必须发送的第一帧：`req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway 网关回复 `res {type:"res", id, ok:true, payload:hello-ok }`（或 `ok:false` 带错误，然后关闭）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 握手后：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 请求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 事件：`{type:"event", event, payload, seq?, stateVersion?}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 结构化 presence 条目：`{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`（对于 WS 客户端，`instanceId` 来自 `connect.client.instanceId`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` 响应是两阶段的：首先 `res` 确认 `{runId,status:"accepted"}`，然后在运行完成后发送最终 `res` `{runId,status:"ok"|"error",summary}`；流式输出作为 `event:"agent"` 到达。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 方法（初始集）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `health` — 完整健康快照（与 `openclaw health --json` 形状相同）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status` — 简短摘要。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system-presence` — 当前 presence 列表。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system-event` — 发布 presence/系统注释（结构化）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send` — 通过活跃渠道发送消息。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` — 运行智能体轮次（在同一连接上流回事件）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.list` — 列出已配对 + 当前连接的节点（包括 `caps`、`deviceFamily`、`modelIdentifier`、`paired`、`connected` 和广播的 `commands`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.describe` — 描述节点（能力 + 支持的 `node.invoke` 命令；适用于已配对节点和当前连接的未配对节点）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.invoke` — 在节点上调用命令（例如 `canvas.*`、`camera.*`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.*` — 配对生命周期（`request`、`list`、`approve`、`reject`、`verify`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
另见：[Presence](/concepts/presence) 了解 presence 如何产生/去重以及为什么稳定的 `client.instanceId` 很重要。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 事件（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent` — 来自智能体运行的流式工具/输出事件（带 seq 标记）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `presence` — presence 更新（带 stateVersion 的增量）推送到所有连接的客户端。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tick` — 定期保活/无操作以确认活跃。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `shutdown` — Gateway 网关正在退出；payload 包括 `reason` 和可选的 `restartExpectedMs`。客户端应重新连接。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WebChat 集成（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WebChat 是原生 SwiftUI UI，直接与 Gateway 网关 WebSocket 通信以获取历史记录、发送、中止和事件。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 远程使用通过相同的 SSH/Tailscale 隧道；如果配置了 Gateway 网关令牌，客户端在 `connect` 期间包含它。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS 应用通过单个 WS 连接（共享连接）；它从初始快照填充 presence 并监听 `presence` 事件以更新 UI。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 类型和验证（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 服务器使用 AJV 根据从协议定义发出的 JSON Schema 验证每个入站帧。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 客户端（TS/Swift）消费生成的类型（TS 直接使用；Swift 通过仓库的生成器）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 协议定义是真实来源；使用以下命令重新生成 schema/模型：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm protocol:gen:swift`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 连接快照（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hello-ok` 包含带有 `presence`、`health`、`stateVersion` 和 `uptimeMs` 的 `snapshot`，以及 `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`，这样客户端无需额外请求即可立即渲染。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `health`/`system-presence` 仍可用于手动刷新，但在连接时不是必需的。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 错误码（res.error 形状）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 错误使用 `{ code, message, details?, retryable?, retryAfterMs? }`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 标准码：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NOT_LINKED` — WhatsApp 未认证。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `AGENT_TIMEOUT` — 智能体未在配置的截止时间内响应。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `INVALID_REQUEST` — schema/参数验证失败。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `UNAVAILABLE` — Gateway 网关正在关闭或依赖项不可用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 保活行为（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tick` 事件（或 WS ping/pong）定期发出，以便客户端知道即使没有流量时 Gateway 网关也是活跃的。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 发送/智能体确认保持为单独的响应；不要为发送重载 tick。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 重放 / 间隙（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 事件不会重放。客户端检测 seq 间隙，应在继续之前刷新（`health` + `system-presence`）。WebChat 和 macOS 客户端现在会在间隙时自动刷新。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 监管（macOS 示例）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用 launchd 保持服务存活：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Program：`openclaw` 的路径（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Arguments：`gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - KeepAlive：true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - StandardOut/Err：文件路径或 `syslog`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 失败时，launchd 重启；致命的配置错误应保持退出，以便运维人员注意到。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- LaunchAgents 是按用户的，需要已登录的会话；对于无头设置，使用自定义 LaunchDaemon（未随附）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw gateway install` 写入 `~/Library/LaunchAgents/bot.molt.gateway.plist`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    （或 `bot.molt.<profile>.plist`；旧版 `com.openclaw.*` 会被清理）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw doctor` 审计 LaunchAgent 配置，可以将其更新为当前默认值。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway 网关服务管理（CLI）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
使用 Gateway 网关 CLI 进行 install/start/stop/restart/status：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
注意事项：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` 默认使用服务解析的端口/配置探测 Gateway 网关 RPC（使用 `--url` 覆盖）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --deep` 添加系统级扫描（LaunchDaemons/系统单元）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --no-probe` 跳过 RPC 探测（在网络故障时有用）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status --json` 对脚本是稳定的。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` 将 **supervisor 运行时**（launchd/systemd 运行中）与 **RPC 可达性**（WS 连接 + status RPC）分开报告。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` 打印配置路径 + 探测目标以避免"localhost vs LAN 绑定"混淆和配置文件不匹配。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` 在服务看起来正在运行但端口已关闭时包含最后一行 Gateway 网关错误。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `logs` 通过 RPC 尾随 Gateway 网关文件日志（无需手动 `tail`/`grep`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 如果检测到其他类似 Gateway 网关的服务，CLI 会发出警告，除非它们是 OpenClaw 配置文件服务。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  我们仍然建议大多数设置**每台机器一个 Gateway 网关**；使用隔离的配置文件/端口进行冗余或救援机器人。参见[多个 Gateway 网关](/gateway/multiple-gateways)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 清理：`openclaw gateway uninstall`（当前服务）和 `openclaw doctor`（旧版迁移）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` 在已安装时是无操作的；使用 `openclaw gateway install --force` 重新安装（配置文件/env/路径更改）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
捆绑的 mac 应用：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw.app 可以捆绑基于 Node 的 Gateway 网关中继并安装标记为（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `bot.molt.gateway`（或 `bot.molt.<profile>`；旧版 `com.openclaw.*` 标签仍能干净卸载）的按用户 LaunchAgent。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 要干净地停止它，使用 `openclaw gateway stop`（或 `launchctl bootout gui/$UID/bot.molt.gateway`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 要重启，使用 `openclaw gateway restart`（或 `launchctl kickstart -k gui/$UID/bot.molt.gateway`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `launchctl` 仅在 LaunchAgent 已安装时有效；否则先使用 `openclaw gateway install`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 运行命名配置文件时，将标签替换为 `bot.molt.<profile>`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 监管（systemd 用户单元）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw 在 Linux/WSL2 上默认安装 **systemd 用户服务**。我们（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
建议单用户机器使用用户服务（更简单的 env，按用户配置）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
对于多用户或常驻服务器使用**系统服务**（无需 lingering，（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
共享监管）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw gateway install` 写入用户单元。`openclaw doctor` 审计（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
单元并可以将其更新以匹配当前推荐的默认值。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
创建 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Unit]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Description=OpenClaw Gateway (profile: <profile>, v<version>)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wants=network-online.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Service]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ExecStart=/usr/local/bin/openclaw gateway --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart=always（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RestartSec=5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Environment=OPENCLAW_GATEWAY_TOKEN=（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WorkingDirectory=/home/youruser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Install]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WantedBy=default.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
启用 lingering（必需，以便用户服务在登出/空闲后继续存活）：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo loginctl enable-linger youruser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
新手引导在 Linux/WSL2 上运行此命令（可能提示输入 sudo；写入 `/var/lib/systemd/linger`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
然后启用服务：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user enable --now openclaw-gateway[-<profile>].service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**替代方案（系统服务）** - 对于常驻或多用户服务器，你可以（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
安装 systemd **系统**单元而不是用户单元（无需 lingering）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
创建 `/etc/systemd/system/openclaw-gateway[-<profile>].service`（复制上面的单元，（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
切换 `WantedBy=multi-user.target`，设置 `User=` + `WorkingDirectory=`），然后：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl daemon-reload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl enable --now openclaw-gateway[-<profile>].service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Windows（WSL2）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Windows 安装应使用 **WSL2** 并遵循上面的 Linux systemd 部分。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 运维检查（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 存活检查：打开 WS 并发送 `req:connect` → 期望收到带有 `payload.type="hello-ok"`（带快照）的 `res`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 就绪检查：调用 `health` → 期望 `ok: true` 并在 `linkChannel` 中有已关联的渠道（适用时）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 调试：订阅 `tick` 和 `presence` 事件；确保 `status` 显示已关联/认证时间；presence 条目显示 Gateway 网关主机和已连接的客户端。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 安全保证（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 默认假设每台主机一个 Gateway 网关；如果你运行多个配置文件，隔离端口/状态并定位到正确的实例。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 不会回退到直接 Baileys 连接；如果 Gateway 网关关闭，发送会快速失败。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 非 connect 的第一帧或格式错误的 JSON 会被拒绝并关闭 socket。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 优雅关闭：关闭前发出 `shutdown` 事件；客户端必须处理关闭 + 重新连接。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI 辅助工具（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway health|status` — 通过 Gateway 网关 WS 请求 health/status。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw message send --target <num> --message "hi" [--media ...]` — 通过 Gateway 网关发送（对 WhatsApp 是幂等的）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw agent --message "hi" --to <num>` — 运行智能体轮次（默认等待最终结果）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway call <method> --params '{"k":"v"}'` — 用于调试的原始方法调用器。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway stop|restart` — 停止/重启受监管的 Gateway 网关服务（launchd/systemd）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway 网关辅助子命令假设 `--url` 上有运行中的 Gateway 网关；它们不再自动生成一个。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 迁移指南（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 淘汰 `openclaw gateway` 和旧版 TCP 控制端口的使用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 更新客户端以使用带有强制 connect 和结构化 presence 的 WS 协议。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
