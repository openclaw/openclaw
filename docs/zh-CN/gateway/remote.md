---
read_when:
  - 运行或排查远程 Gateway网关设置问题
summary: 使用 SSH 隧道（Gateway网关 WebSocket）和 tailnet 进行远程访问
title: 远程访问
x-i18n:
  generated_at: "2026-02-01T20:35:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 7e00bd2e048dfbd829913bef0f40a791b8d8c3e2f8a115fc0a13b03f136ebc93
  source_path: gateway/remote.md
  workflow: 14
---

# 远程访问（SSH、隧道和 tailnet）

本仓库通过在专用主机（桌面/服务器）上运行单个 Gateway网关（主节点）并让客户端连接到它，来支持"通过 SSH 远程访问"。

- 对于**操作者（你 / macOS 应用）**：SSH 隧道是通用的后备方案。
- 对于**节点（iOS/Android 及未来设备）**：连接到 Gateway网关的 **WebSocket**（根据需要通过局域网/tailnet 或 SSH 隧道）。

## 核心思路

- Gateway网关 WebSocket 绑定到你配置端口上的**local loopback**（默认为 18789）。
- 对于远程使用，你通过 SSH 转发该 local loopback 端口（或使用 tailnet/VPN 以减少隧道需求）。

## 常见的 VPN/tailnet 设置（智能体运行的位置）

将 **Gateway网关主机**视为"智能体运行的位置"。它拥有会话、认证配置、渠道和状态。
你的笔记本/桌面（及节点）连接到该主机。

### 1) 在 tailnet 中常驻运行的 Gateway网关（VPS 或家庭服务器）

在持久化主机上运行 Gateway网关，通过 **Tailscale** 或 SSH 访问。

- **最佳体验：**保持 `gateway.bind: "loopback"` 并使用 **Tailscale Serve** 提供控制界面。
- **后备方案：**保持 local loopback + 从需要访问的任何机器建立 SSH 隧道。
- **示例：**[exe.dev](/platforms/exe-dev)（简易虚拟机）或 [Hetzner](/platforms/hetzner)（生产 VPS）。

当你的笔记本经常休眠但希望智能体始终在线时，这是理想方案。

### 2) 家庭桌面运行 Gateway网关，笔记本作为远程控制

笔记本**不**运行智能体。它通过远程连接：

- 使用 macOS 应用的**通过 SSH 远程连接**模式（设置 → 通用 → "OpenClaw 运行位置"）。
- 应用会打开并管理隧道，因此 WebChat + 健康检查"开箱即用"。

操作指南：[macOS 远程访问](/platforms/mac/remote)。

### 3) 笔记本运行 Gateway网关，从其他机器远程访问

保持 Gateway网关本地运行但安全地暴露它：

- 从其他机器通过 SSH 隧道连接到笔记本，或
- 通过 Tailscale Serve 提供控制界面并保持 Gateway网关仅绑定 local loopback。

指南：[Tailscale](/gateway/tailscale) 和 [Web 概览](/web)。

## 命令流程（什么在哪里运行）

一个 Gateway网关服务拥有状态和渠道。节点是外围设备。

流程示例（Telegram → 节点）：

- Telegram 消息到达 **Gateway网关**。
- Gateway网关运行**智能体**并决定是否调用节点工具。
- Gateway网关通过 Gateway网关 WebSocket（`node.*` RPC）调用**节点**。
- 节点返回结果；Gateway网关将回复发送回 Telegram。

说明：

- **节点不运行 Gateway网关服务。**每台主机只应运行一个 Gateway网关，除非你有意运行隔离的配置文件（参见[多 Gateway网关](/gateway/multiple-gateways)）。
- macOS 应用"节点模式"只是通过 Gateway网关 WebSocket 连接的节点客户端。

## SSH 隧道（CLI + 工具）

创建到远程 Gateway网关 WebSocket 的本地隧道：

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

隧道建立后：

- `openclaw health` 和 `openclaw status --deep` 现在通过 `ws://127.0.0.1:18789` 访问远程 Gateway网关。
- `openclaw gateway {status,health,send,agent,call}` 也可以在需要时通过 `--url` 指向转发的 URL。

注意：将 `18789` 替换为你配置的 `gateway.port`（或 `--port`/`OPENCLAW_GATEWAY_PORT`）。

## CLI 远程默认值

你可以持久化远程目标，使 CLI 命令默认使用它：

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

当 Gateway网关仅绑定 local loopback 时，保持 URL 为 `ws://127.0.0.1:18789` 并先打开 SSH 隧道。

## 通过 SSH 访问聊天界面

WebChat 不再使用单独的 HTTP 端口。SwiftUI 聊天界面直接连接到 Gateway网关 WebSocket。

- 通过 SSH 转发 `18789`（参见上文），然后将客户端连接到 `ws://127.0.0.1:18789`。
- 在 macOS 上，建议使用应用的"通过 SSH 远程连接"模式，它会自动管理隧道。

## macOS 应用"通过 SSH 远程连接"

macOS 菜单栏应用可以端到端驱动相同的设置（远程状态检查、WebChat 和语音唤醒转发）。

操作指南：[macOS 远程访问](/platforms/mac/remote)。

## 安全规则（远程/VPN）

简短版本：**保持 Gateway网关仅绑定 local loopback**，除非你确定需要绑定其他地址。

- **local loopback + SSH/Tailscale Serve** 是最安全的默认设置（无公开暴露）。
- **非 local loopback 绑定**（`lan`/`tailnet`/`custom`，或 local loopback 不可用时的 `auto`）必须使用认证令牌/密码。
- `gateway.remote.token` **仅**用于远程 CLI 调用——它**不会**启用本地认证。
- `gateway.remote.tlsFingerprint` 在使用 `wss://` 时固定远程 TLS 证书。
- **Tailscale Serve** 可以在 `gateway.auth.allowTailscale: true` 时通过身份头进行认证。如果你希望使用令牌/密码，请将其设置为 `false`。
- 将浏览器控制视为操作者访问：仅限 tailnet + 有意的节点配对。

深入了解：[安全](/gateway/security)。
