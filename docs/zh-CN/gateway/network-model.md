---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 你想要简要了解 Gateway 网关的网络模型（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: Gateway 网关、节点和 canvas 主机如何连接。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: 网络模型（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-04T17:53:21Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: e3508b884757ef19f425c82e891e2b07e7fd7d985413d569e55ae9b175c91f0f（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: gateway/network-model.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
大多数操作通过 Gateway 网关（`openclaw gateway`）进行，它是一个长期运行的单一进程，负责管理渠道连接和 WebSocket 控制平面。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 核心规则（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 建议每台主机运行一个 Gateway 网关。它是唯一允许拥有 WhatsApp Web 会话的进程。对于救援机器人或严格隔离的场景，可以使用隔离的配置文件和端口运行多个 Gateway 网关。参见[多 Gateway 网关](/gateway/multiple-gateways)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 优先使用回环地址：Gateway 网关的 WS 默认为 `ws://127.0.0.1:18789`。即使是回环连接，向导也会默认生成 gateway token。若需通过 tailnet 访问，请运行 `openclaw gateway --bind tailnet --token ...`，因为非回环绑定必须使用 token。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 节点根据需要通过局域网、tailnet 或 SSH 连接到 Gateway 网关的 WS。旧版 TCP 桥接已弃用。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvas 主机是一个 HTTP 文件服务器，运行在 `canvasHost.port`（默认 `18793`）上，提供 `/__openclaw__/canvas/` 路径供节点 WebView 使用。参见 [Gateway 网关配置](/gateway/configuration)（`canvasHost`）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 远程使用通常通过 SSH 隧道或 Tailscale VPN。参见[远程访问](/gateway/remote)和[设备发现](/gateway/discovery)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
