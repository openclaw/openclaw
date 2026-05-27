---
read_when:
  - 配对或重新连接 iOS 节点
  - 从源码运行 iOS 应用
  - 调试 Gateway 网关发现或 canvas 命令
summary: iOS 节点应用：连接到 Gateway 网关、配对、canvas 和故障排除
title: iOS 应用
x-i18n:
  generated_at: "2026-02-03T07:52:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 692eebdc82e4bb8dc221bcbabf6a344a861a839fc377f1aeeb6eecaa4917a232
  source_path: platforms/ios.md
  workflow: 15
---

# iOS 应用（节点）

可用性：内部预览。iOS 应用尚未公开分发。

## 功能

- 通过 WebSocket（LAN 或 tailnet）连接到 Gateway 网关。
- 暴露节点能力：Canvas、屏幕快照、相机捕获、位置、对话模式、语音唤醒。
- 接收 `node.invoke` 命令并报告节点状态事件。

## 要求

- Gateway 网关运行在另一台设备上（macOS、Linux 或通过 WSL2 的 Windows）。
- 网络路径：
  - 通过 Bonjour 的同一 LAN，**或**
  - 通过单播 DNS-SD 的 Tailnet（示例域：`openclaw.internal.`），**或**
  - 手动主机/端口（备选）。

## 快速开始（配对 + 连接）

1. 启动 Gateway 网关：

```bash
openclaw gateway --port 18789
```

2. 在 iOS 应用中，打开设置并选择一个已发现的 Gateway 网关（或启用手动主机并输入主机/端口）。

3. 在 Gateway 网关主机上批准配对请求：

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 验证连接：

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 发现路径

### Bonjour（LAN）

Gateway 网关在 `local.` 上广播 `_openclaw-gw._tcp`。iOS 应用会自动列出这些。

### Tailnet（跨网络）

如果 mDNS 被阻止，使用单播 DNS-SD 区域（选择一个域；示例：`openclaw.internal.`）和 Tailscale 分割 DNS。
参见 [Bonjour](/gateway/bonjour) 了解 CoreDNS 示例。

### 手动主机/端口

在设置中，启用**手动主机**并输入 Gateway 网关主机 + 端口（默认 `18789`）。

## Canvas + A2UI

iOS 节点渲染一个 WKWebView canvas。使用 `node.invoke` 来驱动它：

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

注意事项：

- Gateway 网关 canvas 主机服务于 `/__openclaw__/canvas/` 和 `/__openclaw__/a2ui/`。
- 当广播了 canvas 主机 URL 时，iOS 节点在连接时自动导航到 A2UI。
- 使用 `canvas.navigate` 和 `{"url":""}` 返回内置脚手架。

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 语音唤醒 + 对话模式

- 语音唤醒和对话模式在设置中可用。
- iOS 可能会暂停后台音频；当应用不活跃时，将语音功能视为尽力而为。

## 常见错误

- `NODE_BACKGROUND_UNAVAILABLE`：将 iOS 应用带到前台（canvas/相机/屏幕命令需要它）。
- `A2UI_HOST_NOT_CONFIGURED`：Gateway 网关未广播 canvas 主机 URL；检查 [Gateway 网关配置](/gateway/configuration) 中的 `canvasHost`。
- 配对提示从未出现：运行 `openclaw nodes pending` 并手动批准。
- 重新安装后重连失败：钥匙串配对令牌已被清除；重新配对节点。

## 相关文档

- [配对](/gateway/pairing)
- [设备发现](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
