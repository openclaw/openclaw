---
read_when:
  - 将 iOS/Android 节点配对到 Gateway网关
  - 使用节点 canvas/相机为智能体提供上下文
  - 添加新的节点命令或 CLI 辅助工具
summary: 节点：配对、能力、权限，以及 canvas/相机/屏幕/系统的 CLI 辅助工具
title: 节点
x-i18n:
  generated_at: "2026-02-01T21:18:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7f7cc1934cfbb4176f0a7ce21371e51d9a9fb459dd73b8fce5a214b58877521f
  source_path: nodes/index.md
  workflow: 15
---

# 节点

**节点**是一个伴侣设备（macOS/iOS/Android/无头），通过 **WebSocket**（与操作员相同的端口）以 `role: "node"` 连接到 Gateway网关，并通过 `node.invoke` 暴露命令接口（例如 `canvas.*`、`camera.*`、`system.*`）。协议详情：[Gateway网关协议](/gateway/protocol)。

旧版传输：[Bridge 协议](/gateway/bridge-protocol)（TCP JSONL；当前节点已弃用/移除）。

macOS 也可以在**节点模式**下运行：菜单栏应用连接到 Gateway网关的 WS 服务器，并将其本地 canvas/相机命令作为节点暴露（因此 `openclaw nodes …` 可以对该 Mac 使用）。

注意事项：

- 节点是**外围设备**，不是 Gateway网关。它们不运行 Gateway网关服务。
- Telegram/WhatsApp 等消息到达的是 **Gateway网关**，而非节点。

## 配对 + 状态

**WS 节点使用设备配对。** 节点在 `connect` 时提供设备身份；Gateway网关为 `role: node` 创建设备配对请求。通过设备 CLI（或 UI）审批。

快速 CLI：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

注意事项：

- `nodes status` 在设备配对角色包含 `node` 时将节点标记为**已配对**。
- `node.pair.*`（CLI：`openclaw nodes pending/approve/reject`）是一个独立的 Gateway网关拥有的节点配对存储；它**不会**拦截 WS `connect` 握手。

## 远程节点主机（system.run）

当你的 Gateway网关运行在一台机器上而你希望命令在另一台机器上执行时，使用**节点主机**。模型仍然与 **Gateway网关** 通信；当选择 `host=node` 时，Gateway网关将 `exec` 调用转发给**节点主机**。

### 各部分运行位置

- **Gateway网关主机**：接收消息，运行模型，路由工具调用。
- **节点主机**：在节点机器上执行 `system.run`/`system.which`。
- **审批**：通过节点主机上的 `~/.openclaw/exec-approvals.json` 执行。

### 启动节点主机（前台）

在节点机器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 启动节点主机（服务）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配对 + 命名

在 Gateway网关主机上：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

命名选项：

- 在 `openclaw node run` / `openclaw node install` 上使用 `--display-name`（持久保存在节点的 `~/.openclaw/node.json` 中）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（Gateway网关覆盖）。

### 将命令加入允许列表

执行审批是**按节点主机**的。从 Gateway网关添加允许列表条目：

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

审批存储在节点主机的 `~/.openclaw/exec-approvals.json` 中。

### 将执行指向节点

配置默认值（Gateway网关配置）：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

或按会话设置：

```
/exec host=node security=allowlist node=<id-or-name>
```

设置后，任何 `host=node` 的 `exec` 调用都会在节点主机上运行（受节点允许列表/审批限制）。

相关链接：

- [节点主机 CLI](/cli/node)
- [Exec 工具](/tools/exec)
- [Exec 审批](/tools/exec-approvals)

## 调用命令

低级别（原始 RPC）：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

对于常见的"为智能体提供 MEDIA 附件"工作流，有更高级的辅助工具。

## 截图（canvas 快照）

如果节点正在显示 Canvas（WebView），`canvas.snapshot` 返回 `{ format, base64 }`。

CLI 辅助工具（写入临时文件并输出 `MEDIA:<path>`）：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas 控制

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意事项：

- `canvas present` 接受 URL 或本地文件路径（`--target`），以及可选的 `--x/--y/--width/--height` 用于定位。
- `canvas eval` 接受内联 JS（`--js`）或位置参数。

### A2UI（Canvas）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意事项：

- 仅支持 A2UI v0.8 JSONL（v0.9/createSurface 会被拒绝）。

## 照片 + 视频（节点相机）

照片（`jpg`）：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # 默认：两个朝向（2 行 MEDIA 输出）
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

视频片段（`mp4`）：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意事项：

- `canvas.*` 和 `camera.*` 要求节点处于**前台**（后台调用返回 `NODE_BACKGROUND_UNAVAILABLE`）。
- 片段时长有上限（当前 `<= 60s`），以避免过大的 base64 载荷。
- Android 会在可能时提示 `CAMERA`/`RECORD_AUDIO` 权限；拒绝权限时以 `*_PERMISSION_REQUIRED` 失败。

## 屏幕录制（节点）

节点暴露 `screen.record`（mp4）。示例：

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意事项：

- `screen.record` 要求节点应用处于前台。
- Android 会在录制前显示系统屏幕捕获提示。
- 屏幕录制上限为 `<= 60s`。
- `--no-audio` 禁用麦克风捕获（iOS/Android 支持；macOS 使用系统捕获音频）。
- 当有多个屏幕可用时，使用 `--screen <index>` 选择显示器。

## 位置（节点）

当设置中启用了位置功能时，节点暴露 `location.get`。

CLI 辅助工具：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意事项：

- 位置功能**默认关闭**。
- "始终"需要系统权限；后台获取为尽力而为。
- 响应包含经纬度、精度（米）和时间戳。

## 短信（Android 节点）

当用户授予 **SMS** 权限且设备支持电话功能时，Android 节点可以暴露 `sms.send`。

低级别调用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意事项：

- 必须在 Android 设备上接受权限提示后，该功能才会被广播。
- 没有电话功能的纯 Wi-Fi 设备不会广播 `sms.send`。

## 系统命令（节点主机 / Mac 节点）

macOS 节点暴露 `system.run`、`system.notify` 和 `system.execApprovals.get/set`。
无头节点主机暴露 `system.run`、`system.which` 和 `system.execApprovals.get/set`。

示例：

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway网关 ready"
```

注意事项：

- `system.run` 在载荷中返回 stdout/stderr/退出码。
- `system.notify` 遵循 macOS 应用的通知权限状态。
- `system.run` 支持 `--cwd`、`--env KEY=VAL`、`--command-timeout` 和 `--needs-screen-recording`。
- `system.notify` 支持 `--priority <passive|active|timeSensitive>` 和 `--delivery <system|overlay|auto>`。
- macOS 节点会丢弃 `PATH` 覆盖；无头节点主机仅在 `PATH` 前置于节点主机 PATH 时才接受。
- 在 macOS 节点模式下，`system.run` 受 macOS 应用中的执行审批限制（设置 → 执行审批）。
  询问/允许列表/完全访问的行为与无头节点主机相同；拒绝的提示返回 `SYSTEM_RUN_DENIED`。
- 在无头节点主机上，`system.run` 受执行审批限制（`~/.openclaw/exec-approvals.json`）。

## Exec 节点绑定

当有多个节点可用时，你可以将 exec 绑定到特定节点。
这会设置 `exec host=node` 的默认节点（可以按智能体覆盖）。

全局默认：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

按智能体覆盖：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

取消设置以允许任意节点：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 权限映射

节点可能在 `node.list` / `node.describe` 中包含 `permissions` 映射，以权限名称为键（例如 `screenRecording`、`accessibility`），布尔值为值（`true` = 已授予）。

## 无头节点主机（跨平台）

OpenClaw 可以运行**无头节点主机**（无 UI），它连接到 Gateway网关 WebSocket 并暴露 `system.run` / `system.which`。这适用于 Linux/Windows 或在服务器旁运行一个最小节点。

启动方式：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意事项：

- 仍然需要配对（Gateway网关会显示节点审批提示）。
- 节点主机将其节点 ID、令牌、显示名称和 Gateway网关连接信息存储在 `~/.openclaw/node.json` 中。
- 执行审批通过 `~/.openclaw/exec-approvals.json` 在本地执行（参见[执行审批](/tools/exec-approvals)）。
- 在 macOS 上，无头节点主机在伴侣应用执行主机可达时优先使用它，不可用时回退到本地执行。设置 `OPENCLAW_NODE_EXEC_HOST=app` 以要求使用应用，或设置 `OPENCLAW_NODE_EXEC_FALLBACK=0` 以禁用回退。
- 当 Gateway网关 WS 使用 TLS 时，添加 `--tls` / `--tls-fingerprint`。

## Mac 节点模式

- macOS 菜单栏应用作为节点连接到 Gateway网关 WS 服务器（因此 `openclaw nodes …` 可以对该 Mac 使用）。
- 在远程模式下，应用为 Gateway网关端口打开 SSH 隧道并连接到 `localhost`。
