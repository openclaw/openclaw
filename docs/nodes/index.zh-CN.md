---
summary: "节点：配对、功能、权限以及画布/相机/屏幕/设备/通知/系统的CLI助手"
read_when:
  - 将iOS/Android节点配对到网关
  - 使用节点画布/相机作为代理上下文
  - 添加新的节点命令或CLI助手
title: "节点"
---

# 节点

**节点**是一个 companion 设备（macOS/iOS/Android/无头），通过 `role: "node"` 连接到网关**WebSocket**（与操作员相同的端口），并通过 `node.invoke` 暴露命令表面（例如 `canvas.*`、`camera.*`、`device.*`、`notifications.*`、`system.*`）。协议详情：[网关协议](/gateway/protocol)。

旧版传输：[桥接协议](/gateway/bridge-protocol)（TCP JSONL；仅用于历史节点）。

macOS 也可以在**节点模式**下运行：菜单栏应用程序连接到网关的 WS 服务器，并将其本地画布/相机命令作为节点暴露（因此 `openclaw nodes …` 可以在这台 Mac 上工作）。

注意：

- 节点是**外围设备**，不是网关。它们不运行网关服务。
- Telegram/WhatsApp 等消息落在**网关**上，而不是节点上。
- 故障排除手册：[/nodes/troubleshooting](/nodes/troubleshooting)

## 配对 + 状态

**WS 节点使用设备配对**。节点在 `connect` 期间呈现设备身份；网关
为 `role: node` 创建设备配对请求。通过设备 CLI（或 UI）批准。

快速 CLI：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

如果节点使用更改的认证详细信息（角色/作用域/公钥）重试，先前的
待处理请求将被取代，并创建新的 `requestId`。在批准前重新运行
`openclaw devices list`。

注意：

- `nodes status` 当节点的设备配对角色包含 `node` 时，将节点标记为**已配对**。
- 设备配对记录是持久的已批准角色合同。令牌
  轮换保持在该合同内；它不能将配对节点升级为
  配对批准从未授予的不同角色。
- `node.pair.*`（CLI：`openclaw nodes pending/approve/reject/rename`）是一个单独的网关拥有的
  节点配对存储；它**不**控制 WS `connect` 握手。
- 批准范围遵循待处理请求的声明命令：
  - 无命令请求：`operator.pairing`
  - 非执行节点命令：`operator.pairing` + `operator.write`
  - `system.run` / `system.run.prepare` / `system.which`：`operator.pairing` + `operator.admin`

## 远程节点主机（system.run）

当您的网关在一台机器上运行，而您希望命令在另一台机器上执行时，使用**节点主机**。模型仍然与**网关**通信；当选择 `host=node` 时，网关将 `exec` 调用转发到**节点主机**。

### 运行位置

- **网关主机**：接收消息，运行模型，路由工具调用。
- **节点主机**：在节点机器上执行 `system.run`/`system.which`。
- **批准**：通过 `~/.openclaw/exec-approvals.json` 在节点主机上强制执行。

批准注意：

- 基于批准的节点运行绑定确切的请求上下文。
- 对于直接的 shell/运行时文件执行，OpenClaw 还会尽力绑定一个具体的本地
  文件操作数，如果该文件在执行前更改，则拒绝运行。
- 如果 OpenClaw 无法为解释器/运行时命令识别出确切的一个具体本地文件，
  则拒绝基于批准的执行，而不是假装完全覆盖运行时。对于更广泛的解释器语义，使用沙箱、
  单独的主机或显式的受信任允许列表/完整工作流。

### 启动节点主机（前台）

在节点机器上：

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### 通过 SSH 隧道的远程网关（环回绑定）

如果网关绑定到环回（`gateway.bind=loopback`，本地模式下的默认设置），
远程节点主机无法直接连接。创建 SSH 隧道并将节点主机指向
隧道的本地端。

示例（节点主机 -> 网关主机）：

```bash
# 终端 A（保持运行）：将本地 18790 转发到网关 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# 终端 B：导出网关令牌并通过隧道连接
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

注意：

- `openclaw node run` 支持令牌或密码认证。
- 环境变量是首选：`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`。
- 配置回退是 `gateway.auth.token` / `gateway.auth.password`。
- 在本地模式下，节点主机故意忽略 `gateway.remote.token` / `gateway.remote.password`。
- 在远程模式下，`gateway.remote.token` / `gateway.remote.password` 根据远程优先级规则是合格的。
- 如果配置了活动的本地 `gateway.auth.*` SecretRefs 但未解析，节点主机认证将关闭失败。
- 节点主机认证解析仅接受 `OPENCLAW_GATEWAY_*` 环境变量。

### 启动节点主机（服务）

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 配对 + 命名

在网关主机上：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

如果节点使用更改的认证详细信息重试，请重新运行 `openclaw devices list`
并批准当前的 `requestId`。

命名选项：

- `openclaw node run` / `openclaw node install` 上的 `--display-name`（在节点上持久存储在 `~/.openclaw/node.json` 中）。
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"`（网关覆盖）。

### 允许命令列表

执行批准是**每个节点主机**。从网关添加允许列表条目：

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

批准存储在节点主机的 `~/.openclaw/exec-approvals.json` 中。

### 将 exec 指向节点

配置默认值（网关配置）：

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

或每个会话：

```
/exec host=node security=allowlist node=<id-or-name>
```

设置后，任何带有 `host=node` 的 `exec` 调用都将在节点主机上运行（受节点允许列表/批准的限制）。

`host=auto` 不会自行隐式选择节点，但从 `auto` 允许显式的每次调用 `host=node` 请求。如果您希望节点执行成为会话的默认值，请设置 `tools.exec.host=node` 或显式使用 `/exec host=node ...`。

相关：

- [节点主机 CLI](/cli/node)
- [Exec 工具](/tools/exec)
- [Exec 批准](/tools/exec-approvals)

## 调用命令

低级（原始 RPC）：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

对于常见的“为代理提供 MEDIA 附件”工作流，存在更高级的助手。

## 屏幕截图（画布快照）

如果节点显示画布（WebView），`canvas.snapshot` 返回 `{ format, base64 }`。

CLI 助手（写入临时文件并打印 `MEDIA:<path>`）：

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### 画布控制

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

注意：

- `canvas present` 接受 URL 或本地文件路径（`--target`），以及可选的 `--x/--y/--width/--height` 用于定位。
- `canvas eval` 接受内联 JS（`--js`）或位置参数。

### A2UI（画布）

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

注意：

- 仅支持 A2UI v0.8 JSONL（v0.9/createSurface 被拒绝）。

## 照片 + 视频（节点相机）

照片（`jpg`）：

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # 默认：两个朝向（2 行 MEDIA）
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

视频剪辑（`mp4`）：

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

注意：

- 节点必须**前台运行**才能使用 `canvas.*` 和 `camera.*`（后台调用返回 `NODE_BACKGROUND_UNAVAILABLE`）。
- 剪辑持续时间被限制（当前 `<= 60s`）以避免过大的 base64 有效负载。
- Android 会在可能时提示 `CAMERA`/`RECORD_AUDIO` 权限；拒绝的权限会失败并显示 `*_PERMISSION_REQUIRED`。

## 屏幕录制（节点）

受支持的节点暴露 `screen.record`（mp4）。示例：

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

注意：

- `screen.record` 的可用性取决于节点平台。
- 屏幕录制被限制为 `<= 60s`。
- `--no-audio` 在支持的平台上禁用麦克风捕获。
- 当多个屏幕可用时，使用 `--screen <index>` 选择显示。

## 位置（节点）

当设置中启用位置时，节点会暴露 `location.get`。

CLI 助手：

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

注意：

- 位置**默认关闭**。
- “始终”需要系统权限；后台获取是尽力而为。
- 响应包括经纬度、精度（米）和时间戳。

## SMS（Android 节点）

当用户授予**SMS** 权限且设备支持电话时，Android 节点可以暴露 `sms.send`。

低级调用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

注意：

- 必须在 Android 设备上接受权限提示，然后才能宣传此功能。
- 没有电话功能的仅 Wi-Fi 设备不会宣传 `sms.send`。

## Android 设备 + 个人数据命令

当相应的功能启用时，Android 节点可以宣传额外的命令系列。

可用系列：

- `device.status`、`device.info`、`device.permissions`、`device.health`
- `notifications.list`、`notifications.actions`
- `photos.latest`
- `contacts.search`、`contacts.add`
- `calendar.events`、`calendar.add`
- `callLog.search`
- `sms.search`
- `motion.activity`、`motion.pedometer`

示例调用：

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```

注意：

- 运动命令由可用传感器的功能门控。

## 系统命令（节点主机 / Mac 节点）

macOS 节点暴露 `system.run`、`system.notify` 和 `system.execApprovals.get/set`。
无头节点主机暴露 `system.run`、`system.which` 和 `system.execApprovals.get/set`。

示例：

```bash
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
openclaw nodes invoke --node <idOrNameOrIp> --command system.which --params '{"name":"git"}'
```

注意：

- `system.run` 在有效负载中返回 stdout/stderr/退出代码。
- Shell 执行现在通过带有 `host=node` 的 `exec` 工具进行；`nodes` 仍然是显式节点命令的直接 RPC 表面。
- `nodes invoke` 不暴露 `system.run` 或 `system.run.prepare`；这些仅保留在 exec 路径上。
- exec 路径在批准前准备规范的 `systemRunPlan`。一旦
  批准被授予，网关转发该存储的计划，而不是任何后来的
  调用者编辑的命令/cwd/会话字段。
- `system.notify` 尊重 macOS 应用程序上的通知权限状态。
- 未识别的节点 `platform` / `deviceFamily` 元数据使用保守的默认允许列表，排除 `system.run` 和 `system.which`。如果您有意需要这些命令用于未知平台，请通过 `gateway.nodes.allowCommands` 明确添加它们。
- `system.run` 支持 `--cwd`、`--env KEY=VAL`、`--command-timeout` 和 `--needs-screen-recording`。
- 对于 shell 包装器（`bash|sh|zsh ... -c/-lc`），请求范围的 `--env` 值被减少到显式允许列表（`TERM`、`LANG`、`LC_*`、`COLORTERM`、`NO_COLOR`、`FORCE_COLOR`）。
- 对于允许列表模式中的始终允许决策，已知的调度包装器（`env`、`nice`、`nohup`、`stdbuf`、`timeout`）保留内部可执行路径而不是包装器路径。如果解包不安全，则不会自动持久化允许列表条目。
- 在允许列表模式下的 Windows 节点主机上，通过 `cmd.exe /c` 运行的 shell 包装器需要批准（仅允许列表条目不会自动允许包装器形式）。
- `system.notify` 支持 `--priority <passive|active|timeSensitive>` 和 `--delivery <system|overlay|auto>`。
- 节点主机忽略 `PATH` 覆盖并剥离危险的启动/shell 键（`DYLD_*`、`LD_*`、`NODE_OPTIONS`、`PYTHON*`、`PERL*`、`RUBYOPT`、`SHELLOPTS`、`PS4`）。如果您需要额外的 PATH 条目，请配置节点主机服务环境（或在标准位置安装工具），而不是通过 `--env` 传递 `PATH`。
- 在 macOS 节点模式下，`system.run` 由 macOS 应用程序中的执行批准门控（设置 → 执行批准）。
  Ask/allowlist/full 行为与无头节点主机相同；拒绝的提示返回 `SYSTEM_RUN_DENIED`。
- 在无头节点主机上，`system.run` 由执行批准门控（`~/.openclaw/exec-approvals.json`）。

## Exec 节点绑定

当多个节点可用时，您可以将 exec 绑定到特定节点。
这会为 `exec host=node` 设置默认节点（可以按代理覆盖）。

全局默认：

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

按代理覆盖：

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

取消设置以允许任何节点：

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 权限映射

节点可能在 `node.list` / `node.describe` 中包含 `permissions` 映射，按权限名称（例如 `screenRecording`、`accessibility`）键控，带有布尔值（`true` = 已授予）。

## 无头节点主机（跨平台）

OpenClaw 可以运行**无头节点主机**（无 UI），连接到网关
WebSocket 并暴露 `system.run` / `system.which`。这在 Linux/Windows 上很有用
或用于在服务器旁边运行最小节点。

启动它：

```bash
openclaw node run --host <gateway-host> --port 18789
```

注意：

- 仍然需要配对（网关会显示设备配对提示）。
- 节点主机将其节点 ID、令牌、显示名称和网关连接信息存储在 `~/.openclaw/node.json` 中。
- 执行批准通过 `~/.openclaw/exec-approvals.json` 在本地强制执行
  （请参阅 [Exec 批准](/tools/exec-approvals)）。
- 在 macOS 上，无头节点主机默认在本地执行 `system.run`。设置
  `OPENCLAW_NODE_EXEC_HOST=app` 以通过 companion 应用程序执行主机路由 `system.run`；添加
  `OPENCLAW_NODE_EXEC_FALLBACK=0` 以要求应用程序主机，如果不可用则关闭失败。
- 当网关 WS 使用 TLS 时，添加 `--tls` / `--tls-fingerprint`。

## Mac 节点模式

- macOS 菜单栏应用程序作为节点连接到网关 WS 服务器（因此 `openclaw nodes …` 可以在这台 Mac 上工作）。
- 在远程模式下，应用程序为网关端口打开 SSH 隧道并连接到 `localhost`。