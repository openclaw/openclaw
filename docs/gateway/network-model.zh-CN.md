---
summary: "网关、节点和画布主机如何连接。"
read_when:
  - 您想要网关网络模型的简明视图
title: "网络模型"
---

# 网络模型

> 此内容已合并到 [网络](/network#core-model)。请参阅该页面获取当前指南。

大多数操作通过网关（`openclaw gateway`）进行，这是一个长时间运行的单一进程，拥有通道连接和 WebSocket 控制平面。

## 核心规则

- 每个主机推荐一个网关。它是唯一被允许拥有 WhatsApp Web 会话的进程。对于救援机器人或严格隔离，运行带有隔离配置文件和端口的多个网关。请参阅[多个网关](/gateway/multiple-gateways)。
- 环回优先：网关 WS 默认使用 `ws://127.0.0.1:18789`。向导默认创建共享密钥身份验证，通常会生成一个令牌，即使对于环回也是如此。对于非环回访问，使用有效的网关身份验证路径：共享密钥令牌/密码身份验证，或正确配置的非环回 `trusted-proxy` 部署。Tailnet/移动设置通常通过 Tailscale Serve 或其他 `wss://` 端点而不是原始 tailnet `ws://` 效果最佳。
- 节点根据需要通过 LAN、tailnet 或 SSH 连接到网关 WS。旧版 TCP 桥接已被移除。
- 画布主机由网关 HTTP 服务器在与网关**相同的端口**上提供服务（默认 `18789`）：
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    当配置了 `gateway.auth` 且网关绑定超出环回时，这些路由受网关身份验证保护。节点客户端使用与其活动 WS 会话绑定的节点范围能力 URL。请参阅[网关配置](/gateway/configuration)（`canvasHost`、`gateway`）。
- 远程使用通常是 SSH 隧道或 tailnet VPN。请参阅[远程访问](/gateway/remote)和[发现](/gateway/discovery)。
