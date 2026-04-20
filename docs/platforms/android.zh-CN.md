---
summary: "Android 应用（节点）：连接运行手册 + 连接/聊天/语音/画布命令界面"
read_when:
  - 配对或重新连接 Android 节点
  - 调试 Android 网关发现或身份验证
  - 验证跨客户端的聊天历史一致性
title: "Android 应用"
---

# Android 应用（节点）

> **注意：** Android 应用尚未公开发布。源代码在 [OpenClaw 仓库](https://github.com/openclaw/openclaw) 的 `apps/android` 下可用。您可以使用 Java 17 和 Android SDK 自行构建它（`./gradlew :app:assemblePlayDebug`）。请参阅 [apps/android/README.md](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md) 了解构建说明。

## 支持快照

- 角色：伴随节点应用（Android 不托管网关）。
- 需要网关：是（在 macOS、Linux 或通过 WSL2 的 Windows 上运行）。
- 安装：[快速开始](/start/getting-started) + [配对](/channels/pairing)。
- 网关：[运行手册](/gateway) + [配置](/gateway/configuration)。
  - 协议：[网关协议](/gateway/protocol)（节点 + 控制平面）。

## 系统控制

系统控制（launchd/systemd）位于网关主机上。请参阅 [网关](/gateway)。

## 连接运行手册

Android 节点应用 ⇄ (mDNS/NSD + WebSocket) ⇄ **网关**

Android 直接连接到网关 WebSocket 并使用设备配对（`role: node`）。

对于 Tailscale 或公共主机，Android 需要安全端点：

- 首选：Tailscale Serve / Funnel，使用 `https://<magicdns>` / `wss://<magicdns>`
- 也支持：任何其他带有真实 TLS 端点的 `wss://` 网关 URL
- 明文 `ws://` 在私有 LAN 地址 / `.local` 主机上仍然支持，以及 `localhost`、`127.0.0.1` 和 Android 模拟器桥接器（`10.0.2.2`）

### 先决条件

- 您可以在“主”机器上运行网关。
- Android 设备/模拟器可以访问网关 WebSocket：
  - 同一 LAN 上有 mDNS/NSD，**或**
  - 同一 Tailscale tailnet 使用广域 Bonjour / 单播 DNS-SD（见下文），**或**
  - 手动网关主机/端口（回退）
- Tailnet/公共移动配对**不**使用原始 tailnet IP `ws://` 端点。请改用 Tailscale Serve 或另一个 `wss://` URL。
- 您可以在网关机器上运行 CLI（`openclaw`）（或通过 SSH）。

### 1) 启动网关

```bash
openclaw gateway --port 18789 --verbose
```

在日志中确认您看到类似以下内容：

- `listening on ws://0.0.0.0:18789`

对于通过 Tailscale 的远程 Android 访问，优先使用 Serve/Funnel 而不是原始 tailnet 绑定：

```bash
openclaw gateway --tailscale serve
```

这为 Android 提供了安全的 `wss://` / `https://` 端点。除非您还单独终止 TLS，否则纯 `gateway.bind: "tailnet"` 设置不足以进行首次远程 Android 配对。

### 2) 验证发现（可选）

从网关机器：

```bash
dns-sd -B _openclaw-gw._tcp local.
```

更多调试说明：[Bonjour](/gateway/bonjour)。

如果您还配置了广域发现域，请与以下内容进行比较：

```bash
openclaw gateway discover --json
```

这会在一次传递中显示 `local.` 加上配置的广域域，并使用解析的服务端点而不是仅 TXT 提示。

#### 通过单播 DNS-SD 的 Tailnet（维也纳 ⇄ 伦敦）发现

Android NSD/mDNS 发现不会跨网络。如果您的 Android 节点和网关在不同的网络上但通过 Tailscale 连接，请改用广域 Bonjour / 单播 DNS-SD。

仅发现不足以进行 tailnet/公共 Android 配对。发现的路由仍然需要安全端点（`wss://` 或 Tailscale Serve）：

1. 在网关主机上设置 DNS-SD 区域（例如 `openclaw.internal.`）并发布 `_openclaw-gw._tcp` 记录。
2. 为指向该 DNS 服务器的所选域配置 Tailscale 拆分 DNS。

详细信息和示例 CoreDNS 配置：[Bonjour](/gateway/bonjour)。

### 3) 从 Android 连接

在 Android 应用中：

- 应用通过**前台服务**（持久通知）保持其网关连接活跃。
- 打开**连接**选项卡。
- 使用**设置代码**或**手动**模式。
- 如果发现被阻止，请在**高级控制**中使用手动主机/端口。对于私有 LAN 主机，`ws://` 仍然有效。对于 Tailscale/公共主机，开启 TLS 并使用 `wss://` / Tailscale Serve 端点。

第一次成功配对后，Android 在启动时自动重新连接：

- 手动端点（如果启用），否则
- 最后发现的网关（尽力而为）。

### 4) 批准配对（CLI）

在网关机器上：

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

配对详情：[配对](/channels/pairing)。

### 5) 验证节点已连接

- 通过节点状态：

  ```bash
  openclaw nodes status
  ```

- 通过网关：

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 聊天 + 历史记录

Android 聊天选项卡支持会话选择（默认 `main`，加上其他现有会话）：

- 历史记录：`chat.history`（显示标准化；内联指令标签从可见文本中剥离，纯文本工具调用 XML 有效负载（包括 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的工具调用块）和泄漏的 ASCII/全宽模型控制令牌被剥离，纯静默令牌助手行（如确切的 `NO_REPLY` / `no_reply`）被省略，过大的行可以被占位符替换）
- 发送：`chat.send`
- 推送更新（尽力而为）：`chat.subscribe` → `event:"chat"`

### 7) 画布 + 相机

#### 网关画布主机（推荐用于 Web 内容）

如果您希望节点显示代理可以在磁盘上编辑的真实 HTML/CSS/JS，请将节点指向网关画布主机。

注意：节点从网关 HTTP 服务器加载画布（与 `gateway.port` 相同的端口，默认 `18789`）。

1. 在网关主机上创建 `~/.openclaw/workspace/canvas/index.html`。

2. 导航节点到它（LAN）：

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet（可选）：如果两个设备都在 Tailscale 上，请使用 MagicDNS 名称或 tailnet IP 而不是 `.local`，例如 `http://<gateway-magicdns>:18789/__openclaw__/canvas/`。

此服务器将实时重载客户端注入 HTML 并在文件更改时重载。A2UI 主机位于 `http://<gateway-host>:18789/__openclaw__/a2ui/`。

画布命令（仅前台）：

- `canvas.eval`、`canvas.snapshot`、`canvas.navigate`（使用 `{"url":""}` 或 `{"url":"/"}` 返回默认脚手架）。`canvas.snapshot` 返回 `{ format, base64 }`（默认 `format="jpeg"`）。
- A2UI：`canvas.a2ui.push`、`canvas.a2ui.reset`（`canvas.a2ui.pushJSONL` 旧别名）

相机命令（仅前台；权限门控）：

- `camera.snap`（jpg）
- `camera.clip`（mp4）

请参阅 [相机节点](/nodes/camera) 了解参数和 CLI 助手。

### 8) 语音 + 扩展的 Android 命令界面

- 语音：Android 在语音选项卡中使用单一麦克风开关流程，具有转录捕获和 `talk.speak` 播放。仅当 `talk.speak` 不可用时才使用本地系统 TTS。当应用离开前台时，语音停止。
- 语音唤醒/通话模式切换目前已从 Android UX/运行时中移除。
- 其他 Android 命令系列（可用性取决于设备 + 权限）：
  - `device.status`、`device.info`、`device.permissions`、`device.health`
  - `notifications.list`、`notifications.actions`（见下文 [通知转发](#通知转发)）
  - `photos.latest`
  - `contacts.search`、`contacts.add`
  - `calendar.events`、`calendar.add`
  - `callLog.search`
  - `sms.search`
  - `motion.activity`、`motion.pedometer`

## 助手入口点

Android 支持从系统助手触发器（Google Assistant）启动 OpenClaw。配置后，按住主页按钮或说 "Hey Google, ask OpenClaw..." 会打开应用并将提示传递到聊天编辑器。

这使用在应用清单中声明的 Android **应用操作**元数据。网关端不需要额外配置 — 助手意图完全由 Android 应用处理并作为普通聊天消息转发。

<Note>
应用操作的可用性取决于设备、Google Play 服务版本以及用户是否将 OpenClaw 设置为默认助手应用。
</Note>

## 通知转发

Android 可以将设备通知作为事件转发到网关。几个控件让您可以确定转发哪些通知以及何时转发。

| 键                               | 类型           | 描述                                                         |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| `notifications.allowPackages`    | string[]       | 仅转发来自这些包名的通知。如果设置，所有其他包都被忽略。     |
| `notifications.denyPackages`     | string[]       | 从不转发来自这些包名的通知。在 `allowPackages` 之后应用。    |
| `notifications.quietHours.start` | string (HH:mm) | 安静时间窗口的开始（本地设备时间）。在此窗口期间通知被抑制。 |
| `notifications.quietHours.end`   | string (HH:mm) | 安静时间窗口的结束。                                         |
| `notifications.rateLimit`        | number         | 每个包每分钟转发的最大通知数。超出的通知被丢弃。             |

通知选择器还对转发的通知事件使用更安全的行为，防止意外转发敏感系统通知。

示例配置：

```json5
{
  notifications: {
    allowPackages: ["com.slack", "com.whatsapp"],
    denyPackages: ["com.android.systemui"],
    quietHours: {
      start: "22:00",
      end: "07:00",
    },
    rateLimit: 5,
  },
}
```

<Note>
通知转发需要 Android 通知监听器权限。应用在设置期间会提示此权限。
</Note>
